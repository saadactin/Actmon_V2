import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import client, { errorText } from '@/api/client';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import Icon from '@/components/ui/Icon';
import { InlineLoading } from '@/components/ui/Loading';
import Notice from '@/components/ui/Notice';
import Select from '@/components/ui/Select';
import Table, { EmptyState } from '@/components/ui/Table';
import Textarea from '@/components/ui/Textarea';
import { Panel, SqlBlock, StatCell } from '@/pages/_shared/enginePanels';
import { fmtNumber, fmtDateTime } from '@/config/dbCatalog';
import { fmtMs } from '@/config/slowQueryCatalog';

/**
 * PostgreSQL Query Plan Analysis — pg_hint_plan-backed "test this plan"
 * workspace. Opened from a selected Slow/Top SQL query (SlowQueryDetailPage
 * passes the query text + connection + database in). Everything here is
 * read-only diagnostics: EXPLAIN never mutates anything, EXPLAIN ANALYZE
 * genuinely executes the SELECT it's given (nothing else) and only ever
 * runs when the user explicitly asks for it via the confirm dialog below —
 * never on mount, never on a timer, never automatically for a whole list.
 *
 * "Better plans, not forced plans": this shows what changed and whether it
 * actually measured faster — it never applies a hint permanently, creates
 * an index, or changes any PostgreSQL setting.
 */

const RESULT_META = {
  improved: { label: 'Improved', tone: 'success' },
  worse: { label: 'Worse', tone: 'danger' },
  same: { label: 'No meaningful change', tone: 'neutral' },
  unknown: { label: 'Not measured — estimated only', tone: 'info' },
};

function PlanNodesTable({ plan, analyzed }) {
  if (!plan) return <p className="text-[12px] text-subtle">Not run yet.</p>;
  const nodes = plan.nodes || [];
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {plan.planning_time != null && <Badge tone="neutral" size="xs">Planning {fmtMs(plan.planning_time)}</Badge>}
        {analyzed && plan.execution_time != null && <Badge tone="info" size="xs">Execution {fmtMs(plan.execution_time)}</Badge>}
        {!analyzed && <Badge tone="warning" size="xs">Estimated plan — not executed</Badge>}
      </div>
      <Table
        columns={[
          { key: 'node', label: 'Node' },
          { key: 'rel', label: 'Relation' },
          { key: 'r', label: analyzed ? 'Actual rows' : 'Est. rows', align: 'right' },
          { key: 't', label: analyzed ? 'Actual time' : 'Est. cost', align: 'right' },
        ]}
        rows={nodes.map((n, i) => ({
          key: i,
          cells: {
            node: (
              <span className="font-mono text-[11px]">
                {'  '.repeat(n.depth || 0)}{n.node_type}
                {String(n.node_type || '').includes('Seq Scan') && <Badge tone="danger" size="xs" className="ml-1.5">seq scan</Badge>}
              </span>
            ),
            rel: <span className="font-mono text-[11px] text-muted">{n.relation || n.alias || '—'}</span>,
            r: <span className="font-mono">{fmtNumber(analyzed ? n.actual_rows : n.plan_rows)}</span>,
            t: (
              <span className="font-mono">
                {analyzed
                  ? (n.actual_total_time != null ? fmtMs(n.actual_total_time) : '—')
                  : (n.total_cost != null ? n.total_cost.toFixed(2) : '—')}
              </span>
            ),
          },
        }))}
        empty={<EmptyState icon="terminal" title="No plan nodes" />}
      />
      {(plan.hints || []).map((h, i) => (
        <Notice key={i} tone={h.level === 'critical' ? 'danger' : 'warning'} title={h.title}>
          {h.text}{h.fix && <span className="mt-0.5 block italic text-subtle">{h.fix}</span>}
        </Notice>
      ))}
    </div>
  );
}

