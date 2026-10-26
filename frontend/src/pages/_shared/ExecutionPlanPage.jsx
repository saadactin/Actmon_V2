/**
 * The execution plan, on its own page.
 *
 * It used to be a step inside Query Analysis, which gave a fourteen-row plan
 * the same vertical slot as a two-line metric strip. A plan is the subject
 * here: a diagram and a table over the same data, one selection shared
 * between them, and the warnings the plan supports underneath.
 *
 * WHAT THE FIGURES ARE. Oracle's `v$sql_plan` is the optimizer's plan, not a
 * record of the run — COST, CARDINALITY, BYTES, CPU_COST and IO_COST are all
 * estimates made before the statement executed, and there is no per-step
 * elapsed time in it at all. Actual figures live in
 * `v$sql_plan_statistics_all` and only when the statement ran under
 * STATISTICS_LEVEL=ALL. None of that is in this payload, so no column here
 * claims a measurement and the Time column is absent rather than filled with
 * an estimate wearing a seconds suffix.
 */
import { useMemo, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';

import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Icon from '@/components/ui/Icon';
import { EmptyState } from '@/components/ui/Table';
import Input from '@/components/ui/Input';
import Notice from '@/components/ui/Notice';
import Select from '@/components/ui/Select';
import PageHeader from '@/components/layout/PageHeader';
import { InlineLoading } from '@/components/ui/Loading';
import { cn } from '@/lib/cn';

import PlanCanvas from './PlanCanvas';
import { SectionHead, ScanWarning } from './queryAnalysisCards';
import { engineFor } from '@/config/slowQueryCatalog';
import { PlanResult, requestPlan } from './SlowQueryDetailPage';
import { buildPlanGraph, classifyOperation, severityFor } from './planLayout';
import { fullScanWarnings } from './queryInsights';

const TYPE_TONES = {
  access: 'success', join: 'info', filter: 'accent', sort: 'neutral', operation: 'accent',
};

const fmt = (v) => (v === null || v === undefined ? null : Number(v).toLocaleString());

/* ── table view ──────────────────────────────────────────────────────── */

function PlanTable({ rows, planCost, selected, onSelect }) {
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState('all');

  const enriched = useMemo(() => rows.map((r) => {
    const cost = r.cost === null || r.cost === undefined ? null : Number(r.cost);
    return {
      ...r,
      _kind: classifyOperation(r.operation, r.options),
      _severity: severityFor(r, planCost),
      _share: cost != null && planCost ? (cost / planCost) * 100 : null,
      _label: [r.operation, r.options].filter(Boolean).join(' '),
      _object: r.object_name ? `${r.object_owner ? `${r.object_owner}.` : ''}${r.object_name}` : null,
    };
  }), [rows, planCost]);

  const shown = enriched.filter((r) => {
    if (kind !== 'all' && r._kind !== kind) return false;
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return r._label.toLowerCase().includes(q) || (r._object || '').toLowerCase().includes(q);
  });

  return (
    <div className="rounded-card border border-border bg-surface">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-card py-2.5">
        <h3 className="mr-auto text-[14px] font-black text-fg">Execution plan</h3>
        {/* Input spreads its props straight onto the <input>, so onChange
            receives the DOM event — unlike Select, which hands over the value.
            Passing the setter directly stored an event object as the search
            term and filtered every row away. */}
        <Input
          size="sm"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onClear={() => setSearch('')}
          placeholder="Search operations…"
          icon="search"
          className="w-56"
        />
        <Select
          size="sm"
          width="auto"
          value={kind}
          onChange={setKind}
          options={[
            { id: 'all', label: 'All operations' },
            { id: 'access', label: 'Access' },
            { id: 'join', label: 'Join' },
            { id: 'filter', label: 'Filter' },
            { id: 'sort', label: 'Sort / Group' },
            { id: 'operation', label: 'Operation' },
          ]}
        />
      </header>

      {/* The table scrolls inside its own card rather than widening the page,
          so a long object name cannot push the layout sideways. */}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[12px]">
          <thead>
            <tr className="border-b border-border bg-sunken text-left">
              {['Id', 'Operation', 'Object name', 'Cost', 'Rows', '% total cost', 'Operation type'].map((h, i) => (
                <th
                  key={h}
                  className={cn(
                    'whitespace-nowrap px-3 py-2 text-[11px] font-bold uppercase tracking-wide text-muted',
                    i >= 3 && i <= 5 && 'text-right',
                  )}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const isSel = r.id === selected;
              return (
                <tr
                  key={r.id}
                  onClick={() => onSelect(r.id)}
                  className={cn(
                    'cursor-pointer border-b border-border transition-colors last:border-0',
                    isSel ? 'bg-accent-softer'
                      : r._severity === 'critical' ? 'bg-danger-soft/40 hover:bg-danger-soft/60'
                        : r._severity === 'warning' ? 'bg-warning-soft/30 hover:bg-warning-soft/50'
                          : 'hover:bg-sunken',
                  )}
                >
                  <td className="px-3 py-2 font-mono font-bold text-muted">{r.id}</td>
                  <td className="px-3 py-2">
                    <span className={cn('font-semibold', r._severity === 'critical' ? 'text-danger-fg' : 'text-fg')}
                      style={{ paddingLeft: `${(Number(r.depth) || 0) * 10}px` }}>
                      {r._label}
                    </span>
                  </td>
                  <td className="px-3 py-2 font-mono text-muted">{r._object || <span className="text-subtle">—</span>}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">{fmt(r.cost) ?? <span className="text-subtle">—</span>}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">{fmt(r.cardinality) ?? <span className="text-subtle">—</span>}</td>
                  <td className={cn('px-3 py-2 text-right font-mono tabular-nums',
                    r._severity === 'critical' && 'font-black text-danger-fg')}>
                    {r._share === null ? <span className="text-subtle">—</span> : `${r._share.toFixed(1)}%`}
                  </td>
                  <td className="px-3 py-2">
                    <Badge tone={TYPE_TONES[r._kind] || 'neutral'} size="xs">{r._kind}</Badge>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {shown.length === 0 && (
          <EmptyState icon="search" title="No operation matches this filter." />
        )}
      </div>

      <p className="border-t border-border px-card py-2 text-[11px] leading-snug text-subtle">
        Cost, rows and the cost share are optimizer <strong>estimates</strong> from v$sql_plan.
        There is no per-step elapsed time in that view, so none is shown.
      </p>
    </div>
  );
}

/* ── the page ────────────────────────────────────────────────────────── */

export default function ExecutionPlanPage({ tech }) {
  const engine = engineFor(tech);
  const { id } = useParams();
  const navigate = useNavigate();
  const { state } = useLocation();
  const row = state?.row;

  const [view, setView] = useState('diagram');
  const [selected, setSelected] = useState(null);
  const [plan, setPlan] = useState(null); // null | {loading} | {rows} | {error}

  const analysisPath = `${engine?.dashboardPath(id)}/slow-queries/detail`;
  // A caller that is not the slow-query list (the Oracle service drill-down's
  // SQL page) passes its own page as `backTo`, so Back returns there.
  const backPath = state?.backTo || analysisPath;

  const load = async () => {
    setPlan({ loading: true });
    try {
      const res = await requestPlan(engine, id, row);
      if (res.status === 'error') throw new Error(res.error || 'The plan request failed.');
      // Only Oracle returns v$sql_plan rows, which is what the canvas and the
      // table below are built around. Every other engine's shape is handed to
      // PlanResult, exactly as it was before this page existed.
      const oracleRows = Array.isArray(res.plan) && res.plan.length
        && typeof res.plan[0] === 'object' && res.plan[0] !== null && 'operation' in res.plan[0];
      setPlan({ rows: oracleRows ? res.plan : [], raw: res, native: !oracleRows });
    } catch (e) {
      setPlan({ error: e?.message || String(e) });
    }
  };

  /* Oracle's plan is a READ of v$sql_plan — it executes nothing — so it is
     fetched on arrival. Every other engine's "explain" issues a statement
     against the server, so those wait for the button. */
  const [started, setStarted] = useState(false);
  if (engine?.key === 'oracle' && !started && row?.query_id) { setStarted(true); load(); }

  if (!engine) {
    return <><PageHeader title="Execution Plan" icon="branch" /><Notice tone="danger" title="Unknown database technology.">{String(tech)}</Notice></>;
  }

  if (!row) {
    return (
      <>
        <PageHeader title="Execution Plan" icon="branch" backTo={`${engine.dashboardPath(id)}/slow-queries`} />
        <Notice tone="info" title="No query selected.">
          This page plans one statement handed to it by the Query Analysis page.
        </Notice>
        <Button variant="primary" iconRight="chevron-right"
          onClick={() => navigate(`${engine.dashboardPath(id)}/slow-queries`)}>
          Open slow queries
        </Button>
      </>
    );
  }

  const rows = plan?.rows || [];
  const graph = rows.length ? buildPlanGraph(rows) : null;
  const planCost = graph?.planCost ?? null;
  const warnings = fullScanWarnings(rows);

  return (
    <>
      <PageHeader
        title="Execution Plan"
        description="Visualise and analyse the execution plan of this query"
        icon="branch"
        backTo={backPath}
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
        {/* ── view switch and controls ── */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-control border border-border bg-surface p-0.5">
            {[
              { id: 'diagram', icon: 'branch', label: 'Diagram view' },
              { id: 'table', icon: 'list', label: 'Table view' },
            ].map((o) => (
              <button
                key={o.id}
                type="button"
                onClick={() => setView(o.id)}
                className={cn(
                  'flex items-center gap-1.5 rounded-control px-3 py-1.5 text-[12px] font-bold transition-colors',
                  view === o.id ? 'bg-accent text-accent-fg' : 'text-muted hover:bg-sunken hover:text-fg',
                )}
              >
                <Icon name={o.icon} size={13} />
                {o.label}
              </button>
            ))}
          </div>

          <div className="ml-auto flex items-center gap-2">
            {!plan?.rows && !plan?.loading && (
              <Button variant="primary" size="sm" icon="play" onClick={load}>Explain plan</Button>
            )}
            {plan?.rows && (
              <Button variant="secondary" size="sm" icon="refresh" onClick={load}>Re-read plan</Button>
            )}
          </div>
        </div>

        {plan?.loading && <InlineLoading label="Reading the execution plan…" />}

        {plan?.error && (
          <>
            <Notice tone="danger" title="The plan could not be read.">{plan.error}</Notice>
            <Button variant="secondary" icon="refresh" onClick={load}>Try again</Button>
          </>
        )}

        {/* A shape this page has no dedicated view for still renders — the
            engine's own plan output, unchanged. */}
        {plan?.native && <PlanResult data={plan.raw} />}

        {plan?.rows && !plan.native && rows.length === 0 && (
          <Notice tone="info" title="No plan rows for this statement.">
            v$sql_plan returned nothing for this sql_id — the cursor may have aged out of
            the shared pool since the statement last ran.
          </Notice>
        )}

        {rows.length > 0 && (
          <>
            {view === 'diagram' ? (
              <PlanCanvas rows={rows} selectedId={selected} onSelect={setSelected} />
            ) : (
              <PlanTable rows={rows} planCost={planCost} selected={selected} onSelect={setSelected} />
            )}

            {warnings.length > 0 && (
              <section>
                <SectionHead
                  title={`${warnings.length} full table scan${warnings.length === 1 ? '' : 's'}`}
                  subtitle="One per table, however many times the plan reads it"
                />
                <div className="grid gap-gutter-sm md:grid-cols-2">
                  {warnings.map((w) => <ScanWarning key={w.key} warning={w} />)}
                </div>
              </section>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" icon="refresh" onClick={load}>Re-run</Button>
              <Button
                variant="primary"
                icon="brain"
                onClick={() => navigate(analysisPath, { state: { row, runAi: true } })}
              >
                Analyse this query
              </Button>
            </div>
          </>
        )}
      </div>
    </>
  );
}
