/**
 * Real-time room state: initial REST load, live WS frames, and gap-free
 * catch-up after every (re)connect using GET messages?after=<last seen id>.
 * All incoming data is validated by the api/ws layers before landing here.
 */
import { useCallback, useEffect, useReducer, useRef } from 'react';
import type {
  ActivityState,
  AddParticipantRequest,
  Approval,
  Artifact,
  Message,
  MyAgentResponse,
  Participant,
  Role,
  Room,
  RoomSettingsPatchRequest,
  WsServerFrame,
} from '@clausroom/protocol';
import * as api from './api.js';
import { RoomSocket, type ConnectionState } from './ws.js';

/**
 * Body of the human message posted by the Continue button and the /continue
 * composer command (docs/API-CONTRACT.md §4 "Turn-continue"): any human
 * message breaks the consecutive-agent run, this is just the canonical one.
 */
export const CONTINUE_MESSAGE_BODY = 'Continue — granted more agent turns.';

export interface RoomState {
  loading: boolean;
  loadError: string | null;
  room: Room | null;
  myRole: Role | null;
  publicBaseUrl: string | null;
  /** Effective server turn limit (AGENT_ROOM_MAX_AUTO_TURNS); null until loaded. */
  maxAutoTurns: number | null;
  participants: Participant[];
  onlineUserIds: string[];
  /** Users (agents, in practice) currently reporting 'working' activity. */
  workingUserIds: string[];
  messages: Message[];
  approvals: Approval[];
  artifacts: Record<string, Artifact>;
  conn: ConnectionState;
}

const initialState: RoomState = {
  loading: true,
  loadError: null,
  room: null,
  myRole: null,
  publicBaseUrl: null,
  maxAutoTurns: null,
  participants: [],
  onlineUserIds: [],
  workingUserIds: [],
  messages: [],
  approvals: [],
  artifacts: {},
  conn: 'connecting',
};

