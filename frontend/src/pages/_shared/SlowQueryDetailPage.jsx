import { useRef, useState } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import cn from '@/lib/cn';
import client from '@/api/client';
import PageHeader from '@/components/layout/PageHeader';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import CopyButton from '@/components/ui/CopyButton';
import Icon from '@/components/ui/Icon';
import Notice from '@/components/ui/Notice';
import Table, { EmptyState } from '@/components/ui/Table';
import { PageLoading, InlineLoading } from '@/components/ui/Loading';
import { Panel, SqlBlock, StatCell } from '@/pages/_shared/enginePanels';
import { fmtNumber, fmtDateTime } from '@/config/dbCatalog';
import { engineFor, fmtMs, SEVERITY_TONES, SEVERITY_LABELS } from '@/config/slowQueryCatalog';
import { SeverityBadge, AiAnalysisResult } from './SlowQueriesPage';
import PgQueryAnalysis from '@/pages/postgresql/PgQueryAnalysis';
import PlanDiagram from './PlanDiagram';
import PlanCanvas from './PlanCanvas';
import { ActionCard, InsightCard, MetricCard, SectionHead } from './queryAnalysisCards';
import QueryAnalysisScreen1 from './QueryAnalysisScreen1';
import QueryAnalysisResults from './QueryAnalysisResults';
import { planObjects, quickInsights } from './queryInsights';
import { pgTree, mysqlTree, oracleTree, mongoTree } from './planTree';

/**
 * One slow query's full analysis — the shared detail page every engine opens
 * into. Same order every time: the query and its cost, then its execution
 * plan (native to whichever engine this is), then AI analysis.
 *
 * The row arrives in router state from the list page. Postgres/MySQL/MSSQL/
 * Oracle can also refetch it by `query_id` on a direct link or reload (their
 * rows have a stable digest); ClickHouse's per-instance fallback and MongoDB
 * cannot — there is no way to recover which specific instance ran, so those
 * two show an honest "go back to the list" state instead of a broken re-fetch.
 */

