/**
 * Room settings control surface (Tier-1: host-owned, server-owned, live).
 *
 * Opened from the room header. The OWNER edits the three per-room overrides —
 * agent turn limit, artifact retention, and storage quota — which the server
 * applies PER-REQUEST with no restart (docs/API-CONTRACT.md §3). Each change is
 * optimistic (shown immediately) and then reconciled from the authoritative
 * room the PATCH returns and the `room_updated` WS frame carries. Non-owners see
 * the same values read-only.
 *
 * Tier-1 / Tier-2 note: these settings govern only server-side room behavior.
 * They never touch any participant's LOCAL bridge filesystem/tool/policy bounds
 * (Tier 2), which are never server-pushed.
 */
import { useRef, useState } from 'react';
import { DEFAULTS, type Room, type RoomSettingsPatchRequest } from '@clausroom/protocol';
import { errorText } from '../api.js';
import { humanSize } from '../format.js';
import { RefreshIcon, SettingsIcon, XIcon } from './icons.js';

type SettingKey = 'max_auto_turns' | 'retention_days' | 'storage_bytes';

/** Built-in fallback defaults, used only for the "reset to default" hint when
 * an override is active (the running server default is knowable exactly only
 * when no override is set — then it equals the effective value). */
const FALLBACK_DEFAULT: Record<SettingKey, number> = {
  max_auto_turns: DEFAULTS.MAX_AUTO_TURNS,
  retention_days: DEFAULTS.ARTIFACT_RETENTION_DAYS,
  storage_bytes: DEFAULTS.ROOM_STORAGE_BYTES,
};

const MB = 1024 * 1024;
const GB = 1024 * 1024 * 1024;
type StorageUnit = 'MB' | 'GB';
const UNIT_BYTES: Record<StorageUnit, number> = { MB, GB };

interface RoomSettingsProps {
  open: boolean;
  onClose: () => void;
  room: Room | null;
  /** True for the room owner: settings are editable. Others see read-only. */
  canEdit: boolean;
  onUpdate: (patch: RoomSettingsPatchRequest) => Promise<Room>;
}

export function RoomSettings({ open, onClose, room, canEdit, onUpdate }: RoomSettingsProps) {
  if (!open || !room) return null;
  return (
    <div className="drawer-overlay" onClick={onClose}>
      <div
        className="drawer card"
        role="dialog"
        aria-label="Room settings"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Keyed by room id so switching rooms remounts with fresh drafts. */}
        <RoomSettingsBody key={room.id} room={room} canEdit={canEdit} onUpdate={onUpdate} onClose={onClose} />
      </div>
    </div>
  );
}

/**
 * Local state for one setting: an optimistic effective value shown while the
 * PATCH is in flight, then dropped once `room` reflects the change. `undefined`
 * = show the committed value; `null` is a real value (retention disabled).
 */
