/**
 * Every HTTP endpoint. Raw tokens exist in exactly two responses: the login
 * exchange and the two participant/token routes.
 */
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Router, type RequestHandler } from 'express';
import multer from 'multer';
import { z } from 'zod';
import {
  AddParticipantRequestSchema,
  ArtifactUploadApprovalPayloadSchema,
  ApprovalStatusSchema,
  CreateApprovalRequestSchema,
  CreateRoomRequestSchema,
  LIMITS,
  LoginRequestSchema,
  PauseRequestSchema,
  PostMessageRequestSchema,
  RespondApprovalRequestSchema,
  TurnLimitRequestSchema,
  UpdateSummaryRequestSchema,
  genId,
  newToken,
  safeFilename,
  sha256Hex,
  type Message,
} from '@clausroom/protocol';
import { nowIso, type ArtifactFile, type Store } from './db.js';
import {
  announce,
  auth,
  caller,
  fail,
  handler,
  hasInlineBlob,
  inRoom,
  noRoom,
  parse,
  post,
  publish,
  redact,
  roomOf,
  withExpiry,
  wire,
} from './room.js';
import type { Hub } from './ws.js';

const UPLOAD_APPROVAL_NEEDED =
  'An agent upload needs an approved artifact_upload approval from your human. ' +
  'Call room_upload_artifact without approval_id to request one.';

function privateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(dir).isDirectory()) throw new Error(`Refusing non-directory path: ${dir}`);
  fs.chmodSync(dir, 0o700);
}

