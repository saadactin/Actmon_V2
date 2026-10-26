/**
 * Oracle → Session Details.
 *
 * One session, addressed by INST_ID + SID + SERIAL# (query string, or the row
 * handed over by Live Queries / Performance). Reads, all by those ids or by
 * the session's SQL_ID — nothing is executed:
 *   oracle-session-detail    GV$SESSION + GV$SESSTAT + current/previous SQL text
 *   oracle-session-activity  GV$SESSION_EVENT waits, blocking, stored CPU samples
 *   oracle-sql-plan / -plan-stats / oracle-sql-detail   the SQL's plan and V$SQL figures
 *   oracle-top-sql           related statements of the same schema
 *
 * An ended session keeps its last snapshot (taken by this page, or the stored
 * top-session record) and says so; nothing is replaced with zeroes, and live
 * actions are not offered for it. There is no kill-session API in ACTMON, so
 * no Kill button is shown.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';

import client from '@/api/client';
import Icon from '@/components/ui/Icon';
import Notice from '@/components/ui/Notice';
import { InlineLoading } from '@/components/ui/Loading';
import { fmtMB, fmtNumber } from '@/config/dbCatalog';
import { explainWait, isIdleWait } from '@/config/oracleWaits';
import { cn } from '@/lib/cn';
import PlanCanvas from '@/pages/_shared/PlanCanvas';
import { PlanTable, ZoomDiagram } from '@/pages/_shared/QueryAnalysisResults';
import { highlight, formatSql } from '@/pages/_shared/QueryAnalysisScreen1';

const NA = 'Not available';
const api = (id, path, params) => client.get(`/connections/oracle/${id}/${path}`, { params, timeout: 60000 }).then((r) => r.data);
const num = (v) => (v == null ? NA : fmtNumber(v));
const secs = (v) => (v == null ? NA : v >= 3600 ? `${Math.floor(v / 3600)}h ${Math.floor((v % 3600) / 60)}m` : v >= 60 ? `${Math.floor(v / 60)}m ${Math.round(v % 60)}s` : `${Number(v).toFixed(1)} s`);
const when = (v) => { if (!v) return NA; const d = new Date(String(v).replace(' ', 'T')); return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString(); };

const TABS = [['overview', 'Overview'], ['plan', 'Execution Plan'], ['sql', 'SQL Details'], ['waits', 'Wait Events'],
  ['blocking', 'Blocking / Blocked'], ['timeline', 'Timeline'], ['performance', 'Performance'], ['related', 'Related SQL']];

/** The session's ids from the URL, else from the row the caller handed over. */
function useSessionIds() {
  const [qs] = useSearchParams();
  const { state } = useLocation();
  const row = state?.row || {};
  const inst = Number(qs.get('inst') || row.inst_id || 1);
  const sid = qs.get('sid') ?? row.sid;
  const serial = qs.get('serial') ?? row.serial_number ?? row.serial;
  return { inst, sid: sid == null ? null : Number(sid), serial: serial == null ? null : Number(serial), row, state };
}

