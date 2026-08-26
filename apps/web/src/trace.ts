/** Copyable, address-free browser diagnostics for failures on another machine. */
const LIMIT = 300;
const started = performance.now();
const entries: string[] = [];

export function trace(scope: 'signal' | 'peer', message: string, detail?: unknown): void {
  let suffix = '';
  if (detail !== undefined) {
    try {
      suffix = `  ${JSON.stringify(detail)}`;
    } catch {
      suffix = `  ${String(detail)}`;
    }
  }
  const line = `${((performance.now() - started) / 1000).toFixed(2).padStart(8)}s  ${scope.padEnd(6)} ${message}${suffix.slice(0, 240)}`;
  entries.push(line);
  if (entries.length > LIMIT) entries.shift();
  console.info(`[clausroom-${scope}] ${message}`, detail ?? '');
}

export function traceText(): string {
  return [`clausroom network diagnostics · ${new Date().toISOString()}`, ...entries].join('\n');
}
