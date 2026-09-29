/**
 * PostgreSQL Query Analysis workspace.
 *
 * Layout note, because it was the reported problem: the old page stacked three
 * numbered "steps" down a narrow column, so most of a wide screen was empty and
 * the page looked unfinished before anything was run. This is a two-column
 * shell instead — the statement and its cost facts stay pinned on the left
 * while the results take the rest of the width — and it is fully populated the
 * moment it opens, because the query's own statistics are already known. The
 * analysis adds to a complete page rather than filling an empty one.
 *
 * Everything it displays comes from the server. There is no placeholder score,
 * no sample plan and no invented recommendation anywhere in this file.
 */
import { useMemo, useState } from 'react';
import client from '@/api/client';
import cn from '@/lib/cn';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Icon from '@/components/ui/Icon';
import Notice from '@/components/ui/Notice';
import Tabs from '@/components/ui/Tabs';
import Table, { EmptyState } from '@/components/ui/Table';
import CopyButton from '@/components/ui/CopyButton';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import { InlineLoading } from '@/components/ui/Loading';
import { Panel, SqlBlock, StatCell } from '@/pages/_shared/enginePanels';
import PlanDiagram from '@/pages/_shared/PlanDiagram';
import { pgTree } from '@/pages/_shared/planTree';
import { AiAnalysisResult, SeverityBadge } from '@/pages/_shared/SlowQueriesPage';
import { fmtMs } from '@/config/slowQueryCatalog';
import { fmtNumber, fmtDateTime } from '@/config/dbCatalog';

// EXPLAIN ANALYZE re-runs the statement in full, and the backend additionally
// probes more than one database before giving up. The app's 30s default is not
// enough headroom for a query whose own average is already seconds.
const ANALYSIS_TIMEOUT_MS = 90_000;

const SEV_TONE = { critical: 'danger', high: 'danger', medium: 'warning', low: 'neutral' };

/** Severity ordering for the findings list — worst first, always. */
const SEV_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };

