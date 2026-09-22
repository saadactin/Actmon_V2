import { useEffect, useState } from 'react';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import Icon from '@/components/ui/Icon';
import Input from '@/components/ui/Input';
import Select from '@/components/ui/Select';
import Switch from '@/components/ui/Switch';
import { Count, When } from './AlertPrimitives';

/**
 * Retention and display settings.
 *
 * Two things this panel is deliberately loud about.
 *
 * **Pruning is off by default and deletion cannot be undone**, so the destructive
 * button is never the primary one and always shows a dry-run count first. The
 * user sees exactly how many rows would go before anything goes.
 *
 * **Open and acknowledged alerts are never pruned, at any age.** That is enforced
 * server-side, but it is stated here too, because "180 day retention" reads as
 * "my six-month-old unresolved incident will vanish" unless something says
 * otherwise.
 *
 * The scope line matters as well: this is installation-wide, not per account.
 * A per-account settings page that silently changes every account is a trap.
 */

const TIMEZONES = [
  { id: 'Asia/Kolkata', label: 'Asia/Kolkata (IST)' },
  { id: 'UTC', label: 'UTC' },
  { id: 'Europe/London', label: 'Europe/London' },
  { id: 'America/New_York', label: 'America/New_York' },
  { id: 'Asia/Singapore', label: 'Asia/Singapore' },
  { id: 'Australia/Sydney', label: 'Australia/Sydney' },
];

const FIELDS = [
  {
    key: 'alert_retention_days',
    label: 'Keep resolved alerts for',
    help: 'Open and acknowledged alerts are never removed, however old they are.',
  },
  {
    key: 'activity_retention_days',
    label: 'Keep the audit trail for',
    help: 'Rule changes, triggers, resolutions and every notification attempt.',
  },
  {
    key: 'notification_payload_days',
    label: 'Keep rendered email bodies for',
    help: 'After this, the message body is discarded but the delivery record — '
      + 'who it went to and whether it arrived — is kept.',
  },
];

