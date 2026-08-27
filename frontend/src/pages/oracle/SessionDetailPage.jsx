import { useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import client, { errorText } from '@/api/client';
import PageHeader from '@/components/layout/PageHeader';
import Badge, { LiveBadge } from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import CopyButton from '@/components/ui/CopyButton';
import Icon from '@/components/ui/Icon';
import Notice from '@/components/ui/Notice';
import Table, { EmptyState } from '@/components/ui/Table';
import Textarea from '@/components/ui/Textarea';
import { InlineLoading } from '@/components/ui/Loading';
import Toasts, { useToasts } from '@/components/ui/Toast';
import { MetricTile, Panel, SqlBlock, StatCell, TablePanel } from '@/pages/_shared/enginePanels';
import { fmtNumber } from '@/config/dbCatalog';
import { WAIT_CLASS_TONES, explainWait } from '@/config/oracleWaits';
import { fmtIdle, waitBand } from './LiveQueries';

/**
 * Real page for one live Oracle session — opened by clicking a row on Live
 * Queries, same navigation shape as the other detail pages this session
 * (router state carries the snapshot). Keeps polling the same live-queries
 * list every 5s and re-matches by sid+serial_number so this page stays
 * genuinely live instead of freezing on the moment it was opened; if the
 * session has since ended, it says so and keeps the last known numbers.
 *
 * Nothing heavy loads automatically — Statement and Execution Plan are each
 * behind their own button, and the AI explanation is opt-in, same pattern
 * as the Storage Health object page.
 */

const REFRESH_MS = 5000;
const num = (v) => Number(v) || 0;
const SESSION_TONES = { ACTIVE: 'success', INACTIVE: 'neutral', KILLED: 'danger', SNIPED: 'warning' };

export default function OracleSessionDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { state } = useLocation();
  const { toasts, push, dismiss } = useToasts();
  const snapshot = state?.row;
  const backTo = `/oracle-dashboard/${id}/live-queries`;

  const [showStatement, setShowStatement] = useState(false);
  const [showPlan, setShowPlan] = useState(false);
  const [plan, setPlan] = useState(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [aiThread, setAiThread] = useState([]);
  const [aiQuestion, setAiQuestion] = useState('');
  const [aiLoading, setAiLoading] = useState(false);

  const { data } = useQuery({
    queryKey: ['oracleLiveQueries', id],
    queryFn: () => client.get(`/connections/oracle/${id}/oracle-live-queries`).then((r) => r.data),
    enabled: !!snapshot,
    refetchInterval: REFRESH_MS,
    retry: false,
  });

  if (!snapshot) {
    return (
      <>
        <PageHeader title="Session" icon="activity" backTo={backTo} />
        <Notice tone="info" title="No session selected.">
          This page shows detail for one session handed to it from Live Queries — open it by clicking a row there.
        </Notice>
        <Button variant="primary" iconRight="chevron-right" onClick={() => navigate(backTo)}>Open Live Queries</Button>
      </>
    );
  }

  const live = (data?.queries || []).find((r) => r.sid === snapshot.sid && r.serial_number === snapshot.serial_number);
  const ended = !!data && !live;
  const s = live || snapshot;
  const k = explainWait(s.wait_event, s.wait_class);
  const sql = s.sql_fulltext || s.sql_text || '';
  const band = waitBand(s.seconds_in_wait);

  const fetchPlan = async () => {
    setShowPlan(true);
    if (plan || !s.sql_id) return;
    setPlanLoading(true);
    try {
      const res = await client.get(`/connections/oracle/${id}/oracle-sql-plan`, { params: { sql_id: s.sql_id } });
      setPlan(res.data);
    } catch (e) {
      setPlan({ error: errorText(e) });
    } finally {
      setPlanLoading(false);
    }
  };

  const askAi = async (question) => {
    setAiLoading(true);
    try {
      const facts = {
        status: s.status, username: s.username, machine: s.machine, wait_event: s.wait_event || 'On CPU',
        wait_class: s.wait_class, seconds_in_wait: s.seconds_in_wait, blocking_session: s.blocking_session || null,
        executions: s.executions, avg_elapsed_ms: s.avg_elapsed_ms, avg_cpu_ms: s.avg_cpu_ms,
        buffer_gets: s.buffer_gets, disk_reads: s.disk_reads, connected_since: s.logon_time,
      };
      if (plan?.plan?.length) facts.plan_step_count = plan.plan.length;
      if (plan?.sql_stats?.optimizer_cost != null) facts.plan_cost = plan.sql_stats.optimizer_cost;

      const res = await client.post(`/connections/oracle/${id}/oracle-storage-ai-explain`, {
        object_type: 'session',
        object_label: `SID ${s.sid},${s.serial_number} (${s.username})`,
        problem: `${k.label}${s.wait_event ? ` — ${s.wait_event}` : ''}`,
        evidence: k.why,
        expected_benefit: null,
        risk: null,
        facts: { ...facts, sql_statement: sql ? sql.slice(0, 1500) : '(idle — no current statement)' },
        question: question || null,
        history: aiThread,
      }).then((r) => r.data);

      if (res.status === 'success') {
        setAiThread((prev) => [...prev, { question: question || null, answer: res.answer }]);
        setAiQuestion('');
      } else {
        push(res.error || 'ActMon AI could not answer that.', 'error');
      }
    } catch (e) {
      push(errorText(e), 'error');
    } finally {
      setAiLoading(false);
    }
  };

  return (
    <>
      <PageHeader
        title={`SID ${s.sid}, ${s.serial_number}`}
        description={`${s.username || 'unknown user'}${s.machine ? ` · ${s.machine}` : ''}`}
        icon="activity"
        backTo={backTo}
        actions={(
          <>
            {ended
              ? <Badge tone="neutral" size="sm">Session ended</Badge>
              : <><LiveBadge label="live" tone="success" /><Badge tone={SESSION_TONES[s.status] || 'neutral'} size="sm">{s.status}</Badge></>}
          </>
        )}
      />
      <Toasts toasts={toasts} onDismiss={dismiss} />

      <div className="space-y-gutter">
        {ended && (
          <Notice tone="info" title="This session has ended.">
            Showing the last known snapshot from when you opened this page.
          </Notice>
        )}

        <div className="grid grid-cols-2 gap-gutter-sm sm:grid-cols-3 xl:grid-cols-6">
          <MetricTile label="Executions" value={fmtNumber(s.executions)} icon="activity" />
          <MetricTile label="Avg Elapsed" value={`${fmtNumber(s.avg_elapsed_ms)} ms`} icon="clock" />
          <MetricTile label="Avg CPU" value={`${fmtNumber(s.avg_cpu_ms)} ms`} icon="cpu" />
          <MetricTile label="Buffer Gets" value={fmtNumber(s.buffer_gets)} icon="database" />
          <MetricTile label="Disk Reads" value={fmtNumber(s.disk_reads)} icon="desktop"
            tone={num(s.disk_reads) > num(s.buffer_gets) * 0.1 ? 'warn' : 'neutral'} />
          <MetricTile label="Waiting" value={`${fmtNumber(s.seconds_in_wait)}s`} icon="clock"
            tone={band.label === '30s+' ? 'bad' : band.label === '5–30s' ? 'warn' : 'neutral'} />
        </div>

        <Notice
          tone={k.tone === 'danger' ? 'danger' : k.tone === 'warning' ? 'warning' : 'info'}
          title={`${k.label}${s.wait_event ? ` — ${s.wait_event}` : ''}${s.wait_class ? ` (${s.wait_class})` : ''}.`}
        >
          {k.why} <b className="block pt-1">What to do: {k.action}</b>
          {s.blocking_session && (
            <span className="mt-1 block">
              <Badge tone="danger" size="xs">blocked by SID {s.blocking_session}</Badge>
            </span>
          )}
        </Notice>

        <div className="flex flex-wrap items-center gap-2">
          {sql && !showStatement && (
            <Button variant="secondary" icon="terminal" onClick={() => setShowStatement(true)}>View Statement</Button>
          )}
          {s.sql_id && !showPlan && (
            <Button variant="secondary" icon="layers" loading={planLoading} onClick={fetchPlan}>View Execution Plan</Button>
          )}
        </div>

        {showStatement && sql && (
          <Panel title="Statement" icon="terminal"
            subtitle={s.sql_id ? `sql_id ${s.sql_id}` : undefined}
            actions={<CopyButton text={sql} />}
          >
            <SqlBlock sql={sql} className="max-h-64 overflow-auto" />
          </Panel>
        )}

        {showPlan && s.sql_id && (
          <TablePanel title="Execution plan" icon="layers"
            subtitle={plan?.sql_stats?.optimizer_mode
              ? `Optimiser mode ${plan.sql_stats.optimizer_mode}, cost ${fmtNumber(plan.sql_stats.optimizer_cost)}`
              : 'v$sql_plan for this sql_id'}>
            {planLoading ? (
              <div className="px-card"><InlineLoading label="Reading the plan…" /></div>
            ) : plan?.error ? (
              <p className="px-card py-4 text-[12px] text-muted">{plan.error}</p>
            ) : (
              <>
                <Table
                  columns={[
                    { key: 'op', label: 'Operation' },
                    { key: 'object', label: 'Object' },
                    { key: 'cost', label: 'Cost', align: 'right' },
                    { key: 'rows', label: 'Est. rows', align: 'right' },
                    { key: 'bytes', label: 'Est. bytes', align: 'right' },
                    { key: 'pred', label: 'Predicates' },
                  ]}
                  rows={(plan?.plan || []).map((p) => ({
                    key: String(p.id),
                    cells: {
                      op: (
                        <span className="font-mono text-[11px] whitespace-pre text-fg"
                          style={{ paddingLeft: `${num(p.depth) * 12}px` }}>
                          {p.operation}{p.options ? ` ${p.options}` : ''}
                        </span>
                      ),
                      object: p.object_name ? (
                        <span className="block text-[11px] leading-tight">
                          <span className="block font-mono text-fg">{p.object_name}</span>
                          <span className="block text-subtle">{p.object_owner} · {p.object_type}</span>
                        </span>
                      ) : null,
                      cost: <span className="font-mono">{fmtNumber(p.cost)}</span>,
                      rows: <span className="font-mono">{fmtNumber(p.cardinality)}</span>,
                      bytes: <span className="font-mono text-[11px] text-muted">{fmtNumber(p.bytes)}</span>,
                      pred: (
                        <span className="block max-w-[260px] font-mono text-[10px] leading-snug break-words text-subtle">
                          {p.access_predicates || p.filter_predicates || ''}
                        </span>
                      ),
                    },
                  }))}
                  empty={<EmptyState icon="layers" title="No plan available"
                    body="The statement has aged out of the shared pool, or v$sql_plan is not readable by this login." />}
                />

                {(plan?.indexes_used || []).length > 0 && (
                  <div className="border-t border-border px-card py-2.5">
                    <p className="mb-1.5 text-[11px] font-bold tracking-wide text-subtle uppercase">
                      Indexes this plan uses
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {plan.indexes_used.map((ix, i) => (
                        <Badge key={`${ix.index_name}-${i}`} tone="accent" size="xs">
                          <Icon name="key" size={9} />
                          {ix.index_name || ix.operation}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </TablePanel>
        )}

        <Panel title="Ask ActMon AI" icon="sparkles" subtitle="Grounded only in the real facts on this page — never guesses a number">
          <div className="space-y-3">
            {aiThread.length === 0 && (
              <Button variant="secondary" loading={aiLoading} onClick={() => askAi(null)}>Explain this session in plain English</Button>
            )}
            {aiThread.map((t, i) => (
              <div key={i} className="space-y-1">
                {t.question && <p className="text-[12px] font-semibold text-fg">You asked: {t.question}</p>}
                <p className="rounded-card border border-border bg-surface p-3 text-[13px] leading-relaxed text-fg">{t.answer}</p>
              </div>
            ))}
            <div className="flex items-start gap-2">
              <Textarea
                rows={2}
                value={aiQuestion}
                onChange={(e) => setAiQuestion(e.target.value)}
                placeholder='Ask a question about this session — e.g. "why is it slow" or "is this safe to kill"'
                wrapperClassName="flex-1"
              />
              <Button variant="primary" loading={aiLoading} disabled={!aiQuestion.trim()} onClick={() => askAi(aiQuestion.trim())}>
                Ask
              </Button>
            </div>
          </div>
        </Panel>
      </div>
    </>
  );
}
