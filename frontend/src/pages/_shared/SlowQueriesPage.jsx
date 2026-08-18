import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import client from '@/api/client';
import IconButton from '@/components/ui/IconButton';
import EngineDashboardHeader from '@/components/layout/EngineDashboardHeader';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Icon from '@/components/ui/Icon';
import Input from '@/components/ui/Input';
import Notice from '@/components/ui/Notice';
import Select from '@/components/ui/Select';
import Table, { EmptyState, nextSort, sortRows } from '@/components/ui/Table';
import { InlineLoading } from '@/components/ui/Loading';
import Pagination, { Paged, pageCountOf } from '@/components/ui/Pagination';
import CopyButton from '@/components/ui/CopyButton';
import { Panel, SqlBlock, TablePanel } from '@/pages/_shared/enginePanels';
import { fmtNumber, fmtDateTime } from '@/config/dbCatalog';
import { MYSQL_DASHBOARD_TABS, mysqlTabRoute } from '@/config/mysqlDashboardNav';
import { POSTGRES_DASHBOARD_TABS, postgresTabRoute } from '@/config/postgresDashboardNav';
import { MSSQL_DASHBOARD_TABS, mssqlTabRoute } from '@/config/mssqlDashboardNav';
import { MONGODB_DASHBOARD_TABS, mongodbTabRoute } from '@/config/mongodbDashboardNav';
import { CLICKHOUSE_DASHBOARD_TABS, clickhouseTabRoute } from '@/config/clickhouseDashboardNav';
import { BASE_TABS as ORACLE_DASHBOARD_TABS } from '@/config/oracleDashboardNav';
import PageHeader from '@/components/layout/PageHeader';
import {
  engineFor, DEFAULT_CAPABILITIES, SEVERITY_TONES, SEVERITY_LABELS, fmtMs,
} from '@/config/slowQueryCatalog';

/** Every engine's own dashboard tab strip + the route a tab click lands on —
 * so the Slow Queries page shows AS one tab within that engine's real
 * navigation (matching MySQL's own page) instead of a disconnected mini
 * page. Oracle's/ClickHouse's own "Slow Queries"/"Slow SQL" tab ids
 * (`slowqueries`, no hyphen) are still in-page preview panels inside their
 * Dashboard components — kept as the `activeTab` id here too, so the strip
 * highlights correctly; every other tab click still navigates back into the
 * real dashboard exactly like clicking it there would. */
const ENGINE_NAV = {
  postgresql: { tabs: POSTGRES_DASHBOARD_TABS, activeTab: 'slow-queries', tabRoute: postgresTabRoute },
  mssql: { tabs: MSSQL_DASHBOARD_TABS, activeTab: 'slow-queries', tabRoute: mssqlTabRoute },
  mongodb: { tabs: MONGODB_DASHBOARD_TABS, activeTab: 'slow-queries', tabRoute: mongodbTabRoute },
  clickhouse: { tabs: CLICKHOUSE_DASHBOARD_TABS, activeTab: 'slowqueries', tabRoute: clickhouseTabRoute },
  oracle: { tabs: ORACLE_DASHBOARD_TABS, activeTab: 'slowqueries', tabRoute: (id, t) => `/oracle-dashboard/${id}${t && t !== 'overview' ? `/${t}` : ''}` },
};

const QUERY_TYPE_FILTER_OPTIONS = [
  { id: 'all', label: 'All queries' },
  { id: 'system', label: 'System queries' },
  { id: 'actmon', label: 'ActMon queries' },
];

const NOT_CONFIGURED_MESSAGE = 'Slow query data is unavailable or not configured.';

const SEVERITY_FILTER_OPTIONS = [
  { id: 'all', label: 'All severities' },
  { id: 'critical', label: 'Critical' },
  { id: 'high', label: 'High' },
  { id: 'medium', label: 'Medium' },
  { id: 'low', label: 'Low' },
];