export default function PgHintPlanPanel({ connId, sqlText, database }) {
  const qc = useQueryClient();
  const [hintText, setHintText] = useState('/*+\n  \n*/');
  const [template, setTemplate] = useState('');
  const [analyzeWanted, setAnalyzeWanted] = useState(false);
  const [confirmAnalyze, setConfirmAnalyze] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [openHistoryId, setOpenHistoryId] = useState(null);

  const availabilityQ = useQuery({
    queryKey: ['pgHintPlanAvailability', connId],
    queryFn: () => client.get(`/connections/postgresql/${connId}/pg-hint-plan/availability`).then((r) => r.data),
    retry: false,
    staleTime: 5 * 60_000,
  });

  const templatesQ = useQuery({
    queryKey: ['pgHintPlanTemplates', connId],
    queryFn: () => client.get(`/connections/postgresql/${connId}/pg-hint-plan/templates`).then((r) => r.data),
    retry: false,
    staleTime: Infinity,
  });

  const validateMut = useMutation({
    mutationFn: () => client.post(`/connections/postgresql/${connId}/pg-hint-plan/validate`, {
      hint_text: hintText, database,
    }).then((r) => r.data),
  });

  const compareMut = useMutation({
    mutationFn: (analyze) => client.post(`/connections/postgresql/${connId}/pg-hint-plan/compare`, {
      sql_text: sqlText, hint_text: hintText.trim() ? hintText : null, analyze, database,
    }).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pgHintPlanHistory', connId] });
    },
  });

  const historyQ = useQuery({
    queryKey: ['pgHintPlanHistory', connId],
    queryFn: () => client.get(`/connections/postgresql/${connId}/pg-hint-plan/history`).then((r) => r.data),
    enabled: historyOpen,
    retry: false,
  });

  const historyDetailQ = useQuery({
    queryKey: ['pgHintPlanHistoryDetail', openHistoryId],
    queryFn: () => client.get(`/pg-hint-plan/history/${openHistoryId}`).then((r) => r.data),
    enabled: openHistoryId != null,
    retry: false,
  });

  const templateOptions = useMemo(() => (templatesQ.data?.templates || []).map((t) => ({
    id: t.name, label: `${t.name} — ${t.description}`,
  })), [templatesQ.data]);

  const insertTemplate = (name) => {
    setTemplate(name);
    const t = (templatesQ.data?.templates || []).find((x) => x.name === name);
    if (t) setHintText(`/*+\n  ${t.example}\n*/`);
  };

  const runTest = (analyze) => {
    setAnalyzeWanted(analyze);
    if (analyze) { setConfirmAnalyze(true); return; }
    compareMut.mutate(false);
  };

  const shown = openHistoryId != null ? historyDetailQ.data : compareMut.data;
  const availability = availabilityQ.data;

  return (
    <Panel title="Query Plan Analysis" icon="terminal" subtitle="pg_hint_plan — test an alternative plan and compare it against the original, side by side">
      <div className="space-y-gutter">
        {availabilityQ.isLoading ? <InlineLoading label="Checking pg_hint_plan availability…" /> : availability?.status === 'error' ? (
          <Notice tone="danger" title="Could not check pg_hint_plan availability.">{availability.error}</Notice>
        ) : (
          <div className={`flex items-start gap-3 rounded-card border p-3.5 ${availability?.can_use ? 'border-success-soft bg-success-soft' : 'border-warning-soft bg-warning-soft'}`}>
            <Icon name={availability?.can_use ? 'check' : 'alert'} size={18} className={availability?.can_use ? 'text-success-fg' : 'text-warning-fg'} />
            <div>
              <p className={`text-[13px] font-bold ${availability?.can_use ? 'text-success-fg' : 'text-warning-fg'}`}>
                pg_hint_plan: {availability?.installed ? 'Installed' : 'Not Installed'}
                {availability?.version ? ` (v${availability.version})` : ''} · Available: {availability?.can_use ? 'Yes' : 'No'}
              </p>
              <p className="mt-0.5 text-[12px] text-muted">{availability?.message}</p>
            </div>
          </div>
        )}

        <div>
          <p className="mb-1.5 text-[12px] font-bold uppercase tracking-wide text-subtle">Original Query</p>
          <SqlBlock sql={sqlText} />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" icon="play" loading={compareMut.isPending && !analyzeWanted} onClick={() => runTest(false)}>
            EXPLAIN
          </Button>
          <Button size="sm" variant="secondary" icon="alert" loading={compareMut.isPending && analyzeWanted} onClick={() => runTest(true)}>
            EXPLAIN ANALYZE
          </Button>
          <span className="text-[11px] text-subtle">EXPLAIN reads the plan only. EXPLAIN ANALYZE actually runs the query — asks first.</span>
        </div>

        {compareMut.error && <Notice tone="danger" title="Could not run EXPLAIN.">{errorText(compareMut.error)}</Notice>}

        {shown && (
          <>
            <div className="grid grid-cols-1 gap-gutter lg:grid-cols-2">
              <div>
                <p className="mb-1.5 text-[12px] font-bold uppercase tracking-wide text-subtle">Original Plan</p>
                <PlanNodesTable plan={shown.original_plan} analyzed={shown.analyzed} />
              </div>
              {shown.hinted_plan && (
                <div>
                  <p className="mb-1.5 text-[12px] font-bold uppercase tracking-wide text-subtle">Hinted Plan</p>
                  <PlanNodesTable plan={shown.hinted_plan} analyzed={shown.analyzed} />
                </div>
              )}
            </div>

            {shown.hinted_plan && (
              <div className="rounded-card border border-border p-3.5">
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-[12px] font-bold uppercase tracking-wide text-subtle">Plan Comparison</p>
                  {shown.result && <Badge tone={RESULT_META[shown.result]?.tone || 'neutral'}>{RESULT_META[shown.result]?.label}</Badge>}
                </div>
                <div className="grid grid-cols-2 gap-gutter-sm sm:grid-cols-4">
                  <StatCell label="Original Planning" value={fmtMs(shown.original_planning_ms)} />
                  <StatCell label="Hinted Planning" value={fmtMs(shown.hinted_planning_ms)} />
                  {shown.analyzed ? (
                    <>
                      <StatCell label="Original Execution" value={fmtMs(shown.original_execution_ms)} />
                      <StatCell
                        label="Hinted Execution" value={fmtMs(shown.hinted_execution_ms)}
                        tone={shown.result === 'improved' ? 'good' : shown.result === 'worse' ? 'bad' : 'neutral'}
                      />
                    </>
                  ) : (
                    <p className="col-span-2 self-center text-[11px] text-subtle">
                      Run with EXPLAIN ANALYZE to measure real execution time — estimated cost alone never proves one plan is faster.
                    </p>
                  )}
                </div>
              </div>
            )}
          </>
        )}

        <div className="border-t border-border pt-gutter">
          <p className="mb-1.5 text-[12px] font-bold uppercase tracking-wide text-subtle">Test Plan Hint</p>
          {!availability?.can_use && (
            <Notice tone="warning" title="pg_hint_plan is not available on this connection.">
              You can still run EXPLAIN/EXPLAIN ANALYZE above without a hint. Testing a hint needs pg_hint_plan installed
              and loaded — see the message above for what to fix.
            </Notice>
          )}
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <div className="w-72">
              <label className="mb-1 block text-[11px] font-bold uppercase text-subtle">Insert template</label>
              <Select value={template} onChange={insertTemplate} options={templateOptions} placeholder="Choose a hint type…" size="sm" />
            </div>
            <Button size="sm" variant="secondary" loading={validateMut.isPending} disabled={!availability?.can_use} onClick={() => validateMut.mutate()}>
              Validate Hint
            </Button>
          </div>
          <Textarea
            className="mt-2 font-mono"
            rows={4}
            value={hintText}
            onChange={(e) => setHintText(e.target.value)}
            placeholder={'/*+\n  IndexScan(orders orders_customer_status_idx)\n*/'}
          />
          {validateMut.data && (
            <div className="mt-2 space-y-1.5">
              {(validateMut.data.errors || []).map((e, i) => (
                <p key={`e${i}`} className="text-[12px] text-danger-fg">✕ {e}</p>
              ))}
              {(validateMut.data.warnings || []).map((w, i) => (
                <p key={`w${i}`} className="text-[12px] text-warning-fg">⚠ {w}</p>
              ))}
              {validateMut.data.ok && !validateMut.data.warnings?.length && (
                <p className="text-[12px] text-success-fg">✓ Hint syntax and referenced objects look valid.</p>
              )}
            </div>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              variant="primary" icon="play" disabled={!availability?.can_use || !hintText.trim()}
              loading={compareMut.isPending && !analyzeWanted} onClick={() => runTest(false)}
            >
              Test Plan (EXPLAIN)
            </Button>
            <Button
              variant="secondary" icon="alert" disabled={!availability?.can_use || !hintText.trim()}
              loading={compareMut.isPending && analyzeWanted} onClick={() => runTest(true)}
            >
              Test Plan (EXPLAIN ANALYZE)
            </Button>
          </div>

          <Notice tone="info" title="Use hints for testing and diagnosis." className="mt-3">
            A hint that improves performance today may become harmful as data distribution, statistics, indexes, or
            PostgreSQL versions change. Before adopting one long-term, check statistics freshness, index selectivity,
            and query design — a hint should explain a problem, not hide it.
          </Notice>
        </div>

        <div className="border-t border-border pt-gutter">
          <button
            type="button"
            onClick={() => { setHistoryOpen((o) => !o); setOpenHistoryId(null); }}
            className="flex items-center gap-1.5 text-[12px] font-bold text-accent-text hover:opacity-80"
          >
            <Icon name={historyOpen ? 'chevron-down' : 'chevron-right'} size={14} />
            Plan Comparison History
          </button>
          {historyOpen && (
            historyQ.isLoading ? <InlineLoading label="Loading history…" /> : (
              <Table
                columns={[
                  { key: 'when', label: 'When' },
                  { key: 'hint', label: 'Hint' },
                  { key: 'analyzed', label: 'Mode' },
                  { key: 'result', label: 'Result' },
                  { key: 'exec', label: 'Original → Hinted', align: 'right' },
                ]}
                rows={(historyQ.data?.comparisons || []).map((c) => ({
                  key: c.id,
                  onClick: () => setOpenHistoryId(c.id),
                  cells: {
                    when: <span className="text-[11px] text-muted">{fmtDateTime(c.created_at)}</span>,
                    hint: <span className="max-w-[240px] truncate font-mono text-[11px]" title={c.hint_text}>{c.hint_text ? c.hint_text.replace(/\s+/g, ' ') : '(no hint — plain EXPLAIN)'}</span>,
                    analyzed: <Badge tone={c.analyzed ? 'info' : 'neutral'} size="xs">{c.analyzed ? 'ANALYZE' : 'estimated'}</Badge>,
                    result: c.result ? <Badge tone={RESULT_META[c.result]?.tone || 'neutral'} size="xs">{RESULT_META[c.result]?.label}</Badge> : <span className="text-subtle">—</span>,
                    exec: c.analyzed ? (
                      <span className="font-mono text-[11px]">{fmtMs(c.original_execution_ms)} → {fmtMs(c.hinted_execution_ms)}</span>
                    ) : <span className="text-subtle">—</span>,
                  },
                }))}
                empty={<EmptyState icon="history" title="No comparisons yet" body="Every 'Test Plan' run above is logged here for later review." />}
              />
            )
          )}
        </div>

        <ConfirmDialog
          open={confirmAnalyze}
          title="Run EXPLAIN ANALYZE?"
          tone="warning"
          confirmLabel="Run it"
          cancelLabel="Cancel"
          loading={compareMut.isPending}
          onCancel={() => setConfirmAnalyze(false)}
          onConfirm={() => { setConfirmAnalyze(false); compareMut.mutate(true); }}
        >
          <div className="space-y-2 text-[13px] text-muted">
            <p>
              Unlike plain EXPLAIN, <span className="font-semibold text-fg">EXPLAIN ANALYZE actually executes this query</span> —
              against this connection's live database — to measure real timing. On a large or expensive query this has
              real production impact (I/O, CPU, and time).
            </p>
            <p>A 10-second statement timeout applies, and this never runs automatically — only this one explicit click.</p>
          </div>
        </ConfirmDialog>
      </div>
    </Panel>
  );
}
