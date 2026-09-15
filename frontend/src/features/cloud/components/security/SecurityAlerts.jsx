import { useState } from 'react';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Dialog from '@/components/ui/Dialog';
import Drawer from '@/components/ui/Drawer';
import Icon from '@/components/ui/Icon';
import Select from '@/components/ui/Select';
import Switch from '@/components/ui/Switch';
import Table, { EmptyState } from '@/components/ui/Table';
import Textarea from '@/components/ui/Textarea';
import Input from '@/components/ui/Input';
import { PageLoading } from '@/components/ui/Loading';
import CloudSection from '../CloudSection';
import { formatDateTime, severityTone } from '../../utils/securityModel';
import {
  useAlertAction, usePolicies, usePolicyMutation, useSecurityAlerts,
} from '../../hooks/useSecurityCenter';

const STATE_TONE = { OPEN: 'danger', ACKNOWLEDGED: 'warning', RESOLVED: 'success' };

// "Active" is the default: an acknowledged alert is still a live problem, so
// acknowledging must not make it vanish from the list you are working through.
const FILTERS = [
  { key: 'ACTIVE', label: 'Active', states: ['OPEN', 'ACKNOWLEDGED'] },
  { key: 'OPEN', label: 'Open', states: ['OPEN'] },
  { key: 'ACKNOWLEDGED', label: 'Acknowledged', states: ['ACKNOWLEDGED'] },
  { key: 'RESOLVED', label: 'Resolved', states: ['RESOLVED'] },
];

/**
 * The Alerts tab.
 *
 * Every alert here carries the fingerprint of the finding that produced it, so
 * Alert → Finding → Evidence works. That link is new: alerting used to be one
 * hard-coded storage rule evaluated during discovery, with no connection to
 * security findings at all — 82 CRITICAL findings on AWS and 68 on OCI produced
 * zero alerts, while the feed's 38 entries were all about idle disks.
 */
