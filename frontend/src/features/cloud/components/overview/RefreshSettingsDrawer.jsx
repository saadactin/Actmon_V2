import { useEffect, useMemo, useState } from 'react';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Drawer from '@/components/ui/Drawer';
import Icon from '@/components/ui/Icon';
import Input from '@/components/ui/Input';
import Select from '@/components/ui/Select';
import Switch from '@/components/ui/Switch';
import { Field, Section } from '@/components/ui/Field';
import cn from '@/lib/cn';
import { formatDateTime, relativeTime } from '../../utils/resourceModel';
import {
  useCancelRefresh, useLatestRefresh, useRefreshCapabilities, useRefreshHistory,
  useRefreshSchedule, useUpdateRefreshSchedule,
} from '../../hooks/useAccountRefresh';

/**
 * Refresh settings and history for one account.
 *
 * The schedule form only offers cadences the backend says it can run — the
 * frequency list, the allowed intervals and the day names all arrive from the
 * schedule endpoint. A form that offered "every 5 minutes" while the scheduler
 * refused anything under an hour would be a form that lies.
 *
 * Times are entered in a named timezone and stored with it. "02:00" on its own
 * is the bug this avoids: interpreted as UTC it runs at 07:30 for an operator
 * in Asia/Kolkata, in the middle of their working day.
 */

const STATUS_TONE = {
  SUCCEEDED: 'success',
  PARTIAL: 'warning',
  FAILED: 'danger',
  CANCELLED: 'neutral',
  RUNNING: 'info',
  QUEUED: 'info',
};

const COMPONENT_TONE = {
  SUCCEEDED: 'text-success-fg',
  FAILED: 'text-danger',
  SKIPPED: 'text-subtle',
  RUNNING: 'text-accent-text',
  PENDING: 'text-subtle',
};

const COMMON_ZONES = [
  'Asia/Kolkata', 'UTC', 'America/New_York', 'America/Chicago',
  'America/Los_Angeles', 'Europe/London', 'Europe/Berlin', 'Asia/Singapore',
  'Asia/Tokyo', 'Australia/Sydney',
];

