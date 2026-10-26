import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Area, AreaChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import cn from '@/lib/cn';
import Icon from '@/components/ui/Icon';
import Button from '@/components/ui/Button';
import Table, { EmptyState, nextSort, sortRows } from '@/components/ui/Table';
import Pagination, { pageCountOf, paginate } from '@/components/ui/Pagination';
import { severityOf } from '@/components/charts/status';
import { metricOf, sectionMeta } from '@/config/alertCatalog';
import { ageSeconds, ago, fullTime, num } from '@/lib/format';
import { useThemeStore } from '@/theme/themeStore';
import { getAlertStats, isAckable } from '@/api/alerts';

const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 };
const SEV = {
  critical: { color: '#ef4444', badge: 'bg-[#fde8e8] text-[#dc2626]' },
  warning: { color: '#f59e0b', badge: 'bg-[#fef3c7] text-[#b45309]' },
  info: { color: '#3b82f6', badge: 'bg-[#dbeafe] text-[#1d4ed8]' },
};
const RANGES = [[24, 'Last 24 hours'], [72, 'Last 3 days'], [168, 'Last 7 days']];
const ctl = 'inline-flex h-11 items-center gap-2 rounded-lg border border-border bg-surface px-3 text-[14px] text-fg';

/** The alert's own number for the Value column: the rule value, else the percentage stated in the message. */
function valueOf(a) {
  const n = Number(a.value);
  if (a.value !== null && a.value !== undefined && a.value !== '' && Number.isFinite(n)) return { v: n, pct: metricOf(a.metric).unit === '%' };
  const m = /(\d+(?:\.\d+)?)%/.exec(a.message || '');
  if (m) return { v: Number(m[1]), pct: true };
  // non-numeric state (e.g. a host that is offline): show what the rule reported, never "NaN"
  return a.value !== null && a.value !== undefined && a.value !== '' ? { text: String(a.value) } : null;
}

