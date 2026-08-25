/**
 * Tab-scoped persistence for the session token. sessionStorage matters here:
 * two SSH tunnels can reuse the same 127.0.0.1 origin at different times, and
 * a credential from one code machine must never bleed into the next one.
 */

const TOKEN_KEY = 'clausroom.session_token';
let memoryToken: string | null = null;

function safeGet(): string | null {
  try {
    return window.sessionStorage.getItem(TOKEN_KEY) ?? memoryToken;
  } catch {
    return memoryToken;
  }
}

function safeSet(value: string | null): void {
  memoryToken = value || null;
  try {
    if (value === null || value === '') window.sessionStorage.removeItem(TOKEN_KEY);
    else window.sessionStorage.setItem(TOKEN_KEY, value);
  } catch {
    // Private-mode / quota errors: the app still works for this tab's lifetime.
  }
}

export function getSessionToken(): string | null {
  return safeGet();
}

export function setSessionToken(token: string | null): void {
  safeSet(token);
}

/**
 * Consume the one-time local CLI handoff before the app makes any requests.
 * URL fragments are not sent to the HTTP server; remove it from the address
 * bar immediately, then retain the session using the app's normal storage.
 */
export function consumeSessionFragment(): string | null {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const token = params.get('clausroom-session');
  if (!token) return null;
  params.delete('clausroom-session');
  const remaining = params.toString();
  window.history.replaceState(
    null,
    '',
    `${window.location.pathname}${window.location.search}${remaining ? `#${remaining}` : ''}`,
  );
  if (!/^arst_[0-9a-f]{32}$/.test(token)) return null;
  setSessionToken(token);
  return token;
}