/** The query cell for the MySQL Slow Queries list — deliberately NOT the
 * shared `SqlCell` (which stays a compact single-line truncation used by
 * every other engine's Explorer tab): this one shows a genuinely readable,
 * wrapped chunk of SQL.
 *
 * The whole cell is part of the row's click target — clicking the query
 * text OR "Show full query" opens Query Analysis for that exact query
 * (`row.onClick` on the enclosing `<tr>`, see `MysqlSlowQueryExplorer`
 * below), it does NOT locally expand/collapse text on this page. Only the
 * Copy button stops propagation, since copying the SQL shouldn't also
 * navigate away. (This previously wrapped the ENTIRE cell in its own
 * `stopPropagation`, which silently ate every click here — including on the
 * query text itself — before it could ever reach the row's navigate
 * handler. That's the actual reason the detail page never opened.) */
function SlowQuerySqlCell({ sql }) {
  const text = String(sql || '').replace(/\s+/g, ' ').trim();
  if (!text) return <span className="text-subtle">—</span>;
  const isLong = text.length > 220;

  return (
    <div className="max-w-2xl cursor-pointer">
      <pre className="line-clamp-3 whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-fg">
        {text}
      </pre>
      <div className="mt-1 flex items-center gap-2">
        {isLong && (
          <span className="text-[11px] font-semibold text-accent-text hover:underline">
            Show full query
          </span>
        )}
        <span onClick={(e) => e.stopPropagation()}>
          <CopyButton text={text} />
        </span>
      </div>
    </div>
  );
}

/**
 * Slow Query Analysis — the ONE list page every engine renders through.
 *
 * MySQL is the reference design (`MysqlSlowQueryExplorer`/`MysqlSlowQueriesPage`
 * below, unchanged): a single filterable/sortable/paginated list, no charts.
 * Every other engine renders through the generalized `SlowQueryExplorer` +
 * `SlowQueriesPage` further down — same table, same filters, same pagination,
 * same detail drill-down, no per-engine chart dashboard. What differs per
 * engine is only which columns/filters apply (`capabilities`, from the
 * normalized API response) and where the underlying data comes from — never
 * the layout or interaction.
 */

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

/* ── MySQL — focused Slow Query Explorer ─────────────────────────────────────
 * MySQL gets its own dedicated page (see `MysqlSlowQueriesPage` below), not
 * the generic Overview/Explorer/AI Analysis/Reports tab set every other
 * engine uses — it opens directly on the full list. The collector can
 * genuinely return hundreds of entries on a busy server, so this sends the
 * database/schema filter, min execution time, search text, sort, and page
 * straight to `GET .../slow-queries` (see
 * `mysql_slow_query_service.list_slow_queries_filtered`), so the frontend
 * only ever holds the one page it's showing. Other engines' list endpoints
 * don't support these params yet, so this stays MySQL-only for now — every
 * other engine keeps using the generic ExplorerTab above, unchanged. */

const SORT_KEY_TO_PARAM = {
  avg: 'avg', max: 'max', execs: 'count', rows_sent: 'rows_returned', rows_examined: 'rows_examined', last: 'last_seen',
};

