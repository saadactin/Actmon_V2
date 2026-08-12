import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import cn from '@/lib/cn';
import Icon from '@/components/ui/Icon';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import Select from '@/components/ui/Select';
import Table, { EmptyState, nextSort, sortRows } from '@/components/ui/Table';
import ChartCard from '@/components/charts/ChartCard';
import { severityOf, StatusKey } from '@/components/charts/status';
import { isAckable } from '@/api/alerts';
import { metricOf, sectionMeta } from '@/config/alertCatalog';
import { ageSeconds, ago, fullTime, num } from '@/lib/format';

const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 };

/**
 * The live alert feed.
 *
 * One filter row scopes everything below it (summary chips included), so the
 * numbers on screen always agree with the rows. Severity chips double as filters
 * — the count you clicked is the count you get.
 */
export default function ActiveAlerts({ feed, onOpenRules }) {
  const navigate = useNavigate();
  const { alerts, summary, isLoading, isFetching, acknowledge, isAcknowledging } = feed;

  const [search, setSearch] = useState('');
  const [severity, setSeverity] = useState('all');
  const [source, setSource] = useState('all');
  const [metric, setMetric] = useState('all');
  const [selected, setSelected] = useState([]);
  const [sort, setSort] = useState({ key: 'severity', dir: 'asc' });
  const [expanded, setExpanded] = useState(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return alerts.filter((a) => {
      if (severity !== 'all' && severityOf(a.severity).id !== severity) return false;
      if (source !== 'all' && a.source !== source) return false;
      if (metric !== 'all' && a.metric !== metric) return false;
      if (!q) return true;
      return [a.rule_name, a.message, a.source, a.technology, a.environment]
        .some((v) => String(v || '').toLowerCase().includes(q));
    });
  }, [alerts, search, severity, source, metric]);

  const hasFilters = search || severity !== 'all' || source !== 'all' || metric !== 'all';
  const clearFilters = () => {
    setSearch(''); setSeverity('all'); setSource('all'); setMetric('all');
  };

  /* ── rows ─────────────────────────────────────────────────────────────── */
  const columns = [
    { key: 'severity', label: 'Severity', sortable: true, width: 108 },
    { key: 'alert', label: 'Alert', sortable: true, sortKey: 'name' },
    { key: 'source', label: 'Source', sortable: true },
    { key: 'value', label: 'Value', align: 'right', sortable: true, width: 128 },
    { key: 'age', label: 'Age', align: 'right', sortable: true, width: 88 },
    { key: 'actions', label: '', align: 'right', width: 64 },
  ];

  const rows = filtered.map((a) => {
    const sev = severityOf(a.severity);
    const m = metricOf(a.metric);
    // Icons live on the section, not the metric — one glyph per family keeps the
    // feed scannable instead of giving 34 metrics 34 different marks.
    const sec = sectionMeta(m.section);
    const isOpen = expanded === a.id;

    return {
      key: String(a.id),
      sort: {
        severity: SEVERITY_ORDER[sev.id] ?? 3,
        name: a.rule_name || '',
        source: a.source || '',
        value: Number(a.value) || 0,
        age: ageSeconds(a.created_at),
      },
      onClick: () => setExpanded(isOpen ? null : a.id),
      cells: {
        severity: <StatusKey status={sev} />,
        alert: (
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <Icon name={sec.icon} size={13} className="shrink-0" style={{ color: sec.color }} />
              <span className="truncate-safe font-semibold text-fg">{a.rule_name || m.label}</span>
            </div>
            <p className={cn('mt-0.5 text-[12px] text-muted', isOpen ? '' : 'truncate-safe')}>
              {a.message}
            </p>
            {isOpen && (
              <dl className="mt-2 grid gap-x-4 gap-y-1 text-[11px] sm:grid-cols-2">
                <Detail label="Metric" value={m.label} />
                <Detail label="Section" value={sec.label} />
                <Detail label="Technology" value={a.technology} />
                <Detail label="Environment" value={a.environment} />
                <Detail label="Threshold" value={a.threshold !== null ? num(a.threshold, m.unit) : null} />
                <Detail label="Raised" value={fullTime(a.created_at)} />
                <Detail
                  label="Origin"
                  value={a.rule_id ? `Rule #${a.rule_id}` : 'Collector event'}
                />
              </dl>
            )}
          </div>
        ),
        source: (
          <div className="min-w-0">
            <span className="truncate-safe block font-medium text-fg">{a.source || '—'}</span>
            {(a.technology || a.environment) && (
              <span className="truncate-safe block text-[11px] text-subtle">
                {[a.technology, a.environment].filter(Boolean).join(' · ')}
              </span>
            )}
          </div>
        ),
        value: a.value === null || a.value === undefined ? (
          <span className="text-subtle">—</span>
        ) : (
          <span>
            <span className="font-bold text-fg">{num(a.value, m.unit)}</span>
            {a.threshold !== null && a.threshold !== undefined && (
              <span className="block text-[10px] text-subtle">of {num(a.threshold, m.unit)}</span>
            )}
          </span>
        ),
        age: <span className="text-[12px] text-muted" title={fullTime(a.created_at)}>{ago(a.created_at)}</span>,
        actions: (
          <div className="flex items-center justify-end gap-0.5" onClick={(e) => e.stopPropagation()}>
            {a.source && (
              <Button
                variant="ghost"
                size="sm"
                icon="external"
                aria-label={`Open ${a.source}`}
                title={`Open ${a.source}`}
                onClick={() => navigate('/infra')}
                className="px-1.5"
              />
            )}
            <Button
              variant="ghost"
              size="sm"
              icon={expanded === a.id ? 'chevron-down' : 'chevron-right'}
              aria-label={expanded === a.id ? 'Hide details' : 'Show details'}
              onClick={() => setExpanded(expanded === a.id ? null : a.id)}
              className="px-1.5"
            />
          </div>
        ),
      },
    };
  });

  const sorted = sortRows(rows, sort);
  const selectedAlerts = filtered.filter((a) => selected.includes(String(a.id)));

  const doAck = async (list) => {
    await acknowledge(list);
    setSelected([]);
  };

  /* ── chart datasets (form is the reader's choice) ────────────────────── */
  const severityItems = [
    { key: 'critical', label: 'Critical', value: summary.critical, status: severityOf('critical') },
    { key: 'warning', label: 'Warning', value: summary.warning, status: severityOf('warning') },
    { key: 'info', label: 'Info', value: summary.info, status: severityOf('info') },
  ];
  const metricItems = summary.byMetric.slice(0, 8).map((m) => ({
    ...m,
    label: metricOf(m.key).label,
  }));

  return (
    <div className="space-y-gutter">
      {/* ── filter row: one row, scopes everything below ──
          `min-w-0` on the search field lets it absorb the leftover space instead
          of forcing the selects onto their own lines. Wrapping only kicks in
          below sm, where one line genuinely doesn't fit. */}
      <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
        <Input
          icon="search"
          placeholder="Search alerts, hosts, messages…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onClear={() => setSearch('')}
          wrapperClassName="w-full min-w-0 sm:w-auto sm:max-w-64 sm:flex-1"
        />
        <Select
          width="auto"
          value={severity}
          onChange={setSeverity}
          options={[
            { id: 'all', label: 'All severities' },
            { id: 'critical', label: `Critical (${summary.critical})` },
            { id: 'warning', label: `Warning (${summary.warning})` },
            { id: 'info', label: `Info (${summary.info})` },
          ]}
        />
        <Select
          width="auto"
          value={source}
          onChange={setSource}
          options={[
            { id: 'all', label: 'All sources' },
            ...summary.sources.map((s) => ({ id: s, label: s })),
          ]}
        />
        <Select
          width="auto"
          value={metric}
          onChange={setMetric}
          options={[
            { id: 'all', label: 'All metrics' },
            ...summary.byMetric.map((m) => ({ id: m.key, label: metricOf(m.key).label })),
          ]}
        />
        {hasFilters && (
          <Button variant="ghost" size="sm" icon="close" onClick={clearFilters}>
            Clear
          </Button>
        )}

        <span className="ml-auto shrink-0 text-[12px] whitespace-nowrap text-subtle">
          {filtered.length === alerts.length
            ? `${alerts.length} firing`
            : `${filtered.length} of ${alerts.length}`}
        </span>
      </div>

      {/* ── severity chips: summary that is also the filter ── */}
      <div className="flex flex-wrap gap-2">
        {severityItems.map((s) => {
          const on = severity === s.key;
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => setSeverity(on ? 'all' : s.key)}
              aria-pressed={on}
              className={cn(
                'card flex items-center gap-2.5 px-3 py-2 transition-colors',
                on ? 'border-accent-border bg-accent-softer' : 'hover:border-strong hover:bg-raised',
              )}
            >
              <span
                className="grid h-7 w-7 place-items-center rounded-md text-white"
                style={{ background: s.status.color }}
              >
                <Icon name={s.status.icon} size={14} strokeWidth={2.8} />
              </span>
              <span className="text-left">
                <span className="block text-[17px] leading-none font-bold text-fg">{s.value}</span>
                <span className="mt-0.5 block text-[10px] font-semibold text-muted">{s.label}</span>
              </span>
            </button>
          );
        })}

        {summary.ackableCount > 0 && (
          <Button
            variant="secondary"
            icon="check"
            loading={isAcknowledging}
            onClick={() => doAck(alerts)}
            className="self-center"
          >
            Acknowledge all {summary.ackableCount} events
          </Button>
        )}
      </div>

      {/* ── overview charts (type switchable per card) ── */}
      {summary.total > 0 && (
        <div className="grid gap-gutter lg:grid-cols-2">
          <ChartCard
            cardId="alerts-by-severity"
            family="flat"
            items={severityItems}
            chartProps={{ labelWidth: 60 }}
            title="By severity"
            icon="alert"
            loading={isFetching && !isLoading}
            tableColumns={[
              { key: 'severity', label: 'Severity' },
              { key: 'count', label: 'Alerts', align: 'right' },
            ]}
            tableRows={severityItems.map((s) => ({ key: s.key, cells: { severity: s.label, count: s.value } }))}
          />
          <ChartCard
            cardId="alerts-by-metric"
            family="flat"
            items={metricItems}
            chartProps={{ labelWidth: 128 }}
            title="By metric"
            icon="trend"
            subtitle={summary.byMetric.length > 8 ? 'Top 8' : undefined}
            loading={isFetching && !isLoading}
            tableColumns={[
              { key: 'metric', label: 'Metric' },
              { key: 'count', label: 'Alerts', align: 'right' },
            ]}
            tableRows={summary.byMetric.map((m) => ({
              key: m.key,
              cells: { metric: metricOf(m.key).label, count: m.value },
            }))}
          />
        </div>
      )}

      {/* ── the feed ── */}
      <section className="card overflow-hidden">
        {selected.length > 0 && (
          <div className="flex flex-wrap items-center gap-3 border-b border-border bg-accent-softer px-card py-2.5">
            <span className="text-[12px] font-semibold text-fg">{selected.length} selected</span>
            <Button
              size="sm"
              variant="primary"
              icon="check"
              loading={isAcknowledging}
              disabled={!selectedAlerts.some(isAckable)}
              onClick={() => doAck(selectedAlerts)}
            >
              Acknowledge
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected([])}>Clear</Button>
            {!selectedAlerts.some(isAckable) && (
              <span className="text-[11px] text-subtle">
                Rule-evaluated alerts clear on their own — nothing here to acknowledge.
              </span>
            )}
          </div>
        )}

        <Table
          columns={columns}
          rows={sorted}
          sort={sort}
          onSort={(key) => setSort((s) => nextSort(s, key))}
          selectable
          selectedKeys={selected}
          onSelectionChange={setSelected}
          /* Only collector events have something to mark read; live rule alerts
             are recomputed each poll, so a checkbox on them would do nothing. */
          isSelectable={(row) => isAckable({ id: row.key })}
          loading={isFetching && !isLoading}
          empty={
            hasFilters ? (
              <EmptyState
                icon="filter"
                title="No alerts match these filters"
                body="Try widening the search or clearing a filter."
                action={<Button size="sm" icon="close" onClick={clearFilters}>Clear filters</Button>}
              />
            ) : (
              <EmptyState
                icon="check"
                title="All clear"
                body="Nothing is firing. Alerts appear here the moment an enabled rule's condition is met."
                action={<Button size="sm" icon="settings" onClick={onOpenRules}>Review alert rules</Button>}
              />
            )
          }
        />
      </section>
    </div>
  );
}

function Detail({ label, value }) {
  if (!value) return null;
  return (
    <div className="flex gap-1.5">
      <dt className="shrink-0 font-semibold text-subtle">{label}</dt>
      <dd className="min-w-0 truncate-safe text-muted">{value}</dd>
    </div>
  );
}
