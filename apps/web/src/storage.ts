/**
 * localStorage-backed persistence for the session token and the server base
 * URL. An empty server base means "same origin" (the normal deployment: the
 * server serves this UI itself).
 */

const TOKEN_KEY = 'clausroom.session_token';
const BASE_KEY = 'clausroom.server_base';

function safeGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string | null): void {
  try {
    if (value === null || value === '') window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Private-mode / quota errors: the app still works for this tab's lifetime.
  }
}

export function getSessionToken(): string | null {
  return safeGet(TOKEN_KEY);
}

export function setSessionToken(token: string | null): void {
  safeSet(TOKEN_KEY, token);
}

/** Normalized (no trailing slash) server base, or '' meaning same-origin. */
export function getServerBase(): string {
  const raw = safeGet(BASE_KEY) ?? '';
  return normalizeBase(raw);
}

export function setServerBase(base: string): void {
  safeSet(BASE_KEY, normalizeBase(base));
}

export function normalizeBase(base: string): string {
  const trimmed = base.trim().replace(/\/+$/, '');
  if (trimmed === '' || trimmed === window.location.origin) return '';
  return trimmed;
}

/** The absolute HTTP origin requests go to (used for display + snippets). */
export function effectiveOrigin(): string {
  return getServerBase() || window.location.origin;
}
