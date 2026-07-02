/**
 * POST /api/rooms/:id/approvals                     — agent/bridge only.
 * GET  /api/rooms/:id/approvals?status=…            — any participant.
 * POST /api/rooms/:id/approvals/:approvalId/respond — reviewer only.
 *
 * Lazy expiry (BINDING): whenever an approval is read or responded to, a
 * pending approval older than DEFAULTS.APPROVAL_TTL_MS (1 h) is treated and
 * returned as expired; the flip is persisted when observed.
 */
import { Router } from 'express';
import {
  ApprovalStatusSchema,
  CreateApprovalRequestSchema,
  DEFAULTS,
  RespondApprovalRequestSchema,
  genId,
} from '@clausroom/protocol';
import { conflict, forbidden, notFound, validation } from '../errors.js';
import { getAuth, getRoomCtx, roomGuard } from '../auth.js';
import { nowIso, toApproval, type ApprovalRow, type Store } from '../db.js';
import { createAndBroadcastMessage } from '../messageService.js';
import type { WsHub } from '../ws.js';
import { h, parse } from './util.js';

/**
 * Apply lazy expiry to an approval row: pending + created_at older than the
 * TTL => treat (and persist) as expired. Returns the effective row.
 */
export function withLazyExpiry(store: Store, row: ApprovalRow, now = Date.now()): ApprovalRow {
  if (row.status === 'pending' && now - Date.parse(row.created_at) > DEFAULTS.APPROVAL_TTL_MS) {
    try {
      store.expireApproval(row.id);
    } catch {
      // Persisting is best-effort; the returned value is what's binding.
    }
    return { ...row, status: 'expired' };
  }
  return row;
}

export function approvalRoutes(store: Store, hub: WsHub): Router {
  const router = Router();

  router.post(
    '/rooms/:id/approvals',
    roomGuard(store),
    h(async (req, res) => {
      const auth = getAuth(req);
      const { room } = getRoomCtx(req);
      if (auth.tokenKind !== 'bridge') {
        throw forbidden('Only agent bridge tokens can request approvals.');
      }
      const body = parse(CreateApprovalRequestSchema, req.body);

      const ownerId = auth.user.owner_user_id;
      const owner = ownerId ? store.getUserById(ownerId) : undefined;
      const ownerParticipant = ownerId ? store.getParticipant(room.id, ownerId) : undefined;
      if (!ownerId || !owner || owner.kind !== 'human' || !ownerParticipant) {
        throw validation(
          'This agent has no owning human participant in this room to review approvals.',
        );
      }

      const now = nowIso();
      const row: ApprovalRow = {
        id: genId('apr'),
        room_id: room.id,
        requested_by: auth.user.id,
        reviewer_user_id: ownerId,
        approval_type: body.approval_type,
        payload_json: JSON.stringify(body.payload),
        status: 'pending',
        created_at: now,
        resolved_at: null,
        expires_at: new Date(Date.parse(now) + DEFAULTS.APPROVAL_TTL_MS).toISOString(),
        consumed_at: null,
      };
      store.insertApproval(row);

      const approval = toApproval(row);
      hub.broadcast(room.id, { type: 'approval_created', approval });
      res.status(201).json({ approval });
    }),
  );

  router.get(
    '/rooms/:id/approvals',
    roomGuard(store),
    h(async (req, res) => {
      const { room } = getRoomCtx(req);
      let statusFilter: string | undefined;
      if (req.query.status !== undefined) {
        const parsed = ApprovalStatusSchema.safeParse(req.query.status);
        if (!parsed.success) {
          throw validation('status must be one of pending|approved|denied|expired.');
        }
        statusFilter = parsed.data;
      }
      const now = Date.now();
      const rows = store
        .listApprovals(room.id)
        .map((row) => withLazyExpiry(store, row, now))
        .filter((row) => statusFilter === undefined || row.status === statusFilter);
      res.status(200).json({ approvals: rows.map(toApproval) });
    }),
  );

  router.post(
    '/rooms/:id/approvals/:approvalId/respond',
    roomGuard(store),
    h(async (req, res) => {
      const auth = getAuth(req);
      const { room } = getRoomCtx(req);
      const approvalId = req.params.approvalId;
      const found = approvalId ? store.getApprovalInRoom(room.id, approvalId) : undefined;
      if (!found) throw notFound('No such approval in this room.');
      const effective = withLazyExpiry(store, found);

      if (auth.user.id !== effective.reviewer_user_id) {
        throw forbidden('Only the assigned reviewer can respond to this approval.');
      }
      const body = parse(RespondApprovalRequestSchema, req.body);

      if (effective.status !== 'pending') {
        throw conflict(`Approval is already ${effective.status}.`);
      }

      const resolvedAt = nowIso();
      store.resolveApproval(effective.id, body.decision, resolvedAt);
      const updated = store.getApprovalInRoom(room.id, effective.id);
      if (!updated) throw notFound('No such approval in this room.');
      const approval = toApproval(updated);

      hub.broadcast(room.id, { type: 'approval_resolved', approval });

      // system_event message sent by the System user (broadcast + MSG logged).
      const systemUser = store.getSystemUser();
      if (systemUser) {
        createAndBroadcastMessage(store, hub, {
          roomId: room.id,
          sender: systemUser,
          messageType: 'system_event',
          bodyMarkdown: `Approval ${approval.id} (${approval.approval_type}) ${body.decision} by ${auth.user.display_name}.`,
        });
      }

      res.status(200).json({ approval });
    }),
  );

  return router;
}