export default function AlertSettingsPanel({
  data, loading, error, canManage,
  onSave, saving, saveError,
  onPrune, pruning, pruneResult,
}) {
  const [draft, setDraft] = useState({});
  const [confirmPrune, setConfirmPrune] = useState(false);

  useEffect(() => {
    if (!data) return;
    setDraft({
      alert_retention_days: data.alert_retention_days,
      activity_retention_days: data.activity_retention_days,
      notification_payload_days: data.notification_payload_days,
      pruning_enabled: data.pruning_enabled,
      display_timezone: data.display_timezone,
      quiet_hours_enabled: data.quiet_hours_enabled,
      quiet_hours_start: data.quiet_hours_start,
      quiet_hours_end: data.quiet_hours_end,
      quiet_hours_critical_bypass: data.quiet_hours_critical_bypass,
    });
  }, [data]);

  if (loading) {
    return (
      <div className="space-y-2">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-20 animate-pulse rounded-control bg-sunken" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <p className="rounded-control border border-dashed border-border px-4 py-6 text-[12px] text-muted">
        Alert settings could not be loaded.{' '}
        {error?.response?.data?.detail || error?.message || ''}
      </p>
    );
  }

  const dirty = data && Object.keys(draft).some((k) => draft[k] !== data[k]);
  const would = data?.preview?.would_remove || pruneResult?.would_remove;
  const errors = saveError?.response?.data?.detail?.errors || {};

  return (
    <div className="space-y-4">
      <section className="card p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="flex items-center gap-2 text-[13px] font-bold text-fg">
              <Icon name="clock" size={15} className="text-accent-text" />
              Retention
            </h3>
            <p className="mt-0.5 text-[11px] leading-snug text-muted">
              {data?.scope}
            </p>
          </div>
          <Badge tone={data?.pruning_enabled ? 'success' : 'neutral'} size="sm">
            {data?.pruning_enabled ? 'Pruning on' : 'Pruning off'}
          </Badge>
        </div>

        <p className="mt-3 flex gap-2 rounded-control border border-border bg-sunken px-3 py-2 text-[11px] leading-snug text-muted">
          <Icon name="info" size={13} className="mt-0.5 shrink-0 text-subtle" />
          <span>{data?.note}</span>
        </p>

        <div className="mt-3 space-y-3">
          {FIELDS.map((f) => (
            <label key={f.key} className="block">
              <span className="mb-1 block text-[12px] font-semibold text-fg">
                {f.label}
              </span>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  size="sm"
                  min={1}
                  max={3650}
                  disabled={!canManage}
                  wrapperClassName="w-28"
                  value={draft[f.key] ?? ''}
                  onChange={(e) => setDraft((d) => ({
                    ...d, [f.key]: e.target.value === '' ? '' : Number(e.target.value),
                  }))}
                />
                <span className="text-[12px] text-muted">days</span>
              </div>
              <span className="mt-1 block text-[11px] leading-snug text-subtle">
                {f.help}
              </span>
              {errors[f.key] && (
                <span className="mt-1 block text-[11px] text-danger">{errors[f.key]}</span>
              )}
            </label>
          ))}

          <div className="rounded-control border border-border p-3">
            <Switch
              checked={!!draft.pruning_enabled}
              disabled={!canManage}
              onChange={(v) => setDraft((d) => ({ ...d, pruning_enabled: v }))}
              label="Delete data that has passed its retention period"
            />
            <p className="mt-1.5 text-[11px] leading-snug text-subtle">
              Off by default. While this is off nothing is ever deleted and the
              figures below are only a projection. Deletion cannot be undone.
            </p>
          </div>
        </div>
      </section>

      <section className="card p-4">
        <h3 className="flex items-center gap-2 text-[13px] font-bold text-fg">
          <Icon name="globe" size={15} className="text-accent-text" />
          Email timestamps
        </h3>
        <p className="mt-0.5 text-[11px] leading-snug text-muted">
          Everything is stored in UTC. This is only how times are rendered in
          alert email, which has no browser to ask — the Alerts tab itself uses
          your own browser&rsquo;s timezone.
        </p>
        <div className="mt-3 max-w-xs">
          <Select
            size="sm"
            value={draft.display_timezone || 'Asia/Kolkata'}
            disabled={!canManage}
            options={TIMEZONES}
            onChange={(v) => setDraft((d) => ({ ...d, display_timezone: v }))}
          />
          {errors.display_timezone && (
            <span className="mt-1 block text-[11px] text-danger">
              {errors.display_timezone}
            </span>
          )}
        </div>
        <p className="mt-2 text-[11px] text-subtle">
          Emails read, for example, <code className="text-fg">17 Sep 2026, 10:42 IST</code>
          {' '}— the zone is always named.
        </p>
      </section>

      <section className="card p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="flex items-center gap-2 text-[13px] font-bold text-fg">
              <Icon name="moon" size={15} className="text-accent-text" />
              Quiet hours
            </h3>
            <p className="mt-0.5 text-[11px] leading-snug text-muted">
              Hold non-critical email until morning. Alerts still open, still
              appear here and still count as active — only the mail waits.
            </p>
          </div>
          <Badge tone={data?.quiet_hours_enabled ? 'info' : 'neutral'} size="sm">
            {data?.quiet_hours_enabled ? 'On' : 'Off'}
          </Badge>
        </div>

        <div className="mt-3 space-y-3">
          <Switch
            checked={!!draft.quiet_hours_enabled}
            disabled={!canManage}
            onChange={(v) => setDraft((d) => ({ ...d, quiet_hours_enabled: v }))}
            label="Hold non-critical email overnight"
          />

          <div className="flex flex-wrap items-end gap-3">
            {[['quiet_hours_start', 'From'], ['quiet_hours_end', 'Until']].map(
              ([key, label]) => (
                <label key={key} className="block">
                  <span className="mb-1 block text-[11px] font-semibold text-fg">
                    {label}
                  </span>
                  <Input
                    type="time"
                    size="sm"
                    wrapperClassName="w-32"
                    disabled={!canManage || !draft.quiet_hours_enabled}
                    value={draft[key] || ''}
                    onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
                  />
                  {errors[key] && (
                    <span className="mt-1 block text-[11px] text-danger">
                      {errors[key]}
                    </span>
                  )}
                </label>
              ),
            )}
            <span className="pb-2 text-[11px] text-subtle">
              in {draft.display_timezone || 'Asia/Kolkata'}
            </span>
          </div>

          <div className="rounded-control border border-border p-3">
            <Switch
              checked={draft.quiet_hours_critical_bypass !== false}
              disabled={!canManage || !draft.quiet_hours_enabled}
              onChange={(v) => setDraft((d) => ({
                ...d, quiet_hours_critical_bypass: v,
              }))}
              label="Critical alerts ignore quiet hours"
            />
            {/* Stated rather than left to the switch label, because turning
                this off is the one setting here that can lose an incident. */}
            <p className="mt-1.5 text-[11px] leading-snug text-subtle">
              {draft.quiet_hours_critical_bypass === false
                ? 'Critical alerts will also be held until morning. A 3am '
                  + 'critical you were not told about is usually worse than '
                  + 'one you were.'
                : 'Recommended. A critical alert is sent whatever the hour; '
                  + 'everything else waits.'}
            </p>
          </div>
        </div>
      </section>

      <section className="card p-4">
        <h3 className="flex items-center gap-2 text-[13px] font-bold text-fg">
          <Icon name="trash" size={15} className="text-accent-text" />
          What would be removed right now
        </h3>

        {would ? (
          <dl className="mt-3 grid gap-x-8 gap-y-1.5 sm:grid-cols-2">
            {[
              ['Resolved alerts past retention', would.resolved_alerts],
              ['Abandoned held breaches', would.abandoned_pending],
              ['Audit rows past retention', would.activity_rows],
              ['Email bodies to strip', would.notification_payloads],
            ].map(([label, value]) => (
              <div key={label} className="flex items-center justify-between gap-3 text-[12px]">
                <dt className="text-muted">{label}</dt>
                <dd className="font-semibold tabular-nums text-fg">
                  {/* NA rather than 0 when the count could not be taken — the
                      notification queue lives in another service's tables. */}
                  <Count value={value} />
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="mt-3 text-[12px] text-muted">
            No projection available.
          </p>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" icon="refresh"
                  loading={pruning} onClick={() => onPrune?.(true)}>
            Recalculate
          </Button>
          {canManage && (
            <Button
              size="sm"
              variant="danger"
              icon="trash"
              disabled={!data?.pruning_enabled}
              onClick={() => setConfirmPrune(true)}
              title={data?.pruning_enabled
                ? undefined
                : 'Enable pruning above before anything can be deleted.'}
            >
              Delete now
            </Button>
          )}
          {data?.last_pruned_at && (
            <span className="text-[11px] text-subtle">
              Last run <When iso={data.last_pruned_at} />
            </span>
          )}
        </div>
      </section>

      {canManage && (
        <div className="flex items-center justify-end gap-2">
          {dirty && (
            <span className="text-[11px] text-muted">Unsaved changes</span>
          )}
          <Button
            variant="primary"
            icon="save"
            loading={saving}
            disabled={!dirty}
            onClick={() => onSave?.(draft)}
          >
            Save settings
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={confirmPrune}
        onCancel={() => setConfirmPrune(false)}
        onConfirm={() => { setConfirmPrune(false); onPrune?.(false); }}
        tone="danger"
        title="Delete data past its retention period?"
        confirmLabel="Delete permanently"
        cancelLabel="Cancel"
      >
        <p className="text-[13px] text-fg">
          This cannot be undone.
        </p>
        <ul className="mt-2 space-y-0.5 text-[12px] text-muted">
          <li>{would?.resolved_alerts ?? 0} resolved alert(s)</li>
          <li>{would?.activity_rows ?? 0} audit row(s)</li>
          <li>{would?.abandoned_pending ?? 0} abandoned held breach(es)</li>
        </ul>
        <p className="mt-2 text-[12px] leading-snug text-muted">
          Open and acknowledged alerts are not affected, whatever their age.
        </p>
      </ConfirmDialog>
    </div>
  );
}
