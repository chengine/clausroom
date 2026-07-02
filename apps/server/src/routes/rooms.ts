/**
 * POST /api/rooms     — create a room (human session tokens only).
 * GET  /api/rooms/:id — room + participants + my_role (any participant).
 */
import { Router } from 'express';
import { CreateRoomRequestSchema, genId } from '@clausroom/protocol';
import { forbidden } from '../errors.js';
import { getAuth, getRoomCtx, roomGuard } from '../auth.js';
import { nowIso, toParticipant, toRoom, type Store } from '../db.js';
import type { ServerConfig } from '../env.js';
import { h, parse } from './util.js';

export function roomRoutes(store: Store, config: ServerConfig): Router {
  const router = Router();

  router.post(
    '/rooms',
    h(async (req, res) => {
      const auth = getAuth(req);
      if (auth.tokenKind !== 'session') {
        throw forbidden('Only human session tokens can create rooms.');
      }
      const body = parse(CreateRoomRequestSchema, req.body);
      const now = nowIso();
      const room = {
        id: genId('room'),
        name: body.name,
        created_by: auth.user.id,
        created_at: now,
        agents_paused: 0,
        archived_at: null,
      };
      store.transaction(() => {
        store.insertRoom(room);
        store.insertParticipant({
          room_id: room.id,
          user_id: auth.user.id,
          role: 'owner',
          can_send: 1,
          can_upload: 1,
          paused: 0,
        });
      });
      res.status(201).json({ room: toRoom(room) });
    }),
  );

  router.get(
    '/rooms/:id',
    roomGuard(store),
    h(async (req, res) => {
      const { room, participant } = getRoomCtx(req);
      const participants = store
        .listParticipants(room.id)
        .map(({ participant: p, user }) => toParticipant(p, user));
      res.status(200).json({
        room: toRoom(room),
        participants,
        my_role: participant.role,
        // Effective server config the UI needs: the real turn limit for the
        // sidebar meter, and the operator's public URL for onboarding snippets.
        max_auto_turns: config.maxAutoTurns,
        ...(config.publicBaseUrl ? { public_base_url: config.publicBaseUrl } : {}),
      });
    }),
  );

  return router;
}
