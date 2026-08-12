import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import client from '@/api/client';
import { mssqlTableDetail } from '@/api/drilldown';
import PageHeader from '@/components/layout/PageHeader';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import CopyButton from '@/components/ui/CopyButton';
import Icon from '@/components/ui/Icon';
import Notice from '@/components/ui/Notice';
import Table, { EmptyState } from '@/components/ui/Table';
import { InlineLoading } from '@/components/ui/Loading';
import {
  Panel, SqlBlock, StatCell, TablePanel,
} from '@/pages/_shared/enginePanels';
import { fmtBytes, fmtNumber } from '@/config/dbCatalog';
import { SLOW_THRESHOLDS, queryWarnings } from './SlowQueries';

/**
 * One slow query, taken apart in the order a DBA would: what it costs, which
 * tables it touches, what indexes those tables have, then what to change.
 *
 * The query arrives in router state from the slow-queries list. That means a
 * bookmark or a refresh has nothing to render — so this page says so and offers
 * the way back, rather than showing an empty analysis.
 */

const analyzeQuery = (id, body) =>
  client.post(`/connections/mssql/${id}/mssql-slow-queries/analyze-groq`, body).then((r) => r.data);

const num = (v) => Number(v) || 0;
const mb = (v) => num(v) * 1048576;

/**
 * Best-effort table extraction from a T-SQL statement.
 *
 * Regex, not a parser: this only has to be right often enough to be useful, and a
 * name it gets wrong shows up as "could not read this object" in its own panel
 * rather than breaking the page. Keywords are excluded so `FROM (SELECT …)` and
 * `UPDATE SET` don't become table names.
 */
export function parseTables(sql) {
  if (!sql) return [];
  const re = /\b(?:from|join|into|update)\s+(\[?[A-Za-z0-9_#$]+\]?(?:\s*\.\s*\[?[A-Za-z0-9_#$]*\]?){0,2})/gi;
  const KEYWORDS = new Set([
    'select', 'where', 'set', 'values', 'on', 'as', 'inner', 'left', 'right',
    'outer', 'cross', 'group', 'order', 'by', 'with', 'apply', 'union',
  ]);
  const out = [];
  const seen = new Set();
  let m = re.exec(sql);
  while (m) {
    const raw = m[1].replace(/[[\]\s]/g, '');
    if (raw && !raw.includes('(')) {
      const parts = raw.split('.').filter(Boolean);
      let schema = 'dbo';
      let table = null;
      if (parts.length === 1) [table] = parts;
      else if (parts.length === 2) [schema, table] = parts;
      else { schema = parts[parts.length - 2]; table = parts[parts.length - 1]; }

      const key = `${schema}.${table}`.toLowerCase();
      if (table && !KEYWORDS.has(table.toLowerCase()) && !seen.has(key)) {
        seen.add(key);
        out.push({ schema, table });
      }
    }
    m = re.exec(sql);
  }
  return out;
}

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

const SEV_TONES = { critical: 'danger', high: 'danger', medium: 'warning', low: 'success' };

/** The model's advice. Every section is optional — it renders what came back. */
function AiAnalysis({ a }) {
  if (!a) return null;
  return (
    <div className="space-y-gutter-sm">
      <div className="flex flex-wrap items-center gap-2">
        {a.severity && (
          <Badge tone={SEV_TONES[String(a.severity).toLowerCase()] || 'neutral'} size="xs">
            {a.severity}
          </Badge>
        )}
        {a.estimated_overall_improvement && (
          <span className="text-[11px] font-semibold text-success-fg">
            Expected gain: {a.estimated_overall_improvement}
          </span>
        )}
      </div>

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
                <Badge tone={SEV_TONES[String(is.severity).toLowerCase()] || 'neutral'} size="xs">
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
                  {ix.reason}
                  {ix.estimated_improvement && (
                    <b className="ml-1 text-success-fg">({ix.estimated_improvement})</b>
                  )}
                </p>
                <div className="flex items-start gap-2">
                  <SqlBlock sql={ix.create_sql} className="flex-1" />
                  <CopyButton text={ix.create_sql} />
                </div>
              </div>
            ))}
          </div>
        </Panel>
      )}

      {a.query_rewrite?.applicable && a.query_rewrite.optimized_sql && (
        <Panel title="Suggested rewrite" icon="terminal"
          subtitle={a.query_rewrite.expected_gain || undefined}>
          <div className="flex items-start gap-2">
            <SqlBlock sql={a.query_rewrite.optimized_sql} className="flex-1" />
            <CopyButton text={a.query_rewrite.optimized_sql} />
          </div>
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

      {a.business_impact && (
        <p className="text-[12px] text-muted"><b>Business impact:</b> {a.business_impact}</p>
      )}
    </div>
  );
}

