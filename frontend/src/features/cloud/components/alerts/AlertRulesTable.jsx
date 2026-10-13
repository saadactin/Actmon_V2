import { useState } from 'react';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import Icon from '@/components/ui/Icon';
import Input from '@/components/ui/Input';
import Select from '@/components/ui/Select';
import Switch from '@/components/ui/Switch';
import Table, { EmptyState } from '@/components/ui/Table';
import {
  Count, ResultBadge, SeverityBadge, When, categoryMeta, humanDuration,
  resultMeta,
} from './AlertPrimitives';

/**
 * The rule list.
 *
 * Three columns exist here that a simpler table would leave out, and each earns
 * its space:
 *
 *   Last result — the full six-state answer, not "OK / firing", so a rule that
 *   has never managed to read its data source is visibly different from one
 *   quietly reporting that everything is fine.
 *
 *   Observed — the actual measured value, or NA. A rule with a threshold of 0
 *   and an observed value of NA is a rule that can never fire, and nothing else
 *   on the page would reveal that.
 *
 *   Notifications — who this rule would actually reach. A rule that records
 *   alerts and emails nobody is a legitimate configuration and a very common
 *   accident, and the two are indistinguishable unless the list says.
 */

const SEVERITY_OPTIONS = [
  { id: '', label: 'Any severity' },
  { id: 'CRITICAL', label: 'Critical' },
  { id: 'HIGH', label: 'High' },
  { id: 'MEDIUM', label: 'Medium' },
  { id: 'LOW', label: 'Low' },
  { id: 'INFO', label: 'Info' },
];

const STATUS_OPTIONS = [
  { id: '', label: 'Enabled and disabled' },
  { id: 'true', label: 'Enabled only' },
  { id: 'false', label: 'Disabled only' },
];

const NOTIFY_OPTIONS = [
  { id: '', label: 'Any notification setup' },
  { id: 'true', label: 'Reaches someone' },
  { id: 'false', label: 'Emails nobody' },
];

const SILENCE_CHOICES = [
  { id: '3600', label: '1 hour' },
  { id: '21600', label: '6 hours' },
  { id: '86400', label: '24 hours' },
  { id: '604800', label: '7 days' },
];