export default function SecurityAlerts({ accountId, onOpenFinding }) {
  const [filter, setFilter] = useState('ACTIVE');
  const [pending, setPending] = useState(null);   // { alert, action }
  const [reason, setReason] = useState('');
  const [err, setErr] = useState(null);
  const { data, isLoading } = useSecurityAlerts(accountId, true);
  const act = useAlertAction();

  const alerts = data?.alerts || [];
  const active = FILTERS.find((f) => f.key === filter)?.states ?? [];
  const visible = alerts.filter((a) => active.includes(a.state ?? 'OPEN'));
  const countFor = (states) => alerts.filter((a) => states.includes(a.state ?? 'OPEN')).length;

  const submit = async () => {
    setErr(null);
    try {
      await act.mutateAsync({
        alertId: pending.alert.id,
        action: pending.action,
        reason: reason.trim() || undefined,
      });
      setPending(null); setReason('');
    } catch (e) {
      setErr(e?.response?.data?.detail || e?.message || 'The action failed.');
    }
  };

  if (isLoading && !data) return <PageLoading title="Loading alerts…" minHeight={220} />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-1 text-[11px] font-bold uppercase tracking-wider text-subtle">
          State
        </span>
        {FILTERS.map((f) => {
          const n = countFor(f.states);
          const isActive = filter === f.key;
          return (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              disabled={n === 0 && !isActive}
              aria-pressed={isActive}
              className={`inline-flex items-center gap-1.5 rounded-control border px-3 py-1.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                isActive
                  ? 'border-accent bg-accent-soft text-accent-text'
                  : 'border-border bg-surface text-muted hover:text-fg'
              }`}
            >
              {f.label}
              <span className="rounded-full bg-neutral-soft px-1.5 text-[10px] text-muted">{n}</span>
            </button>
          );
        })}
      </div>

      {visible.length === 0 ? (
        <CloudSection>
          <EmptyState
            icon={filter === 'ACTIVE' ? 'shield-check' : 'bell'}
            title={filter === 'ACTIVE' ? 'No active alerts' : `No ${filter.toLowerCase()} alerts`}
            body={filter === 'ACTIVE'
              ? 'No finding has crossed an alert policy threshold. Check the Findings tab '
                + 'for open findings that no policy currently covers.'
              : 'Try the Active filter.'}
          />
        </CloudSection>
      ) : (
        <div className="space-y-3">
          {visible.map((a) => (
            <div key={a.id} className="card border-l-4 px-card py-3.5"
              style={{ borderLeftColor: a.severity === 'CRITICAL' ? 'var(--danger)'
                : a.severity === 'HIGH' ? 'var(--warning)' : 'var(--border)' }}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={severityTone(a.severity)}>{a.severity}</Badge>
                    <Badge tone={STATE_TONE[a.state] || 'neutral'}>{a.state}</Badge>
                    <span className="text-[14px] font-semibold text-fg">
                      {a.policy_name || a.anomaly_type}
                    </span>
                    {a.simulated && <Badge tone="outline" size="xs">simulated</Badge>}
                    {a.previous_severity && (
                      <Badge tone="warning" size="xs">
                        escalated from {a.previous_severity}
                      </Badge>
                    )}
                  </div>
                  <p className="mt-1.5 text-[13px] leading-relaxed text-muted">{a.details}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-subtle">
                    <span>First seen {formatDateTime(a.created_at)}</span>
                    <span>Last seen {formatDateTime(a.last_seen_at)}</span>
                    <span>{a.occurrence_count}× detected</span>
                    <span>{a.notification_count || 0}× notified</span>
                    {a.notification_status === 'no_channel' && (
                      // Worth surfacing: an alert that fired but reached nobody
                      // is indistinguishable from one that never fired, unless
                      // the feed says so.
                      <span className="text-warning-fg">no notification channel configured</span>
                    )}
                    {a.acknowledged_by && <span>acknowledged by {a.acknowledged_by}</span>}
                    {a.resolved_by && <span>resolved by {a.resolved_by}</span>}
                  </div>
                  {a.resolution_reason && (
                    <p className="mt-1 text-[11px] italic text-muted">{a.resolution_reason}</p>
                  )}
                </div>

                <div className="flex shrink-0 flex-wrap gap-2">
                  {a.finding_fingerprint && onOpenFinding && (
                    <Button size="sm" icon="external"
                      onClick={() => onOpenFinding(a.finding_fingerprint)}>
                      Finding
                    </Button>
                  )}
                  {a.state === 'OPEN' && (
                    <Button size="sm" icon="check"
                      onClick={() => { setPending({ alert: a, action: 'acknowledge' }); setReason(''); }}>
                      Acknowledge
                    </Button>
                  )}
                  {a.state !== 'RESOLVED' && (
                    <>
                      <Button size="sm" variant="subtle" icon="check"
                        onClick={() => { setPending({ alert: a, action: 'resolve' }); setReason(''); }}>
                        Resolve
                      </Button>
                      <Button size="sm" variant="ghost" icon="eye-off"
                        onClick={() => { setPending({ alert: a, action: 'suppress' }); setReason(''); }}>
                        Suppress
                      </Button>
                    </>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <Dialog
        open={!!pending}
        onClose={() => { setPending(null); setErr(null); }}
        title={pending ? `${pending.action[0].toUpperCase()}${pending.action.slice(1)} alert` : ''}
        footer={(
          <div className="flex justify-end gap-2">
            <Button onClick={() => { setPending(null); setErr(null); }}>Cancel</Button>
            <Button variant="primary" loading={act.isPending} onClick={submit}>
              Confirm
            </Button>
          </div>
        )}
      >
        {pending && (
          <div className="space-y-3 text-sm">
            <p className="text-fg">{pending.alert.policy_name || pending.alert.anomaly_type}</p>
            {pending.action === 'resolve' && (
              <p className="text-xs leading-relaxed text-muted">
                Resolving records that the condition was handled. The next assessment reopens
                it if the condition is still present — resolving an alert is not a way to make
                a finding go away.
              </p>
            )}
            {pending.action === 'suppress' && (
              <p className="text-xs leading-relaxed text-warning-fg">
                Suppressing acts on the underlying <strong>finding</strong>, not just this
                alert, so the next assessment does not recreate it. It stops counting toward
                the score. A reason is required.
              </p>
            )}
            <Textarea
              rows={3}
              placeholder={pending.action === 'suppress'
                ? 'Required — why is this being left in place?'
                : 'Optional note'}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            {err && <p className="text-[11px] text-danger">{err}</p>}
          </div>
        )}
      </Dialog>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   Alert policies
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * What turns a finding into an alert — configurable rather than hard-coded.
 *
 * Built-in policies can be disabled and retuned but not deleted: a deleted
 * built-in would silently reappear on the next boot, which is worse than
 * refusing. Disabling persists across deploys because the seeder deliberately
 * refreshes only a policy's definition, never the fields an operator tunes.
 */
export function SecurityPolicies({ accountId, canManage }) {
  const { data, isLoading } = usePolicies(accountId);
  const { create, update, remove } = usePolicyMutation();
  const [editing, setEditing] = useState(null);
  const [err, setErr] = useState(null);

  if (isLoading) return <PageLoading title="Loading alert policies…" minHeight={200} />;
  const policies = data?.policies || [];

  const toggle = (p) => update.mutate({ policyId: p.id, enabled: !p.enabled });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-xs leading-relaxed text-muted">
          A policy decides when a finding is worth interrupting someone. A finding answers
          &ldquo;what is wrong&rdquo;; an alert answers &ldquo;did that cross a threshold&rdquo;.
          Where several policies match one finding, the most specific one wins, so a
          world-open RDP port produces one alert rather than one per policy.
        </p>
        {canManage && (
          <Button variant="primary" icon="plus"
            onClick={() => { setEditing({}); setErr(null); }}>
            New policy
          </Button>
        )}
      </div>

      <Table
        columns={[
          { key: 'on', label: '', width: 60 },
          { key: 'name', label: 'Policy' },
          { key: 'matches', label: 'Matches' },
          { key: 'threshold', label: 'Threshold', width: 220 },
          { key: 'sev', label: 'Alert severity', width: 130 },
          { key: 'fired', label: 'Triggered', width: 150, align: 'right' },
        ]}
        rows={policies.map((p) => ({
          key: p.id,
          onClick: canManage ? () => { setEditing(p); setErr(null); } : undefined,
          cells: {
            on: (
              <Switch
                checked={p.enabled}
                disabled={!canManage || update.isPending}
                onChange={() => toggle(p)}
                label={`${p.enabled ? 'Disable' : 'Enable'} ${p.name}`}
              />
            ),
            name: (
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate-safe text-[13px] font-medium text-fg">{p.name}</span>
                  {p.builtin && <Badge tone="outline" size="xs">built-in</Badge>}
                  {!p.notify && <Badge tone="neutral" size="xs">record only</Badge>}
                </div>
                <div className="line-clamp-2 text-[11px] leading-relaxed text-subtle">
                  {p.description}
                </div>
              </div>
            ),
            matches: (
              <div className="flex flex-wrap gap-1">
                {(p.rule_ids || []).slice(0, 2).map((r) => (
                  <Badge key={r} tone="outline" size="xs">{r}</Badge>
                ))}
                {(p.rule_ids || []).length > 2 && (
                  <Badge tone="neutral" size="xs">+{p.rule_ids.length - 2} rules</Badge>
                )}
                {(p.categories || []).map((c) => (
                  <Badge key={c} tone="info" size="xs">{c}</Badge>
                ))}
                {p.min_severity && (
                  <Badge tone={severityTone(p.min_severity)} size="xs">
                    ≥ {p.min_severity}
                  </Badge>
                )}
                {(p.ports || []).length > 0 && (
                  <Badge tone="outline" size="xs">
                    {p.ports.length === 1 ? `port ${p.ports[0]}` : `${p.ports.length} ports`}
                  </Badge>
                )}
                {!p.rule_ids && !p.categories && !p.min_severity && !p.ports && (
                  <Badge tone="neutral" size="xs">any finding</Badge>
                )}
              </div>
            ),
            threshold: (
              <span className="text-[11px] text-muted">
                {p.threshold_label} ≥ {p.threshold_value}
              </span>
            ),
            sev: p.alert_severity
              ? <Badge tone={severityTone(p.alert_severity)}>{p.alert_severity}</Badge>
              : <span className="text-[11px] text-subtle">from finding</span>,
            fired: (
              <div className="text-right">
                <div className="text-[12px] text-fg">{p.trigger_count}×</div>
                <div className="text-[10px] text-subtle">
                  {p.last_triggered_at ? formatDateTime(p.last_triggered_at) : 'never'}
                </div>
              </div>
            ),
          },
          sort: { name: p.name, threshold: p.threshold_value, fired: p.trigger_count },
        }))}
        rowHeight={64}
        virtualize
        maxBodyHeight={560}
      />

      <PolicyDrawer
        policy={editing}
        meta={data}
        accountId={accountId}
        error={err}
        onError={setErr}
        onClose={() => { setEditing(null); setErr(null); }}
        onSave={async (payload) => {
          setErr(null);
          try {
            if (editing?.id) await update.mutateAsync({ policyId: editing.id, ...payload });
            else await create.mutateAsync(payload);
            setEditing(null);
          } catch (e) {
            setErr(e?.response?.data?.detail || e?.message || 'The policy could not be saved.');
          }
        }}
        onDelete={editing?.id && !editing.builtin ? async () => {
          setErr(null);
          try {
            await remove.mutateAsync(editing.id);
            setEditing(null);
          } catch (e) {
            setErr(e?.response?.data?.detail || 'The policy could not be deleted.');
          }
        } : undefined}
      />
    </div>
  );
}

function PolicyDrawer({ policy, meta, accountId, onClose, onSave, onDelete, error, onError }) {
  const [draft, setDraft] = useState(null);
  const open = !!policy;
  const current = draft ?? policy ?? {};

  if (!open) return null;
  const set = (patch) => setDraft({ ...current, ...patch });

  return (
    <Drawer
      open={open}
      onClose={() => { setDraft(null); onClose(); }}
      title={policy?.id ? 'Edit alert policy' : 'New alert policy'}
      subtitle={policy?.builtin
        ? 'Built-in policy — its matching rules are fixed, but you can retune and disable it.'
        : undefined}
      width={560}
      footer={(
        <div className="flex items-center justify-between gap-2">
          {onDelete
            ? <Button variant="danger-ghost" icon="trash" onClick={onDelete}>Delete</Button>
            : <span />}
          <div className="flex gap-2">
            <Button onClick={() => { setDraft(null); onClose(); }}>Cancel</Button>
            <Button variant="primary" onClick={() => onSave(cleanPolicy(current, accountId))}>
              Save
            </Button>
          </div>
        </div>
      )}
    >
      <div className="space-y-4 text-sm">
        {policy?.builtin && (
          <div className="rounded-control border border-info-soft bg-info-soft p-3 text-xs text-info-fg">
            Built-in policies cannot be deleted — they are re-seeded on every startup, so a
            deletion would silently come back. Disable it instead; that persists.
          </div>
        )}

        <Labeled label="Name">
          <Input value={current.name || ''}
            onChange={(e) => set({ name: e.target.value })} />
        </Labeled>

        <Labeled label="Description">
          <Textarea rows={2} value={current.description || ''}
            onChange={(e) => set({ description: e.target.value })} />
        </Labeled>

        <Labeled label="Enabled">
          <Switch checked={current.enabled !== false}
            onChange={(v) => set({ enabled: v })} label="Enabled" />
        </Labeled>

        <Labeled label="Threshold">
          <div className="flex gap-2">
            <Select
              value={current.threshold_kind || 'any_new'}
              onChange={(v) => set({ threshold_kind: v })}
              options={(meta?.threshold_kinds || []).map((t) => ({
                id: t.value, label: t.label,
              }))}
            />
            <Input
              type="number"
              value={current.threshold_value ?? 1}
              onChange={(e) => set({ threshold_value: Number(e.target.value) })}
              wrapperClassName="w-24"
            />
          </div>
        </Labeled>

        <Labeled label="Minimum severity">
          <Select
            value={current.min_severity || ''}
            onChange={(v) => set({ min_severity: v || null })}
            options={[
              { id: '', label: 'Any severity' },
              ...(meta?.selectable?.severities || []).map((s) => ({ id: s, label: s })),
            ]}
          />
        </Labeled>

        <Labeled label="Alert severity">
          <Select
            value={current.alert_severity || ''}
            onChange={(v) => set({ alert_severity: v || null })}
            options={[
              { id: '', label: "Use the finding's own severity" },
              ...(meta?.selectable?.severities || []).map((s) => ({ id: s, label: s })),
            ]}
          />
        </Labeled>

        <Labeled label="Category">
          <Select
            value={(current.categories || [])[0] || ''}
            onChange={(v) => set({ categories: v ? [v] : null })}
            options={[
              { id: '', label: 'Any category' },
              ...(meta?.selectable?.categories || []).map((c) => ({ id: c, label: c })),
            ]}
          />
        </Labeled>

        <Labeled label="Notification cooldown (minutes)">
          <Input
            type="number"
            value={current.cooldown_minutes ?? 60}
            onChange={(e) => set({ cooldown_minutes: Number(e.target.value) })}
          />
          <p className="mt-1 text-[11px] leading-relaxed text-subtle">
            A persisting condition is re-notified at most this often. Without a cooldown, a
            problem seen on every scan notifies on every scan.
          </p>
        </Labeled>

        <Labeled label="Send notifications">
          <Switch checked={current.notify !== false}
            onChange={(v) => set({ notify: v })} label="Send notifications" />
          <p className="mt-1 text-[11px] leading-relaxed text-subtle">
            Off records the alert in the feed without routing it to a channel.
          </p>
        </Labeled>

        {error && (
          <div className="rounded-control border border-danger-soft bg-danger-soft p-2.5 text-xs text-danger-fg">
            {error}
          </div>
        )}
      </div>
    </Drawer>
  );
}

function Labeled({ label, children }) {
  return (
    <div>
      <div className="mb-1 text-[11px] font-bold uppercase tracking-wider text-muted">{label}</div>
      {children}
    </div>
  );
}

/** Only send the fields a user can actually edit here — posting the whole row
 *  back would let a stale `trigger_count` or `builtin` flag overwrite the
 *  server's. */
function cleanPolicy(p, accountId) {
  const out = {
    name: p.name, description: p.description, enabled: p.enabled !== false,
    threshold_kind: p.threshold_kind || 'any_new',
    threshold_value: p.threshold_value ?? 1,
    min_severity: p.min_severity || undefined,
    alert_severity: p.alert_severity || undefined,
    categories: p.categories?.length ? p.categories : undefined,
    rule_ids: p.rule_ids?.length ? p.rule_ids : undefined,
    ports: p.ports?.length ? p.ports : undefined,
    cooldown_minutes: p.cooldown_minutes ?? 60,
    notify: p.notify !== false,
  };
  if (!p.id && accountId) out.account_id = accountId;
  return out;
}