export default function RefreshSettingsDrawer({ open, onClose, account, accountId }) {
  const schedule = useRefreshSchedule(accountId, { enabled: open });
  const latest = useLatestRefresh(accountId);
  const history = useRefreshHistory(accountId, { limit: 20, enabled: open });
  const capabilities = useRefreshCapabilities(accountId, { enabled: open });
  const save = useUpdateRefreshSchedule(accountId);
  const cancel = useCancelRefresh(accountId);

  const [form, setForm] = useState(null);
  const [errors, setErrors] = useState(null);
  const [saved, setSaved] = useState(false);

  // Seed from the server, and re-seed whenever the server's copy changes —
  // otherwise saving leaves the form showing what was typed rather than what
  // was actually stored, which is how a rejected field ends up looking saved.
  const serverUpdatedAt = schedule.data?.updated_at;
  useEffect(() => {
    if (!schedule.data) return;
    setForm({
      enabled: !!schedule.data.enabled,
      frequency_type: schedule.data.frequency_type || 'daily',
      interval_hours: schedule.data.interval_hours ?? 24,
      day_of_week: schedule.data.day_of_week ?? 0,
      time_of_day: schedule.data.time_of_day || '02:00',
      timezone: schedule.data.timezone || browserZone(),
    });
    setErrors(null);
  }, [schedule.data, serverUpdatedAt]);

  const options = schedule.data?.options;
  const scheduler = schedule.data?.scheduler;

  const zoneOptions = useMemo(() => {
    const zones = new Set(COMMON_ZONES);
    const b = browserZone();
    if (b) zones.add(b);
    if (form?.timezone) zones.add(form.timezone);
    return [...zones].sort().map((z) => ({ id: z, label: z }));
  }, [form?.timezone]);

  const set = (patch) => {
    setForm((f) => ({ ...f, ...patch }));
    setSaved(false);
  };

  const onSave = () => {
    setErrors(null);
    save.mutate(form, {
      onSuccess: () => { setSaved(true); setErrors(null); },
      onError: (err) => {
        const detail = err?.response?.data?.detail;
        // 422 carries per-field reasons. Showing them against their fields is
        // the difference between "invalid" and "an interval must be one of
        // 1, 2, 3, 6, 12, 24 or 48 hours".
        if (detail?.errors) setErrors(detail.errors);
        else setErrors({ _: detail?.message || detail || err?.message
          || 'The schedule could not be saved.' });
      },
    });
  };

  const current = latest.data?.current;
  const unsupported = (capabilities.data?.components || [])
    .filter((c) => !c.supported);

  return (
    <Drawer
      open={open}
      onClose={onClose}
      icon="refresh"
      title="Refresh settings"
      subtitle={account?.account_name
        ? `${account.account_name} · ${account.provider || ''}`.trim()
        : 'This cloud account'}
      width={480}
      footer={(
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-subtle">
            {saved ? 'Schedule saved.' : 'Changes apply from the next run.'}
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
            <Button
              variant="primary"
              size="sm"
              icon="save"
              loading={save.isPending}
              disabled={!form}
              onClick={onSave}
            >
              Save schedule
            </Button>
          </div>
        </div>
      )}
    >
      <div className="space-y-5">
        {/* ── Current run ─────────────────────────────────────────────── */}
        {current && (
          <div className="rounded-control border border-info bg-info-soft px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[12px] font-semibold text-fg">
                A refresh is running
              </span>
              <Button
                variant="danger-ghost"
                size="sm"
                icon="stop"
                loading={cancel.isPending}
                onClick={() => cancel.mutate(current.refresh_id)}
              >
                Cancel
              </Button>
            </div>
            <p className="mt-1 text-[11px] leading-snug text-muted">
              Started {relativeTime(current.started_at || current.created_at)}.
              Cancelling releases the account&apos;s lock; a provider request
              already in flight finishes on its own, because interrupting it
              would leave the inventory half-written.
            </p>
          </div>
        )}

        {/* ── Schedule ────────────────────────────────────────────────── */}
        <Section title="Automatic refresh" icon="clock">
          <Field
            label="Refresh this account automatically"
            hint={form?.enabled
              ? 'The backend scheduler runs it — it does not need this page open.'
              : 'Off. This account refreshes only when someone asks it to.'}
            inline
          >
            <Switch
              checked={!!form?.enabled}
              onChange={(v) => set({ enabled: v })}
              label="Automatic refresh"
            />
          </Field>

          {form?.enabled && (
            <div className="space-y-3 border-l-2 border-border pl-3">
              <Field label="Frequency">
                <Select
                  size="sm"
                  value={form.frequency_type}
                  onChange={(v) => set({ frequency_type: v })}
                  options={(options?.frequencies || []).map((f) => ({
                    id: f.value, label: f.label,
                  }))}
                />
                {errors?.frequency_type && <FieldError>{errors.frequency_type}</FieldError>}
              </Field>

              {form.frequency_type === 'interval' && (
                <Field label="Every" hint={options?.note}>
                  <Select
                    size="sm"
                    value={String(form.interval_hours)}
                    onChange={(v) => set({ interval_hours: Number(v) })}
                    options={(options?.interval_hours || []).map((h) => ({
                      id: String(h), label: h === 1 ? '1 hour' : `${h} hours`,
                    }))}
                  />
                  {errors?.interval_hours && <FieldError>{errors.interval_hours}</FieldError>}
                </Field>
              )}

              {form.frequency_type === 'weekly' && (
                <Field label="Day">
                  <Select
                    size="sm"
                    value={String(form.day_of_week)}
                    onChange={(v) => set({ day_of_week: Number(v) })}
                    options={(options?.days || []).map((d) => ({
                      id: String(d.value), label: d.label,
                    }))}
                  />
                  {errors?.day_of_week && <FieldError>{errors.day_of_week}</FieldError>}
                </Field>
              )}

              {form.frequency_type !== 'interval' && (
                <Field label="Time">
                  <Input
                    size="sm"
                    type="time"
                    value={form.time_of_day}
                    onChange={(e) => set({ time_of_day: e.target.value })}
                  />
                  {errors?.time_of_day && <FieldError>{errors.time_of_day}</FieldError>}
                </Field>
              )}

              <Field
                label="Timezone"
                hint="The time above is local to this zone, and stays correct across daylight saving changes."
              >
                <Select
                  size="sm"
                  value={form.timezone}
                  onChange={(v) => set({ timezone: v })}
                  options={zoneOptions}
                />
                {errors?.timezone && <FieldError>{errors.timezone}</FieldError>}
              </Field>
            </div>
          )}

          {errors?._ && <FieldError>{errors._}</FieldError>}

          <div className="rounded-control bg-sunken px-3 py-2 text-[11px] leading-snug">
            <div className="font-semibold text-fg">
              {schedule.data?.summary || 'Automatic refresh is off.'}
            </div>
            <div className="mt-1 space-y-0.5 text-muted">
              <div>
                Next run:
                {' '}
                {schedule.data?.next_run_at
                  ? `${formatDateTime(schedule.data.next_run_at)} (${relativeTime(schedule.data.next_run_at)})`
                  : 'not scheduled'}
              </div>
              <div>
                Last run:
                {' '}
                {schedule.data?.last_run_at
                  ? relativeTime(schedule.data.last_run_at) : 'never'}
              </div>
              <div>
                Last success:
                {' '}
                {schedule.data?.last_success_at
                  ? relativeTime(schedule.data.last_success_at) : 'never'}
              </div>
            </div>
            {/* If the scheduler process is not running, an enabled schedule is
                a promise nothing will keep. Say so rather than showing a
                confident "next run" that will pass unattended. */}
            {form?.enabled && scheduler && !scheduler.running && (
              <div className="mt-1.5 flex items-start gap-1.5 text-danger">
                <Icon name="alert" size={11} className="mt-0.5 shrink-0" />
                <span>
                  The refresh scheduler is not running on the server, so this
                  schedule will not fire until it is started.
                </span>
              </div>
            )}
          </div>
        </Section>

        {/* ── What a refresh covers ───────────────────────────────────── */}
        <Section title="What a refresh covers" icon="layers">
          <ul className="space-y-1 text-[11px] leading-snug text-muted">
            {(capabilities.data?.components || []).map((c) => (
              <li key={c.key} className="flex items-start gap-1.5">
                <Icon
                  name={c.supported ? 'check' : 'close'}
                  size={11}
                  className={cn('mt-0.5 shrink-0',
                    c.supported ? 'text-success-fg' : 'text-subtle')}
                />
                <span>
                  <span className="font-semibold text-fg">{c.label}</span>
                  {c.reason ? ` — ${c.reason}` : ''}
                </span>
              </li>
            ))}
          </ul>
          {capabilities.data?.note && (
            <p className="text-[11px] leading-snug text-subtle">
              {capabilities.data.note}
            </p>
          )}
          {unsupported.length > 0 && (
            <p className="text-[11px] leading-snug text-warning-fg">
              A refresh of this account will report
              {` ${unsupported.map((c) => c.label).join(' and ')} `}
              as skipped rather than leaving stale numbers looking current.
            </p>
          )}
        </Section>

        {/* ── History ─────────────────────────────────────────────────── */}
        <Section title="Refresh history" icon="history">
          {history.isLoading ? (
            <p className="text-[11px] text-subtle">Loading…</p>
          ) : !(history.data?.history || []).length ? (
            <p className="text-[11px] leading-snug text-subtle">
              This account has not been refreshed yet.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {history.data.history.map((run) => (
                <HistoryRow key={run.refresh_id} run={run} />
              ))}
            </ul>
          )}
        </Section>
      </div>
    </Drawer>
  );
}

