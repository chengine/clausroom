import { useEffect, useRef, useState } from 'react';
import { TOKEN_PREFIXES, type User } from '@clausroom/protocol';
import * as api from '../api.js';
import { getSessionToken, setSessionToken } from '../storage.js';
import type { RoomMembership } from '../api.js';
import { ThemeToggle } from './ThemeToggle.js';
import { Wordmark } from './Wordmark.js';

interface JoinViewProps {
  /**
   * Credential accepted and the landing room resolved. `landingRoomId` is the
   * caller's most-recently created room, or null when they belong to none (route
   * to the rooms home).
   */
  onJoined: (sessionToken: string, user: User, landingRoomId: string | null) => void;
  /** Give up on the link and drop to the manual token-paste sign-in screen. */
  onFallback: () => void;
}

/** Most-recently created room (GET /api/me returns rooms ascending by created_at). */
function landingRoom(rooms: RoomMembership[]): string | null {
  const last = rooms[rooms.length - 1];
  return last ? last.room.id : null;
}

/**
 * /join route (docs/API-CONTRACT.md §1 "Web join links"). Reads its credential
 * from location.hash — never the query string — exchanges/stores it, strips the
 * fragment immediately, then routes into the caller's room. Two fragment shapes:
 * `#i=<arit_ invite>` (exchanged for a session at POST /api/auth/login) and
 * `#s=<arst_ session>` (stored directly; the first authenticated request
 * validates it). If both keys are present, `s` wins.
 */
export function JoinView({ onJoined, onFallback }: JoinViewProps) {
  const [error, setError] = useState<string | null>(null);
  // StrictMode invokes effects twice in dev; without this guard a single-use
  // invite would be spent on the first run and rejected on the second.
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    // Read the fragment, then strip it from the URL *before* any await so the
    // bearer token never lingers in the address bar, history, or a later Referer.
    const rawHash = window.location.hash.replace(/^#/, '');
    try {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    } catch {
      // history unavailable (rare): the flow still works, the hash just stays.
    }

    const params = new URLSearchParams(rawHash);
    const invite = params.get('i')?.trim() ?? '';
    const session = params.get('s')?.trim() ?? '';

    void (async () => {
      try {
        // `s` wins when both are present.
        if (session) {
          if (!session.startsWith(TOKEN_PREFIXES.session)) {
            setError(
              'This sign-in link looks malformed (its token is not a session token). Ask the room owner to resend it, or sign in with your token below.',
            );
            return;
          }
          // No dedicated auth call — GET /api/me is the first authenticated
          // request and validates the session token for us.
          const result = await api.me(session);
          setSessionToken(session);
          onJoined(session, result.user, landingRoom(result.rooms));
          return;
        }

        if (invite) {
          if (!invite.startsWith(TOKEN_PREFIXES.invite)) {
            setError(
              'This join link looks malformed (its token is not an invite). Ask the room owner to resend it, or sign in with your token below.',
            );
            return;
          }
          const loginResult = await api.login(invite);
          setSessionToken(loginResult.session_token);
          // Resolve the landing room; if this follow-up read hiccups, still route
          // in (to the rooms home) — the session token is already valid.
          try {
            const meResult = await api.me(loginResult.session_token);
            onJoined(loginResult.session_token, meResult.user, landingRoom(meResult.rooms));
          } catch {
            onJoined(loginResult.session_token, loginResult.user, null);
          }
          return;
        }

        // No credential in the link. If this browser already has a session,
        // treat /join as a plain entry point rather than an error.
        const stored = getSessionToken();
        if (stored) {
          const result = await api.me(stored);
          onJoined(stored, result.user, landingRoom(result.rooms));
          return;
        }

        setError(
          'This join link is missing its invite or session token. Ask the room owner to resend the link, or sign in with your token below.',
        );
      } catch (err) {
        if (api.isUnauthorized(err)) {
          setError(
            invite
              ? 'This invite link was not accepted — it may have already been used or been revoked. Ask the room owner for a fresh link.'
              : 'This sign-in link was not accepted — it may have expired or been revoked. Ask the room owner for a fresh link.',
          );
        } else {
          setError(api.errorText(err));
        }
      }
    })();
    // Run exactly once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!error) {
    return (
      <div className="boot-screen">
        <Wordmark size="lg" />
        <div className="spinner" />
        <p className="login-footnote">Signing you in…</p>
      </div>
    );
  }

  return (
    <div className="login-screen">
      <div className="login-card card">
        <div className="login-card__brand">
          <Wordmark size="lg" />
          <p className="login-card__tag">Let&rsquo;s get you into the room.</p>
        </div>

        <div className="form-error" role="alert">
          {error}
        </div>

        <button type="button" className="btn btn--primary btn--lg" onClick={onFallback}>
          Go to the sign-in screen
        </button>

        <div className="login-card__foot">
          <ThemeToggle />
        </div>
      </div>
      <p className="login-footnote">Join links are single-use — treat them as secrets.</p>
    </div>
  );
}
