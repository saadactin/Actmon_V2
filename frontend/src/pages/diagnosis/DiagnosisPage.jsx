import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import cn from '@/lib/cn';
import client, { errorText } from '@/api/client';
import { serviceAction } from '@/api/servers';
import { usePermissions } from '@/hooks/usePermissions';
import PageHeader from '@/components/layout/PageHeader';
import Tabs from '@/components/ui/Tabs';
import Icon from '@/components/ui/Icon';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import PasswordPrompt from '@/components/ui/PasswordPrompt';
import {
  Section, Stat, StatGrid, MiniTable, Unavailable, SeverityBadge, StatusBadge,
  TerminalEntry, PermissionRequired,
} from './diagnosisKit';

/*
 * DiagnosisPage — a dedicated, full-page troubleshooting workspace. Nothing
 * runs automatically except the passive overview/plan reads on open; every
 * diagnostic command is explicit (checkbox → Run / Run Selected / Run All
 * Safe Diagnostics), and every recovery action requires confirmation +
 * re-auth before it executes. Replaces the old DiagnosisWindow modal.
 */

const fetchOverview = (id) => client.get(`/databases/${id}/diagnose/overview`).then((r) => r.data);
const fetchPlan = (id) => client.get(`/databases/${id}/diagnose/plan`).then((r) => r.data);
const runOneCheck = (id, checkId) => client.get(`/databases/${id}/diagnose/check/${checkId}`).then((r) => r.data);
const postRca = (id, results) => client.post(`/databases/${id}/diagnose/rca`, { results }).then((r) => r.data.rca);
const postAi = (id, bundle) => client.post(`/databases/${id}/diagnose/ai-analysis`, bundle).then((r) => r.data.ai);
const postReport = (id, results, ai) => client.post(`/databases/${id}/diagnose/report`, { results, ai }).then((r) => r.data.report);
const fetchHistoryList = (id) => client.get(`/databases/${id}/diagnose/history`).then((r) => r.data.runs || []);
const fetchHistoryOne = (id, runId) => client.get(`/databases/${id}/diagnose/history/${runId}`).then((r) => r.data.run);
const historyStart = (id) => client.post(`/databases/${id}/diagnose/history/start`).then((r) => r.data.run_id);
const historyRecordCheck = (id, runId, result) => client.post(`/databases/${id}/diagnose/history/${runId}/check`, result);
const historyRecordRca = (id, runId, rca) => client.post(`/databases/${id}/diagnose/history/${runId}/rca`, rca);
const historyRecordAi = (id, runId, ai) => client.post(`/databases/${id}/diagnose/history/${runId}/ai`, ai);
const historyRecordAction = (id, runId, action, unit, result) =>
  client.post(`/databases/${id}/diagnose/history/${runId}/action`, { action, unit, result });

const TAB_DEFS = [
  { id: 'overview', label: 'Overview', icon: 'activity' },
  { id: 'terminal', label: 'Terminal', icon: 'terminal' },
  { id: 'errors', label: 'Errors & Logs', icon: 'report' },
  { id: 'timeline', label: 'Timeline', icon: 'clock' },
  { id: 'rca', label: 'Root Cause & AI', icon: 'search' },
  { id: 'actions', label: 'Recommended Actions', icon: 'wrench' },
  { id: 'history', label: 'History', icon: 'history' },
];

// diagnose_engine.py's CHECKS carry their own finer-grained groups (Service,
// Storage, Config, Install, Connectivity, System, Logs); the new
// db_checks_plan() entries already say "Database". Bucket them into the
// spec's SYSTEM/NETWORK/DATABASE/LOGS headings for the sidebar without
// changing what the backend calls them (that grouping still shows up
// verbatim in /diagnose/plan for anything else that reads it).
const GROUP_BUCKET = {
  Service: 'System', Storage: 'System', Config: 'System', Install: 'System', System: 'System',
  Connectivity: 'Network', Logs: 'Logs', Database: 'Database',
};
const GROUP_ORDER = ['System', 'Network', 'Database', 'Logs'];

