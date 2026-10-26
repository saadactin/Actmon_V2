/**
 * Query Analysis — screen 2: the results of Analyze (Oracle).
 *
 * Everything here is a read keyed by the captured SQL_ID; nothing is executed:
 *   plan        /oracle-sql-plan            V$SQL_PLAN (estimates, predicates)
 *   planStats   /oracle-sql-plan-stats      V$SQL_PLAN_STATISTICS_ALL (actuals,
 *                                           only when Oracle collected them)
 *   detail      /oracle-sql-detail          V$SQL child cursors (execution details,
 *                                           plan history)
 *   trend       /oracle-sql-trend           stored Top-SQL snapshots (ClickHouse)
 *   topSql      /oracle-top-sql             cursor cache, for similar statements
 * A value the backend did not return reads "Not available".
 */
import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import Icon from '@/components/ui/Icon';
import Notice from '@/components/ui/Notice';
import { fmtNumber } from '@/config/dbCatalog';
import { cn } from '@/lib/cn';

import PlanDiagram from './PlanDiagram';
import { oracleTree } from './planTree';
import { fullScanWarnings, missingIndexCandidates, estimatedCost } from './queryInsights';
import { highlight, formatSql } from './QueryAnalysisScreen1';

const NA = 'Not available';
const ms = (v) => (v == null ? NA : v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Number(v).toFixed(2)} ms`);
const num = (v) => (v == null ? NA : fmtNumber(v));

function Card({ n, title, subtitle, right, children, className, id }) {
  return (
    <section id={id} className={cn('min-w-0 scroll-mt-24 rounded-2xl border border-border bg-surface p-5 shadow-sm', className)}>
      <div className="mb-3 flex items-start gap-3">
        {n && <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accent text-[13px] font-bold text-accent-fg">{n}</span>}
        <div className="min-w-0 flex-1">
          <h2 className="text-[16px] font-bold text-fg">{title}</h2>
          {subtitle && <p className="text-[12px] text-muted">{subtitle}</p>}
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

function Tabs({ value, onChange, options }) {
  return (
    <div className="mb-3 flex gap-5 border-b border-border text-[13px]">
      {options.map(([k, l]) => (
        <button key={k} type="button" onClick={() => onChange(k)}
          className={cn('-mb-px border-b-2 pb-2 font-medium', value === k ? 'border-accent text-accent-text' : 'border-transparent text-muted hover:text-fg')}>
          {l}
        </button>
      ))}
    </div>
  );
}

const op = (r) => `${r.operation || ''}${r.options ? ` ${r.options}` : ''}`;
const DEPTH_COLORS = ['#8b5cf6', '#3b82f6', '#ef4444', '#22c55e', '#f59e0b', '#0ea5e9'];

export function PlanTable({ rows, stats, selected, onSelect }) {
  const byId = new Map((stats?.steps || []).map((s) => [s.id, s]));
  const collected = !!stats?.collected;
  return (
    <div className="overflow-auto rounded-xl border border-border">
      <table className="w-full min-w-[640px] text-[12.5px]">
        <thead className="bg-sunken/70 text-left text-[12px] font-semibold text-muted">
          <tr>
            {['Id', 'Operation', 'Object Name', 'Depth', 'Cost', 'Est. Rows', 'Actual Rows', 'Time'].map((h) => (
              <th key={h} className="whitespace-nowrap px-3 py-2.5">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const s = byId.get(r.id);
            return (
              <tr key={r.id} onClick={() => onSelect?.(r.id)}
                className={cn('cursor-pointer border-t border-border hover:bg-sunken/60', selected === r.id && 'bg-accent-softer')}>
                <td className="px-3 py-2" style={{ boxShadow: `inset 3px 0 0 ${DEPTH_COLORS[(r.depth || 0) % DEPTH_COLORS.length]}` }}>{r.id}</td>
                <td className="whitespace-nowrap px-3" style={{ paddingLeft: `${12 + (r.depth || 0) * 10}px` }}>{op(r)}</td>
                <td className="px-3 font-mono text-[12px]">{r.object_name || '—'}</td>
                <td className="px-3">{r.depth ?? '—'}</td>
                <td className="px-3">{r.cost ?? '—'}</td>
                <td className="px-3">{r.cardinality == null ? '—' : fmtNumber(r.cardinality)}</td>
                <td className="px-3">{collected && s?.actual_rows != null ? fmtNumber(s.actual_rows) : '—'}</td>
                <td className="px-3">{collected && s?.elapsed_ms != null ? ms(s.elapsed_ms) : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="border-t border-border px-3 py-2 text-[11px] text-subtle">
        Est. Rows and Cost are the optimizer's estimates (V$SQL_PLAN).{' '}
        {collected ? 'Actual Rows and Time are the last execution’s measurements (V$SQL_PLAN_STATISTICS_ALL).' : (stats?.note || 'Actual figures were not read.')}
      </p>
    </div>
  );
}

/** The plan tree with zoom and fit-to-width. */
export function ZoomDiagram({ rows }) {
  const [zoom, setZoom] = useState(1);
  const box = useRef(null);
  const inner = useRef(null);
  const tree = useMemo(() => oracleTree(rows), [rows]);
  const fit = () => {
    const w = box.current?.clientWidth || 1; const iw = (inner.current?.scrollWidth || w) / zoom;
    setZoom(Math.max(0.3, Math.min(1.5, (w - 24) / iw)));
  };
  const btn = 'grid h-8 w-8 place-items-center rounded-md border border-border bg-surface text-fg hover:bg-sunken';
  return (
    <div className="relative">
      <div ref={box} className="h-[420px] overflow-auto rounded-xl border border-border bg-sunken/40 p-3">
        <div ref={inner} style={{ transform: `scale(${zoom})`, transformOrigin: 'top left', width: `${100 / zoom}%` }}>
          <PlanDiagram tree={tree} />
        </div>
      </div>
      <div className="absolute right-3 top-3 flex flex-col items-center gap-1.5 rounded-lg border border-border bg-surface p-1.5 shadow-sm">
        <button type="button" className={btn} title="Zoom in" onClick={() => setZoom((z) => Math.min(2, z + 0.15))}><Icon name="plus" size={15} /></button>
        <span className="text-[11px] font-semibold text-muted">{Math.round(zoom * 100)}%</span>
        <button type="button" className={btn} title="Zoom out" onClick={() => setZoom((z) => Math.max(0.3, z - 0.15))}><Icon name="minus" size={15} /></button>
        <button type="button" className={btn} title="Fit to width" onClick={fit}><Icon name="expand" size={14} /></button>
      </div>
    </div>
  );
}

function Insight({ tone, icon, title, body, evidence }) {
  const t = { danger: 'bg-danger-soft text-danger-fg', warning: 'bg-warning-soft text-warning-fg', info: 'bg-accent-soft text-accent-text', good: 'bg-success-soft text-success-fg' }[tone];
  return (
    <li className="flex gap-3 border-t border-border py-3 first:border-t-0">
      <span className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-lg', t)}><Icon name={icon} size={17} /></span>
      <div className="min-w-0">
        <p className="text-[13.5px] font-bold text-fg">{title}</p>
        <p className="text-[12px] text-muted">{body}</p>
        {evidence && <p className="mt-0.5 text-[11px] text-subtle">Evidence: {evidence}</p>}
      </div>
    </li>
  );
}

function TrendSpark({ points, k, fmt }) {
  const vals = points.map((p) => p[k]).filter((v) => v != null);
  if (vals.length < 2) return <span className="text-[12px] text-muted">{vals.length ? fmt(vals[0]) : NA}</span>;
  const W = 220; const H = 50; const max = Math.max(...vals); const min = Math.min(...vals); const span = max - min || 1;
  const d = vals.map((v, i) => `${i ? 'L' : 'M'}${((i / (vals.length - 1)) * W).toFixed(1)},${(H - 4 - ((v - min) / span) * (H - 8)).toFixed(1)}`).join('');
  return (
    <div className="flex items-center gap-3">
      <svg width={W} height={H}><path d={`${d}L${W},${H}L0,${H}Z`} fill="#3b82f6" opacity="0.12" /><path d={d} fill="none" stroke="#3b82f6" strokeWidth="1.8" /></svg>
      <span className="text-[12px] text-muted">min {fmt(min)} · max {fmt(max)}</span>
    </div>
  );
}

const RANGES = [{ id: 1, label: 'Last 1 Hour' }, { id: 6, label: 'Last 6 Hours' }, { id: 24, label: 'Last 24 Hours' }, { id: 168, label: 'Last 7 Days' }];

export default function QueryAnalysisResults({
  engine, id, row, sql, results, onBack, onRefresh, refreshing, trendHours, onTrendHours,
}) {
  const navigate = useNavigate();
  const { plan = [], planStats, detail, trend, topSql } = results;
  const [planTab, setPlanTab] = useState('diagram');
  const [relTab, setRelTab] = useState('similar');
  const [selected, setSelected] = useState(null);
  const [showAll, setShowAll] = useState(false);
  const [tz, setTz] = useState('local');
  const [shownSql, setShownSql] = useState(sql);
  const [copied, setCopied] = useState(false);
  const topRef = useRef(null);

  const s = detail?.status === 'success' ? detail.summary : null;
  const child0 = detail?.status === 'success' ? detail.children?.[0] : null;
  const planHash = child0?.plan_hash_value || (plan[0] && plan[0].plan_hash_value) || null;

  /* Insights — each with its evidence. An index CANDIDATE is a plan signal,
     never presented as a fact about the schema. */
  const insights = useMemo(() => {
    const list = [];
    fullScanWarnings(plan).forEach((w) => list.push({
      tone: 'danger', icon: 'alert', title: 'Full table scan detected',
      body: `The plan reads ${w.owner ? `${w.owner}.` : ''}${w.object || 'a table'} in full.`,
      evidence: `step ${w.steps.join(', ')} · cost ${w.cost ?? '—'} · est. rows ${w.rows == null ? '—' : fmtNumber(w.rows)}`,
    }));
    (missingIndexCandidates(plan) || []).forEach((r) => list.push({
      tone: 'warning', icon: 'key', title: 'Index candidate',
      body: `No index step on ${r.object_owner ? `${r.object_owner}.` : ''}${r.object_name} in this plan. It may have indexes the optimizer chose not to use — check its predicates before adding one.`,
      evidence: `TABLE ACCESS FULL at step ${r.id}${r.filter_predicates ? ` · filter ${r.filter_predicates}` : ''}`,
    }));
    const cost = estimatedCost(plan);
    if (cost != null) {
      list.push({ tone: 'info', icon: 'info', title: 'Optimizer cost', body: `The optimizer estimates a total cost of ${fmtNumber(cost)} for this plan.`, evidence: 'root step cost, V$SQL_PLAN' });
    }
    if (s?.elapsed_ms_per_exec != null) {
      const slow = s.elapsed_ms_per_exec >= 1000;
      list.push({
        tone: slow ? 'warning' : 'good', icon: 'clock', title: slow ? 'Slow per execution' : 'Execution time per call',
        body: `${ms(s.elapsed_ms_per_exec)} per execution over ${fmtNumber(s.executions)} executions.`,
        evidence: 'elapsed_time / executions, V$SQL (cumulative since the cursor was loaded)',
      });
    }
    return list;
  }, [plan, s]);

  const similar = useMemo(() => {
    const all = (topSql?.sql || []).filter((r) => r.sql_id !== row.query_id);
    const samePlan = planHash ? all.filter((r) => String(r.plan_hash_value) === String(planHash)) : [];
    return samePlan.length ? { label: 'Statements sharing this plan hash', rows: samePlan }
      : { label: `Top statements in schema ${row.schema_name || ''}`.trim(), rows: all.filter((r) => !row.schema_name || r.parsing_schema_name === row.schema_name).slice(0, 8) };
  }, [topSql, planHash, row]);

  const plans = useMemo(() => {
    const by = new Map();
    (detail?.children || []).forEach((c) => {
      const k = c.plan_hash_value;
      const a = by.get(k) || { plan_hash_value: k, children: 0, executions: 0, elapsed_s: 0, last_active_time: null };
      a.children += 1; a.executions += c.executions || 0; a.elapsed_s += c.elapsed_s || 0;
      if (!a.last_active_time || String(c.last_active_time) > String(a.last_active_time)) a.last_active_time = c.last_active_time;
      by.set(k, a);
    });
    return [...by.values()];
  }, [detail]);

  const download = () => {
    const blob = new Blob([shownSql], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `${row.query_id || 'query'}.sql`; a.click();
    URL.revokeObjectURL(a.href);
  };
  const copy = async () => { try { await navigator.clipboard.writeText(shownSql); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* blocked */ } };
  const go = (anchor) => document.getElementById(anchor)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const when = (v) => {
    if (!v) return NA;
    const d = new Date(String(v).replace(' ', 'T'));
    return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString(undefined, tz === 'utc' ? { timeZone: 'UTC' } : {});
  };

  return (
    <div ref={topRef} className="space-y-4">
      {/* header */}
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={onBack}
          className="flex h-11 items-center gap-2 rounded-lg border border-border bg-surface px-4 text-[14px] font-semibold text-fg shadow-sm hover:bg-sunken">
          <Icon name="arrow-left" size={16} /> Back
        </button>
        <Icon name="zap" size={26} className="text-accent-text" />
        <div className="min-w-0">
          <h1 className="text-[22px] font-bold text-fg">Query Analysis</h1>
          <p className="text-[13px] text-muted">Execution plan, performance insights and related SQL</p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-3">
          <label className="flex h-12 flex-col justify-center rounded-lg border border-border bg-surface px-3 shadow-sm" title="Range for the Performance Trend">
            <span className="text-[11px] text-muted">Time Range</span>
            <select value={trendHours} onChange={(e) => onTrendHours(Number(e.target.value))} className="bg-transparent text-[13px] font-medium text-fg outline-none">
              {RANGES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
            </select>
          </label>
          <label className="flex h-12 flex-col justify-center rounded-lg border border-border bg-surface px-3 shadow-sm">
            <span className="text-[11px] text-muted">Time Zone</span>
            <select value={tz} onChange={(e) => setTz(e.target.value)} className="bg-transparent text-[13px] font-medium text-fg outline-none">
              <option value="local">Local</option><option value="utc">UTC</option>
            </select>
          </label>
          <button type="button" onClick={onRefresh}
            className="flex h-12 items-center gap-2 rounded-lg bg-accent px-6 text-[15px] font-semibold text-accent-fg shadow-sm hover:brightness-110">
            <Icon name="refresh" size={17} className={refreshing ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>
      </div>

      {/* section links */}
      <nav className="flex flex-wrap gap-6 border-b border-border text-[14px]">
        {[['qa-plan', 'Execution Plan'], ['qa-table', 'Plan Table'], ['qa-insights', 'Performance Insights'], ['qa-related', 'Related SQL & History']].map(([a, l], i) => (
          <button key={a} type="button" onClick={() => go(a)} className="-mb-px flex items-center gap-2 border-b-2 border-transparent pb-2.5 font-semibold text-fg hover:border-accent hover:text-accent-text">
            <span className="grid h-5 w-5 place-items-center rounded-full bg-accent text-[11px] text-accent-fg">{i + 1}</span>{l}
          </button>
        ))}
      </nav>

      <div className="grid gap-4 xl:grid-cols-[1.05fr_1.15fr_1fr]">
        <Card id="qa-plan" n={1} title="Execution Plan" subtitle="Visual and tabular representation of the execution plan.">
          <Tabs value={planTab} onChange={setPlanTab} options={[['diagram', 'Plan Diagram'], ['table', 'Plan Table'], ['pred', 'Predicate Information'], ['other', 'Other Information']]} />
          {planTab === 'diagram' && <ZoomDiagram rows={plan} />}
          {planTab === 'table' && <PlanTable rows={plan} stats={planStats} selected={selected} onSelect={setSelected} />}
          {planTab === 'pred' && (
            <ul className="max-h-[420px] space-y-2 overflow-auto text-[12.5px]">
              {plan.filter((r) => r.access_predicates || r.filter_predicates).map((r) => (
                <li key={r.id} className="rounded-lg border border-border p-3">
                  <p className="font-semibold text-fg">{r.id} · {op(r)} {r.object_name ? `· ${r.object_name}` : ''}</p>
                  {r.access_predicates && <p className="mt-1 font-mono text-[12px]"><span className="text-muted">access </span>{r.access_predicates}</p>}
                  {r.filter_predicates && <p className="mt-1 font-mono text-[12px]"><span className="text-muted">filter </span>{r.filter_predicates}</p>}
                </li>
              ))}
              {!plan.some((r) => r.access_predicates || r.filter_predicates) && <li className="text-muted">No predicates in this plan.</li>}
            </ul>
          )}
          {planTab === 'other' && (
            <div className="max-h-[420px] overflow-auto rounded-xl border border-border">
              <table className="w-full text-[12.5px]">
                <thead className="bg-sunken/70 text-left text-[12px] text-muted"><tr>{['Id', 'Object type', 'Bytes', 'CPU cost', 'I/O cost'].map((h) => <th key={h} className="px-3 py-2">{h}</th>)}</tr></thead>
                <tbody>{plan.map((r) => (
                  <tr key={r.id} className="border-t border-border"><td className="px-3 py-2">{r.id}</td><td className="px-3">{r.object_type || '—'}</td>
                    <td className="px-3">{r.bytes == null ? '—' : fmtNumber(r.bytes)}</td><td className="px-3">{r.cpu_cost == null ? '—' : fmtNumber(r.cpu_cost)}</td><td className="px-3">{r.io_cost ?? '—'}</td></tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </Card>

        <Card id="qa-table" n={2} title="Plan Table" subtitle="Estimated vs actual row counts and performance metrics.">
          <PlanTable rows={plan} stats={planStats} selected={selected} onSelect={setSelected} />
        </Card>

        <div className="space-y-4">
          <Card id="qa-insights" n={3} title="Performance Insights"
            right={insights.length > 4 && (
              <button type="button" onClick={() => setShowAll((v) => !v)} className="rounded-md border border-accent/40 px-2.5 py-1 text-[12px] font-semibold text-accent-text hover:bg-accent-softer">
                {showAll ? 'Show less' : 'View All'}
              </button>
            )}>
            {insights.length ? (
              <ul>{(showAll ? insights : insights.slice(0, 4)).map((x, i) => <Insight key={i} {...x} />)}</ul>
            ) : <p className="text-[12.5px] text-muted">The plan raised no findings.</p>}
          </Card>

          <Card id="qa-related" n={4} title="Related SQL & History">
            <Tabs value={relTab} onChange={setRelTab} options={[['similar', 'Similar SQL'], ['plans', 'Plan History'], ['trend', 'Performance Trend']]} />
            {relTab === 'similar' && (
              topSql?.status === 'error' ? <p className="text-[12px] text-danger-fg">{topSql.error}</p>
                : !similar.rows.length ? <p className="text-[12px] text-muted">No related statements in the cursor cache.</p> : (
                  <>
                    <p className="mb-2 text-[11px] text-subtle">{similar.label} (V$SQL)</p>
                    <table className="w-full text-[12px]">
                      <thead className="text-left text-muted"><tr>{['SQL ID', 'Executions', 'Avg Time', 'DB Time', 'Plan Hash'].map((h) => <th key={h} className="pb-1.5 pr-2">{h}</th>)}</tr></thead>
                      <tbody>{similar.rows.slice(0, 6).map((r) => (
                        <tr key={`${r.sql_id}-${r.child_number}`} className="cursor-pointer border-t border-border hover:bg-sunken/60"
                          onClick={() => navigate(`${engine.dashboardPath(id)}/slow-queries/detail`, { state: { row: {
                            query_id: r.sql_id, query_text: r.sql_fulltext || r.sql_text, execution_count: r.executions,
                            average_execution_time: r.avg_elapsed_ms, schema_name: r.parsing_schema_name, user_name: r.parsing_schema_name, _raw: r,
                          } } })}>
                          <td className="py-1.5 pr-2 font-mono text-accent-text">{r.sql_id}</td>
                          <td className="pr-2">{num(r.executions)}</td><td className="pr-2">{ms(r.avg_elapsed_ms)}</td>
                          <td className="pr-2">{ms(r.elapsed_ms)}</td><td className="font-mono">{r.plan_hash_value}</td>
                        </tr>
                      ))}</tbody>
                    </table>
                  </>
                )
            )}
            {relTab === 'plans' && (
              detail?.status !== 'success' ? <p className="text-[12px] text-muted">{detail?.error || 'Plan history could not be read.'}</p> : (
                <>
                  <p className="mb-2 text-[11px] text-subtle">Plans of this statement now in the cursor cache (V$SQL child cursors)</p>
                  <table className="w-full text-[12px]">
                    <thead className="text-left text-muted"><tr>{['Plan Hash', 'Children', 'Executions', 'Elapsed', 'Last active'].map((h) => <th key={h} className="pb-1.5 pr-2">{h}</th>)}</tr></thead>
                    <tbody>{plans.map((p) => (
                      <tr key={p.plan_hash_value} className="border-t border-border">
                        <td className="py-1.5 pr-2 font-mono">{p.plan_hash_value}</td><td className="pr-2">{p.children}</td>
                        <td className="pr-2">{num(p.executions)}</td><td className="pr-2">{p.elapsed_s.toFixed(2)} s</td><td>{when(p.last_active_time)}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                  {plans.length === 1 && <p className="mt-2 text-[11px] text-subtle">One plan — the optimizer has not changed its plan for this statement.</p>}
                </>
              )
            )}
            {relTab === 'trend' && (
              trend?.status === 'error' ? <p className="text-[12px] text-danger-fg">{trend.error}</p>
                : !(trend?.points || []).length ? <p className="text-[12px] text-muted">{trend?.note || 'No stored history for this statement.'}</p> : (
                  <div className="space-y-3">
                    <p className="text-[11px] text-subtle">Stored Top-SQL snapshots for {row.query_id} — {trend.points.length} in the last {trendHours} h</p>
                    <div><p className="text-[12px] font-semibold text-fg">Avg elapsed per execution</p><TrendSpark points={trend.points} k="avg_elapsed_ms" fmt={ms} /></div>
                    <div><p className="text-[12px] font-semibold text-fg">Executions (cumulative)</p><TrendSpark points={trend.points} k="executions" fmt={num} /></div>
                  </div>
                )
            )}
          </Card>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.6fr_1fr]">
        <Card n={1} title="Query SQL (for reference)"
          right={(
            <div className="flex gap-2">
              {[['Format', 'list', () => setShownSql(formatSql(shownSql))], [copied ? 'Copied' : 'Copy', copied ? 'check' : 'copy', copy], ['Download', 'download', download]].map(([l, ic, fn]) => (
                <button key={l} type="button" onClick={fn} className="flex h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-[13px] font-semibold text-fg hover:bg-sunken">
                  <Icon name={ic} size={15} />{l}
                </button>
              ))}
            </div>
          )}>
          <div className="flex max-h-[260px] overflow-auto rounded-lg border border-border font-mono text-[13px] leading-[21px]">
            <div className="select-none border-r border-border bg-sunken/50 px-3 py-2 text-right text-subtle">
              {shownSql.split('\n').map((_, i) => <div key={i}>{i + 1}</div>)}
            </div>
            <pre className="m-0 flex-1 whitespace-pre px-4 py-2 text-fg">{highlight(shownSql)}</pre>
          </div>
        </Card>
        <Card n={3} title="Execution Details" subtitle="V$SQL — cumulative since the cursor was loaded">
          {detail?.status !== 'success' ? (
            <Notice tone="warning" title="Execution details could not be read.">{detail?.error || 'No response.'}</Notice>
          ) : (
            <dl className="grid grid-cols-2 gap-x-6 text-[12.5px]">
              {[
                ['SQL ID', <span key="i" className="font-mono text-accent-text">{row.query_id}</span>], ['Last active', when(child0?.last_active_time)],
                ['Plan Hash', s?.plan_hash_values?.join(', ') || NA], ['Elapsed Time', s ? `${s.elapsed_s.toFixed(2)} s` : NA],
                ['Child Number', child0?.child_number ?? NA], ['CPU Time', s ? `${s.cpu_s.toFixed(2)} s` : NA],
                ['Parsing Schema', child0?.parsing_schema || NA], ['Buffer Gets', num(s?.buffer_gets)],
                ['Optimizer Mode', child0?.optimizer_mode || NA], ['Disk Reads', num(s?.disk_reads)],
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between gap-3 border-b border-border py-2">
                  <dt className="text-muted">{k}</dt><dd className="text-right font-medium text-fg">{v}</dd>
                </div>
              ))}
            </dl>
          )}
        </Card>
      </div>
    </div>
  );
}
