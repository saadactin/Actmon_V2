import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Activity, AlertTriangle, Archive, Clock, Cpu, Database, HardDrive, Layers, MemoryStick,
  Server, Users, Zap,
} from 'lucide-react';
import client from '@/api/client';
import { PageLoading } from '@/components/ui/Loading';
import {
  C, HealthChecks, KStat, RSection, RTable, ReportShell, UsageBar, fmtNum, now, shortVersion,
  statusBadge,
} from '@/pages/_shared/reportKit';

/**
 * SQL Server monitoring report.
 *
 * Same shell as every other engine's report, so the header, the period control,
 * the e-mail scheduler and the print layout are identical — only the sections
 * differ. Sections are bound to what `/monitoring-dashboard` returns: `blocking`
 * and `disk_io` are arrays of rows, not objects of counters, and `sessions` is a
 * summary rather than a list, which is why the sessions table reads
 * `active_queries`.
 */

const ENGINE = {
  key: 'mssql',
  label: 'SQL Server',
  emoji: '🗄️',
  reportPrefix: 'mssql-report',
};

const api = (path, id) => client.get(`/connections/mssql/${id}/${path}`).then((r) => r.data);

const num = (v) => Number(v) || 0;
const clean = (list) => (Array.isArray(list) ? list.filter((r) => r && !r.error) : []);

