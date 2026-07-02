import { useCallback, useEffect, useState } from 'react';
import type { Room, User } from '@clausroom/protocol';
import * as api from './api.js';
import { Login } from './components/Login.js';
import { RoomsHome } from './components/RoomsHome.js';
import { RoomView } from './components/RoomView.js';
import { Wordmark } from './components/Wordmark.js';
import { getSessionToken, setSessionToken } from './storage.js';

type View = { name: 'login' } | { name: 'rooms' } | { name: 'room'; roomId: string };

export function App() {
  const [token, setToken] = useState<string | null>(() => getSessionToken());
  const [me, setMe] = useState<User | null>(null);
  const [view, setView] = useState<View>(() => (getSessionToken() ? { name: 'rooms' } : { name: 'login' }));
  const [bootError, setBootError] = useState<string | null>(null);
  const [bootAttempt, setBootAttempt] = useState(0);

  const logout = useCallback(() => {
    setSessionToken(null);
    setToken(null);
    setMe(null);
    setBootError(null);
    setView({ name: 'login' });
  }, []);

  // Validate a persisted session token on boot / after retry.
  useEffect(() => {
    if (!token || me) return;
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
        if (api.isUnauthorized(err)) logout();
        else setBootError(api.errorText(err));
      });
    return () => {
      cancelled = true;
    };
  }, [token, me, bootAttempt, logout]);

  if (!token || view.name === 'login') {
    return (
      <Login
        onLoggedIn={(sessionToken: string, user: User) => {
          setToken(sessionToken);
          setMe(user);
          setBootError(null);
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
        onUnauthorized={logout}
      />
    );
  }

  return (
    <RoomsHome
      token={token}
      me={me}
      onEnterRoom={(room: Room) => setView({ name: 'room', roomId: room.id })}
      onLogout={logout}
      onUnauthorized={logout}
    />
  );
}
