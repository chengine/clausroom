import { useState, type FormEvent } from 'react';
import type { AddParticipantRequest, Participant } from '@clausroom/protocol';
import type { AddParticipantResult, RotateTokenResult } from '../api.js';
import { errorText } from '../api.js';
import {
  agentOnboardingText,
  bridgeToml,
  claudeMcpAddCommand,
  exportTokenLine,
  humanOnboardingText,
} from '../snippets.js';
import { CopyButton } from './CopyButton.js';
import { BotIcon, KeyIcon, PersonIcon, RefreshIcon, XIcon } from './icons.js';

interface OwnerDrawerProps {
  open: boolean;
  onClose: () => void;
  roomId: string;
  roomName: string;
  serverUrl: string;
  participants: Participant[];
  meId: string;
  nameOf: (userId: string) => string;
  onAddParticipant: (body: AddParticipantRequest) => Promise<AddParticipantResult>;
  onRotateToken: (userId: string) => Promise<RotateTokenResult>;
}

interface MintedToken {
  title: string;
  token: string;
  tokenKind: 'invite' | 'bridge';
  participantName: string;
  ownerHumanName: string;
}

export function OwnerDrawer({
  open,
  onClose,
  roomId,
  roomName,
  serverUrl,
  participants,
  meId,
  nameOf,
  onAddParticipant,
  onRotateToken,
}: OwnerDrawerProps) {
  const [displayName, setDisplayName] = useState('');
  const [kind, setKind] = useState<'human' | 'agent'>('agent');
  const [humanRole, setHumanRole] = useState<'human' | 'observer'>('human');
  const [ownerUserId, setOwnerUserId] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [rotateBusy, setRotateBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [minted, setMinted] = useState<MintedToken | null>(null);

  if (!open) return null;

  const humanParticipants = participants.filter((p) => p.user.kind === 'human');

  async function submit(event: FormEvent) {
    event.preventDefault();
    const name = displayName.trim();
    if (!name || busy) return;
    setBusy(true);
    setError(null);
    try {
      const body: AddParticipantRequest =
        kind === 'human'
          ? { display_name: name, kind: 'human', role: humanRole }
          : {
              display_name: name,
              kind: 'agent',
              role: 'agent',
              ...(ownerUserId ? { owner_user_id: ownerUserId } : {}),
            };
      const result = await onAddParticipant(body);
      const token = result.bridge_token ?? result.invite_token;
      if (token) {
        setMinted({
          title: `${name} added`,
          token,
          tokenKind: result.bridge_token ? 'bridge' : 'invite',
          participantName: name,
          ownerHumanName:
            kind === 'agent' ? nameOf(ownerUserId || meId) : name,
        });
      }
      setDisplayName('');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function rotate(p: Participant) {
    if (rotateBusy) return;
    if (
      !window.confirm(
        `Regenerate the token for ${p.user.display_name}? Their current tokens stop working immediately.`,
      )
    ) {
      return;
    }
    setRotateBusy(p.user_id);
    setError(null);
    try {
      const result = await onRotateToken(p.user_id);
      const token = result.bridge_token ?? result.invite_token;
      if (token) {
        setMinted({
          title: `New token for ${p.user.display_name}`,
          token,
          tokenKind: result.bridge_token ? 'bridge' : 'invite',
          participantName: p.user.display_name,
          ownerHumanName: p.user.owner_user_id ? nameOf(p.user.owner_user_id) : p.user.display_name,
        });
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setRotateBusy(null);
    }
  }

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <div
        className="drawer card"
        role="dialog"
        aria-label="Room setup"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="drawer__head">
          <h2 className="drawer__title">Room setup</h2>
          <button type="button" className="btn btn--ghost btn--icon" onClick={onClose} aria-label="Close">
            <XIcon size={16} />
          </button>
        </header>

        <section className="drawer__section">
          <h3 className="drawer__subtitle">Add participant</h3>
          <form className="drawer__form" onSubmit={submit}>
            <label className="field">
              <span className="field__label">Display name</span>
              <input
                className="input"
                type="text"
                value={displayName}
                maxLength={100}
                placeholder={kind === 'agent' ? "e.g. Teacher's Agent" : 'e.g. Teacher'}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </label>

            <div className="field">
              <span className="field__label">Kind</span>
              <div className="segmented">
                <button
                  type="button"
                  className={`segmented__btn${kind === 'human' ? ' segmented__btn--on' : ''}`}
                  onClick={() => setKind('human')}
                >
                  <PersonIcon size={13} /> Human
                </button>
                <button
                  type="button"
                  className={`segmented__btn${kind === 'agent' ? ' segmented__btn--on' : ''}`}
                  onClick={() => setKind('agent')}
                >
                  <BotIcon size={13} /> Agent
                </button>
              </div>
            </div>

            {kind === 'human' ? (
              <label className="field">
                <span className="field__label">Role</span>
                <select
                  className="input"
                  value={humanRole}
                  onChange={(e) => setHumanRole(e.target.value === 'observer' ? 'observer' : 'human')}
                >
                  <option value="human">human — can chat</option>
                  <option value="observer">observer — read-only</option>
                </select>
              </label>
            ) : (
              <label className="field">
                <span className="field__label">Steered by (approvals reviewer)</span>
                <select
                  className="input"
                  value={ownerUserId || meId}
                  onChange={(e) => setOwnerUserId(e.target.value)}
                >
                  {humanParticipants.map((p) => (
                    <option key={p.user_id} value={p.user_id}>
                      {p.user.display_name}
                      {p.user_id === meId ? ' (you)' : ''}
                    </option>
                  ))}
                </select>
              </label>
            )}

            <button className="btn btn--primary" type="submit" disabled={busy || !displayName.trim()}>
              {busy ? 'Adding…' : `Add ${kind}`}
            </button>
          </form>
        </section>

        <section className="drawer__section">
          <h3 className="drawer__subtitle">Tokens</h3>
          <p className="sidebar__hint">
            Raw tokens are shown exactly once. Regenerating revokes every previous token for that
            participant.
          </p>
          <ul className="rotate-list">
            {participants
              .filter((p) => p.user_id !== meId)
              .map((p) => (
                <li key={p.user_id} className="rotate-list__row">
                  <span className="rotate-list__who">
                    {p.user.kind === 'agent' ? <BotIcon size={13} /> : <PersonIcon size={13} />}
                    {p.user.display_name}
                  </span>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    disabled={rotateBusy !== null}
                    onClick={() => void rotate(p)}
                  >
                    <RefreshIcon size={13} />
                    {rotateBusy === p.user_id ? 'Rotating…' : 'Regenerate token'}
                  </button>
                </li>
              ))}
          </ul>
        </section>

        {error && <div className="form-error" role="alert">{error}</div>}
      </div>

      {minted && (
        <TokenModal
          minted={minted}
          roomId={roomId}
          roomName={roomName}
          serverUrl={serverUrl}
          onClose={() => setMinted(null)}
        />
      )}
    </div>
  );
}

function TokenModal({
  minted,
  roomId,
  roomName,
  serverUrl,
  onClose,
}: {
  minted: MintedToken;
  roomId: string;
  roomName: string;
  serverUrl: string;
  onClose: () => void;
}) {
  const agentInput = {
    serverUrl,
    roomId,
    agentName: minted.participantName,
    ownerHumanName: minted.ownerHumanName,
    bridgeToken: minted.token,
  };

  return (
    <div className="modal-overlay" onClick={(e) => e.stopPropagation()}>
      <div className="modal card" role="dialog" aria-label="One-time token">
        <header className="modal__head">
          <span className="modal__icon">
            <KeyIcon size={16} />
          </span>
          <h3 className="modal__title">{minted.title}</h3>
          <button type="button" className="btn btn--ghost btn--icon" onClick={onClose} aria-label="Close">
            <XIcon size={16} />
          </button>
        </header>

        <p className="modal__warning">
          This {minted.tokenKind === 'bridge' ? 'bridge' : 'invite'} token is shown <strong>once</strong>.
          Copy it now and share it over a private channel.
        </p>

        <div className="token-box">
          <code className="token-box__value">{minted.token}</code>
          <CopyButton text={minted.token} label="Copy token" />
        </div>

        {minted.tokenKind === 'invite' ? (
          <div className="snippet">
            <div className="snippet__head">
              <span className="snippet__title">Onboarding message for {minted.participantName}</span>
              <CopyButton
                text={humanOnboardingText({ serverUrl, roomName, inviteToken: minted.token })}
                label="Copy"
              />
            </div>
            <pre className="snippet__pre">
              {humanOnboardingText({ serverUrl, roomName, inviteToken: minted.token })}
            </pre>
          </div>
        ) : (
          <>
            <div className="snippet">
              <div className="snippet__head">
                <span className="snippet__title">~/.clausroom/bridge.toml</span>
                <CopyButton text={bridgeToml(agentInput)} label="Copy" />
              </div>
              <pre className="snippet__pre">{bridgeToml(agentInput)}</pre>
            </div>
            <div className="snippet">
              <div className="snippet__head">
                <span className="snippet__title">Bridge token env var</span>
                <CopyButton text={exportTokenLine(minted.token)} label="Copy" />
              </div>
              <pre className="snippet__pre">{exportTokenLine(minted.token)}</pre>
            </div>
            <div className="snippet">
              <div className="snippet__head">
                <span className="snippet__title">Connect Claude Code</span>
                <CopyButton text={claudeMcpAddCommand()} label="Copy" />
              </div>
              <pre className="snippet__pre">{claudeMcpAddCommand()}</pre>
            </div>
            <div className="modal__foot">
              <CopyButton text={agentOnboardingText(agentInput)} label="Copy full setup snippet" />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
