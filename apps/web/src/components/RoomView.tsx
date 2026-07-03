import { useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULTS, type Approval, type Message, type User } from '@clausroom/protocol';
import { errorText } from '../api.js';
import { buildColorMap, colorFor } from '../colors.js';
import { effectiveOrigin } from '../storage.js';
import { CONTINUE_MESSAGE_BODY, agentTurnRun, useRoomState } from '../useRoomState.js';
import type { ConnectionState } from '../ws.js';
import { ApprovalCard } from './ApprovalCard.js';
import { Composer } from './Composer.js';
import { MessageCard } from './MessageCard.js';
import { OwnerDrawer } from './OwnerDrawer.js';
import { Sidebar } from './Sidebar.js';
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  DownloadIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
} from './icons.js';

interface RoomViewProps {
  token: string;
  roomId: string;
  me: User;
  onBack: () => void;
  onUnauthorized: (err?: unknown) => void;
}

type TimelineItem =
  | { kind: 'message'; id: string; created_at: string; message: Message }
  | { kind: 'approval'; id: string; created_at: string; approval: Approval };

const CONN_LABEL: Record<ConnectionState, string> = {
  connecting: 'connecting',
  online: 'live',
  reconnecting: 'reconnecting',
  denied: 'access denied',
  stopped: 'offline',
};

