import { useMemo, useState } from 'react';
import cn from '@/lib/cn';
import Icon from '@/components/ui/Icon';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import Select from '@/components/ui/Select';
import Switch from '@/components/ui/Switch';
import Badge from '@/components/ui/Badge';
import Dialog from '@/components/ui/Dialog';
import Table, { EmptyState, nextSort, sortRows } from '@/components/ui/Table';
import { severityOf, StatusKey } from '@/components/charts/status';
import {
  EVALUATION, SECTIONS, describeCondition, describeScope, metricOf, sectionMeta, sectionOf,
} from '@/config/alertCatalog';
import { duration } from '@/lib/format';
import RuleEditor from './RuleEditor';

const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 };

/**
 * Rule management — section-driven, matching the existing module.
 *
 * A section is chosen first and everything below it belongs to that section only:
 * the rules listed, the search, and the metrics offered when creating a new one.
 * That keeps a 34-metric catalogue navigable, and it means "New rule" already
 * knows roughly what you're building.
 *
 * `enabled` is an inline switch because it's the single lever that decides what
 * fires, and disabled rules stay listed (dimmed) rather than disappearing —
 * "why am I not getting this alert" is the question this tab has to answer.
 */
export default function AlertRules({ rules: api }) {
  const { rules, isLoading, isFetching, saveRule, isSaving, toggleRule, deleteRule } = api;

  const [section, setSection] = useState('infrastructure');
  const [search, setSearch] = useState('');
  const [severity, setSeverity] = useState('all');
  const [state, setState] = useState('all');
  const [sort, setSort] = useState({ key: 'severity', dir: 'asc' });
  const [editing, setEditing] = useState(null); // null = closed, {} = new
  const [confirmDelete, setConfirmDelete] = useState(null);

  const meta = sectionMeta(section);

  /** Rule counts per section, so the picker shows where the rules actually are. */
  const counts = useMemo(() => {
    const acc = {};
    for (const r of rules) {
      const id = sectionOf(r.metric);
      acc[id] = (acc[id] || 0) + 1;
    }
    return acc;
  }, [rules]);

  const sectionRules = useMemo(
    () => rules.filter((r) => sectionOf(r.metric) === section),
    [rules, section],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return sectionRules.filter((r) => {
      if (severity !== 'all' && r.severity !== severity) return false;
      if (state === 'enabled' && !r.enabled) return false;
      if (state === 'disabled' && r.enabled) return false;
      if (!q) return true;
      return [r.name, r.description, metricOf(r.metric).label, r.scope_value]
        .some((v) => String(v || '').toLowerCase().includes(q));
    });
  }, [sectionRules, search, severity, state]);

  const stats = useMemo(() => ({
    enabled: sectionRules.filter((r) => r.enabled).length,
    disabled: sectionRules.filter((r) => !r.enabled).length,
    critical: sectionRules.filter((r) => r.severity === 'critical').length,
    warning: sectionRules.filter((r) => r.severity === 'warning').length,
    reserved: sectionRules.filter((r) => metricOf(r.metric).evaluation === 'reserved').length,
  }), [sectionRules]);

  const hasFilters = search || severity !== 'all' || state !== 'all';
  const clearFilters = () => { setSearch(''); setSeverity('all'); setState('all'); };

  const columns = [
    { key: 'rule', label: 'Rule', sortable: true, sortKey: 'name' },
    { key: 'condition', label: 'Condition', sortable: true, sortKey: 'metric' },
    { key: 'severity', label: 'Severity', sortable: true, width: 106 },
    { key: 'scope', label: 'Scope', sortable: true, width: 148 },
    { key: 'timing', label: 'For / re-notify', align: 'right', width: 118 },
    { key: 'enabled', label: 'On', align: 'right', width: 56 },
    { key: 'actions', label: '', align: 'right', width: 70 },
  ];

  const rows = filtered.map((r) => {
    const m = metricOf(r.metric);
    const sev = severityOf(r.severity);
    const evl = EVALUATION[m.evaluation] || EVALUATION.reserved;
    const dim = !r.enabled && 'opacity-55';

    return {
      key: String(r.id),
      sort: {
        name: r.name || '',
        metric: m.label,
        severity: SEVERITY_ORDER[sev.id] ?? 3,
        scope: describeScope(r),
      },
      cells: {
        rule: (
          <div className={cn('min-w-0', dim)}>
            <span className="truncate-safe block font-semibold text-fg">{r.name}</span>
            {r.description && (
              <span className="truncate-safe block text-[11px] text-subtle">{r.description}</span>
            )}
          </div>
        ),
        condition: (
          <div className={cn('flex min-w-0 items-center gap-1.5', dim)}>
            <span className="truncate-safe text-[12px] text-muted">{describeCondition(r)}</span>
            {/* a rule on a metric nothing can raise is the top cause of
                "my alert never fired" — say so on the row */}
            {m.evaluation === 'reserved' && (
              <Badge tone="warning" size="xs" className="shrink-0">no source</Badge>
            )}
          </div>
        ),
        severity: <span className={cn(dim)}><StatusKey status={sev} /></span>,
        scope: (
          <span className={cn('truncate-safe block text-[12px] text-muted', dim)}>
            {describeScope(r)}
          </span>
        ),
        timing: (
          <span className={cn('block text-[11px] text-muted', dim)}>
            {duration(r.duration_seconds)}
            <span className="block text-[10px] text-subtle">
              {r.cooldown_seconds ? `then ${duration(r.cooldown_seconds)}` : 'every time'}
            </span>
          </span>
        ),
        enabled: (
          <div className="flex justify-end">
            <Switch
              size="sm"
              checked={r.enabled}
              onChange={(enabled) => toggleRule({ id: r.id, enabled })}
              label={`${r.enabled ? 'Disable' : 'Enable'} ${r.name}`}
            />
          </div>
        ),
        actions: (
          <div className="flex items-center justify-end gap-0.5">
            <Button
              variant="ghost" size="sm" icon="settings" className="px-1.5"
              aria-label={`Edit ${r.name}`} title="Edit"
              onClick={() => setEditing(r)}
            />
            <Button
              variant="danger-ghost" size="sm" icon="trash" className="px-1.5"
              aria-label={`Delete ${r.name}`} title="Delete"
              onClick={() => setConfirmDelete(r)}
            />
          </div>
        ),
      },
    };
  });

  return (
    <div className="space-y-gutter">
      {/* ── section picker: choose first, everything below follows ── */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {SECTIONS.map((s) => {
          const active = s.id === section;
          const count = counts[s.id] || 0;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => { setSection(s.id); clearFilters(); }}
              aria-pressed={active}
              className={cn(
                'card flex items-start gap-2.5 px-3 py-2.5 text-left transition-colors',
                active ? 'border-accent-border bg-accent-softer' : 'hover:border-strong hover:bg-raised',
              )}
            >
              <span
                className="grid h-8 w-8 shrink-0 place-items-center rounded-md"
                style={{ background: `color-mix(in srgb, ${s.color} 14%, transparent)`, color: s.color }}
              >
                <Icon name={s.icon} size={16} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-1.5">
                  <span className="truncate-safe text-[12px] font-bold text-fg">{s.label}</span>
                  <span className="text-[11px] font-semibold text-subtle tabular-nums">{count}</span>
                </span>
                <span className="truncate-safe block text-[10px] text-subtle">{s.desc}</span>
              </span>
            </button>
          );
        })}
      </div>

      {/* ── filter row, scoped to the chosen section — one line from sm up ── */}
      <div className="flex flex-wrap items-center gap-2 lg:flex-nowrap">
        <Input
          icon="search"
          placeholder={`Search ${meta.label.toLowerCase()} rules…`}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onClear={() => setSearch('')}
          wrapperClassName="w-full min-w-0 sm:w-auto sm:max-w-56 sm:flex-1"
        />
        <Select
          width="auto" value={severity} onChange={setSeverity}
          options={[
            { id: 'all', label: 'All severities' },
            { id: 'critical', label: `Critical (${stats.critical})` },
            { id: 'warning', label: `Warning (${stats.warning})` },
          ]}
        />
        <Select
          width="auto" value={state} onChange={setState}
          options={[
            { id: 'all', label: `All (${sectionRules.length})` },
            { id: 'enabled', label: `Enabled (${stats.enabled})` },
            { id: 'disabled', label: `Disabled (${stats.disabled})` },
          ]}
        />
        {hasFilters && (
          <Button variant="ghost" size="sm" icon="close" onClick={clearFilters}>Clear</Button>
        )}

        <div className="ml-auto flex shrink-0 items-center gap-2">
          {stats.disabled > 0 && <Badge tone="warning">{stats.disabled} off</Badge>}
          {stats.reserved > 0 && (
            <Badge tone="warning" className="hidden xl:inline-flex">
              {stats.reserved} with no data source
            </Badge>
          )}
          <Button variant="primary" icon="plus" onClick={() => setEditing({})}>
            New rule
          </Button>
        </div>
      </div>

      {/* ── the table ── */}
      <section className="card overflow-hidden">
        <Table
          columns={columns}
          rows={sortRows(rows, sort)}
          sort={sort}
          onSort={(key) => setSort((s) => nextSort(s, key))}
          loading={isFetching && !isLoading}
          empty={
            hasFilters ? (
              <EmptyState
                icon="filter"
                title={`No ${meta.label.toLowerCase()} rules match these filters`}
                action={<Button size="sm" icon="close" onClick={clearFilters}>Clear filters</Button>}
              />
            ) : (
              <EmptyState
                icon={meta.icon}
                title={`No ${meta.label.toLowerCase()} rules yet`}
                body={`${meta.desc}. Create a threshold rule to start monitoring.`}
                action={(
                  <Button size="sm" variant="primary" icon="plus" onClick={() => setEditing({})}>
                    New {meta.label.toLowerCase()} rule
                  </Button>
                )}
              />
            )
          }
        />
      </section>

      <RuleEditor
        open={editing !== null}
        rule={editing?.id ? editing : null}
        defaultSection={section}
        onClose={() => setEditing(null)}
        onSave={saveRule}
        saving={isSaving}
      />

      {confirmDelete && (
        <ConfirmDelete
          rule={confirmDelete}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={async () => {
            await deleteRule(confirmDelete.id);
            setConfirmDelete(null);
          }}
        />
      )}
    </div>
  );
}

/** Deleting isn't reversible from the UI, so it asks and names what stops being watched. */
function ConfirmDelete({ rule, onCancel, onConfirm }) {
  const [busy, setBusy] = useState(false);

  return (
    <Dialog
      open
      onClose={onCancel}
      title="Delete this rule?"
      icon="trash"
      tone="danger"
      width={420}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel}>Cancel</Button>
          <Button
            variant="danger"
            icon="trash"
            loading={busy}
            onClick={async () => { setBusy(true); try { await onConfirm(); } finally { setBusy(false); } }}
          >
            Delete rule
          </Button>
        </div>
      }
    >
      <p className="text-[12px] text-muted">
        <b className="text-fg">{rule.name}</b> will be removed, and
        {' '}<b className="text-fg">{describeCondition(rule)}</b> on {describeScope(rule)}
        {' '}will no longer raise alerts.
      </p>
      <p className="mt-2 text-[11px] text-subtle">
        To stop the alerts without losing the rule, switch it off instead.
      </p>
    </Dialog>
  );
}
