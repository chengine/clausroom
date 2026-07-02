/**
 * GET /api/rooms/:id/export.md — human-readable markdown transcript.
 * H1 room name, then every message ascending as
 * `### <sender display_name> (<kind>) — <created_at> — <message_type>`
 * followed by the body and a bulleted list of attached artifacts.
 */
import { Router } from 'express';
import { getRoomCtx, roomGuard } from '../auth.js';
import { toMessage, type Store } from '../db.js';
import { h } from './util.js';

export function exportRoutes(store: Store): Router {
  const router = Router();

  router.get(
    '/rooms/:id/export.md',
    roomGuard(store),
    h(async (req, res) => {
      const { room } = getRoomCtx(req);
      const lines: string[] = [`# ${room.name}`, ''];

      for (const row of store.listAllMessages(room.id)) {
        const message = toMessage(row);
        lines.push(
          `### ${message.sender.display_name} (${message.sender.kind}) — ${message.created_at} — ${message.message_type}`,
          '',
          message.body_markdown,
          '',
        );
        if (message.artifact_ids.length > 0) {
          for (const artifactId of message.artifact_ids) {
            const artifact = store.getArtifactInRoom(room.id, artifactId);
            if (artifact) {
              lines.push(
                `- ${artifact.filename} (${artifact.size_bytes} bytes, sha256 ${artifact.sha256})`,
              );
            } else {
              lines.push(`- ${artifactId} (artifact metadata unavailable)`);
            }
          }
          lines.push('');
        }
      }

      res.status(200);
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${room.id}-transcript.md"`);
      res.send(lines.join('\n'));
    }),
  );

  return router;
}