function MysqlSlowQueryExplorer({ engine, id }) {
  const navigate = useNavigate();
  const [schema, setSchema] = useState('');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 220);
    return () => clearTimeout(t);
  }, [search]);
  const [minDuration, setMinDuration] = useState('0');
  const [severity, setSeverity] = useState('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [sort, setSort] = useState({ key: 'avg', dir: 'desc' });
  const [page, setPage] = useState(1);
  const pageSize = 25;

  const params = useMemo(() => ({
    db_name: schema || undefined,
    min_avg_ms: Number(minDuration) || undefined,
    search: debouncedSearch.trim() || undefined,
    severity: severity !== 'all' ? severity : undefined,
    date_from: dateFrom || undefined,
    date_to: dateTo || undefined,
    sort_by: SORT_KEY_TO_PARAM[sort.key],
    sort_dir: sort.dir,
    page,
    page_size: pageSize,
  }), [schema, minDuration, debouncedSearch, severity, dateFrom, dateTo, sort, page]);

  // Filters/sort/schema changing should always land back on page 1 — never
  // silently show an empty "page 4 of 1" after narrowing the result set.
  useEffect(() => { setPage(1); }, [schema, minDuration, debouncedSearch, severity, dateFrom, dateTo, sort.key, sort.dir]);

  const { data, isFetching, refetch } = useQuery({
    queryKey: ['slowQueriesFiltered', 'mysql', id, params],
    queryFn: () => client.get(engine.api.list(id), { params }).then((r) => r.data),
    // v5's replacement for the v4 boolean `keepPreviousData: true` (silently
    // ignored in v5) — without this, the table briefly emptied on every
    // database/severity/search/date/sort/page change instead of keeping the
    // previous rows visible while the new filter's data loads.
    placeholderData: keepPreviousData,
    refetchInterval: 30000,
  });

  // The backend clamps an out-of-range page to the real last page (e.g. the
  // log rotated and the filtered result set shrank while sitting on a later
  // page) and reports which page it actually served. Sync local state to
  // that so the displayed "page" label and the Pagination control's
  // Prev/Next state never disagree with what's actually on screen.
  useEffect(() => {
    if (data && typeof data.page === 'number' && data.page !== page) {
      setPage(data.page);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const pageRows = data?.normalized || [];
  const total = data?.normalized_total ?? pageRows.length;
  const availableSchemas = data?.available_databases || [];
  const pageCount = pageCountOf(total, pageSize);
  const logConfig = data?.slow_log_config;

  const schemaOptions = [{ id: '', label: 'All databases' }, ...availableSchemas.map((s) => ({ id: s, label: s }))];

  const columns = [
    { key: 'sev', label: 'Severity' },
    { key: 'db', label: 'Database' },
    { key: 'query', label: 'Query' },
    { key: 'avg', label: 'Avg time', align: 'right', sortable: true },
    { key: 'max', label: 'Max time', align: 'right', sortable: true },
    { key: 'execs', label: 'Executions', align: 'right', sortable: true },
    { key: 'rows_sent', label: 'Rows sent', align: 'right', sortable: true },
    { key: 'rows_examined', label: 'Rows examined', align: 'right', sortable: true },
    { key: 'last', label: 'Last seen', sortable: true },
    { key: 'who', label: 'User / Host' },
  ];

  const tableRows = pageRows.map((r, i) => ({
    key: r.query_id || `q-${i}`,
    onClick: () => navigate(`${engine.dashboardPath(id)}/slow-queries/detail`, { state: { row: r, raw: r._raw } }),
    cells: {
      sev: <SeverityBadge severity={r.severity} />,
      db: r.database_name
        ? <Badge tone="accent" size="xs">{r.database_name}</Badge>
        : <Badge tone="neutral" size="xs">No Database</Badge>,
      query: <SlowQuerySqlCell sql={r.query_text} />,
      avg: (
        <span className={
          r.severity === 'critical' ? 'font-mono font-bold text-danger-fg'
            : r.severity === 'high' ? 'font-mono font-bold text-warning-fg' : 'font-mono font-semibold'
        }>
          {fmtMs(r.average_execution_time)}
        </span>
      ),
      max: r.max_execution_time != null ? <span className="font-mono text-muted">{fmtMs(r.max_execution_time)}</span> : null,
      execs: <span className="font-mono">{fmtNumber(r.execution_count)}</span>,
      rows_sent: <span className="font-mono text-muted">{fmtNumber(r.rows_returned)}</span>,
      rows_examined: <span className="font-mono text-muted">{fmtNumber(r.rows_affected)}</span>,
      last: r.last_seen ? (
        <span className="whitespace-nowrap font-mono text-[11px] text-muted">{fmtDateTime(r.last_seen) || r.last_seen}</span>
      ) : null,
      who: (r.user_name || r.host) ? (
        <span className="whitespace-nowrap font-mono text-[11px]">
          {r.user_name || '—'}
          {r.host && <span className="text-subtle"> @ {r.host}</span>}
        </span>
      ) : <span className="text-subtle">—</span>,
    },
  }));

  return (
    <div className="space-y-gutter">
      {logConfig && logConfig.enabled === false && (
        <Notice tone="warning" title="The Slow Query Log is not enabled on this server.">
          Set <code>slow_query_log = ON</code> (and a <code>long_query_time</code> threshold) to start recording
          entries — nothing can be shown here until it is.
        </Notice>
      )}
      {data?.file_error && (
        <Notice tone="warning" title="The Slow Query Log file could not be read.">{data.file_error}</Notice>
      )}

      <TablePanel
        title="Slow queries"
        icon="zap"
        subtitle="Every genuine entry from the MySQL/MariaDB Slow Query Log — filtered and paginated on the server"
        actions={(
          <>
            <Select value={minDuration} onChange={setMinDuration} options={DURATION_FILTERS} size="sm" width="auto" />
            {/* Always shown — even with a single real database, this is how
                the user confirms what's actually in the log and switches
                between it and "All Databases". Previously hidden whenever
                `availableSchemas.length <= 1`, which is exactly why it
                looked "missing" on a server with only one active database. */}
            <Select value={schema} onChange={setSchema} options={schemaOptions} size="sm" width="auto" />
            <Select value={severity} onChange={setSeverity} options={SEVERITY_FILTER_OPTIONS} size="sm" width="auto" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onClear={() => setSearch('')}
              placeholder="Search query text…"
              icon="search"
              size="sm"
              wrapperClassName="w-44"
            />
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="h-control-sm rounded-control border border-border bg-surface px-2 text-[12px] text-fg"
            />
            <span className="text-[11px] text-subtle">to</span>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="h-control-sm rounded-control border border-border bg-surface px-2 text-[12px] text-fg"
            />
            <Button variant="ghost" size="sm" icon="refresh" loading={isFetching} onClick={() => refetch()} aria-label="Refresh" />
            <Badge tone="accent" size="xs">{fmtNumber(total)}</Badge>
          </>
        )}
      >
        <Table
          columns={columns}
          rows={tableRows}
          sort={sort}
          onSort={(key) => setSort((cur) => nextSort(cur, key))}
          loading={isFetching}
          empty={
            <EmptyState icon="zap" title="No slow queries match these filters"
              body="Try widening the duration floor, clearing the search, or picking a different database."
              action={<Button variant="primary" icon="refresh" onClick={() => refetch()}>Refresh now</Button>} />
          }
        />
        {total > 0 && (
          <Pagination page={page} pageCount={pageCount} total={total} pageSize={pageSize} onPage={setPage} unit="queries" />
        )}
      </TablePanel>
    </div>
  );
}

/** MySQL's whole Slow Queries page — a focused explorer, nothing else. Opens
 * directly on the full list (no Overview, no AI Analysis tab here — that
 * only ever runs per-query, inside "Analyze Query"). Shares the SAME nav
 * strip as the rest of the MySQL dashboard (Overview…Storage…Slow Queries),
 * so it feels like one continuous tab set even though this page lives at
 * its own route, not inside `MySQLDashboard.jsx`'s own `activeTab` switch. */
function MysqlSlowQueriesPage({ engine, id }) {
  const navigate = useNavigate();
  return (
    <div className="flex min-h-full flex-col">
      <EngineDashboardHeader
        tech="mysql"
        connectionId={id}
        tabs={MYSQL_DASHBOARD_TABS}
        activeTab="slow-queries"
        onTabChange={(t) => navigate(mysqlTabRoute(id, t))}
      />
      <div className="space-y-1">
        <h1 className="text-lg font-black text-fg">Slow Queries</h1>
        <p className="text-xs text-subtle">MySQL/MariaDB Slow Query Log</p>
      </div>
      <MysqlSlowQueryExplorer engine={engine} id={id} />
    </div>
  );
}

/* ── Generic Slow Query Explorer — every engine except MySQL ──────────────
 * The SAME table/filters/pagination/search/sorting/empty/loading/error
 * design MySQL's own explorer uses above, generalized: reads whichever
 * columns/params an engine's `capabilities` genuinely populate rather than
 * hardcoding MySQL-specific fields. One component, reused for PostgreSQL,
 * Oracle, SQL Server, MongoDB, and ClickHouse (and Cosmos DB once wired) —
 * not a per-engine reimplementation. */

function NotConfiguredNotice({ engine, data }) {
  return (
    <Notice tone="warning" title={NOT_CONFIGURED_MESSAGE}>
      {data?.error
        ? `${engine.label} reported: ${data.error}`
        : `No slow-query collection mechanism is currently reachable for this ${engine.label} connection.`}
    </Notice>
  );
}

function SlowQueryExplorer({ engine, id }) {
  const navigate = useNavigate();
  const [schema, setSchema] = useState('');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 220);
    return () => clearTimeout(t);
  }, [search]);
  const [minDuration, setMinDuration] = useState('0');
  const [severity, setSeverity] = useState('all');
  const [queryType, setQueryType] = useState('all');
  const [userFilter, setUserFilter] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [sort, setSort] = useState({ key: 'avg', dir: 'desc' });
  const [page, setPage] = useState(1);
  const pageSize = 25;

  const params = useMemo(() => ({
    db_name: schema || undefined,
    query_type: queryType !== 'all' ? queryType : undefined,
    min_avg_ms: Number(minDuration) || undefined,
    search: debouncedSearch.trim() || undefined,
    severity: severity !== 'all' ? severity : undefined,
    user_name: userFilter || undefined,
    date_from: dateFrom || undefined,
    date_to: dateTo || undefined,
    sort_by: sort.key,
    sort_dir: sort.dir,
    page,
    page_size: pageSize,
  }), [schema, queryType, minDuration, debouncedSearch, severity, userFilter, dateFrom, dateTo, sort, page]);

  useEffect(() => { setPage(1); }, [schema, queryType, minDuration, debouncedSearch, severity, userFilter, dateFrom, dateTo, sort.key, sort.dir]);

  const { data, isFetching, error, refetch } = useQuery({
    queryKey: ['slowQueriesFiltered', engine.key, id, params],
    queryFn: () => client.get(engine.api.list(id), { params }).then((r) => r.data),
    placeholderData: keepPreviousData,
    refetchInterval: 30000,
    retry: false,
  });

  useEffect(() => {
    if (data && typeof data.page === 'number' && data.page !== page) {
      setPage(data.page);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const pageRows = data?.normalized || [];
  const total = data?.normalized_total ?? pageRows.length;
  const availableSchemas = data?.available_databases || [];
  const availableUsers = data?.available_users || [];
  const pageCount = pageCountOf(total, pageSize);

  const schemaOptions = [{ id: '', label: 'All databases' }, ...availableSchemas.map((s) => ({ id: s, label: s }))];
  const userOptions = [{ id: '', label: 'All users' }, ...availableUsers.map((u) => ({ id: u, label: u }))];

  const columns = [
    { key: 'sev', label: 'Status' },
    { key: 'db', label: 'Database' },
    { key: 'query', label: 'Query' },
    { key: 'avg', label: 'Avg time', align: 'right', sortable: true },
    { key: 'max', label: 'Max time', align: 'right', sortable: true },
    { key: 'execs', label: 'Executions', align: 'right', sortable: true },
    { key: 'rows', label: 'Rows', align: 'right', sortable: true },
    { key: 'first_seen', label: 'First seen', sortable: true },
    { key: 'last', label: 'Last seen', sortable: true },
    { key: 'user', label: 'User' },
    { key: 'actions', label: '' },
  ];

  const tableRows = pageRows.map((r, i) => ({
    // `query_id` alone isn't guaranteed unique here — the same digest id
    // (e.g. pg_stat_statements' queryid, Oracle's sql_id) can legitimately
    // repeat across different databases/schemas on one instance, which
    // produced React's "two children with the same key" warning when two
    // such rows landed on the same page. The row's position is always
    // unique, so it's folded into the key too.
    key: `${r.query_id || 'q'}-${i}`,
    onClick: () => navigate(`${engine.dashboardPath(id)}/slow-queries/detail`, { state: { row: r, raw: r._raw } }),
    cells: {
      sev: <SeverityBadge severity={r.severity} />,
      // Oracle has no separate database concept -- schema_name is the
      // real "which database" answer there, so it is the fallback rather
      // than an honest-but-unhelpful "No Database" on every single row.
      db: (r.database_name || r.schema_name)
        ? <Badge tone="accent" size="xs">{r.database_name || r.schema_name}</Badge>
        : <Badge tone="neutral" size="xs">No Database</Badge>,
      query: <SlowQuerySqlCell sql={r.query_text} />,
      avg: (
        <span className={
          r.severity === 'critical' ? 'font-mono font-bold text-danger-fg'
            : r.severity === 'high' ? 'font-mono font-bold text-warning-fg' : 'font-mono font-semibold'
        }>
          {fmtMs(r.average_execution_time)}
        </span>
      ),
      max: r.max_execution_time != null ? <span className="font-mono text-muted">{fmtMs(r.max_execution_time)}</span> : <span className="text-subtle">—</span>,
      execs: r.execution_count != null ? <span className="font-mono">{fmtNumber(r.execution_count)}</span> : <span className="text-subtle">—</span>,
      rows: (r.rows_returned ?? r.rows_affected) != null
        ? <span className="font-mono text-muted">{fmtNumber(r.rows_returned ?? r.rows_affected)}</span>
        : <span className="text-subtle">—</span>,
      first_seen: r.first_seen ? (
        <span className="whitespace-nowrap font-mono text-[11px] text-muted">{fmtDateTime(r.first_seen) || r.first_seen}</span>
      ) : <span className="text-subtle">—</span>,
      last: r.last_seen ? (
        <span className="whitespace-nowrap font-mono text-[11px] text-muted">{fmtDateTime(r.last_seen) || r.last_seen}</span>
      ) : <span className="text-subtle">—</span>,
      user: r.user_name ? <span className="font-mono text-[12px]">{r.user_name}</span> : <span className="text-subtle">—</span>,
      actions: (
        <span onClick={(e) => e.stopPropagation()}>
          <IconButton
            icon="chevron-right"
            label="View details"
            size="sm"
            onClick={() => navigate(`${engine.dashboardPath(id)}/slow-queries/detail`, { state: { row: r, raw: r._raw } })}
          />
        </span>
      ),
    },
  }));

  // A genuine configuration gap (collector unreachable/disabled, zero rows to
  // show either way) gets the exact required message, with whatever specific
  // fix ActMon already knows for this engine (Postgres's SetupGuidePanel)
  // underneath it — never fake data in its place.
  const notConfigured = data?.status === 'error' && total === 0
    && !(engine.setupGuide === 'pg_stat_statements' && data.pg_stat_statements_available === false);

  return (
    <div className="space-y-gutter">
      {engine.setupGuide === 'pg_stat_statements' && data?.pg_stat_statements_available === false && (
        <SetupGuidePanel id={id} engine={engine} onEnabled={refetch} />
      )}
      {notConfigured && <NotConfiguredNotice engine={engine} data={data} />}
      {error && (
        <Notice tone="danger" title="Could not load slow queries.">{error.message}</Notice>
      )}

      <TablePanel
        title="Slow queries"
        icon="zap"
        subtitle={engine.sourceLabel(data)}
        actions={(
          <>
            <Select value={queryType} onChange={setQueryType} options={QUERY_TYPE_FILTER_OPTIONS} size="sm" width="auto" />
            <Select value={minDuration} onChange={setMinDuration} options={DURATION_FILTERS} size="sm" width="auto" />
            <Select value={schema} onChange={setSchema} options={schemaOptions} size="sm" width="auto" />
            {availableUsers.length > 0 && (
              <Select value={userFilter} onChange={setUserFilter} options={userOptions} size="sm" width="auto" />
            )}
            <Select value={severity} onChange={setSeverity} options={SEVERITY_FILTER_OPTIONS} size="sm" width="auto" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onClear={() => setSearch('')}
              placeholder="Search query text…"
              icon="search"
              size="sm"
              wrapperClassName="w-44"
            />
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="h-control-sm rounded-control border border-border bg-surface px-2 text-[12px] text-fg"
            />
            <span className="text-[11px] text-subtle">to</span>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="h-control-sm rounded-control border border-border bg-surface px-2 text-[12px] text-fg"
            />
            <Button variant="ghost" size="sm" icon="refresh" loading={isFetching} onClick={() => refetch()} aria-label="Refresh" />
            <Badge tone="accent" size="xs">{fmtNumber(total)}</Badge>
          </>
        )}
      >
        <Table
          columns={columns}
          rows={tableRows}
          sort={sort}
          onSort={(key) => setSort((cur) => nextSort(cur, key))}
          loading={isFetching}
          empty={
            notConfigured ? (
              <EmptyState icon="zap" title={NOT_CONFIGURED_MESSAGE} body="No collector is reachable for this connection." />
            ) : (
              <EmptyState icon="zap" title="No slow queries match these filters"
                body="Try widening the duration floor, clearing the search, or picking a different database."
                action={<Button variant="primary" icon="refresh" onClick={() => refetch()}>Refresh now</Button>} />
            )
          }
        />
        {total > 0 && (
          <Pagination page={page} pageCount={pageCount} total={total} pageSize={pageSize} onPage={setPage} unit="queries" />
        )}
      </TablePanel>
    </div>
  );
}

function GenericSlowQueriesPage({ engine, id }) {
  const navigate = useNavigate();
  const nav = ENGINE_NAV[engine.key];
  return (
    <div className="flex min-h-full flex-col">
      {nav ? (
        <EngineDashboardHeader
          tech={engine.key}
          connectionId={id}
          tabs={nav.tabs}
          activeTab={nav.activeTab}
          onTabChange={(t) => {
            if (t === nav.activeTab) return;
            navigate(nav.tabRoute(id, t));
          }}
        />
      ) : (
        <PageHeader title={`${engine.label} Slow Queries`} icon="zap" backTo={engine.dashboardPath(id)} />
      )}
      <div className="space-y-1">
        <h1 className="text-lg font-black text-fg">Slow Queries</h1>
        <p className="text-xs text-subtle">{engine.label}</p>
      </div>
      <SlowQueryExplorer engine={engine} id={id} />
    </div>
  );
}

/* ── Main component ──────────────────────────────────────────────────────── */

export default function SlowQueriesPage({ tech }) {
  const engine = engineFor(tech);
  const { id } = useParams();

  if (!engine) {
    return (
      <>
        <PageHeader title="Slow Queries" icon="zap" />
        <Notice tone="danger" title="Unknown database technology.">{String(tech)}</Notice>
      </>
    );
  }

  // MySQL keeps its own focused page — the reference design every other
  // engine now matches via GenericSlowQueriesPage/SlowQueryExplorer above.
  if (engine.key === 'mysql') {
    return <MysqlSlowQueriesPage engine={engine} id={id} />;
  }

  return <GenericSlowQueriesPage engine={engine} id={id} />;
}
