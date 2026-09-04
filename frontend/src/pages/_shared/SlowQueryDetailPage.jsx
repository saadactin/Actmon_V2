import { useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
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
import PgHintPlanPanel from '@/pages/postgresql/PgHintPlanPanel';

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
function PlanResult({ data }) {
  if (data.plan_error || data.error) {
    return <Notice tone="warning" title="The plan could not be read.">{data.plan_error || data.error}</Notice>;
  }

  // Postgres / MySQL shape: EXPLAIN (ANALYZE) node tree
  if (Array.isArray(data.nodes)) {
    if (!data.nodes.length) return <p className="text-[12px] text-subtle">No plan nodes returned.</p>;
    return (
      <div className="space-y-gutter-sm">
        <div className="flex flex-wrap items-center gap-2">
          {data.planning_time != null && <StatCellInline label="Planning time" value={fmtMs(data.planning_time)} />}
          {data.analyzed && data.execution_time != null && <StatCellInline label="Execution time" value={fmtMs(data.execution_time)} />}
          {!data.analyzed && (
            <Badge tone="warning" size="xs">Estimated plan — params replaced with NULL</Badge>
          )}
        </div>
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
                  {String(n.node_type || '').includes('Seq Scan') && (
                    <Badge tone="danger" size="xs" className="ml-1.5">seq scan</Badge>
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
    return (
      <>
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
    return (
      <div className="space-y-gutter-sm">
        {data.plan_summary && <Badge tone="accent">{data.plan_summary}</Badge>}
        <div className="grid grid-cols-2 gap-gutter-sm sm:grid-cols-4">
          <StatCell label="Returned" value={fmtNumber(stats.nReturned)} />
          <StatCell label="Keys examined" value={fmtNumber(stats.totalKeysExamined)} />
          <StatCell label="Docs examined" value={fmtNumber(stats.totalDocsExamined)} />
          <StatCell label="Execution time" value={stats.executionTimeMillis != null ? fmtMs(stats.executionTimeMillis) : '—'} />
        </div>
        <Panel title="Query planner" icon="terminal">
          <SqlBlock sql={JSON.stringify(data.query_planner, null, 2)} className="max-h-72 overflow-auto" />
        </Panel>
      </div>
    );
  }

  return <p className="text-[12px] text-subtle">No plan data returned.</p>;
}

function StatCellInline({ label, value }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-card bg-sunken px-2.5 py-1 text-[11px]">
      <span className="text-subtle">{label}:</span>
      <span className="font-mono font-bold text-fg">{value}</span>
    </span>
  );
}

/** Runs whichever engine's EXPLAIN-equivalent applies, on demand. */
function PlanStep({ engine, id, row }) {
  const [state, setState] = useState(null); // null | {loading} | {data} | {error}

  const run = async () => {
    setState({ loading: true });
    try {
      let res;
      if (engine.key === 'oracle') {
        const sqlId = row.query_id;
        if (!sqlId) throw new Error('No sql_id on this row.');
        res = await client.get(engine.api.explainSqlId(id, sqlId)).then((r) => r.data);
      } else if (engine.key === 'mongodb') {
        const raw = row._raw || {};
        const [database, collection] = String(raw.ns || row.database_name || '').split('.', 2);
        res = await client.post(engine.api.explainOp(id), {
          database: database || row.database_name || 'admin',
          collection: collection || raw.collection || '',
          query_filter: (() => { try { return JSON.parse(raw.query || '{}'); } catch { return {}; } })(),
        }).then((r) => r.data);
      } else {
        res = await client.post(engine.api.explainSql(id), {
          sql_text: row.query_text,
          database: row.database_name,
          db_name: row.database_name,
        }).then((r) => r.data);
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

  const backTo = engine ? `${engine.dashboardPath(id)}/slow-queries` : '/databases';
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

  const row = routerRow || refetched?.query;

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

  const runAi = async () => {
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

      <div className="space-y-gutter">
        <Step n={1} title="The query" subtitle="What it is and what it costs today">
          <div className="flex items-start gap-2">
            <SqlBlock sql={sql || '(empty)'} className="max-h-60 flex-1 overflow-auto" />
            <CopyButton text={sql} />
          </div>
          <div className="mt-gutter-sm grid grid-cols-2 gap-gutter-sm sm:grid-cols-3 lg:grid-cols-6">
            <StatCell label="Severity" value={<SeverityBadge severity={row.severity} />} />
            <StatCell label={row.execution_count != null ? 'Avg time' : 'Duration'} value={fmtMs(row.average_execution_time)}
              tone={row.severity === 'critical' ? 'bad' : row.severity === 'high' ? 'warn' : 'neutral'} />
            {row.execution_count != null && <StatCell label="Executions" value={fmtNumber(row.execution_count)} />}
            {row.max_execution_time != null && <StatCell label="Max time" value={fmtMs(row.max_execution_time)} />}
            {row.rows_returned != null && <StatCell label="Rows sent" value={fmtNumber(row.rows_returned)} />}
            {row.rows_affected != null && <StatCell label="Rows examined" value={fmtNumber(row.rows_affected)} />}
            {row.user_name && <StatCell label="User" value={row.user_name} />}
            {row.host && <StatCell label="Host" value={row.host} />}
            {row.first_seen && <StatCell label="First seen" value={fmtDateTime(row.first_seen) || row.first_seen} />}
            {row.last_seen && <StatCell label="Last seen" value={fmtDateTime(row.last_seen) || row.last_seen} />}
          </div>
        </Step>

        {engine.hasFullAnalysis ? (
          <Step n={2} title="Analysis workspace"
            subtitle="EXPLAIN, then tables, indexes, and a rule-based diagnosis — one pass, run on demand">
            <MysqlAnalysisWorkspace engine={engine} id={id} row={row} />
          </Step>
        ) : (
          <>
            <Step n={2} title="Execution plan" subtitle={`Native to ${engine.label} — read on demand, never cached stale`}>
              <PlanStep engine={engine} id={id} row={row} />
            </Step>

            <Step n={3} title="How to make it faster" subtitle="The model reads the statement together with its cost figures">
              {!ai && <Button variant="primary" size="lg" icon="brain" onClick={runAi}>Analyse this query</Button>}
              {ai?.loading && <InlineLoading label="Analysing…" />}
              {ai?.err && (
                <>
                  <Notice tone="danger" title="Analysis failed.">{ai.err}</Notice>
                  <Button variant="secondary" icon="refresh" onClick={runAi}>Try again</Button>
                </>
              )}
              {ai?.result && (
                <>
                  <AiAnalysisResult a={ai.result} />
                  <Button variant="secondary" icon="refresh" className="mt-gutter-sm" onClick={runAi}>Re-analyse</Button>
                </>
              )}
            </Step>

            {tech === 'postgresql' && (
              <PgHintPlanPanel connId={id} sqlText={sql} database={row.database_name || row.schema_name} />
            )}
          </>
        )}
      </div>
    </>
  );
}
