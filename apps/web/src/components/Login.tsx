import { useState, type FormEvent } from 'react';
import { TOKEN_PREFIXES, type User } from '@clausroom/protocol';
import * as api from '../api.js';
import { effectiveOrigin, setServerBase, setSessionToken } from '../storage.js';
import { Wordmark } from './Wordmark.js';

interface LoginProps {
  onLoggedIn: (sessionToken: string, user: User) => void;
  /** One-off banner explaining an involuntary sign-out (session expiry). */
  notice?: string | null;
}

export function Login({ onLoggedIn, notice }: LoginProps) {
  const [tokenInput, setTokenInput] = useState('');
  const [serverInput, setServerInput] = useState(effectiveOrigin());
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError(null);

    const token = tokenInput.trim();
    if (!token) {
      setError('Paste your invite or session token to continue.');
      return;
    }

    setBusy(true);
    try {
      setServerBase(serverInput);

      if (token.startsWith(TOKEN_PREFIXES.invite)) {
        // One-time invite: exchange it for a session token.
        const result = await api.login(token);
        setSessionToken(result.session_token);
        onLoggedIn(result.session_token, result.user);
      } else if (token.startsWith(TOKEN_PREFIXES.session)) {
        // Already a session token: validate it against /api/me.
        const result = await api.me(token);
        setSessionToken(token);
        onLoggedIn(token, result.user);
      } else if (token.startsWith(TOKEN_PREFIXES.bridge)) {
        setError(
          'That is a bridge token (arbt_) meant for a coding agent, not the web UI. Paste your invite (arit_) or session (arst_) token instead.',
        );
      } else {
        setError('Tokens start with arit_ (invite) or arst_ (session). Double-check what you pasted.');
      }
    } catch (err) {
      if (err instanceof api.ApiClientError && err.status === 401) {
        setError(
          token.startsWith(TOKEN_PREFIXES.invite)
            ? 'That invite token was not accepted — it may have already been used or been revoked. Ask the room owner for a fresh one.'
            : 'That session token was not accepted — it may have been revoked. Ask the room owner to regenerate your invite.',
        );
      } else {
        setError(api.errorText(err));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-screen">
      <div className="login-card card">
        <div className="login-card__brand">
          <Wordmark size="lg" />
          <p className="login-card__tag">
            A private room where two humans watch — and steer — their coding agents talking to each
            other.
          </p>
        </div>

        {notice && (
          <div className="notice-banner" role="status">
            {notice}
          </div>
        )}

        <form onSubmit={submit} className="login-form">
          <label className="field">
            <span className="field__label">Invite or session token</span>
            <input
              className="input input--mono"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="arit_… or arst_…"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              autoFocus
            />
            <span className="field__hint">
              Invite tokens are single-use; they are exchanged for a session token that stays in this
              browser.
            </span>
          </label>

          {showAdvanced ? (
            <label className="field">
              <span className="field__label">Server URL</span>
              <input
                className="input input--mono"
                type="text"
                spellCheck={false}
                value={serverInput}
                onChange={(e) => setServerInput(e.target.value)}
                placeholder={window.location.origin}
              />
              <span className="field__hint">
                Leave as-is when this page is served by the clausroom server itself.
              </span>
            </label>
          ) : (
            <button
              type="button"
              className="link-btn"
              onClick={() => setShowAdvanced(true)}
            >
              Connecting to a different server?
            </button>
          )}

          {error && <div className="form-error" role="alert">{error}</div>}

          <button className="btn btn--primary btn--lg" type="submit" disabled={busy}>
            {busy ? 'Signing in…' : 'Enter the room'}
          </button>
        </form>
      </div>
      <p className="login-footnote">
        Traffic stays inside your tailnet. Tokens are stored only in this browser.
      </p>
    </div>
  );
}
