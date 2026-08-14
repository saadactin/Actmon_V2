import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip,
  ResponsiveContainer, PieChart, Pie, Cell, Legend,
} from 'recharts';
import client from '@/api/client';
import PageHeader from '@/components/layout/PageHeader';
import Tabs from '@/components/ui/Tabs';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Icon from '@/components/ui/Icon';
import Input from '@/components/ui/Input';
import Notice from '@/components/ui/Notice';
import Select from '@/components/ui/Select';
import Table, { EmptyState, nextSort, sortRows } from '@/components/ui/Table';
import { PageLoading, InlineLoading } from '@/components/ui/Loading';
import { Paged } from '@/components/ui/Pagination';
import CopyButton from '@/components/ui/CopyButton';
import { MetricTile, Panel, SqlCell, SqlBlock, TablePanel } from '@/pages/_shared/enginePanels';
import { fmtNumber, fmtDateTime } from '@/config/dbCatalog';
import {
  engineFor, DEFAULT_CAPABILITIES, SEVERITY_TONES, SEVERITY_LABELS, fmtMs,
} from '@/config/slowQueryCatalog';

/**
 * Slow Query Analysis — the ONE list page every engine renders through.
 *
 * PostgreSQL's page was this task's reference implementation: 4 tabs (Overview,
 * Query Explorer, AI Analysis, Reports), a KPI strip, a slowest-queries chart, a
 * by-user breakdown, hotspot cards, and a CSV export. Every engine gets exactly
 * this shape now — what changes per engine is which columns/panels apply
 * (`capabilities`, from the normalized API response), never the layout.
 *
 * The table and every stat here reads `data.normalized` — the common row shape
 * every engine's backend now produces — so no branch here ever checks `tech`.
 */

