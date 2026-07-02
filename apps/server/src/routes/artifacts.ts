/**
 * POST /api/rooms/:id/artifacts                      — multipart upload (can_upload required).
 * GET  /api/rooms/:id/artifacts                      — list (any participant).
 * GET  /api/rooms/:id/artifacts/:artifactId          — metadata (any participant).
 * GET  /api/rooms/:id/artifacts/:artifactId/download — stream (any participant; no IDOR).
 *
 * Uploads land in a tmp dir under the artifact dir (multer disk storage with a
 * hard size limit), are hashed by streaming, then moved to
 * <artifactDir>/<room_id>/<artifact_id>/<sha256>__<sanitized_filename>.
 */
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { DEFAULTS, genId } from '@clausroom/protocol';
import { HttpError, notFound, tooLarge, validation } from '../errors.js';
import { getAuth, getRoomCtx, roomGuard } from '../auth.js';
import { nowIso, toArtifact, type ApprovalRow, type ArtifactRow, type Store } from '../db.js';
import { isArchive, matchesSecretNameGlob, sanitizeFilename } from '../policy.js';
import { createMessage, publishMessage } from '../messageService.js';
import { withLazyExpiry } from './approvals.js';
import type { WsHub } from '../ws.js';
import type { ServerConfig } from '../env.js';
import { h, parse } from './util.js';

const APPROVAL_REQUIRED_MESSAGE =
  'This upload requires an approved artifact_upload approval. Call room_request_human_approval first.';

const UploadFieldsSchema = z.object({
  description: z.string().max(DEFAULTS.MAX_BODY_CHARS).optional(),
  approval_id: z.string().optional(),
});

/** Stream-hash a file (never readFileSync — uploads can be up to 100 MiB). */
async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

function removeIfExists(filePath: string | undefined): void {
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // best-effort tmp cleanup
  }
}

/**
 * True iff the approval's payload identifies the uploaded file: payload.sha256
 * must be present and equal the computed content hash (case-insensitive hex),
 * and payload.size_bytes, when numeric, must equal the uploaded size. Binding
 * the approval to the file keeps a human "yes" for one concrete file from
 * authorizing the upload of a different one (docs/API-CONTRACT.md §5).
 */
function approvalMatchesFile(row: ApprovalRow, sha256: string, sizeBytes: number): boolean {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload_json);
  } catch {
    return false;
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const p = payload as Record<string, unknown>;
  if (typeof p.sha256 !== 'string' || p.sha256.toLowerCase() !== sha256) return false;
  if (typeof p.size_bytes === 'number' && p.size_bytes !== sizeBytes) return false;
  return true;
}

