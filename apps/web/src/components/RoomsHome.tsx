import { useEffect, useState, type FormEvent } from 'react';
import type { Room, User } from '@clausroom/protocol';
import * as api from '../api.js';
import { fmtDate } from '../format.js';
import { ArrowLeftIcon, PlusIcon } from './icons.js';
import { ThemeToggle } from './ThemeToggle.js';
import { Wordmark } from './Wordmark.js';

interface RoomsHomeProps {
  token: string;
  me: User;
  onEnterRoom: (room: Room) => void;
  onLogout: () => void;
  onUnauthorized: (err?: unknown) => void;
}

export function RoomsHome({ token, me, onEnterRoom, onLogout, onUnauthorized }: RoomsHomeProps) {
  const [rooms, setRooms] = useState<api.RoomMembership[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .me(token)
      .then((result) => {
        if (!cancelled) setRooms(result.rooms);
      })
      .catch((err) => {
        if (cancelled) return;
        if (api.isUnauthorized(err)) onUnauthorized(err);
        else setError(api.errorText(err));
      });
    return () => {
      cancelled = true;
    };
  }, [token, onUnauthorized]);

  async function createRoom(event: FormEvent) {
    event.preventDefault();
    const name = newName.trim();
    if (!name || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const room = await api.createRoom(token, name);
      setNewName('');
      onEnterRoom(room);
    } catch (err) {
      if (api.isUnauthorized(err)) onUnauthorized(err);
      else setCreateError(api.errorText(err));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="home-screen">
      <header className="topbar">
        <Wordmark />
        <div className="topbar__right">
          <ThemeToggle />
          <span className="user-chip" title={me.id}>
            <span className="user-chip__dot" />
            {me.display_name}
            {me.is_admin && <span className="user-chip__badge">admin</span>}
          </span>
          <button type="button" className="btn btn--ghost btn--sm" onClick={onLogout}>
            <ArrowLeftIcon size={14} /> Sign out
          </button>
        </div>
      </header>

      <main className="home-main">
        <div className="home-head">
          <h1 className="home-title">Your rooms</h1>
          <p className="home-sub">Pick a room to watch the conversation live, or start a new one.</p>
        </div>

        {error && <div className="form-error" role="alert">{error}</div>}

        {rooms === null && !error && (
          <div className="empty-state">
            <div className="spinner" />
            <p>Loading rooms…</p>
          </div>
        )}

        {rooms !== null && rooms.length === 0 && (
          <div className="empty-state card">
            <p className="empty-state__title">No rooms yet</p>
            <p>Create your first room below, then invite your collaborator and both agents.</p>
          </div>
        )}

        {rooms !== null && rooms.length > 0 && (
          <ul className="room-list">
            {rooms.map(({ room, my_role }) => (
              <li key={room.id}>
                <button type="button" className="room-tile card" onClick={() => onEnterRoom(room)}>
                  <span className="room-tile__name">{room.name}</span>
                  <span className="room-tile__meta">
                    <span className={`role-badge role-badge--${my_role}`}>{my_role}</span>
                    {room.agents_paused && <span className="pill pill--warn">agents paused</span>}
                    <span className="room-tile__date">since {fmtDate(room.created_at)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <form className="create-room card" onSubmit={createRoom}>
          <span className="create-room__label">New room</span>
          <div className="create-room__row">
            <input
              className="input"
              type="text"
              placeholder="e.g. Project Debug Room"
              value={newName}
              maxLength={200}
              onChange={(e) => setNewName(e.target.value)}
            />
            <button
              className="btn btn--primary"
              type="submit"
              disabled={creating || newName.trim().length === 0}
            >
              <PlusIcon size={15} /> {creating ? 'Creating…' : 'Create'}
            </button>
          </div>
          {createError && <div className="form-error" role="alert">{createError}</div>}
        </form>
      </main>
    </div>
  );
}
