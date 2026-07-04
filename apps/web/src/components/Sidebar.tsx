import { useState, type CSSProperties, type ReactNode } from 'react';
import type { Approval, Participant, Room } from '@clausroom/protocol';
import { errorText } from '../api.js';
import { initials } from '../format.js';
import { ApprovalCard, effectiveStatus } from './ApprovalCard.js';
import { RoomSummary } from './RoomSummary.js';
import { BotIcon, PauseIcon, PersonIcon, PlayIcon } from './icons.js';

interface SidebarProps {
  room: Room | null;
  participants: Participant[];
  onlineUserIds: string[];
  /** Users currently reporting 'working' activity (agents, in practice). */
  workingUserIds: ReadonlySet<string>;
  meId: string;
  iAmHuman: boolean;
  /** Viewer is a human participant with can_send (summary edit / continue). */
  canSend: boolean;
  colorOf: (userId: string) => string;
  nameOf: (userId: string) => string;
  turnRun: number;
  maxTurns: number;
  approvals: Approval[];
  onUpdateSummary: (summaryMarkdown: string | null) => Promise<void>;
  /** Posts the canonical Continue message, resetting the agent turn run. */
  onContinue: () => Promise<void>;
  onSetParticipantPaused: (userId: string, paused: boolean) => Promise<void>;
  onRespondApproval: (approvalId: string, decision: 'approved' | 'denied') => Promise<void>;
  /** Surface an action failure to the human (never swallow pause errors). */
  onActionError: (message: string) => void;
  /** "Connect your agent" panel, rendered for human participants (null otherwise). */
  agentPanel?: ReactNode;
}