function Card({ icon, title, subtitle, right, children, className }) {
  return (
    <section className={cn('min-w-0 rounded-2xl border border-border bg-surface p-5 shadow-sm', className)}>
      <div className="mb-3 flex items-start gap-3">
        {icon && <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-accent text-accent-fg"><Icon name={icon} size={17} /></span>}
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

function Metric({ icon, tone, label, value, sub, spark }) {
  const t = { blue: 'bg-accent-soft text-accent-text', purple: 'bg-[#8b5cf6]/15 text-[#7c3aed]', red: 'bg-danger-soft text-danger-fg', amber: 'bg-warning-soft text-warning-fg' }[tone || 'blue'];
  return (
    <div className="flex min-h-[112px] items-center gap-3 rounded-2xl border border-border bg-surface p-4 shadow-sm">
      <span className={cn('grid h-11 w-11 shrink-0 place-items-center rounded-full', t)}><Icon name={icon} size={20} /></span>
      <div className="min-w-0 flex-1">
        <p className="text-[12.5px] text-muted">{label}</p>
        <p className="whitespace-nowrap text-[22px] font-bold leading-tight text-fg">{value}</p>
        {sub && <p className="text-[11px] text-subtle">{sub}</p>}
      </div>
      {spark}
    </div>
  );
}

function Spark({ points, k, color = '#3b82f6' }) {
  const vals = (points || []).map((p) => p[k]).filter((v) => v != null);
  if (vals.length < 2) return null;
  const W = 80; const H = 36; const max = Math.max(...vals); const min = Math.min(...vals); const span = max - min || 1;
  const d = vals.map((v, i) => `${i ? 'L' : 'M'}${((i / (vals.length - 1)) * W).toFixed(1)},${(H - 3 - ((v - min) / span) * (H - 6)).toFixed(1)}`).join('');
  return <svg width={W} height={H} className="shrink-0"><path d={d} fill="none" stroke={color} strokeWidth="1.6" /></svg>;
}

function SqlBox({ text, sqlId, label }) {
  const [shown, setShown] = useState(text || '');
  const [copied, setCopied] = useState(false);
  useEffect(() => { setShown(text || ''); }, [text]);
  if (!text) return <p className="text-[12.5px] text-muted">{sqlId ? 'The SQL text has aged out of GV$SQL or cannot be read by the monitoring user.' : `No ${label || 'SQL'} for this session.`}</p>;
  const copy = async () => { try { await navigator.clipboard.writeText(shown); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* blocked */ } };
  const download = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([shown], { type: 'text/plain' })); a.download = `${sqlId || 'session'}.sql`; a.click(); URL.revokeObjectURL(a.href); };
  return (
    <div>
      <div className="mb-2 flex justify-end gap-2">
        {[['Format', 'list', () => setShown(formatSql(shown))], [copied ? 'Copied' : 'Copy', copied ? 'check' : 'copy', copy], ['Download', 'download', download]].map(([l, ic, fn]) => (
          <button key={l} type="button" onClick={fn} className="flex h-8 items-center gap-1.5 rounded-lg border border-border px-3 text-[12.5px] font-semibold text-fg hover:bg-sunken"><Icon name={ic} size={14} />{l}</button>
        ))}
      </div>
      <div className="flex max-h-[280px] overflow-auto rounded-lg border border-border font-mono text-[13px] leading-[21px]">
        <div className="select-none border-r border-border bg-sunken/50 px-3 py-2 text-right text-subtle">{shown.split('\n').map((_, i) => <div key={i}>{i + 1}</div>)}</div>
        <pre className="m-0 flex-1 whitespace-pre px-4 py-2 text-fg">{highlight(shown)}</pre>
      </div>
    </div>
  );
}

function WaitTable({ waits, onPick, picked }) {
  if (waits == null) return <p className="text-[12.5px] text-muted">Wait events could not be read (GV$SESSION_EVENT).</p>;
  const rows = waits.filter((w) => !isIdleWait(w.event, w.wait_class));
  if (!rows.length) return <p className="text-[12.5px] text-muted">This session has not waited on any non-idle event since logon.</p>;
  const total = rows.reduce((a, w) => a + (w.time_waited_s || 0), 0);
  return (
    <table className="w-full text-[12.5px]">
      <thead className="bg-sunken/70 text-left text-[12px] font-semibold text-muted">
        <tr>{['Event', 'Class', 'Wait Time', 'Waits', '% Total', ''].map((h) => <th key={h} className="px-3 py-2">{h}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((w) => {
          const pct = total > 0 ? (w.time_waited_s || 0) / total * 100 : null;
          return (
            <tr key={w.event} className={cn('border-t border-border', picked === w.event && 'bg-accent-softer')}>
              <td className="px-3 py-2"><button type="button" onClick={() => onPick?.(w)} className="text-left text-accent-text underline-offset-2 hover:underline">{w.event}</button></td>
              <td className="px-3">{w.wait_class || NA}</td>
              <td className="px-3">{secs(w.time_waited_s)}</td>
              <td className="px-3">{num(w.total_waits)}</td>
              <td className="px-3">{pct == null ? '—' : `${pct.toFixed(1)}%`}</td>
              <td className="w-32 px-3"><span className="block h-2 rounded-full bg-sunken"><span className="block h-full rounded-full bg-accent" style={{ width: `${pct || 0}%` }} /></span></td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function TimelineChart({ points }) {
  const vals = points.map((p) => p.cpu_pct ?? 0);
  const W = 900; const H = 200; const pad = 40;
  const max = Math.max(1, ...vals);
  const x = (i) => pad + (points.length <= 1 ? 0 : (i / (points.length - 1)) * (W - pad * 1.5));
  const y = (v) => H - 24 - (v / max) * (H - 40);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.cpu_pct ?? 0).toFixed(1)}`).join('');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
      {[0, 0.5, 1].map((k) => (<g key={k}><line x1={pad} x2={W - 10} y1={y(max * k)} y2={y(max * k)} stroke="var(--border)" strokeDasharray="3 3" /><text x={pad - 6} y={y(max * k) + 4} textAnchor="end" fontSize="11" fill="var(--muted)">{(max * k).toFixed(0)}%</text></g>))}
      <path d={`${d}L${x(points.length - 1)},${H - 24}L${x(0)},${H - 24}Z`} fill="#3b82f6" opacity="0.12" />
      <path d={d} fill="none" stroke="#3b82f6" strokeWidth="2" />
      {points.map((p, i) => <circle key={i} cx={x(i)} cy={y(p.cpu_pct ?? 0)} r="3" fill="#3b82f6"><title>{`${when(`${p.t}:00Z`)} — CPU ${p.cpu_pct == null ? NA : `${p.cpu_pct}%`}${p.sql_id ? ` · SQL ${p.sql_id}` : ''}`}</title></circle>)}
      {[0, Math.floor((points.length - 1) / 2), points.length - 1].filter((v, i, a) => a.indexOf(v) === i).map((i) => (
        <text key={i} x={x(i)} y={H - 6} textAnchor="middle" fontSize="11" fill="var(--muted)">{new Date(`${points[i].t}:00Z`).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</text>
      ))}
    </svg>
  );
}

export default function OracleSessionDetails() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { inst, sid, serial, row, state } = useSessionIds();
  const [tab, setTab] = useState('overview');
  const [picked, setPicked] = useState(null);
  const [planSel, setPlanSel] = useState(null);
  const backTo = state?.backTo || `/oracle-dashboard/${id}/live-queries`;
  const fromPerformance = /\/performance$/.test(backTo);
  const cacheKey = `actmon:session:${id}:${inst}:${sid}:${serial}`;
  const ready = sid != null && serial != null;

  const detail = useQuery({
    queryKey: ['oraSess', id, inst, sid, serial],
    queryFn: () => api(id, 'oracle-session-detail', { inst_id: inst, sid, serial }),
    enabled: ready, refetchInterval: 15000, retry: false,
  });
  const activity = useQuery({
    queryKey: ['oraSessAct', id, inst, sid, serial],
    queryFn: () => api(id, 'oracle-session-activity', { inst_id: inst, sid, serial }),
    enabled: ready, refetchInterval: 30000, retry: false,
  });

  // Keep the last good snapshot, so an ended session still shows what it was.
  const [snap, setSnap] = useState(() => { try { return JSON.parse(sessionStorage.getItem(cacheKey) || 'null'); } catch { return null; } });
  useEffect(() => {
    if (detail.data?.status === 'success') {
      const s = { at: new Date().toISOString(), detail: detail.data, activity: activity.data?.status === 'success' ? activity.data : (snap?.activity || null) };
      setSnap(s);
      try { sessionStorage.setItem(cacheKey, JSON.stringify(s)); } catch { /* storage full or blocked */ }
    }
  }, [detail.data, activity.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const ended = detail.data?.status === 'ended';
  const live = detail.data?.status === 'success' ? detail.data : null;
  const shown = live || (ended ? snap?.detail : null);
  const act = activity.data?.status === 'success' ? activity.data : snap?.activity;
  const s = shown?.session || null;
  const stats = shown?.stats || null;
  const sqlId = s?.sql_id || shown?.current_sql?.sql_id || s?.prev_sql_id || act?.last_stored?.sql_id || row.sql_id || null;

  const plan = useQuery({ queryKey: ['qaPlan', id, sqlId], queryFn: () => api(id, 'oracle-sql-plan', { sql_id: sqlId }).then((r) => (r.status === 'error' ? Promise.reject(new Error(r.error)) : r.plan || [])), enabled: !!sqlId, retry: false, staleTime: 60000 });
  const planStats = useQuery({ queryKey: ['qaPlanStats', id, sqlId], queryFn: () => api(id, 'oracle-sql-plan-stats', { sql_id: sqlId }), enabled: !!sqlId, retry: false, staleTime: 60000 });
  const sqlDetail = useQuery({ queryKey: ['qaDetail', id, sqlId], queryFn: () => api(id, 'oracle-sql-detail', { sql_id: sqlId }), enabled: !!sqlId, retry: false, staleTime: 60000 });
  const topSql = useQuery({ queryKey: ['qaTopSql', id], queryFn: () => api(id, 'oracle-top-sql'), enabled: tab === 'overview' || tab === 'related', retry: false, staleTime: 60000 });

  const refresh = () => { detail.refetch(); activity.refetch(); plan.refetch(); planStats.refetch(); sqlDetail.refetch(); };

  const duration = s?.logon_time ? (Date.now() - new Date(String(s.logon_time).replace(' ', 'T')).getTime()) / 1000 : null;
  const statusLabel = ended ? 'Session Ended' : s?.status ? s.status.charAt(0) + s.status.slice(1).toLowerCase() : null;
  const waitTotal = (act?.waits || []).filter((w) => !isIdleWait(w.event, w.wait_class)).reduce((a, w) => a + (w.time_waited_s || 0), 0);
  const stat = (k) => (stats && stats[k] != null ? stats[k] : null);
  const ioReq = stat('physical read total IO requests') != null || stat('physical write total IO requests') != null
    ? (stat('physical read total IO requests') || 0) + (stat('physical write total IO requests') || 0) : null;
  const sum = sqlDetail.data?.status === 'success' ? sqlDetail.data.summary : null;
  const child0 = sqlDetail.data?.status === 'success' ? sqlDetail.data.children?.[0] : null;
  const related = useMemo(() => {
    const schema = (child0?.parsing_schema || s?.username || '').toUpperCase();
    return (topSql.data?.sql || []).filter((r) => r.sql_id !== sqlId && (!schema || String(r.parsing_schema_name || '').toUpperCase() === schema)).slice(0, 8);
  }, [topSql.data, child0, s, sqlId]);
  const pickedInfo = picked ? explainWait(picked.event, picked.wait_class) : null;
  const openSql = (r) => navigate(`/oracle-dashboard/${id}/slow-queries/detail`, { state: { backTo: `${window.location.pathname}${window.location.search}`, row: { query_id: r.sql_id, query_text: r.sql_fulltext || r.sql_text || '', execution_count: r.executions, average_execution_time: r.avg_elapsed_ms, schema_name: r.parsing_schema_name, _raw: r } } });

  if (!ready) {
    return (
      <div className="space-y-4">
        <Link to={backTo} className="inline-flex items-center gap-2 text-[14px] font-semibold text-accent-text"><Icon name="arrow-left" size={16} />Back</Link>
        <Notice tone="info" title="No session selected.">Open a session from Live Queries or Performance → Top Sessions.</Notice>
      </div>
    );
  }

  const planCard = (big) => (
    <Card icon="branch" title="Execution Plan" subtitle={planStats.data?.collected ? 'Estimated plan with the last execution’s actual figures' : 'Estimated plan (V$SQL_PLAN)'}>
      {!sqlId ? <p className="text-[12.5px] text-muted">This session has no current or previous SQL to plan.</p>
        : plan.isLoading ? <InlineLoading label="Reading the plan…" />
          : plan.error ? <p className="text-[12.5px] text-danger-fg">{String(plan.error.message || plan.error)}</p>
            : !(plan.data || []).length ? <p className="text-[12.5px] text-muted">No plan in the cursor cache for SQL {sqlId} (it may have aged out).</p>
              : big ? (
                <div className="grid gap-4 xl:grid-cols-2">
                  <div className="h-[460px] overflow-hidden rounded-xl border border-border"><PlanCanvas rows={plan.data} selectedId={planSel} onSelect={setPlanSel} /></div>
                  <div className="space-y-3">
                    <PlanTable rows={plan.data} stats={planStats.data} selected={planSel} onSelect={setPlanSel} />
                    <PlanExtras rows={plan.data} stats={planStats.data} />
                  </div>
                </div>
              ) : <ZoomDiagram rows={plan.data} />}
    </Card>
  );

  return (
    <div className="space-y-4">
      {/* breadcrumb */}
      <nav className="flex flex-wrap items-center gap-2 text-[13px] text-muted">
        <Link to={backTo} className="flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 font-semibold text-accent-text shadow-sm hover:bg-sunken"><Icon name="arrow-left" size={14} />Back</Link>
        <Link to={`/oracle-dashboard/${id}`} className="hover:text-accent-text hover:underline">Oracle Dashboard</Link>
        <Icon name="chevron-right" size={12} />
        <Link to={backTo} className="hover:text-accent-text hover:underline">{fromPerformance ? 'Performance' : 'Live Queries'}</Link>
        <Icon name="chevron-right" size={12} />
        <span className="font-semibold text-fg">Session Details</span>
      </nav>

      {/* header */}
      <div className="flex flex-wrap items-center gap-4">
        <span className="grid h-12 w-12 place-items-center rounded-xl bg-accent-soft text-accent-text"><Icon name="activity" size={22} /></span>
        <div className="min-w-0">
          <h1 className="flex flex-wrap items-center gap-3 text-[24px] font-bold text-fg">
            SID {sid}, SERIAL# {serial}
            {statusLabel && (
              <span className={cn('rounded-full px-3 py-0.5 text-[12px] font-semibold', ended ? 'bg-sunken text-muted' : /active/i.test(statusLabel) && !/inactive/i.test(statusLabel) ? 'bg-success-soft text-success-fg' : 'bg-warning-soft text-warning-fg')}>{statusLabel}</span>
            )}
          </h1>
          <p className="text-[12.5px] text-muted">
            {[`Instance ${inst}`, s?.username && `User: ${s.username}`, s?.program && `Program: ${s.program}`, s?.machine && `Machine: ${s.machine}`, s?.service_name && `Service: ${s.service_name}`].filter(Boolean).join('  ·  ') || (act?.last_stored ? `User: ${act.last_stored.username || NA} · Program: ${act.last_stored.program || NA}` : '')}
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-3">
          <div className="rounded-xl border border-border bg-surface px-4 py-2 shadow-sm"><p className="text-[11px] text-muted">Started At</p><p className="text-[13.5px] font-semibold text-fg">{when(s?.logon_time)}</p></div>
          <div className="rounded-xl border border-border bg-surface px-4 py-2 shadow-sm"><p className="text-[11px] text-muted">Duration</p><p className="text-[13.5px] font-semibold text-fg">{ended ? 'Ended' : secs(duration)}</p></div>
          <button type="button" onClick={() => setTab('timeline')} className="flex h-11 items-center gap-2 rounded-lg border border-accent px-4 text-[13.5px] font-semibold text-accent-text hover:bg-accent-softer"><Icon name="history" size={16} />View History</button>
          <button type="button" onClick={refresh} className="flex h-11 items-center gap-2 rounded-lg bg-accent px-5 text-[14px] font-semibold text-accent-fg hover:brightness-110"><Icon name="refresh" size={16} className={detail.isFetching ? 'animate-spin' : ''} />Refresh</button>
        </div>
      </div>

      {detail.isLoading && <InlineLoading label="Reading the session…" />}
      {detail.error && <Notice tone="danger" title="The session could not be read.">{String(detail.error.message || detail.error)}</Notice>}
      {detail.data?.status === 'error' && <Notice tone="danger" title="The session could not be read.">{detail.data.error}</Notice>}
      {ended && (
        <Notice tone="warning" title="This session has ended.">
          {snap?.detail
            ? <>Showing the last available snapshot, taken {when(snap.at)}. Values are that moment&rsquo;s, not live.</>
            : act?.last_stored
              ? <>No snapshot from this page. The last stored record is from {when(`${act.last_stored.t}Z`)} (user {act.last_stored.username || NA}, SQL {act.last_stored.sql_id || NA}).</>
              : <>ACTMON holds no snapshot of this session, so its details are not available.</>}
        </Notice>
      )}

      {/* tabs */}
      <div className="flex flex-wrap gap-1 border-b border-border">
        {TABS.map(([k, l]) => (
          <button key={k} type="button" onClick={() => setTab(k)}
            className={cn('-mb-px border-b-2 px-4 py-2.5 text-[14px] font-semibold', tab === k ? 'border-accent text-accent-text' : 'border-transparent text-fg hover:text-accent-text')}>{l}</button>
        ))}
      </div>

      {(tab === 'overview' || tab === 'performance') && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
          <Metric icon="cpu" label="CPU Used" value={stat('CPU used by this session') == null ? NA : secs(stat('CPU used by this session') / 100)}
            sub={act?.timeline?.length ? `latest stored ${act.timeline.at(-1).cpu_pct ?? NA}% of a core` : 'since logon'} spark={<Spark points={act?.timeline} k="cpu_pct" />} />
          <Metric icon="memory" tone="purple" label="Memory (PGA)" value={stat('session pga memory') == null ? NA : fmtMB(stat('session pga memory') / 1048576)} sub={stat('session pga memory max') == null ? undefined : `max ${fmtMB(stat('session pga memory max') / 1048576)}`} />
          <Metric icon="layers" tone="purple" label="Logical Reads" value={num(stat('session logical reads'))} sub="blocks, since logon" />
          <Metric icon="database" tone="red" label="Physical Reads" value={num(stat('physical reads'))} sub="blocks, since logon" />
          <Metric icon="database" label="I/O Requests" value={num(ioReq)} sub="read + write, since logon" />
          <Metric icon="clock" tone="amber" label="Wait Time" value={act?.waits ? secs(waitTotal) : NA} sub="non-idle, since logon" />
        </div>
      )}

      {tab === 'overview' && (
        <>
          <div className="grid gap-4 xl:grid-cols-[1.1fr_1.1fr_1fr]">
            {planCard(false)}
            <Card icon="list" title="Plan Table">{(plan.data || []).length ? <PlanTable rows={plan.data} stats={planStats.data} selected={planSel} onSelect={setPlanSel} /> : <p className="text-[12.5px] text-muted">No plan rows.</p>}</Card>
            <div className="space-y-4">
              <Card icon="clock" title="Wait Events" right={<button type="button" onClick={() => setTab('waits')} className="rounded-md border border-accent/40 px-2.5 py-1 text-[12px] font-semibold text-accent-text">View All</button>}>
                <WaitTable waits={act?.waits ? act.waits.slice(0, 5) : act?.waits} onPick={(w) => { setPicked(w); setTab('waits'); }} />
              </Card>
              <Card icon="report" title="Top SQL from Same User" right={<button type="button" onClick={() => setTab('related')} className="rounded-md border border-accent/40 px-2.5 py-1 text-[12px] font-semibold text-accent-text">View All</button>}>
                <RelatedTable rows={related.slice(0, 5)} loading={topSql.isLoading} onOpen={openSql} />
              </Card>
            </div>
          </div>
          <div className="grid gap-4 xl:grid-cols-[1.2fr_1fr_1fr]">
            <Card icon="code-xml" title="Session SQL" subtitle={ended ? 'Last captured statement — not running now' : s?.sql_id ? 'Running statement' : 'Previous statement'}>
              <SqlBox text={shown?.current_sql?.text || shown?.previous_sql?.text} sqlId={sqlId} />
            </Card>
            <ExecDetails sum={sum} child0={child0} sqlId={sqlId} error={sqlDetail.data?.status !== 'success' ? sqlDetail.data?.error : null} loading={sqlDetail.isLoading} />
            <Card icon="history" title="Session Timeline" subtitle="Stored CPU samples (ClickHouse)">
              <TimelineBody act={act} />
            </Card>
          </div>
        </>
      )}

      {tab === 'plan' && planCard(true)}

      {tab === 'sql' && (
        <div className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
          <div className="space-y-4">
            <Card icon="code-xml" title="Current SQL" subtitle={ended ? 'Last captured — not running now' : undefined}><SqlBox text={shown?.current_sql?.text} sqlId={shown?.current_sql?.sql_id} label="current SQL" /></Card>
            <Card icon="code-xml" title="Previous SQL"><SqlBox text={shown?.previous_sql?.text} sqlId={shown?.previous_sql?.sql_id} label="previous SQL" /></Card>
          </div>
          <ExecDetails sum={sum} child0={child0} sqlId={sqlId} error={sqlDetail.data?.status !== 'success' ? sqlDetail.data?.error : null} loading={sqlDetail.isLoading} />
        </div>
      )}

      {tab === 'waits' && (
        <div className="grid gap-4 xl:grid-cols-[1.5fr_1fr]">
          <Card icon="clock" title="Wait Events" subtitle="GV$SESSION_EVENT — cumulative since logon, idle waits excluded"><WaitTable waits={act?.waits} onPick={setPicked} picked={picked?.event} /></Card>
          <Card icon="info" title={picked ? picked.event : 'About an event'}>
            {!picked ? <p className="text-[12.5px] text-muted">Click an event name to see what it means.</p> : (
              <div className="space-y-2 text-[13px]">
                <p className="font-semibold text-fg">{pickedInfo.label}</p>
                {pickedInfo.id === 'unknown' && <p className="text-muted">This event is not one ACTMON has an explanation for; it is shown exactly as Oracle reports it.</p>}
                {pickedInfo.why && <p className="text-fg">{pickedInfo.why}</p>}
                {pickedInfo.action && <p className="text-muted">{pickedInfo.action}</p>}
                <p className="text-[12px] text-subtle">Class {picked.wait_class || NA} · {num(picked.total_waits)} waits · {secs(picked.time_waited_s)} total</p>
              </div>
            )}
          </Card>
        </div>
      )}

      {tab === 'blocking' && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card icon="lock" title="Blocked by" subtitle="The session this one is waiting on">
            <SessionList rows={act?.blocker} empty="This session is not waiting on another session." id={id} backTo={backTo} />
          </Card>
          <Card icon="ban" title="Blocking" subtitle="Sessions waiting on this one">
            <SessionList rows={act?.blocked} empty="No session is waiting on this one." id={id} backTo={backTo} />
          </Card>
        </div>
      )}

      {(tab === 'timeline' || tab === 'performance') && (
        <Card icon="history" title="Session Timeline" subtitle="CPU per collection cycle, stored only while this session was among the top 5 on its instance">
          <TimelineBody act={act} big />
        </Card>
      )}

      {tab === 'related' && (
        <Card icon="report" title="Related SQL" subtitle={`Top statements of schema ${(child0?.parsing_schema || s?.username || '').toUpperCase() || NA} in the cursor cache`}>
          <RelatedTable rows={related} loading={topSql.isLoading} onOpen={openSql} />
        </Card>
      )}

      {(activity.data?.errors || []).length > 0 && <p className="text-[11px] text-subtle">Partial read: {activity.data.errors.join(' · ')}</p>}
    </div>
  );
}

function PlanExtras({ rows, stats }) {
  const [t, setT] = useState('pred');
  return (
    <div className="rounded-xl border border-border p-3">
      <div className="mb-2 flex gap-4 text-[12.5px]">
        {[['pred', 'Predicate Information'], ['other', 'Other Information'], ['stats', 'Plan Statistics']].map(([k, l]) => (
          <button key={k} type="button" onClick={() => setT(k)} className={cn('font-semibold', t === k ? 'text-accent-text underline underline-offset-4' : 'text-muted')}>{l}</button>
        ))}
      </div>
      {t === 'pred' && (rows.some((r) => r.access_predicates || r.filter_predicates) ? rows.filter((r) => r.access_predicates || r.filter_predicates).map((r) => (
        <p key={r.id} className="font-mono text-[12px]"><b>{r.id}</b> {r.access_predicates && <>access {r.access_predicates} </>}{r.filter_predicates && <>filter {r.filter_predicates}</>}</p>
      )) : <p className="text-[12px] text-muted">No predicates in this plan.</p>)}
      {t === 'other' && rows.map((r) => <p key={r.id} className="text-[12px]">{r.id} · {r.object_type || '—'} · bytes {r.bytes == null ? '—' : fmtNumber(r.bytes)} · CPU cost {r.cpu_cost == null ? '—' : fmtNumber(r.cpu_cost)} · I/O cost {r.io_cost ?? '—'}</p>)}
      {t === 'stats' && (stats?.collected
        ? stats.steps.map((st) => <p key={st.id} className="text-[12px]">{st.id} · starts {num(st.starts)} · rows {num(st.actual_rows)} · {st.elapsed_ms == null ? NA : `${st.elapsed_ms.toFixed(2)} ms`} · gets {num(st.buffer_gets)}</p>)
        : <p className="text-[12px] text-muted">{stats?.note || 'Plan statistics were not read.'}</p>)}
    </div>
  );
}

function ExecDetails({ sum, child0, sqlId, error, loading }) {
  return (
    <Card icon="info" title="Execution Details" subtitle="V$SQL — cumulative since the cursor was loaded">
      {!sqlId ? <p className="text-[12.5px] text-muted">No SQL for this session.</p> : loading ? <InlineLoading label="Reading V$SQL…" /> : error ? <p className="text-[12.5px] text-muted">{error}</p> : (
        <dl className="grid grid-cols-2 gap-x-5 text-[12.5px]">
          {[['SQL ID', <span key="s" className="font-mono text-accent-text">{sqlId}</span>], ['Last active', when(child0?.last_active_time)],
            ['Plan Hash', sum?.plan_hash_values?.join(', ') || NA], ['Elapsed Time', sum ? secs(sum.elapsed_s) : NA],
            ['Child Number', child0?.child_number ?? NA], ['CPU Time', sum ? secs(sum.cpu_s) : NA],
            ['Parsing Schema', child0?.parsing_schema || NA], ['Buffer Gets', num(sum?.buffer_gets)],
            ['Optimizer Mode', child0?.optimizer_mode || NA], ['Disk Reads', num(sum?.disk_reads)],
            ['Executions', num(sum?.executions)], ['Rows Processed', num(sum?.rows_processed)]].map(([k, v]) => (
            <div key={k} className="flex justify-between gap-3 border-b border-border py-1.5"><dt className="text-muted">{k}</dt><dd className="text-right font-medium text-fg">{v}</dd></div>
          ))}
        </dl>
      )}
    </Card>
  );
}

function RelatedTable({ rows, loading, onOpen }) {
  if (loading) return <InlineLoading label="Reading V$SQL…" />;
  if (!rows.length) return <p className="text-[12.5px] text-muted">No related statements in the cursor cache.</p>;
  return (
    <table className="w-full text-[12.5px]">
      <thead className="text-left text-[12px] text-muted"><tr>{['SQL ID', 'Executions', 'Avg Time', 'DB Time', 'Plan Hash', 'Last Active'].map((h) => <th key={h} className="pb-1.5 pr-2">{h}</th>)}</tr></thead>
      <tbody>{rows.map((r) => (
        <tr key={`${r.sql_id}-${r.child_number}`} onClick={() => onOpen(r)} className="cursor-pointer border-t border-border hover:bg-sunken/60">
          <td className="py-1.5 pr-2 font-mono text-accent-text hover:underline">{r.sql_id}</td><td className="pr-2">{num(r.executions)}</td>
          <td className="pr-2">{r.avg_elapsed_ms == null ? NA : secs(r.avg_elapsed_ms / 1000)}</td><td className="pr-2">{r.elapsed_ms == null ? NA : secs(r.elapsed_ms / 1000)}</td>
          <td className="pr-2 font-mono">{r.plan_hash_value}</td><td>{r.last_active_time || NA}</td>
        </tr>
      ))}</tbody>
    </table>
  );
}

function SessionList({ rows, empty, id, backTo }) {
  if (rows == null) return <p className="text-[12.5px] text-muted">Could not be read.</p>;
  if (!rows.length) return <p className="text-[12.5px] text-muted">{empty}</p>;
  return (
    <table className="w-full text-[12.5px]">
      <thead className="text-left text-[12px] text-muted"><tr>{['SID', 'Serial#', 'User', 'Event', 'Waiting', 'Status'].map((h) => <th key={h} className="pb-1.5 pr-2">{h}</th>)}</tr></thead>
      <tbody>{rows.map((r) => (
        <tr key={`${r.inst_id}-${r.sid}`} className="border-t border-border">
          <td className="py-1.5 pr-2"><Link className="font-semibold text-accent-text hover:underline" to={`/oracle-dashboard/${id}/live-queries/session?inst=${r.inst_id}&sid=${r.sid}&serial=${r.serial}`} state={{ backTo }}>{r.sid}</Link></td>
          <td className="pr-2">{r.serial}</td><td className="pr-2">{r.username || NA}</td><td className="pr-2">{r.event || NA}</td>
          <td className="pr-2">{secs(r.seconds_in_wait)}</td><td>{r.status || NA}</td>
        </tr>
      ))}</tbody>
    </table>
  );
}

function TimelineBody({ act, big }) {
  if (!act) return <InlineLoading label="Reading stored samples…" />;
  if (act.timeline == null) return <p className="text-[12.5px] text-muted">The history store (ClickHouse) could not be reached.</p>;
  if (!act.timeline.length) return <p className="text-[12.5px] text-muted">No stored samples for this session. ACTMON stores a session only for collection cycles in which it was among the top 5 by CPU on its instance.</p>;
  return big ? <TimelineChart points={act.timeline} /> : (
    <div>
      <Spark points={act.timeline} k="cpu_pct" />
      <p className="mt-2 text-[12px] text-muted">{act.timeline.length} stored samples · latest {act.timeline.at(-1).cpu_pct ?? NA}% CPU</p>
    </div>
  );
}
