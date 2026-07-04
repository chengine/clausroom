/**
 * PUT /api/rooms/:id/summary — set or clear the pinned room summary.
 *
 * Auth: any participant with can_send true — human or agent, session or
 * bridge token (docs/API-CONTRACT.md §3). This is the ONLY can_send check
 * applied: room.agents_paused, per-participant paused, the turn limit, and
 * the message rate limit do not gate summary updates.
 */
import { Router } from 'express';
import { UpdateSummaryRequestSchema } from '@clausroom/protocol';
import { forbidden, notFound } from '../errors.js';
import { getAuth, getRoomCtx, roomGuard } from '../auth.js';
import { nowIso, toRoom, type Store } from '../db.js';
import { redactSecrets } from '../policy.js';
import { createAndBroadcastMessage } from '../messageService.js';
import type { ServerConfig } from '../env.js';
import type { WsHub } from '../ws.js';
import { h, parse } from './util.js';

export function summaryRoutes(store: Store, hub: WsHub, config: ServerConfig): Router {
  const router = Router();

  router.put(
    '/rooms/:id/summary',
    roomGuard(store),
    h(async (req, res) => {
      const auth = getAuth(req);
      const { room, participant } = getRoomCtx(req);
      if (participant.can_send !== 1) {
        throw forbidden('You do not have permission to update the summary in this room.');
      }
      const body = parse(UpdateSummaryRequestSchema, req.body);

      // Best-effort secret redaction, same seatbelt as message bodies (§4):
      // the summary is persisted, broadcast in room_updated/hello frames, and
      // fed back into every agent's room_get_status/room_get_summary output.
      const summaryMarkdown =
        body.summary_markdown === null ? null : redactSecrets(body.summary_markdown);

      // All three summary fields are set on every call, including clears.
      store.updateRoomSummary(room.id, summaryMarkdown, auth.user.id, nowIso());
      const updated = store.getRoom(room.id);
      if (!updated) throw notFound('Room not found.');
      const roomOut = toRoom(updated, config);

      // Side effects in binding order: room_updated broadcast, then a
      // system_event message from the System user (broadcast + MSG logged).
      hub.broadcast(room.id, { type: 'room_updated', room: roomOut });
      const systemUser = store.getSystemUser();
      if (systemUser) {
        createAndBroadcastMessage(store, hub, {
          roomId: room.id,
          sender: systemUser,
          messageType: 'system_event',
          bodyMarkdown: `${auth.user.display_name} updated the room summary.`,
        });
      }

      res.status(200).json({ room: roomOut });
    }),
  );

  return router;
}