export function RoomView({ token, roomId, me, onBack, onUnauthorized }: RoomViewProps) {
  const { state, actions } = useRoomState(token, roomId, onUnauthorized);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [pauseBusy, setPauseBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  // Failures of header/sidebar/timeline actions (pause toggles, export,
  // artifact downloads) surface here instead of being silently swallowed.
  const [actionError, setActionError] = useState<string | null>(null);

  const colorMap = useMemo(() => buildColorMap(state.participants), [state.participants]);
  const colorOf = (userId: string) => colorFor(colorMap, userId);

  const namesById = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of state.participants) map.set(p.user_id, p.user.display_name);
    for (const m of state.messages) {
      if (!map.has(m.sender.id)) map.set(m.sender.id, m.sender.display_name);
    }
    return map;
  }, [state.participants, state.messages]);
  const nameOf = (userId: string) => namesById.get(userId) ?? 'someone';

  const messagesById = useMemo(
    () => new Map(state.messages.map((m) => [m.id, m] as const)),
    [state.messages],
  );

  const items = useMemo<TimelineItem[]>(() => {
    const merged: TimelineItem[] = [
      ...state.messages.map<TimelineItem>((m) => ({
        kind: 'message',
        id: m.id,
        created_at: m.created_at,
        message: m,
      })),
      ...state.approvals.map<TimelineItem>((a) => ({
        kind: 'approval',
        id: a.id,
        created_at: a.created_at,
        approval: a,
      })),
    ];
    merged.sort((a, b) => {
      if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    return merged;
  }, [state.messages, state.approvals]);

  const turnRun = useMemo(() => agentTurnRun(state.messages), [state.messages]);
  const myParticipant = state.participants.find((p) => p.user_id === me.id);
  const canSend = myParticipant?.can_send ?? false;
  const iAmOwner = state.myRole === 'owner';
  const iAmHuman = me.kind === 'human' && state.myRole !== 'observer';
  const serverUrl = state.publicBaseUrl ?? effectiveOrigin();

  const workingSet = useMemo(() => new Set(state.workingUserIds), [state.workingUserIds]);

  // Decision cards: card message id -> the choice a human answered with.
  // A card counts as answered once any human message at/after it in the room
  // order (button click or typed) has a body exactly equal to one of its
  // choices (docs/API-CONTRACT.md §4); the earliest such message wins.
  const answeredChoices = useMemo(() => {
    const map = new Map<string, string>();
    const openCards: Message[] = [];
    for (const m of state.messages) {
      if (m.sender.kind === 'human') {
        for (const card of openCards) {
          if (!map.has(card.id) && card.choices?.includes(m.body_markdown)) {
            map.set(card.id, m.body_markdown);
          }
        }
      }
      if (m.choices && m.choices.length > 0) openCards.push(m);
    }
    return map;
  }, [state.messages]);

  async function chooseOption(message: Message, choice: string) {
    try {
      await actions.sendMessage(choice, [], message.id);
    } catch (err) {
      setActionError(`Could not send your choice: ${errorText(err)}`);
    }
  }

  // --- auto-scroll pinned to bottom, with a "new messages" pill when away ---
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);
  const prevCountRef = useRef(0);
  const [pinned, setPinned] = useState(true);
  const [unseen, setUnseen] = useState(0);
  const reducedMotion = useMemo(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    [],
  );

  function scrollToBottom(smooth: boolean) {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth && !reducedMotion ? 'smooth' : 'auto' });
  }

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
    pinnedRef.current = nearBottom;
    setPinned(nearBottom);
    if (nearBottom) setUnseen(0);
  }

  useEffect(() => {
    const prev = prevCountRef.current;
    const delta = items.length - prev;
    prevCountRef.current = items.length;
    if (delta <= 0) return;
    if (prev === 0 || pinnedRef.current) {
      scrollToBottom(prev !== 0);
    } else {
      setUnseen((u) => u + delta);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length]);

  async function toggleAllAgents() {
    if (pauseBusy || !state.room) return;
    const pausing = !state.room.agents_paused;
    setPauseBusy(true);
    setActionError(null);
    try {
      await actions.setAllAgentsPaused(pausing);
    } catch (err) {
      setActionError(
        `Could not ${pausing ? 'pause' : 'resume'} agents: ${errorText(err)}`,
      );
    } finally {
      setPauseBusy(false);
    }
  }

  async function exportTranscript() {
    if (exporting) return;
    setExporting(true);
    setActionError(null);
    try {
      await actions.exportTranscript();
    } catch (err) {
      setActionError(`Transcript export failed: ${errorText(err)}`);
    } finally {
      setExporting(false);
    }
  }

  if (state.loadError) {
    return (
      <div className="room-error">
        <div className="card room-error__card">
          <p className="room-error__text">{state.loadError}</p>
          <button type="button" className="btn btn--primary" onClick={onBack}>
            <ArrowLeftIcon size={15} /> Back to rooms
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="room-screen">
      <header className="room-header card">
        <button type="button" className="btn btn--ghost btn--icon" onClick={onBack} aria-label="Back to rooms">
          <ArrowLeftIcon size={17} />
        </button>
        <div className="room-header__title">
          <h1 className="room-header__name">{state.room?.name ?? 'Loading…'}</h1>
          <span className={`conn-pill conn-pill--${state.conn}`}>
            <span className="conn-pill__dot" />
            {CONN_LABEL[state.conn]}
          </span>
        </div>
        <div className="room-header__actions">
          {state.room && (
            <button
              type="button"
              className={`btn btn--sm ${state.room.agents_paused ? 'btn--resume' : 'btn--ghost'}`}
              disabled={pauseBusy}
              onClick={() => void toggleAllAgents()}
              title={state.room.agents_paused ? 'Resume all agents' : 'Pause all agents'}
            >
              {state.room.agents_paused ? <PlayIcon size={14} /> : <PauseIcon size={14} />}
              {state.room.agents_paused ? 'Resume agents' : 'Pause agents'}
            </button>
          )}
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            disabled={exporting}
            onClick={() => void exportTranscript()}
          >
            <DownloadIcon size={14} />
            {exporting ? 'Exporting…' : 'Export transcript'}
          </button>
          {iAmOwner && (
            <button type="button" className="btn btn--primary btn--sm" onClick={() => setDrawerOpen(true)}>
              <PlusIcon size={14} /> Add participant
            </button>
          )}
        </div>
      </header>

      {actionError && (
        <div className="action-error-banner" role="alert">
          <span>{actionError}</span>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => setActionError(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      {state.room?.agents_paused && (
        <div className="paused-banner" role="status">
          <PauseIcon size={14} />
          <span>
            All agents are paused — they cannot send messages until a human resumes them.
          </span>
          <button
            type="button"
            className="btn btn--resume btn--sm"
            disabled={pauseBusy}
            onClick={() => void toggleAllAgents()}
          >
            <PlayIcon size={13} /> Resume
          </button>
        </div>
      )}

      <div className="room-body">
        <main className="timeline-wrap">
          <div className="timeline" ref={scrollRef} onScroll={handleScroll}>
            {state.loading && (
              <div className="empty-state">
                <div className="spinner" />
                <p>Joining the room…</p>
              </div>
            )}
            {!state.loading && items.length === 0 && (
              <div className="empty-state">
                <p className="empty-state__title">The room is quiet</p>
                <p>Say something below, or address one of the agents to kick things off.</p>
              </div>
            )}
            {items.map((item) =>
              item.kind === 'message' ? (
                <MessageCard
                  key={`m-${item.id}`}
                  message={item.message}
                  color={colorOf(item.message.sender.id)}
                  nameOf={nameOf}
                  messageById={(id) => messagesById.get(id)}
                  artifactById={(id) => state.artifacts[id]}
                  answeredChoice={answeredChoices.get(item.message.id) ?? null}
                  canChoose={iAmHuman && canSend}
                  onChoose={(choice) => chooseOption(item.message, choice)}
                  senderWorking={
                    item.message.sender.kind === 'agent' && workingSet.has(item.message.sender.id)
                  }
                  onDownloadArtifact={(artifact) =>
                    void actions
                      .downloadArtifact(artifact)
                      .catch((err: unknown) =>
                        setActionError(`Download of ${artifact.filename} failed: ${errorText(err)}`),
                      )
                  }
                />
              ) : (
                <div className="timeline__approval" key={`a-${item.id}`}>
                  <ApprovalCard
                    approval={item.approval}
                    meId={me.id}
                    nameOf={nameOf}
                    onRespond={actions.respondApproval}
                  />
                </div>
              ),
            )}
          </div>

          {!pinned && unseen > 0 && (
            <button
              type="button"
              className="new-messages-pill"
              onClick={() => {
                scrollToBottom(true);
                setUnseen(0);
              }}
            >
              <ArrowDownIcon size={13} />
              {unseen} new {unseen === 1 ? 'message' : 'messages'}
            </button>
          )}

          <Composer
            participants={state.participants}
            meId={me.id}
            colorOf={colorOf}
            canSend={canSend}
            onSend={actions.sendMessage}
          />
        </main>

        <Sidebar
          room={state.room}
          participants={state.participants}
          onlineUserIds={state.onlineUserIds}
          workingUserIds={workingSet}
          meId={me.id}
          iAmHuman={iAmHuman}
          canSend={canSend}
          colorOf={colorOf}
          nameOf={nameOf}
          turnRun={turnRun}
          maxTurns={state.maxAutoTurns ?? DEFAULTS.MAX_AUTO_TURNS}
          approvals={state.approvals}
          onUpdateSummary={actions.updateSummary}
          onContinue={() => actions.sendMessage(CONTINUE_MESSAGE_BODY, [])}
          onSetParticipantPaused={actions.setParticipantPaused}
          onRespondApproval={actions.respondApproval}
          onActionError={setActionError}
        />
      </div>

      <OwnerDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        roomId={roomId}
        roomName={state.room?.name ?? roomId}
        serverUrl={serverUrl}
        participants={state.participants}
        meId={me.id}
        nameOf={nameOf}
        onAddParticipant={actions.addParticipant}
        onRotateToken={actions.rotateToken}
      />
    </div>
  );
}