export function routes(store: Store, hub: Hub, dataDir: string): Router {
  const api = Router();
  const room = [auth(store), inRoom(store)];
  const changedRoom = (id: string) => {
    const updated = store.room(id);
    if (!updated) throw noRoom();
    hub.send(id, { type: 'room_updated', room: updated });
    return updated;
  };

  // --- auth ----------------------------------------------------------------

  api.post(
    '/auth/login',
    handler((req, res) => {
      const { invite_token } = parse(LoginRequestSchema, req.body);
      const invite = store.token(sha256Hex(invite_token));
      const user = invite ? store.user(invite.user_id) : undefined;
      if (
        !invite ||
        !user ||
        invite.kind !== 'invite' ||
        invite.used_at !== null ||
        invite.revoked_at !== null
      ) {
        throw fail('unauthorized', 'Unknown, already-used, or revoked invite token.');
      }
      const session = newToken('session');
      store.transaction(() => {
        store.useInvite(invite.id);
        store.addToken('session', sha256Hex(session), user.id, null);
      });
      res.json({ session_token: session, user });
    }),
  );

  api.get(
    '/me',
    auth(store),
    handler((req, res) => {
      const me = caller(req);
      res.json({ user: me.user, rooms: store.roomsOf(me.user.id) });
    }),
  );

  // --- rooms ---------------------------------------------------------------

  api.post(
    '/rooms',
    auth(store),
    handler((req, res) => {
      const me = caller(req);
      if (me.tokenKind !== 'session' || me.user.id !== store.ownerUser()?.id) {
        throw fail('forbidden', 'Only the host owner can create a room.');
      }
      const { name } = parse(CreateRoomRequestSchema, req.body);
      const created = store.transaction(() => {
        const room = store.addRoom(name);
        store.addParticipant(room.id, me.user, 'owner');
        return room;
      });
      res.status(201).json({ room: created });
    }),
  );

  api.get(
    '/rooms/:id',
    room,
    handler((req, res) => {
      const { room: r, participant } = roomOf(req);
      res.json({
        room: r,
        participants: store.participants(r.id),
        my_role: participant.role,
        agent_turns: r.agent_turn_limit,
      });
    }),
  );

  // --- participants --------------------------------------------------------

  const ownerOnly: RequestHandler = (req, _res, next) => {
    next(roomOf(req).participant.role === 'owner' ? undefined : fail('forbidden', 'Owner only.'));
  };

  api.post(
    '/rooms/:id/participants',
    room,
    ownerOnly,
    handler((req, res) => {
      const { room: r, me } = roomOf(req);
      const body = parse(AddParticipantRequestSchema, req.body);

      let ownerUserId: string | null = null;
      if (body.kind === 'agent') {
        const candidate = body.owner_user_id ?? me.user.id;
        const reviewer = store.participant(r.id, candidate);
        if (!reviewer || reviewer.user.kind !== 'human') {
          throw fail('validation', 'owner_user_id must be a human participant of this room.');
        }
        ownerUserId = candidate;
      }

      const kind = body.kind === 'human' ? 'invite' : 'bridge';
      const raw = newToken(kind);
      const participant = store.transaction(() => {
        const user = store.addUser({
          id: genId('user'),
          display_name: body.display_name,
          kind: body.kind,
          owner_user_id: ownerUserId,
        });
        store.addToken(kind, sha256Hex(raw), user.id, kind === 'bridge' ? r.id : null);
        return store.addParticipant(r.id, user, body.role);
      });
      res.status(201).json({ participant, [`${kind}_token`]: raw });
    }),
  );

  api.post(
    '/rooms/:id/participants/:userId/token',
    room,
    ownerOnly,
    handler((req, res) => {
      const { room: r } = roomOf(req);
      const target = req.params.userId ? store.participant(r.id, req.params.userId) : undefined;
      if (!target) throw fail('not_found', 'No such participant in this room.');
      const kind = target.user.kind === 'human' ? 'invite' : 'bridge';
      const raw = newToken(kind);
      store.transaction(() => {
        store.revokeTokens(target.user_id);
        store.addToken(kind, sha256Hex(raw), target.user_id, kind === 'bridge' ? r.id : null);
      });
      hub.disconnectUser(target.user_id);
      res.json({ [`${kind}_token`]: raw });
    }),
  );

  api.post(
    '/rooms/:id/pause',
    room,
    handler((req, res) => {
      const { room: r, me } = roomOf(req);
      if (me.user.kind !== 'human') {
        throw fail('forbidden', 'Only a human can pause or resume an agent.');
      }
      const body = parse(PauseRequestSchema, req.body);

      if (body.target === 'all_agents') {
        store.pauseAgents(r.id, body.paused);
        res.json({ room: changedRoom(r.id) });
        return;
      }
      if (!store.participant(r.id, body.target)) {
        throw fail('not_found', 'No such participant in this room.');
      }
      store.pauseParticipant(r.id, body.target, body.paused);
      const participant = store.participant(r.id, body.target);
      if (!participant) throw fail('not_found', 'No such participant in this room.');
      hub.send(r.id, { type: 'participant_updated', participant });
      res.json({ participant });
    }),
  );

  api.put(
    '/rooms/:id/turn-limit',
    room,
    handler((req, res) => {
      const { room: r, me } = roomOf(req);
      if (me.user.kind !== 'human') throw fail('forbidden', 'Only a human can change the turn limit.');
      const { agent_turn_limit } = parse(TurnLimitRequestSchema, req.body);
      store.setTurnLimit(r.id, agent_turn_limit);
      res.json({ room: changedRoom(r.id) });
    }),
  );

  api.put(
    '/rooms/:id/summary',
    room,
    handler((req, res) => {
      const { room: r, participant, me } = roomOf(req);
      if (!participant.can_send) throw fail('forbidden', 'You cannot write in this room.');
      const { summary_markdown } = parse(UpdateSummaryRequestSchema, req.body);

      store.setSummary(
        r.id,
        summary_markdown === null ? null : redact(summary_markdown),
        me.user.id,
      );
      const updated = changedRoom(r.id);
      announce(store, hub, r.id, `${me.user.display_name} updated the room summary.`);
      res.json({ room: updated });
    }),
  );

  // --- messages ------------------------------------------------------------

  const ListQuery = z.object({
    after: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(LIMITS.PAGE_MAX).optional(),
  });

  api.get(
    '/rooms/:id/messages',
    room,
    handler((req, res) => {
      const { room: r } = roomOf(req);
      const query = parse(ListQuery, req.query);
      let after = null;
      if (query.after !== undefined) {
        const cursor = store.message(r.id, query.after);
        if (!cursor) throw fail('not_found', 'Unknown `after` message id in this room.');
        after = { created_at: cursor.created_at, id: cursor.id };
      }
      res.json({ messages: store.messages(r.id, after, query.limit ?? LIMITS.PAGE) });
    }),
  );

  api.post(
    '/rooms/:id/messages',
    room,
    handler((req, res) => {
      const { room: r, participant, me } = roomOf(req);
      if (!participant.can_send) throw fail('forbidden', 'You cannot write in this room.');
      const body = parse(PostMessageRequestSchema, req.body);

      // Reserved for the System user; allowing it would also let an agent slip
      // past the turn limit, which skips system_event rows when counting.
      if (body.message_type === 'system_event') {
        throw fail('validation', 'message_type "system_event" is reserved for the server.');
      }
      if (hasInlineBlob(body.body_markdown)) {
        throw fail('inline_blob', 'Do not inline file content; upload an artifact instead.');
      }
      for (const id of body.artifact_ids ?? []) {
        if (!store.artifact(r.id, id)) {
          throw fail('validation', `artifact_ids: ${id} is not an artifact in this room.`);
        }
      }
      for (const id of body.recipient_ids) {
        if (!store.participant(r.id, id)) {
          throw fail('validation', `recipient_ids: ${id} is not a participant of this room.`);
        }
      }
      if (body.reply_to_message_id && !store.message(r.id, body.reply_to_message_id)) {
        throw fail('validation', 'reply_to_message_id: no such message in this room.');
      }

      if (me.user.kind === 'agent') {
        if (r.agents_paused) {
          throw fail('agents_paused', 'Every agent is paused here. Wait for a human to resume.');
        }
        if (participant.paused) {
          throw fail('participant_paused', 'You are paused. Wait for your human to resume you.');
        }
        const run = store.agentRun(r.id);
        if (run >= r.agent_turn_limit) {
          throw fail(
            'turn_limit',
            `Agent turn limit reached (${run} agent messages in a row). Stop and wait for a human reply.`,
          );
        }
      }

      const message = post(store, hub, {
        room_id: r.id,
        sender: me.user,
        message_type: body.message_type,
        body_markdown: redact(body.body_markdown),
        recipient_ids: body.recipient_ids,
        artifact_ids: body.artifact_ids ?? [],
        reply_to_message_id: body.reply_to_message_id ?? null,
        confidence: body.confidence ?? null,
        choices: body.choices ?? null,
      });
      res.status(201).json({ message });
    }),
  );

  // --- artifacts -----------------------------------------------------------

  const artifactDir = path.join(dataDir, 'artifacts');
  const tmpDir = path.join(artifactDir, '.tmp');
  privateDir(artifactDir);
  // Multipart files are disposable until their database transaction commits.
  fs.rmSync(tmpDir, { recursive: true, force: true });
  privateDir(tmpDir);
  const upload = multer({
    storage: multer.diskStorage({ destination: tmpDir }),
    limits: {
      fileSize: LIMITS.UPLOAD_BYTES,
      files: 1,
      fields: 2,
      parts: 4,
      fieldNameSize: 32,
      fieldSize: LIMITS.BODY_CHARS * 4,
      headerPairs: 20,
    },
  });
  let receiving = 0;
  const receiveUpload: RequestHandler = (req, res, next) => {
    if (receiving >= LIMITS.UPLOAD_CONCURRENCY) {
      next(fail('too_large', 'Too many uploads are already in progress. Try again shortly.'));
      return;
    }
    receiving += 1;
    upload.single('file')(req, res, (error) => {
      if (error) receiving -= 1;
      next(error);
    });
  };

  const UploadFields = z.object({
    description: z.string().max(LIMITS.BODY_CHARS).optional(),
    approval_id: z.string().min(1).optional(),
  });

  api.post(
    '/rooms/:id/artifacts',
    room,
    receiveUpload,
    handler(async (req, res) => {
      const { room: r, participant, me } = roomOf(req);
      const file = req.file;
      try {
        if (!participant.can_upload) throw fail('forbidden', 'You cannot upload in this room.');
        if (!file) throw fail('validation', 'A `file` field is required (multipart/form-data).');
        const fields = parse(UploadFields, req.body ?? {});
        const filename = safeFilename(file.originalname);

        // An agent upload always needs its own unused, approved approval: one
        // human "yes" authorizes exactly one upload.
        let consume: string | null = null;
        if (me.user.kind === 'agent') {
          const approval = fields.approval_id
            ? store.approval(r.id, fields.approval_id)
            : undefined;
          const manifest = approval
            ? ArtifactUploadApprovalPayloadSchema.safeParse(approval.payload)
            : undefined;
          if (
            !approval ||
            !manifest?.success ||
            withExpiry(store, approval).status !== 'approved' ||
            approval.approval_type !== 'artifact_upload' ||
            approval.requested_by !== me.user.id ||
            approval.consumed_at !== null
          ) {
            throw fail('approval_required', UPLOAD_APPROVAL_NEEDED);
          }
          const digest = await fileSha256(file.path);
          if (
            manifest.data.filename !== filename ||
            manifest.data.size_bytes !== file.size ||
            manifest.data.sha256 !== digest ||
            manifest.data.description !== (fields.description ?? filename)
          ) {
            throw fail(
              'approval_required',
              'The uploaded file or description does not match what your human approved. Ask again.',
            );
          }
          consume = approval.id;
        }

        const id = genId('art');
        const roomDir = path.join(artifactDir, r.id);
        privateDir(roomDir);
        const dir = path.join(roomDir, id);
        const storagePath = path.join(dir, filename);

        const artifact: ArtifactFile = {
          id,
          room_id: r.id,
          uploaded_by: me.user.id,
          filename,
          mime_type: file.mimetype || 'application/octet-stream',
          size_bytes: file.size,
          storage_path: storagePath,
          approval_id: fields.approval_id ?? null,
          created_at: nowIso(),
        };
        let message: Message;
        let madeDir = false;
        try {
          // Claim, storage move, rows, and announcement commit as one serialized
          // operation. A concurrent replay loses the claim before moving bytes.
          message = store.transaction(() => {
            if (consume && !store.consumeApproval(consume)) {
              throw fail('approval_required', 'That approval has already been used. Ask again.');
            }
            if (store.artifactBytes(r.id) + file.size > LIMITS.ROOM_ARTIFACT_BYTES) {
              throw fail('too_large', 'This room has reached its 1 GiB artifact limit.');
            }
            fs.mkdirSync(dir, { mode: 0o700 });
            madeDir = true;
            fs.renameSync(file.path, storagePath);
            store.addArtifact(artifact);
            return store.addMessage({
              room_id: r.id,
              sender: me.user,
              message_type: 'artifact_uploaded',
              body_markdown: redact(fields.description ?? filename),
              artifact_ids: [id],
            });
          });
        } catch (error) {
          if (madeDir) fs.rmSync(dir, { recursive: true, force: true });
          throw error;
        }
        publish(hub, message);
        res.status(201).json({ artifact: onWire(artifact), message });
      } finally {
        // Anything that threw before the rename leaves a temp file behind.
        if (file) fs.rmSync(file.path, { force: true });
        receiving -= 1;
      }
    }),
  );

  api.get(
    '/rooms/:id/artifacts',
    room,
    handler((req, res) => {
      res.json({ artifacts: store.artifacts(roomOf(req).room.id).map(onWire) });
    }),
  );

  api.get(
    '/rooms/:id/artifacts/:artifactId',
    room,
    handler((req, res) => {
      res.json({ artifact: onWire(findArtifact(store, req.params, roomOf(req).room.id)) });
    }),
  );

  api.get(
    '/rooms/:id/artifacts/:artifactId/download',
    room,
    handler(async (req, res) => {
      const artifact = findArtifact(store, req.params, roomOf(req).room.id);
      if (!fs.existsSync(artifact.storage_path)) {
        throw fail('not_found', 'The artifact file is missing from storage.');
      }
      res.setHeader('Content-Type', artifact.mime_type);
      res.setHeader('Content-Length', String(artifact.size_bytes));
      res.setHeader('Content-Disposition', `attachment; filename="${artifact.filename}"`);
      // pipeline (unlike pipe) destroys the read stream if the client aborts,
      // so a cancelled download cannot leak the file descriptor.
      await pipeline(fs.createReadStream(artifact.storage_path), res).catch(() => {
        if (!res.destroyed) res.destroy();
      });
    }),
  );

  // --- approvals -----------------------------------------------------------

  api.post(
    '/rooms/:id/approvals',
    room,
    handler((req, res) => {
      const { room: r, me } = roomOf(req);
      if (me.tokenKind !== 'bridge') {
        throw fail('forbidden', 'Only an agent can request an approval.');
      }
      const body = parse(CreateApprovalRequestSchema, req.body);
      const reviewerId = me.user.owner_user_id;
      const reviewer = reviewerId ? store.participant(r.id, reviewerId) : undefined;
      if (!reviewerId || !reviewer || reviewer.user.kind !== 'human') {
        throw fail('validation', 'This agent has no human owner in this room to review approvals.');
      }
      const approval = {
        id: genId('apr'),
        room_id: r.id,
        requested_by: me.user.id,
        reviewer_user_id: reviewerId,
        approval_type: body.approval_type,
        payload: body.payload,
        status: 'pending' as const,
        created_at: nowIso(),
        resolved_at: null,
        consumed_at: null,
      };
      store.addApproval(approval);
      hub.send(r.id, { type: 'approval_created', approval: wire(approval) });
      res.status(201).json({ approval: wire(approval) });
    }),
  );

  api.get(
    '/rooms/:id/approvals',
    room,
    handler((req, res) => {
      const { room: r } = roomOf(req);
      const status =
        req.query.status === undefined ? undefined : parse(ApprovalStatusSchema, req.query.status);
      const approvals = store
        .approvals(r.id)
        .map((a) => withExpiry(store, a))
        .filter((a) => status === undefined || a.status === status)
        .map(wire);
      res.json({ approvals });
    }),
  );

  api.post(
    '/rooms/:id/approvals/:approvalId/respond',
    room,
    handler((req, res) => {
      const { room: r, me } = roomOf(req);
      const found = req.params.approvalId
        ? store.approval(r.id, req.params.approvalId)
        : undefined;
      if (!found) throw fail('not_found', 'No such approval in this room.');
      const approval = withExpiry(store, found);
      if (me.user.id !== approval.reviewer_user_id) {
        throw fail('forbidden', 'Only the assigned reviewer can answer this approval.');
      }
      const { decision } = parse(RespondApprovalRequestSchema, req.body);
      if (approval.status !== 'pending') {
        throw fail('conflict', `That approval is already ${approval.status}.`);
      }

      store.setApprovalStatus(approval.id, decision);
      const updated = store.approval(r.id, approval.id);
      if (!updated) throw fail('not_found', 'No such approval in this room.');
      hub.send(r.id, { type: 'approval_resolved', approval: wire(updated) });
      announce(
        store,
        hub,
        r.id,
        `${me.user.display_name} ${decision} the ${approval.approval_type} request.`,
      );
      res.json({ approval: wire(updated) });
    }),
  );

  // --- transcript ----------------------------------------------------------

  api.get(
    '/rooms/:id/export.md',
    room,
    handler((req, res) => {
      const { room: r } = roomOf(req);
      const byId = new Map(store.artifacts(r.id).map((a) => [a.id, a]));
      const lines = [`# ${r.name}`, ''];
      for (const m of store.messages(r.id, null, -1)) {
        lines.push(
          `### ${m.sender.display_name} (${m.sender.kind}) — ${m.created_at} — ${m.message_type}`,
          '',
          m.body_markdown,
          '',
        );
        for (const id of m.artifact_ids) {
          const a = byId.get(id);
          lines.push(a ? `- ${a.filename} (${a.size_bytes} bytes)` : `- ${id} (unavailable)`);
        }
        if (m.artifact_ids.length > 0) lines.push('');
      }
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${r.id}-transcript.md"`);
      res.send(lines.join('\n'));
    }),
  );

  return api;
}

/** Drop the on-disk location before an artifact goes on the wire. */
function onWire(row: ArtifactFile): Omit<ArtifactFile, 'storage_path'> {
  const { storage_path: _drop, ...artifact } = row;
  return artifact;
}

function findArtifact(
  store: Store,
  params: { artifactId?: string },
  roomId: string,
): ArtifactFile {
  const artifact = params.artifactId ? store.artifact(roomId, params.artifactId) : undefined;
  if (!artifact) throw fail('not_found', 'No such artifact in this room.');
  return artifact;
}

/** Digest the exact temporary bytes multer received, before they enter storage. */
async function fileSha256(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
