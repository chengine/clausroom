import { createContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { PEER, type PeerRoomInvite } from '@clausroom/protocol';
import * as api from '../api.js';
import { consumeSessionFragment, getSessionToken, setSessionToken } from '../storage.js';
import {
  readPeerBootstrap,
  guestPeer,
  hostPeer,
  type GuestPeer,
  type HostPeer,
} from '../peer.js';
import { Wordmark } from './Wordmark.js';
import { trace, traceText } from '../trace.js';

export const PeerRoom = createContext<string | null>(null);

function copy(value: string): void {
  void navigator.clipboard.writeText(value);
}

function controlUrl(secret: string): string {
  const url = new URL(`${PEER.PATH}/control`, location.origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('secret', secret);
  return url.toString();
}

export function PeerSetup({ children }: { children: ReactNode }) {
  const [bootstrap] = useState(readPeerBootstrap);
  // On the host this strips and stores the human token before the setup screen
  // spends any time gathering ICE or waiting for a pasted answer.
  useState(() => consumeSessionFragment());
  if (bootstrap === 'invalid') {
    return (
      <SetupCard
        title="This private URL is incomplete"
        status="Reopen the complete URL printed by the running Clausroom command."
      >
        <p className="login-footnote">Do not paste an arit_ or arbt_ key here.</p>
      </SetupCard>
    );
  }
  if (!bootstrap) return children;
  return bootstrap.role === 'host' ? (
    <HostSetup key={bootstrap.secret} bootstrap={bootstrap}>
      {children}
    </HostSetup>
  ) : (
    <GuestSetup key={bootstrap.secret} bootstrap={bootstrap}>
      {children}
    </GuestSetup>
  );
}

function HostSetup({
  bootstrap,
  children,
}: {
  bootstrap: Extract<ReturnType<typeof readPeerBootstrap>, { role: 'host' }>;
  children: ReactNode;
}) {
  const peer = useRef<HostPeer | null>(null);
  const [generation, setGeneration] = useState(0);
  const [offer, setOffer] = useState('');
  const [answer, setAnswer] = useState('');
  const [status, setStatus] = useState('Creating a private browser invite…');
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    peer.current?.close();
    peer.current = null;
    setOffer('');
    setAnswer('');
    setConnected(false);
    setBusy(false);
    setStatus('Creating a private browser invite…');
    const create = async () => {
      const token = getSessionToken();
      if (!token) throw new Error('The private host session is missing. Reopen the URL printed by `clausroom host`.');
      const rotated = await api.rotateToken(token, bootstrap.room.room, bootstrap.room.human_id);
      if (!rotated.invite_token) throw new Error('The server did not issue a fresh guest invite.');
      return hostPeer(
        { ...bootstrap, room: { ...bootstrap.room, invite: rotated.invite_token } },
        (message) => {
          if (!cancelled) {
            peer.current?.close();
            peer.current = null;
            setOffer('');
            setAnswer('');
            setBusy(false);
            setConnected(false);
            setStatus(message);
          }
        },
        (message) => {
          if (!cancelled) setStatus(message);
        },
      );
    };
    void create().then(
      (created) => {
        if (cancelled) return created.close();
        peer.current = created;
        setOffer(created.code);
        setStatus('Send this invite to your partner. There is no paste deadline.');
      },
      (error: unknown) => {
        if (!cancelled) setStatus(error instanceof Error ? error.message : 'Could not create the invite.');
      },
    );
    return () => {
      cancelled = true;
      peer.current?.close();
      peer.current = null;
    };
  }, [bootstrap, generation]);

  if (connected) return <PeerRoom.Provider value={bootstrap.room.room}>{children}</PeerRoom.Provider>;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const current = peer.current;
    if (!current || !answer.trim() || busy) return;
    setBusy(true);
    setStatus('Checking the direct path…');
    void current.accept(answer).then(
      (path) => {
        setBusy(false);
        console.info(`[clausroom-peer] direct ${path}`);
        setConnected(true);
      },
      (error: unknown) => {
        setBusy(false);
        setStatus(`${error instanceof Error ? error.message : 'That answer failed.'} The room is still running.`);
      },
    );
  };

  return (
    <SetupCard title="Host this clausroom" status={status}>
      {offer && (
        <CodeField label="1. Send this invite" value={offer} copyLabel="Copy invite" readOnly />
      )}
      <form className="peer-form" onSubmit={submit}>
        <CodeField
          label="2. Paste their answer"
          value={answer}
          onChange={setAnswer}
          placeholder="CLAUSROOM-ANSWER-2.…"
        />
        <div className="peer-actions">
          <button className="btn btn--primary" type="submit" disabled={busy || !offer || !answer.trim()}>
            Connect
          </button>
          <button className="btn btn--ghost" type="button" disabled={busy} onClick={() => setGeneration((n) => n + 1)}>
            New invite
          </button>
        </div>
      </form>
    </SetupCard>
  );
}

