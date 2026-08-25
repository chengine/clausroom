/**
 * ~/.clausroom/session.json — the only runtime state, mode 0600 on POSIX.
 *
 * `host` and `connect` write it when a room comes up and delete it when they
 * exit; `mcp` and `auto` read it to learn where the room is and which token to
 * use. It holds the facts a config file should never contain, plus the read
 * cursor so an agent does not re-read the same messages after a restart.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { TOKEN_PREFIX } from '@clausroom/protocol';

const SessionSchema = z.object({
  /** The host/connect process that owns this file. */
  pid: z.number().int().positive(),
  role: z.enum(['host', 'guest']),
  /** Loopback URL of the room server: the real one, or the guest's peer proxy. */
  server: z.string().regex(/^http:\/\/(127\.0\.0\.1|\[::1\]):\d+$/),
  room: z.string().regex(/^room_[0-9a-f]{24}$/),
  /** The local agent's room-scoped token. */
  token: z.string().regex(new RegExp(`^${TOKEN_PREFIX.bridge}[0-9a-f]{32}$`)),
  me: z.string().min(1).max(100),
  agent_name: z.string().min(1).max(100),
  /** Newest message this agent has read, or null for "nothing yet". */
  cursor: z.string().nullable(),
  /** Exact local harness conversation used by auto-reply; never "latest". */
  engine_session: z
    .object({ agent: z.enum(['claude', 'codex']), id: z.string().uuid() })
    .optional(),
});

export type Session = z.infer<typeof SessionSchema>;

/** Overridable so tests can run without touching a real home directory. */
function stateDir(): string {
  return process.env.CLAUSROOM_STATE_DIR
    ? path.resolve(process.env.CLAUSROOM_STATE_DIR)
    : path.join(os.homedir(), '.clausroom');
}

function sessionFile(): string {
  return path.join(stateDir(), 'session.json');
}

/** Create the file with 0600 from the start, then move it into place. */
async function writePrivate(file: string, contents: string): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fsp.chmod(path.dirname(file), 0o700);
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}`;
  await fsp.writeFile(temp, contents, { mode: 0o600, flag: 'wx' });
  try {
    await fsp.rename(temp, file);
  } catch (err) {
    await fsp.rm(temp, { force: true });
    throw err;
  }
}

export async function writeSession(session: Session): Promise<void> {
  await writePrivate(sessionFile(), `${JSON.stringify(session, null, 2)}\n`);
}

/**
 * The live session, or an error explaining what to run. A file left behind by a
 * crashed process is removed rather than trusted.
 */
export async function readSession(): Promise<Session> {
  const file = sessionFile();
  let raw: string;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch {
    throw new Error('No room is running. Start one with `clausroom host` or `clausroom connect`.');
  }
  const stat = await fsp.lstat(file);
  if (!stat.isFile() || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) {
    throw new Error(`Refusing ${file}: it must be a regular file with no group or world access.`);
  }
  const parsed = SessionSchema.safeParse(JSON.parse(raw) as unknown);
  if (!parsed.success) throw new Error(`${file} is not a valid clausroom session.`);
  if (!alive(parsed.data.pid)) {
    await fsp.rm(file, { force: true });
    throw new Error('The last room is no longer running. Start `clausroom host` or `connect` again.');
  }
  return parsed.data;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Remove the session file, but only if this process still owns it. */
export async function clearSession(): Promise<void> {
  try {
    const parsed = SessionSchema.safeParse(
      JSON.parse(await fsp.readFile(sessionFile(), 'utf8')) as unknown,
    );
    if (parsed.success && parsed.data.pid === process.pid) {
      await fsp.rm(sessionFile(), { force: true });
    }
  } catch {
    /* nothing to clear */
  }
}

/**
 * Move the read cursor forward. Called by the agent-facing processes, which do
 * not own the file, so it patches just that field and never creates one.
 */
export function saveCursor(messageId: string): void {
  patchSession((session) =>
    session.cursor === messageId ? session : { ...session, cursor: messageId },
  );
}

/** Remember or forget the exact Claude/Codex conversation used by this room. */
export function saveEngineSession(agent: 'claude' | 'codex', id?: string): void {
  patchSession((session) => {
    if (!id) {
      const { engine_session: _old, ...rest } = session;
      return rest;
    }
    return { ...session, engine_session: { agent, id } };
  });
}

function patchSession(update: (session: Session) => Session): void {
  const file = sessionFile();
  try {
    const parsed = SessionSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')) as unknown);
    if (!parsed.success) return;
    const next = update(parsed.data);
    fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, {
      mode: 0o600,
    });
  } catch {
    /* Runtime continuity is useful, but never a reason to stop the room. */
  }
}

/** Where downloaded artifacts land, and nowhere else. */
export function downloadsDir(): string {
  return path.join(stateDir(), 'downloads');
}
