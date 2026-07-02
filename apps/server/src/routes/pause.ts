/**
 * POST /api/rooms/:id/pause — pause/resume all agents or one participant.
 * Human participants only (agents/bridges -> 403 forbidden).
 */
import { Router } from 'express';
import { PauseRequestSchema } from '@clausroom/protocol';
import { forbidden, notFound } from '../errors.js';
import { getAuth, getRoomCtx, roomGuard } from '../auth.js';
import { toParticipant, toRoom, type Store } from '../db.js';
import type { WsHub } from '../ws.js';
import { h, parse } from './util.js';

export function pauseRoutes(store: Store, hub: WsHub): Router {
  const router = Router();

  router.post(
    '/rooms/:id/pause',
    roomGuard(store),
    h(async (req, res) => {
      const auth = getAuth(req);
      const { room } = getRoomCtx(req);
      if (auth.tokenKind !== 'session' || auth.user.kind !== 'human') {
        throw forbidden('Only human participants can pause or resume agents.');
      }
      const body = parse(PauseRequestSchema, req.body);

      if (body.target === 'all_agents') {
        store.setRoomAgentsPaused(room.id, body.paused);
        const updated = store.getRoom(room.id);
        if (!updated) throw notFound('Room not found.');
        const roomOut = toRoom(updated);
        hub.broadcast(room.id, { type: 'room_updated', room: roomOut });
        res.status(200).json({ room: roomOut });
        return;
      }

      const target = store.getParticipant(room.id, body.target);
      const targetUser = target ? store.getUserById(target.user_id) : undefined;
      if (!target || !targetUser) throw notFound('No such participant in this room.');
      store.setParticipantPaused(room.id, body.target, body.paused);
      const updatedTarget = store.getParticipant(room.id, body.target);
      if (!updatedTarget) throw notFound('No such participant in this room.');
      const participantOut = toParticipant(updatedTarget, targetUser);
      hub.broadcast(room.id, { type: 'participant_updated', participant: participantOut });
      res.status(200).json({ participant: participantOut });
    }),
  );

  return router;
}