function GuestSetup({
  bootstrap,
  children,
}: {
  bootstrap: Extract<ReturnType<typeof readPeerBootstrap>, { role: 'guest' }>;
  children: ReactNode;
}) {
  const peer = useRef<GuestPeer | null>(null);
  const control = useRef<WebSocket | null>(null);
  const room = useRef<PeerRoomInvite | null>(null);
  const attempt = useRef(0);
  const [offer, setOffer] = useState('');
  const [answer, setAnswer] = useState('');
  const [status, setStatus] = useState('Connecting to the local Clausroom command…');
  const [connected, setConnected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const stopPeer = (message: string, clearOffer = false) => {
    attempt.current += 1;
    peer.current?.close();
    peer.current = null;
    room.current = null;
    setAnswer('');
    if (clearOffer) setOffer('');
    setBusy(false);
    setConnected(null);
    setStatus(message);
  };

  useEffect(() => {
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const open = () => {
      if (stopped) return;
      const ws = new WebSocket(controlUrl(bootstrap.secret));
      control.current = ws;
      ws.onopen = () => {
        setStatus(peer.current ? 'Waiting for the host to paste your answer…' : 'Paste the host invite below.');
        if (room.current) ws.send(JSON.stringify({ type: 'join', invite: room.current }));
      };
      ws.onmessage = (event) => {
        let value: { type?: unknown; id?: unknown; token?: unknown; invite?: unknown; message?: unknown };
        try {
          value = JSON.parse(String(event.data)) as typeof value;
        } catch {
          return;
        }
        if (value.type === 'tunnel' && typeof value.id === 'string') {
          trace('peer', `tunnel ${value.id.slice(0, 8)}: requested by connector`);
          peer.current?.openTunnel(value.id);
        }
        else if (
          value.type === 'session' &&
          peer.current &&
          typeof value.token === 'string' &&
          /^arst_[0-9a-f]{32}$/.test(value.token) &&
          value.invite === room.current?.invite
        ) {
          setSessionToken(value.token);
          if (peer.current.confirm() && room.current) setConnected(room.current.room);
        } else if (value.type === 'error' && typeof value.message === 'string') {
          peer.current?.confirm(value.message);
          setStatus(value.message);
        }
      };
      ws.onclose = (event) => {
        if (control.current === ws) control.current = null;
        if (!stopped) {
          if (event.code === 4009) {
            stopped = true;
            stopPeer('This connector was opened in another tab. Use that tab or reopen the private URL.');
            return;
          }
          setStatus('The local command disconnected; reconnecting…');
          retry = setTimeout(open, 1000);
        }
      };
      ws.onerror = () => ws.close();
    };
    open();
    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      control.current?.close();
      control.current = null;
    };
  }, [bootstrap.secret]);

  useEffect(
    () => () => {
      attempt.current += 1;
      peer.current?.close();
      peer.current = null;
    },
    [],
  );

  if (connected) return <PeerRoom.Provider value={connected}>{children}</PeerRoom.Provider>;
  const join = (event: FormEvent) => {
    event.preventDefault();
    if (!offer.trim() || busy) return;
    const currentAttempt = ++attempt.current;
    peer.current?.close();
    peer.current = null;
    room.current = null;
    setAnswer('');
    setBusy(true);
    setStatus('Creating your answer…');
    const makeAnswer = async (): Promise<void> => {
      const created = await guestPeer(
        offer,
        bootstrap,
        (invite) => {
          if (attempt.current !== currentAttempt) return;
          room.current = invite;
          if (control.current?.readyState === WebSocket.OPEN) {
            control.current.send(JSON.stringify({ type: 'join', invite }));
          }
        },
        (message) => {
          if (attempt.current === currentAttempt) stopPeer(message, true);
        },
        (message) => {
          if (attempt.current === currentAttempt) setStatus(message);
        },
      );
      if (attempt.current !== currentAttempt) return created.close();
      setBusy(false);
      peer.current = created;
      setAnswer(created.code);
      setStatus('Send the current answer to the host.');
      try {
        console.info(`[clausroom-peer] direct ${await created.connected}`);
      } catch {
        if (attempt.current !== currentAttempt || peer.current !== created) return;
        created.close();
        peer.current = null;
        trace('peer', 'guest: answer expired; refreshing');
        setStatus('That answer expired; creating a fresh one…');
        await makeAnswer();
      }
    };
    void makeAnswer().catch((error: unknown) => {
      if (attempt.current === currentAttempt) {
        stopPeer(error instanceof Error ? error.message : 'That invite was not accepted.');
      }
    });
  };

  return (
    <SetupCard title="Join this clausroom" status={status}>
      <form className="peer-form" onSubmit={join}>
        <CodeField
          label="1. Paste the host invite"
          value={offer}
          onChange={setOffer}
          placeholder="CLAUSROOM-OFFER-2.…"
        />
        <div className="peer-actions">
          <button className="btn btn--primary" type="submit" disabled={busy || !offer.trim()}>
            Make answer
          </button>
          {answer && (
            <button
              className="btn btn--ghost"
              type="button"
              onClick={() => {
                stopPeer('Paste the host invite below.');
              }}
            >
              Start over
            </button>
          )}
        </div>
      </form>
      {answer && (
        <CodeField
          label="2. Send the current answer"
          value={answer}
          copyLabel="Copy answer"
          readOnly
        />
      )}
    </SetupCard>
  );
}

function SetupCard({ title, status, children }: { title: string; status: string; children: ReactNode }) {
  return (
    <main className="peer-screen">
      <section className="card peer-card">
        <Wordmark size="lg" />
        <div>
          <h1 className="peer-title">{title}</h1>
          <p className="peer-status">{status}</p>
        </div>
        {children}
        <button className="btn btn--ghost" type="button" onClick={() => copy(traceText())}>
          Copy network diagnostics
        </button>
        <p className="login-footnote">The codes contain connection details. Exchange them privately.</p>
      </section>
    </main>
  );
}

function CodeField({
  label,
  value,
  onChange,
  placeholder,
  copyLabel,
  readOnly,
}: {
  label: string;
  value: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  copyLabel?: string;
  readOnly?: boolean;
}) {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      <textarea
        className="input input--mono peer-code"
        value={value}
        readOnly={readOnly}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(event) => onChange?.(event.target.value)}
      />
      {copyLabel && (
        <button className="btn btn--ghost btn--sm peer-copy" type="button" onClick={() => copy(value)}>
          {copyLabel}
        </button>
      )}
    </label>
  );
}
