import React, { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Activity, Clock, Server, Database, Users, Zap, HardDrive, RotateCcw,
  Shield, Lock, BarChart2, Cpu, Heart, CheckCircle2, TrendingUp,
  Archive, AlertOctagon, Layers, Radio,
} from 'lucide-react';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, PieChart, Pie, Cell, Legend,
} from 'recharts';
import client from '../../api/client';
import {
  ReportShell, RSection, KStat, RTable, UsageBar, HealthChecks,
  statusBadge, fmtNum, fmtBytes, now, C,
} from '../_shared/reportKit';

const ENGINE = {
  key: 'oracle',
  label: 'Oracle',
  emoji: '🔶',
  reportPrefix: 'oracle-report',
  headerGradient: 'linear-gradient(135deg,#0f172a 0%,#7a1f1f 55%,#3a0d0d 100%)',
  gradient: 'linear-gradient(135deg,#c74634,#f80000)',
};

const POOL_COLORS = [C.red, C.orange, C.amber, C.blue, C.purple, C.teal, C.green, C.cyan];

const api = (path, id) => client.get(`/connections/oracle/${id}/${path}`).then(r => r.data);

export default function OracleReportsPage() {
  const { id } = useParams();
  const [period, setPeriod] = useState('live');
  const [genTime, setGenTime] = useState(now);

  const refetchInterval = period === 'live' ? 30000 : false;

  /* existing queries */
  const { data: dash, isLoading: l1, refetch: r1 } = useQuery({ queryKey: ['rpt-dash', id], queryFn: () => api('oracle-dashboard', id), refetchInterval });
  const { data: sgaD, isLoading: l2 }              = useQuery({ queryKey: ['rpt-sga', id], queryFn: () => api('oracle-sga-detail', id), refetchInterval });
  const { data: pgaD }                             = useQuery({ queryKey: ['rpt-pga', id], queryFn: () => api('oracle-pga-detail', id), refetchInterval });
  const { data: sessD }                            = useQuery({ queryKey: ['rpt-sess', id], queryFn: () => api('oracle-sessions', id), refetchInterval });
  const { data: sqlD }                             = useQuery({ queryKey: ['rpt-sql', id], queryFn: () => api('oracle-top-sql', id), refetchInterval });
  const { data: waitD }                            = useQuery({ queryKey: ['rpt-wait', id], queryFn: () => api('oracle-wait-events', id), refetchInterval });
  const { data: tsD }                              = useQuery({ queryKey: ['rpt-ts', id], queryFn: () => api('oracle-tablespaces', id), refetchInterval });
  const { data: redoD }                            = useQuery({ queryKey: ['rpt-redo', id], queryFn: () => api('oracle-redo-logs', id), refetchInterval });
  const { data: dgD }                              = useQuery({ queryKey: ['rpt-dg', id], queryFn: () => api('oracle-data-guard', id), refetchInterval });
  const { data: liveD }                            = useQuery({ queryKey: ['rpt-live', id], queryFn: () => api('oracle-live-queries', id), refetchInterval: period === 'live' ? 10000 : false });
  const { data: lockD }                            = useQuery({ queryKey: ['rpt-lock', id], queryFn: () => api('oracle-locks', id), refetchInterval });
  const { data: sysD }                             = useQuery({ queryKey: ['rpt-sys', id], queryFn: () => api('oracle-system-stats', id), refetchInterval });
  const { data: procD }                            = useQuery({ queryKey: ['rpt-proc', id], queryFn: () => api('oracle-processes', id), refetchInterval });

  /* new endpoints */
  const { data: dbStatusD }   = useQuery({ queryKey: ['rpt-dbstatus', id], queryFn: () => api('oracle-db-status', id), refetchInterval });
  const { data: rmanD }       = useQuery({ queryKey: ['rpt-rman', id], queryFn: () => api('oracle-rman-backup', id), refetchInterval });
  const { data: archGapD }    = useQuery({ queryKey: ['rpt-archgap', id], queryFn: () => api('oracle-archive-log-gap', id), refetchInterval });
  const { data: invalidD }    = useQuery({ queryKey: ['rpt-invalid', id], queryFn: () => api('oracle-invalid-objects', id), refetchInterval });
  const { data: sarD }        = useQuery({ queryKey: ['rpt-sar', id], queryFn: () => api('oracle-sar-top', id), refetchInterval });
  const { data: datafilesD }  = useQuery({ queryKey: ['rpt-datafiles', id], queryFn: () => api('oracle-datafile-mounts', id), refetchInterval });
  const { data: ebsWfD }      = useQuery({ queryKey: ['rpt-ebswf', id], queryFn: () => api('oracle-ebs-workflow', id), refetchInterval });
  const { data: ebsConcD }    = useQuery({ queryKey: ['rpt-ebsconc', id], queryFn: () => api('oracle-ebs-concurrent', id), refetchInterval });

  const loading = l1 || l2;
  const refetchAll = () => { r1(); setGenTime(now()); };

  /* ── derived values ── */
  const hs          = dash?.health_summary || {};
  const conn        = dash?.connection || dbStatusD?.instance || {};
  const tablespaces = tsD?.tablespaces || dash?.tablespaces || [];
  const wait_events = waitD?.wait_events || dash?.wait_events || [];
  const top_sql     = sqlD?.top_sql || dash?.top_sql || [];
  const redo_logs   = redoD?.redo_logs || dash?.redo_logs || [];
  const sessions    = sessD?.sessions || [];
  const liveQ       = liveD?.queries || [];
  const locks       = lockD?.lock_waits || [];
  const sysStats    = sysD?.stats || [];
  const procs       = procD?.processes || [];
  const dgStandby   = dgD?.standby_dbs || [];
  const sgaPools    = sgaD?.pools || [];

  /* new data */
  const dbInst        = dbStatusD?.instance || {};
  const dbSt          = dbStatusD?.db_status || {};
  const rmanJobs      = rmanD?.jobs || [];
  const drGap         = archGapD?.dr_gap || [];
  const hourlyArc     = archGapD?.hourly_rate || [];
  const archMode      = archGapD?.arch_mode || hs.log_mode || '—';
  const invalidObjs   = invalidD?.objects || [];
  const invalidByType = invalidD?.by_type || [];
  const sarCpu        = sarD?.cpu_pct || 0;
  const sarMem        = sarD?.mem_pct || 0;
  const topCpu        = sarD?.top_cpu || [];
  const mountSummary  = datafilesD?.mount_summary || [];
  const datafilesList = datafilesD?.datafiles || [];
  const ebsWf         = ebsWfD;
  const ebsConc       = ebsConcD;

  /* derived health */
  const activeSess  = Number(hs.active_sessions) || 0;
  const totalSess   = Number(hs.total_sessions) || 0;
  const maxSess     = Number(hs.max_sessions) || 1;
  const sessionPct  = Math.min(100, Math.round(totalSess / maxSess * 100));
  const bufHitPct   = Number(hs.buffer_cache_hit_pct) || 0;
  const libHitPct   = Number(hs.library_cache_hit_pct) || 0;
  const sgaMb       = Number(hs.sga_mb) || 0;
  const pgaMb       = Number(hs.pga_mb) || 0;
  const maxTsPct    = tablespaces.length > 0 ? Math.max(...tablespaces.map(t => Number(t.used_pct) || 0)) : 0;
  const rmanFailed  = rmanD?.failed?.length || 0;
  const maxGap      = archGapD?.max_gap || 0;

  function computeScore() {
    let s = 100;
    if (sessionPct > 90) s -= 30; else if (sessionPct > 70) s -= 15;
    if (bufHitPct < 70) s -= 25;  else if (bufHitPct < 85) s -= 10;
    if (maxTsPct > 90) s -= 20;   else if (maxTsPct > 80) s -= 10;
    if (rmanFailed > 0) s -= 15;
    if (maxGap > 10) s -= 20;     else if (maxGap > 5) s -= 10;
    if ((invalidD?.total || 0) > 50) s -= 10;
    return Math.max(0, s);
  }
  const healthScore = computeScore();

  const sessChartData = sessions.reduce((acc, s) => {
    const k = s.status || 'UNKNOWN';
    const ex = acc.find(x => x.name === k);
    if (ex) ex.value++; else acc.push({ name: k, value: 1 });
    return acc;
  }, []);

  const connName = dash?.connection?.name || dbInst?.name || `Oracle #${id}`;
  const subtitle = `${dbInst.host || conn.host || ''}${dbInst.version ? ` · v${dbInst.version}` : ''}`;

  const alertBadges = [
    rmanFailed > 0 && { tone: 'red', label: `${rmanFailed} Backup Failed` },
    maxGap > 5 && { tone: 'amber', label: `DR Gap: ${maxGap}` },
  ];

  if (loading && !dash) return (
    <div className="min-h-screen flex items-center justify-center bg-[#f1f5f9]">
      <div className="text-center">
        <div className="w-12 h-12 border-4 border-red-200 border-t-red-600 rounded-full animate-spin mx-auto mb-4" />
        <p className="text-slate-600 font-semibold">Loading Oracle report…</p>
      </div>
    </div>
  );

  return (
    <ReportShell
      engine={{ ...ENGINE, backTo: `/oracle-dashboard/${id}` }}
      id={id} period={period} setPeriod={setPeriod}
      genTime={genTime} setGenTime={setGenTime} onRefresh={refetchAll}
      connName={connName} subtitle={subtitle} alertBadges={alertBadges}
    >
      {/* ══ 1. EXECUTIVE SUMMARY ══ */}
      <RSection title="Executive Summary" icon={Heart}
        color={healthScore >= 80 ? C.green : healthScore >= 60 ? C.amber : C.red}>
        <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-8 gap-3 mb-5">
          <KStat label="Health Score"     value={`${healthScore}/100`}               color={healthScore >= 80 ? C.green : healthScore >= 60 ? C.amber : C.red} />
          <KStat label="DB Status"        value={dbSt.open_mode || hs.status || '—'} color={dbSt.open_mode === 'READ WRITE' || hs.status === 'OPEN' ? C.green : C.red} />
          <KStat label="Uptime (days)"    value={dbInst.uptime_days || hs.uptime || '—'} />
          <KStat label="Sessions"         value={`${totalSess}/${maxSess}`}          color={sessionPct > 80 ? C.red : C.green} sub={`${sessionPct}% used`} />
          <KStat label="Active Sessions"  value={activeSess}                         color={activeSess > 50 ? C.orange : C.indigo} />
          <KStat label="Buffer Cache Hit" value={`${bufHitPct}%`}                    color={bufHitPct < 80 ? C.red : C.green} />
          <KStat label="Invalid Objects"  value={invalidD?.total ?? '—'}             color={(invalidD?.total || 0) > 0 ? C.orange : C.green} />
          <KStat label="RMAN Failed"      value={rmanFailed}                         color={rmanFailed > 0 ? C.red : C.green} />
        </div>
        <HealthChecks checks={[
          { ok: dbSt.open_mode === 'READ WRITE' || hs.status === 'OPEN', label: `DB: ${dbSt.open_mode || hs.status || '—'}` },
          { ok: sessionPct < 80,              label: `Sessions ${sessionPct}%` },
          { ok: bufHitPct >= 90,              label: `Buffer Hit ${bufHitPct}%` },
          { ok: libHitPct >= 95,              label: `Library Cache ${libHitPct}%` },
          { ok: maxTsPct < 85,                label: `Max Tablespace ${maxTsPct}%` },
          { ok: archMode === 'ARCHIVELOG',    label: `Log Mode: ${archMode}` },
          { ok: maxGap <= 5,                  label: `DR Gap: ${maxGap} logs` },
          { ok: rmanFailed === 0,             label: `RMAN: ${rmanFailed === 0 ? 'OK' : `${rmanFailed} Failed`}` },
          { ok: (invalidD?.total || 0) === 0, label: `Invalid Objects: ${invalidD?.total ?? '—'}` },
          { ok: locks.length === 0,           label: `Locks: ${locks.length === 0 ? 'None' : `${locks.length} waits`}` },
        ]} />
      </RSection>

      {/* ══ 2. DATABASE STATUS ══ */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-4">
        <RSection title="Database Status" icon={Database} color={C.red} className="!mb-0">
          <div className="grid grid-cols-2 gap-x-6">
            {[
              ['DB Name',       dbSt.name || hs.db_name],
              ['Unique Name',   dbSt.unique_name || hs.db_unique_name || '—'],
              ['Instance',      dbInst.name || hs.instance_name],
              ['Host',          dbInst.host || hs.host_name],
              ['Version',       dbInst.version || hs.version],
              ['Open Mode',     dbSt.open_mode || hs.status],
              ['DB Role',       dbSt.role || dgD?.db_role || '—'],
              ['Log Mode',      dbSt.log_mode || hs.log_mode],
              ['Flashback',     dbSt.flashback || '—'],
              ['Protection',    dbSt.protection || dgD?.protection_mode || '—'],
              ['Archiver',      dbInst.archiver || '—'],
              ['Startup Time',  dbInst.startup_time || hs.startup_time],
              ['Uptime (days)', dbInst.uptime_days || '—'],
              ['Logins',        dbInst.logins || '—'],
              ['Platform',      dbSt.platform || '—'],
              ['DB Size (GB)',  hs.db_size_gb || '—'],
            ].map(([l, v]) => (
              <div key={l} className="flex items-start justify-between py-1.5 border-b border-slate-100 last:border-0 col-span-1">
                <span className="text-[11px] text-slate-400 font-semibold flex-shrink-0">{l}</span>
                <span className="text-[11px] font-bold text-slate-800 font-mono ml-2 text-right break-all">
                  {(l === 'Open Mode' || l === 'Log Mode' || l === 'Flashback' || l === 'Logins') ? statusBadge(v) : (v || '—')}
                </span>
              </div>
            ))}
          </div>
        </RSection>

        <RSection title="Performance Overview" icon={TrendingUp} color={C.blue} className="!mb-0">
          <div className="grid grid-cols-2 gap-3 mb-4">
            <KStat label="Buffer Cache Hit"  value={`${bufHitPct}%`} color={bufHitPct < 85 ? C.red : C.green} />
            <KStat label="Library Cache Hit" value={`${libHitPct}%`} color={libHitPct < 95 ? C.orange : C.green} />
            <KStat label="SGA (MB)"          value={fmtNum(sgaMb)}   color={C.blue} />
            <KStat label="PGA (MB)"          value={fmtNum(pgaMb)}   color={C.purple} />
            <KStat label="CPU %"             value={`${sarCpu}%`}    color={sarCpu > 80 ? C.red : C.green} />
            <KStat label="Memory %"          value={`${sarMem}%`}    color={sarMem > 85 ? C.red : C.green} />
          </div>
          {sgaPools.length > 0 && (
            <ResponsiveContainer width="100%" height={150}>
              <BarChart data={sgaPools.slice(0, 6)} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                <XAxis dataKey="pool" tick={{ fontSize: 9 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 9 }} tickFormatter={v => `${(v / 1048576).toFixed(0)}M`} axisLine={false} tickLine={false} />
                <Tooltip formatter={v => fmtBytes(v)} />
                <Bar dataKey="bytes" radius={[4, 4, 0, 0]}>
                  {sgaPools.slice(0, 6).map((_, i) => <Cell key={i} fill={POOL_COLORS[i % POOL_COLORS.length]} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </RSection>
      </div>

      {/* ══ 3. RMAN BACKUP STATUS ══ */}
      <RSection title="RMAN Backup Status" icon={Archive} color={rmanFailed > 0 ? C.red : C.green} pageBreak>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          <KStat label="Total Jobs"     value={rmanD?.total ?? '—'} />
          <KStat label="Running"        value={rmanD?.running?.length ?? 0} color={C.blue} />
          <KStat label="Failed"         value={rmanFailed}                  color={rmanFailed > 0 ? C.red : C.green} />
          <KStat label="Last DB Backup" value={rmanD?.last_db_backup?.start_time?.slice(0, 16) || '—'}
            color={rmanD?.last_db_backup?.status === 'COMPLETED' ? C.green : C.orange} />
        </div>
        <RTable
          headers={['Input Type', 'Status', 'Start Time', 'End Time', 'HRS', 'Bytes Backed (GB)', 'Output (GB)', 'Device']}
          rows={rmanJobs.slice(0, 15).map(j => [
            <span className="font-bold text-slate-700">{j.input_type}</span>,
            statusBadge(j.status),
            <span className="font-mono text-[10px]">{j.start_time}</span>,
            <span className="font-mono text-[10px]">{j.end_time}</span>,
            <span className={`font-bold ${Number(j.hrs) > 4 ? 'text-orange-600' : 'text-slate-700'}`}>{j.hrs}</span>,
            <span className="font-bold">{j.input_gb}</span>,
            j.output_gb,
            <span className="text-[10px] font-mono text-slate-500">{j.output_device_type}</span>,
          ])}
          emptyMsg="No RMAN backup data"
        />
      </RSection>

      {/* ══ 4. ARCHIVE LOG GAP / DR STATUS ══ */}
      <RSection title="Archive Log Gap — DR Status" icon={Radio} color={maxGap > 5 ? C.red : C.green}>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          <KStat label="Archive Mode"  value={archMode}                  color={archMode === 'ARCHIVELOG' ? C.green : C.red} />
          <KStat label="Max Gap (logs)" value={maxGap}                   color={maxGap > 10 ? C.red : maxGap > 5 ? C.orange : C.green} />
          <KStat label="Total Gap"     value={archGapD?.total_gap ?? 0}  color={C.slate} />
          <KStat label="Destinations"  value={archGapD?.dr_gap?.length ?? 0} color={C.blue} />
        </div>
        <RTable
          headers={['DEST_ID', 'Dest Name', 'DB Unique', 'THREAD#', 'LOG_ARCHIVED', 'LOG_APPLIED', 'LOG_GAP', 'Status', 'Target']}
          rows={drGap.map(g => [
            g.dest_id,
            <span className="text-[10px] font-mono text-slate-500">{g.dest_name}</span>,
            <span className="font-bold text-blue-700">{g.db_unique || '—'}</span>,
            g.thread_num,
            <span className="font-mono">{g.log_archived}</span>,
            <span className="font-mono">{g.log_applied}</span>,
            <span className={`font-black text-lg ${Number(g.log_gap) > 10 ? 'text-red-600' : Number(g.log_gap) > 5 ? 'text-amber-600' : 'text-green-600'}`}>
              {g.log_gap}
            </span>,
            statusBadge(g.status),
            <span className={`text-[10px] font-bold ${g.target === 'STANDBY' ? 'text-purple-600' : 'text-slate-400'}`}>{g.target}</span>,
          ])}
          emptyMsg="No DR destinations configured"
        />
        {hourlyArc.length > 0 && (
          <div className="mt-4">
            <p className="text-xs font-bold text-slate-500 mb-2">Hourly Archive Generation (last 24h)</p>
            <ResponsiveContainer width="100%" height={140}>
              <BarChart data={hourlyArc.slice(0, 24).reverse()} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                <XAxis dataKey="hour_slot" tick={{ fontSize: 8 }} axisLine={false} tickLine={false}
                  tickFormatter={v => v?.slice(-5) || ''} />
                <YAxis tick={{ fontSize: 9 }} axisLine={false} tickLine={false} />
                <Tooltip formatter={(v, n) => [v, n === 'logs' ? 'Archive Logs' : 'MB']} />
                <Bar dataKey="logs" fill={C.blue} radius={[3, 3, 0, 0]} name="logs" />
                <Bar dataKey="mb"   fill={C.teal} radius={[3, 3, 0, 0]} name="mb" />
                <Legend wrapperStyle={{ fontSize: 10 }} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </RSection>

      {/* ══ 5. TABLESPACE USAGE ══ */}
      <RSection title="Tablespace Usage" icon={HardDrive} color={C.teal} pageBreak>
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
          <div>
            {tablespaces.slice(0, 12).map((ts, i) => (
              <UsageBar key={i}
                label={ts.tablespace_name}
                pct={Number(ts.used_pct) || 0}
                sub={`Free: ${fmtNum(ts.free_mb)} MB · Total: ${fmtNum(ts.total_mb)} MB`} />
            ))}
          </div>
          <RTable
            headers={['Tablespace', 'Status', 'Total (MB)', 'Free (GB)', 'Used %']}
            rows={tablespaces.map(ts => [
              <span className="font-bold text-teal-700">{ts.tablespace_name}</span>,
              statusBadge(ts.status),
              fmtNum(ts.total_mb),
              <span className="font-bold">{(Number(ts.free_mb || 0) / 1024).toFixed(1)}</span>,
              <span className={`font-bold ${Number(ts.used_pct) > 85 ? 'text-red-600' : Number(ts.used_pct) > 70 ? 'text-orange-600' : 'text-green-600'}`}>
                {ts.used_pct}%
              </span>,
            ])}
          />
        </div>
      </RSection>

      {/* ══ 6. INVALID OBJECTS ══ */}
      <RSection title={`Invalid Objects (${invalidD?.total ?? 0} total)`}
        icon={AlertOctagon} color={(invalidD?.total || 0) > 0 ? C.orange : C.green}>
        {(invalidD?.total || 0) === 0 ? (
          <div className="text-center py-4 flex items-center justify-center gap-2 text-green-600">
            <CheckCircle2 size={18} />
            <span className="font-bold text-sm">No invalid objects found</span>
          </div>
        ) : (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
            <div>
              <p className="text-xs font-bold text-slate-500 mb-3">BY OBJECT TYPE</p>
              <RTable
                headers={['Object Type', 'Count']}
                rows={invalidByType.slice(0, 12).map(x => [
                  <span className="font-bold text-orange-700">{x.type}</span>,
                  <span className="font-black text-slate-800">{x.count}</span>,
                ])}
              />
            </div>
            <div>
              <p className="text-xs font-bold text-slate-500 mb-3">INVALID OBJECT DETAILS (first 20)</p>
              <RTable
                headers={['Owner', 'Type', 'Object Name', 'Last DDL']}
                rows={invalidObjs.slice(0, 20).map(o => [
                  <span className="font-bold text-red-700">{o.owner}</span>,
                  <span className="text-[10px] font-mono text-slate-500">{o.object_type}</span>,
                  <span className="font-semibold text-slate-700">{o.object_name}</span>,
                  <span className="font-mono text-[10px] text-slate-400">{o.last_ddl?.slice(0, 10)}</span>,
                ])}
              />
            </div>
          </div>
        )}
      </RSection>

      {/* ══ 7. SAR / TOP PROCESSES ══ */}
      <RSection title="System Activity (SAR) / Top Processes" icon={Cpu} color={C.cyan} pageBreak>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          <KStat label="CPU Usage %"       value={`${sarCpu}%`}         color={sarCpu > 80 ? C.red : C.green} />
          <KStat label="Memory Usage %"    value={`${sarMem}%`}         color={sarMem > 85 ? C.red : C.green} />
          <KStat label="Physical Mem (GB)" value={sarD?.phys_gb ?? '—'} color={C.blue} />
          <KStat label="Free Mem (GB)"     value={sarD?.free_gb ?? '—'} color={C.teal} />
        </div>
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
          <div>
            <p className="text-xs font-bold text-slate-500 mb-2">TOP SESSIONS BY CPU</p>
            <RTable
              headers={['SID', 'Username', 'Program', 'CPU %', 'Status', 'OS PID']}
              rows={topCpu.slice(0, 10).map(t => [
                <span className="font-mono">{t.sid}</span>,
                <span className="font-bold text-blue-700">{t.username || '—'}</span>,
                <span className="text-[10px] text-slate-500 truncate max-w-[120px] block">{(t.program || '').slice(0, 30)}</span>,
                <span className={`font-bold ${t.cpu_pct > 20 ? 'text-red-600' : 'text-slate-700'}`}>{t.cpu_pct}%</span>,
                statusBadge(t.status),
                <span className="font-mono text-[10px] text-slate-400">{t.os_pid}</span>,
              ])}
              emptyMsg="No session CPU data"
            />
          </div>
          <div>
            <p className="text-xs font-bold text-slate-500 mb-2">OS STATISTICS</p>
            {sarD?.os_stats && (
              <RTable
                headers={['Metric', 'Value']}
                rows={Object.entries(sarD.os_stats).slice(0, 12).map(([k, v]) => [
                  <span className="font-semibold text-slate-600 text-[11px]">{k.replace(/_/g, ' ')}</span>,
                  <span className="font-black text-slate-800">{typeof v === 'number' ? v.toLocaleString() : v}</span>,
                ])}
              />
            )}
          </div>
        </div>
      </RSection>

      {/* ══ 8. DB MOUNT POINTS / DATA FILES ══ */}
      <RSection title="DB Mount Points / Data Files" icon={Layers} color={C.slate}>
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
          <div>
            <p className="text-xs font-bold text-slate-500 mb-2">MOUNT POINT SUMMARY</p>
            <RTable
              headers={['Mount Point', 'Files', 'Total GB']}
              rows={mountSummary.map(m => [
                <span className="font-mono text-blue-700 text-[11px]">{m.mount || 'unknown'}</span>,
                m.files,
                <span className="font-bold">{Number(m.total_gb || 0).toFixed(2)}</span>,
              ])}
              emptyMsg="No mount point data"
            />
          </div>
          <div>
            <p className="text-xs font-bold text-slate-500 mb-2">DATA FILES (first 20)</p>
            <RTable
              headers={['Tablespace', 'Size GB', 'AutoExt', 'Max GB', 'Status']}
              rows={datafilesList.slice(0, 20).map(f => [
                <span className="font-bold text-teal-700 text-[10px]">{f.tablespace}</span>,
                <span className="font-bold">{f.size_gb}</span>,
                statusBadge(f.autoextend),
                f.max_gb,
                statusBadge(f.status),
              ])}
              emptyMsg="No data file info (DBA privilege required)"
            />
          </div>
        </div>
      </RSection>

      {/* ══ 9. TOP SQL ══ */}
      <RSection title="Top SQL by Elapsed Time" icon={Zap} color={C.orange} pageBreak>
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-5 mb-4">
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={top_sql.slice(0, 8).map(s => ({
              name: (s.sql_id || '').slice(0, 12),
              elapsed: Math.round(Number(s.elapsed_ms) || 0),
              cpu: Math.round(Number(s.cpu_ms) || 0),
            }))} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
              <XAxis dataKey="name" tick={{ fontSize: 9 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 9 }} tickFormatter={fmtNum} axisLine={false} tickLine={false} />
              <Tooltip formatter={v => `${fmtNum(v)} ms`} />
              <Bar dataKey="elapsed" fill={C.orange} radius={[4, 4, 0, 0]} name="Elapsed" />
              <Bar dataKey="cpu"     fill={C.red}    radius={[4, 4, 0, 0]} name="CPU" />
              <Legend wrapperStyle={{ fontSize: 10 }} />
            </BarChart>
          </ResponsiveContainer>
          <RTable
            headers={['SQL ID', 'Exec', 'Elapsed (ms)', 'CPU (ms)', 'Buf Gets', 'Avg ms']}
            rows={top_sql.slice(0, 8).map(s => [
              <span className="font-mono text-[10px] text-red-700">{s.sql_id || '—'}</span>,
              fmtNum(s.executions),
              <span className={`font-bold ${Number(s.elapsed_ms) > 5000 ? 'text-red-600' : Number(s.elapsed_ms) > 1000 ? 'text-orange-600' : 'text-slate-700'}`}>{fmtNum(s.elapsed_ms)}</span>,
              fmtNum(s.cpu_ms),
              fmtNum(s.buffer_gets),
              <span className={`font-bold ${Number(s.avg_elapsed_ms) > 1000 ? 'text-red-600' : 'text-green-600'}`}>{fmtNum(s.avg_elapsed_ms)}</span>,
            ])}
          />
        </div>
      </RSection>

      {/* ══ 10. WAIT EVENTS + SESSIONS ══ */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-4">
        <RSection title="Top Wait Events" icon={Clock} color={C.red} className="!mb-0">
          {wait_events.length === 0 ? (
            <p className="text-center text-slate-400 py-6">No wait events</p>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart layout="vertical"
                data={wait_events.slice(0, 8).map(w => ({
                  name: (w.event || '').slice(0, 30),
                  waits: Number(w.total_waits) || 0,
                }))}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 9 }} tickFormatter={fmtNum} axisLine={false} tickLine={false} />
                <YAxis width={150} type="category" dataKey="name" tick={{ fontSize: 9 }} axisLine={false} tickLine={false} />
                <Tooltip formatter={(v) => [fmtNum(v), 'Total Waits']} />
                <Bar dataKey="waits" fill={C.red} radius={[0, 4, 4, 0]} name="Total Waits" />
              </BarChart>
            </ResponsiveContainer>
          )}
        </RSection>

        <RSection title="Session Analysis" icon={Users} color={C.indigo} className="!mb-0">
          <div className="grid grid-cols-3 gap-3 mb-3">
            <KStat label="Active" value={activeSess} color={C.green} />
            <KStat label="Total"  value={totalSess}  color={C.indigo} />
            <KStat label="Max"    value={maxSess}    color={C.slate} />
          </div>
          {sessChartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={150}>
              <PieChart>
                <Pie data={sessChartData} dataKey="value" nameKey="name"
                  innerRadius={40} outerRadius={65}
                  label={({ name, percent }) => percent > 0.05 ? `${name} ${(percent * 100).toFixed(0)}%` : ''}>
                  {sessChartData.map((_, i) => <Cell key={i} fill={POOL_COLORS[i % POOL_COLORS.length]} />)}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <p className="text-center text-slate-400 text-xs py-4">No session data</p>
          )}
        </RSection>
      </div>

      {/* ══ 11. LIVE QUERIES ══ */}
      <RSection title={`Live Queries (${liveQ.length} sessions)`} icon={Activity} color={C.green}>
        {liveQ.length === 0 ? (
          <div className="text-center py-6 flex items-center justify-center gap-2 text-green-600">
            <CheckCircle2 size={18} />
            <span className="font-bold text-sm">No active queries running</span>
          </div>
        ) : (
          <RTable
            headers={['SID', 'Username', 'Status', 'Wait Event', 'Sec Wait', 'SQL ID', 'Machine', 'SQL Preview']}
            rows={liveQ.slice(0, 15).map(q => [
              <span className="font-mono text-slate-500">{q.sid}</span>,
              <span className="font-bold text-red-700">{q.username || '—'}</span>,
              statusBadge(q.status),
              <span className="text-orange-600 text-[11px]">{q.wait_event || 'CPU'}</span>,
              <span className={`font-bold ${Number(q.seconds_in_wait) > 60 ? 'text-red-600' : 'text-slate-600'}`}>{q.seconds_in_wait || 0}s</span>,
              <span className="font-mono text-[10px] text-slate-400">{q.sql_id || '—'}</span>,
              <span className="text-slate-400 text-[10px]">{(q.machine || '').slice(0, 20)}</span>,
              <span className="font-mono text-[10px] text-slate-500 max-w-[200px] truncate block">{(q.sql_text || '').slice(0, 80)}</span>,
            ])}
          />
        )}
      </RSection>

      {/* ══ 12. LOCK ANALYSIS ══ */}
      <RSection title={`Lock Analysis (${locks.length} waits)`} icon={Lock} color={locks.length > 0 ? C.red : C.green}>
        {locks.length === 0 ? (
          <div className="text-center py-4 flex items-center justify-center gap-2 text-green-600">
            <CheckCircle2 size={18} />
            <span className="font-bold text-sm">No lock waits — database is healthy</span>
          </div>
        ) : (
          <RTable
            headers={['Blocker SID', 'Waiter SID', 'Lock Type', 'Mode Held', 'Mode Req', 'Wait (s)']}
            rows={locks.map(l => [
              <span className="font-bold text-red-700">{l.blocking_session || l.blocker_sid || '—'}</span>,
              l.waiting_session || l.waiter_sid || '—',
              l.lock_type || '—',
              l.mode_held || '—',
              l.mode_requested || '—',
              <span className={`font-bold ${Number(l.seconds_in_wait || l.wait_seconds) > 60 ? 'text-red-600' : 'text-orange-600'}`}>
                {l.seconds_in_wait || l.wait_seconds || '—'}
              </span>,
            ])}
          />
        )}
      </RSection>

      {/* ══ 13. REDO LOGS + DATA GUARD ══ */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-4">
        <RSection title="Redo Log Groups" icon={RotateCcw} color={C.blue} className="!mb-0">
          <RTable
            headers={['Group', 'Members', 'Bytes', 'Sequence', 'Status', 'Archived']}
            rows={redo_logs.map(r => [
              <span className="font-mono font-bold">{r.group_no || r.group}</span>,
              r.members,
              fmtBytes(r.bytes || 0),
              r.sequence_no || r.sequence || '—',
              statusBadge(r.status),
              <span className={r.archived === 'YES' ? 'text-green-600 font-bold' : 'text-red-600 font-bold'}>{r.archived}</span>,
            ])}
            emptyMsg="No redo log data"
          />
        </RSection>

        <RSection title="Data Guard / DR Sync" icon={Shield} color={C.purple} className="!mb-0">
          <div className="grid grid-cols-2 gap-3 mb-3">
            <KStat label="DB Role"     value={dgD?.db_role || dbSt.role || '—'} color={C.purple} />
            <KStat label="Protection"  value={dgD?.protection_mode || dbSt.protection || '—'} />
            <KStat label="Switchover"  value={dgD?.switchover_status || '—'} color={C.indigo} />
            <KStat label="Standby DBs" value={dgStandby.length} color={dgStandby.length > 0 ? C.green : C.slate} />
          </div>
          {dgStandby.length > 0 ? (
            <RTable
              headers={['Dest', 'DB Name', 'Status', 'Log Mode', 'Delay']}
              rows={dgStandby.map(s => [
                s.dest_id || '—',
                s.db_unique_name || '—',
                s.status || '—',
                s.protection_mode || '—',
                s.delay_mins ? `${s.delay_mins}m` : '0',
              ])}
            />
          ) : (
            <p className="text-slate-400 text-xs text-center py-4">Standalone instance — no Data Guard</p>
          )}
        </RSection>
      </div>

      {/* ══ 14. EBS SECTIONS (only shown if is_ebs) ══ */}
      {(ebsWf?.is_ebs || ebsConc?.is_ebs) && (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-4">
          <RSection title={`EBS Workflow Status (${ebsWf?.total_stuck || 0} stuck)`}
            icon={Activity} color={(ebsWf?.total_stuck || 0) > 0 ? C.red : C.green} className="!mb-0">
            {(ebsWf?.by_type || []).length > 0 ? (
              <>
                <div className="grid grid-cols-3 gap-2 mb-3">
                  {(ebsWf?.by_type || []).slice(0, 6).map(x => (
                    <KStat key={x.status} label={x.status} value={x.count}
                      color={x.status === 'ERROR' ? C.red : x.status === 'DEFERRED' ? C.orange : C.slate} />
                  ))}
                </div>
                {(ebsWf?.stuck || []).length > 0 && (
                  <RTable
                    headers={['Item Type', 'Status', 'Begin Date', 'Days Stuck']}
                    rows={(ebsWf?.stuck || []).slice(0, 10).map(w => [
                      <span className="font-bold text-purple-700">{w.item_type}</span>,
                      statusBadge(w.status),
                      <span className="font-mono text-[10px]">{w.begin_date}</span>,
                      <span className={`font-bold ${w.days_stuck > 1 ? 'text-red-600' : 'text-orange-600'}`}>{w.days_stuck}d</span>,
                    ])}
                  />
                )}
              </>
            ) : (
              <p className="text-slate-400 text-xs text-center py-4">No EBS Workflow data (non-EBS instance)</p>
            )}
          </RSection>

          <RSection title="Concurrent Manager Status" icon={Server} color={C.cyan} className="!mb-0">
            {(ebsConc?.managers || []).length > 0 ? (
              <RTable
                headers={['Manager', 'Enabled', 'Running', 'Max']}
                rows={(ebsConc?.managers || []).slice(0, 15).map(m => [
                  <span className="font-bold text-cyan-700 text-[11px]">{m.display || m.name}</span>,
                  statusBadge(m.enabled === 'Y' ? 'YES' : 'NO'),
                  <span className="font-bold">{m.running}</span>,
                  m.max,
                ])}
              />
            ) : (
              <p className="text-slate-400 text-xs text-center py-4">No Concurrent Manager data (non-EBS instance)</p>
            )}
          </RSection>
        </div>
      )}

      {/* ══ 15. SYSTEM STATISTICS ══ */}
      <RSection title="System Statistics" icon={BarChart2} color={C.slate} pageBreak>
        {sysStats.length === 0 ? (
          <p className="text-center text-slate-400 py-4">No system stats</p>
        ) : (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={sysStats.slice(0, 8).map(s => ({
                name: (s.name || s.statistic_name || '').replace(/_/g, ' ').slice(0, 22),
                value: Number(s.value) || 0,
              }))} layout="vertical" margin={{ left: 10, right: 10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 9 }} tickFormatter={fmtNum} axisLine={false} tickLine={false} />
                <YAxis width={150} type="category" dataKey="name" tick={{ fontSize: 9 }} axisLine={false} tickLine={false} />
                <Tooltip formatter={v => fmtNum(v)} />
                <Bar dataKey="value" fill={C.slate} radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
            <RTable
              headers={['Statistic', 'Value']}
              rows={sysStats.slice(0, 16).map(s => [
                <span className="font-semibold text-slate-600">{s.name || s.statistic_name}</span>,
                <span className="font-black text-slate-800">{fmtNum(s.value)}</span>,
              ])}
            />
          </div>
        )}
      </RSection>

      {/* ══ 16. WAIT EVENTS DETAIL ══ */}
      <RSection title="Wait Events Detail" icon={Clock} color={C.amber} pageBreak>
        <RTable
          headers={['Event', 'Wait Class', 'Total Waits', 'Time Waited (s)', 'Avg Wait (ms)']}
          rows={wait_events.slice(0, 15).map(w => [
            <span className="font-semibold text-slate-700">{w.event}</span>,
            <span className="text-[11px] px-2 py-0.5 rounded bg-amber-50 text-amber-700 font-bold">{w.wait_class}</span>,
            fmtNum(w.total_waits),
            <span className="font-bold">{Number(w.time_waited_seconds || 0).toFixed(2)}</span>,
            <span className={`font-bold ${Number(w.avg_wait_ms) > 100 ? 'text-red-600' : 'text-green-600'}`}>
              {Number(w.avg_wait_ms || 0).toFixed(2)}
            </span>,
          ])}
          emptyMsg="No wait events"
        />
      </RSection>
    </ReportShell>
  );
}