export function artifactRoutes(store: Store, hub: WsHub, config: ServerConfig): Router {
  const router = Router();

  const tmpDir = path.join(config.artifactDir, '.tmp');
  fs.mkdirSync(tmpDir, { recursive: true });

  const upload = multer({
    storage: multer.diskStorage({ destination: tmpDir }),
    limits: { fileSize: config.maxUploadBytes, files: 1 },
  });

  /** multer with error mapping (LIMIT_FILE_SIZE -> 413 too_large, abort). */
  const uploadMiddleware: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
    upload.single('file')(req, res, (err: unknown) => {
      if (!err) return next();
      removeIfExists(req.file?.path);
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return next(
            tooLarge(`Upload exceeds the ${config.maxUploadBytes} byte limit.`),
          );
        }
        return next(validation(`Invalid multipart upload: ${err.message}`));
      }
      next(err);
    });
  };

  const requireCanUpload: RequestHandler = (req, _res, next) => {
    const { participant } = getRoomCtx(req);
    if (participant.can_upload !== 1) {
      return next(
        new HttpError(403, 'forbidden', 'You do not have permission to upload in this room.'),
      );
    }
    next();
  };

  router.post(
    '/rooms/:id/artifacts',
    roomGuard(store),
    requireCanUpload,
    uploadMiddleware,
    h(async (req, res) => {
      const auth = getAuth(req);
      const { room } = getRoomCtx(req);
      const file = req.file;
      if (!file) throw validation('A `file` field is required (multipart/form-data).');

      try {
        const fields = parse(UploadFieldsSchema, req.body ?? {});
        const description =
          fields.description !== undefined && fields.description.length > 0
            ? fields.description
            : undefined;
        const approvalId =
          fields.approval_id !== undefined && fields.approval_id.length > 0
            ? fields.approval_id
            : undefined;

        const sanitized = sanitizeFilename(file.originalname);
        const mimeType = file.mimetype || 'application/octet-stream';
        const sizeBytes = file.size;

        // Resolve a supplied approval_id up front: unknown in this room -> 404.
        let approvalRow = null;
        if (approvalId !== undefined) {
          const found = store.getApprovalInRoom(room.id, approvalId);
          if (!found) throw notFound('No such approval in this room.');
          approvalRow = withLazyExpiry(store, found);
        }

        const sha256 = await sha256File(file.path);

        // Agent approval gate.
        let consumeApprovalId: string | null = null;
        if (auth.user.kind === 'agent') {
          const needsApproval =
            sizeBytes > config.requireApprovalBytes ||
            matchesSecretNameGlob(sanitized, file.originalname) ||
            isArchive(file.originalname, mimeType) ||
            isArchive(sanitized, mimeType);
          if (needsApproval) {
            if (
              approvalRow === null ||
              approvalRow.status !== 'approved' ||
              approvalRow.approval_type !== 'artifact_upload' ||
              approvalRow.requested_by !== auth.user.id ||
              approvalRow.consumed_at !== null ||
              !approvalMatchesFile(approvalRow, sha256, sizeBytes)
            ) {
              throw new HttpError(403, 'approval_required', APPROVAL_REQUIRED_MESSAGE);
            }
            // Single-use: the approval is consumed by this upload (in the
            // same transaction as the artifact row below).
            consumeApprovalId = approvalRow.id;
          }
        }

        const artifactId = genId('art');
        const destDir = path.join(config.artifactDir, room.id, artifactId);
        fs.mkdirSync(destDir, { recursive: true });
        const storagePath = path.join(destDir, `${sha256}__${sanitized}`);
        fs.renameSync(file.path, storagePath);

        const row: ArtifactRow = {
          id: artifactId,
          room_id: room.id,
          uploaded_by: auth.user.id,
          filename: sanitized,
          mime_type: mimeType,
          size_bytes: sizeBytes,
          sha256,
          storage_path: storagePath,
          approval_id: approvalId ?? null,
          created_at: nowIso(),
          expires_at: null,
        };
        // The artifact row, its mandatory artifact_uploaded message, and the
        // approval consumption commit atomically; the broadcast + MSG log line
        // happen only after the transaction commits. The auto-message bypasses
        // agent pause/turn/rate checks (the agent gate is the approval gate).
        const message = store.transaction(() => {
          store.insertArtifact(row);
          if (consumeApprovalId) store.consumeApproval(consumeApprovalId, row.created_at);
          return createMessage(store, {
            roomId: room.id,
            sender: auth.user,
            messageType: 'artifact_uploaded',
            bodyMarkdown: description ?? sanitized,
            artifactIds: [artifactId],
            recipientIds: [],
          });
        });
        publishMessage(hub, message);

        res.status(201).json({ artifact: toArtifact(row), message });
      } finally {
        // If anything failed before the rename, drop the tmp file.
        removeIfExists(file.path);
      }
    }),
  );

  router.get(
    '/rooms/:id/artifacts',
    roomGuard(store),
    h(async (req, res) => {
      const { room } = getRoomCtx(req);
      res.status(200).json({ artifacts: store.listArtifacts(room.id).map(toArtifact) });
    }),
  );

  router.get(
    '/rooms/:id/artifacts/:artifactId',
    roomGuard(store),
    h(async (req, res) => {
      const { room } = getRoomCtx(req);
      const artifactId = req.params.artifactId;
      const row = artifactId ? store.getArtifactInRoom(room.id, artifactId) : undefined;
      if (!row) throw notFound('No such artifact in this room.');
      res.status(200).json({ artifact: toArtifact(row) });
    }),
  );

  router.get(
    '/rooms/:id/artifacts/:artifactId/download',
    roomGuard(store),
    h(async (req, res) => {
      const { room } = getRoomCtx(req);
      const artifactId = req.params.artifactId;
      const row = artifactId ? store.getArtifactInRoom(room.id, artifactId) : undefined;
      if (!row) throw notFound('No such artifact in this room.');
      if (!fs.existsSync(row.storage_path)) {
        throw notFound('Artifact file is missing from storage.');
      }
      res.status(200);
      res.setHeader('Content-Type', row.mime_type);
      res.setHeader('Content-Length', String(row.size_bytes));
      res.setHeader('Content-Disposition', `attachment; filename="${row.filename}"`);
      // pipeline (unlike stream.pipe) destroys the read stream when the
      // response closes early, so a client abort cannot leak the file fd.
      const stream = fs.createReadStream(row.storage_path);
      try {
        await pipeline(stream, res);
      } catch {
        // Premature close (client abort) or a mid-stream read error: both
        // streams are already destroyed by pipeline; nothing to send.
        if (!res.destroyed) res.destroy();
      }
    }),
  );

  return router;
}