export function Sidebar({
  room,
  participants,
  onlineUserIds,
  workingUserIds,
  meId,
  iAmHuman,
  canSend,
  colorOf,
  nameOf,
  turnRun,
  maxTurns,
  approvals,
  onUpdateSummary,
  onContinue,
  onSetParticipantPaused,
  onRespondApproval,
  onActionError,
  agentPanel,
}: SidebarProps) {
  const [pauseBusy, setPauseBusy] = useState<string | null>(null);
  const [continueBusy, setContinueBusy] = useState(false);
  const online = new Set(onlineUserIds);

  const ordered = [...participants].sort((a, b) => {
    const rank = (p: Participant) =>
      p.role === 'owner' ? 0 : p.user.kind === 'human' ? 1 : p.user.kind === 'agent' ? 2 : 3;
    return (
      rank(a) - rank(b) ||
      a.user.created_at.localeCompare(b.user.created_at) ||
      a.user_id.localeCompare(b.user_id)
    );
  });

  const pending = approvals.filter((a) => effectiveStatus(a) === 'pending');

  async function togglePause(p: Participant) {
    if (pauseBusy) return;
    setPauseBusy(p.user_id);
    try {
      await onSetParticipantPaused(p.user_id, !p.paused);
    } catch (err) {
      onActionError(
        `Could not ${p.paused ? 'resume' : 'pause'} ${p.user.display_name}: ${errorText(err)}`,
      );
    } finally {
      setPauseBusy(null);
    }
  }

  async function grantContinue() {
    if (continueBusy) return;
    setContinueBusy(true);
    try {
      await onContinue();
    } catch (err) {
      onActionError(`Could not grant more agent turns: ${errorText(err)}`);
    } finally {
      setContinueBusy(false);
    }
  }

  return (
    <aside className="sidebar">
      {room && (
        <RoomSummary
          room={room}
          canEdit={iAmHuman && canSend}
          nameOf={nameOf}
          onSave={onUpdateSummary}
        />
      )}

      {agentPanel}

      <section className="sidebar__section card">
        <h2 className="sidebar__title">Participants</h2>
        <ul className="participant-list">
          {ordered.map((p) => {
            const working = p.user.kind === 'agent' && workingUserIds.has(p.user_id);
            return (
            <li
              key={p.user_id}
              className="participant"
              style={{ '--pc': colorOf(p.user_id) } as CSSProperties}
            >
              <span className="participant__avatar">
                {initials(p.user.display_name)}
                <span
                  className={`presence-dot${online.has(p.user_id) ? ' presence-dot--on' : ''}${
                    working ? ' presence-dot--working' : ''
                  }`}
                  title={working ? 'working…' : online.has(p.user_id) ? 'online' : 'offline'}
                />
              </span>
              <span className="participant__info">
                <span className="participant__name">
                  {p.user.display_name}
                  {p.user_id === meId && <span className="participant__you">you</span>}
                </span>
                <span className="participant__meta">
                  {p.user.kind === 'agent' ? <BotIcon size={11} /> : <PersonIcon size={11} />}
                  <span>{p.role}</span>
                  {p.user.kind === 'agent' && p.user.owner_user_id && (
                    <span className="participant__owner">· steered by {nameOf(p.user.owner_user_id)}</span>
                  )}
                  {working && (
                    <span className="working-pill">
                      <span className="working-pill__dot" />
                      working…
                    </span>
                  )}
                </span>
              </span>
              {p.user.kind === 'agent' &&
                (iAmHuman ? (
                  <button
                    type="button"
                    className={`pause-toggle${p.paused ? ' pause-toggle--paused' : ''}`}
                    disabled={pauseBusy === p.user_id}
                    onClick={() => void togglePause(p)}
                    title={p.paused ? 'Resume this agent' : 'Pause this agent'}
                  >
                    {p.paused ? <PlayIcon size={13} /> : <PauseIcon size={13} />}
                    <span>{p.paused ? 'Paused' : 'Live'}</span>
                  </button>
                ) : (
                  p.paused && <span className="pill pill--warn">paused</span>
                ))}
            </li>
            );
          })}
        </ul>
      </section>

      <section className="sidebar__section card">
        <h2 className="sidebar__title">Agent turn budget</h2>
        <div
          className="turn-budget"
          role="meter"
          aria-valuemin={0}
          aria-valuemax={maxTurns}
          aria-valuenow={Math.min(turnRun, maxTurns)}
          aria-label="Consecutive agent messages"
        >
          <div className="turn-budget__track">
            {Array.from({ length: maxTurns }, (_, i) => (
              <span
                key={i}
                className={`turn-budget__seg${i < turnRun ? ' turn-budget__seg--used' : ''}${
                  turnRun >= maxTurns ? ' turn-budget__seg--maxed' : ''
                }`}
              />
            ))}
          </div>
          <span className="turn-budget__label">
            {Math.min(turnRun, maxTurns)} / {maxTurns}
          </span>
        </div>
        <p className="sidebar__hint">
          {turnRun >= maxTurns
            ? 'Limit reached — agents must wait for a human message.'
            : 'Consecutive agent messages since the last human message.'}
        </p>
        {turnRun >= maxTurns && iAmHuman && canSend && (
          <button
            type="button"
            className="btn continue-btn"
            disabled={continueBusy}
            onClick={() => void grantContinue()}
          >
            <PlayIcon size={14} />
            {continueBusy ? 'Granting…' : 'Continue — grant more agent turns'}
          </button>
        )}
      </section>

      <section className="sidebar__section card">
        <h2 className="sidebar__title">
          Pending approvals
          {pending.length > 0 && <span className="count-badge">{pending.length}</span>}
        </h2>
        {pending.length === 0 ? (
          <p className="sidebar__hint">Nothing waiting on a human right now.</p>
        ) : (
          <div className="sidebar__approvals">
            {pending.map((a) => (
              <ApprovalCard
                key={a.id}
                approval={a}
                meId={meId}
                nameOf={nameOf}
                onRespond={onRespondApproval}
                compact
              />
            ))}
          </div>
        )}
      </section>
    </aside>
  );
}