export default function PgQueryAnalysis({ engine, id, row }) {
  const [tab, setTab] = useState('overview');
  const [analysis, setAnalysis] = useState(null); // null | {loading} | {data} | {error}
  const [ai, setAi] = useState(null);
  const [confirmAnalyze, setConfirmAnalyze] = useState(false);

  const sql = row.query_text || '';
  const hasSql = !!sql.trim();

  const post = (mode) => client.post(engine.api.analyzeFull(id), {
    sql_text: sql,
    db_name: row.database_name || row.schema_name || null,
    mode,
    count_calls: row.execution_count ?? 0,
    avg_exec_ms: row.average_execution_time ?? 0,
    max_exec_ms: row.max_execution_time ?? 0,
    total_exec_ms: row.total_execution_time ?? 0,
    rows_returned: row.rows_returned ?? 0,
  }, { timeout: ANALYSIS_TIMEOUT_MS }).then((r) => r.data);

  const runAnalysis = async (mode = 'estimate') => {
    if (!hasSql) {
      setAnalysis({ error: 'This entry carries no SQL statement, so there is nothing to analyse.' });
      return;
    }
    setAnalysis({ loading: true, mode });
    setAi(null);
    try {
      const res = await post(mode);
      if (res.status !== 'success') {
        // The backend returns a human-readable `error` plus, where it has one,
        // the server's own cleaned message in `detail`. Both are useful: the
        // first says what to do, the second says what PostgreSQL actually said.
        const extra = res.detail && !String(res.error || '').includes(res.detail) ? `

${res.detail}` : '';
        throw new Error((res.error || 'The analysis returned no result.') + extra);
      }
      setAnalysis({ data: res });
      setTab('overview');
    } catch (e) {
      setAnalysis({ error: errText(e) });
    }
  };

  const runAi = async () => {
    setAi({ loading: true });
    try {
      const payload = engine.buildAiPayload(row, row._raw);
      const res = await client.post(engine.api.analyzeContext(id), {
        ...payload,
        database: row.database_name || row.schema_name || null,
        analysis: analysis?.data || {},
      }, { timeout: ANALYSIS_TIMEOUT_MS }).then((r) => r.data);
      setAi(res.status === 'success'
        ? { result: res.analysis }
        : { err: res.error || 'The analyser returned no result.' });
    } catch (e) {
      setAi({ err: errText(e) });
    }
  };

  const data = analysis?.data;
  const diagnosis = data?.diagnosis;
  const findings = useMemo(
    () => [...(diagnosis?.findings || [])].sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]),
    [diagnosis],
  );
  const running = !!analysis?.loading;

  const tabs = [
    { id: 'overview', label: 'Overview', icon: 'info' },
    { id: 'plan', label: 'Execution plan', icon: 'terminal',
      count: data?.explain?.nodes?.length },
    { id: 'findings', label: 'Findings', icon: 'alert-triangle',
      count: findings.length || undefined,
      tone: diagnosis?.counts?.critical ? 'danger' : diagnosis?.counts?.high ? 'warning' : 'neutral' },
    { id: 'tables', label: 'Tables & indexes', icon: 'database',
      count: data?.tables?.length || undefined },
    { id: 'ai', label: 'AI recommendations', icon: 'brain' },
  ];

  return (
    <div className="grid grid-cols-1 gap-gutter xl:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
      {/* ── left rail: the statement and what it costs, always populated ── */}
      <div className="space-y-gutter-sm xl:sticky xl:top-4 xl:self-start">
        <Panel
          title="Statement"
          icon="code"
          subtitle={data?.explain?.used_db ? `Planned in ${data.explain.used_db}` : undefined}
          actions={<CopyButton text={sql} />}
        >
          {hasSql ? (
            <SqlBlock sql={sql} className="max-h-[22rem] overflow-auto" />
          ) : (
            <p className="text-[12px] text-subtle">This entry carries no SQL text.</p>
          )}
        </Panel>

        <Panel title="Cost today" icon="activity" subtitle="From this server's own statistics">
          <div className="grid grid-cols-2 gap-gutter-sm">
            <StatCell label="Severity" value={<SeverityBadge severity={row.severity} />} />
            <StatCell
              label={row.execution_count != null ? 'Avg time' : 'Duration'}
              value={fmtMs(row.average_execution_time)}
              tone={row.severity === 'critical' ? 'bad' : row.severity === 'high' ? 'warn' : 'neutral'}
            />
            {row.max_execution_time != null && <StatCell label="Max time" value={fmtMs(row.max_execution_time)} />}
            {row.execution_count != null && <StatCell label="Executions" value={fmtNumber(row.execution_count)} />}
            {row.total_execution_time != null && <StatCell label="Total time" value={fmtMs(row.total_execution_time)} />}
            {row.rows_returned != null && <StatCell label="Rows returned" value={fmtNumber(row.rows_returned)} />}
          </div>
          <div className="mt-gutter-sm space-y-1 border-t border-border pt-gutter-sm">
            <Fact label="Database" value={row.database_name || row.schema_name} />
            <Fact label="User" value={row.user_name} />
            <Fact label="Query type" value={row.query_type} />
            <Fact label="First seen" value={row.first_seen && (fmtDateTime(row.first_seen) || row.first_seen)} />
            <Fact label="Last seen" value={row.last_seen && (fmtDateTime(row.last_seen) || row.last_seen)} />
          </div>
        </Panel>
      </div>

      {/* ── right: the analysis ─────────────────────────────────────────── */}
      <div className="min-w-0 space-y-gutter-sm">
        <Panel
          title="Analysis"
          icon="zap"
          subtitle={
            data
              ? (data.explain?.analyzed
                ? 'Measured plan — the statement was executed'
                : 'Estimated plan — the statement was not executed')
              : 'EXPLAIN, the query\'s own tables and indexes, then a rule-based diagnosis'
          }
          actions={(
            <div className="flex flex-wrap items-center gap-2">
              {data && !data.explain?.analyzed && (
                <Button
                  variant="secondary" size="sm" icon="play"
                  onClick={() => setConfirmAnalyze(true)}
                  disabled={running}
                >
                  Run EXPLAIN ANALYZE
                </Button>
              )}
              <Button
                variant="primary" size="sm"
                icon={analysis?.error ? 'refresh' : 'zap'}
                loading={running}
                disabled={!hasSql || running}
                onClick={() => runAnalysis('estimate')}
              >
                {running ? 'Analysing query…' : analysis?.error ? 'Retry' : data ? 'Re-analyse' : 'Analyze query'}
              </Button>
            </div>
          )}
        >
          {!hasSql && (
            <Notice tone="warning" title="No statement to analyse.">
              This row carries no SQL text, so there is nothing to plan.
            </Notice>
          )}

          {hasSql && !analysis && (
            <IdleState onRun={() => runAnalysis('estimate')} />
          )}

          {running && (
            <InlineLoading label={
              analysis.mode === 'analyze'
                ? 'Executing the statement under EXPLAIN ANALYZE…'
                : 'Planning the statement and reading its tables’ indexes…'
            } />
          )}

          {analysis?.error && (
            <div className="space-y-gutter-sm">
              <Notice tone="danger" title="The analysis could not be completed.">
                <span className="whitespace-pre-wrap">{analysis.error}</span>
              </Notice>
              <Button variant="secondary" icon="refresh" onClick={() => runAnalysis('estimate')}>
                Try again
              </Button>
            </div>
          )}

          {data && (
            <div className="space-y-gutter-sm">
              {data.explain?.analyze_declined_reason && (
                <Notice tone="info" title="EXPLAIN ANALYZE was not run.">
                  {data.explain.analyze_declined_reason} The estimated plan is shown instead.
                </Notice>
              )}
              {data.explain?.params_replaced && (
                <Notice tone="info" title="This is the normalised statement.">
                  pg_stat_statements records queries with their literals replaced by
                  <code className="mx-1 font-mono">$1</code>,<code className="mx-1 font-mono">$2</code>…
                  Those became NULL for planning, so the estimated row counts can differ from
                  what the application really sees.
                </Notice>
              )}
              {data.metadata_error && (
                <Notice tone="warning" title="Table metadata was incomplete.">
                  {data.metadata_error} Findings that depend on index or row-count data may be missing.
                </Notice>
              )}

              <Tabs tabs={tabs} value={tab} onChange={setTab} />

              {tab === 'overview' && <OverviewTab data={data} findings={findings} row={row} />}
              {tab === 'plan' && <PlanTab explain={data.explain} />}
              {tab === 'findings' && <FindingsTab findings={findings} />}
              {tab === 'tables' && <TablesTab data={data} />}
              {tab === 'ai' && <AiTab ai={ai} onRun={runAi} />}
            </div>
          )}
        </Panel>
      </div>

      <ConfirmDialog
        open={confirmAnalyze}
        onCancel={() => setConfirmAnalyze(false)}
        onConfirm={() => { setConfirmAnalyze(false); runAnalysis('analyze'); }}
        tone="warning"
        title="Run this statement for real?"
        confirmLabel="Run EXPLAIN ANALYZE"
        cancelLabel="Cancel"
      >
        <p className="text-[13px]">
          EXPLAIN ANALYZE does not simulate the query — it <strong>executes</strong> it, on this
          server, and reports what actually happened. On a slow query that means paying its full
          cost again.
        </p>
        <p className="mt-2 text-[13px] text-muted">
          The server independently refuses to run anything that is not a plain read, so a statement
          that writes cannot be executed from here whatever this dialog is told.
        </p>
      </ConfirmDialog>
    </div>
  );
}

