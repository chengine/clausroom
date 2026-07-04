/**
 * GET  /api/rooms/:id/messages — ascending (created_at, id) page with `after` cursor.
 * POST /api/rooms/:id/messages — post a message; sender derived from the token.
 *
 * Enforcement order (docs/API-CONTRACT.md §4): schema validation ->
 * inline-blob guard -> reference validation -> (agents only) agents_paused ->
 * participant paused -> turn limit -> (everyone) sliding-window rate limit.
 */
import { Router } from 'express';
import { z } from 'zod';
import { PostMessageRequestSchema } from '@clausroom/protocol';
import { HttpError, notFound, validation } from '../errors.js';
import { getAuth, getRoomCtx, roomGuard } from '../auth.js';
import { effectiveRoomSettings, toMessage, type Store } from '../db.js';
import {
  countTrailingAgentRun,
  hasInlineBlob,
  redactSecrets,
  type MessageRateLimiter,
} from '../policy.js';
import { createAndBroadcastMessage } from '../messageService.js';
import type { WsHub } from '../ws.js';
import { h, parse } from './util.js';
import type { ServerConfig } from '../env.js';

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

const ListQuerySchema = z.object({
  after: z.string().min(1).optional(),
  limit: z
    .string()
    .regex(/^\d+$/, 'limit must be a non-negative integer')
    .optional(),
});

export function messageRoutes(
  store: Store,
  hub: WsHub,
  config: ServerConfig,
  rateLimiter: MessageRateLimiter,
): Router {
  const router = Router();

  router.get(
    '/rooms/:id/messages',
    roomGuard(store),
    h(async (req, res) => {
      const { room } = getRoomCtx(req);
      const query = parse(ListQuerySchema, req.query);

      let limit = DEFAULT_LIMIT;
      if (query.limit !== undefined) {
        limit = Number.parseInt(query.limit, 10);
        if (!Number.isFinite(limit) || limit > MAX_LIMIT) {
          throw validation(`limit must be a number <= ${MAX_LIMIT}.`);
        }
      }

      let after: { created_at: string; id: string } | null = null;
      if (query.after !== undefined) {
        const cursor = store.getMessageInRoom(room.id, query.after);
        if (!cursor) throw notFound('Unknown `after` message id in this room.');
        after = { created_at: cursor.created_at, id: cursor.id };
      }

      const rows = store.listMessages(room.id, after, limit);
      res.status(200).json({ messages: rows.map(toMessage) });
    }),
  );

  router.post(
    '/rooms/:id/messages',
    roomGuard(store),
    h(async (req, res) => {
      const auth = getAuth(req);
      const { room, participant } = getRoomCtx(req);
      if (participant.can_send !== 1) {
        throw new HttpError(403, 'forbidden', 'You do not have permission to send messages in this room.');
      }

      // Schema validation (sender/sender_id in the body is ignored: the schema
      // strips unknown keys and the sender is always derived from the token).
      const body = parse(PostMessageRequestSchema, req.body);

      // system_event is reserved for server-generated messages (System user).
      // Allowing it here would let agents impersonate server notices AND dodge
      // the turn-limit walk, which skips system_event rows when counting the run.
      if (body.message_type === 'system_event') {
        throw validation(
          'message_type "system_event" is reserved for server-generated messages.',
        );
      }

      if (hasInlineBlob(body.body_markdown)) {
        throw new HttpError(
          422,
          'inline_blob',
          'Do not inline file content; upload an artifact instead.',
        );
      }

      const artifactIds = body.artifact_ids ?? [];
      for (const artifactId of artifactIds) {
        if (!store.getArtifactInRoom(room.id, artifactId)) {
          throw validation(`artifact_ids: ${artifactId} is not an artifact in this room.`);
        }
      }
      for (const recipientId of body.recipient_ids) {
        if (!store.getParticipant(room.id, recipientId)) {
          throw validation(`recipient_ids: ${recipientId} is not a participant of this room.`);
        }
      }
      if (body.reply_to_message_id !== undefined) {
        if (!store.getMessageInRoom(room.id, body.reply_to_message_id)) {
          throw validation('reply_to_message_id: no such message in this room.');
        }
      }

      // Agent-only enforcement, in binding order.
      if (auth.user.kind === 'agent') {
        if (room.agents_paused === 1) {
          throw new HttpError(
            403,
            'agents_paused',
            'All agents are paused in this room. Wait for a human to resume.',
          );
        }
        if (participant.paused === 1) {
          throw new HttpError(
            403,
            'participant_paused',
            'You are paused in this room. Wait for your human to resume you.',
          );
        }
        const run = countTrailingAgentRun(store, room.id);
        // Effective turn limit is read per-request (room override ?? global
        // default), so a live PATCH enforces the new limit immediately.
        const maxAutoTurns = effectiveRoomSettings(room, config).max_auto_turns;
        if (run >= maxAutoTurns) {
          throw new HttpError(
            429,
            'turn_limit',
            `Agent turn limit reached (${run} consecutive agent messages). Stop now and wait for a human to reply before sending more messages.`,
          );
        }
      }

      // Rate limit — ALL senders, human and agent.
      if (!rateLimiter.allows(auth.user.id)) {
        throw new HttpError(
          429,
          'rate_limited',
          'Message rate limit exceeded (30 messages per minute). Slow down and wait before sending more.',
        );
      }

      // Best-effort secret redaction (docs/API-CONTRACT.md §4): after
      // validation, before storage and broadcast — the original never
      // persists, and the redacted body is not re-validated against the
      // length/inline-blob rules. `choices` entries are not scanned.
      const message = createAndBroadcastMessage(store, hub, {
        roomId: room.id,
        sender: auth.user,
        messageType: body.message_type,
        bodyMarkdown: redactSecrets(body.body_markdown),
        recipientIds: body.recipient_ids,
        artifactIds,
        replyToMessageId: body.reply_to_message_id ?? null,
        confidence: body.confidence ?? null,
        choices: body.choices ?? null,
      });
      rateLimiter.record(auth.user.id);

      res.status(201).json({ message });
    }),
  );

  return router;
}
