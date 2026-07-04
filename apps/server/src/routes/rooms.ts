/**
 * POST  /api/rooms              — create a room (human session tokens only).
 * GET   /api/rooms/:id          — room + participants + my_role (any participant).
 * PATCH /api/rooms/:id/settings — update Tier-1 per-room overrides (OWNER only), live.
 */
import { Router } from 'express';
import {
  CreateRoomRequestSchema,
  RoomSettingsPatchRequestSchema,
  genId,
} from '@clausroom/protocol';
import { forbidden, notFound } from '../errors.js';
import { getAuth, getRoomCtx, roomGuard } from '../auth.js';
import {
  effectiveRoomSettings,
  nowIso,
  toParticipant,
  toRoom,
  type Store,
} from '../db.js';
import type { ServerConfig } from '../env.js';
import type { WsHub } from '../ws.js';
import { h, parse } from './util.js';

export function roomRoutes(store: Store, config: ServerConfig, hub: WsHub): Router {
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
        summary_markdown: null,
        summary_updated_by: null,
        summary_updated_at: null,
        // New rooms carry no Tier-1 overrides: every setting falls back to the
        // server global env default until the owner PATCHes them.
        max_auto_turns: null,
        retention_days: null,
        storage_bytes: null,
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
      res.status(201).json({ room: toRoom(room, config) });
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
        room: toRoom(room, config),
        participants,
        my_role: participant.role,
        // Top-level max_auto_turns is the room's EFFECTIVE turn limit (identical
        // to room.effective_settings.max_auto_turns), kept for the sidebar meter.
        max_auto_turns: effectiveRoomSettings(room, config).max_auto_turns,
        ...(config.publicBaseUrl ? { public_base_url: config.publicBaseUrl } : {}),
      });
    }),
  );

  router.patch(
    '/rooms/:id/settings',
    roomGuard(store),
    h(async (req, res) => {
      const { room, participant } = getRoomCtx(req);
      // Tier-1 settings are owner-only and server-owned. A non-participant
      // already got 404 from roomGuard (hiding room existence); any other
      // participant role -> 403.
      if (participant.role !== 'owner') {
        throw forbidden('Only the room owner can change room settings.');
      }
      // Range/type validation (max_auto_turns int 1..100; retention_days >= 0;
      // storage_bytes int > 0; explicit null clears) -> 422 on failure. Omitted
      // fields are left unchanged; an empty body {} is a valid no-op.
      const patch = parse(RoomSettingsPatchRequestSchema, req.body);
      store.updateRoomSettings(room.id, patch);
      const updated = store.getRoom(room.id);
      if (!updated) throw notFound('Room not found.');
      const roomOut = toRoom(updated, config);
      // Broadcast the updated room (with recomputed effective_settings) so every
      // socket sees the new turn budget / retention / quota. Reads are
      // per-request, so the very next decision already uses the new values.
      hub.broadcast(room.id, { type: 'room_updated', room: roomOut });
      res.status(200).json({ room: roomOut });
    }),
  );

  return router;
}
