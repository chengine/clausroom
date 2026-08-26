/** One-time, idempotent loopback forwarding through an existing SSH destination. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from './util.js';

function target(destination: string): string {
  const host = destination.replace(/^[^@]+@/, '');
  if (!host || host.startsWith('-') || /[\s*?!]/.test(host)) {
    throw new Error('destination must be the hostname or user@hostname you use with ssh');
  }
  return host;
}

function write(file: string, text: string, mode: number): void {
  const destination = fs.existsSync(file) ? fs.realpathSync(file) : file;
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, text, { encoding: 'utf8', flag: 'wx', mode });
    fs.renameSync(temporary, destination);
    fs.chmodSync(destination, mode);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function install(destination: string, port: number): string {
  const host = target(destination);
  const dir = path.join(os.homedir(), '.ssh');
  const file = path.join(dir, 'config');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const escaped = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const old = new RegExp(
    `^# BEGIN CLAUSROOM ${escaped}\\r?\\n[\\s\\S]*?^# END CLAUSROOM\\r?\\n?`,
    'm',
  );
  const block = `# BEGIN CLAUSROOM ${host}\nHost ${host}\n    LocalForward 127.0.0.1:${port} 127.0.0.1:${port}\n    ExitOnForwardFailure yes\nHost *\n# END CLAUSROOM\n`;
  const rest = current.replace(old, '').trimStart();
  const mode = fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : 0o600;
  write(file, `${block}${rest}`, mode);
  return file;
}

export async function setupSshForward(
  destination: string,
  sshPort: number,
  clausroomPort: number,
): Promise<void> {
  if (
    ![sshPort, clausroomPort].every(
      (value) => Number.isInteger(value) && value > 0 && value < 65536,
    )
  ) {
    throw new Error('ports must be integers from 1 to 65535');
  }
  const config = install(destination, clausroomPort);
  process.stderr.write(`[clausroom] saved the forward in ${config}; starting it now.\n`);
  const code = await run('ssh', ['-N', '-p', String(sshPort), destination]);
  if (code !== 0 && code !== 128) throw new Error(`ssh exited with code ${code}`);
}