function HistoryRow({ run }) {
  const [open, setOpen] = useState(false);
  const failed = Object.values(run.components || {})
    .filter((c) => c.status === 'FAILED');

  return (
    <li className="rounded-control border border-border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-sunken"
      >
        <Badge tone={STATUS_TONE[run.status] || 'neutral'} size="xs">
          {run.status}
        </Badge>
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted">
          {relativeTime(run.completed_at || run.started_at || run.created_at)}
          {run.trigger_type ? ` · ${TRIGGER_LABEL[run.trigger_type] || run.trigger_type}` : ''}
          {run.duration_ms != null ? ` · ${(run.duration_ms / 1000).toFixed(1)}s` : ''}
        </span>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} className="shrink-0 text-subtle" />
      </button>

      {open && (
        <div className="space-y-1.5 border-t border-border px-2.5 py-2 text-[11px] leading-snug">
          <div className="text-subtle">
            {run.started_at ? `Started ${formatDateTime(run.started_at)}` : 'Not started'}
            {run.triggered_by ? ` · by ${run.triggered_by}` : ''}
          </div>

          <ul className="space-y-0.5">
            {Object.entries(run.components || {}).map(([key, c]) => (
              <li key={key} className="flex items-start gap-1.5">
                <span className={cn('font-semibold', COMPONENT_TONE[c.status] || 'text-subtle')}>
                  {c.status}
                </span>
                <span className="text-muted">{c.label}</span>
                {c.detail && <span className="min-w-0 text-subtle">— {c.detail}</span>}
              </li>
            ))}
          </ul>

          {run.resources_found != null && (
            <div className="text-muted">
              {run.resources_found.toLocaleString()} resources recorded
            </div>
          )}

          {/* The failure reason, verbatim from the run record. A refresh the
              user cannot explain is a refresh they cannot fix. */}
          {run.error && (
            <div className="rounded-control border border-danger bg-danger-soft px-2 py-1 text-danger">
              {run.error}
            </div>
          )}
          {!run.error && failed.length > 0 && (
            <div className="text-warning-fg">
              {failed.map((c) => c.label).join(', ')} could not be refreshed.
              Previous data was kept.
            </div>
          )}
        </div>
      )}
    </li>
  );
}

const TRIGGER_LABEL = {
  MANUAL: 'Manual',
  SCHEDULED: 'Scheduled',
  TEST: 'Test',
  manual: 'Manual',
  scheduled: 'Scheduled',
  test: 'Test',
};

const FieldError = ({ children }) => (
  <p className="mt-1 text-[11px] leading-snug text-danger">{children}</p>
);

function browserZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
