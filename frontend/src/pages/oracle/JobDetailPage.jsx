import { useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import client, { errorText } from '@/api/client';
import PageHeader from '@/components/layout/PageHeader';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import Notice from '@/components/ui/Notice';
import Textarea from '@/components/ui/Textarea';
import Toasts, { useToasts } from '@/components/ui/Toast';
import { Panel, SqlBlock, StatCell } from '@/pages/_shared/enginePanels';
import { fmtNumber } from '@/config/dbCatalog';
import { explainWait } from '@/config/oracleWaits';
import { ACTION_LABELS, JOB_STATUS_TONES, fmtIST } from './storageHealthConstants';

/**
 * Real page for one Oracle Storage Health maintenance job — opened by
 * clicking a row on the Maintenance Jobs table. Approval no longer auto-runs
 * anything: an approved job sits idle until a human explicitly clicks "Start
 * Execution" here, and this page then polls the job live so the run is
 * actually watchable instead of a silent background thing that finishes
 * whenever it finishes.
 */

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'rejected']);

function titleCase(snake) {
  return snake.split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

/** Every finding's evidence string is "key=value, key=value, ..." — turn it
 * into readable chips instead of one dense sentence of raw text. */
function parseEvidence(str) {
  if (!str) return [];
  return str.split(/,\s+/).map((part) => {
    const m = part.trim().match(/^([a-zA-Z0-9_ ]+)=(.+?)\.?$/);
    if (m) return { label: titleCase(m[1].trim().replace(/ /g, '_')), value: m[2].trim() };
    return { label: null, value: part.trim() };
  }).filter((p) => p.value);
}

function elapsedText(startIso) {
  if (!startIso) return null;
  const secs = Math.max(0, Math.floor((Date.now() - new Date(startIso).getTime()) / 1000));
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

function durationText(startIso, endIso) {
  if (!startIso || !endIso) return null;
  const secs = Math.max(0, Math.floor((new Date(endIso).getTime() - new Date(startIso).getTime()) / 1000));
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

function parseRecipients(str) {
  return str.split(',').map((s) => s.trim()).filter(Boolean);
}

export default function OracleJobDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { state } = useLocation();
  const qc = useQueryClient();
  const { toasts, push, dismiss } = useToasts();
  const snapshot = state?.job;
  const backTo = `/oracle-dashboard/${id}/storage-health`;

  const [aiThread, setAiThread] = useState([]);
  const [aiQuestion, setAiQuestion] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [recipients, setRecipients] = useState('');
  const [scheduleAt, setScheduleAt] = useState('');

  const jobQ = useQuery({
    queryKey: ['oracleMaintenanceJob', snapshot?.id],
    queryFn: () => client.get(`/oracle-maintenance/jobs/${snapshot.id}`).then((r) => r.data),
    enabled: !!snapshot,
    initialData: snapshot,
    retry: false,
    // Live while it's on its way to running or actually running; stop once
    // it lands somewhere terminal — no point polling a finished job forever.
    refetchInterval: (query) => {
      const st = query.state.data?.status;
      return st && TERMINAL_STATUSES.has(st) ? false : 2000;
    },
  });

  // jobQ.data reflects the live polled status (not the frozen router-state
  // snapshot) once the first poll lands, so this tracks the real transition
  // through approved -> running -> terminal, not just the initial state.
  const liveStatus = jobQ.data?.status || snapshot?.status;
  const liveStartRequestedAt = jobQ.data?.start_requested_at ?? snapshot?.start_requested_at;
  const runningLiveGuess = liveStatus === 'running' || (liveStatus === 'approved' && !!liveStartRequestedAt);

  // Real, live activity from the database itself while the DDL is actually
  // executing — not just a client-side timer. The agent opens one real
  // Oracle session to run the statement, so it's findable in v$session for
  // as long as it's running.
  const liveSessionQ = useQuery({
    queryKey: ['oracleLiveQueriesForJob', id],
    queryFn: () => client.get(`/connections/oracle/${id}/oracle-live-queries`).then((r) => r.data),
    enabled: !!snapshot && runningLiveGuess,
    refetchInterval: 2000,
    retry: false,
  });

  const startMut = useMutation({
    mutationFn: () => client.post(`/oracle-maintenance/jobs/${snapshot.id}/start`, {
      recipients: parseRecipients(recipients),
    }).then((r) => r.data),
    onSuccess: () => {
      push('Started — the runner will pick it up within a few seconds.', 'success');
      qc.invalidateQueries({ queryKey: ['oracleMaintenanceJob', snapshot.id] });
      qc.invalidateQueries({ queryKey: ['oracleMaintenanceJobs', id] });
      qc.invalidateQueries({ queryKey: ['oracleMaintenanceJobsAll'] });
    },
    onError: (e) => push(errorText(e), 'error'),
  });

  const scheduleMut = useMutation({
    mutationFn: () => client.post(`/oracle-maintenance/jobs/${snapshot.id}/schedule`, {
      scheduled_at: new Date(scheduleAt).toISOString(),
      recipients: parseRecipients(recipients),
    }).then((r) => r.data),
    onSuccess: (data) => {
      push(`Scheduled for ${fmtIST(data.scheduled_at)} — it will start automatically.`, 'success');
      qc.invalidateQueries({ queryKey: ['oracleMaintenanceJob', snapshot.id] });
      qc.invalidateQueries({ queryKey: ['oracleMaintenanceJobs', id] });
      qc.invalidateQueries({ queryKey: ['oracleMaintenanceJobsAll'] });
    },
    onError: (e) => push(errorText(e), 'error'),
  });

  if (!snapshot) {
    return (
      <>
        <PageHeader title="Maintenance Job" icon="clipboard" backTo={backTo} />
        <Notice tone="info" title="No job selected.">
          This page shows detail for one maintenance job handed to it from Storage Health — open it by clicking a row there.
        </Notice>
        <Button variant="primary" iconRight="chevron-right" onClick={() => navigate(backTo)}>Open Storage Health</Button>
      </>
    );
  }

  const j = jobQ.data || snapshot;
  const hasStartOrSchedule = !!j.start_requested_at || !!j.scheduled_at;
  const queuedNotStarted = j.status === 'approved' && !hasStartOrSchedule;
  const scheduledPending = j.status === 'approved' && !!j.scheduled_at && !j.start_requested_at;
  const runningLive = j.status === 'running' || (j.status === 'approved' && !!j.start_requested_at);
  const evidenceChips = parseEvidence(j.evidence);

  // Match by the bare object name in the live SQL text — the agent's session
  // running "ALTER TABLE OWNER.NAME SHRINK SPACE" shows up in v$session like
  // any other session, so this is a real signal, not a guess.
  const bareName = (j.object_name.split('.').slice(-1)[0] || j.object_name).toUpperCase();
  const liveSession = (liveSessionQ.data?.queries || []).find((s) =>
    (s.sql_text || s.sql_fulltext || '').toUpperCase().includes(bareName));
  const liveWait = liveSession ? explainWait(liveSession.wait_event, liveSession.wait_class) : null;

  const askAi = async (question) => {
    setAiLoading(true);
    try {
      const facts = {
        status: j.status, proposed_sql: j.proposed_sql, executed_sql: j.executed_sql,
        requested_at: j.requested_at, approved_at: j.approved_at,
        start_requested_at: j.start_requested_at, execution_started_at: j.execution_started_at,
        execution_ended_at: j.execution_ended_at, reclaimed_mb: j.reclaimed_mb,
        error_details: j.error_details, rejection_reason: j.rejection_reason,
        before_size_mb: j.before_metrics?.size_mb, after_size_mb: j.after_metrics?.size_mb,
      };
      const res = await client.post(`/connections/oracle/${id}/oracle-storage-ai-explain`, {
        object_type: j.object_type,
        object_label: j.object_name,
        problem: j.detected_issue,
        evidence: j.evidence,
        expected_benefit: j.expected_benefit,
        risk: j.risk,
        facts,
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
        title={j.object_name}
        description={`${ACTION_LABELS[j.recommended_action] || j.recommended_action} · ${j.object_type}`}
        icon="clipboard"
        backTo={backTo}
        actions={<Badge tone={JOB_STATUS_TONES[j.status] || 'neutral'} size="sm">{String(j.status).replace('_', ' ')}</Badge>}
      />
      <Toasts toasts={toasts} onDismiss={dismiss} />

      <div className="space-y-gutter">
        <Panel title="Finding that triggered this job" icon="alert">
          <div className="space-y-4">
            <p className="text-[16px] font-bold text-fg">{j.detected_issue}</p>

            <div>
              <p className="mb-2 text-[12px] font-bold tracking-wide text-subtle uppercase">Evidence</p>
              <div className="flex flex-wrap gap-2">
                {evidenceChips.map((c, i) => (
                  <span key={i} className="rounded-control border border-border bg-surface px-3 py-1.5 text-[13px]">
                    {c.label ? <><span className="text-muted">{c.label}: </span><span className="font-bold text-fg">{c.value}</span></> : <span className="font-semibold text-fg">{c.value}</span>}
                  </span>
                ))}
              </div>
            </div>

            <div className="grid gap-gutter-sm sm:grid-cols-2">
              <div className="rounded-card bg-success-soft p-3.5">
                <p className="mb-1 text-[12px] font-bold tracking-wide text-success-fg uppercase">Expected Benefit</p>
                <p className="text-[13px] font-medium text-success-fg">{j.expected_benefit || '—'}</p>
              </div>
              <div className="rounded-card bg-warning-soft p-3.5">
                <p className="mb-1 text-[12px] font-bold tracking-wide text-warning-fg uppercase">Risk</p>
                <p className="text-[13px] font-medium text-warning-fg">{j.risk || '—'}</p>
              </div>
            </div>
          </div>
        </Panel>

        <Panel title="Proposed SQL" icon="terminal">
          <SqlBlock sql={j.proposed_sql} />
        </Panel>

        {j.status === 'pending_approval' && (
          <Notice tone="warning" title="Awaiting approval.">
            Approve or reject this from the Maintenance Jobs table on Storage Health — once approved, come back here to start it.
          </Notice>
        )}

        {j.status === 'rejected' && (
          <Notice tone="neutral" title="Rejected — nothing was run.">
            {j.rejection_reason || 'No reason given.'}
          </Notice>
        )}

        {queuedNotStarted && (
          <Panel title="Ready to run" icon="play" subtitle="Approved — nothing runs until you start or schedule it">
            <div className="space-y-3">
              <p className="text-[12px] text-muted">
                This will execute the statement above against <span className="font-semibold text-fg">{j.object_name}</span>.
              </p>

              <div>
                <label className="mb-1 block text-[11px] font-bold tracking-wide text-subtle uppercase">
                  Notify by email (optional)
                </label>
                <Input
                  value={recipients}
                  onChange={(e) => setRecipients(e.target.value)}
                  placeholder="dba@company.com, ops@company.com"
                  size="sm"
                />
                <p className="mt-1 text-[11px] text-subtle">Sent when this starts, and again when it succeeds or fails.</p>
              </div>

              <div className="flex flex-wrap items-end gap-3 border-t border-border pt-3">
                <Button variant="primary" icon="play" loading={startMut.isPending} onClick={() => startMut.mutate()}>
                  Start Execution Now
                </Button>

                <span className="text-[11px] text-subtle">— or —</span>

                <div>
                  <label className="mb-1 block text-[11px] font-bold tracking-wide text-subtle uppercase">Schedule for</label>
                  <Input
                    type="datetime-local"
                    value={scheduleAt}
                    onChange={(e) => setScheduleAt(e.target.value)}
                    size="sm"
                    wrapperClassName="w-52"
                  />
                </div>
                <Button
                  variant="secondary" icon="clock" loading={scheduleMut.isPending}
                  disabled={!scheduleAt} onClick={() => scheduleMut.mutate()}
                >
                  Schedule
                </Button>
              </div>
            </div>
          </Panel>
        )}

        {scheduledPending && (
          <Notice tone="info" title={`Scheduled for ${fmtIST(j.scheduled_at)}.`}>
            This will start automatically at that time — no further action needed.
            {j.notification_recipients?.length > 0 && ` ${j.notification_recipients.join(', ')} will be notified.`}
          </Notice>
        )}

        {runningLive && (
          <Panel title="Running now" icon="activity" subtitle="Live — this page polls every 2 seconds">
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <span className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-accent" />
                <p className="text-[13px] text-fg">
                  {j.execution_started_at
                    ? `Executing on ${j.object_name} — ${elapsedText(j.execution_started_at)} elapsed.`
                    : 'Queued — waiting for the maintenance runner to pick it up (usually within a few seconds).'}
                </p>
              </div>

              {j.execution_started_at && liveSession && (
                <div className="grid grid-cols-2 gap-gutter-sm sm:grid-cols-4">
                  <StatCell label="SID" value={`${liveSession.sid},${liveSession.serial_number}`} />
                  <StatCell label="Status" value={liveSession.status} />
                  <StatCell label="Waiting On" value={liveSession.wait_event || 'On CPU'} />
                  <StatCell label="Wait Class" value={liveSession.wait_class || '—'} />
                </div>
              )}
              {j.execution_started_at && liveWait && (
                <p className="text-[12px] text-muted">{liveWait.why}</p>
              )}
              {j.execution_started_at && !liveSession && (
                <p className="text-[11px] text-subtle">
                  No matching session found in v$session right now — either it hasn't shown up yet, or it's between polls. This does not mean the statement stopped.
                </p>
              )}
            </div>
          </Panel>
        )}

        {j.status === 'succeeded' && (
          <Panel title="Result" icon="check" subtitle={j.execution_ended_at ? `Completed ${fmtIST(j.execution_ended_at)}` : undefined}>
            <div className="grid grid-cols-2 gap-gutter-sm sm:grid-cols-3">
              <StatCell label="Started" value={j.execution_started_at ? fmtIST(j.execution_started_at) : '—'} />
              <StatCell label="Completed" value={j.execution_ended_at ? fmtIST(j.execution_ended_at) : '—'} />
              <StatCell label="Duration" value={durationText(j.execution_started_at, j.execution_ended_at) || '—'} />
              <StatCell label="Before" value={j.before_metrics?.size_mb != null ? `${fmtNumber(j.before_metrics.size_mb)} MB` : '—'} />
              <StatCell label="After" value={j.after_metrics?.size_mb != null ? `${fmtNumber(j.after_metrics.size_mb)} MB` : '—'} />
              <StatCell label="Reclaimed" value={j.reclaimed_mb != null ? `${fmtNumber(j.reclaimed_mb)} MB` : '—'} tone="good" />
            </div>
            {j.reclaimed_mb === 0 && (
              <p className="mt-2 text-[11px] text-subtle">
                0 MB reclaimed can mean an earlier attempt already shrank this object — check History for a prior run on the same object.
              </p>
            )}
          </Panel>
        )}

        {j.status === 'failed' && (
          <Panel title="Result" icon="alert" subtitle={j.execution_ended_at ? `Failed ${fmtIST(j.execution_ended_at)}` : undefined}>
            <div className="grid grid-cols-2 gap-gutter-sm sm:grid-cols-3">
              <StatCell label="Started" value={j.execution_started_at ? fmtIST(j.execution_started_at) : '—'} />
              <StatCell label="Failed At" value={j.execution_ended_at ? fmtIST(j.execution_ended_at) : '—'} />
              <StatCell label="Duration" value={durationText(j.execution_started_at, j.execution_ended_at) || '—'} />
            </div>
            <Notice tone="danger" title="Execution failed." className="mt-3">
              {j.error_details || 'No error detail was recorded.'}
            </Notice>
          </Panel>
        )}

        <Panel title="Ask ActMon AI" icon="sparkles" subtitle="Grounded only in the real facts on this page — never guesses a number">
          <div className="space-y-3">
            {aiThread.length === 0 && (
              <Button variant="secondary" loading={aiLoading} onClick={() => askAi(null)}>Explain this job in plain English</Button>
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
                placeholder='Ask a question about this job — e.g. "why did nothing get reclaimed"'
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