/** One table's structure, fetched on mount. */
function TablePanelDetail({ connId, dbName, schema, table }) {
  const [state, setState] = useState({ loading: true });
  const [showColumns, setShowColumns] = useState(false);

  useEffect(() => {
    let alive = true;
    setState({ loading: true });
    mssqlTableDetail(connId, dbName, schema, table)
      .then((d) => { if (alive) setState({ data: d }); })
      .catch((e) => { if (alive) setState({ err: e?.message || String(e) }); });
    return () => { alive = false; };
  }, [connId, dbName, schema, table]);

  const d = state.data;
  const stats = d?.stats || {};
  const indexes = d?.indexes || [];
  const columns = d?.columns || [];
  const missing = (d?.missing_indexes || []).filter((m) => m.ddl);

  return (
    <TablePanel
      title={`${schema}.${table}`}
      icon="table"
      subtitle={d
        ? `${fmtNumber(stats.row_count)} rows · ${stats.total_mb != null ? fmtBytes(mb(stats.total_mb)) : '—'} · ${indexes.length} index${indexes.length === 1 ? '' : 'es'}`
        : undefined}
    >
      {state.loading ? (
        <div className="px-card py-6"><InlineLoading label="Reading structure…" /></div>
      ) : state.err ? (
        <p className="px-card py-4 text-[12px] text-muted">
          Could not read this object ({state.err}). It is probably a CTE, an alias, a
          temporary table or a view rather than a base table.
        </p>
      ) : (
        <>
          {indexes.length === 0 ? (
            <div className="px-card py-3">
              <Notice tone="warning" className="mb-0" title="No indexes.">
                This table is a heap — every read is a full scan, which does not scale.
              </Notice>
            </div>
          ) : (
            <Table
              columns={[
                { key: 'name', label: 'Index' },
                { key: 'type', label: 'Type' },
                { key: 'unique', label: 'Unique' },
                { key: 'cols', label: 'Key columns' },
                { key: 'frag', label: 'Frag %', align: 'right' },
                { key: 'seeks', label: 'Seeks', align: 'right' },
                { key: 'scans', label: 'Scans', align: 'right' },
                { key: 'lookups', label: 'Lookups', align: 'right' },
              ]}
              rows={indexes.map((ix, i) => ({
                key: `${ix.index_name || 'heap'}-${i}`,
                cells: {
                  name: (
                    <span className="flex items-center gap-1.5">
                      <span className="font-mono text-[12px] font-semibold text-accent-text">
                        {ix.index_name || '(heap)'}
                      </span>
                      {ix.is_primary_key && <Badge tone="accent" size="xs">PK</Badge>}
                    </span>
                  ),
                  type: <span className="text-[11px] text-muted">{String(ix.type_desc || '').replace('_INDEX', '')}</span>,
                  unique: ix.is_unique ? <Badge tone="info" size="xs">Unique</Badge> : null,
                  cols: <span className="truncate-safe block max-w-[220px] font-mono text-[11px] text-muted">{ix.key_columns}</span>,
                  frag: (
                    <span className={num(ix.frag_pct) >= 30 ? 'font-mono font-bold text-danger-fg' : 'font-mono'}>
                      {ix.frag_pct != null ? `${ix.frag_pct}%` : '—'}
                    </span>
                  ),
                  seeks: <span className="font-mono">{fmtNumber(ix.seeks)}</span>,
                  scans: <span className="font-mono">{fmtNumber(ix.scans)}</span>,
                  lookups: <span className="font-mono">{fmtNumber(ix.lookups)}</span>,
                },
              }))}
              empty={<EmptyState icon="key" title="No indexes" />}
            />
          )}

          {missing.length > 0 && (
            <div className="space-y-2 border-t border-border px-card py-3">
              <p className="flex items-center gap-1.5 text-[11px] font-bold tracking-wide text-subtle uppercase">
                <Icon name="layers" size={12} />
                Index candidates the optimiser recorded ({missing.length})
              </p>
              {missing.map((m, i) => (
                <div key={i}>
                  <p className="mb-1 text-[11px] text-muted">
                    Estimated <b className="text-success-fg">{m.impact}%</b> improvement · {fmtNumber(m.uses)} uses
                  </p>
                  <div className="flex items-start gap-2">
                    <SqlBlock sql={m.ddl} className="flex-1" />
                    <CopyButton text={m.ddl} />
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="border-t border-border px-card py-2.5">
            <button
              type="button"
              onClick={() => setShowColumns((v) => !v)}
              className="flex items-center gap-1.5 text-[11px] font-bold tracking-wide text-subtle uppercase transition-colors hover:text-fg"
            >
              <Icon name={showColumns ? 'chevron-down' : 'chevron-right'} size={12} />
              Columns ({columns.length})
            </button>
          </div>
          {showColumns && (
            <Table
              columns={[
                { key: 'id', label: '#', align: 'right' },
                { key: 'name', label: 'Column' },
                { key: 'type', label: 'Type' },
                { key: 'len', label: 'Length', align: 'right' },
                { key: 'null', label: 'Nullable' },
                { key: 'key', label: 'Key' },
              ]}
              rows={columns.map((c, i) => ({
                key: `${c.name}-${i}`,
                cells: {
                  id: <span className="font-mono text-[11px] text-subtle">{c.column_id}</span>,
                  name: <span className="font-mono text-[12px] font-semibold">{c.name}</span>,
                  type: <span className="font-mono text-[11px] text-accent-text">{c.data_type}</span>,
                  len: <span className="font-mono text-[11px] text-muted">{c.length}</span>,
                  null: c.is_nullable
                    ? <span className="text-[11px] text-subtle">NULL</span>
                    : <span className="text-[11px] font-semibold text-fg">NOT NULL</span>,
                  key: c.is_pk ? <Badge tone="accent" size="xs">PK</Badge> : null,
                },
              }))}
              empty={<EmptyState icon="rows" title="No columns returned" />}
            />
          )}
        </>
      )}
    </TablePanel>
  );
}

export default function MSSQLQueryDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { state } = useLocation();
  const q = state?.query;
  const [ai, setAi] = useState(null); // { loading } | { result } | { err }

  const backTo = `/mssql-dashboard/${id}/slow-queries`;

  if (!q) {
    return (
      <>
        <PageHeader title="Query Analysis" icon="zap" backTo={backTo} />
        <Notice tone="info" title="No query selected.">
          This page analyses one statement handed to it by the slow-queries list, so
          there is nothing to show on a direct visit or after a reload.
        </Notice>
        <Button variant="primary" iconRight="chevron-right" onClick={() => navigate(backTo)}>
          Open slow queries
        </Button>
      </>
    );
  }

  const sql = q.sql_text || '';
  const tables = parseTables(sql);
  const warnings = queryWarnings(q);

  const runAi = async () => {
    setAi({ loading: true });
    try {
      const res = await analyzeQuery(id, {
        sql_text: sql,
        db_name: q.db_name,
        execution_count: num(q.execution_count),
        avg_elapsed_ms: num(q.avg_elapsed_ms),
        total_cpu_ms: num(q.total_cpu_ms),
        avg_logical_reads: num(q.avg_logical_reads),
        avg_physical_reads: num(q.avg_physical_reads),
      });
      setAi(res.status === 'success'
        ? { result: res.analysis }
        : { err: res.error || 'The analyser returned no result.' });
    } catch (e) {
      setAi({ err: e?.message || String(e) });
    }
  };

  return (
    <>
      <PageHeader
        title="Query Analysis"
        description="Cost, then the tables it touches, then their indexes, then what to change"
        icon="zap"
        backTo={backTo}
        actions={q.db_name ? <Badge tone="accent">{q.db_name}</Badge> : undefined}
      />

      <div className="max-w-6xl space-y-gutter">
        <Step n={1} title="The query" subtitle="What it is and what it costs today">
          <div className="flex items-start gap-2">
            <SqlBlock sql={sql || '(empty)'} className="max-h-60 flex-1 overflow-auto" />
            <CopyButton text={sql} />
          </div>
          <div className="mt-gutter-sm grid grid-cols-2 gap-gutter-sm sm:grid-cols-3 lg:grid-cols-6">
            <StatCell label="Avg elapsed" value={`${fmtNumber(q.avg_elapsed_ms)} ms`}
              tone={num(q.avg_elapsed_ms) > SLOW_THRESHOLDS.elapsedMs ? 'bad' : 'neutral'} />
            <StatCell label="Executions" value={fmtNumber(q.execution_count)} />
            <StatCell label="Total CPU" value={`${fmtNumber(q.total_cpu_ms)} ms`} />
            <StatCell label="Avg logical reads" value={fmtNumber(q.avg_logical_reads)}
              tone={num(q.avg_logical_reads) > SLOW_THRESHOLDS.logicalReads ? 'warn' : 'neutral'} />
            <StatCell label="Avg physical reads" value={fmtNumber(q.avg_physical_reads)}
              tone={num(q.avg_physical_reads) > SLOW_THRESHOLDS.physicalReads ? 'warn' : 'neutral'} />
            <StatCell label="Last executed"
              value={q.last_execution_time ? String(q.last_execution_time).slice(0, 19) : '—'} />
          </div>

          {warnings.length > 0 && (
            <div className="mt-gutter-sm space-y-2">
              {warnings.map((w) => (
                <Notice key={w.title} tone={w.level === 'bad' ? 'danger' : 'warning'}
                  className="mb-0" title={`${w.title}.`}>
                  {w.text}
                </Notice>
              ))}
            </div>
          )}
        </Step>

        <Step n={2} title="Tables it touches"
          subtitle={`${tables.length} name${tables.length === 1 ? '' : 's'} parsed from the statement`}>
          {tables.length === 0 ? (
            <p className="text-[13px] text-muted">
              No table names could be parsed — the statement may be dynamic SQL, a stored
              procedure call, or use only CTEs and temporary tables.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {tables.map((t) => (
                <Badge key={`${t.schema}.${t.table}`} tone="accent">
                  <Icon name="table" size={11} />
                  {t.schema}.{t.table}
                </Badge>
              ))}
            </div>
          )}
        </Step>

        {tables.length > 0 && (
          <Step n={3} title="Indexes and structure"
            subtitle="What exists, how fragmented it is, and what the optimiser wishes were there">
            <div className="space-y-gutter">
              {tables.map((t) => (
                <TablePanelDetail
                  key={`${t.schema}.${t.table}`}
                  connId={id}
                  dbName={q.db_name}
                  schema={t.schema}
                  table={t.table}
                />
              ))}
            </div>
          </Step>
        )}

        <Step n={4} title="How to make it faster"
          subtitle="The model reads the statement together with its cost figures">
          {!ai && (
            <Button variant="primary" size="lg" icon="brain" onClick={runAi}>
              Analyse this query
            </Button>
          )}
          {ai?.loading && <InlineLoading label="Analysing…" />}
          {ai?.err && (
            <>
              <Notice tone="danger" title="Analysis failed.">{ai.err}</Notice>
              <Button variant="secondary" icon="refresh" onClick={runAi}>Try again</Button>
            </>
          )}
          {ai?.result && (
            <>
              <AiAnalysis a={ai.result} />
              <Button variant="secondary" icon="refresh" className="mt-gutter-sm" onClick={runAi}>
                Re-analyse
              </Button>
            </>
          )}
        </Step>
      </div>
    </>
  );
}
