import { useCallback, useEffect, useState } from 'react';
import type { Room, User } from '@clausroom/protocol';
import * as api from './api.js';
import { JoinView } from './components/JoinView.js';
import { Login } from './components/Login.js';
import { RoomsHome } from './components/RoomsHome.js';
import { RoomView } from './components/RoomView.js';
import { Wordmark } from './components/Wordmark.js';
import { getSessionToken, setSessionToken } from './storage.js';

type View = { name: 'login' } | { name: 'join' } | { name: 'rooms' } | { name: 'room'; roomId: string };

/**
 * Is this initial load a join request? The dedicated /join path, or any load
 * whose fragment carries a credential (`#i=` invite / `#s=` session), routes
 * through JoinView (docs/API-CONTRACT.md §1 "Web join links").
 */
function isJoinRequest(): boolean {
  if (window.location.pathname === '/join') return true;
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  return params.has('i') || params.has('s');
}

/** Drop /join (and any leftover fragment) from the address bar after routing. */
function clearJoinUrl(): void {
  if (window.location.pathname === '/join' || window.location.hash) {
    try {
      window.history.replaceState(null, '', '/');
    } catch {
      // history unavailable: harmless, the URL just stays as-is.
    }
  }
}

const startsAtJoin = isJoinRequest();

export function App() {
  const [token, setToken] = useState<string | null>(() => getSessionToken());
  const [me, setMe] = useState<User | null>(null);
  const [view, setView] = useState<View>(() =>
    startsAtJoin ? { name: 'join' } : getSessionToken() ? { name: 'rooms' } : { name: 'login' },
  );
  const [bootError, setBootError] = useState<string | null>(null);
  const [bootAttempt, setBootAttempt] = useState(0);
  // Shown on the login screen after an involuntary sign-out (session expiry).
  const [loginNotice, setLoginNotice] = useState<string | null>(null);

  const logout = useCallback(() => {
    setSessionToken(null);
    setToken(null);
    setMe(null);
    setBootError(null);
    setLoginNotice(null);
    setView({ name: 'login' });
  }, []);

  // Every 401 from any view lands here; an expired session (the sliding TTL)
  // clears the stored token and explains itself on the login screen.
  const handleUnauthorized = useCallback((err?: unknown) => {
    setSessionToken(null);
    setToken(null);
    setMe(null);
    setBootError(null);
    setLoginNotice(
      api.isSessionExpired(err) ? 'Your session expired — paste a fresh token.' : null,
    );
    setView({ name: 'login' });
  }, []);

  // Validate a persisted session token on boot / after retry. Skipped while the
  // join flow owns the screen — JoinView does its own auth, and letting this fire
  // on a stale stored token would 401 and yank us to the login screen mid-join.
  useEffect(() => {
    if (!token || me || view.name === 'join') return;
    let cancelled = false;
    api
      .me(token)
      .then((result) => {
        if (!cancelled) {
          setMe(result.user);
          setBootError(null);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        if (api.isUnauthorized(err)) handleUnauthorized(err);
        else setBootError(api.errorText(err));
      });
    return () => {
      cancelled = true;
    };
  }, [token, me, bootAttempt, handleUnauthorized, view.name]);

  if (view.name === 'join') {
    return (
      <JoinView
        onJoined={(sessionToken: string, user: User, landingRoomId: string | null) => {
          setToken(sessionToken);
          setMe(user);
          setBootError(null);
          setLoginNotice(null);
          clearJoinUrl();
          setView(landingRoomId ? { name: 'room', roomId: landingRoomId } : { name: 'rooms' });
        }}
        onFallback={() => {
          clearJoinUrl();
          setView({ name: 'login' });
        }}
      />
    );
  }

  if (!token || view.name === 'login') {
    return (
      <Login
        notice={loginNotice}
        onLoggedIn={(sessionToken: string, user: User) => {
          setToken(sessionToken);
          setMe(user);
          setBootError(null);
          setLoginNotice(null);
          setView({ name: 'rooms' });
        }}
      />
    );
  }

  if (!me) {
    return (
      <div className="boot-screen">
        <Wordmark size="lg" />
        {bootError ? (
          <div className="card boot-screen__card">
            <p className="form-error">{bootError}</p>
            <div className="boot-screen__actions">
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => {
                  setBootError(null);
                  setBootAttempt((n) => n + 1);
                }}
              >
                Retry
              </button>
              <button type="button" className="btn btn--ghost" onClick={logout}>
                Sign out
              </button>
            </div>
          </div>
        ) : (
          <div className="spinner" />
        )}
      </div>
    );
  }

  if (view.name === 'room') {
    return (
      <RoomView
        key={view.roomId}
        token={token}
        roomId={view.roomId}
        me={me}
        onBack={() => setView({ name: 'rooms' })}
        onUnauthorized={handleUnauthorized}
      />
    );
  }

  return (
    <RoomsHome
      token={token}
      me={me}
      onEnterRoom={(room: Room) => setView({ name: 'room', roomId: room.id })}
      onLogout={logout}
      onUnauthorized={handleUnauthorized}
    />
  );
}