export default function MSSQLReportsPage() {
  const { id } = useParams();
  const [period, setPeriod] = useState('live');
  const [genTime, setGenTime] = useState(now);
  const live = period === 'live';

  const { data: dash, isLoading, refetch } = useQuery({
    queryKey: ['rpt-mssql-dash', id, period],
    queryFn: () => api('monitoring-dashboard', id),
    refetchInterval: live ? 30000 : false,
    retry: false,
  });
  const { data: slowD } = useQuery({
    queryKey: ['rpt-mssql-slow', id, period],
    queryFn: () => api('mssql-slow-queries', id),
    refetchInterval: live ? 15000 : false,
    retry: false,
  });
  const { data: idxD } = useQuery({
    queryKey: ['rpt-mssql-idx', id, period],
    queryFn: () => api('mssql-index-analysis', id),
    refetchInterval: false,
    retry: false,
  });

  const hs = dash?.health_summary || {};
  const conn = dash?.connection || {};
  const cpu = dash?.cpu || {};
  const mem = dash?.memory || {};
  const serverInfo = dash?.server_info || {};
  const databases = clean(dash?.databases);
  const waits = clean(dash?.wait_stats);
  const sessions = clean(dash?.active_queries);
  const ioFiles = clean(dash?.disk_io);
  const tables = clean(dash?.tables);
  const blocking = Array.isArray(dash?.blocking) ? dash.blocking : [];
  const backups = Array.isArray(dash?.backup_history) ? dash.backup_history : [];
  const logins = Array.isArray(dash?.users) ? dash.users : [];
  const alwaysOn = dash?.always_on || {};
  const replication = dash?.replication || {};
  const slowQ = slowD?.queries || [];
  const idxSummary = idxD?.summary || {};

  const connName = conn.name || hs.host_name || `SQL Server #${id}`;
  const subtitle = [
    conn.host ? `${conn.host}${conn.port ? `:${conn.port}` : ''}` : null,
    shortVersion(hs.version),
    hs.edition || null,
  ].filter(Boolean).join(' · ');

  const activeCon = num(hs.active_sessions);
  const maxCon = num(hs.max_connections);
  const conPct = maxCon > 0 ? Math.min(100, Math.round((activeCon / maxCon) * 100)) : 0;
  const cacheHit = num(hs.buffer_cache_hit_pct);
  const hostCpu = Math.round(num(cpu.host_cpu_pct ?? hs.host_cpu_pct));
  const sqlCpu = Math.round(num(cpu.sql_server_cpu_pct));
  const otherCpu = Math.max(0, hostCpu - sqlCpu);
  const idleCpu = Math.max(0, 100 - hostCpu);
  const memPct = Math.round(num(hs.memory_usage_pct ?? mem.host_used_pct));
  const dataMb = databases.reduce((a, d) => a + num(d.size_mb), 0);
  const logMb = databases.reduce((a, d) => a + num(d.log_size_mb), 0);
  const simpleRecovery = databases.filter((d) => d.recovery_model_desc === 'SIMPLE');
  const offlineDbs = databases.filter((d) => d.state_desc && d.state_desc !== 'ONLINE');

  const healthScore = (() => {
    let s = 100;
    if (conPct > 90) s -= 30; else if (conPct > 70) s -= 15;
    if (cacheHit && cacheHit < 90) s -= 20; else if (cacheHit && cacheHit < 95) s -= 8;
    if (blocking.length > 0) s -= 15;
    if (hostCpu > 90) s -= 15; else if (hostCpu > 75) s -= 8;
    if (memPct > 90) s -= 10;
    return Math.max(0, Math.min(100, s));
  })();

  const alertBadges = [
    conPct > 80 && { tone: 'red', label: `Connections ${conPct}%` },
    cacheHit > 0 && cacheHit < 90 && { tone: 'amber', label: `Cache hit ${cacheHit.toFixed(1)}%` },
    hostCpu > 85 && { tone: 'red', label: `CPU ${hostCpu}%` },
    blocking.length > 0 && { tone: 'red', label: `${blocking.length} blocking` },
    offlineDbs.length > 0 && { tone: 'red', label: `${offlineDbs.length} not ONLINE` },
  ];

  if (isLoading && !dash) return <PageLoading title="Loading SQL Server report…" />;

  return (
    <ReportShell
      engine={{ ...ENGINE, backTo: `/mssql-dashboard/${id}` }}
      id={id}
      period={period}
      setPeriod={setPeriod}
      genTime={genTime}
      setGenTime={setGenTime}
      onRefresh={refetch}
      connName={connName}
      subtitle={subtitle}
      alertBadges={alertBadges}
    >
      {/* ══ 1 · EXECUTIVE SUMMARY ══ */}
      <RSection title="Executive Summary" icon={Activity}
        color={healthScore >= 80 ? C.green : healthScore >= 60 ? C.amber : C.red}>
        <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8">
          <KStat label="Health Score" value={`${healthScore}/100`}
            color={healthScore >= 80 ? C.green : healthScore >= 60 ? C.amber : C.red} />
          <KStat label="Edition" value={hs.edition || '—'} color={C.blue} />
          <KStat label="Uptime" value={hs.uptime || '—'} sub={hs.last_restart !== 'N/A' ? hs.last_restart : undefined} />
          <KStat label="Connections" value={`${activeCon}/${maxCon || '—'}`}
            color={conPct > 80 ? C.red : C.green} sub={`${conPct}% of ceiling`} />
          <KStat label="Buffer Cache Hit" value={cacheHit ? `${cacheHit.toFixed(1)}%` : '—'}
            color={cacheHit && cacheHit < 90 ? C.red : C.green} />
          <KStat label="Disk Footprint"
            value={hs.total_size_gb > 0.1 ? `${hs.total_size_gb} GB` : `${hs.total_size_mb || 0} MB`}
            color={C.blue} sub="data + log" />
          <KStat label="Host CPU" value={`${hostCpu}%`} color={hostCpu > 85 ? C.red : C.green} />
          <KStat label="Host Memory" value={`${memPct}%`} color={memPct > 90 ? C.red : C.green} />
        </div>
        <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8">
          <KStat label="Databases" value={fmtNum(hs.total_databases ?? databases.length)} color={C.blue} />
          <KStat label="Active Sessions" value={fmtNum(activeCon)} />
          <KStat label="SQL Server CPU" value={`${sqlCpu}%`} color={C.indigo} />
          <KStat label="Slow Queries" value={slowQ.length} color={slowQ.length > 10 ? C.orange : C.green} />
          <KStat label="Blocking Chains" value={blocking.length} color={blocking.length > 0 ? C.red : C.green} />
          <KStat label="Wait Types" value={waits.length} color={C.slate} />
          <KStat label="Page Life Exp." value={fmtNum(mem.page_life_expectancy)} sub="seconds" />
          <KStat label="Server Logins" value={logins.length} color={C.teal} />
        </div>
        <HealthChecks checks={[
          { ok: offlineDbs.length === 0, label: `Databases ONLINE: ${databases.length - offlineDbs.length}/${databases.length}` },
          { ok: conPct < 80, label: `Connections ${conPct}%` },
          { ok: !cacheHit || cacheHit >= 90, label: `Cache hit ${cacheHit ? cacheHit.toFixed(1) : '—'}%` },
          { ok: hostCpu < 85, label: `Host CPU ${hostCpu}%` },
          { ok: memPct < 90, label: `Host memory ${memPct}%` },
          { ok: blocking.length === 0, label: `Blocking: ${blocking.length}` },
          { ok: slowQ.length <= 10, label: `Slow queries: ${slowQ.length}` },
          { ok: backups.length > 0, label: `Backups in last 7 days: ${backups.length}` },
        ]} />
      </RSection>

      {/* ══ 2 · SERVER ══ */}
      <RSection title="Server" icon={Server} color={C.blue}>
        <RTable
          headers={['Property', 'Value']}
          rows={[
            ['Instance', serverInfo.server_name || conn.host || '—'],
            ['Product version', serverInfo.product_version || hs.version || '—'],
            ['Edition', serverInfo.edition || hs.edition || '—'],
            ['Uptime', hs.uptime || '—'],
            ['Last restart', hs.last_restart || '—'],
            ['Max connections', hs.max_connections_unlimited
              ? `${fmtNum(hs.max_connections)} (no configured limit)`
              : fmtNum(hs.max_connections)],
            ['Replication state', replication.state || 'STANDALONE'],
            ['AlwaysOn', alwaysOn.enabled
              ? (alwaysOn.groups || []).map((g) => `${g.ag_name} (${g.role_desc}, ${g.synchronization_health_desc})`).join('; ')
              : 'Not configured'],
          ].map(([k, v]) => [<span className="font-semibold text-slate-700">{k}</span>, v])}
        />
      </RSection>

      {/* ══ 3 · CPU & MEMORY ══ */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <RSection title="CPU Breakdown" icon={Cpu} color={C.blue}>
          <UsageBar label="SQL Server" pct={sqlCpu} color={C.blue} />
          <UsageBar label="Other processes" pct={otherCpu} color={C.orange} />
          <UsageBar label="Idle" pct={idleCpu} color={C.slate} />
          <p className="mt-2 text-[11px] text-slate-400">
            Host CPU in use: <b className="text-slate-700">{hostCpu}%</b> — SQL Server {sqlCpu}%,
            other processes {otherCpu}%, idle {idleCpu}%. Measured across all cores.
          </p>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <KStat label="Batch Requests/sec" value={fmtNum(cpu.batch_requests_sec)} />
            <KStat label="Compilations/sec" value={fmtNum(cpu.sql_compilations)} />
            <KStat label="Re-compilations/sec" value={fmtNum(cpu.sql_recompilations)}
              color={num(cpu.sql_recompilations) > 100 ? C.orange : undefined} />
            <KStat label="Full Scans/sec" value={fmtNum(cpu.full_scans_sec)} />
          </div>
        </RSection>

        <RSection title="Memory" icon={MemoryStick} color={C.blue}>
          <UsageBar label="Host RAM used" pct={memPct} color={memPct > 85 ? C.red : C.green} />
          <div className="mt-2 grid grid-cols-2 gap-3">
            <KStat label="Host used" value={`${fmtNum(mem.host_used_mb)} MB`} />
            <KStat label="Host total" value={`${fmtNum(mem.host_total_mb)} MB`} />
            <KStat label="SQL Server holds" value={`${fmtNum(mem.total_mb)} MB`} color={C.teal}
              sub="Total Server Memory" />
            <KStat label="SQL Server target" value={`${fmtNum(mem.target_mb)} MB`}
              sub="Target Server Memory" />
            <KStat label="Process in use" value={`${fmtNum(mem.used_mb)} MB`} />
            <KStat label="Page Life Expectancy" value={fmtNum(mem.page_life_expectancy)} sub="seconds"
              color={num(mem.page_life_expectancy) > 0 && num(mem.page_life_expectancy) < 300 ? C.red : undefined} />
          </div>
        </RSection>
      </div>

      {/* ══ 4 · DATABASES ══ */}
      <RSection title={`Databases (${databases.length})`} icon={Database} color={C.indigo}>
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <KStat label="Data files" value={`${fmtNum(Math.round(dataMb))} MB`} color={C.blue} />
          <KStat label="Log files" value={`${fmtNum(Math.round(logMb))} MB`}
            color={logMb > dataMb && dataMb > 0 ? C.orange : undefined}
            sub={dataMb > 0 ? `${Math.round((logMb / dataMb) * 100)}% of data` : undefined} />
          <KStat label="SIMPLE recovery" value={simpleRecovery.length}
            color={simpleRecovery.length ? C.amber : C.green}
            sub="no point-in-time restore" />
          <KStat label="Not ONLINE" value={offlineDbs.length}
            color={offlineDbs.length ? C.red : C.green} />
        </div>
        <RTable
          headers={['Database', 'State', 'Recovery', 'Owner', 'Data (MB)', 'Log (MB)', 'Compat']}
          rows={databases.slice(0, 30).map((d) => [
            <span className="font-bold text-slate-800">{d.name}</span>,
            statusBadge(d.state_desc),
            d.recovery_model_desc || '—',
            <span className="font-mono text-[11px]">{d.owner || '—'}</span>,
            fmtNum(d.size_mb),
            d.log_size_mb != null ? fmtNum(d.log_size_mb) : '—',
            d.compatibility_level || '—',
          ])}
          emptyMsg="No database data"
        />
      </RSection>

      {/* ══ 5 · WAITS + BLOCKING ══ */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <RSection title="Top Wait Types" icon={Clock} color={C.purple}>
          <RTable
            headers={['Wait Type', 'Waiting Tasks', 'Wait (ms)', 'Share']}
            rows={waits.slice(0, 12).map((w) => [
              <span className="font-mono text-[11px]">{w.wait_type}</span>,
              fmtNum(w.waiting_tasks_count),
              fmtNum(w.wait_time_ms),
              w.pct != null ? `${w.pct}%` : '—',
            ])}
            emptyMsg="No wait statistics — the login may lack VIEW SERVER STATE"
          />
        </RSection>

        <RSection title={`Blocking (${blocking.length})`} icon={AlertTriangle}
          color={blocking.length ? C.red : C.green}>
          {blocking.length === 0 ? (
            <p className="flex items-center gap-2 text-sm font-semibold text-emerald-600">
              <Server size={15} /> No request is waiting on a lock held by another session
            </p>
          ) : (
            <RTable
              headers={['Blocked by', 'Waiting session', 'Database', 'Wait type', 'Waiting (ms)']}
              rows={blocking.slice(0, 12).map((b) => [
                <span className="font-mono font-bold text-red-600">{b.blocking_session_id}</span>,
                <span className="font-mono">{b.session_id}</span>,
                b.db_name || '—',
                b.wait_type || '—',
                fmtNum(b.wait_time),
              ])}
            />
          )}
        </RSection>
      </div>

      {/* ══ 6 · SESSIONS ══ */}
      <RSection title={`Active Sessions (${sessions.length})`} icon={Users} color={C.teal}>
        <RTable
          headers={['Session', 'Login', 'Host', 'Database', 'Status', 'Elapsed (ms)', 'Wait type']}
          rows={sessions.slice(0, 20).map((s) => [
            <span className="font-mono">{s.session_id}</span>,
            <span className="font-semibold">{s.login_name || '—'}</span>,
            <span className="font-mono text-[11px]">{s.host_name || '—'}</span>,
            s.database_name || '—',
            statusBadge(s.status),
            fmtNum(s.duration_ms),
            s.wait_type || '—',
          ])}
          emptyMsg="No user sessions connected"
        />
      </RSection>

      {/* ══ 7 · SLOW QUERIES ══ */}
      <RSection title="Top Slow Queries" icon={Zap} color={C.orange} pageBreak>
        <RTable
          headers={['Statement', 'Avg elapsed (ms)', 'Executions', 'Total CPU (ms)', 'Avg logical reads', 'Database']}
          rows={slowQ.slice(0, 15).map((q) => [
            <span className="block max-w-[380px] truncate font-mono text-[11px]">
              {String(q.sql_text || '').replace(/\s+/g, ' ').slice(0, 120)}
            </span>,
            fmtNum(q.avg_elapsed_ms),
            fmtNum(q.execution_count),
            fmtNum(q.total_cpu_ms),
            fmtNum(q.avg_logical_reads),
            q.db_name || '—',
          ])}
          emptyMsg="No cached plans — the plan cache is cleared on restart"
        />
      </RSection>

      {/* ══ 8 · STORAGE & I/O ══ */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <RSection title="Largest Tables" icon={HardDrive} color={C.blue}>
          <RTable
            headers={['Table', 'Rows', 'Data (MB)', 'Index (MB)', 'Total (MB)']}
            rows={tables.slice(0, 15).map((t) => [
              <span className="font-mono text-[11px]">{t.db_name}.{t.schema_name}.{t.table_name}</span>,
              fmtNum(t.row_count),
              fmtNum(t.data_mb),
              fmtNum(t.index_mb),
              <b>{fmtNum(t.total_mb)}</b>,
            ])}
            emptyMsg="No table sizes collected"
          />
        </RSection>

        <RSection title="Slowest Files by I/O Stall" icon={Activity} color={C.purple}>
          <RTable
            headers={['Database', 'File', 'Reads', 'Writes', 'Avg I/O (ms)']}
            rows={ioFiles.slice(0, 12).map((f) => [
              f.db_name || '—',
              <span className="block max-w-[220px] truncate font-mono text-[10px]">{f.physical_name}</span>,
              fmtNum(f.num_of_reads),
              fmtNum(f.num_of_writes),
              <b style={{ color: num(f.avg_io_ms) > 20 ? C.red : undefined }}>
                {f.avg_io_ms != null ? f.avg_io_ms : '—'}
              </b>,
            ])}
            emptyMsg="No file I/O statistics"
          />
        </RSection>
      </div>

      {/* ══ 9 · INDEX HEALTH ══ */}
      <RSection title="Index Health" icon={Layers} color={C.indigo}>
        {idxD?.status === 'success' ? (
          <>
            <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
              <KStat label="Score" value={`${idxSummary.health_score ?? '—'}/100`}
                color={num(idxSummary.health_score) >= 80 ? C.green : num(idxSummary.health_score) >= 60 ? C.amber : C.red} />
              <KStat label="Total indexes" value={fmtNum(idxSummary.total_indexes)} />
              <KStat label="Never read" value={idxSummary.unused_indexes_count ?? 0}
                color={idxSummary.unused_indexes_count ? C.red : C.green} />
              <KStat label="Unused but written" value={idxSummary.unused_with_writes_count ?? 0}
                color={idxSummary.unused_with_writes_count ? C.orange : C.green} />
              <KStat label="Candidates" value={idxSummary.missing_indexes_count ?? 0}
                color={idxSummary.missing_indexes_count ? C.amber : C.green} />
            </div>
            <RTable
              headers={['Table', 'Suggested columns', 'Improvement measure', 'Seeks', 'Scans']}
              rows={(idxD.missing_indexes || []).slice(0, 10).map((m) => [
                <span className="font-mono text-[11px] font-bold">{m.table_name}</span>,
                <span className="block max-w-[300px] truncate font-mono text-[11px]">{m.suggested_columns}</span>,
                m.improvement_measure != null ? fmtNum(Math.round(m.improvement_measure)) : '—',
                fmtNum(m.user_seeks),
                fmtNum(m.user_scans),
              ])}
              emptyMsg="No missing-index candidates for the connected database"
            />
            <p className="mt-2 text-[11px] text-slate-400">
              Index usage DMVs are per-database and reset on restart — this covers the
              connected database only.
            </p>
          </>
        ) : (
          <p className="text-sm text-slate-400">
            Index analysis unavailable{idxD?.error ? `: ${idxD.error}` : ''}.
          </p>
        )}
      </RSection>

      {/* ══ 10 · BACKUPS ══ */}
      <RSection title={`Backups — last 7 days (${backups.length})`} icon={Archive}
        color={backups.length ? C.green : C.red} pageBreak>
        <RTable
          headers={['Database', 'Type', 'Started', 'Finished', 'Size (MB)']}
          rows={backups.slice(0, 20).map((b) => [
            <span className="font-bold text-slate-800">{b.database_name}</span>,
            BACKUP_TYPES[b.backup_type] || b.backup_type || '—',
            String(b.backup_start_date || '').slice(0, 19) || '—',
            String(b.backup_finish_date || '').slice(0, 19) || '—',
            fmtNum(b.size_mb),
          ])}
          emptyMsg="No backup recorded in msdb for the last 7 days"
        />
        {simpleRecovery.length > 0 && (
          <p className="mt-2 text-[11px] text-amber-600">
            {simpleRecovery.length} database{simpleRecovery.length === 1 ? ' is' : 's are'} in SIMPLE
            recovery ({simpleRecovery.map((d) => d.name).join(', ')}) — log backups are not possible,
            so point-in-time restore is not available for {simpleRecovery.length === 1 ? 'it' : 'them'}.
          </p>
        )}
      </RSection>
    </ReportShell>
  );
}

/** msdb.dbo.backupset stores the type as one letter. */
const BACKUP_TYPES = {
  D: 'Full', I: 'Differential', L: 'Log', F: 'File', G: 'File diff', P: 'Partial', Q: 'Partial diff',
};