function cmpByCreated(a: { created_at: string; id: string }, b: { created_at: string; id: string }): number {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

type Action =
  | {
      type: 'loaded';
      room: Room;
      participants: Participant[];
      myRole: Role;
      publicBaseUrl: string | null;
      maxAutoTurns: number | null;
    }
  | { type: 'load_error'; error: string }
  | { type: 'room'; room: Room }
  | { type: 'participant'; participant: Participant }
  | { type: 'participants'; participants: Participant[] }
  | { type: 'presence'; onlineUserIds: string[] }
  | { type: 'activity'; userId: string; state: ActivityState }
  | { type: 'activity_reset' }
  | { type: 'messages_add'; messages: Message[] }
  | { type: 'approvals_set'; approvals: Approval[] }
  | { type: 'approvals_merge'; approvals: Approval[] }
  | { type: 'approval_upsert'; approval: Approval }
  | { type: 'artifacts_add'; artifacts: Artifact[] }
  | { type: 'conn'; conn: ConnectionState };

function reducer(state: RoomState, action: Action): RoomState {
  switch (action.type) {
    case 'loaded':
      return {
        ...state,
        loading: false,
        loadError: null,
        room: action.room,
        participants: action.participants,
        myRole: action.myRole,
        publicBaseUrl: action.publicBaseUrl,
        maxAutoTurns: action.maxAutoTurns,
      };
    case 'load_error':
      return { ...state, loading: false, loadError: action.error };
    case 'room':
      return { ...state, room: action.room };
    case 'participant': {
      const exists = state.participants.some((p) => p.user_id === action.participant.user_id);
      return {
        ...state,
        participants: exists
          ? state.participants.map((p) =>
              p.user_id === action.participant.user_id ? action.participant : p,
            )
          : [...state.participants, action.participant],
      };
    }
    case 'participants':
      return { ...state, participants: action.participants };
    case 'presence':
      return { ...state, onlineUserIds: action.onlineUserIds };
    case 'activity': {
      const working = state.workingUserIds.includes(action.userId);
      if (action.state === 'working') {
        if (working) return state;
        return { ...state, workingUserIds: [...state.workingUserIds, action.userId] };
      }
      if (!working) return state;
      return { ...state, workingUserIds: state.workingUserIds.filter((id) => id !== action.userId) };
    }
    case 'activity_reset':
      return state.workingUserIds.length === 0 ? state : { ...state, workingUserIds: [] };
    case 'messages_add': {
      const byId = new Map(state.messages.map((m) => [m.id, m] as const));
      let changed = false;
      for (const m of action.messages) {
        if (!byId.has(m.id)) {
          byId.set(m.id, m);
          changed = true;
        }
      }
      if (!changed) return state;
      return { ...state, messages: [...byId.values()].sort(cmpByCreated) };
    }
    case 'approvals_set':
      return { ...state, approvals: [...action.approvals].sort(cmpByCreated) };
    case 'approvals_merge': {
      // Merge-by-id (like messages_add): a wholesale replace could drop an
      // approval_created frame that raced the in-flight GET /approvals during
      // a reconnect, hiding a pending approval until the next reconnect.
      const byId = new Map(state.approvals.map((a) => [a.id, a] as const));
      for (const a of action.approvals) {
        const existing = byId.get(a.id);
        // Never downgrade a resolution we already saw to a stale 'pending'.
        if (existing && existing.status !== 'pending' && a.status === 'pending') continue;
        byId.set(a.id, a);
      }
      return { ...state, approvals: [...byId.values()].sort(cmpByCreated) };
    }
    case 'approval_upsert': {
      const rest = state.approvals.filter((a) => a.id !== action.approval.id);
      return { ...state, approvals: [...rest, action.approval].sort(cmpByCreated) };
    }
    case 'artifacts_add': {
      if (action.artifacts.length === 0) return state;
      const next = { ...state.artifacts };
      for (const a of action.artifacts) next[a.id] = a;
      return { ...state, artifacts: next };
    }
    case 'conn':
      return { ...state, conn: action.conn };
  }
}

export interface RoomActions {
  sendMessage: (
    bodyMarkdown: string,
    recipientIds: string[],
    replyToMessageId?: string,
  ) => Promise<void>;
  updateSummary: (summaryMarkdown: string | null) => Promise<void>;
  /** Owner-only: update Tier-1 per-room settings live (PATCH …/settings). */
  updateRoomSettings: (patch: RoomSettingsPatchRequest) => Promise<Room>;
  setAllAgentsPaused: (paused: boolean) => Promise<void>;
  setParticipantPaused: (userId: string, paused: boolean) => Promise<void>;
  respondApproval: (approvalId: string, decision: 'approved' | 'denied') => Promise<void>;
  addParticipant: (body: AddParticipantRequest) => Promise<api.AddParticipantResult>;
  rotateToken: (userId: string) => Promise<api.RotateTokenResult>;
  /** Self-service: create/reconnect the caller's own agent, minting its bridge token. */
  provisionMyAgent: (agentName?: string) => Promise<MyAgentResponse>;
  exportTranscript: () => Promise<void>;
  downloadArtifact: (artifact: Artifact) => Promise<void>;
}

export function useRoomState(
  token: string,
  roomId: string,
  onUnauthorized: (err?: unknown) => void,
): { state: RoomState; actions: RoomActions } {
  const [state, dispatch] = useReducer(reducer, initialState);
  const lastMessageRef = useRef<Message | null>(null);
  const requestedArtifactsRef = useRef<Set<string>>(new Set());

  const guard = useCallback(
    async <T,>(work: Promise<T>): Promise<T> => {
      try {
        return await work;
      } catch (err) {
        if (api.isUnauthorized(err)) onUnauthorized(err);
        throw err;
      }
    },
    [onUnauthorized],
  );

  const noteMessages = useCallback((messages: Message[]) => {
    if (messages.length === 0) return;
    for (const m of messages) {
      if (!lastMessageRef.current || cmpByCreated(lastMessageRef.current, m) < 0) {
        lastMessageRef.current = m;
      }
    }
    dispatch({ type: 'messages_add', messages });
  }, []);

  const fetchMissingArtifacts = useCallback(
    (messages: Message[]) => {
      const wanted: string[] = [];
      for (const m of messages) {
        for (const id of m.artifact_ids) {
          if (!requestedArtifactsRef.current.has(id)) {
            requestedArtifactsRef.current.add(id);
            wanted.push(id);
          }
        }
      }
      for (const id of wanted) {
        api
          .getArtifact(token, roomId, id)
          .then((artifact) => dispatch({ type: 'artifacts_add', artifacts: [artifact] }))
          .catch(() => {
            // Allow a retry on the next sighting of this artifact id.
            requestedArtifactsRef.current.delete(id);
          });
      }
    },
    [token, roomId],
  );

  /** Page through GET /messages from `after` (null = from the beginning). */
  const catchUp = useCallback(
    async (after: string | null) => {
      let cursor = after;
      for (;;) {
        const batch = await api.getMessages(token, roomId, cursor ?? undefined, 500);
        if (batch.length > 0) {
          noteMessages(batch);
          fetchMissingArtifacts(batch);
          cursor = batch[batch.length - 1]?.id ?? cursor;
        }
        if (batch.length < 500) return;
      }
    },
    [token, roomId, noteMessages, fetchMissingArtifacts],
  );

  const handleFrame = useCallback(
    (frame: WsServerFrame) => {
      switch (frame.type) {
        case 'hello':
          dispatch({ type: 'room', room: frame.room });
          dispatch({ type: 'participants', participants: frame.participants });
          dispatch({ type: 'presence', onlineUserIds: frame.presence });
          // The hello frame carries no activity info: a fresh connection
          // assumes everyone is idle and learns from subsequent frames.
          dispatch({ type: 'activity_reset' });
          // Recover anything missed while disconnected.
          void catchUp(lastMessageRef.current?.id ?? null).catch(() => undefined);
          api
            .getApprovals(token, roomId)
            .then((approvals) => dispatch({ type: 'approvals_merge', approvals }))
            .catch(() => undefined);
          break;
        case 'message_created':
          noteMessages([frame.message]);
          fetchMissingArtifacts([frame.message]);
          break;
        case 'approval_created':
        case 'approval_resolved':
          dispatch({ type: 'approval_upsert', approval: frame.approval });
          break;
        case 'participant_updated':
          dispatch({ type: 'participant', participant: frame.participant });
          break;
        case 'room_updated':
          dispatch({ type: 'room', room: frame.room });
          break;
        case 'presence':
          dispatch({ type: 'presence', onlineUserIds: frame.online_user_ids });
          break;
        case 'activity':
          // No local revert timer here on purpose: the server broadcasts a
          // 'working' frame only on the idle→working EDGE (repeated reports
          // just refresh its 60 s auto-revert, contract §8), so during one
          // long engine run no further frame ever arrives — a client-side
          // fallback would wrongly flip a still-working agent back to idle.
          // Lost-frame cases are covered by the server's auto-revert broadcast
          // and by the hello reset on reconnect.
          dispatch({
            type: 'activity',
            userId: frame.payload.user_id,
            state: frame.payload.state,
          });
          break;
        case 'pong':
        case 'error':
          break;
      }
    },
    [token, roomId, catchUp, noteMessages, fetchMissingArtifacts],
  );

  const handleFrameRef = useRef(handleFrame);
  handleFrameRef.current = handleFrame;

  useEffect(() => {
    let cancelled = false;
    lastMessageRef.current = null;
    requestedArtifactsRef.current = new Set();

    const socket = new RoomSocket(roomId, token, {
      onFrame: (frame) => {
        if (!cancelled) handleFrameRef.current(frame);
      },
      onState: (conn) => {
        if (!cancelled) dispatch({ type: 'conn', conn });
      },
    });

    void (async () => {
      try {
        const detail = await api.getRoom(token, roomId);
        if (cancelled) return;
        dispatch({
          type: 'loaded',
          room: detail.room,
          participants: detail.participants,
          myRole: detail.my_role,
          publicBaseUrl: detail.public_base_url ?? null,
          maxAutoTurns: detail.max_auto_turns ?? null,
        });
        const [approvals, artifacts] = await Promise.all([
          api.getApprovals(token, roomId),
          api.getArtifacts(token, roomId),
        ]);
        if (cancelled) return;
        dispatch({ type: 'approvals_set', approvals });
        for (const a of artifacts) requestedArtifactsRef.current.add(a.id);
        dispatch({ type: 'artifacts_add', artifacts });
        await catchUp(null);
        if (cancelled) return;
        socket.start();
      } catch (err) {
        if (cancelled) return;
        if (api.isUnauthorized(err)) {
          onUnauthorized(err);
          return;
        }
        dispatch({ type: 'load_error', error: api.errorText(err) });
      }
    })();

    return () => {
      cancelled = true;
      socket.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, token]);

  const sendMessage = useCallback(
    async (bodyMarkdown: string, recipientIds: string[], replyToMessageId?: string) => {
      const message = await guard(
        api.postMessage(token, roomId, {
          recipient_ids: recipientIds,
          message_type: 'human_message',
          body_markdown: bodyMarkdown,
          ...(replyToMessageId ? { reply_to_message_id: replyToMessageId } : {}),
        }),
      );
      noteMessages([message]);
    },
    [guard, token, roomId, noteMessages],
  );

  const updateSummary = useCallback(
    async (summaryMarkdown: string | null) => {
      const room = await guard(api.updateSummary(token, roomId, summaryMarkdown));
      dispatch({ type: 'room', room });
    },
    [guard, token, roomId],
  );

  const updateRoomSettings = useCallback(
    async (patch: RoomSettingsPatchRequest) => {
      // Authoritative reconcile: the PATCH response carries the updated room
      // (with recomputed effective_settings); the server also broadcasts a
      // room_updated frame that dispatches the same 'room' action.
      const room = await guard(api.patchRoomSettings(token, roomId, patch));
      dispatch({ type: 'room', room });
      return room;
    },
    [guard, token, roomId],
  );

  const setAllAgentsPaused = useCallback(
    async (paused: boolean) => {
      const result = await guard(api.pause(token, roomId, 'all_agents', paused));
      if (result.room) dispatch({ type: 'room', room: result.room });
    },
    [guard, token, roomId],
  );

  const setParticipantPaused = useCallback(
    async (userId: string, paused: boolean) => {
      const result = await guard(api.pause(token, roomId, userId, paused));
      if (result.participant) dispatch({ type: 'participant', participant: result.participant });
    },
    [guard, token, roomId],
  );

  const respondApproval = useCallback(
    async (approvalId: string, decision: 'approved' | 'denied') => {
      const approval = await guard(api.respondApproval(token, roomId, approvalId, decision));
      dispatch({ type: 'approval_upsert', approval });
    },
    [guard, token, roomId],
  );

  const addParticipant = useCallback(
    async (body: AddParticipantRequest) => {
      const result = await guard(api.addParticipant(token, roomId, body));
      dispatch({ type: 'participant', participant: result.participant });
      return result;
    },
    [guard, token, roomId],
  );

  const rotateToken = useCallback(
    (userId: string) => guard(api.rotateParticipantToken(token, roomId, userId)),
    [guard, token, roomId],
  );

  const provisionMyAgent = useCallback(
    async (agentName?: string) => {
      const result = await guard(api.provisionMyAgent(token, roomId, agentName));
      // Reflect the created/updated agent participant in the roster immediately
      // (a fresh create arrives over WS too, but this avoids a flash of absence).
      dispatch({ type: 'participant', participant: result.participant });
      return result;
    },
    [guard, token, roomId],
  );

  const exportTranscript = useCallback(
    () => guard(api.downloadTranscript(token, roomId)),
    [guard, token, roomId],
  );

  const downloadArtifact = useCallback(
    (artifact: Artifact) => guard(api.downloadArtifact(token, artifact)),
    [guard, token],
  );

  return {
    state,
    actions: {
      sendMessage,
      updateSummary,
      updateRoomSettings,
      setAllAgentsPaused,
      setParticipantPaused,
      respondApproval,
      addParticipant,
      rotateToken,
      provisionMyAgent,
      exportTranscript,
      downloadArtifact,
    },
  };
}

/**
 * Trailing consecutive agent messages (the server's turn-limit run):
 * system_event messages neither extend nor break the run; any other
 * non-agent message breaks it.
 */
export function agentTurnRun(messages: Message[]): number {
  let run = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.message_type === 'system_event') continue;
    if (m.sender.kind === 'agent') run += 1;
    else break;
  }
  return run;
}