function useSetting(field: SettingKey, room: Room, onUpdate: RoomSettingsProps['onUpdate']) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [optimistic, setOptimistic] = useState<number | null | undefined>(undefined);

  const override = (room[field] ?? null) as number | null;
  const eff = room.effective_settings?.[field];
  const committedEffective: number | null = eff === undefined ? FALLBACK_DEFAULT[field] : eff;
  const isOverride = override !== null;
  const effective = optimistic !== undefined ? optimistic : committedEffective;
  // Exact when there is no override; best-effort built-in default otherwise.
  const shownDefault = isOverride ? FALLBACK_DEFAULT[field] : committedEffective;

  async function apply(patchValue: number | null, optimisticEffective: number | null) {
    setBusy(true);
    setError(null);
    setOptimistic(optimisticEffective);
    try {
      await onUpdate({ [field]: patchValue } as RoomSettingsPatchRequest);
      // Reconciled: the returned room (and the room_updated frame) is the source
      // of truth now — drop the optimistic overlay and read committed values.
      setOptimistic(undefined);
    } catch (err) {
      setOptimistic(undefined);
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return { override, committedEffective, isOverride, effective, shownDefault, busy, error, setError, apply };
}

function RoomSettingsBody({
  room,
  canEdit,
  onUpdate,
  onClose,
}: {
  room: Room;
  canEdit: boolean;
  onUpdate: RoomSettingsProps['onUpdate'];
  onClose: () => void;
}) {
  const turns = useSetting('max_auto_turns', room, onUpdate);
  const retention = useSetting('retention_days', room, onUpdate);
  const storage = useSetting('storage_bytes', room, onUpdate);

  const turnsRef = useRef<HTMLInputElement>(null);
  const retentionRef = useRef<HTMLInputElement>(null);

  function applyTurns() {
    const raw = turnsRef.current?.value ?? '';
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 1 || n > 100) {
      turns.setError('Enter a whole number from 1 to 100.');
      return;
    }
    void turns.apply(n, n);
  }

  function applyRetention() {
    const raw = retentionRef.current?.value ?? '';
    const n = Number.parseFloat(raw);
    if (!Number.isFinite(n) || n < 0) {
      retention.setError('Enter a number of days (0 or more).');
      return;
    }
    void retention.apply(n, n);
  }

  return (
    <>
      <header className="drawer__head">
        <h2 className="drawer__title">
          <SettingsIcon size={17} /> Room settings
        </h2>
        <button type="button" className="btn btn--ghost btn--icon" onClick={onClose} aria-label="Close">
          <XIcon size={16} />
        </button>
      </header>

      <p className="setting-intro">
        {canEdit
          ? 'Host-owned room limits. Changes apply live — no restart, no agent reconnect.'
          : 'Host-owned room limits, set by the room owner. Read-only for you.'}
      </p>

      {/* --- Agent turn limit --------------------------------------------- */}
      <section className="drawer__section setting">
        <div className="setting__head">
          <h3 className="drawer__subtitle">Agent turn limit</h3>
          <SettingBadge isOverride={turns.isOverride} />
        </div>
        <p className="setting__desc">
          Consecutive agent messages allowed before a human must reply.
        </p>
        <div className="setting__effective">
          <span className="setting__value">{fmtTurns(turns.effective as number)}</span>
          <span className="setting__unit">effective</span>
        </div>

        {canEdit ? (
          <div className="setting__edit">
            <div className="setting__row">
              <input
                key={`turns-${turns.committedEffective}`}
                ref={turnsRef}
                className="input setting__input"
                type="number"
                min={1}
                max={100}
                step={1}
                defaultValue={String(turns.committedEffective)}
                onFocus={() => turns.setError(null)}
                aria-label="Agent turn limit"
              />
              <button
                type="button"
                className="btn btn--primary btn--sm"
                disabled={turns.busy}
                onClick={applyTurns}
              >
                {turns.busy ? 'Applying…' : 'Apply'}
              </button>
            </div>
            <ResetRow
              field={turns}
              defaultText={fmtTurns(turns.shownDefault as number)}
              onReset={() => void turns.apply(null, turns.committedEffective)}
            />
          </div>
        ) : (
          <ReadOnlyDefault isOverride={turns.isOverride} defaultText={fmtTurns(turns.shownDefault as number)} />
        )}
        {turns.error && <div className="form-error form-error--sm" role="alert">{turns.error}</div>}
      </section>

      {/* --- Artifact retention ------------------------------------------- */}
      <section className="drawer__section setting">
        <div className="setting__head">
          <h3 className="drawer__subtitle">Artifact retention</h3>
          <SettingBadge isOverride={retention.isOverride} />
        </div>
        <p className="setting__desc">
          How long uploaded artifacts are kept before the sweep deletes them.
          {' '}A room override cannot disable expiry (only the server default can).
        </p>
        <div className="setting__effective">
          <span className="setting__value">{fmtRetention(retention.effective)}</span>
          <span className="setting__unit">effective</span>
        </div>

        {canEdit ? (
          <div className="setting__edit">
            <div className="setting__row">
              <input
                key={`retention-${retention.committedEffective ?? 'off'}`}
                ref={retentionRef}
                className="input setting__input"
                type="number"
                min={0}
                step="any"
                placeholder="e.g. 30"
                defaultValue={retention.committedEffective === null ? '' : String(retention.committedEffective)}
                onFocus={() => retention.setError(null)}
                aria-label="Artifact retention in days"
              />
              <span className="setting__suffix">days</span>
              <button
                type="button"
                className="btn btn--primary btn--sm"
                disabled={retention.busy}
                onClick={applyRetention}
              >
                {retention.busy ? 'Applying…' : 'Apply'}
              </button>
            </div>
            <ResetRow
              field={retention}
              defaultText={fmtRetention(retention.isOverride ? retention.shownDefault : retention.committedEffective)}
              onReset={() => void retention.apply(null, retention.committedEffective)}
            />
          </div>
        ) : (
          <ReadOnlyDefault
            isOverride={retention.isOverride}
            defaultText={fmtRetention(retention.isOverride ? retention.shownDefault : retention.committedEffective)}
          />
        )}
        {retention.error && <div className="form-error form-error--sm" role="alert">{retention.error}</div>}
      </section>

      {/* --- Storage quota ------------------------------------------------ */}
      <section className="drawer__section setting">
        <div className="setting__head">
          <h3 className="drawer__subtitle">Storage quota</h3>
          <SettingBadge isOverride={storage.isOverride} />
        </div>
        <p className="setting__desc">
          Total size of this room&rsquo;s live (non-deleted) artifacts.
        </p>
        <div className="setting__effective">
          <span className="setting__value">{humanSize(storage.effective as number)}</span>
          <span className="setting__unit">effective</span>
        </div>

        {canEdit ? (
          <div className="setting__edit">
            <StorageEditor
              key={`storage-${storage.committedEffective}`}
              committedBytes={storage.committedEffective as number}
              busy={storage.busy}
              onApply={(bytes) => void storage.apply(bytes, bytes)}
              onError={(msg) => storage.setError(msg)}
              onClearError={() => storage.setError(null)}
            />
            <ResetRow
              field={storage}
              defaultText={humanSize(storage.shownDefault as number)}
              onReset={() => void storage.apply(null, storage.committedEffective)}
            />
          </div>
        ) : (
          <ReadOnlyDefault isOverride={storage.isOverride} defaultText={humanSize(storage.shownDefault as number)} />
        )}
        {storage.error && <div className="form-error form-error--sm" role="alert">{storage.error}</div>}
      </section>
    </>
  );
}