const PIE_COLORS = ['#6366f1', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#06b6d4', '#f97316', '#84cc16'];

const num = (v) => Number(v) || 0;

const DURATION_FILTERS = [
  { id: '0', label: 'Any duration' },
  { id: '100', label: '≥ 100 ms' },
  { id: '500', label: '≥ 500 ms' },
  { id: '1000', label: '≥ 1 s' },
  { id: '5000', label: '≥ 5 s' },
  { id: '10000', label: '≥ 10 s' },
];

export function SeverityBadge({ severity }) {
  const s = String(severity || 'low').toLowerCase();
  return <Badge tone={SEVERITY_TONES[s] || 'neutral'} size="xs">{SEVERITY_LABELS[s] || severity || 'Low'}</Badge>;
}

/** The model's advice — every section is optional; it renders what came back.
 * Shared with SlowQueryDetailPage's AI tab so the two never drift apart. */
export function AiAnalysisResult({ a }) {
  if (!a) return null;
  return (
    <div className="space-y-gutter-sm">
      <div className="flex flex-wrap items-center gap-2">
        <SeverityBadge severity={a.severity} />
        {a.estimated_overall_improvement && (
          <span className="text-[11px] font-semibold text-success-fg">
            Expected gain: {a.estimated_overall_improvement}
          </span>
        )}
      </div>

      {a.severity_reason && <p className="text-[12px] text-muted">{a.severity_reason}</p>}
      {a.summary && <p className="text-[13px] text-fg"><b>Summary:</b> {a.summary}</p>}

      {a.root_cause && (
        <Panel title="Root cause" icon="info">
          <p className="text-[12px] text-fg">{a.root_cause}</p>
        </Panel>
      )}

      {(a.issues || []).length > 0 && (
        <Panel title={`Issues (${a.issues.length})`} icon="alert">
          <ul className="space-y-2">
            {a.issues.map((is, i) => (
              <li key={i} className="text-[12px]">
                <Badge tone={SEVERITY_TONES[String(is.severity).toLowerCase()] || 'neutral'} size="xs">
                  {is.type}
                </Badge>
                <span className="ml-2 text-fg">{is.description}</span>
                {is.evidence && <p className="mt-0.5 text-[11px] text-subtle">Evidence: {is.evidence}</p>}
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {(a.index_recommendations || []).length > 0 && (
        <Panel title={`Index recommendations (${a.index_recommendations.length})`} icon="layers">
          <div className="space-y-gutter-sm">
            {a.index_recommendations.map((ix, i) => (
              <div key={i}>
                <p className="mb-1 text-[12px] text-muted">
                  {ix.table && <span className="font-semibold text-fg">{ix.table}: </span>}
                  {ix.reason}
                  {ix.estimated_improvement && <b className="ml-1 text-success-fg">({ix.estimated_improvement})</b>}
                </p>
                {ix.create_sql && (
                  <div className="flex items-start gap-2">
                    <SqlBlock sql={ix.create_sql} className="flex-1" />
                    <CopyButton text={ix.create_sql} />
                  </div>
                )}
              </div>
            ))}
          </div>
        </Panel>
      )}

      {(a.schema_suggestions || []).length > 0 && (
        <Panel title="Schema suggestions" icon="layers">
          <ul className="space-y-1.5">
            {a.schema_suggestions.map((s, i) => (
              <li key={i} className="text-[12px] text-fg">{typeof s === 'string' ? s : JSON.stringify(s)}</li>
            ))}
          </ul>
        </Panel>
      )}

      {a.query_rewrite?.applicable && a.query_rewrite.optimized_sql && (
        <Panel title="Suggested rewrite" icon="terminal" subtitle={a.query_rewrite.expected_gain || undefined}>
          <div className="flex items-start gap-2">
            <SqlBlock sql={a.query_rewrite.optimized_sql} className="flex-1" />
            <CopyButton text={a.query_rewrite.optimized_sql} />
          </div>
          {a.query_rewrite.explanation && <p className="mt-1.5 text-[11px] text-subtle">{a.query_rewrite.explanation}</p>}
        </Panel>
      )}

      {(a.priority_actions || []).length > 0 && (
        <Panel title="Do these first" icon="check">
          <ol className="space-y-1.5">
            {a.priority_actions.map((p, i) => (
              <li key={i} className="flex items-start gap-2 text-[12px] text-fg">
                <span className="mt-0.5 font-mono text-[11px] font-bold text-accent-text">{i + 1}.</span>
                {p}
              </li>
            ))}
          </ol>
        </Panel>
      )}

      {(a.validation_queries || []).length > 0 && (
        <Panel title="Validation queries" icon="check">
          <div className="space-y-2">
            {a.validation_queries.map((vq, i) => (
              <div key={i} className="flex items-start gap-2">
                <SqlBlock sql={vq} className="flex-1" />
                <CopyButton text={vq} />
              </div>
            ))}
          </div>
        </Panel>
      )}

      {a.business_impact && (
        <p className="text-[12px] text-muted"><b>Business impact:</b> {a.business_impact}</p>
      )}
    </div>
  );
}

/** pg_stat_statements is the only "missing extension" flow this phase — MySQL's
 * performance_schema/slow log, and every other engine's native mechanism, ship
 * enabled by default, so no other engine needs this panel. */
function SetupGuidePanel({ id, engine, onEnabled }) {
  const [enabling, setEnabling] = useState(false);
  const [result, setResult] = useState(null);

  const handleEnable = async () => {
    setEnabling(true);
    setResult(null);
    try {
      const res = await client.post(engine.api.enableExtension(id)).then((r) => r.data);
      setResult(res);
      if (res.status === 'success') onEnabled?.();
    } catch (e) {
      setResult({ status: 'error', message: e?.message || 'Request failed.' });
    } finally {
      setEnabling(false);
    }
  };

  const step1 = "shared_preload_libraries = 'pg_stat_statements'";
  const step2 = 'CREATE EXTENSION IF NOT EXISTS pg_stat_statements;';
  const grantCmd = 'GRANT pg_read_all_stats TO your_user;';

  return (
    <Panel title="pg_stat_statements is not enabled" icon="settings"
      subtitle="Required for full slow-query history — enable it to unlock every tab.">
      <div className="space-y-gutter-sm">
        {result && (
          <Notice tone={result.status === 'success' ? 'success' : result.status === 'needs_restart' ? 'warning' : 'danger'}>
            {result.message}
          </Notice>
        )}
        {result?.status !== 'success' && (
          <Button variant="primary" icon="play" loading={enabling} onClick={handleEnable}>
            Enable extension automatically
          </Button>
        )}
        <div className="flex items-center gap-3">
          <div className="h-px flex-1 bg-border" />
          <span className="text-[10px] font-bold tracking-wide text-subtle uppercase">or set up manually</span>
          <div className="h-px flex-1 bg-border" />
        </div>
        <div className="space-y-1.5">
          <p className="text-[12px] font-semibold text-fg">1. Add to postgresql.conf and restart</p>
          <div className="flex items-center gap-2">
            <SqlBlock sql={step1} className="flex-1" />
            <CopyButton text={step1} />
          </div>
        </div>
        <div className="space-y-1.5">
          <p className="text-[12px] font-semibold text-fg">2. Create the extension</p>
          <div className="flex items-center gap-2">
            <SqlBlock sql={step2} className="flex-1" />
            <CopyButton text={step2} />
          </div>
        </div>
        <Notice tone="info" title="Permission needed?">
          Grant stats access with:
          <div className="mt-1.5 flex items-center gap-2">
            <SqlBlock sql={grantCmd} className="flex-1" />
            <CopyButton text={grantCmd} />
          </div>
        </Notice>
      </div>
    </Panel>
  );
}

/* ── Overview tab ────────────────────────────────────────────────────────── */

function OverviewTab({ rows, cap, engine, id, data, onRefetch }) {
  const isInstance = cap.aggregation === 'instance';

  const totalExecs = rows.reduce((s, r) => s + num(r.execution_count), 0);
  const avgTime = rows.length ? rows.reduce((s, r) => s + num(r.average_execution_time), 0) / rows.length : 0;
  const criticalCount = rows.filter((r) => r.severity === 'critical').length;

  const barData = [...rows]
    .sort((a, b) => num(b.average_execution_time) - num(a.average_execution_time))
    .slice(0, 12)
    .map((r, i) => ({
      name: `Q${i + 1}`,
      avg: num(r.average_execution_time),
      max: num(r.max_execution_time ?? r.average_execution_time),
      label: (r.query_text || '').replace(/\s+/g, ' ').slice(0, 40),
    }));

  const userMap = {};
  if (cap.user_name) {
    rows.forEach((r) => {
      const u = r.user_name || 'unknown';
      userMap[u] = (userMap[u] || 0) + 1;
    });
  }
  const pieData = Object.entries(userMap).map(([name, value]) => ({ name, value }));

  const top5Slow = [...rows].sort((a, b) => num(b.average_execution_time) - num(a.average_execution_time)).slice(0, 5);
  const top5Calls = cap.execution_count
    ? [...rows].sort((a, b) => num(b.execution_count) - num(a.execution_count)).slice(0, 5) : [];
  const top5Rows = cap.rows_returned
    ? [...rows].sort((a, b) => num(b.rows_returned) - num(a.rows_returned)).slice(0, 5) : [];

  return (
    <div className="space-y-gutter">
      {engine.setupGuide === 'pg_stat_statements' && data?.pg_stat_statements_available === false && (
        <SetupGuidePanel id={id} engine={engine} onEnabled={onRefetch} />
      )}

      <div className="grid grid-cols-2 gap-gutter-sm md:grid-cols-4">
        <MetricTile label={isInstance ? 'Operations captured' : 'Unique queries'} value={rows.length} icon="list" />
        {cap.execution_count ? (
          <MetricTile label="Total executions" value={fmtNumber(totalExecs)} icon="activity" tone="accent" />
        ) : (
          <MetricTile label="Source" value={engine.sourceLabel(data)} icon="database" />
        )}
        <MetricTile label={isInstance ? 'Avg duration' : 'Avg query time'} value={fmtMs(avgTime)} icon="clock"
          tone={avgTime > SEVERITY_THRESHOLDS_MS_HIGH ? 'bad' : 'neutral'} />
        <MetricTile label="Critical now" value={criticalCount} icon="alert"
          tone={criticalCount ? 'bad' : 'good'} hint="Averaging more than 10s" />
      </div>

      {rows.length > 0 && (
        <div className="grid grid-cols-1 gap-gutter lg:grid-cols-3">
          <TablePanel title="Slowest queries" icon="trend"
            subtitle="Top 12 by average duration — avg vs max"
            className="lg:col-span-2" bodyClassName="px-card py-card">
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={barData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis dataKey="name" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} unit=" ms" width={55} />
                <RTooltip
                  formatter={(v, n) => [fmtMs(v), n === 'avg' ? 'Avg time' : 'Max time']}
                  labelFormatter={(_, p) => p?.[0]?.payload?.label || ''}
                  contentStyle={{ fontSize: 11 }}
                />
                <Bar dataKey="avg" name="avg" fill="var(--color-accent, #6366f1)" radius={[4, 4, 0, 0]} />
                <Bar dataKey="max" name="max" fill="#f59e0b" radius={[4, 4, 0, 0]} opacity={0.55} />
              </BarChart>
            </ResponsiveContainer>
          </TablePanel>

          {cap.user_name && pieData.length > 0 ? (
            <TablePanel title="By user" icon="user" bodyClassName="px-card py-card">
              <ResponsiveContainer width="100%" height={220}>
                <PieChart>
                  <Pie data={pieData} cx="50%" cy="50%" innerRadius={50} outerRadius={80}
                    dataKey="value" nameKey="name" label={({ percent }) => (percent > 0.08 ? '' : '')}>
                    {pieData.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                  </Pie>
                  <RTooltip contentStyle={{ fontSize: 11 }} />
                  <Legend iconSize={8} wrapperStyle={{ fontSize: 11 }} />
                </PieChart>
              </ResponsiveContainer>
            </TablePanel>
          ) : (
            <Panel title="Source" icon="info">
              <p className="text-[12px] text-muted">{engine.sourceLabel(data)}</p>
            </Panel>
          )}
        </div>
      )}

      {rows.length > 0 && (
        <div className="grid grid-cols-1 gap-gutter md:grid-cols-3">
          <HotspotCard title="Slowest queries" icon="clock" items={top5Slow}
            metric={(r) => fmtMs(r.average_execution_time)} />
          {cap.execution_count && (
            <HotspotCard title="Most executed" icon="activity" items={top5Calls}
              metric={(r) => `${fmtNumber(r.execution_count)} execs`} />
          )}
          {cap.rows_returned && (
            <HotspotCard title="Most rows returned" icon="rows" items={top5Rows}
              metric={(r) => `${fmtNumber(r.rows_returned)} rows`} />
          )}
        </div>
      )}
    </div>
  );
}

const SEVERITY_THRESHOLDS_MS_HIGH = 2000;

function HotspotCard({ title, icon, items, metric }) {
  return (
    <Panel title={title} icon={icon}>
      {items.length === 0 ? (
        <p className="text-[12px] text-subtle">No data</p>
      ) : (
        <div className="space-y-2">
          {items.map((r, i) => (
            <div key={i} className="flex items-start justify-between gap-2">
              <span className="truncate-safe flex-1 font-mono text-[11px] text-muted">
                {(r.query_text || '').replace(/\s+/g, ' ').slice(0, 55)}
              </span>
              <span className="shrink-0 font-mono text-[11px] font-bold text-accent-text">{metric(r)}</span>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

/* ── Query Explorer tab ──────────────────────────────────────────────────── */

function ExplorerTab({ rows, cap, engine, id, isFetching, onRefetch, data }) {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [userFilter, setUserFilter] = useState('');
  const [minDuration, setMinDuration] = useState('0');
  const [sort, setSort] = useState({ key: 'avg', dir: 'desc' });

  const userOptions = useMemo(() => ([
    { id: '', label: 'All users' },
    ...[...new Set(rows.map((r) => r.user_name).filter(Boolean))].sort().map((u) => ({ id: u, label: u })),
  ]), [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const floor = Number(minDuration) || 0;
    return rows.filter((r) => (
      (!q || String(r.query_text || '').toLowerCase().includes(q))
      && (!userFilter || r.user_name === userFilter)
      && num(r.average_execution_time) >= floor
    ));
  }, [rows, search, userFilter, minDuration]);

  const isInstance = cap.aggregation === 'instance';

  const columns = useMemo(() => {
    const cols = [
      { key: 'sev', label: 'Severity' },
      { key: 'query', label: 'Query' },
      { key: 'avg', label: isInstance ? 'Duration' : 'Avg time', align: 'right', sortable: true },
    ];
    if (!isInstance) cols.push({ key: 'max', label: 'Max time', align: 'right', sortable: true });
    if (cap.execution_count) cols.push({ key: 'execs', label: 'Executions', align: 'right', sortable: true });
    if (cap.rows_returned) cols.push({ key: 'rows', label: 'Rows', align: 'right', sortable: true });
    if (cap.user_name) cols.push({ key: 'user', label: 'User' });
    if (cap.host) cols.push({ key: 'host', label: 'Host' });
    cols.push({ key: 'last', label: 'Last seen', sortable: true });
    return cols;
  }, [cap, isInstance]);

  const tableRows = useMemo(() => sortRows(filtered.map((r, i) => ({
    key: r.query_id || `q-${i}`,
    onClick: () => navigate(`${engine.dashboardPath(id)}/slow-queries/detail`, { state: { row: r, raw: r._raw } }),
    sort: {
      avg: num(r.average_execution_time),
      max: num(r.max_execution_time),
      execs: num(r.execution_count),
      rows: num(r.rows_returned),
      last: r.last_seen ? new Date(r.last_seen).getTime() || 0 : 0,
    },
    cells: {
      sev: <SeverityBadge severity={r.severity} />,
      query: (
        <div>
          <SqlCell sql={r.query_text} max={100} />
          {r.database_name && <Badge tone="accent" size="xs" className="mt-1">{r.database_name}</Badge>}
        </div>
      ),
      avg: (
        <span className={
          r.severity === 'critical' ? 'font-mono font-bold text-danger-fg'
            : r.severity === 'high' ? 'font-mono font-bold text-warning-fg'
              : 'font-mono font-semibold'
        }>
          {fmtMs(r.average_execution_time)}
        </span>
      ),
      max: r.max_execution_time != null ? <span className="font-mono text-muted">{fmtMs(r.max_execution_time)}</span> : null,
      execs: <span className="font-mono">{fmtNumber(r.execution_count)}</span>,
      rows: <span className="font-mono text-muted">{fmtNumber(r.rows_returned)}</span>,
      user: r.user_name ? <span className="font-mono text-[12px]">{r.user_name}</span> : null,
      host: r.host ? <span className="font-mono text-[11px] text-muted">{r.host}</span> : null,
      last: r.last_seen ? (
        <span className="whitespace-nowrap font-mono text-[11px] text-muted">{fmtDateTime(r.last_seen) || r.last_seen}</span>
      ) : null,
    },
  })), sort), [filtered, sort, navigate, engine, id]);

  return (
    <TablePanel
      title="Slow queries"
      icon="zap"
      subtitle="Select a row for the full analysis"
      actions={(
        <>
          {userOptions.length > 2 && (
            <Select value={userFilter} onChange={setUserFilter} options={userOptions} size="sm" width="auto" />
          )}
          <Select value={minDuration} onChange={setMinDuration} options={DURATION_FILTERS} size="sm" width="auto" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onClear={() => setSearch('')}
            placeholder="Search query text…"
            icon="search"
            size="sm"
            wrapperClassName="w-44"
          />
          <Badge tone="accent" size="xs">
            {filtered.length === rows.length ? rows.length : `${filtered.length} / ${rows.length}`}
          </Badge>
        </>
      )}
    >
      <Paged rows={tableRows} unit="queries">
        {(page, pager) => (
          <>
            <Table
              columns={columns}
              rows={page}
              sort={sort}
              onSort={(key) => setSort((cur) => nextSort(cur, key))}
              loading={isFetching}
              empty={rows.length ? (
                <EmptyState icon="filter" title="No matches"
                  body="Nothing matches the current filters — try a wider duration or clear the search." />
              ) : (
                <EmptyState icon="zap" title="No slow queries captured"
                  body={data?.error ? `${engine.label} reported: ${data.error}` : 'Nothing has crossed the slow-query threshold yet.'}
                  action={<Button variant="primary" icon="refresh" onClick={onRefetch}>Refresh now</Button>} />
              )}
            />
            {pager}
          </>
        )}
      </Paged>
    </TablePanel>
  );
}

/* ── AI Analysis tab ─────────────────────────────────────────────────────── */

function AiAnalysisTab({ rows, engine, id }) {
  const [selected, setSelected] = useState(null);
  const [ai, setAi] = useState(null);

  const worst5 = [...rows].sort((a, b) => num(b.average_execution_time) - num(a.average_execution_time)).slice(0, 5);

  const runAi = async (row) => {
    setSelected(row);
    setAi({ loading: true });
    try {
      const payload = engine.buildAiPayload(row, row._raw);
      const res = await client.post(engine.api.analyzeGroq(id), payload).then((r) => r.data);
      setAi(res.status === 'success' ? { result: res.analysis } : { err: res.error || 'The analyser returned no result.' });
    } catch (e) {
      setAi({ err: e?.message || String(e) });
    }
  };

  return (
    <div className="space-y-gutter">
      <Panel title="ActMon AI Deep Analysis" icon="brain"
        subtitle="Powered by the ActMon AI engine — instant DBA-level insights">
        {worst5.length === 0 ? (
          <p className="text-[12px] text-subtle">No query data available yet.</p>
        ) : (
          <>
            <p className="mb-2 text-[11px] font-bold tracking-wide text-subtle uppercase">Top 5 worst — quick pick</p>
            <div className="space-y-1.5">
              {worst5.map((r, i) => (
                <button
                  key={r.query_id || i}
                  type="button"
                  onClick={() => runAi(r)}
                  className={`w-full rounded-card border px-3 py-2 text-left text-[12px] transition-colors ${
                    selected === r ? 'border-accent bg-accent-soft' : 'border-border hover:bg-sunken'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate-safe flex-1 font-mono">
                      {(r.query_text || '').replace(/\s+/g, ' ').slice(0, 70)}
                    </span>
                    <span className="shrink-0 font-mono font-bold">{fmtMs(r.average_execution_time)}</span>
                  </div>
                  {r.user_name && <span className="text-[10px] text-subtle">user: {r.user_name}</span>}
                </button>
              ))}
            </div>
          </>
        )}
      </Panel>

      {ai?.loading && (
        <Panel><InlineLoading label="Running ActMon AI analysis — usually 5–10 seconds…" /></Panel>
      )}
      {ai?.err && (
        <>
          <Notice tone="danger" title="Analysis failed.">{ai.err}</Notice>
          <Button variant="secondary" icon="refresh" onClick={() => runAi(selected)}>Retry</Button>
        </>
      )}
      {ai?.result && (
        <Panel title={`Analysis — ${(selected.query_text || '').slice(0, 40)}…`} icon="brain">
          <AiAnalysisResult a={ai.result} />
        </Panel>
      )}
      {!ai && worst5.length > 0 && (
        <div className="py-12 text-center text-subtle">
          <Icon name="brain" size={32} className="mx-auto mb-3 opacity-30" />
          <p className="text-[13px]">Select a query above to get AI analysis</p>
        </div>
      )}
    </div>
  );
}

/* ── Reports tab ─────────────────────────────────────────────────────────── */

function ReportsTab({ rows, engine, id }) {
  const exportCsv = () => {
    const headers = ['Query', 'Database', 'User', 'Executions', 'Avg time (ms)', 'Max time (ms)', 'Total time (ms)', 'Rows returned', 'Severity', 'Last seen'];
    const csvRows = rows.map((r) => [
      `"${(r.query_text || '').replace(/"/g, '""').slice(0, 300)}"`,
      r.database_name || '',
      r.user_name || '',
      num(r.execution_count),
      num(r.average_execution_time),
      num(r.max_execution_time),
      num(r.total_execution_time),
      num(r.rows_returned),
      r.severity || '',
      r.last_seen || '',
    ].join(','));
    const csv = [headers.join(','), ...csvRows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${engine.key}_slow_queries_${id}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const totalExecs = rows.reduce((s, r) => s + num(r.execution_count), 0);
  const totalTime = rows.reduce((s, r) => s + num(r.total_execution_time), 0);
  const criticalQ = rows.filter((r) => r.severity === 'critical').length;

  return (
    <div className="space-y-gutter">
      <div className="grid grid-cols-2 gap-gutter-sm md:grid-cols-4">
        <MetricTile label="Total queries" value={rows.length} icon="list" />
        <MetricTile label="Total executions" value={fmtNumber(totalExecs)} icon="activity" tone="accent" />
        <MetricTile label="Total DB time" value={fmtMs(totalTime)} icon="clock" />
        <MetricTile label="Critical (>10s)" value={criticalQ} icon="alert" tone={criticalQ ? 'bad' : 'good'} />
      </div>

      <Panel title="Export slow query report" icon="download"
        subtitle={`${rows.length} queries · ${criticalQ} critical (>10s avg)`}
        actions={<Button variant="primary" icon="download" onClick={exportCsv}>Export CSV</Button>}
      >
        <p className="text-[12px] text-muted">
          Includes query text, user, execution counts, timing stats and severity. Suitable for
          performance audits and sharing with your team.
        </p>
      </Panel>
    </div>
  );
}

/* ── Main component ──────────────────────────────────────────────────────── */

export default function SlowQueriesPage({ tech }) {
  const engine = engineFor(tech);
  const { id } = useParams();
  const [tab, setTab] = useState('overview');

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['slowQueries', tech, id],
    queryFn: () => client.get(engine.api.list(id)).then((r) => r.data),
    retry: false,
    refetchInterval: 30000,
    enabled: !!engine,
  });

  const cap = data?.capabilities || DEFAULT_CAPABILITIES;

  /* The raw per-engine row (`_raw`) rides along for whatever the normalized
     schema deliberately drops (blks_hit/read, no_index_count, docsExamined…) —
     the AI-payload builders and detail page read it as a bonus, never a
     requirement, since a field it lacks just falls back to the normalized one. */
  const rows = useMemo(() => {
    const normalized = data?.normalized || [];
    // MongoDB has no `queries` key — its normalization runs over `all_ops`
    // (current_ops + profile_ops merged and sorted), not the raw `current_ops`
    // array alone, so that must be checked first.
    const rawList = data?.queries || data?.all_ops || data?.current_ops || [];
    return normalized.map((r, i) => ({ ...r, _raw: rawList[i] }));
  }, [data]);

  const header = (
    <PageHeader
      title={`${engine?.label || tech} Slow Queries`}
      description={engine ? engine.sourceLabel(data) : undefined}
      icon="zap"
      backTo={engine ? engine.dashboardPath(id) : undefined}
      actions={(
        <Button variant="secondary" icon="refresh" loading={isFetching} onClick={() => refetch()}>
          Refresh
        </Button>
      )}
      tabs={(
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { id: 'overview', label: 'Overview', icon: 'layers' },
            { id: 'explorer', label: 'Query Explorer', icon: 'search' },
            { id: 'ai', label: 'AI Analysis', icon: 'brain' },
            { id: 'reports', label: 'Reports', icon: 'download' },
          ]}
        />
      )}
    />
  );

  if (!engine) {
    return (
      <>
        <PageHeader title="Slow Queries" icon="zap" />
        <Notice tone="danger" title="Unknown database technology.">{String(tech)}</Notice>
      </>
    );
  }

  if (isLoading) return <>{header}<PageLoading title="Loading slow queries…" /></>;

  if (error) {
    return (
      <>
        {header}
        <Notice tone="danger" title="Could not load slow queries.">{error.message}</Notice>
        <Button variant="primary" icon="refresh" onClick={() => refetch()}>Retry</Button>
      </>
    );
  }

  return (
    <>
      {header}

      {data?.status === 'error' && data?.error && !(engine.setupGuide === 'pg_stat_statements' && data.pg_stat_statements_available === false) && (
        <Notice tone="warning" title="The collector could not be read.">{data.error}</Notice>
      )}

      {tab === 'overview' && <OverviewTab rows={rows} cap={cap} engine={engine} id={id} data={data} onRefetch={refetch} />}
      {tab === 'explorer' && <ExplorerTab rows={rows} cap={cap} engine={engine} id={id} isFetching={isFetching} onRefetch={refetch} data={data} />}
      {tab === 'ai' && <AiAnalysisTab rows={rows} engine={engine} id={id} />}
      {tab === 'reports' && <ReportsTab rows={rows} engine={engine} id={id} />}

      <p className="mt-gutter flex items-start gap-1.5 text-[11px] text-subtle">
        <Icon name="info" size={12} className="mt-0.5 shrink-0" />
        {cap.aggregation === 'instance'
          ? 'These are individual observed operations, not aggregated statistics — this engine has no query-digest concept, so each row is a single point in time rather than a running average.'
          : 'Averages are cumulative since the last reset or server restart — a low execution count may understate a query\'s real cost.'}
      </p>
    </>
  );
}
