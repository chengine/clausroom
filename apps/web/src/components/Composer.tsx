import { useRef, useState, type KeyboardEvent } from 'react';
import { DEFAULTS, type Participant } from '@clausroom/protocol';
import { errorText } from '../api.js';
import { BotIcon, PersonIcon, SendIcon } from './icons.js';

interface ComposerProps {
  participants: Participant[];
  meId: string;
  colorOf: (userId: string) => string;
  canSend: boolean;
  onSend: (bodyMarkdown: string, recipientIds: string[]) => Promise<void>;
}

export function Composer({ participants, meId, colorOf, canSend, onSend }: ComposerProps) {
  const [body, setBody] = useState('');
  const [recipients, setRecipients] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // "Everyone" (empty recipient list) plus every other participant, agents
  // first — targeting an agent is the "ask my agent / ask their agent" flow.
  const targets = participants
    .filter((p) => p.user_id !== meId)
    .sort((a, b) => {
      const aAgent = a.user.kind === 'agent' ? 0 : 1;
      const bAgent = b.user.kind === 'agent' ? 0 : 1;
      return aAgent - bAgent || a.user.display_name.localeCompare(b.user.display_name);
    });

  function toggleRecipient(userId: string) {
    setRecipients((prev) =>
      prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId],
    );
  }

  async function send() {
    const trimmed = body.trim();
    if (!trimmed || sending || !canSend) return;
    setSending(true);
    setError(null);
    try {
      await onSend(trimmed, recipients);
      setBody('');
      textareaRef.current?.focus();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSending(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // The Enter that commits an IME composition (CJK input) fires keydown with
    // isComposing true (keyCode 229) — it must never send the message.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  }

  const remaining = DEFAULTS.MAX_BODY_CHARS - body.length;

  return (
    <div className="composer card">
      <div className="composer__recipients" role="group" aria-label="Recipients">
        <span className="composer__to">to</span>
        <button
          type="button"
          className={`recipient-chip${recipients.length === 0 ? ' recipient-chip--on' : ''}`}
          onClick={() => setRecipients([])}
        >
          Everyone
        </button>
        {targets.map((p) => {
          const on = recipients.includes(p.user_id);
          return (
            <button
              key={p.user_id}
              type="button"
              className={`recipient-chip${on ? ' recipient-chip--on' : ''}`}
              style={{ ['--pc' as string]: colorOf(p.user_id) }}
              onClick={() => toggleRecipient(p.user_id)}
              title={p.user.kind === 'agent' ? 'agent' : 'human'}
            >
              {p.user.kind === 'agent' ? <BotIcon size={12} /> : <PersonIcon size={12} />}
              {p.user.display_name}
            </button>
          );
        })}
      </div>

      <div className="composer__row">
        <textarea
          ref={textareaRef}
          className="composer__input"
          placeholder={
            canSend
              ? 'Write a message — Enter to send, Shift+Enter for a new line'
              : 'You are an observer in this room and cannot send messages.'
          }
          value={body}
          maxLength={DEFAULTS.MAX_BODY_CHARS}
          rows={Math.min(6, Math.max(1, body.split('\n').length))}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={!canSend || sending}
        />
        <button
          type="button"
          className="btn btn--primary composer__send"
          onClick={() => void send()}
          disabled={!canSend || sending || body.trim().length === 0}
          aria-label="Send message"
        >
          <SendIcon size={16} />
          <span>{sending ? 'Sending…' : 'Send'}</span>
        </button>
      </div>

      <div className="composer__foot">
        {error ? (
          <span className="form-error form-error--sm" role="alert">
            {error}
          </span>
        ) : (
          <span className="composer__hint">
            {recipients.length === 0
              ? 'Visible to the whole room.'
              : 'Addressed — everyone still sees it; recipients treat it as directed at them.'}
          </span>
        )}
        {remaining < DEFAULTS.MAX_BODY_CHARS * 0.1 && (
          <span className={`composer__count${remaining <= 0 ? ' composer__count--max' : ''}`}>
            {remaining.toLocaleString()} left
          </span>
        )}
      </div>
    </div>
  );
}