export default function AlertRulesTable({
  rules = [], facets, loading, canManage, canTest, canTriage,
  filters = {}, onFilters,
  onCreate, onTemplates, onEdit, onToggle, onDelete, onDuplicate, onSilence,
  onTest, testing, testResult, onClearTest, onViewHistory,
}) {
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [silencing, setSilencing] = useState(null);
  const [silenceSeconds, setSilenceSeconds] = useState('3600');
  const [silenceReason, setSilenceReason] = useState('');
  const [search, setSearch] = useState(filters.q || '');

  const hasFilters = !!(filters.q || filters.category || filters.severity
    || filters.enabled || filters.notifies);

  const categoryOptions = [
    { id: '', label: 'Every category' },
    ...(facets?.categories || []).map((c) => ({
      id: c.value, label: `${categoryMeta(c.value).label} (${c.count})`,
    })),
  ];

  const columns = [
    { key: 'name', label: 'Rule', width: '22%' },
    { key: 'condition', label: 'Trigger', width: '24%' },
    { key: 'scope', label: 'Scope', width: 120 },
    { key: 'severity', label: 'Severity', width: 90 },
    { key: 'result', label: 'Last result', width: 140 },
    { key: 'observed', label: 'Observed', align: 'right', width: 100 },
    { key: 'notifications', label: 'Notifications', width: 130 },
    { key: 'triggered', label: 'Last triggered', width: 110 },
    { key: 'status', label: 'Status', align: 'center', width: 96 },
    { key: 'actions', label: '', align: 'right', width: 150 },
  ];

  const rows = rules.map((r) => {
    const cat = categoryMeta(r.category);
    const meta = resultMeta(r.last_result);
    const scope = r.scope_config || {};
    const scopeBits = Object.entries(scope).filter(([, v]) => v);
    const notify = r.notification_config || {};
    const own = notify.recipients || [];
    const reaches = own.length > 0 || notify.use_account_defaults !== false;

    return {
      key: r.id,
      cells: {
        name: (
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <Icon name={cat.icon} size={13} className="shrink-0 text-subtle" />
              <span className="truncate font-semibold text-fg">{r.name}</span>
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-1 text-meta text-muted">
              <span>{cat.label}</span>
              {r.is_silenced && (
                <Badge tone="warning" size="sm" title={r.silence_reason || undefined}>
                  Silenced
                </Badge>
              )}
              {(r.min_duration_seconds > 0 || r.consecutive_breaches_required > 1) && (
                <Badge
                  tone="neutral"
                  size="sm"
                  title={[
                    r.consecutive_breaches_required > 1
                      && `${r.consecutive_breaches_required} consecutive evaluations`,
                    r.min_duration_seconds > 0
                      && `sustained for ${humanDuration(r.min_duration_seconds)}`,
                  ].filter(Boolean).join(' and ')}
                >
                  Held
                </Badge>
              )}
            </div>
          </div>
        ),
        // The generated sentence, not raw JSON. Produced from the same config
        // the evaluator reads, so the two cannot disagree.
        condition: (
          <span className="block text-[12px] leading-snug text-muted">
            {r.condition_human || '—'}
          </span>
        ),
        scope: (
          <span className="block text-meta leading-snug text-muted">
            {scopeBits.length
              ? scopeBits.map(([k, v]) => `${k}: ${v}`).join(', ')
              : <span className="text-subtle">Whole account</span>}
          </span>
        ),
        severity: <SeverityBadge severity={r.severity} />,
        result: (
          <div className="min-w-0">
            <ResultBadge state={r.last_result} />
            <div className="mt-0.5 text-micro text-subtle">
              <When iso={r.last_evaluated_at} never="Not evaluated yet" />
            </div>
          </div>
        ),
        observed: (
          <div className="text-right">
            <div className="text-[12px] font-semibold tabular-nums text-fg">
              {r.last_observed_value ?? (
                <span className="text-subtle" title={meta.help}>NA</span>
              )}
            </div>
            {r.trigger_count > 0 && (
              <div className="text-micro text-subtle">
                fired <Count value={r.trigger_count} />×
              </div>
            )}
          </div>
        ),
        notifications: (
          <div className="text-meta leading-snug">
            {r.is_silenced ? (
              <span className="text-warning-fg">
                Suppressed until <When iso={r.silenced_until} />
              </span>
            ) : reaches ? (
              <span className="text-muted">
                {own.length
                  ? `${own.length} on this rule`
                  : 'Account defaults'}
                {notify.use_account_defaults !== false && own.length
                  ? ' + defaults' : ''}
              </span>
            ) : (
              <span className="text-warning-fg" title="This rule records alerts but emails nobody.">
                Emails nobody
              </span>
            )}
          </div>
        ),
        triggered: (
          <span className="text-meta text-muted">
            <When iso={r.last_triggered_at} never="Never" />
          </span>
        ),
        status: (
          <div className="flex justify-center">
            <Switch
              checked={!!r.enabled}
              disabled={!canManage}
              size="sm"
              onChange={(next) => onToggle?.(r.id, next)}
            />
          </div>
        ),
        actions: (
          <div className="flex justify-end gap-0.5">
            {canTest && (
              <Button
                size="sm" variant="ghost" icon="play"
                loading={testing === r.id}
                onClick={() => onTest?.(r.id)}
                title="Evaluate now against live data. Creates no alert and sends no email."
              />
            )}
            <Button size="sm" variant="ghost" icon="history"
                    onClick={() => onViewHistory?.(r.id)}
                    title="View this rule's alert history" />
            {canTriage && (
              <Button
                size="sm"
                variant="ghost"
                icon={r.is_silenced ? 'bell' : 'ban'}
                onClick={() => (r.is_silenced
                  ? onSilence?.({ ruleId: r.id, silence: false })
                  : setSilencing(r))}
                title={r.is_silenced
                  ? 'Unsilence — start emailing again'
                  : 'Silence: stop the email, keep watching'}
              />
            )}
            {canManage && (
              <>
                <Button size="sm" variant="ghost" icon="copy"
                        onClick={() => onDuplicate?.(r.id)}
                        title="Duplicate (created disabled)" />
                <Button size="sm" variant="ghost" icon="settings"
                        onClick={() => onEdit?.(r)} title="Edit rule" />
                <Button size="sm" variant="danger-ghost" icon="trash"
                        onClick={() => setConfirmDelete(r)} title="Delete rule" />
              </>
            )}
          </div>
        ),
      },
      tone: r.enabled ? undefined : 'muted',
    };
  });

  return (
    <>
      {/* ── Filters ─────────────────────────────────────────────────── */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input
          icon="search"
          size="sm"
          placeholder="Search rules…"
          value={search}
          wrapperClassName="w-52"
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && onFilters?.({ ...filters, q: search })}
          onClear={() => { setSearch(''); onFilters?.({ ...filters, q: '' }); }}
        />
        <Select size="sm" width="auto" value={filters.category || ''}
                options={categoryOptions}
                onChange={(v) => onFilters?.({ ...filters, category: v })} />
        <Select size="sm" width="auto" value={filters.severity || ''}
                options={SEVERITY_OPTIONS}
                onChange={(v) => onFilters?.({ ...filters, severity: v })} />
        <Select size="sm" width="auto" value={filters.enabled || ''}
                options={STATUS_OPTIONS}
                onChange={(v) => onFilters?.({ ...filters, enabled: v })} />
        <Select size="sm" width="auto" value={filters.notifies || ''}
                options={NOTIFY_OPTIONS}
                onChange={(v) => onFilters?.({ ...filters, notifies: v })} />
        {hasFilters && (
          <Button size="sm" variant="ghost" icon="close"
                  onClick={() => { setSearch(''); onFilters?.({}); }}>
            Clear
          </Button>
        )}
      </div>

      {/* The test result sits above the table rather than in a modal: it is a
          measurement, and the operator wants it beside the row it came from. */}
      {testResult && (
        <div className="mb-3 rounded-control border border-border bg-sunken p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <ResultBadge state={testResult.result} />
                <span className="text-[12px] font-semibold text-fg">
                  {testResult.would_trigger
                    ? 'This rule would fire right now'
                    : 'This rule would not fire right now'}
                </span>
              </div>
              <p className="mt-1 text-[12px] text-muted">{testResult.condition}</p>
              <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-[12px]">
                <div className="flex gap-2">
                  <dt className="text-muted">Observed</dt>
                  <dd className="font-semibold text-fg">
                    {testResult.explain?.observed_label ?? 'NA'}
                  </dd>
                </div>
                <div className="flex gap-2">
                  <dt className="text-muted">Threshold</dt>
                  <dd className="font-semibold text-fg">
                    {testResult.explain?.threshold_label ?? 'NA'}
                  </dd>
                </div>
                <div className="flex gap-2">
                  <dt className="text-muted">Took</dt>
                  <dd className="font-semibold text-fg">{testResult.duration_ms} ms</dd>
                </div>
              </dl>
              {testResult.explain?.detail && (
                <p className="mt-2 text-meta leading-snug text-muted">
                  {testResult.explain.detail}
                </p>
              )}
              <p className="mt-2 text-meta text-subtle">{testResult.note}</p>
            </div>
            <Button size="sm" variant="ghost" icon="close" onClick={onClearTest} />
          </div>
        </div>
      )}

      <Table
        columns={columns}
        rows={rows}
        loading={loading}
        empty={(
          <EmptyState
            icon="bell"
            title={hasFilters ? 'No rule matches these filters' : 'No alert rules yet'}
            body={hasFilters
              ? 'Clear the filters to see every rule on this account.'
              : canManage
                ? 'Nothing is being watched on this account. Start from a template, or create a rule to be told when a condition you care about becomes true.'
                : 'Nothing is being watched on this account, and your role cannot create rules.'}
            action={hasFilters ? (
              <Button variant="secondary" icon="close"
                      onClick={() => { setSearch(''); onFilters?.({}); }}>
                Clear filters
              </Button>
            ) : canManage ? (
              <div className="flex flex-wrap justify-center gap-2">
                <Button variant="primary" icon="plus" onClick={onCreate}>
                  Create alert
                </Button>
                <Button variant="secondary" icon="bookmark" onClick={onTemplates}>
                  Browse templates
                </Button>
              </div>
            ) : undefined}
          />
        )}
      />

      <ConfirmDialog
        open={!!confirmDelete}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => { onDelete?.(confirmDelete.id); setConfirmDelete(null); }}
        tone="danger"
        title="Delete alert rule?"
        confirmLabel="Delete rule"
        cancelLabel="Keep rule"
      >
        <p className="text-[13px] text-fg">
          <strong>{confirmDelete?.name}</strong> will stop being evaluated.
        </p>
        <p className="mt-2 text-[12px] leading-snug text-muted">
          Alerts this rule has already raised are kept and stay searchable in
          Alert history, labelled with the deleted rule&rsquo;s name. Nothing in
          the history is removed.
        </p>
      </ConfirmDialog>

      <ConfirmDialog
        open={!!silencing}
        onCancel={() => { setSilencing(null); setSilenceReason(''); }}
        onConfirm={() => {
          onSilence?.({
            ruleId: silencing.id,
            seconds: Number(silenceSeconds),
            reason: silenceReason.trim() || undefined,
            silence: true,
          });
          setSilencing(null);
          setSilenceReason('');
        }}
        tone="warning"
        icon="ban"
        title="Silence this rule?"
        confirmLabel="Silence"
        cancelLabel="Cancel"
      >
        <p className="text-[13px] text-fg">
          <strong>{silencing?.name}</strong> will stop sending email.
        </p>
        <p className="mt-2 text-[12px] leading-snug text-muted">
          It keeps evaluating, and alerts still open and resolve — so this tab
          stays truthful about what is wrong. Only the notification is
          suppressed. Use <strong>Disable</strong> instead if you want it to stop
          watching altogether.
        </p>
        <div className="mt-3 space-y-2">
          <label className="block">
            <span className="mb-1 block text-meta font-semibold text-fg">For</span>
            <Select size="sm" value={silenceSeconds} options={SILENCE_CHOICES}
                    onChange={setSilenceSeconds} />
          </label>
          <label className="block">
            <span className="mb-1 block text-meta font-semibold text-fg">
              Reason <span className="font-normal text-subtle">(optional)</span>
            </span>
            <Input size="sm" placeholder="Planned maintenance"
                   value={silenceReason}
                   onChange={(e) => setSilenceReason(e.target.value)} />
          </label>
        </div>
      </ConfirmDialog>
    </>
  );
}
