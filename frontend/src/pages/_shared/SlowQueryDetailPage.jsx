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
import { engineFor, fmtMs } from '@/config/slowQueryCatalog';
import { SeverityBadge, AiAnalysisResult } from './SlowQueriesPage';

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
        actions={row.database_name ? <Badge tone="accent">{row.database_name}</Badge> : undefined}
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
            {row.rows_returned != null && <StatCell label="Rows returned" value={fmtNumber(row.rows_returned)} />}
            {row.user_name && <StatCell label="User" value={row.user_name} />}
            {row.host && <StatCell label="Host" value={row.host} />}
            {row.last_seen && <StatCell label="Last seen" value={fmtDateTime(row.last_seen) || row.last_seen} />}
          </div>
        </Step>

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
      </div>
    </>
  );
}