/** Alerts → Active. Filters scope everything below (charts, table); every number comes from the live feed or /alerts/detail/stats. */
export default function ActiveAlerts({ feed, onOpenRules, openAlertId, onOpenAlert }) {
  const navigate = useNavigate();
  const { alerts, summary, isLoading, isFetching, acknowledge, isAcknowledging } = feed;

  const [search, setSearch] = useState('');
  // ?sev=critical|warning|info — the dashboard's Alerts By Severity chart links here
  const [searchParams] = useSearchParams();
  const sevParam = ['critical', 'warning', 'info'].includes(searchParams.get('sev')) ? searchParams.get('sev') : 'all';
  const [severity, setSeverity] = useState(sevParam);
  useEffect(() => { setSeverity(sevParam); }, [sevParam]);
  const [source, setSource] = useState('all');
  const [metric, setMetric] = useState('all');
  const [hours, setHours] = useState(24);
  const [trendSev, setTrendSev] = useState('critical');
  const [sort, setSort] = useState({ key: 'severity', dir: 'asc' });
  const [selected, setSelected] = useState([]);
  const [confirmAll, setConfirmAll] = useState(false);
  const [menu, setMenu] = useState(null);       // row key with an open ⋮ menu, or 'page'
  const [page, setPage] = useState(1);
  const appPageSize = useThemeStore((s) => s.rowsPerPage);
  const [ownPageSize, setOwnPageSize] = useState(null);
  const pageSize = ownPageSize ?? appPageSize;

  const statsQ = useQuery({ queryKey: ['alerts', 'stats', hours], queryFn: () => getAlertStats(hours), refetchInterval: 60_000 });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return alerts.filter((a) => {
      if (severity !== 'all' && severityOf(a.severity).id !== severity) return false;
      if (source !== 'all' && a.source !== source) return false;
      if (metric !== 'all' && a.metric !== metric) return false;
      if (!q) return true;
      return [a.rule_name, a.message, a.source, a.technology, a.environment].some((v) => String(v || '').toLowerCase().includes(q));
    });
  }, [alerts, search, severity, source, metric]);
  const hasFilters = search || severity !== 'all' || source !== 'all' || metric !== 'all';
  const clearFilters = () => { setSearch(''); setSeverity('all'); setSource('all'); setMetric('all'); };

  const dist = useMemo(() => {
    const c = { critical: 0, warning: 0, info: 0 };
    filtered.forEach((a) => { c[severityOf(a.severity).id in c ? severityOf(a.severity).id : 'info'] += 1; });
    return c;
  }, [filtered]);
  const distTotal = dist.critical + dist.warning + dist.info;
  const series = statsQ.data?.series || [];
  const trendData = series.map((p) => ({ t: p.t, v: trendSev === 'all' ? p.critical + p.warning + p.info : p[trendSev] || 0 }));

  const columns = [
    { key: 'srNo', label: 'Sr. No.', align: 'center', width: 90 },
    { key: 'alert', label: 'Alert', sortable: true, sortKey: 'name' },
    { key: 'source', label: 'Source', sortable: true, width: 170 },
    { key: 'severity', label: 'Severity', align: 'center', sortable: true, width: 140 },
    { key: 'value', label: 'Value', sortable: true, width: 190 },
    { key: 'age', label: 'Age', sortable: true, width: 140 },
    { key: 'actions', label: 'Actions', align: 'center', width: 160 },
  ];

  const ackOne = async (a) => { if (isAckable(a)) await acknowledge([a]); };

  const rows = filtered.map((a) => {
    const sevId = severityOf(a.severity).id;
    const sev = SEV[sevId] || SEV.info;
    const m = metricOf(a.metric);
    const sec = sectionMeta(m.section);
    const val = valueOf(a);
    const key = String(a.id);
    return {
      key,
      sort: { severity: SEVERITY_ORDER[sevId] ?? 3, name: a.rule_name || '', source: a.source || '', value: Number.isFinite(val?.v) ? val.v : -1, age: ageSeconds(a.created_at) },
      onClick: () => onOpenAlert?.(a.id),
      className: String(openAlertId) === key ? 'bg-accent-soft/70 ring-2 ring-inset ring-accent' : undefined,
      cells: {
        alert: (
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md text-[#2563eb]"><Icon name={sec.icon || 'database'} size={22} /></span>
            <div className="min-w-0">
              <div className="truncate-safe text-[15px] font-semibold text-fg">{a.rule_name || m.label}</div>
              <div className="truncate-safe text-[12.5px] text-muted" title={a.message}>{a.message}</div>
            </div>
          </div>
        ),
        source: (
          <span className="inline-flex min-w-0 items-center gap-2 text-[14px] text-fg" title={[a.technology, a.environment].filter(Boolean).join(' · ')}>
            <Icon name="database" size={16} className="shrink-0 text-[#2563eb]" /><span className="truncate-safe">{a.source || '—'}</span>
          </span>
        ),
        severity: (
          <span className={cn('inline-flex items-center gap-1.5 rounded-full px-3.5 py-1 text-[13.5px] font-semibold', sev.badge)}>
            <Icon name="alert" size={14} />{severityOf(a.severity).label}
          </span>
        ),
        value: !val ? <span className="text-[14px] text-subtle">—</span> : val.text ? <span className="text-[14px] font-semibold capitalize text-fg">{val.text}</span> : (
          <span className="block w-full pr-4">
            <span className="block text-[14px] font-semibold text-fg tabular-nums">{val.pct ? `${val.v.toFixed(1)}%` : num(val.v, m.unit)}</span>
            {val.pct && <span className="mt-1 block h-[7px] w-full overflow-hidden rounded-full bg-[#e5e7eb]"><span className="block h-full rounded-full" style={{ width: `${Math.min(100, val.v)}%`, background: sev.color }} /></span>}
            {a.threshold !== null && a.threshold !== undefined && <span className="block text-[10.5px] text-subtle">threshold {num(a.threshold, m.unit)}</span>}
          </span>
        ),
        age: <span className="inline-flex items-center gap-1.5 text-[14px] text-fg" title={fullTime(a.created_at)}><Icon name="clock" size={15} className="text-muted" />{ago(a.created_at)}</span>,
        actions: (
          <div className="relative flex items-center justify-center gap-1" onClick={(e) => e.stopPropagation()}>
            <button type="button" aria-label={`View ${a.rule_name}`} title="View details" onClick={() => onOpenAlert?.(a.id)} className="grid h-9 w-9 place-items-center rounded-md text-fg hover:bg-raised"><Icon name="eye" size={17} /></button>
            <button type="button" aria-label={`Acknowledge ${a.rule_name}`} title={isAckable(a) ? 'Acknowledge' : 'Live state — clears when the condition clears'} disabled={!isAckable(a) || isAcknowledging}
              onClick={() => ackOne(a)} className="grid h-9 w-9 place-items-center rounded-md text-fg hover:bg-raised disabled:opacity-35"><Icon name="bell" size={17} /></button>
            <button type="button" aria-label={`More actions for ${a.rule_name}`} onClick={() => setMenu(menu === key ? null : key)} className="grid h-9 w-9 place-items-center rounded-md text-fg hover:bg-raised"><Icon name="more-vertical" size={17} /></button>
            {menu === key && (
              <div className="absolute right-0 top-10 z-20 w-48 rounded-lg border border-border bg-surface py-1 text-left shadow-lg" onMouseLeave={() => setMenu(null)}>
                <button type="button" onClick={() => { setMenu(null); onOpenAlert?.(a.id); }} className="block w-full px-3 py-2 text-left text-[13px] hover:bg-raised">Open details</button>
                <button type="button" onClick={() => { setMenu(null); navigate('/infra'); }} className="block w-full px-3 py-2 text-left text-[13px] hover:bg-raised">Open Infrastructure</button>
                <button type="button" onClick={() => { setMenu(null); setSource(a.source || 'all'); }} className="block w-full px-3 py-2 text-left text-[13px] hover:bg-raised">Only this source</button>
              </div>
            )}
          </div>
        ),
      },
    };
  });

  const sorted = sortRows(rows, sort);
  const numbered = sorted.map((r, i) => ({ ...r, cells: { ...r.cells, srNo: <span className="text-[14px] tabular-nums text-fg">{i + 1}</span> } }));
  const pageCount = pageCountOf(numbered.length, pageSize);
  useEffect(() => { if (page > pageCount) setPage(pageCount); }, [page, pageCount]);
  const currentPage = Math.min(page, pageCount);
  const pageRows = paginate(numbered, currentPage, pageSize);
  const selectedAlerts = alerts.filter((a) => selected.includes(String(a.id)));

  const exportCsv = () => {
    const q = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const lines = [['Alert', 'Message', 'Source', 'Severity', 'Value', 'Raised (UTC)'].join(',')]
      .concat(sorted.map((r) => { const a = filtered.find((x) => String(x.id) === r.key); const v = valueOf(a); return [a.rule_name, a.message, a.source, a.severity, v ? v.v : '', a.created_at].map(q).join(','); }));
    const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' }));
    const el = document.createElement('a'); el.href = url; el.download = `actmon-alerts-${new Date().toISOString().slice(0, 16).replace(':', '')}.csv`;
    document.body.appendChild(el); el.click(); el.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="space-y-4">
      {/* filter row */}
      <div className="flex flex-wrap items-center gap-3">
        <label className={cn(ctl, 'min-w-[240px] flex-1 xl:max-w-[340px]')}>
          <Icon name="search" size={17} className="text-muted" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search alerts, hosts, messages..." aria-label="Search alerts" className="w-full bg-transparent outline-none placeholder:text-subtle" />
        </label>
        <select aria-label="Severity" value={severity} onChange={(e) => setSeverity(e.target.value)} className={cn(ctl, 'pr-8')}>
          <option value="all">All severities</option><option value="critical">Critical ({summary.critical})</option><option value="warning">Warning ({summary.warning})</option><option value="info">Info ({summary.info})</option>
        </select>
        <select aria-label="Source" value={source} onChange={(e) => setSource(e.target.value)} className={cn(ctl, 'max-w-[220px] pr-8')}>
          <option value="all">All sources</option>{summary.sources.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select aria-label="Metric" value={metric} onChange={(e) => setMetric(e.target.value)} className={cn(ctl, 'max-w-[220px] pr-8')}>
          <option value="all">All metrics</option>{summary.byMetric.map((m) => <option key={m.key} value={m.key}>{metricOf(m.key).label}</option>)}
        </select>
        <span className={ctl}>
          <Icon name="calendar" size={17} className="text-accent" />
          <select aria-label="Trend range" value={hours} onChange={(e) => setHours(Number(e.target.value))} className="bg-transparent outline-none">
            {RANGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <button type="button" aria-label="Refresh" onClick={() => { feed.refresh(); statsQ.refetch(); }} className="text-muted hover:text-fg"><Icon name="refresh" size={15} className={cn(isFetching && 'animate-spin')} /></button>
        </span>
        {hasFilters && <Button variant="ghost" size="sm" icon="close" onClick={clearFilters}>Clear</Button>}
        {summary.ackableCount > 0 && (
          <label className="inline-flex items-center gap-2.5 text-[14px] font-semibold text-fg">
            <button type="button" role="switch" aria-checked={confirmAll} aria-label={`Acknowledge all ${summary.ackableCount} events`} onClick={() => setConfirmAll(true)}
              className={cn('relative h-6 w-11 rounded-full transition-colors', confirmAll ? 'bg-accent' : 'bg-[#e5e7eb]')}>
              <span className={cn('absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all', confirmAll ? 'left-[22px]' : 'left-0.5')} />
            </button>
            Acknowledge all {summary.ackableCount} events
          </label>
        )}
        <div className="ml-auto flex items-center gap-2">
          {selectedAlerts.filter(isAckable).length > 0 && (
            <Button variant="secondary" size="sm" icon="check" loading={isAcknowledging} onClick={async () => { await acknowledge(selectedAlerts); setSelected([]); }}>
              Acknowledge selected ({selectedAlerts.filter(isAckable).length})
            </Button>
          )}
          <button type="button" onClick={exportCsv} disabled={!filtered.length} className={cn(ctl, 'px-5 font-semibold disabled:opacity-50')}><Icon name="download" size={18} className="text-accent" />Export</button>
          <div className="relative">
            <button type="button" aria-label="More" onClick={() => setMenu(menu === 'page' ? null : 'page')} className={cn(ctl, 'w-11 justify-center px-0')}><Icon name="more-vertical" size={18} /></button>
            {menu === 'page' && (
              <div className="absolute right-0 z-20 mt-1 w-52 rounded-lg border border-border bg-surface py-1 shadow-lg" onMouseLeave={() => setMenu(null)}>
                <button type="button" onClick={() => { setMenu(null); onOpenRules(); }} className="block w-full px-3 py-2 text-left text-[13px] hover:bg-raised">Review alert rules</button>
                <button type="button" onClick={() => { setMenu(null); clearFilters(); }} className="block w-full px-3 py-2 text-left text-[13px] hover:bg-raised">Clear filters</button>
              </div>
            )}
          </div>
        </div>
      </div>

      {confirmAll && (
        <div className="card flex flex-wrap items-center gap-3 border-warning px-4 py-3">
          <Icon name="alert" size={18} className="text-warning-fg" />
          <span className="text-[13.5px] text-fg">Acknowledge all <b>{summary.ackableCount}</b> stored alert events? They leave this list; live-state alerts stay until their condition clears.</span>
          <div className="ml-auto flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => setConfirmAll(false)}>Cancel</Button>
            <Button size="sm" icon="check" loading={isAcknowledging} onClick={async () => { await acknowledge(alerts); setConfirmAll(false); }}>Acknowledge all</Button>
          </div>
        </div>
      )}

      {/* trend + distribution */}
      <div className="grid gap-4 xl:grid-cols-[2.6fr_1fr]">
        <section className="card p-5">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-[17px] font-semibold text-fg">Alerts Trend ({RANGES.find((r) => r[0] === hours)?.[1].replace('Last ', 'Last ')})</h3>
            <div className="flex gap-1 text-[13px]">
              {[['all', 'All'], ['critical', 'Critical'], ['warning', 'Warning'], ['info', 'Info']].map(([k, l]) => (
                <button key={k} type="button" onClick={() => setTrendSev(k)} className={cn('rounded-md px-2.5 py-1', trendSev === k ? 'bg-[#fde8e8] font-semibold text-[#dc2626]' : 'text-muted hover:bg-raised')}>{l}</button>
              ))}
            </div>
          </div>
          {statsQ.isLoading ? <div className="h-40 animate-pulse rounded bg-sunken" /> : statsQ.isError ? <p className="py-12 text-center text-[13px] text-muted">Trend unavailable: {statsQ.error?.message}</p> : (
            <div className="h-[150px]">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={trendData} margin={{ top: 6, right: 8, bottom: 0, left: -18 }}>
                  <defs><linearGradient id="alTrend" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={SEV[trendSev]?.color || '#ef4444'} stopOpacity={0.35} /><stop offset="100%" stopColor={SEV[trendSev]?.color || '#ef4444'} stopOpacity={0.05} /></linearGradient></defs>
                  <CartesianGrid stroke="var(--chart-grid)" />
                  <XAxis dataKey="t" type="number" scale="time" domain={['dataMin', 'dataMax']} tickFormatter={(t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })} tick={{ fontSize: 11.5, fill: 'var(--fg-muted)' }} stroke="var(--border)" minTickGap={30} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11.5, fill: 'var(--fg-muted)' }} stroke="var(--border)" />
                  <Tooltip labelFormatter={(t) => new Date(t).toLocaleString()} formatter={(v) => [v, 'alerts raised']} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                  <Area type="monotone" dataKey="v" stroke={SEV[trendSev]?.color || '#ef4444'} strokeWidth={2} fill="url(#alTrend)" dot={{ r: 2.5, fill: SEV[trendSev]?.color || '#ef4444', strokeWidth: 0 }} isAnimationActive={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
          <p className="mt-1 text-[11px] text-subtle">Collector alerts raised per {statsQ.data?.bucket_s === 3600 ? 'hour' : `${(statsQ.data?.bucket_s || 3600) / 3600} hours`}. Rule alerts are live state and have no stored onset.</p>
        </section>
        <section className="card p-5">
          <h3 className="mb-3 text-[17px] font-semibold text-fg">Severity Distribution</h3>
          <div className="flex items-center gap-5">
            <div className="relative h-[140px] w-[140px] shrink-0">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart><Pie data={distTotal ? ['critical', 'warning', 'info'].map((k) => ({ k, v: dist[k] })).filter((x) => x.v) : [{ k: 'none', v: 1 }]} dataKey="v" innerRadius="72%" outerRadius="100%" stroke="none" isAnimationActive={false}>
                  {(distTotal ? ['critical', 'warning', 'info'].filter((k) => dist[k]) : ['none']).map((k) => <Cell key={k} fill={SEV[k]?.color || '#e5e7eb'} />)}
                </Pie></PieChart>
              </ResponsiveContainer>
              <div className="absolute inset-0 grid place-items-center text-center"><div><div className="text-[26px] font-bold text-fg">{distTotal}</div><div className="text-[13px] text-muted">Total</div></div></div>
            </div>
            <ul className="flex-1 space-y-3 text-[14px]">
              {['critical', 'warning', 'info'].map((k) => (
                <li key={k} className="flex items-center gap-2">
                  <span className="h-3 w-3 rounded-full" style={{ background: SEV[k].color }} />
                  <button type="button" onClick={() => setSeverity(severity === k ? 'all' : k)} className="flex-1 text-left capitalize text-fg hover:underline">{k}</button>
                  <b className="tabular-nums text-fg">{dist[k]}</b><span className="w-14 text-right tabular-nums text-muted">({distTotal ? Math.round((100 * dist[k]) / distTotal) : 0}%)</span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </div>

      {/* table */}
      <Table
        columns={columns}
        rows={pageRows}
        sort={sort}
        onSort={(key) => setSort((s) => nextSort(s, key))}
        rowHeight={58}
        darkHeader
        selectable
        selectedKeys={selected}
        onSelectionChange={setSelected}
        loading={isFetching && !isLoading}
        empty={hasFilters ? (
          <EmptyState icon="filter" title="No alerts match these filters" body="Try widening the search or clearing a filter." action={<Button size="sm" icon="close" onClick={clearFilters}>Clear filters</Button>} />
        ) : (
          <EmptyState icon="check" title="All clear" body="Nothing is firing. Alerts appear here the moment an enabled rule's condition is met." action={<Button size="sm" icon="settings" onClick={onOpenRules}>Review alert rules</Button>} />
        )}
      />
      {sorted.length > 0 && (
        <div className="card">
          <Pagination page={currentPage} pageCount={pageCount} total={sorted.length} pageSize={pageSize} onPage={setPage} onPageSize={setOwnPageSize} unit="alerts" />
        </div>
      )}
    </div>
  );
}