export default function DiagnosisPage() {
  const { connId } = useParams();
  const id = Number(connId);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { canHere } = usePermissions();
  const canAct = canHere('execute');

  const [activeTab, setActiveTab] = useState('overview');

  // ── passive data (safe to auto-fetch — no command execution) ───────────
  const [overview, setOverview] = useState(null);
  const [loadingOverview, setLoadingOverview] = useState(false);
  const [loadErr, setLoadErr] = useState(null);
  const [plan, setPlan] = useState([]);
  const [planErr, setPlanErr] = useState(null);

  const loadOverview = useCallback(async () => {
    setLoadingOverview(true); setLoadErr(null);
    try {
      const ov = await fetchOverview(id);
      if (ov.status !== 'success') throw new Error(ov.error || 'Could not load diagnosis overview.');
      setOverview(ov);
    } catch (e) { setLoadErr(errorText(e, 'Could not load diagnosis overview.')); }
    finally { setLoadingOverview(false); }
  }, [id]);

  const loadPlan = useCallback(async () => {
    setPlanErr(null);
    try { setPlan((await fetchPlan(id)).checks || []); }
    catch (e) { setPlanErr(errorText(e, 'Could not load the check catalogue.')); }
  }, [id]);

  useEffect(() => { loadOverview(); loadPlan(); }, [loadOverview, loadPlan]);

  // ── checklist selection + execution (nothing runs until asked) ─────────
  const [selected, setSelected] = useState(() => new Set());
  const toggleSelected = (checkId) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(checkId)) next.delete(checkId); else next.add(checkId);
    return next;
  });

  const [results, setResults] = useState({});
  const resultsRef = useRef({});
  const [runningIds, setRunningIds] = useState(() => new Set());
  const [transcript, setTranscript] = useState([]);
  const [runId, setRunId] = useState(null);
  const runIdRef = useRef(null);
  const [rca, setRca] = useState(null);
  const [rcaLoading, setRcaLoading] = useState(false);

  const ensureRun = useCallback(async () => {
    if (runIdRef.current) return runIdRef.current;
    const rid = await historyStart(id);
    runIdRef.current = rid;
    setRunId(rid);
    return rid;
  }, [id]);

  const computeRca = useCallback(async () => {
    setRcaLoading(true);
    try {
      const r = await postRca(id, Object.values(resultsRef.current));
      setRca(r);
      if (runIdRef.current) historyRecordRca(id, runIdRef.current, r).catch(() => {});
    } catch (e) {
      setRca({ insufficient: true, reason: errorText(e, 'Could not compute root cause.') });
    } finally { setRcaLoading(false); }
  }, [id]);

  const runOne = useCallback(async (checkId) => {
    setRunningIds((prev) => new Set(prev).add(checkId));
    try {
      const rid = await ensureRun();
      const result = await runOneCheck(id, checkId);
      resultsRef.current = { ...resultsRef.current, [checkId]: result };
      setResults(resultsRef.current);
      setTranscript((prev) => [{ ...result, at: new Date().toISOString() }, ...prev]);
      historyRecordCheck(id, rid, result).catch(() => {});
      return result;
    } finally {
      setRunningIds((prev) => { const next = new Set(prev); next.delete(checkId); return next; });
    }
  }, [id, ensureRun]);

  const runMany = useCallback(async (ids) => {
    for (const cid of ids) {
      // eslint-disable-next-line no-await-in-loop
      await runOne(cid);
    }
    await computeRca();
  }, [runOne, computeRca]);

  const runSelected = () => runMany([...selected]);
  const runAllSafe = () => runMany(plan.map((c) => c.id));

  // ── AI analysis (explicit, opt-in — unchanged behaviour) ────────────────
  const [ai, setAi] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);
  const runAi = async () => {
    setAiLoading(true);
    try {
      const bundle = { ...overview, checks: Object.values(resultsRef.current), root_cause_analysis: rca };
      const result = await postAi(id, bundle);
      setAi(result);
      if (runIdRef.current) historyRecordAi(id, runIdRef.current, result).catch(() => {});
    } catch (e) { setAi({ available: false, reason: errorText(e, 'ActmonAI analysis failed.') }); }
    finally { setAiLoading(false); }
  };

  // ── report (advanced action) ────────────────────────────────────────────
  const [report, setReport] = useState(null);
  const [reportLoading, setReportLoading] = useState(false);
  const genReport = async () => {
    setReportLoading(true);
    try { setReport(await postReport(id, Object.values(resultsRef.current), ai)); }
    catch (e) { setReport(`Report generation failed: ${errorText(e)}`); }
    finally { setReportLoading(false); }
  };
  const copyReport = async () => {
    const text = report || await postReport(id, Object.values(resultsRef.current), ai).then((r) => { setReport(r); return r; });
    await navigator.clipboard.writeText(text);
  };

  // ── recovery actions (confirm → re-auth → re-verify) ────────────────────
  const [actionConfirm, setActionConfirm] = useState(null); // { action, unit }
  const [actionPrompt, setActionPrompt] = useState(null);   // { action, unit } — after confirm
  const [recovery, setRecovery] = useState(null);

  const serviceResult = results.service;
  const svcRunning = serviceResult?.status === 'passed';
  const svcStopped = serviceResult?.status === 'failed';
  const serviceUnit = serviceResult?.service_name;

  const runServiceAction = async (pw) => {
    const { action, unit } = actionPrompt;
    const r = await serviceAction(overview.server_id, unit, action, pw);
    setActionPrompt(null);
    setRecovery({ ok: null, message: 'Verifying recovery…' });
    qc.invalidateQueries({ queryKey: ['services', overview.server_id] });
    const svcAfter = await runOne('service');
    const connAfter = await runOne('db_connection');
    const ok = svcAfter.status === 'passed' && connAfter.status === 'passed';
    setRecovery({
      ok,
      message: ok
        ? 'Recovery Successful — service is running and the database is accepting connections.'
        : `Recovery Failed — service: ${svcAfter.detail}; connection: ${connAfter.detail}`,
    });
    if (runIdRef.current) historyRecordAction(id, runIdRef.current, action, unit, ok ? 'success' : 'failed').catch(() => {});
    return r;
  };

  // ── history ──────────────────────────────────────────────────────────────
  const [historyList, setHistoryList] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyDetail, setHistoryDetail] = useState(null);
  useEffect(() => {
    if (activeTab !== 'history') return;
    setHistoryLoading(true);
    fetchHistoryList(id).then(setHistoryList).catch(() => {}).finally(() => setHistoryLoading(false));
  }, [activeTab, id]);
  const openHistoryRun = (runIdToOpen) => {
    fetchHistoryOne(id, runIdToOpen).then(setHistoryDetail).catch(() => {});
  };

  const h = overview?.header;
  const summary = overview?.summary;
  const timeline = overview?.timeline || [];
  const hh = overview?.host_os_health;

  const latestFailure = transcript.find((t) => t.status === 'failed');
  const groupedPlan = GROUP_ORDER
    .map((g) => ({ group: g, items: plan.filter((c) => (GROUP_BUCKET[c.group] || c.group) === g) }))
    .filter((g) => g.items.length);

  const title = (
    <span className="flex items-center gap-2">
      {h?.database_name || `Connection ${id}`}
      {h && <SeverityBadge severity={h.severity} />}
      {h && <Badge tone="neutral" size="sm">{h.current_status}</Badge>}
    </span>
  );
  const description = h
    ? [h.technology, `${h.host}:${h.port}`, h.os_type || 'OS unknown']
        .filter(Boolean).join(' · ')
      + (h.duration_seconds ? ` · Down ${Math.round(h.duration_seconds / 60)}m` : '')
    : 'Loading…';

  return (
    <div>
      <PageHeader
        title={title}
        description={description}
        icon="diagnose"
        tabs={<Tabs tabs={TAB_DEFS} value={activeTab} onChange={setActiveTab} />}
        actions={(
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button variant="secondary" size="sm" icon="refresh" loading={loadingOverview} onClick={loadOverview}>Refresh</Button>
            <Button variant="primary" size="sm" icon="play" disabled={!plan.length} onClick={runAllSafe}>Run Diagnosis</Button>
            <Button variant="secondary" size="sm" icon="report" onClick={() => setActiveTab('errors')}>View Logs</Button>
            <Link to="/alerts" className="inline-flex h-control-sm items-center gap-1.5 rounded-control border border-border px-2.5 text-[12px] font-semibold text-muted transition-colors hover:bg-sunken hover:text-fg">
              <Icon name="bell" size={12} /> View Alert
            </Link>
            <Button variant="ghost" size="sm" icon="close" onClick={() => navigate(-1)}>Close</Button>
          </div>
        )}
      />

      {loadErr && <div className="mb-gutter rounded-control border border-danger-soft bg-danger-soft p-3 text-[13px] text-danger-fg">{loadErr}</div>}

      <div className="grid grid-cols-1 gap-gutter lg:grid-cols-[280px_1fr_260px]">
        {/* ── left: diagnostic checklist ── */}
        <div className="card overflow-hidden lg:sticky lg:top-4 lg:self-start">
          <div className="border-b border-border px-3 py-2.5">
            <h3 className="text-[11px] font-black uppercase tracking-wide text-fg">Diagnostic Checks</h3>
          </div>
          <div className="max-h-[70vh] overflow-y-auto p-2">
            {planErr && <Unavailable reason={planErr} />}
            {groupedPlan.map(({ group, items }) => (
              <div key={group} className="mb-2">
                <p className="px-1.5 py-1 text-[10px] font-bold uppercase tracking-wide text-subtle">{group}</p>
                {items.map((c) => {
                  const running = runningIds.has(c.id);
                  const result = results[c.id];
                  return (
                    <div key={c.id} className="flex items-center gap-1.5 rounded-control px-1.5 py-1 hover:bg-sunken">
                      <input
                        type="checkbox"
                        checked={selected.has(c.id)}
                        onChange={() => toggleSelected(c.id)}
                        className="h-3.5 w-3.5 shrink-0 rounded border-border accent-[var(--accent)]"
                        title={c.why}
                      />
                      <span className="flex-1 truncate-safe text-[12px] font-semibold text-fg" title={c.what}>{c.title}</span>
                      {result && <StatusBadge status={result.status} />}
                      <button
                        type="button"
                        onClick={() => runOne(c.id)}
                        disabled={running}
                        className="rounded-control p-1 text-subtle hover:bg-accent-soft hover:text-accent-text disabled:opacity-50"
                        title={`Run: ${c.command}`}
                      >
                        <Icon name={running ? 'spinner' : 'play'} size={13} className={running ? 'animate-spin' : ''} />
                      </button>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          <div className="flex flex-col gap-2 border-t border-border p-2.5">
            <Button variant="secondary" size="sm" icon="check" disabled={!selected.size} onClick={runSelected}>Run Selected Checks</Button>
            <Button variant="primary" size="sm" icon="play" disabled={!plan.length} onClick={runAllSafe}>Run All Safe Diagnostics</Button>
          </div>
        </div>

        {/* ── center: tabs ── */}
        <div className="min-w-0">
          {activeTab === 'overview' && (
            <>
              <Section title="Diagnosis Summary" icon="activity" tone="accent">
                <StatGrid>
                  <Stat label="Current Status" value={summary?.current_status} tone={svcStopped ? 'danger' : svcRunning ? 'success' : undefined} />
                  <Stat label="Confidence" value={rca ? `${rca.confidence}%` : '—'} />
                  <Stat label="Detected At" value={rca?.detected_at || summary?.detected_at || '—'} />
                  <Stat label="Last Heartbeat" value={summary?.last_successful_heartbeat ? new Date(summary.last_successful_heartbeat).toLocaleString() : '—'} />
                </StatGrid>
              </Section>
              <Section title="Host / OS Health" icon="cpu" tone="neutral">
                {hh?.available ? (
                  <StatGrid>
                    <Stat label="CPU" value={hh.cpu} tone={Number(hh.cpu) > 85 ? 'danger' : undefined} />
                    <Stat label="Memory" value={hh.memory} tone={Number(hh.memory) > 85 ? 'danger' : undefined} />
                    <Stat label="Disk" value={hh.disk} tone={Number(hh.disk) > 90 ? 'danger' : undefined} />
                    <Stat label="Uptime" value={hh.uptime} />
                  </StatGrid>
                ) : <Unavailable reason={hh?.reason} />}
              </Section>
              <Section title="Last Successful Connection" icon="wifi" tone="info">
                <StatGrid>
                  <Stat label="Last Successful Heartbeat" value={summary?.last_successful_heartbeat ? new Date(summary.last_successful_heartbeat).toLocaleString() : '—'} />
                  <Stat label="Last Successful Connection" value={summary?.last_successful_connection ? new Date(summary.last_successful_connection).toLocaleString() : '—'} />
                </StatGrid>
                <p className="mt-2 text-[12px] text-subtle">Run the "Database Connection" check (left sidebar) for a live, fresh answer.</p>
              </Section>
            </>
          )}

          {activeTab === 'terminal' && (
            <div className="space-y-3">
              {transcript.length === 0 && <Unavailable reason="No checks run yet this session — select checks on the left and run them to build a transcript here." />}
              {transcript.map((entry, i) => (
                <TerminalEntry
                  key={`${entry.id}-${i}`}
                  entry={entry}
                  onCopyCommand={(cmd) => navigator.clipboard.writeText(cmd || '')}
                  onRunAgain={(e2) => runOne(e2.id)}
                />
              ))}
            </div>
          )}

          {activeTab === 'errors' && (
            <>
              <Section title="Latest Error" icon="alert" tone="danger">
                {latestFailure ? (
                  <div className="rounded-control border-l-4 border-danger bg-danger-soft p-3">
                    <div className="mb-1.5 flex items-center justify-between">
                      <span className="text-[11px] font-bold uppercase text-danger-fg">{latestFailure.title}</span>
                      <span className="text-[11px] text-subtle">{new Date(latestFailure.at).toLocaleString()}</span>
                    </div>
                    <p className="whitespace-pre-wrap break-all font-mono text-[13px] text-fg">{latestFailure.detail}</p>
                    <div className="mt-2 flex gap-3">
                      <button type="button" onClick={() => navigator.clipboard.writeText(latestFailure.output || latestFailure.detail || '')} className="flex items-center gap-1 text-[12px] font-semibold text-accent-text hover:underline">
                        <Icon name="copy" size={12} /> Copy Error
                      </button>
                    </div>
                    <PermissionRequired issue={latestFailure.permissionIssue} />
                  </div>
                ) : <Unavailable reason="No failing check yet. Run 'Database Logs', 'Error Logs' or 'System Journal' from the left sidebar." />}
              </Section>
              <Section title="Error Files & Logs" icon="report" tone="warning">
                {results.db_logs || results.logs || results.journal ? (
                  <MiniTable
                    headers={['Check', 'Status', 'Detail']}
                    rows={['db_logs', 'logs', 'journal'].filter((k) => results[k]).map((k) => [
                      results[k].title, <StatusBadge status={results[k].status} />,
                      <span className="break-all font-mono">{results[k].detail}</span>,
                    ])}
                  />
                ) : <Unavailable reason="Run 'Database Logs' (native) or 'Error Logs' / 'System Journal' (OS-level) to see log evidence here." />}
              </Section>
            </>
          )}

          {activeTab === 'timeline' && (
            <Section title="Diagnosis Timeline" icon="clock" tone="neutral">
              <div>
                {timeline.map((t, i) => (
                  <div key={t.label} className="flex items-start gap-3">
                    <div className="flex flex-col items-center">
                      <span className={cn('h-2.5 w-2.5 rounded-full', t.available ? 'bg-accent' : 'bg-neutral-soft')} />
                      {i < timeline.length - 1 && <span className="my-0.5 w-px flex-1 bg-border" style={{ minHeight: 18 }} />}
                    </div>
                    <div className="-mt-0.5 pb-3">
                      <p className={cn('text-[13px] font-semibold', t.available ? 'text-fg' : 'text-subtle')}>{t.label}</p>
                      <p className="text-[11px] text-subtle">{t.available ? (t.timestamp ? new Date(t.timestamp).toLocaleString() : t.timestamp) : 'Not available'}</p>
                    </div>
                  </div>
                ))}
              </div>
            </Section>
          )}

          {activeTab === 'rca' && (
            <>
              <Section title="Root Cause Analysis" icon="search" tone="danger" actions={
                <Button variant="secondary" size="sm" icon="refresh" loading={rcaLoading} disabled={!Object.keys(results).length} onClick={computeRca}>Re-analyze</Button>
              }>
                {rca && !rca.insufficient ? (
                  <div className="space-y-2">
                    <p className="text-[13.5px] font-bold text-fg">{rca.primary_cause}</p>
                    <p className="text-[12px] text-subtle">Confidence: {rca.confidence}%</p>
                    {rca.evidence?.length > 0 && (
                      <ul className="list-inside list-disc space-y-1 text-[12.5px] text-muted">
                        {rca.evidence.map((e, i) => <li key={i}>{typeof e === 'string' ? e : JSON.stringify(e)}</li>)}
                      </ul>
                    )}
                  </div>
                ) : <Unavailable reason={rca?.reason || 'Root cause could not be determined from the available diagnostics — run some checks first.'} />}
                {rca?.missing_checks?.length > 0 && <p className="mt-2 text-[11px] text-subtle">Missing checks: {rca.missing_checks.join(', ')}</p>}
              </Section>
              <Section title="ActmonAI Analysis" icon="sparkles" tone="accent">
                {!ai && <Button variant="primary" icon="sparkles" loading={aiLoading} disabled={aiLoading} onClick={runAi}>Run ActmonAI Analysis</Button>}
                {ai?.available && (
                  <div className="mt-1 space-y-2">
                    <p className="text-[13.5px] text-fg">{ai.diagnosis}</p>
                    <p className="text-[13px] font-bold text-fg">Root cause: {ai.root_cause}</p>
                    {ai.evidence?.length > 0 && (
                      <ul className="list-inside list-disc space-y-1 text-[12.5px] text-muted">
                        {ai.evidence.map((e, i) => <li key={i}>{e}</li>)}
                      </ul>
                    )}
                    <p className="text-[13px] text-fg"><span className="font-bold">Recommended:</span> {ai.recommended_resolution}</p>
                    <p className="text-[11px] text-subtle">Confidence: {ai.confidence}%</p>
                  </div>
                )}
                {ai && !ai.available && <Unavailable reason={ai.reason} />}
              </Section>
            </>
          )}

          {activeTab === 'actions' && (
            <>
              <Section title="Diagnostic Actions" icon="wrench" tone="info">
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" size="sm" icon="refresh" onClick={loadOverview}>Refresh Diagnosis</Button>
                  <Button variant="secondary" size="sm" icon="play" onClick={runAllSafe}>Run All Safe Diagnostics</Button>
                </div>
              </Section>
              <Section title="Recommended Actions" icon="wrench" tone="warning">
                {rca?.recommended_fix ? (
                  <div className="space-y-2 text-[13px] text-fg">
                    <p>{rca.recommended_fix}</p>
                    {rca.preventive?.length > 0 && (
                      <ul className="list-inside list-disc space-y-1 text-[12.5px] text-muted">
                        {rca.preventive.map((p, i) => <li key={i}>{p}</li>)}
                      </ul>
                    )}
                  </div>
                ) : <Unavailable reason="Run checks and compute a root cause to see recommended actions." />}
              </Section>
              <Section title="Recovery Actions" icon="power" tone="danger">
                {!serviceResult ? (
                  <Unavailable reason="Run the 'Service Status' check first — recovery actions need to know the service's real current state." />
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {svcStopped && canAct && (
                      <Button variant="primary" size="sm" icon="play" onClick={() => setActionConfirm({ action: 'start', unit: serviceUnit })}>Start Service</Button>
                    )}
                    {svcRunning && canAct && (
                      <Button variant="secondary" size="sm" icon="power" onClick={() => setActionConfirm({ action: 'restart', unit: serviceUnit })}>Restart Service</Button>
                    )}
                    {!svcStopped && !svcRunning && <p className="text-[12px] italic text-subtle">Service state is unknown — no restart action is offered until it can be confirmed.</p>}
                    {!canAct && <p className="text-[12px] italic text-subtle">You don't have permission to perform recovery actions here.</p>}
                  </div>
                )}
                {recovery && (
                  <div className={cn('mt-3 flex items-center gap-2 rounded-control p-3 text-[13px] font-semibold',
                    recovery.ok === true ? 'bg-success-soft text-success-fg' : recovery.ok === false ? 'bg-danger-soft text-danger-fg' : 'bg-sunken text-subtle')}>
                    <Icon name={recovery.ok === true ? 'check' : recovery.ok === false ? 'close' : 'spinner'} size={15} className={recovery.ok === null ? 'animate-spin' : undefined} />
                    {recovery.message}
                  </div>
                )}
              </Section>
              <Section title="Advanced Actions" icon="settings" tone="neutral">
                <div className="mb-3 flex flex-wrap gap-2">
                  <Button variant="secondary" size="sm" icon="report" loading={reportLoading} onClick={genReport}>Generate Diagnostic Report</Button>
                  <Button variant="secondary" size="sm" icon="copy" onClick={copyReport}>Copy Report</Button>
                </div>
                {report && <pre className="max-h-80 overflow-y-auto whitespace-pre-wrap rounded-control bg-inverse p-3 font-mono text-[11px] text-on-inverse">{report}</pre>}
              </Section>
            </>
          )}

          {activeTab === 'history' && (
            <Section title="Diagnostic History" icon="history" tone="neutral">
              {historyLoading && <p className="text-[13px] text-subtle">Loading…</p>}
              {!historyLoading && (
                <MiniTable
                  headers={['Started', 'Status', 'Checks', 'Root Cause', 'Actions']}
                  emptyMsg="No previous diagnosis runs for this connection yet."
                  rows={historyList.map((r) => [
                    <button type="button" className="text-accent-text hover:underline" onClick={() => openHistoryRun(r.id)}>{new Date(r.started_at).toLocaleString()}</button>,
                    <Badge tone="neutral" size="sm">{r.status || '—'}</Badge>,
                    String((r.checks_run || []).length),
                    r.root_cause || '—',
                    String((r.actions_performed || []).length),
                  ])}
                />
              )}
              {historyDetail && (
                <div className="mt-4 border-t border-border pt-3">
                  <p className="mb-2 text-[12px] font-bold uppercase tracking-wide text-subtle">Run #{historyDetail.id} — {new Date(historyDetail.started_at).toLocaleString()}</p>
                  <StatGrid>
                    <Stat label="Status" value={historyDetail.status} />
                    <Stat label="Severity" value={historyDetail.severity} />
                    <Stat label="Confidence" value={historyDetail.confidence != null ? `${historyDetail.confidence}%` : '—'} />
                    <Stat label="Checks Run" value={(historyDetail.checks_run || []).length} />
                  </StatGrid>
                  <p className="mt-3 text-[13px] text-fg">{historyDetail.root_cause || 'No root cause recorded.'}</p>
                  {historyDetail.checks_run?.length > 0 && (
                    <MiniTable headers={['Check', 'Status']} rows={historyDetail.checks_run.map((c) => [c.title, <StatusBadge status={c.status} />])} />
                  )}
                  {historyDetail.actions_performed?.length > 0 && (
                    <MiniTable headers={['Action', 'Unit', 'Result', 'At']} rows={historyDetail.actions_performed.map((a) => [a.action, a.unit, a.result, new Date(a.at).toLocaleString()])} />
                  )}
                </div>
              )}
            </Section>
          )}
        </div>

        {/* ── right: summary strip ── */}
        <div className="card h-fit p-4 lg:sticky lg:top-4">
          <p className="mb-3 text-[11px] font-black uppercase tracking-wide text-subtle">Summary</p>
          <div className="space-y-3">
            <div>
              <p className="text-[10px] font-bold uppercase text-subtle">Status</p>
              <p className="text-[14px] font-bold text-fg">{summary?.current_status || '—'}</p>
            </div>
            <div>
              <p className="text-[10px] font-bold uppercase text-subtle">Severity</p>
              {h ? <SeverityBadge severity={h.severity} /> : <p className="text-[14px] text-fg">—</p>}
            </div>
            <div>
              <p className="text-[10px] font-bold uppercase text-subtle">Confidence</p>
              <p className="text-[14px] font-bold text-fg">{rca ? `${rca.confidence}%` : '—'}</p>
            </div>
            <div>
              <p className="text-[10px] font-bold uppercase text-subtle">Root Cause</p>
              <p className="text-[12.5px] text-fg">{rca?.primary_cause || (rcaLoading ? 'Analyzing…' : 'Not yet determined.')}</p>
            </div>
            <div>
              <p className="text-[10px] font-bold uppercase text-subtle">Latest Error</p>
              <p className="text-[12.5px] text-fg">{latestFailure ? `${latestFailure.title}: ${latestFailure.detail}` : 'None captured yet.'}</p>
            </div>
          </div>
        </div>
      </div>

      {actionConfirm && (
        <ConfirmDialog
          open
          title={`${actionConfirm.action === 'start' ? 'Start' : 'Restart'} Service`}
          tone={actionConfirm.action === 'restart' ? 'warning' : 'warning'}
          confirmLabel={actionConfirm.action === 'start' ? 'Continue — Start Service' : 'Continue — Restart Service'}
          onCancel={() => setActionConfirm(null)}
          onConfirm={() => { setActionPrompt(actionConfirm); setActionConfirm(null); }}
        >
          <dl className="space-y-1.5 text-[13px]">
            <div><dt className="inline font-bold text-muted">Server: </dt><dd className="inline text-fg">{h?.host}</dd></div>
            <div><dt className="inline font-bold text-muted">Database: </dt><dd className="inline text-fg">{h?.database_name}</dd></div>
            <div><dt className="inline font-bold text-muted">Service: </dt><dd className="inline text-fg">{actionConfirm.unit}</dd></div>
            <div><dt className="inline font-bold text-muted">Action: </dt><dd className="inline text-fg">{actionConfirm.action === 'start' ? 'Start' : 'Restart'}</dd></div>
            <div><dt className="inline font-bold text-muted">Expected impact: </dt><dd className="inline text-fg">
              {actionConfirm.action === 'start'
                ? 'The database will begin accepting connections once the service starts.'
                : 'The database will be briefly unavailable while the service restarts.'}
            </dd></div>
          </dl>
        </ConfirmDialog>
      )}

      {actionPrompt && (
        <PasswordPrompt
          title={`${actionPrompt.action === 'start' ? 'Start' : 'Restart'} — ${h?.database_name} (${actionPrompt.unit})`}
          confirmLabel={actionPrompt.action === 'start' ? 'Start Service' : 'Restart Service'}
          onConfirm={(pw) => runServiceAction(pw)}
          onClose={() => setActionPrompt(null)}
        />
      )}
    </div>
  );
}
