/** Safe, idempotent SSH loopback forwarding for a browser on another machine. */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const INCLUDE = 'Include ~/.ssh/clausroom/config';
const HEADER = '# Managed by clausroom. Use `clausroom ssh add` to update an entry.\n';
const RESET = '# END CLAUSROOM MANAGED HOSTS\nHost *\n';

export interface SshForwardOptions {
  name: string;
  host: string;
  user: string;
  sshPort: number;
  clausroomPort: number;
}

export interface SshForwardResult {
  alias: string;
  config: string;
}

function checked(options: SshForwardOptions): SshForwardOptions & { alias: string } {
  const name = options.name.toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(name)) {
    throw new Error('name must contain only letters, numbers, dots, dashes, or underscores');
  }
  if (!/^[A-Za-z0-9:.%_-]+$/.test(options.host)) {
    throw new Error('host must be a hostname or IP address');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._@%+\\-]*$/.test(options.user)) {
    throw new Error('user is not a valid SSH username');
  }
  for (const [label, value] of [
    ['ssh-port', options.sshPort],
    ['clausroom-port', options.clausroomPort],
  ] as const) {
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
      throw new Error(`${label} must be an integer from 1 to 65535`);
    }
  }
  return { ...options, name, alias: `clausroom-${name}` };
}

function shellWord(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)
    ? value
    : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The exact one-line command a remote Clausroom process can print for its user. */
export function formatSshAddCommand(options: SshForwardOptions): string {
  const value = checked(options);
  return [
    'clausroom ssh add',
    shellWord(value.name),
    '--host',
    shellWord(value.host),
    '--user',
    shellWord(value.user),
    '--ssh-port',
    String(value.sshPort),
    '--clausroom-port',
    String(value.clausroomPort),
  ].join(' ');
}

function atomicWrite(file: string, text: string, mode: number): void {
  const destination = fs.existsSync(file) ? fs.realpathSync(file) : file;
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );
  try {
    fs.writeFileSync(temporary, text, { encoding: 'utf8', flag: 'wx', mode });
    fs.renameSync(temporary, destination);
    fs.chmodSync(destination, mode);
  } catch (err) {
    try {
      fs.unlinkSync(temporary);
    } catch {
      /* nothing was left behind */
    }
    throw err;
  }
}

function withManagedInclude(text: string): string {
  const include = /^\s*include\s+(?:"~\/\.ssh\/clausroom\/config"|~\/\.ssh\/clausroom\/config)\s*(?:#.*)?$/i;
  const lines = text
    .split(/\r?\n/)
    .filter((line) => !include.test(line));
  while (lines.at(-1) === '') lines.pop();
  // OpenSSH keeps the first value it finds. Put our exact per-host values before
  // global defaults; the managed file restores `Host *` before returning here.
  const boundary = lines.findIndex((line) => line.trim() && !/^\s*#/.test(line));
  const at = boundary < 0 ? lines.length : boundary;
  const before = lines.slice(0, at);
  const after = lines.slice(at);
  while (before.at(-1) === '') before.pop();
  while (after[0] === '') after.shift();
  return `${[
    ...before,
    ...(before.length > 0 && before.at(-1)?.trim() ? [''] : []),
    INCLUDE,
    ...(after.length > 0 && after[0]?.trim() ? [''] : []),
    ...after,
  ].join('\n')}\n`;
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function entry(options: SshForwardOptions & { alias: string }): string {
  return [
    `# BEGIN ${options.alias}`,
    `Host ${options.alias}`,
    `    HostName ${options.host}`,
    `    User ${options.user}`,
    `    Port ${options.sshPort}`,
    `    LocalForward 127.0.0.1:${options.clausroomPort} 127.0.0.1:${options.clausroomPort}`,
    '    ExitOnForwardFailure yes',
    `# END ${options.alias}`,
    '',
  ].join('\n');
}

/** Add or replace one Clausroom-owned Host entry without touching user entries. */
export function addSshForward(
  options: SshForwardOptions,
  home: string = os.homedir(),
): SshForwardResult {
  const value = checked(options);
  const sshDir = path.join(home, '.ssh');
  const managedDir = path.join(sshDir, 'clausroom');
  const mainConfig = path.join(sshDir, 'config');
  const managedConfig = path.join(managedDir, 'config');

  fs.mkdirSync(sshDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(managedDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(managedDir, 0o700);

  const main = fs.existsSync(mainConfig) ? fs.readFileSync(mainConfig, 'utf8') : '';
  const mainMode = fs.existsSync(mainConfig) ? fs.statSync(mainConfig).mode & 0o777 : 0o600;
  const nextMain = withManagedInclude(main);
  if (nextMain !== main) atomicWrite(mainConfig, nextMain, mainMode);

  const managed = fs.existsSync(managedConfig)
    ? fs.readFileSync(managedConfig, 'utf8')
    : HEADER;
  const block = new RegExp(
    `^# BEGIN ${regexEscape(value.alias)}\\r?\\n[\\s\\S]*?^# END ${regexEscape(value.alias)}\\r?\\n?`,
    'gmi',
  );
  const withoutReset = managed.replace(
    /\n*# END CLAUSROOM MANAGED HOSTS\r?\nHost \*\s*$/i,
    '',
  );
  const withoutOld = withoutReset.replace(block, '').trim();
  const nextManaged = `${withoutOld || HEADER.trim()}\n\n${entry(value)}${RESET}`;
  if (nextManaged !== managed) atomicWrite(managedConfig, nextManaged, 0o600);
  else fs.chmodSync(fs.realpathSync(managedConfig), 0o600);

  return { alias: value.alias, config: managedConfig };
}
