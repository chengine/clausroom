import { useState } from 'react';
import type { MyAgentResponse } from '@clausroom/protocol';
import { errorText } from '../api.js';
import { claudeMcpAddJoin } from '../snippets.js';
import { CopyButton } from './CopyButton.js';
import { BotIcon, KeyIcon, RefreshIcon, XIcon } from './icons.js';

interface ConnectAgentPanelProps {
  /** True when the caller already owns an agent in this room (rotate vs. create). */
  hasAgent: boolean;
  /** Mint/rotate the caller's own agent bridge token (POST /api/rooms/:id/my-agent). */
  onProvision: (agentName?: string) => Promise<MyAgentResponse>;
}

/**
 * "Connect your agent" — self-service agent provisioning for the logged-in human
 * (docs/API-CONTRACT.md §3 POST /api/rooms/:id/my-agent). One button mints (or
 * rotates) the caller's OWN bridge token and pops a one-time modal with the
 * ready-to-run `clausroom-bridge join` command, so a guest attaches their agent
 * without anyone relaying a token by hand.
 */
export function ConnectAgentPanel({ hasAgent, onProvision }: ConnectAgentPanelProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<{ result: MyAgentResponse; reconnected: boolean } | null>(null);

  async function connect() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await onProvision();
      setModal({ result, reconnected: hasAgent });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="sidebar__section card">
      <h2 className="sidebar__title">Your agent</h2>
      <p className="sidebar__hint">
        {hasAgent
          ? 'Reconnect your agent or rotate its bridge token. The previous token stops working immediately.'
          : "Connect your own coding agent to this room. You'll get one command to run on your machine."}
      </p>
      <button
        type="button"
        className="btn btn--primary connect-agent__btn"
        disabled={busy}
        onClick={() => void connect()}
      >
        {hasAgent ? <RefreshIcon size={14} /> : <BotIcon size={14} />}
        {busy
          ? hasAgent
            ? 'Reconnecting…'
            : 'Connecting…'
          : hasAgent
            ? 'Reconnect my agent'
            : 'Add my agent'}
      </button>
      {error && (
        <div className="form-error form-error--sm" role="alert">
          {error}
        </div>
      )}

      {modal && (
        <ConnectAgentModal
          result={modal.result}
          reconnected={modal.reconnected}
          onClose={() => setModal(null)}
        />
      )}
    </section>
  );
}

function ConnectAgentModal({
  result,
  reconnected,
  onClose,
}: {
  result: MyAgentResponse;
  reconnected: boolean;
  onClose: () => void;
}) {
  const agentName = result.participant.user.display_name;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal card"
        role="dialog"
        aria-label="Connect your agent"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal__head">
          <span className="modal__icon">
            <BotIcon size={16} />
          </span>
          <h3 className="modal__title">{reconnected ? `${agentName} reconnected` : `${agentName} is ready`}</h3>
          <button type="button" className="btn btn--ghost btn--icon" onClick={onClose} aria-label="Close">
            <XIcon size={16} />
          </button>
        </header>

        <p className="modal__warning">
          <KeyIcon size={13} /> This bridge token and command are shown <strong>once</strong>. Copy
          what you need before closing.
        </p>

        <div className="snippet">
          <div className="snippet__head">
            <span className="snippet__title">Run this one command</span>
            <CopyButton text={result.join_command} label="Copy command" />
          </div>
          <pre className="snippet__pre">{result.join_command}</pre>
        </div>
        <p className="field__hint">
          Paste it into a terminal on the machine where your coding agent runs. It writes{' '}
          <code>~/.clausroom/bridge.toml</code> with safe local defaults and asks which project
          directory to expose — your local setup is never chosen by the server.
        </p>

        <div className="token-box">
          <code className="token-box__value">{result.bridge_token}</code>
          <CopyButton text={result.bridge_token} label="Copy token" />
        </div>
        <p className="field__hint">
          The raw bridge token, in case you wire the bridge up by hand instead.
        </p>

        <div className="snippet">
          <div className="snippet__head">
            <span className="snippet__title">Then connect Claude Code</span>
            <CopyButton text={claudeMcpAddJoin()} label="Copy" />
          </div>
          <pre className="snippet__pre">{claudeMcpAddJoin()}</pre>
        </div>
        <p className="field__hint">
          Equivalent to the <code>claude mcp add</code> line the join command prints for you.
        </p>
      </div>
    </div>
  );
}
