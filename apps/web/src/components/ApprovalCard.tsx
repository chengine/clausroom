import { useState } from 'react';
import { DEFAULTS, type Approval } from '@clausroom/protocol';
import { errorText } from '../api.js';
import { humanSize, shortSha, timeAgo, typeLabel } from '../format.js';
import { CheckIcon, ShieldIcon, XIcon } from './icons.js';

interface ApprovalCardProps {
  approval: Approval;
  meId: string;
  nameOf: (userId: string) => string;
  onRespond: (approvalId: string, decision: 'approved' | 'denied') => Promise<void>;
  compact?: boolean;
}

/** Client-side mirror of the server's lazy expiry, purely for display. */
export function effectiveStatus(approval: Approval): Approval['status'] {
  if (
    approval.status === 'pending' &&
    Date.now() - new Date(approval.created_at).getTime() > DEFAULTS.APPROVAL_TTL_MS
  ) {
    return 'expired';
  }
  return approval.status;
}

function payloadString(payload: Record<string, unknown>, key: string): string | null {
  const v = payload[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function payloadNumber(payload: Record<string, unknown>, key: string): number | null {
  const v = payload[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function ApprovalCard({ approval, meId, nameOf, onRespond, compact }: ApprovalCardProps) {
  const [busy, setBusy] = useState<'approved' | 'denied' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const status = effectiveStatus(approval);
  const iAmReviewer = approval.reviewer_user_id === meId;
  const actionable = status === 'pending' && iAmReviewer;

  const filename = payloadString(approval.payload, 'filename');
  const path = payloadString(approval.payload, 'path');
  const command = payloadString(approval.payload, 'command');
  const cwd = payloadString(approval.payload, 'cwd');
  const description =
    payloadString(approval.payload, 'description') ?? payloadString(approval.payload, 'reason');
  const sizeBytes = payloadNumber(approval.payload, 'size_bytes');
  const sha = payloadString(approval.payload, 'sha256');

  async function respond(decision: 'approved' | 'denied') {
    if (busy) return;
    setBusy(decision);
    setError(null);
    try {
      await onRespond(approval.id, decision);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div
      className={`approval-card approval-card--${status}${compact ? ' approval-card--compact' : ''}`}
      data-approval-id={approval.id}
    >
      <header className="approval-card__head">
        <span className="approval-card__icon">
          <ShieldIcon size={14} />
        </span>
        <span className="approval-card__type">{typeLabel(approval.approval_type)}</span>
        <span className={`pill pill--${status}`}>{status}</span>
        <span className="approval-card__age" title={approval.created_at}>
          {timeAgo(approval.created_at)}
        </span>
      </header>

      <div className="approval-card__who">
        <span>
          <strong>{nameOf(approval.requested_by)}</strong> asks{' '}
          <strong>{iAmReviewer ? 'you' : nameOf(approval.reviewer_user_id)}</strong>
        </span>
      </div>

      <dl className="approval-card__details">
        {filename && (
          <div className="approval-card__row">
            <dt>file</dt>
            <dd className="mono">{filename}</dd>
          </div>
        )}
        {command && (
          <div className="approval-card__row">
            <dt>command</dt>
            <dd className="mono">{command}</dd>
          </div>
        )}
        {cwd && (
          <div className="approval-card__row">
            <dt>cwd</dt>
            <dd className="mono">{cwd}</dd>
          </div>
        )}
        {!compact && path && (
          <div className="approval-card__row">
            <dt>path</dt>
            <dd className="mono">{path}</dd>
          </div>
        )}
        {sizeBytes !== null && (
          <div className="approval-card__row">
            <dt>size</dt>
            <dd>{humanSize(sizeBytes)}</dd>
          </div>
        )}
        {sha && (
          <div className="approval-card__row">
            <dt>sha256</dt>
            <dd className="mono" title={sha}>
              {shortSha(sha)}
            </dd>
          </div>
        )}
        {description && (
          <div className="approval-card__row">
            <dt>why</dt>
            <dd>{description}</dd>
          </div>
        )}
      </dl>

      {status === 'pending' && !iAmReviewer && (
        <p className="approval-card__note">
          Only {nameOf(approval.reviewer_user_id)} can decide this request.
        </p>
      )}

      {actionable && (
        <div className="approval-card__actions">
          <button
            type="button"
            className="btn btn--approve btn--sm"
            disabled={busy !== null}
            onClick={() => void respond('approved')}
          >
            <CheckIcon size={14} /> {busy === 'approved' ? 'Approving…' : 'Approve'}
          </button>
          <button
            type="button"
            className="btn btn--deny btn--sm"
            disabled={busy !== null}
            onClick={() => void respond('denied')}
          >
            <XIcon size={14} /> {busy === 'denied' ? 'Denying…' : 'Deny'}
          </button>
        </div>
      )}

      {error && <div className="form-error form-error--sm">{error}</div>}
    </div>
  );
}
