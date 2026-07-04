/**
 * POST /api/rooms/:id/my-agent — self-service agent provisioning (onboarding v2).
 *
 * An authenticated HUMAN participant provisions THEIR OWN agent in-app, so the
 * room owner no longer has to relay bridge tokens out of band:
 *   - rotate: if the caller already owns an agent participant in this room, revoke
 *     all of that agent's bridge tokens for this room and mint a fresh one
 *     (participant unchanged, agent_name ignored);
 *   - create: otherwise create a new agent user (kind 'agent', owner = caller),
 *     insert it as an agent participant, and mint its bridge token.
 *
 * The raw bridge token is shown EXACTLY ONCE, in this response, together with a
 * ready-to-run `join_command`. See docs/API-CONTRACT.md §3 (POST …/my-agent).
 *
 * SECURITY INVARIANT: this endpoint returns connection info plus the caller's OWN
 * bridge token only — never the recipient's local security config. The join blob
 * carries { v, server_url, room_id, token, agent_name? }; `clausroom-bridge join`
 * writes bridge.toml with SAFE LOCAL DEFAULTS (roots chosen by the joining user).
 */
import { Router } from 'express';
import {
  MyAgentRequestSchema,
  encodeJoinBlob,
  genId,
  newBridgeToken,
  sha256Hex,
} from '@clausroom/protocol';
import { forbidden } from '../errors.js';
import { getAuth, getRoomCtx, roomGuard } from '../auth.js';
import {
  nowIso,
  toParticipant,
  type ParticipantRow,
  type Store,
  type TokenRow,
  type UserRow,
} from '../db.js';
import type { ServerConfig } from '../env.js';
import type { WsHub } from '../ws.js';
import { h, parse } from './util.js';

/** A fresh bridge (arbt_) token row scoped to one room for one agent user. */
function bridgeTokenRow(rawToken: string, agentUser: UserRow, roomId: string, now: string): TokenRow {
  return {
    id: genId('tok'),
    kind: 'bridge',
    token_hash: sha256Hex(rawToken),
    user_id: agentUser.id,
    room_id: roomId,
    name: agentUser.display_name,
    created_at: now,
    last_used_at: null,
    used_at: null,
    revoked_at: null,
  };
}

export function myAgentRoutes(store: Store, hub: WsHub, config: ServerConfig): Router {
  const router = Router();

  router.post(
    '/rooms/:id/my-agent',
    roomGuard(store),
    h(async (req, res) => {
      const auth = getAuth(req);
      const { room } = getRoomCtx(req);
      // Authenticated HUMAN participant only. Bridge tokens / agents -> 403.
      // Non-participants already got 404 from roomGuard (room-hiding rule).
      if (auth.tokenKind !== 'session' || auth.user.kind !== 'human') {
        throw forbidden('Only a human participant can provision their own agent.');
      }
      const body = parse(MyAgentRequestSchema, req.body);

      const now = nowIso();
      const rawToken = newBridgeToken();

      // "The caller's agent" is the agent participant of this room whose user's
      // owner_user_id == the caller. A caller owns at most one such agent here.
      const existing = store
        .listParticipants(room.id)
        .find(
          ({ participant, user }) =>
            participant.role === 'agent' &&
            user.kind === 'agent' &&
            user.owner_user_id === auth.user.id,
        );

      let agentUser: UserRow;
      let participantRow: ParticipantRow;

      if (existing) {
        // Rotate: revoke all this agent's bridge tokens for this room, mint fresh.
        // The participant is unchanged and agent_name is ignored.
        agentUser = existing.user;
        participantRow = existing.participant;
        store.transaction(() => {
          store.revokeBridgeTokens(agentUser.id, room.id, now);
          store.insertToken(bridgeTokenRow(rawToken, agentUser, room.id, now));
        });
      } else {
        // Create a new agent user owned by the caller, insert it as a participant,
        // and mint its bridge token. Cap the server default name at 100 chars.
        agentUser = {
          id: genId('user'),
          display_name: (body.agent_name ?? `${auth.user.display_name}'s Agent`).slice(0, 100),
          email: null,
          kind: 'agent',
          is_admin: 0,
          owner_user_id: auth.user.id,
          created_at: now,
        };
        participantRow = {
          room_id: room.id,
          user_id: agentUser.id,
          role: 'agent',
          can_send: 1,
          can_upload: 1,
          paused: 0,
        };
        store.transaction(() => {
          store.insertUser(agentUser);
          store.insertParticipant(participantRow);
          store.insertToken(bridgeTokenRow(rawToken, agentUser, room.id, now));
        });
      }

      const participant = toParticipant(participantRow, agentUser);

      // server_url: AGENT_ROOM_PUBLIC_BASE_URL when set, else the request origin.
      const serverUrl =
        config.publicBaseUrl ??
        `${req.protocol}://${req.get('host') ?? `${config.host}:${config.port}`}`;
      const joinCommand =
        'npx -y clausroom-bridge join ' +
        encodeJoinBlob({
          v: 1,
          server_url: serverUrl,
          room_id: room.id,
          token: rawToken,
          // Seed [identity].agent_name in bridge.toml; blob caps this at 100 chars.
          agent_name: agentUser.display_name.slice(0, 100),
        });

      // participant_updated covers both create and rotate — there is no
      // participant_created frame; a fresh participant surfaces via this frame.
      hub.broadcast(room.id, { type: 'participant_updated', participant });

      res.status(200).json({
        participant,
        bridge_token: rawToken,
        join_command: joinCommand,
      });
    }),
  );

  return router;
}