/* ── the page before anything has been run ──────────────────────────────── */

function IdleState({ onRun }) {
  return (
    <div className="rounded-card border border-dashed border-border px-4 py-6 text-center">
      <Icon name="zap" size={22} className="mx-auto text-subtle" />
      <p className="mt-2 text-[13px] font-semibold text-fg">Nothing has been run against the server yet</p>
      <p className="mx-auto mt-1 max-w-lg text-[12px] leading-relaxed text-muted">
        Analysing asks PostgreSQL for this statement&rsquo;s plan, reads the real indexes and row
        counts of the tables it touches, and checks the two against each other. Plain EXPLAIN is
        used, so the statement is <strong>not</strong> executed.
      </p>
      <Button variant="primary" icon="zap" className="mt-3" onClick={onRun}>Analyze query</Button>
    </div>
  );
}

/* ── tabs ───────────────────────────────────────────────────────────────── */

function OverviewTab({ data, findings, row }) {
  const d = data.diagnosis || {};
  const explain = data.explain || {};
  const counts = d.counts || {};
  const top = findings.slice(0, 3);

  return (
    <div className="space-y-gutter-sm">
      <div className={cn(
        'rounded-card border px-4 py-3',
        counts.critical ? 'border-danger-border bg-danger-softer'
          : counts.high ? 'border-warning-border bg-warning-softer'
            : 'border-success-border bg-success-softer',
      )}>
        <p className="text-[14px] font-bold text-fg">{d.verdict}</p>
        <p className="mt-1 text-[12px] text-muted">
          {explain.analyzed
            ? 'Based on a measured execution plan and this server’s catalogue.'
            : 'Based on an estimated execution plan and this server’s catalogue. Run EXPLAIN ANALYZE for measured row counts.'}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-gutter-sm sm:grid-cols-3 lg:grid-cols-6">
        <StatCell label="Critical" value={counts.critical ?? 0} tone={counts.critical ? 'bad' : 'neutral'} />
        <StatCell label="High" value={counts.high ?? 0} tone={counts.high ? 'bad' : 'neutral'} />
        <StatCell label="Medium" value={counts.medium ?? 0} tone={counts.medium ? 'warn' : 'neutral'} />
        <StatCell label="Low" value={counts.low ?? 0} />
        <StatCell label="Plan nodes" value={fmtNumber(explain.nodes?.length)} />
        <StatCell label="Tables read" value={fmtNumber(data.tables?.length)} />
      </div>

      <div className="grid grid-cols-2 gap-gutter-sm sm:grid-cols-4">
        <StatCell label="Planning time" value={explain.planning_time != null ? fmtMs(explain.planning_time) : '—'} />
        <StatCell label="Execution time"
          value={explain.analyzed && explain.execution_time != null ? fmtMs(explain.execution_time) : 'not measured'}
          hint={explain.analyzed ? undefined : 'Requires EXPLAIN ANALYZE'} />
        <StatCell label="Avg per call" value={fmtMs(row.average_execution_time)} />
        <StatCell label="Calls" value={fmtNumber(row.execution_count)} />
      </div>

      {top.length > 0 && (
        <div>
          <p className="mb-1.5 text-[11px] font-bold tracking-wide text-subtle uppercase">
            Most serious findings
          </p>
          <div className="space-y-1.5">
            {top.map((f, i) => <FindingCard key={i} f={f} compact />)}
          </div>
        </div>
      )}
    </div>
  );
}

