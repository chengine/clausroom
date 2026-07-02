/**
 * POST /api/rooms/:id/participants               — add a participant (owner only).
 * POST /api/rooms/:id/participants/:userId/token — rotate a participant's token (owner only).
 *
 * Raw tokens appear exactly once: in these responses.
 */
import { Router } from 'express';
import {
  AddParticipantRequestSchema,
  genId,
  newBridgeToken,
  newInviteToken,
  sha256Hex,
} from '@clausroom/protocol';
import { forbidden, notFound, validation } from '../errors.js';
import { getAuth, getRoomCtx, roomGuard } from '../auth.js';
import { nowIso, toParticipant, type Store, type TokenRow } from '../db.js';
import { h, parse } from './util.js';

export function participantRoutes(store: Store): Router {
  const router = Router();

  router.post(
    '/rooms/:id/participants',
    roomGuard(store),
    h(async (req, res) => {
      const auth = getAuth(req);
      const { room, participant: caller } = getRoomCtx(req);
      if (caller.role !== 'owner') {
        throw forbidden('Only the room owner can add participants.');
      }
      const body = parse(AddParticipantRequestSchema, req.body);

      let ownerUserId: string | null = null;
      if (body.kind === 'agent') {
        const candidate = body.owner_user_id ?? auth.user.id;
        const ownerUser = store.getUserById(candidate);
        const ownerParticipant = store.getParticipant(room.id, candidate);
        if (!ownerUser || ownerUser.kind !== 'human' || !ownerParticipant) {
          throw validation('owner_user_id must be a human participant of this room.');
        }
        ownerUserId = candidate;
      }

      const now = nowIso();
      const newUser = {
        id: genId('user'),
        display_name: body.display_name,
        email: null,
        kind: body.kind,
        is_admin: 0,
        owner_user_id: ownerUserId,
        created_at: now,
      };
      const newParticipant = {
        room_id: room.id,
        user_id: newUser.id,
        role: body.role,
        can_send: body.role === 'observer' ? 0 : 1,
        can_upload: 1,
        paused: 0,
      };

      const rawToken = body.kind === 'human' ? newInviteToken() : newBridgeToken();
      const tokenRow: TokenRow = {
        id: genId('tok'),
        kind: body.kind === 'human' ? 'invite' : 'bridge',
        token_hash: sha256Hex(rawToken),
        user_id: newUser.id,
        room_id: body.kind === 'human' ? null : room.id,
        name: body.display_name,
        created_at: now,
        last_used_at: null,
        used_at: null,
        revoked_at: null,
      };

      store.transaction(() => {
        store.insertUser(newUser);
        store.insertParticipant(newParticipant);
        store.insertToken(tokenRow);
      });

      const payload: Record<string, unknown> = {
        participant: toParticipant(newParticipant, newUser),
      };
      if (body.kind === 'human') payload.invite_token = rawToken;
      else payload.bridge_token = rawToken;
      res.status(201).json(payload);
    }),
  );

  router.post(
    '/rooms/:id/participants/:userId/token',
    roomGuard(store),
    h(async (req, res) => {
      const { room, participant: caller } = getRoomCtx(req);
      if (caller.role !== 'owner') {
        throw forbidden('Only the room owner can rotate participant tokens.');
      }
      const targetUserId = req.params.userId;
      if (!targetUserId) throw notFound('No such participant in this room.');
      const target = store.getParticipant(room.id, targetUserId);
      const targetUser = target ? store.getUserById(target.user_id) : undefined;
      if (!target || !targetUser) throw notFound('No such participant in this room.');

      const now = nowIso();
      if (targetUser.kind === 'human') {
        const rawToken = newInviteToken();
        store.transaction(() => {
          store.revokeHumanTokens(targetUser.id, now);
          store.insertToken({
            id: genId('tok'),
            kind: 'invite',
            token_hash: sha256Hex(rawToken),
            user_id: targetUser.id,
            room_id: null,
            name: targetUser.display_name,
            created_at: now,
            last_used_at: null,
            used_at: null,
            revoked_at: null,
          });
        });
        res.status(200).json({ invite_token: rawToken });
      } else {
        const rawToken = newBridgeToken();
        store.transaction(() => {
          store.revokeBridgeTokens(targetUser.id, room.id, now);
          store.insertToken({
            id: genId('tok'),
            kind: 'bridge',
            token_hash: sha256Hex(rawToken),
            user_id: targetUser.id,
            room_id: room.id,
            name: targetUser.display_name,
            created_at: now,
            last_used_at: null,
            used_at: null,
            revoked_at: null,
          });
        });
        res.status(200).json({ bridge_token: rawToken });
      }
    }),
  );

  return router;
}
