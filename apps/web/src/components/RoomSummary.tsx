import { useState } from 'react';
import { DEFAULTS, type Room } from '@clausroom/protocol';
import { errorText } from '../api.js';
import { fmtTime } from '../format.js';
import { ChevronDownIcon, PencilIcon } from './icons.js';
import { Markdown } from './Markdown.js';

interface RoomSummaryProps {
  room: Room;
  /** Humans with can_send may edit (PUT /api/rooms/:id/summary). */
  canEdit: boolean;
  nameOf: (userId: string) => string;
  /** Saves the summary; null clears it. Rejections stay local to this card. */
  onSave: (summaryMarkdown: string | null) => Promise<void>;
}

/**
 * Pinned, collapsible room summary card (top of the sidebar). Renders the
 * summary markdown, updates live from room_updated frames (via the room
 * prop), and lets humans edit it in place with a 4000-char capped textarea.
 */
export function RoomSummary({ room, canEdit, nameOf, onSave }: RoomSummaryProps) {
  const [open, setOpen] = useState(true);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const summary = room.summary_markdown ?? null;

  function startEdit() {
    setDraft(summary ?? '');
    setError(null);
    setEditing(true);
    setOpen(true);
  }

  async function save() {
    if (busy) return;
    const trimmed = draft.trim();
    setBusy(true);
    setError(null);
    try {
      // An emptied textarea clears the summary back to unset (null).
      await onSave(trimmed.length === 0 ? null : trimmed);
      setEditing(false);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={`sidebar__section card summary-card${open ? '' : ' summary-card--collapsed'}`}>
      <div className="summary-card__head">
        <h2 className="sidebar__title summary-card__title">
          <button
            type="button"
            className="summary-card__toggle"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            <ChevronDownIcon size={13} className="summary-card__chevron" />
            Room summary
          </button>
        </h2>
        {canEdit && open && !editing && (
          <button type="button" className="btn btn--ghost btn--sm" onClick={startEdit}>
            <PencilIcon size={12} /> Edit
          </button>
        )}
      </div>

      {open && !editing && (
        <>
          {summary ? (
            <Markdown source={summary} />
          ) : (
            <p className="sidebar__hint">
              No summary yet — a pinned recap of where things stand.
              {canEdit && ' Use Edit to write one.'}
            </p>
          )}
          {room.summary_updated_at && (
            <p className="summary-card__byline">
              updated by {room.summary_updated_by ? nameOf(room.summary_updated_by) : 'someone'} ·{' '}
              <time dateTime={room.summary_updated_at} title={room.summary_updated_at}>
                {fmtTime(room.summary_updated_at)}
              </time>
            </p>
          )}
        </>
      )}

      {open && editing && (
        <div className="summary-edit">
          <textarea
            className="input summary-edit__textarea"
            value={draft}
            maxLength={DEFAULTS.SUMMARY_MAX_CHARS}
            placeholder="Markdown summary of where things stand… (empty clears it)"
            onChange={(e) => setDraft(e.target.value)}
            autoFocus
          />
          <div className="summary-edit__foot">
            <span
              className={`summary-edit__count${
                draft.length >= DEFAULTS.SUMMARY_MAX_CHARS ? ' summary-edit__count--max' : ''
              }`}
            >
              {draft.length.toLocaleString()} / {DEFAULTS.SUMMARY_MAX_CHARS.toLocaleString()}
            </span>
            <div className="summary-edit__actions">
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                disabled={busy}
                onClick={() => setEditing(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn--primary btn--sm"
                disabled={busy}
                onClick={() => void save()}
              >
                {busy ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
          {error && (
            <span className="form-error form-error--sm" role="alert">
              {error}
            </span>
          )}
        </div>
      )}
    </section>
  );
}