function PlanTab({ explain }) {
  const [view, setView] = useState('table');
  const nodes = explain?.nodes || [];
  const tree = useMemo(() => (explain?.raw ? pgTree(explain.raw) : null), [explain]);
  const analyzed = explain?.analyzed;

  if (!nodes.length) {
    return <EmptyState icon="terminal" title="The plan came back empty" />;
  }

  return (
    <div className="space-y-gutter-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={analyzed ? 'success' : 'warning'} size="xs">
          {analyzed ? 'Measured' : 'Estimated'}
        </Badge>
        {explain.used_db && <Badge tone="neutral" size="xs">db: {explain.used_db}</Badge>}
        {tree && (
          <div className="ml-auto inline-flex rounded-control border border-border p-0.5">
            {[{ id: 'table', icon: 'list', label: 'Table' }, { id: 'diagram', icon: 'branch', label: 'Diagram' }].map((o) => (
              <button
                key={o.id} type="button" onClick={() => setView(o.id)}
                className={cn(
                  'flex items-center gap-1.5 rounded-control px-2.5 py-1 text-[11px] font-semibold transition-colors',
                  view === o.id ? 'bg-accent text-accent-fg' : 'text-muted hover:bg-sunken',
                )}
              >
                <Icon name={o.icon} size={12} />{o.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {view === 'diagram' && tree ? (
        <PlanDiagram tree={tree} />
      ) : (
        <Table
          columns={[
            { key: 'node', label: 'Node' },
            { key: 'rel', label: 'Relation' },
            { key: 'rows', label: analyzed ? 'Actual rows' : 'Est. rows', align: 'right' },
            { key: 'cost', label: analyzed ? 'Actual time' : 'Total cost', align: 'right' },
            { key: 'extra', label: 'Detail' },
          ]}
          rows={nodes.map((n, i) => ({
            key: i,
            cells: {
              node: (
                <span className="font-mono text-[11px]">
                  <span className="text-subtle">{'  '.repeat(n.depth || 0)}</span>
                  {n.node_type}
                  {String(n.node_type || '').includes('Seq Scan') && (
                    <Badge tone="danger" size="xs" className="ml-1.5">full scan</Badge>
                  )}
                </span>
              ),
              rel: <span className="font-mono text-[11px] text-muted">{n.relation || n.alias || '—'}</span>,
              rows: <span className="font-mono">{fmtNumber(analyzed ? n.actual_rows : n.plan_rows)}</span>,
              cost: (
                <span className="font-mono">
                  {analyzed
                    ? (n.actual_total_time != null ? fmtMs(n.actual_total_time) : '—')
                    : (n.total_cost != null ? Number(n.total_cost).toFixed(2) : '—')}
                </span>
              ),
              extra: (
                <span className="flex flex-wrap gap-1">
                  {n.join_type && <Badge tone="neutral" size="xs">{n.join_type} join</Badge>}
                  {n.sort_method && <Badge tone={/disk/i.test(n.sort_method) ? 'danger' : 'neutral'} size="xs">{n.sort_method}</Badge>}
                  {n.filter && (
                    <span className="truncate max-w-[22rem] font-mono text-[10px] text-subtle" title={n.filter}>
                      {n.filter}
                    </span>
                  )}
                </span>
              ),
            },
          }))}
          empty={<EmptyState icon="terminal" title="No plan nodes" />}
        />
      )}
    </div>
  );
}

function FindingsTab({ findings }) {
  if (!findings.length) {
    return (
      <EmptyState
        icon="check"
        title="Nothing to flag"
        body="The plan, the indexes and the statistics were all checked and none of the rules matched."
      />
    );
  }
  return <div className="space-y-gutter-sm">{findings.map((f, i) => <FindingCard key={i} f={f} />)}</div>;
}

function FindingCard({ f, compact }) {
  return (
    <div className="rounded-card border border-border bg-surface px-3.5 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={SEV_TONE[f.severity] || 'neutral'} size="xs">{f.severity}</Badge>
        <span className="text-[13px] font-bold text-fg">{f.title}</span>
        {f.table && <Badge tone="neutral" size="xs">{f.table}</Badge>}
      </div>

      {!compact && f.detail && (
        <p className="mt-1.5 text-[12px] leading-relaxed text-muted">{f.detail}</p>
      )}

      {f.evidence && (
        <p className="mt-1.5 rounded-control bg-sunken px-2 py-1 font-mono text-[11px] text-fg">
          <span className="text-subtle">evidence: </span>{f.evidence}
        </p>
      )}

      {!compact && f.action && (
        <p className="mt-1.5 text-[12px]">
          <span className="font-semibold text-fg">What to do: </span>
          <span className="text-muted">{f.action}</span>
        </p>
      )}

      {!compact && f.suggested_sql && (
        <div className="mt-1.5 flex items-start gap-1.5">
          <SqlBlock sql={f.suggested_sql} className="flex-1" />
          <CopyButton text={f.suggested_sql} />
        </div>
      )}

      {!compact && f.tradeoff && (
        <p className="mt-1.5 text-[11px] italic text-subtle">Trade-off: {f.tradeoff}</p>
      )}
    </div>
  );
}

function TablesTab({ data }) {
  const tables = data.tables || [];
  const redundant = data.redundant_indexes || [];
  const unused = data.unused_indexes || [];

  if (!tables.length) {
    return (
      <EmptyState
        icon="database"
        title="No table metadata"
        body="None of this query's relations could be resolved in the catalogue — they may live in another database, or the monitoring user may not be able to see them."
      />
    );
  }

  return (
    <div className="space-y-gutter-sm">
      {tables.map((t) => (
        <div key={`${t.schema_name}.${t.table_name}`} className="rounded-card border border-border">
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-3.5 py-2">
            <span className="font-mono text-[13px] font-bold text-fg">{t.schema_name}.{t.table_name}</span>
            <Badge tone="neutral" size="xs">{fmtNumber(t.row_estimate)} rows</Badge>
            <Badge tone="neutral" size="xs">{t.total_size}</Badge>
            <Badge tone="neutral" size="xs">indexes {t.index_size}</Badge>
            {t.never_analyzed
              ? <Badge tone="danger" size="xs">never analysed</Badge>
              : <span className="text-[11px] text-subtle">analysed {t.last_analyzed}</span>}
            {(t.n_dead_tup || 0) > 0 && (
              <Badge tone={t.n_dead_tup > t.row_estimate * 0.2 ? 'warning' : 'neutral'} size="xs">
                {fmtNumber(t.n_dead_tup)} dead
              </Badge>
            )}
          </div>
          <Table
            columns={[
              { key: 'name', label: 'Index' },
              { key: 'cols', label: 'Columns' },
              { key: 'kind', label: 'Kind' },
              { key: 'scans', label: 'Scans', align: 'right' },
              { key: 'size', label: 'Size', align: 'right' },
            ]}
            rows={(t.indexes || []).map((i) => ({
              key: i.index_name,
              cells: {
                name: <span className="font-mono text-[11px] font-semibold">{i.index_name}</span>,
                cols: <span className="font-mono text-[11px] text-muted">{(i.columns || []).join(', ') || '—'}</span>,
                kind: (
                  <span className="flex gap-1">
                    {i.is_primary && <Badge tone="accent" size="xs">primary</Badge>}
                    {i.is_unique && !i.is_primary && <Badge tone="neutral" size="xs">unique</Badge>}
                    {!i.is_valid && <Badge tone="danger" size="xs">invalid</Badge>}
                  </span>
                ),
                scans: (
                  <span className={cn('font-mono', (i.idx_scan || 0) === 0 && 'text-warning-fg')}>
                    {fmtNumber(i.idx_scan)}
                  </span>
                ),
                size: <span className="font-mono text-muted">{i.index_size}</span>,
              },
            }))}
            empty={<EmptyState icon="database" title="This table has no indexes" />}
          />
        </div>
      ))}

      {redundant.length > 0 && (
        <Notice tone="warning" title="Redundant indexes on this query's tables">
          <ul className="mt-1 space-y-0.5 text-[12px]">
            {redundant.map((r, i) => (
              <li key={i}>
                <code className="font-mono">{r.index}</code> ({r.size}) on {r.table} is a prefix of{' '}
                <code className="font-mono">{r.covered_by}</code> — the longer index already serves it.
              </li>
            ))}
          </ul>
        </Notice>
      )}

      {unused.length > 0 && (
        <Notice tone="info" title="Indexes never used since the statistics were last reset">
          <ul className="mt-1 space-y-0.5 text-[12px]">
            {unused.map((u, i) => (
              <li key={i}><code className="font-mono">{u.index}</code> ({u.size}) on {u.table}</li>
            ))}
          </ul>
          <p className="mt-1.5 text-[11px] text-subtle">
            Zero scans means unused <em>since pg_stat was last reset</em> — not necessarily never.
            Check the reset time before dropping anything.
          </p>
        </Notice>
      )}
    </div>
  );
}

function AiTab({ ai, onRun }) {
  return (
    <div className="space-y-gutter-sm">
      <Notice tone="info" title="Generated by a language model.">
        The findings tab is rule-based and deterministic — every line there is derived from the plan
        and the catalogue. This tab asks a model to reason over that same evidence. Treat its
        suggestions as a starting point and verify them before applying anything.
      </Notice>

      {!ai && <Button variant="primary" icon="brain" onClick={onRun}>Generate recommendations</Button>}
      {ai?.loading && <InlineLoading label="Asking the model to read the plan and the index metadata…" />}
      {ai?.err && (
        <div className="space-y-gutter-sm">
          <Notice tone="danger" title="The recommendations could not be generated.">{ai.err}</Notice>
          <Button variant="secondary" icon="refresh" onClick={onRun}>Try again</Button>
        </div>
      )}
      {ai?.result && (
        <>
          <AiAnalysisResult a={ai.result} />
          <Button variant="secondary" icon="refresh" onClick={onRun}>Regenerate</Button>
        </>
      )}
    </div>
  );
}

/* ── small pieces ───────────────────────────────────────────────────────── */

function Fact({ label, value }) {
  if (!value) return null;
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="shrink-0 text-[11px] text-subtle">{label}</span>
      <span className="truncate-safe min-w-0 text-right text-[12px] font-semibold text-fg">{value}</span>
    </div>
  );
}

/** Axios rejects carry the server's message in `response.data.detail`; falling
    straight back to `e.message` would show "Request failed with status code
    400" instead of the reason the backend actually gave. */
function errText(e) {
  const d = e?.response?.data;
  if (typeof d === 'string' && d) return d;
  if (d?.detail) return typeof d.detail === 'string' ? d.detail : JSON.stringify(d.detail);
  if (d?.error) return d.error;
  if (e?.code === 'ECONNABORTED') return 'The request timed out before the server answered.';
  return e?.message || String(e);
}
