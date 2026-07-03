/**
 * Shared "accept a message" path: insert the row, broadcast the
 * message_created frame, and print the binding stdout line
 * `MSG <room_id> <sender_id> <message_type>` — exactly once per message.
 *
 * `createMessage` (insert only) and `publishMessage` (broadcast + log) are
 * exposed separately so multi-write paths (e.g. artifact upload + its
 * mandatory artifact_uploaded message) can run the inserts inside one
 * store.transaction() and broadcast only after the transaction commits.
 */
import { genId, type Message, type MessageType, type Confidence } from '@clausroom/protocol';
import { monotonicNowIso, toMessage, type Store, type UserRow } from './db.js';
import type { WsHub } from './ws.js';

export interface NewMessageInput {
  roomId: string;
  sender: UserRow;
  messageType: MessageType;
  bodyMarkdown: string;
  recipientIds?: string[];
  artifactIds?: string[];
  replyToMessageId?: string | null;
  confidence?: Confidence | null;
  /** Decision-card choices, stored verbatim as choices_json (null when unset). */
  choices?: string[] | null;
}

/** Insert the message row (no broadcast/log). Safe to call inside a transaction. */
export function createMessage(store: Store, input: NewMessageInput): Message {
  const id = genId('msg');
  // Strictly increasing created_at keeps (created_at, id) a true insertion
  // order, so `after`-cursor pagination can never skip a same-millisecond row.
  const createdAt = monotonicNowIso();
  store.insertMessage({
    id,
    room_id: input.roomId,
    sender_id: input.sender.id,
    recipient_ids_json: JSON.stringify(input.recipientIds ?? []),
    message_type: input.messageType,
    body_markdown: input.bodyMarkdown,
    artifact_ids_json: JSON.stringify(input.artifactIds ?? []),
    reply_to_message_id: input.replyToMessageId ?? null,
    confidence: input.confidence ?? null,
    choices_json: input.choices ? JSON.stringify(input.choices) : null,
    created_at: createdAt,
  });
  const row = store.getMessageInRoom(input.roomId, id);
  return row
    ? toMessage(row)
    : {
        id,
        room_id: input.roomId,
        sender: {
          id: input.sender.id,
          kind: input.sender.kind,
          display_name: input.sender.display_name,
        },
        recipient_ids: input.recipientIds ?? [],
        message_type: input.messageType,
        body_markdown: input.bodyMarkdown,
        artifact_ids: input.artifactIds ?? [],
        reply_to_message_id: input.replyToMessageId ?? null,
        confidence: input.confidence ?? null,
        choices: input.choices ?? null,
        created_at: createdAt,
      };
}

/** Broadcast the message_created frame and print the binding MSG stdout line. */
export function publishMessage(hub: WsHub, message: Message): void {
  hub.broadcast(message.room_id, { type: 'message_created', message });
  // Binding machine-readable log line (docs/API-CONTRACT.md §14).
  console.log(`MSG ${message.room_id} ${message.sender.id} ${message.message_type}`);
}

export function createAndBroadcastMessage(store: Store, hub: WsHub, input: NewMessageInput): Message {
  const message = createMessage(store, input);
  publishMessage(hub, message);
  return message;
}