function Step({ n, title, subtitle, children }) {
  return (
    <section>
      <div className="mb-gutter-sm flex items-center gap-3">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accent text-[12px] font-bold text-accent-fg">
          {n}
        </span>
        <div className="min-w-0">
          <h2 className="truncate-safe text-[15px] font-bold text-fg">{title}</h2>
          {subtitle && <p className="text-[12px] text-muted">{subtitle}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

/** Every engine's EXPLAIN-equivalent comes back a different shape — this
 * renders whichever one is genuinely there rather than forcing a common table
 * onto data that doesn't fit it. */
/** Renders whichever plan shape the engine returned. Exported because the
 *  Execution Plan page serves every engine, and only Oracle's shape has the
 *  dedicated canvas — the rest keep exactly the rendering they had. */
export function PlanResult({ data }) {
  const [view, setView] = useState('table'); // 'table' | 'diagram' — default matches today's behaviour exactly

  if (data.plan_error || data.error) {
    return <Notice tone="warning" title="The plan could not be read.">{data.plan_error || data.error}</Notice>;
  }

  // Postgres / MySQL shape: EXPLAIN (ANALYZE) node tree
  if (Array.isArray(data.nodes)) {
    if (!data.nodes.length) return <p className="text-[12px] text-subtle">No plan nodes returned.</p>;
    const tree = data.raw ? (pgTree(data.raw) || mysqlTree(data.raw)) : null;
    return (
      <div className="space-y-gutter-sm">
        <div className="flex flex-wrap items-center gap-2">
          {data.planning_time != null && <StatCellInline label="Planning time" value={fmtMs(data.planning_time)} />}
          {data.analyzed && data.execution_time != null && <StatCellInline label="Execution time" value={fmtMs(data.execution_time)} />}
          {!data.analyzed && (
            <Badge tone="warning" size="xs">Estimated plan — params replaced with NULL</Badge>
          )}
          {tree && <PlanViewToggle view={view} onChange={setView} className="ml-auto" />}
        </div>
        {view === 'diagram' && tree ? (
          <PlanDiagram tree={tree} />
        ) : (
          <Table
            columns={[
              { key: 'node', label: 'Node type' },
              { key: 'rel', label: 'Relation' },
              { key: 'r', label: data.analyzed ? 'Actual rows' : 'Est. rows', align: 'right' },
              { key: 't', label: data.analyzed ? 'Actual time' : 'Est. cost', align: 'right' },
            ]}
            rows={data.nodes.map((n, i) => ({
              key: i,
              cells: {
                node: (
                  <span className="font-mono text-[11px]">
                    {'  '.repeat(n.depth || 0)}{n.node_type}
                    {(String(n.node_type || '').includes('Seq Scan') || n.node_type === 'Table Scan') && (
                      <Badge tone="danger" size="xs" className="ml-1.5">full scan</Badge>
                    )}
                  </span>
                ),
                rel: <span className="font-mono text-[11px] text-muted">{n.relation || n.alias || '—'}</span>,
                r: <span className="font-mono">{fmtNumber(data.analyzed ? n.actual_rows : n.plan_rows)}</span>,
                t: <span className="font-mono">
                  {data.analyzed
                    ? (n.actual_total_time != null ? fmtMs(n.actual_total_time) : '—')
                    : (n.total_cost != null ? n.total_cost.toFixed(2) : '—')}
                </span>,
              },
            }))}
            empty={<EmptyState icon="terminal" title="No plan nodes" />}
          />
        )}
        {(data.hints || []).map((h, i) => (
          <Notice key={i} tone={h.level === 'critical' ? 'danger' : 'warning'} title={h.title}>
            {h.text}{h.fix && <span className="mt-0.5 block italic text-subtle">{h.fix}</span>}
          </Notice>
        ))}
      </div>
    );
  }

  // Oracle shape: v$sql_plan rows
  if (Array.isArray(data.plan) && data.plan.length && typeof data.plan[0] === 'object') {
    const tree = oracleTree(data.plan);
    return (
      <>
        <div className="mb-gutter-sm flex justify-end">
          {tree && <PlanViewToggle view={view} onChange={setView} />}
        </div>
        {view === 'diagram' && tree ? (
          /* The raw rows, not the normalised tree: the details panel shows
             every column v$sql_plan returned, and the tree adapter keeps only
             the four the old card had room for. */
          <PlanCanvas rows={data.plan} />
        ) : (
          <Table
            columns={[
              { key: 'op', label: 'Operation' },
              { key: 'obj', label: 'Object' },
              { key: 'cost', label: 'Cost', align: 'right' },
              { key: 'card', label: 'Cardinality', align: 'right' },
            ]}
            rows={data.plan.map((p, i) => ({
              key: p.id ?? i,
              cells: {
                op: <span className="font-mono text-[11px]">{'  '.repeat(p.depth || 0)}{p.operation} {p.options || ''}</span>,
                obj: p.object_name ? <span className="font-mono text-[11px] text-muted">{p.object_owner}.{p.object_name}</span> : null,
                cost: <span className="font-mono">{fmtNumber(p.cost)}</span>,
                card: <span className="font-mono">{fmtNumber(p.cardinality)}</span>,
              },
            }))}
            empty={<EmptyState icon="terminal" title="No plan rows" body="v$sql_plan has nothing for this sql_id — it may have aged out of the shared pool." />}
          />
        )}
        {(data.hints || []).map((h, i) => (
          <Notice key={i} tone={h.level === 'critical' ? 'danger' : 'warning'} title={h.title} className="mt-gutter-sm">
            {h.text}{h.fix && <span className="mt-0.5 block italic text-subtle">{h.fix}</span>}
          </Notice>
        ))}
      </>
    );
  }

  // ClickHouse shape: EXPLAIN PLAN text lines
  if (Array.isArray(data.plan)) {
    return (
      <div className="space-y-gutter-sm">
        <SqlBlock sql={(data.plan || []).join('\n') || '(empty plan)'} className="max-h-96 overflow-auto" />
        {(data.estimate || []).length > 0 && (
          <Panel title="Estimate" icon="info">
            <SqlBlock sql={JSON.stringify(data.estimate, null, 2)} className="max-h-60 overflow-auto" />
          </Panel>
        )}
      </div>
    );
  }

  // MongoDB shape: real .explain()
  if (data.query_planner || data.execution_stats) {
    const stats = data.execution_stats || {};
    const tree = mongoTree(data.query_planner);
    return (
      <div className="space-y-gutter-sm">
        <div className="flex flex-wrap items-center gap-2">
          {data.plan_summary && <Badge tone="accent">{data.plan_summary}</Badge>}
          {tree && <PlanViewToggle view={view} onChange={setView} className="ml-auto" />}
        </div>
        <div className="grid grid-cols-2 gap-gutter-sm sm:grid-cols-4">
          <StatCell label="Returned" value={fmtNumber(stats.nReturned)} />
          <StatCell label="Keys examined" value={fmtNumber(stats.totalKeysExamined)} />
          <StatCell label="Docs examined" value={fmtNumber(stats.totalDocsExamined)} />
          <StatCell label="Execution time" value={stats.executionTimeMillis != null ? fmtMs(stats.executionTimeMillis) : '—'} />
        </div>
        {view === 'diagram' && tree ? (
          <PlanDiagram tree={tree} />
        ) : (
          <Panel title="Query planner" icon="terminal">
            <SqlBlock sql={JSON.stringify(data.query_planner, null, 2)} className="max-h-72 overflow-auto" />
          </Panel>
        )}
      </div>
    );
  }

  return <p className="text-[12px] text-subtle">No plan data returned.</p>;
}

function PlanViewToggle({ view, onChange, className }) {
  return (
    <div className={cn('inline-flex rounded-control border border-border p-0.5', className)}>
      {[{ id: 'table', icon: 'list', label: 'Table' }, { id: 'diagram', icon: 'branch', label: 'Diagram' }].map((opt) => (
        <button
          key={opt.id}
          type="button"
          onClick={() => onChange(opt.id)}
          className={cn(
            'flex items-center gap-1.5 rounded-control px-2.5 py-1 text-[11px] font-semibold transition-colors',
            view === opt.id ? 'bg-accent text-accent-fg' : 'text-muted hover:bg-sunken',
          )}
        >
          <Icon name={opt.icon} size={12} />
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function StatCellInline({ label, value }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-card bg-sunken px-2.5 py-1 text-[11px]">
      <span className="text-subtle">{label}:</span>
      <span className="font-mono font-bold text-fg">{value}</span>
    </span>
  );
}

// EXPLAIN ANALYZE genuinely re-runs the query in full — for a query whose
// own average runtime is many seconds, that alone can take just as long,
// before the multi-database fallback probe this endpoint also does on top.
// The app's normal 30s default was never enough margin for that.
const PLAN_REQUEST_TIMEOUT_MS = 60_000;

/** Runs whichever engine's EXPLAIN-equivalent applies, on demand. */
/**
 * Sections 3 and 4: what the plan says about this query, and the facts around
 * it.
 *
 * The insights need the execution plan, and reading one is not free — for most
 * engines the "explain" call issues a statement against the server. So the
 * plan is read on request, not on arrival, and until then each card says so
 * rather than showing a zero that reads as "nothing found". Oracle is the
 * exception: its plan is a SELECT from v$sql_plan, which executes nothing.
 */
function QuickInsights({ engine, id, row, planState }) {
  const [ownPlan, setPlan] = useState(null); // null | {loading} | {rows} | {error}
  const plan = planState || ownPlan;
  const canRead = engine.hasExplain && (engine.key !== 'oracle' || !!row.query_id);

  const read = async () => {
    setPlan({ loading: true });
    try {
      if (engine.key !== 'oracle') throw new Error('Only Oracle plans are summarised here.');
      const res = await client
        .get(engine.api.explainSqlId(id, row.query_id), { timeout: PLAN_REQUEST_TIMEOUT_MS })
        .then((r) => r.data);
      if (res.status === 'error') throw new Error(res.error || 'The plan request failed.');
      setPlan({ rows: Array.isArray(res.plan) ? res.plan : [] });
    } catch (e) {
      setPlan({ error: e?.message || String(e) });
    }
  };

  // Reading v$sql_plan executes nothing, so for Oracle it happens on arrival.
  const [started, setStarted] = useState(false);
  if (!planState && engine.key === 'oracle' && canRead && !started) { setStarted(true); read(); }

  const rows = plan?.rows || [];
  const insights = quickInsights(rows);
  const objects = planObjects(rows);

  return (
    <>
      <Step n={3} title="Quick insights" subtitle="Key findings about this query, from its execution plan">
        {plan?.loading && <InlineLoading label="Reading the execution plan…" />}
        {plan?.error && (
          <Notice tone="warning" title="The plan could not be read, so these are unavailable.">
            {plan.error}
          </Notice>
        )}
        {!plan && !canRead && (
          <Notice tone="info" title="No plan available for this row.">
            {engine.hasExplain
              ? `This row carries no identifier ${engine.label} can look a plan up by.`
              : `${engine.label} exposes no execution plan through ActMon.`}
          </Notice>
        )}
        <div className={cn('grid gap-gutter-sm sm:grid-cols-2 xl:grid-cols-4', (plan?.loading || plan?.error) && 'mt-gutter-sm')}>
          <InsightCard icon="alert" label="Full table scans" count={insights.fullTableScans}
            note={insights.fullTableScans ? 'May impact performance' : 'None in this plan'} />
          <InsightCard icon="key" label="Missing indexes" count={insights.missingIndexes}
            note="Potential improvement" />
          <InsightCard icon="branch" label="Join operations" count={insights.joinOperations}
            goodWhenZero={false} note="Review join conditions" />
          {/* A cost is a magnitude, not a fault — it gets the neutral tone
              rather than the amber one a finding would carry. */}
          <InsightCard icon="gauge" label="Estimated cost" count={insights.estimatedCost}
            tone="accent" goodWhenZero={false} note="Optimizer estimate" />
        </div>
      </Step>

      <Step n={4} title="Related information" subtitle="Additional details about this statement">
        <div className="grid grid-cols-2 gap-gutter-sm sm:grid-cols-3 xl:grid-cols-5">
          <MetricCard compact icon="database" label="Schema"
            value={row.schema_name || row.database_name || null} />
          <MetricCard compact icon="table" label="Tables"
            value={objects ? objects.tables.length : null} />
          <MetricCard compact icon="boxes" label="Object types"
            value={objects && objects.types.length ? objects.types.join(', ') : null} />
          <MetricCard compact icon="type" label="Query type"
            value={(row.query_text || '').trim().split(/\s+/)[0]?.toUpperCase() || null} />
          <MetricCard compact icon="key" label="SQL id"
            value={row.query_id || null} />
        </div>
      </Step>
    </>
  );
}

/**
 * Fetch one plan, by whatever route this engine offers.
 *
 * Exported and shared with the Execution Plan page so there is ONE definition
 * of how a plan is requested per engine. Oracle reads v$sql_plan (a SELECT,
 * executing nothing); the others issue an EXPLAIN against the server, which is
 * why those stay behind an explicit action rather than running on arrival.
 */
export async function requestPlan(engine, id, row) {
  if (engine.key === 'oracle') {
    const sqlId = row.query_id;
    if (!sqlId) throw new Error('No sql_id on this row.');
    return client.get(engine.api.explainSqlId(id, sqlId), { timeout: PLAN_REQUEST_TIMEOUT_MS }).then((r) => r.data);
  }
  if (engine.key === 'mongodb') {
    const raw = row._raw || {};
    const [database, collection] = String(raw.ns || row.database_name || '').split('.', 2);
    return client.post(engine.api.explainOp(id), {
      database: database || row.database_name || 'admin',
      collection: collection || raw.collection || '',
      query_filter: (() => { try { return JSON.parse(raw.query || '{}'); } catch { return {}; } })(),
    }, { timeout: PLAN_REQUEST_TIMEOUT_MS }).then((r) => r.data);
  }
  return client.post(engine.api.explainSql(id), {
    sql_text: row.query_text,
    database: row.database_name,
    db_name: row.database_name,
  }, { timeout: PLAN_REQUEST_TIMEOUT_MS }).then((r) => r.data);
}

function PlanStep({ engine, id, row }) {
  const [state, setState] = useState(null); // null | {loading} | {data} | {error}

  const run = async () => {
    setState({ loading: true });
    try {
      let res;
      if (engine.key === 'oracle') {
        const sqlId = row.query_id;
        if (!sqlId) throw new Error('No sql_id on this row.');
        res = await client.get(engine.api.explainSqlId(id, sqlId), { timeout: PLAN_REQUEST_TIMEOUT_MS }).then((r) => r.data);
      } else if (engine.key === 'mongodb') {
        const raw = row._raw || {};
        const [database, collection] = String(raw.ns || row.database_name || '').split('.', 2);
        res = await client.post(engine.api.explainOp(id), {
          database: database || row.database_name || 'admin',
          collection: collection || raw.collection || '',
          query_filter: (() => { try { return JSON.parse(raw.query || '{}'); } catch { return {}; } })(),
        }, { timeout: PLAN_REQUEST_TIMEOUT_MS }).then((r) => r.data);
      } else {
        res = await client.post(engine.api.explainSql(id), {
          sql_text: row.query_text,
          database: row.database_name,
          db_name: row.database_name,
        }, { timeout: PLAN_REQUEST_TIMEOUT_MS }).then((r) => r.data);
      }
      if (res.status === 'error') throw new Error(res.error || 'The plan request failed.');
      setState({ data: res });
    } catch (e) {
      setState({ error: e?.message || String(e) });
    }
  };

  if (!engine.hasExplain) {
    return (
      <Notice tone="info" title="Not available for this engine yet.">
        Real execution-plan retrieval for {engine.label} is a planned follow-up.
      </Notice>
    );
  }

  return (
    <>
      {!state && (
        <Button variant="secondary" icon="terminal" onClick={run}>
          Run {engine.key === 'oracle' ? 'plan lookup' : engine.key === 'mongodb' ? 'explain()' : 'EXPLAIN'}
        </Button>
      )}
      {state?.loading && <InlineLoading label="Reading the plan…" />}
      {state?.error && (
        <>
          <Notice tone="danger" title="Plan request failed.">{state.error}</Notice>
          <Button variant="secondary" icon="refresh" onClick={run}>Try again</Button>
        </>
      )}
      {state?.data && (
        <>
          <PlanResult data={state.data} />
          <Button variant="secondary" icon="refresh" size="sm" className="mt-gutter-sm" onClick={run}>Re-run</Button>
        </>
      )}
    </>
  );
}

/* ── MySQL analysis workspace ─────────────────────────────────────────────
 * §4-12 of the Slow Query spec: EXPLAIN → execution-plan analysis → tables
 * used → indexes used → missing/duplicate index analysis → statistics →
 * performance diagnosis → Groq explanation → prioritized recommendations →
 * optional query rewrite. One `analyze-full` call gathers everything
 * deterministic in one pass (so EXPLAIN only ever runs once per click, not
 * once per section); the Groq call is a SEPARATE, explicitly user-triggered
 * step so opening a query never blocks on an LLM round-trip. MySQL-only for
 * now (`engine.hasFullAnalysis`) — every other engine keeps the simpler
 * PlanStep/AI flow above, unchanged. */

function IssueSeverityBadge({ severity }) {
  const s = String(severity || 'low').toLowerCase();
  return <Badge tone={SEVERITY_TONES[s] || 'neutral'} size="xs">{SEVERITY_LABELS[s] || severity}</Badge>;
}

function ExecutionPlanSection({ data, mode, onRunAnalyze, analyzing }) {
  const explain = data.explain || {};
  const flags = explain.flags || {};
  const declined = explain.analyze_declined_reason;

  return (
    <Panel title="Execution plan" icon="terminal"
      subtitle={mode === 'analyze' ? 'Actual execution plan — the statement was really run' : 'Estimated plan — the statement was NOT executed'}
      actions={mode !== 'analyze' && (
        <Button variant="secondary" size="sm" icon="play" loading={analyzing} onClick={onRunAnalyze}>
          Run EXPLAIN ANALYZE
        </Button>
      )}
    >
      <div className="space-y-gutter-sm">
        {declined && (
          <Notice tone="info" title="EXPLAIN ANALYZE was not run.">{declined} Showing the estimated plan instead.</Notice>
        )}
        <div className="flex flex-wrap items-center gap-1.5">
          {flags.has_full_scan && <Badge tone="danger" size="xs">Full table scan</Badge>}
          {flags.has_full_index_scan && <Badge tone="warning" size="xs">Full index scan</Badge>}
          {flags.has_ignored_index && <Badge tone="warning" size="xs">Available index ignored</Badge>}
          {flags.has_filesort && <Badge tone="warning" size="xs">Filesort</Badge>}
          {flags.has_temp_table && <Badge tone="warning" size="xs">Temporary table</Badge>}
          {flags.has_dedup && <Badge tone="neutral" size="xs">Duplicate removal</Badge>}
          {Object.keys(flags).length === 0 && <span className="text-[12px] text-subtle">No warning flags in this plan.</span>}
        </div>
        <Table
          columns={[
            { key: 'table', label: 'Table' },
            { key: 'type', label: 'Access type' },
            { key: 'possible', label: 'Possible keys' },
            { key: 'key', label: 'Key used' },
            { key: 'len', label: 'Key length', align: 'right' },
            { key: 'rows', label: mode === 'analyze' ? 'Rows examined' : 'Est. rows', align: 'right' },
            { key: 'filtered', label: 'Filtered %', align: 'right' },
            { key: 'extra', label: 'Extra' },
          ]}
          rows={(explain.tables || []).map((t, i) => ({
            key: i,
            cells: {
              table: <span className="font-mono text-[11px] font-semibold">{t.table_name}</span>,
              type: (
                <span className="font-mono text-[11px]">
                  {t.access_type}
                  {t.access_type === 'ALL' && <Badge tone="danger" size="xs" className="ml-1.5">scan</Badge>}
                </span>
              ),
              possible: <span className="font-mono text-[10px] text-muted">{(t.possible_keys || []).join(', ') || '—'}</span>,
              key: t.key
                ? <span className="font-mono text-[11px] text-success-fg">{t.key}</span>
                : <span className="font-mono text-[11px] text-danger-fg">none</span>,
              len: <span className="font-mono text-muted">{t.key_length ?? '—'}</span>,
              rows: <span className="font-mono">{fmtNumber(t.rows_examined_per_scan)}</span>,
              filtered: <span className="font-mono">{t.filtered != null ? `${t.filtered}%` : '—'}</span>,
              extra: (
                <span className="flex flex-wrap gap-1">
                  {t.using_index && <Badge tone="success" size="xs">using index</Badge>}
                  {t.using_where && <Badge tone="neutral" size="xs">using where</Badge>}
                  {t.using_join_buffer && <Badge tone="warning" size="xs">join buffer</Badge>}
                </span>
              ),
            },
          }))}
          empty={<EmptyState icon="terminal" title="No plan rows" />}
        />
      </div>
    </Panel>
  );
}

function TablesIndexesSection({ data }) {
  const tables = data.tables || [];
  const duplicates = data.duplicate_indexes || [];
  const coverage = data.index_coverage || [];

  if (!tables.length) {
    return (
      <Panel title="Tables & indexes" icon="database">
        <p className="text-[12px] text-subtle">No table metadata could be resolved for this query's tables.</p>
      </Panel>
    );
  }

  return (
    <Panel title="Tables & indexes" icon="database" subtitle="Real metadata from information_schema, scoped to this query's own tables">
      <div className="space-y-gutter">
        {tables.map((t) => {
          const dupesHere = duplicates.filter((d) => d.table_name === t.table_name);
          const coverageHere = coverage.filter((c) => c.table_name === t.table_name);
          return (
            <div key={t.table_name} className="rounded-card border border-border p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-[13px] font-bold text-fg">{t.table_name}</p>
                  <p className="text-[11px] text-muted">
                    {t.engine || '—'} · {fmtNumber(t.row_estimate)} rows (approx.) · {t.total_mb != null ? `${t.total_mb} MB` : '—'}
                    {t.primary_key?.length ? ` · PK: ${t.primary_key.join(', ')}` : ''}
                  </p>
                </div>
              </div>

              {t.columns?.length > 0 && (
                <>
                  <p className="mb-1.5 text-[10px] font-bold tracking-wide text-subtle uppercase">Table structure</p>
                  <Table
                    className="mb-3"
                    columns={[
                      { key: 'name', label: 'Column' },
                      { key: 'type', label: 'Type' },
                      { key: 'nullable', label: 'Nullable' },
                    ]}
                    rows={t.columns.map((c) => ({
                      key: c.name,
                      cells: {
                        name: (
                          <span className="font-mono text-[11px]">
                            {c.name}
                            {t.primary_key?.includes(c.name) && <Badge tone="accent" size="xs" className="ml-1.5">PK</Badge>}
                          </span>
                        ),
                        type: <span className="font-mono text-[11px] text-muted">{c.type}</span>,
                        nullable: c.nullable ? <span className="text-subtle">yes</span> : <Badge tone="neutral" size="xs">not null</Badge>,
                      },
                    }))}
                    empty={<EmptyState icon="database" title="No column metadata" />}
                  />
                </>
              )}

              <p className="mb-1.5 text-[10px] font-bold tracking-wide text-subtle uppercase">Existing indexes</p>
              <Table
                columns={[
                  { key: 'name', label: 'Index' },
                  { key: 'cols', label: 'Columns' },
                  { key: 'unique', label: 'Unique' },
                  { key: 'card', label: 'Cardinality', align: 'right' },
                ]}
                rows={(t.indexes || []).map((idx) => ({
                  key: idx.index_name,
                  cells: {
                    name: (
                      <span className="font-mono text-[11px]">
                        {idx.index_name}
                        {idx.primary && <Badge tone="accent" size="xs" className="ml-1.5">PK</Badge>}
                      </span>
                    ),
                    cols: <span className="font-mono text-[11px] text-muted">{idx.columns.join(', ')}</span>,
                    unique: idx.unique ? <Badge tone="success" size="xs">unique</Badge> : <span className="text-subtle">—</span>,
                    card: <span className="font-mono">{fmtNumber(idx.cardinality)}</span>,
                  },
                }))}
                empty={<EmptyState icon="database" title="No indexes found on this table" />}
              />

              {dupesHere.length > 0 && (
                <div className="mt-2 space-y-1.5">
                  {dupesHere.map((d, i) => (
                    <Notice key={i} tone="warning" title={`\`${d.redundant_index}\` may be redundant`}>
                      Its columns ({d.columns.join(', ')}) are a leading prefix of `{d.covered_by}` ({d.covered_columns.join(', ')}).
                      <div className="mt-1.5 flex items-center gap-2">
                        <SqlBlock sql={d.drop_statement} className="flex-1" />
                        <CopyButton text={d.drop_statement} />
                      </div>
                    </Notice>
                  ))}
                </div>
              )}

              {coverageHere.map((c, i) => (
                <Notice key={i} tone={c.verdict === 'covered' ? 'success' : 'info'} className="mt-2"
                  title={c.verdict === 'covered' ? 'Existing index already covers this query' : 'No existing index covers this'}>
                  {c.explanation}
                </Notice>
              ))}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

function DiagnosisSection({ data }) {
  const issues = data.diagnosis?.issues || [];
  return (
    <Panel title={`Performance diagnosis (${issues.length})`} icon="alert"
      subtitle="Every issue below is backed by a specific signal from the plan or metadata above — nothing is flagged just because it exists">
      {issues.length === 0 ? (
        <p className="text-[12px] text-success-fg">No rule-based issues detected from this plan and metadata.</p>
      ) : (
        <ul className="space-y-2.5">
          {issues.map((is, i) => (
            <li key={i} className="rounded-card border border-border p-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <IssueSeverityBadge severity={is.severity} />
                <span className="font-mono text-[11px] font-bold text-fg">{is.type}</span>
                {is.table && <Badge tone="neutral" size="xs">{is.table}</Badge>}
              </div>
              <p className="mt-1 text-[12px] text-fg">{is.description}</p>
              <p className="mt-0.5 text-[11px] text-subtle">Evidence: {is.evidence}</p>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function RecommendationsSection({ ai, onRunAi }) {
  const a = ai?.result;
  return (
    <Panel title="ActMon AI analysis & recommendations" icon="brain"
      subtitle="Reasons only from the evidence gathered above — the query, plan, real table/index metadata, coverage check, and diagnosis">
      {!ai && (
        <Button variant="primary" icon="brain" onClick={onRunAi}>Get AI explanation & recommendations</Button>
      )}
      {ai?.loading && <InlineLoading label="Analysing with the evidence gathered above…" />}
      {ai?.err && (
        <>
          <Notice tone="danger" title="Analysis failed.">{ai.err}</Notice>
          <Button variant="secondary" icon="refresh" onClick={onRunAi}>Try again</Button>
        </>
      )}
      {a && (
        <div className="space-y-gutter-sm">
          {a.summary && <p className="text-[13px] text-fg"><b>Summary:</b> {a.summary}</p>}
          {a.root_cause && (
            <Panel title="Root cause" icon="info"><p className="text-[12px] text-fg">{a.root_cause}</p></Panel>
          )}

          {(a.recommendations || []).length > 0 && (
            <Panel title={`Recommendations (${a.recommendations.length})`} icon="check">
              <div className="space-y-gutter-sm">
                {a.recommendations.map((r, i) => (
                  <div key={i} className="rounded-card border border-border p-3">
                    <div className="mb-1.5 flex items-center gap-2">
                      <IssueSeverityBadge severity={r.priority} />
                      <span className="text-[13px] font-bold text-fg">{r.problem}</span>
                    </div>
                    <p className="text-[12px] text-muted"><b>Evidence:</b> {r.evidence}</p>
                    <p className="mt-1 text-[12px] text-fg"><b>Recommendation:</b> {r.recommendation}</p>
                    <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-subtle">
                      {r.expected_benefit && <span><b className="text-success-fg">Expected benefit:</b> {r.expected_benefit}</span>}
                      {r.risk && <span><b className="text-warning-fg">Risk:</b> {r.risk}</span>}
                    </div>
                    {r.existing_index_considered && r.existing_index_considered !== 'none applicable' && (
                      <p className="mt-1 text-[11px] text-subtle"><b>Existing index considered:</b> {r.existing_index_considered}</p>
                    )}
                    {r.example && (
                      <div className="mt-1.5 flex items-start gap-2">
                        <SqlBlock sql={r.example} className="flex-1" />
                        <CopyButton text={r.example} />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </Panel>
          )}

          {a.query_rewrite?.applicable && a.query_rewrite.optimized_sql && (
            <Panel title="Query rewrite" icon="terminal" subtitle="Optional — nothing is changed automatically">
              <div className="space-y-2">
                <div>
                  <p className="mb-1 text-[11px] font-bold tracking-wide text-subtle uppercase">Suggested query</p>
                  <div className="flex items-start gap-2">
                    <SqlBlock sql={a.query_rewrite.optimized_sql} className="flex-1" />
                    <CopyButton text={a.query_rewrite.optimized_sql} />
                  </div>
                </div>
                {(a.query_rewrite.changes_made || []).length > 0 && (
                  <ul className="ml-4 list-disc space-y-0.5 text-[12px] text-fg">
                    {a.query_rewrite.changes_made.map((c, i) => <li key={i}>{c}</li>)}
                  </ul>
                )}
                {a.query_rewrite.explanation && <p className="text-[11px] text-subtle">{a.query_rewrite.explanation}</p>}
              </div>
            </Panel>
          )}

          {(a.risks_and_testing || []).length > 0 && (
            <Panel title="Test before production" icon="shield">
              <ul className="ml-4 list-disc space-y-1 text-[12px] text-fg">
                {a.risks_and_testing.map((r, i) => <li key={i}>{r}</li>)}
              </ul>
            </Panel>
          )}

          {a.estimated_overall_improvement && (
            <p className="text-[12px] text-muted"><b>Estimated overall improvement:</b> {a.estimated_overall_improvement}</p>
          )}

          <Button variant="secondary" icon="refresh" size="sm" onClick={onRunAi}>Re-analyse</Button>
        </div>
      )}
    </Panel>
  );
}

function MysqlAnalysisWorkspace({ engine, id, row }) {
  const [analysis, setAnalysis] = useState(null); // null | {loading} | {data} | {error}
  const [ai, setAi] = useState(null);

  const runAnalysis = async (mode) => {
    setAnalysis({ loading: true });
    try {
      const res = await client.post(engine.api.analyzeFull(id), {
        sql_text: row.query_text,
        db_name: row.database_name,
        mode,
        rows_examined: row._raw?.rows_examined ?? row.rows_affected ?? 0,
        rows_returned: row.rows_returned ?? 0,
        count_calls: row.execution_count ?? 0,
        avg_exec_ms: row.average_execution_time ?? 0,
        total_exec_ms: row.total_execution_time ?? 0,
      }).then((r) => r.data);
      if (res.status !== 'success') throw new Error(res.error || 'Analysis failed.');
      setAnalysis({ data: res });
    } catch (e) {
      setAnalysis({ error: e?.message || String(e) });
    }
  };

  const runAi = async () => {
    setAi({ loading: true });
    try {
      const payload = engine.buildAiPayload(row, row._raw);
      const res = await client.post(engine.api.analyzeContext(id), { ...payload, analysis: analysis?.data || {} }).then((r) => r.data);
      setAi(res.status === 'success' ? { result: res.analysis } : { err: res.error || 'The analyser returned no result.' });
    } catch (e) {
      setAi({ err: e?.message || String(e) });
    }
  };

  return (
    <div className="space-y-gutter">
      {!analysis && (
        <Button variant="primary" size="lg" icon="terminal" onClick={() => runAnalysis('estimate')}>
          Run analysis
        </Button>
      )}
      {analysis?.loading && <InlineLoading label="Running EXPLAIN and gathering table/index metadata…" />}
      {analysis?.error && (
        <>
          <Notice tone="danger" title="Analysis failed.">{analysis.error}</Notice>
          <Button variant="secondary" icon="refresh" onClick={() => runAnalysis('estimate')}>Try again</Button>
        </>
      )}
      {analysis?.data && (
        <>
          <ExecutionPlanSection
            data={analysis.data}
            mode={analysis.data.explain?.mode || 'estimate'}
            analyzing={analysis.loading}
            onRunAnalyze={() => runAnalysis('analyze')}
          />
          <TablesIndexesSection data={analysis.data} />
          <DiagnosisSection data={analysis.data} />
          <RecommendationsSection ai={ai} onRunAi={runAi} />
        </>
      )}
    </div>
  );
}

export default function SlowQueryDetailPage({ tech }) {
  const engine = engineFor(tech);
  const { id } = useParams();
  const navigate = useNavigate();
  const { state } = useLocation();
  const [ai, setAi] = useState(null);

  // A caller outside the slow-query list (Performance) passes its own page as
  // `backTo`, so Back returns there instead of to the Slow Queries list.
  const backTo = state?.backTo || (engine ? `${engine.dashboardPath(id)}/slow-queries` : '/databases');
  const routerRow = state?.row;
  const canRefetch = !!(engine?.api.byId && routerRow?.query_id);

  /* A direct link or a page reload has no router state — refetch by query_id
     for the four digest-based engines; ClickHouse's per-instance fallback and
     MongoDB have no stable id to look up, so they fall through to the "go
     back" state below rather than pretending a reload can recover the row. */
  const { data: refetched, isLoading: refetching } = useQuery({
    queryKey: ['slowQueryById', tech, id, routerRow?.query_id],
    queryFn: () => client.get(engine.api.byId(id, routerRow.query_id)).then((r) => r.data),
    enabled: !routerRow && canRefetch,
    retry: false,
  });

  /* Refresh re-reads the statement by id (when the engine has one), and the
     newer figures replace the ones handed over by the list. */
  const [freshRow, setFreshRow] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const row = freshRow || routerRow || refetched?.query;
  const refreshRow = async () => {
    if (!engine?.api.byId || !row?.query_id) return;
    setRefreshing(true);
    try {
      const r = await client.get(engine.api.byId(id, row.query_id)).then((x) => x.data);
      if (r?.query) setFreshRow({ ...r.query, _raw: r.query._raw ?? row._raw });
    } catch { /* keep the figures on screen */ } finally { setRefreshing(false); }
  };

  /* Oracle: the statement's own plan (V$SQL_PLAN executes nothing), read once
     and shared by the statistics cards and Quick insights. */
  const planQ = useQuery({
    queryKey: ['qaPlan', id, row?.query_id],
    queryFn: async () => {
      const res = await client.get(engine.api.explainSqlId(id, row.query_id), { timeout: PLAN_REQUEST_TIMEOUT_MS }).then((r) => r.data);
      if (res.status === 'error') throw new Error(res.error || 'The plan request failed.');
      return Array.isArray(res.plan) ? res.plan : [];
    },
    enabled: !!(engine?.key === 'oracle' && row?.query_id),
    retry: false,
    staleTime: 60000,
  });
  /* Analyze (Oracle): reads keyed by the captured SQL_ID, run together. The
     results screen opens only when the plan was read. */
  const qc = useQueryClient();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const view = searchParams.get('view');
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState(null);
  const [trendHours, setTrendHours] = useState(24);
  const sqlRef = useRef(null);
  const sqlId = row?.query_id;
  const oracleApi = (path, params) => client.get(`/connections/oracle/${id}/${path}`, { params, timeout: PLAN_REQUEST_TIMEOUT_MS }).then((r) => r.data);
  const resKeys = {
    detail: ['qaDetail', id, sqlId],
    stats: ['qaPlanStats', id, sqlId],
    trend: ['qaTrend', id, sqlId, trendHours],
    top: ['qaTopSql', id],
  };
  const detailQ = useQuery({ queryKey: resKeys.detail, queryFn: () => oracleApi('oracle-sql-detail', { sql_id: sqlId }), enabled: false, retry: false, staleTime: 60000 });
  const statsQ = useQuery({ queryKey: resKeys.stats, queryFn: () => oracleApi('oracle-sql-plan-stats', { sql_id: sqlId }), enabled: false, retry: false, staleTime: 60000 });
  const trendQ = useQuery({ queryKey: resKeys.trend, queryFn: () => oracleApi('oracle-sql-trend', { sql_id: sqlId, hours: trendHours }), enabled: view === 'results' && !!sqlId, retry: false, staleTime: 60000 });
  const topQ = useQuery({ queryKey: resKeys.top, queryFn: () => oracleApi('oracle-top-sql'), enabled: false, retry: false, staleTime: 60000 });
  const haveResults = !!(planQ.data && detailQ.data);

  const runAnalysis = async (focus) => {
    setAnalyzing(true);
    setAnalyzeError(null);
    try {
      const [plan] = await Promise.all([
        planQ.data ? Promise.resolve(planQ.data) : planQ.refetch({ throwOnError: true }).then((r) => { if (r.error) throw r.error; return r.data; }),
        qc.fetchQuery({ queryKey: resKeys.detail, queryFn: () => oracleApi('oracle-sql-detail', { sql_id: sqlId }), staleTime: 60000 }),
      ]);
      await Promise.allSettled([
        qc.fetchQuery({ queryKey: resKeys.stats, queryFn: () => oracleApi('oracle-sql-plan-stats', { sql_id: sqlId }), staleTime: 60000 }),
        qc.fetchQuery({ queryKey: resKeys.top, queryFn: () => oracleApi('oracle-top-sql'), staleTime: 60000 }),
      ]);
      if (!plan || !plan.length) throw new Error('Oracle returned no plan for this SQL ID — the cursor may have aged out of the shared pool.');
      // Keep the edited text on this history entry, then open the results.
      navigate(`${location.pathname}`, { replace: true, state: { ...(state || {}), row, sql: sqlRef.current } });
      navigate(`${location.pathname}?view=results${focus ? `#${focus}` : ''}`, { state: { ...(state || {}), row, sql: sqlRef.current } });
    } catch (e) {
      setAnalyzeError(e?.response?.data?.detail ? JSON.stringify(e.response.data.detail) : (e?.message || String(e)));
    } finally {
      setAnalyzing(false);
    }
  };

  const planState = engine?.key === 'oracle'
    ? (planQ.isLoading ? { loading: true } : planQ.error ? { error: planQ.error.message } : planQ.data ? { rows: planQ.data } : null)
    : null;

  if (!engine) {
    return <><PageHeader title="Query Analysis" icon="zap" /><Notice tone="danger" title="Unknown database technology.">{String(tech)}</Notice></>;
  }

  if (!row) {
    if (!routerRow && canRefetch && refetching) {
      return <><PageHeader title="Query Analysis" icon="zap" backTo={backTo} /><PageLoading title="Loading query…" /></>;
    }
    return (
      <>
        <PageHeader title="Query Analysis" icon="zap" backTo={backTo} />
        <Notice tone="info" title="No query selected.">
          This page analyses one statement handed to it by the slow-queries list.
          {engine.api.byId
            ? ' It could not be found in the current slow-query window — it may have aged out.'
            : ` ${engine.label} has no stable per-query id to recover after a reload, so this page only works when opened from the list.`}
        </Notice>
        <Button variant="primary" iconRight="chevron-right" onClick={() => navigate(backTo)}>
          Open slow queries
        </Button>
      </>
    );
  }

  const sql = row.query_text || '';

  const runAi = async (editedSql = null) => {
    setAi({ loading: true });
    try {
      // Screen 1's editor can send an edited statement; the cost figures
      // stay the captured statement's.
      const payload = engine.buildAiPayload(editedSql ? { ...row, query_text: editedSql } : row, row._raw);
      if (editedSql && 'sql_text' in payload) payload.sql_text = editedSql;
      const res = await client.post(engine.api.analyzeGroq(id), payload).then((r) => r.data);
      setAi(res.status === 'success' ? { result: res.analysis } : { err: res.error || 'The analyser returned no result.' });
    } catch (e) {
      setAi({ err: e?.message || String(e) });
    }
  };

  if (!engine.hasPgWorkspace && !engine.hasFullAnalysis && engine.key === 'oracle' && view === 'results') {
    if (!haveResults) {
      // A results URL opened directly (or refreshed): read the results again.
      if (!analyzing && !analyzeError && sqlId) setTimeout(() => runAnalysis(), 0);
      return (
        <div className="space-y-gutter">
          {analyzeError ? (
            <Notice tone="danger" title="Analysis could not be completed.">
              {analyzeError}
              <div className="mt-2 flex gap-2">
                <Button variant="secondary" icon="refresh" onClick={() => runAnalysis()}>Retry</Button>
                <Button variant="secondary" icon="arrow-left" onClick={() => navigate(location.pathname, { state })}>Back to the query</Button>
              </div>
            </Notice>
          ) : <PageLoading title="Analyzing…" />}
        </div>
      );
    }
    return (
      <QueryAnalysisResults
        engine={engine} id={id} row={row}
        sql={state?.sql ?? row.query_text ?? ''}
        results={{ plan: planQ.data || [], planStats: statsQ.data, detail: detailQ.data, trend: trendQ.data, topSql: topQ.data }}
        onBack={() => navigate(-1)}
        onRefresh={() => { planQ.refetch(); detailQ.refetch(); statsQ.refetch(); trendQ.refetch(); topQ.refetch(); }}
        refreshing={planQ.isFetching || detailQ.isFetching || statsQ.isFetching || trendQ.isFetching || topQ.isFetching}
        trendHours={trendHours} onTrendHours={setTrendHours}
      />
    );
  }

  if (!engine.hasPgWorkspace && !engine.hasFullAnalysis) {
    const oracle = engine.key === 'oracle';
    return (
      <div className="space-y-gutter">
        <QueryAnalysisScreen1
          key={row.query_id || row.query_text}
          engine={engine} id={id} row={row} backTo={backTo}
          ai={ai}
          initialSql={state?.sql}
          onSqlChange={(v) => { sqlRef.current = v; }}
          analyzing={analyzing}
          analyzeError={analyzeError}
          onRetry={() => runAnalysis()}
          onAnalyze={oracle
            ? (text, edited) => (edited
              ? setAnalyzeError('Analyze reads the captured statement’s plan and statistics from Oracle by its SQL ID, and an edited statement has no cursor yet. ACTMON does not run EXPLAIN PLAN on text typed in the browser. Undo the edits to analyse the captured statement, or use "Analyse this query" for an AI reading of the edited text.')
              : runAnalysis())
            : (text, edited) => runAi(edited ? text : null)}
          onAi={(text, edited) => runAi(edited ? text : null)}
          onRefresh={refreshRow} refreshing={refreshing}
          onPlan={oracle
            ? () => (haveResults ? navigate(`${location.pathname}?view=results#qa-plan`, { state: { ...(state || {}), row, sql: sqlRef.current } }) : runAnalysis('qa-plan'))
            : () => navigate(`${engine.dashboardPath(id)}/slow-queries/plan`, { state: { row } })}
          planState={planState}
        />
        {ai?.err && (
          <div>
            <Notice tone="danger" title="Analysis failed.">{ai.err}</Notice>
            <Button variant="secondary" icon="refresh" onClick={() => runAi()}>Try again</Button>
          </div>
        )}
        {ai?.result && <AiAnalysisResult a={ai.result} />}
        <QuickInsights engine={engine} id={id} row={row} planState={planState} />
      </div>
    );
  }

  return (
    <>
      <PageHeader
        title="Query Analysis"
        description="Cost, then the execution plan, then how to make it faster"
        icon="zap"
        backTo={backTo}
        actions={(
          <div className="flex items-center gap-2">
            {row.query_type && (
              <Badge tone={row.query_type === 'actmon' ? 'warning' : 'neutral'}>
                {row.query_type === 'actmon' ? 'ActMon Query' : 'System Query'}
              </Badge>
            )}
            {(row.database_name || row.schema_name) && (
              <Badge tone="accent">{row.database_name || row.schema_name}</Badge>
            )}
          </div>
        )}
      />

      {engine.hasPgWorkspace ? (
        <PgQueryAnalysis engine={engine} id={id} row={row} />
      ) : (
      <div className="space-y-gutter">
        <Step n={1} title="The query" subtitle="What it is and what it costs today">
          {/* The card scrolls in both directions rather than wrapping: a long
              statement stays readable line by line, and the Copy button keeps
              the whole text whatever is on screen. */}
          <div className="flex items-start gap-2">
            <SqlBlock sql={sql || '(empty)'} className="max-h-60 flex-1 overflow-auto" />
            <CopyButton text={sql} />
          </div>

          {/* The five figures the reference leads with, then whatever else this
              engine actually reports — a column no engine fills is not shown
              rather than printed as a dash. */}
          <div className="mt-gutter-sm grid grid-cols-2 gap-gutter-sm sm:grid-cols-3 xl:grid-cols-5">
            <MetricCard icon="alert" label="Severity"
              tone={row.severity === 'critical' ? 'danger' : row.severity === 'high' ? 'warning' : 'success'}
              value={<SeverityBadge severity={row.severity} />} />
            <MetricCard icon="clock" label={row.execution_count != null ? 'Avg time' : 'Duration'}
              tone={row.severity === 'critical' ? 'danger' : row.severity === 'high' ? 'warning' : 'accent'}
              value={fmtMs(row.average_execution_time)} />
            <MetricCard icon="activity" label="Executions"
              value={row.execution_count == null ? null : fmtNumber(row.execution_count)} />
            <MetricCard icon="trend" label="Rows sent"
              value={row.rows_returned == null ? null : fmtNumber(row.rows_returned)} />
            <MetricCard icon="calendar" label="Last seen"
              value={row.last_seen ? (fmtDateTime(row.last_seen) || row.last_seen) : null} />
          </div>
          {(row.max_execution_time != null || row.rows_affected != null || row.user_name || row.host || row.first_seen) && (
            <div className="mt-gutter-sm grid grid-cols-2 gap-gutter-sm sm:grid-cols-3 xl:grid-cols-5">
              {row.max_execution_time != null && <MetricCard compact icon="clock" label="Max time" value={fmtMs(row.max_execution_time)} tone="neutral" />}
              {row.rows_affected != null && <MetricCard compact icon="rows" label="Rows examined" value={fmtNumber(row.rows_affected)} tone="neutral" />}
              {row.user_name && <MetricCard compact icon="user" label="User" value={row.user_name} tone="neutral" />}
              {row.host && <MetricCard compact icon="server" label="Host" value={row.host} tone="neutral" />}
              {row.first_seen && <MetricCard compact icon="calendar" label="First seen" value={fmtDateTime(row.first_seen) || row.first_seen} tone="neutral" />}
            </div>
          )}
        </Step>

        {engine.hasFullAnalysis ? (
          <Step n={2} title="Analysis workspace"
            subtitle="EXPLAIN, then tables, indexes, and a rule-based diagnosis — one pass, run on demand">
            <MysqlAnalysisWorkspace engine={engine} id={id} row={row} />
          </Step>
        ) : (
          <>
            <Step n={2} title="What's next?" subtitle="Analyse the execution plan and get recommendations">
              <div className="grid gap-gutter-sm lg:grid-cols-3">
                {/* Only offered where a plan can actually be fetched for this
                    row — a card that leads to "no sql_id" is worse than none. */}
                {engine.hasExplain && (
                  <ActionCard
                    tone="primary"
                    icon="branch"
                    title="View execution plan"
                    body="See the complete execution plan, as a diagram and as a table."
                    disabled={engine.key === 'oracle' && !row.query_id}
                    onClick={() => navigate(`${engine.dashboardPath(id)}/slow-queries/plan`, { state: { row } })}
                  />
                )}
                <ActionCard
                  tone="success"
                  icon="brain"
                  title="Analyse this query"
                  body="Read the statement together with its cost figures and suggest improvements."
                  busy={ai?.loading}
                  onClick={runAi}
                />
                {/* Shown only for engines that genuinely have a comparison
                    workspace; the others would be a card with nowhere to go. */}
                {engine.key === 'oracle' && (
                  <ActionCard
                    tone="accent"
                    icon="layers"
                    title="Compare & tune"
                    body="Open Top SQL, where this statement sits beside its plan history."
                    onClick={() => navigate(`${engine.dashboardPath(id)}/sql`)}
                  />
                )}
              </div>

              {ai?.loading && <div className="mt-gutter-sm"><InlineLoading label="Analysing…" /></div>}
              {ai?.err && (
                <div className="mt-gutter-sm">
                  <Notice tone="danger" title="Analysis failed.">{ai.err}</Notice>
                  <Button variant="secondary" icon="refresh" onClick={runAi}>Try again</Button>
                </div>
              )}
              {ai?.result && (
                <div className="mt-gutter-sm">
                  <AiAnalysisResult a={ai.result} />
                  <Button variant="secondary" icon="refresh" className="mt-gutter-sm" onClick={runAi}>Re-analyse</Button>
                </div>
              )}
            </Step>

            <QuickInsights engine={engine} id={id} row={row} />
          </>
        )}
      </div>
      )}
    </>
  );
}