function SettingBadge({ isOverride }: { isOverride: boolean }) {
  return (
    <span className={`setting-badge${isOverride ? ' setting-badge--override' : ' setting-badge--default'}`}>
      {isOverride ? 'override' : 'default'}
    </span>
  );
}

function ResetRow({
  field,
  defaultText,
  onReset,
}: {
  field: { isOverride: boolean; busy: boolean };
  defaultText: string;
  onReset: () => void;
}) {
  return (
    <div className="setting__reset">
      <span className="setting__default-hint">
        Default: <strong>{defaultText}</strong>
      </span>
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        disabled={!field.isOverride || field.busy}
        onClick={onReset}
        title={field.isOverride ? 'Clear the override and use the server default' : 'No override to reset'}
      >
        <RefreshIcon size={13} /> Reset to default
      </button>
    </div>
  );
}

function ReadOnlyDefault({ isOverride, defaultText }: { isOverride: boolean; defaultText: string }) {
  return (
    <p className="setting__default-hint">
      {isOverride ? (
        <>Overrides the server default of <strong>{defaultText}</strong>.</>
      ) : (
        <>Using the server default (<strong>{defaultText}</strong>).</>
      )}
    </p>
  );
}

function StorageEditor({
  committedBytes,
  busy,
  onApply,
  onError,
  onClearError,
}: {
  committedBytes: number;
  busy: boolean;
  onApply: (bytes: number) => void;
  onError: (message: string) => void;
  onClearError: () => void;
}) {
  const init = splitBytes(committedBytes);
  const [unit, setUnit] = useState<StorageUnit>(init.unit);
  const [value, setValue] = useState<string>(init.value);

  function changeUnit(next: StorageUnit) {
    const cur = Number.parseFloat(value);
    if (Number.isFinite(cur)) {
      const abs = cur * UNIT_BYTES[unit];
      setValue(trimNum(abs / UNIT_BYTES[next]));
    }
    setUnit(next);
  }

  function apply() {
    const n = Number.parseFloat(value);
    if (!Number.isFinite(n) || n <= 0) {
      onError('Enter a quota greater than 0.');
      return;
    }
    const bytes = Math.round(n * UNIT_BYTES[unit]);
    if (bytes <= 0) {
      onError('Enter a quota greater than 0.');
      return;
    }
    onApply(bytes);
  }

  return (
    <div className="setting__row">
      <input
        className="input setting__input"
        type="number"
        min={0}
        step="any"
        value={value}
        onChange={(e) => {
          onClearError();
          setValue(e.target.value);
        }}
        aria-label="Storage quota amount"
      />
      <select
        className="input setting__unit-select"
        value={unit}
        onChange={(e) => changeUnit(e.target.value === 'GB' ? 'GB' : 'MB')}
        aria-label="Storage quota unit"
      >
        <option value="MB">MB</option>
        <option value="GB">GB</option>
      </select>
      <button type="button" className="btn btn--primary btn--sm" disabled={busy} onClick={apply}>
        {busy ? 'Applying…' : 'Apply'}
      </button>
    </div>
  );
}

// --- header trigger ---------------------------------------------------------

export function RoomSettingsButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="btn btn--ghost btn--sm" onClick={onClick} title="Room settings">
      <SettingsIcon size={14} /> Settings
    </button>
  );
}

// --- formatting -------------------------------------------------------------

function fmtTurns(n: number): string {
  return `${n} ${n === 1 ? 'turn' : 'turns'}`;
}

function fmtRetention(n: number | null): string {
  if (n === null) return 'Off — artifacts never expire';
  if (n === 0) return 'Immediate (0 days)';
  return `${trimNum(n)} ${n === 1 ? 'day' : 'days'}`;
}

function trimNum(v: number): string {
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
}

function splitBytes(bytes: number): { unit: StorageUnit; value: string } {
  if (bytes >= GB) return { unit: 'GB', value: trimNum(bytes / GB) };
  return { unit: 'MB', value: trimNum(bytes / MB) };
}
