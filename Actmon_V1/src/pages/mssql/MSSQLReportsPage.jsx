import React, { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Heart, Cpu, MemoryStick, Database, Clock, AlertTriangle, Users, Zap, Server,
} from 'lucide-react';
import client from '../../api/client';
import {
  ReportShell, RSection, KStat, RTable, UsageBar, HealthChecks,
  statusBadge, fmtNum, now, C,
} from '../_shared/reportKit';

const ENGINE = {
  key: 'mssql',
  label: 'SQL Server',
  emoji: '🗄️',
  reportPrefix: 'mssql-report',
  headerGradient: 'linear-gradient(135deg,#0f172a 0%,#1e3a5f 55%,#0c2340 100%)',
  gradient: 'linear-gradient(135deg,#1e3a5f,#2563eb)',
};

const api = (path, id) => client.get(`/connections/mssql/${id}/${path}`).then(r => r.data);

export default function MSSQLReportsPage() {
  const { id } = useParams();
  const [period, setPeriod] = useState('live');
  const [genTime, setGenTime] = useState(now);
  const ri = period === 'live' ? 30000 : false;

  const { data: dash, isLoading, refetch } = useQuery({ queryKey: ['rpt-mssql-dash', id], queryFn: () => api('monitoring-dashboard', id), refetchInterval: ri, retry: false });
  const { data: slowD } = useQuery({ queryKey: ['rpt-mssql-slow', id], queryFn: () => api('mssql-slow-queries', id), refetchInterval: period === 'live' ? 15000 : false, retry: false });

  const hs = dash?.health_summary || {};
  const conn = dash?.connection || {};
  const cpu = dash?.cpu || {};
  const mem = dash?.memory || {};
  const databases = dash?.databases || [];
  const waits = dash?.wait_stats || [];
  const blocking = dash?.blocking || [];
  const sessions = dash?.sessions || dash?.active_queries || [];
  const slowQ = slowD?.queries || [];

  const connName = conn.name || hs.host_name || `SQL Server #${id}`;
  const subtitle = `${conn.host || hs.host_name || ''}${hs.version ? ` · ${String(hs.version).split(' ')[0]}` : ''}`;

  // computed scalars
  const activeCon = Number(hs.active_sessions) || 0;
  const maxCon = Number(hs.max_connections) || 0;
  const conPct = maxCon > 0 ? Math.min(100, Math.round(activeCon / maxCon * 100)) : 0;
  const cacheHit = Number(hs.buffer_cache_hit_pct) || 0;
  const hostCpu = Math.round(Number(cpu.host_cpu_pct ?? hs.host_cpu_pct) || 0);
  const sqlCpu = Math.round(Number(cpu.sql_server_cpu_pct) || 0);
  const otherCpu = Math.max(0, hostCpu - sqlCpu);
  const idleCpu = Math.max(0, 100 - hostCpu);
  const memPct = Math.round(Number(hs.memory_usage_pct ?? mem.host_used_pct) || 0);
  const dbSize = hs.total_size_gb > 0.1 ? `${hs.total_size_gb} GB` : `${hs.total_size_mb || 0} MB`;
  const uptime = hs.uptime || '—';

  function computeScore() {
    let s = 100;
    if (conPct > 90) s -= 30; else if (conPct > 70) s -= 15;
    if (cacheHit && cacheHit < 90) s -= 20; else if (cacheHit && cacheHit < 95) s -= 8;
    if (blocking.length > 0) s -= 15;
    if (hostCpu > 90) s -= 15; else if (hostCpu > 75) s -= 8;
    if (memPct > 90) s -= 10;
    return Math.max(0, Math.min(100, s));
  }
  const healthScore = computeScore();

  const alertBadges = [
    conPct > 80 && { tone: 'red', label: `Connections ${conPct}%` },
    cacheHit > 0 && cacheHit < 90 && { tone: 'amber', label: `Cache Hit ${cacheHit.toFixed(1)}%` },
    hostCpu > 85 && { tone: 'red', label: `CPU ${hostCpu}%` },
    blocking.length > 0 && { tone: 'red', label: `${blocking.length} Blocking` },
  ];

  if (isLoading && !dash) return (
    <div className="min-h-screen flex items-center justify-center bg-[#f1f5f9]">
      <div className="text-center">
        <div className="w-12 h-12 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin mx-auto mb-4" />
        <p className="text-slate-600 font-semibold">Loading SQL Server report…</p>
      </div>
    </div>
  );

  return (
    <ReportShell
      engine={{ ...ENGINE, backTo: `/mssql-dashboard/${id}` }}
      id={id} period={period} setPeriod={setPeriod}
      genTime={genTime} setGenTime={setGenTime} onRefresh={refetch}
      connName={connName} subtitle={subtitle} alertBadges={alertBadges}
    >
      {/* ══ 1. EXECUTIVE SUMMARY ══ */}
      <RSection title="Executive Summary" icon={Heart}
        color={healthScore >= 80 ? C.green : healthScore >= 60 ? C.amber : C.red}>
        <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-8 gap-3 mb-5">
          <KStat label="Health Score" value={`${healthScore}/100`} color={healthScore >= 80 ? C.green : healthScore >= 60 ? C.amber : C.red} />
          <KStat label="Edition" value={hs.edition || '—'} color={C.blue} />
          <KStat label="Uptime" value={uptime} />
          <KStat label="Connections" value={`${activeCon}/${maxCon || '—'}`} color={conPct > 80 ? C.red : C.green} sub={`${conPct}% used`} />
          <KStat label="Buffer Cache Hit" value={cacheHit ? `${cacheHit.toFixed(1)}%` : '—'} color={cacheHit && cacheHit < 90 ? C.red : C.green} />
          <KStat label="Total DB Size" value={dbSize} color={C.blue} />
          <KStat label="Host CPU" value={`${hostCpu}%`} color={hostCpu > 85 ? C.red : C.green} />
          <KStat label="Memory Used" value={`${memPct}%`} color={memPct > 90 ? C.red : C.green} />
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-8 gap-3 mb-5">
          <KStat label="Databases" value={fmtNum(hs.total_databases ?? databases.length)} color={C.blue} />
          <KStat label="Active Sessions" value={fmtNum(activeCon)} />
          <KStat label="SQL Server CPU" value={`${sqlCpu}%`} color={C.indigo} />
          <KStat label="Slow Queries" value={slowQ.length} color={slowQ.length > 10 ? C.orange : C.green} />
          <KStat label="Blocking Chains" value={blocking.length} color={blocking.length > 0 ? C.red : C.green} />
          <KStat label="Wait Types" value={waits.length} color={C.slate} />
          <KStat label="Page Life Exp." value={fmtNum(mem.page_life_expectancy)} sub="seconds" />
          <KStat label="SQL Mem" value={`${fmtNum(mem.used_mb)} MB`} color={C.teal} />
        </div>
        <HealthChecks checks={[
          { ok: true, label: `Status: ONLINE` },
          { ok: conPct < 80, label: `Connections ${conPct}%` },
          { ok: !cacheHit || cacheHit >= 90, label: `Cache Hit ${cacheHit ? cacheHit.toFixed(1) : '—'}%` },
          { ok: hostCpu < 85, label: `Host CPU ${hostCpu}%` },
          { ok: memPct < 90, label: `Memory ${memPct}%` },
          { ok: blocking.length === 0, label: `Blocking: ${blocking.length}` },
          { ok: slowQ.length <= 10, label: `Slow Queries: ${slowQ.length}` },
        ]} />
      </RSection>

      {/* ══ 2. CPU & MEMORY ══ */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <RSection title="CPU Breakdown" icon={Cpu} color={C.blue}>
          <UsageBar label="SQL Server CPU" pct={sqlCpu} color={C.blue} />
          <UsageBar label="Other processes" pct={otherCpu} color={C.orange} />
          <UsageBar label="Idle" pct={idleCpu} color={C.slate} />
          <p className="text-[11px] text-slate-400 mt-2">Host CPU in use: <b className="text-slate-700">{hostCpu}%</b> (SQL {sqlCpu}% + other {otherCpu}% + idle {idleCpu}%).</p>
        </RSection>
        <RSection title="Memory" icon={MemoryStick} color={C.blue}>
          <UsageBar label="Host RAM used" pct={memPct} color={memPct > 85 ? C.red : C.green} />
          <div className="grid grid-cols-2 gap-3 mt-2">
            <KStat label="Used" value={`${fmtNum(mem.host_used_mb ?? mem.used_mb)} MB`} />
            <KStat label="Total" value={`${fmtNum(mem.host_total_mb ?? mem.total_mb)} MB`} />
            <KStat label="SQL Server Mem" value={`${fmtNum(mem.used_mb)} MB`} color={C.teal} />
            <KStat label="Page Life Expectancy" value={fmtNum(mem.page_life_expectancy)} sub="seconds" />
          </div>
        </RSection>
      </div>

      {/* ══ 3. DATABASES ══ */}
      <RSection title={`Databases (${databases.length})`} icon={Database} color={C.indigo}>
        <RTable headers={['Database', 'State', 'Recovery Model', 'Size (MB)']}
          rows={databases.slice(0, 25).map(d => [
            <span className="font-bold text-slate-800">{d.name}</span>,
            statusBadge(d.state_desc || d.state),
            d.recovery_model_desc || '—',
            fmtNum(d.size_mb ?? d.data_size_mb),
          ])} emptyMsg="No database data" />
      </RSection>

      {/* ══ 4. WAITS + BLOCKING ══ */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <RSection title="Top Wait Types" icon={Clock} color={C.purple}>
          <RTable headers={['Wait Type', 'Wait (ms)', '%']}
            rows={waits.slice(0, 12).map(w => [
              <span className="font-mono text-[11px]">{w.wait_type}</span>,
              fmtNum(w.wait_time_ms), w.pct != null ? `${w.pct}%` : '—',
            ])} emptyMsg="No wait statistics" />
        </RSection>
        <RSection title={`Blocking Chains (${blocking.length})`} icon={AlertTriangle} color={blocking.length ? C.red : C.green}>
          {blocking.length === 0
            ? <p className="text-sm text-emerald-600 font-semibold flex items-center gap-2"><Server size={15} /> No blocking detected</p>
            : <RTable headers={['Blocker', 'Blocked', 'Wait (ms)', 'Login']}
                rows={blocking.slice(0, 12).map(b => [b.blocking_spid || b.blocker_id, b.blocked_spid || '—', fmtNum(b.wait_time_ms), b.login_name || '—'])} />}
        </RSection>
      </div>

      {/* ══ 5. SESSIONS ══ */}
      {sessions.length > 0 && (
        <RSection title={`Active Sessions (${sessions.length})`} icon={Users} color={C.teal}>
          <RTable headers={['SPID', 'Login', 'Database', 'Status', 'CPU (ms)', 'Reads']}
            rows={sessions.slice(0, 15).map(s => [
              s.session_id || s.spid, s.login_name || '—', s.db_name || s.database_name || '—',
              statusBadge(s.status), fmtNum(s.cpu_time), fmtNum(s.logical_reads),
            ])} emptyMsg="No active sessions" />
        </RSection>
      )}

      {/* ══ 6. TOP SLOW QUERIES ══ */}
      <RSection title="Top Slow Queries" icon={Zap} color={C.orange} pageBreak>
        <RTable headers={['Query (truncated)', 'Avg ms', 'Executions', 'Total CPU (ms)', 'Database']}
          rows={slowQ.slice(0, 15).map(q => [
            <span className="font-mono text-[11px] block max-w-[420px] truncate">{String(q.sql_text || '').replace(/\s+/g, ' ').slice(0, 120)}</span>,
            fmtNum(q.avg_elapsed_ms), fmtNum(q.execution_count), fmtNum(q.total_cpu_ms), q.db_name || '—',
          ])} emptyMsg="No slow query data" />
      </RSection>
    </ReportShell>
  );
}
