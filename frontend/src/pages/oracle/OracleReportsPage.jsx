import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Activity, AlertOctagon, Archive, BarChart2, Clock, Cpu, Database, HardDrive, Layers,
  Lock, MemoryStick, Radio, RotateCcw, Server, Shield, TrendingUp, Users, Zap,
} from 'lucide-react';
import client from '@/api/client';
import { PageLoading } from '@/components/ui/Loading';
import {
  C, HealthChecks, KStat, RSection, RTable, ReportShell, UsageBar, fmtNum, now, statusBadge,
} from '@/pages/_shared/reportKit';
import { explainWait } from '@/config/oracleWaits';

/**
 * Oracle monitoring report — twenty sections over twenty-one endpoints.
 *
 * Bound to what each endpoint actually returns. The existing report reads
 * `waitD.wait_events`, `sqlD.top_sql`, `redoD.redo_logs` and `dgD.standby_dbs`;
 * the service returns `events`, `sql`, `log_groups` and `standby_logs`. The first
 * three silently fell back to the dashboard payload's smaller copies, and the
 * fourth had no fallback at all, so the Data Guard standby table was always empty.
 *
 * The EBS sections only render for an E-Business Suite database — the endpoints
 * report `is_ebs` themselves, so a plain Oracle instance does not get two empty
 * sections about a product it does not run.
 */

const ENGINE = {
  key: 'oracle',
  label: 'Oracle',
  emoji: '🔶',
  reportPrefix: 'oracle-report',
};

const api = (path, id) => client.get(`/connections/oracle/${id}/${path}`).then((r) => r.data);
const num = (v) => Number(v) || 0;

/**
 * One section's data. A hook rather than twenty-one inline `useQuery` blocks; the
 * period is part of the key so switching period refetches, instead of showing live
 * numbers under a "Weekly" heading.
 */
function useReportQuery(id, period, key, path, interval) {
  return useQuery({
    queryKey: [`rpt-oracle-${key}`, id, period],
    queryFn: () => api(path, id),
    refetchInterval: interval,
    retry: false,
  });
}

export default function OracleReportsPage() {
  const { id } = useParams();
  const [period, setPeriod] = useState('live');
  const [genTime, setGenTime] = useState(now);
  const live = period === 'live';
  const every = live ? 30000 : false;

  const use = (key, path, interval = every) => useReportQuery(id, period, key, path, interval);

  const dash = use('dash', 'oracle-dashboard');
  const dbStatus = use('dbstatus', 'oracle-db-status');
  const sga = use('sga', 'oracle-sga-detail');
  const pga = use('pga', 'oracle-pga-detail');
  const sessions = use('sess', 'oracle-sessions');
  const topSql = use('sql', 'oracle-top-sql');
  const waits = use('wait', 'oracle-wait-events');
  const tablespaces = use('ts', 'oracle-tablespaces');
  const redo = use('redo', 'oracle-redo-logs');
  const dataGuard = use('dg', 'oracle-data-guard');
  const live_ = use('live', 'oracle-live-queries', live ? 10000 : false);
  const locks = use('lock', 'oracle-locks');
  const sysStats = use('sys', 'oracle-system-stats');
  const processes = use('proc', 'oracle-processes');
  const rman = use('rman', 'oracle-rman-backup');
  const archGap = use('archgap', 'oracle-archive-log-gap');
  const invalid = use('invalid', 'oracle-invalid-objects');
  const sar = use('sar', 'oracle-sar-top');
  const datafiles = use('datafiles', 'oracle-datafile-mounts');
  const ebsWf = use('ebswf', 'oracle-ebs-workflow');
  const ebsConc = use('ebsconc', 'oracle-ebs-concurrent');

  /* ── the real keys each endpoint returns ── */
  const hs = dash.data?.health_summary || {};
  const conn = dash.data?.connection || {};
  const inst = dbStatus.data?.instance || {};
  const dbSt = dbStatus.data?.db_status || {};
  const sessionCounts = dbStatus.data?.sessions || {};
  const sgaPools = sga.data?.pools || [];
  const pgaSummary = pga.data?.summary || {};
  const sessionRows = sessions.data?.sessions || [];
  const sessionSummary = sessions.data?.summary || {};
  const sqlRows = topSql.data?.sql || dash.data?.top_sql || [];
  const waitRows = waits.data?.events || dash.data?.wait_events || [];
  const waitClasses = waits.data?.class_breakdown || [];
  const tsRows = tablespaces.data?.tablespaces || dash.data?.tablespaces || [];
  const redoGroups = redo.data?.log_groups || dash.data?.redo_logs || [];
  const archiveDests = dataGuard.data?.archive_dests || [];
  const standbyLogs = dataGuard.data?.standby_logs || [];
  const dgMessages = dataGuard.data?.dg_status || [];
  const liveRows = live_.data?.queries || [];
  const lockRows = locks.data?.lock_waits || [];
  const enqueueRows = locks.data?.enqueue_stats || [];
  const keyStats = sysStats.data?.key_stats || {};
  const procRows = processes.data?.processes || [];
  const rmanJobs = rman.data?.jobs || [];
  const rmanFailed = (rman.data?.failed || []).length;
  const lastDbBackup = rman.data?.last_db_backup || null;
  const drGap = archGap.data?.dr_gap || [];
  const hourlyArchive = archGap.data?.hourly_rate || [];
  const archMode = archGap.data?.arch_mode || hs.log_mode || '—';
  const maxGap = num(archGap.data?.max_gap);
  const invalidObjects = invalid.data?.objects || [];
  const invalidByType = invalid.data?.by_type || [];
  const mounts = datafiles.data?.mount_summary || [];
  const dataFileRows = datafiles.data?.datafiles || [];
  const topCpu = sar.data?.top_cpu || [];
  const topIo = sar.data?.top_io || [];

  /* ── derived ── */
  const sessionPct = num(hs.session_pct)
    || (num(hs.max_sessions) ? Math.round((num(hs.total_sessions) / num(hs.max_sessions)) * 100) : 0);
  const bufHitPct = num(hs.buffer_cache_hit_pct);
  const libHitPct = num(hs.library_cache_hit_pct);
  const hostCpuPct = num(sar.data?.cpu_pct) || num(hs.host_cpu_pct);
  const hostMemPct = num(sar.data?.mem_pct);
  const maxTsPct = tsRows.length ? Math.max(...tsRows.map((t) => num(t.used_pct))) : 0;
  const fullestTs = tsRows.find((t) => num(t.used_pct) === maxTsPct);
  const criticalTs = tsRows.filter((t) => num(t.used_pct) > 85);
  const busyWaits = waitRows.filter((w) => !/idle/i.test(w.wait_class || ''));
  const singleMemberGroups = redoGroups.filter((g) => num(g.members) < 2);
  const invalidTotal = num(invalid.data?.total);

  const healthScore = (() => {
    let s = 100;
    if (sessionPct > 90) s -= 30; else if (sessionPct > 70) s -= 15;
    if (bufHitPct > 0 && bufHitPct < 70) s -= 25; else if (bufHitPct > 0 && bufHitPct < 85) s -= 10;
    if (maxTsPct > 90) s -= 20; else if (maxTsPct > 80) s -= 10;
    if (rmanFailed > 0) s -= 15;
    if (maxGap > 10) s -= 20; else if (maxGap > 5) s -= 10;
    if (invalidTotal > 50) s -= 10;
    return Math.max(0, s);
  })();

  const connName = conn.name || inst.name || `Oracle #${id}`;
  const subtitle = [
    inst.host || conn.host || null,
    inst.version ? `v${inst.version}` : null,
    dbSt.role || null,
  ].filter(Boolean).join(' · ');

  const alertBadges = [
    rmanFailed > 0 && { tone: 'red', label: `${rmanFailed} backup${rmanFailed === 1 ? '' : 's'} failed` },
    maxGap > 5 && { tone: 'amber', label: `DR gap ${maxGap} logs` },
    criticalTs.length > 0 && { tone: 'red', label: `${criticalTs.length} tablespace${criticalTs.length === 1 ? '' : 's'} over 85%` },
    lockRows.length > 0 && { tone: 'red', label: `${lockRows.length} lock wait${lockRows.length === 1 ? '' : 's'}` },
    archMode !== 'ARCHIVELOG' && { tone: 'red', label: `Log mode ${archMode}` },
  ];

  if (dash.isLoading && !dash.data) return <PageLoading title="Loading Oracle report…" />;

  return (
    <ReportShell
      engine={{ ...ENGINE, backTo: `/oracle-dashboard/${id}` }}
      id={id}
      period={period}
      setPeriod={setPeriod}
      genTime={genTime}
      setGenTime={setGenTime}
      onRefresh={() => { dash.refetch(); setGenTime(now()); }}
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
          <KStat label="Open Mode" value={dbSt.open_mode || hs.status || '—'}
            color={dbSt.open_mode === 'READ WRITE' || hs.status === 'OPEN' ? C.green : C.red} />
          <KStat label="Role" value={dbSt.role || '—'} color={C.blue} />
          <KStat label="Log Mode" value={archMode}
            color={archMode === 'ARCHIVELOG' ? C.green : C.red}
            sub={archMode === 'ARCHIVELOG' ? undefined : 'no PITR possible'} />
          <KStat label="Uptime" value={inst.uptime_days != null ? `${inst.uptime_days} days` : '—'}
            sub={inst.startup_time || hs.startup_time || undefined} />
          <KStat label="Sessions" value={`${num(hs.total_sessions)}/${num(hs.max_sessions)}`}
            color={sessionPct > 80 ? C.red : C.green} sub={`${sessionPct}% of the limit`} />
          <KStat label="Buffer Cache Hit" value={bufHitPct ? `${bufHitPct}%` : '—'}
            color={bufHitPct && bufHitPct < 90 ? C.red : C.green} />
          <KStat label="Database Size" value={hs.db_size_gb ? `${hs.db_size_gb} GB` : '—'} color={C.blue} />
        </div>
        <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8">
          <KStat label="Host CPU" value={hostCpuPct ? `${hostCpuPct}%` : '—'}
            color={hostCpuPct > 85 ? C.red : C.green} />
          <KStat label="Host Memory" value={hostMemPct ? `${hostMemPct}%` : '—'}
            color={hostMemPct > 90 ? C.red : C.green} />
          <KStat label="SGA" value={`${fmtNum(hs.sga_mb)} MB`} color={C.teal} />
          <KStat label="PGA" value={`${fmtNum(hs.pga_mb)} MB`} color={C.indigo} />
          <KStat label="Fullest Tablespace" value={maxTsPct ? `${maxTsPct}%` : '—'}
            color={maxTsPct > 90 ? C.red : maxTsPct > 80 ? C.amber : C.green}
            sub={fullestTs?.tablespace_name} />
          <KStat label="Lock Waits" value={lockRows.length} color={lockRows.length ? C.red : C.green} />
          <KStat label="Invalid Objects" value={invalidTotal} color={invalidTotal ? C.amber : C.green} />
          <KStat label="DR Gap" value={maxGap} color={maxGap > 5 ? C.red : C.green} sub="logs behind" />
        </div>
        <HealthChecks checks={[
          { ok: dbSt.open_mode === 'READ WRITE' || hs.status === 'OPEN', label: `Open mode: ${dbSt.open_mode || hs.status || '—'}` },
          { ok: archMode === 'ARCHIVELOG', label: `Log mode: ${archMode}` },
          { ok: sessionPct < 80, label: `Sessions ${sessionPct}%` },
          { ok: !bufHitPct || bufHitPct >= 90, label: `Buffer cache ${bufHitPct || '—'}%` },
          { ok: !libHitPct || libHitPct >= 95, label: `Library cache ${libHitPct || '—'}%` },
          { ok: maxTsPct <= 85, label: `Fullest tablespace ${maxTsPct}%` },
          { ok: rmanFailed === 0, label: `RMAN failures: ${rmanFailed}` },
          { ok: maxGap <= 5, label: `DR gap: ${maxGap} logs` },
          { ok: lockRows.length === 0, label: `Lock waits: ${lockRows.length}` },
          { ok: singleMemberGroups.length === 0, label: `Redo groups with one member: ${singleMemberGroups.length}` },
          { ok: invalidTotal === 0, label: `Invalid objects: ${invalidTotal}` },
        ]} />
      </RSection>

      {/* ══ 2 · INSTANCE ══ */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <RSection title="Instance & Database" icon={Database} color={C.red} className="!mb-0">
          <RTable
            headers={['Property', 'Value']}
            rows={[
              ['Instance', inst.name || hs.instance_name],
              ['Host', inst.host || hs.host_name],
              ['Version', inst.version || hs.version],
              ['Instance status', inst.status || hs.status],
              ['Database status', inst.db_status],
              ['Logins', inst.logins],
              ['Archiver', inst.archiver],
              ['Started', inst.startup_time || hs.startup_time],
              ['Database name', dbSt.name || hs.db_name],
              ['Unique name', dbSt.unique_name || hs.db_unique_name],
              ['Open mode', dbSt.open_mode],
              ['Role', dbSt.role],
              ['Protection mode', dbSt.protection],
              ['Flashback', dbSt.flashback],
              ['Platform', dbSt.platform],
            ].filter(([, v]) => v != null && v !== '')
              .map(([k, v]) => [<span className="font-semibold text-slate-700">{k}</span>, v])}
            emptyMsg="v$instance / v$database could not be read"
          />
        </RSection>

        <RSection title="Performance Overview" icon={TrendingUp} color={C.blue} className="!mb-0">
          <UsageBar label="Sessions against the limit" pct={sessionPct}
            color={sessionPct > 85 ? C.red : C.green} />
          <UsageBar label="Buffer cache hit rate" pct={bufHitPct}
            color={bufHitPct < 90 ? C.red : C.green} />
          <UsageBar label="Library cache hit rate" pct={libHitPct}
            color={libHitPct < 95 ? C.amber : C.green} />
          <UsageBar label="Host CPU" pct={hostCpuPct} color={hostCpuPct > 85 ? C.red : C.green} />
          <UsageBar label="Host memory" pct={hostMemPct} color={hostMemPct > 90 ? C.red : C.green} />
          <div className="mt-3 grid grid-cols-2 gap-3">
            <KStat label="Active sessions" value={fmtNum(hs.active_sessions)} />
            <KStat label="Total sessions" value={fmtNum(hs.total_sessions)} />
            <KStat label="CPU count" value={hs.cpu_count || '—'} sub={hs.cpu_cores ? `${hs.cpu_cores} cores` : undefined} />
            <KStat label="Database CPU share" value={hs.db_cpu_pct != null ? `${hs.db_cpu_pct}%` : '—'} />
          </div>
        </RSection>
      </div>

      {/* ══ 3 · MEMORY ══ */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <RSection title="SGA" icon={MemoryStick} color={C.teal} className="!mb-0">
          <RTable
            headers={['Pool', 'Size (MB)', 'Share']}
            rows={sgaPools.map((p) => {
              const total = sgaPools.reduce((a, x) => a + num(x.mb), 0);
              return [
                <span className="font-semibold text-slate-800">{p.pool}</span>,
                fmtNum(p.mb),
                total ? `${Math.round((num(p.mb) / total) * 100)}%` : '—',
              ];
            })}
            emptyMsg="v$sgastat could not be read"
          />
          {sga.data?.total_mb != null && (
            <p className="mt-2 text-[11px] text-slate-400">
              Total allocated: <b className="text-slate-700">{fmtNum(sga.data.total_mb)} MB</b>
            </p>
          )}
        </RSection>

        <RSection title="PGA" icon={Cpu} color={C.indigo} className="!mb-0">
          <div className="grid grid-cols-2 gap-3">
            <KStat label="Allocated" value={`${fmtNum(pgaSummary.total_allocated_mb)} MB`} />
            <KStat label="Aggregate target" value={`${fmtNum(pgaSummary.aggregate_target_mb)} MB`} />
            <KStat label="Cache hit" value={pgaSummary.cache_hit_pct != null ? `${pgaSummary.cache_hit_pct}%` : '—'}
              color={num(pgaSummary.cache_hit_pct) > 0 && num(pgaSummary.cache_hit_pct) < 90 ? C.amber : C.green}
              sub="sorts done in memory" />
            <KStat label="Work areas active" value={pgaSummary.work_areas_active ?? '—'} />
          </div>
          <p className="mt-3 text-[11px] text-slate-400">
            A PGA cache-hit rate below 90% means sorts and hash joins are spilling to temporary
            tablespace — raise <span className="font-mono">pga_aggregate_target</span> before tuning
            the individual statements.
          </p>
        </RSection>
      </div>

      {/* ══ 4 · RMAN BACKUPS ══ */}
      <RSection title="RMAN Backups" icon={Archive} color={rmanFailed > 0 ? C.red : C.green} pageBreak>
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <KStat label="Jobs recorded" value={rman.data?.total ?? 0} />
          <KStat label="Failed or with warnings" value={rmanFailed}
            color={rmanFailed ? C.red : C.green} />
          <KStat label="Running now" value={(rman.data?.running || []).length}
            color={(rman.data?.running || []).length ? C.blue : undefined} />
          <KStat label="Last full database backup"
            value={lastDbBackup?.end_time ? String(lastDbBackup.end_time).slice(0, 16) : '—'}
            color={lastDbBackup ? C.green : C.red}
            sub={lastDbBackup ? `${lastDbBackup.output_gb} GB in ${lastDbBackup.hrs}h` : 'none found'} />
        </div>
        <RTable
          headers={['Type', 'Status', 'Started', 'Duration', 'Input', 'Output', 'Throughput', 'Device']}
          rows={rmanJobs.slice(0, 20).map((j) => [
            <span className="font-semibold text-slate-800">{j.input_type}</span>,
            statusBadge(j.status),
            String(j.start_time || '').slice(0, 16),
            j.hrs != null ? `${j.hrs}h` : '—',
            `${j.input_gb} GB`,
            `${j.output_gb} GB`,
            j.mb_per_sec ? `${j.mb_per_sec} MB/s` : '—',
            j.output_device_type || '—',
          ])}
          emptyMsg="v$rman_backup_job_details has no rows — RMAN may never have run, or msdb-equivalent views are not readable"
        />
        {!lastDbBackup && (
          <p className="mt-2 text-[11px] text-red-600">
            No full database backup is recorded. Without one there is no recovery point at all.
          </p>
        )}
      </RSection>

      {/* ══ 5 · ARCHIVE LOG / DR ══ */}
      <RSection title="Archive Log and DR Gap" icon={Radio} color={maxGap > 5 ? C.red : C.green}>
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <KStat label="Log mode" value={archMode} color={archMode === 'ARCHIVELOG' ? C.green : C.red} />
          <KStat label="Largest standby gap" value={maxGap} color={maxGap > 5 ? C.red : C.green}
            sub="logs not yet applied" />
          <KStat label="Destinations" value={drGap.length} />
          <KStat label="Logs in the last 24h"
            value={fmtNum(hourlyArchive.reduce((a, h) => a + num(h.logs), 0))}
            sub={`${fmtNum(hourlyArchive.reduce((a, h) => a + num(h.mb), 0))} MB`} />
        </div>
        <RTable
          headers={['Destination', 'Target', 'Status', 'Archived', 'Applied', 'Gap', 'Standby name']}
          rows={drGap.map((g) => [
            <span className="font-mono text-[11px]">{g.dest_name}</span>,
            g.target || '—',
            statusBadge(g.status),
            <span className="font-mono">{g.log_archived}</span>,
            <span className="font-mono">{g.log_applied}</span>,
            <b style={{ color: num(g.log_gap) > 5 ? C.red : num(g.log_gap) > 0 ? C.amber : C.green }}>
              {g.log_gap}
            </b>,
            g.db_unique || '—',
          ])}
          emptyMsg="No active archive destination other than the local one"
        />
        {archMode !== 'ARCHIVELOG' && (
          <p className="mt-2 text-[11px] text-red-600">
            The database is in {archMode}. There is no archived redo, so no point-in-time recovery
            and no Data Guard is possible until it is switched to ARCHIVELOG.
          </p>
        )}
      </RSection>

      {/* ══ 6 · TABLESPACES ══ */}
      <RSection title={`Tablespaces (${tsRows.length})`} icon={HardDrive}
        color={maxTsPct > 90 ? C.red : maxTsPct > 80 ? C.amber : C.teal} pageBreak>
        <RTable
          headers={['Tablespace', 'Status', 'Type', 'Used %', 'Used (MB)', 'Free (MB)', 'Allocated (MB)']}
          rows={tsRows.slice(0, 30).map((t) => [
            <span className="font-bold text-slate-800">{t.tablespace_name}</span>,
            statusBadge(t.status),
            t.contents || '—',
            <b style={{ color: num(t.used_pct) > 90 ? C.red : num(t.used_pct) > 80 ? C.amber : C.green }}>
              {t.used_pct}%
            </b>,
            fmtNum(t.used_mb),
            fmtNum(t.free_mb),
            fmtNum(t.total_mb),
          ])}
          emptyMsg="dba_tablespace_usage_metrics could not be read"
        />
        {criticalTs.length > 0 && (
          <p className="mt-2 text-[11px] text-red-600">
            {criticalTs.map((t) => `${t.tablespace_name} ${t.used_pct}%`).join(', ')} — a tablespace
            that reaches 100% stops accepting writes.
          </p>
        )}
      </RSection>

      {/* ══ 7 · INVALID OBJECTS ══ */}
      <RSection title={`Invalid Objects (${invalidTotal})`} icon={AlertOctagon}
        color={invalidTotal ? C.amber : C.green}>
        {invalidTotal === 0 ? (
          <p className="text-sm font-semibold text-emerald-600">
            Every object in the user schemas is valid.
          </p>
        ) : (
          <>
            <div className="mb-3 flex flex-wrap gap-2">
              {invalidByType.slice(0, 10).map((t) => (
                <span key={t.type}
                  className="rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[11px] font-bold text-amber-700">
                  {t.type} × {t.count}
                </span>
              ))}
            </div>
            <RTable
              headers={['Owner', 'Type', 'Object', 'Last DDL', 'Created']}
              rows={invalidObjects.slice(0, 25).map((o) => [
                <span className="font-mono text-[11px]">{o.owner}</span>,
                o.object_type,
                <span className="font-semibold text-slate-800">{o.object_name}</span>,
                String(o.last_ddl || '').slice(0, 16),
                String(o.created || '').slice(0, 16),
              ])}
            />
            <p className="mt-2 text-[11px] text-slate-400">
              An INVALID object raises an error the first time something calls it. Recompile with
              {' '}<span className="font-mono">UTL_RECOMP.RECOMP_PARALLEL</span>, or individually.
            </p>
          </>
        )}
      </RSection>

      {/* ══ 8 · HOST / SAR ══ */}
      <RSection title="Host Activity" icon={Cpu} color={C.cyan} pageBreak>
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <KStat label="Host CPU" value={hostCpuPct ? `${hostCpuPct}%` : '—'}
            color={hostCpuPct > 85 ? C.red : C.green} />
          <KStat label="Host memory used" value={hostMemPct ? `${hostMemPct}%` : '—'}
            color={hostMemPct > 90 ? C.red : C.green} />
          <KStat label="Physical memory" value={sar.data?.phys_gb ? `${sar.data.phys_gb} GB` : '—'}
            sub={sar.data?.free_gb != null ? `${sar.data.free_gb} GB free` : undefined} />
          <KStat label="Load average" value={sar.data?.load != null ? Number(sar.data.load).toFixed(2) : '—'} />
        </div>
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <div>
            <p className="mb-1.5 text-[11px] font-bold tracking-wide text-slate-400 uppercase">
              Sessions using the most CPU
            </p>
            <RTable
              headers={['SID', 'User', 'Program', 'CPU used', 'Share']}
              rows={topCpu.slice(0, 10).map((s) => [
                <span className="font-mono">{s.sid}</span>,
                s.username || '—',
                <span className="block max-w-[180px] truncate text-[11px]">{s.program}</span>,
                fmtNum(s.cpu_used),
                `${s.cpu_pct}%`,
              ])}
              emptyMsg="v$sesstat could not be read"
            />
          </div>
          <div>
            <p className="mb-1.5 text-[11px] font-bold tracking-wide text-slate-400 uppercase">
              Sessions doing the most physical I/O
            </p>
            <RTable
              headers={['SID', 'User', 'Program', 'Physical reads', 'Block gets']}
              rows={topIo.slice(0, 10).map((s) => [
                <span className="font-mono">{s.sid}</span>,
                s.username || '—',
                <span className="block max-w-[180px] truncate text-[11px]">{s.program}</span>,
                fmtNum(s.physical_reads),
                fmtNum(s.block_gets),
              ])}
              emptyMsg="No session has done physical reads"
            />
          </div>
        </div>
      </RSection>

      {/* ══ 9 · DATA FILES ══ */}
      <RSection title="Data Files and Mount Points" icon={Layers} color={C.slate}>
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <KStat label="Data files" value={dataFileRows.length} />
          <KStat label="Temp files" value={(datafiles.data?.tempfiles || []).length} />
          <KStat label="Mount points" value={mounts.length} />
          <KStat label="Autoextensible"
            value={dataFileRows.filter((f) => f.autoextend === 'YES').length}
            sub={`of ${dataFileRows.length}`} />
        </div>
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <div>
            <p className="mb-1.5 text-[11px] font-bold tracking-wide text-slate-400 uppercase">
              By mount point
            </p>
            <RTable
              headers={['Mount', 'Files', 'Total (GB)']}
              rows={mounts.map((m) => [
                <span className="font-mono text-[11px]">{m.mount}</span>,
                m.files,
                Number(m.total_gb).toFixed(2),
              ])}
              emptyMsg="No mount point could be derived from the file paths"
            />
          </div>
          <div>
            <p className="mb-1.5 text-[11px] font-bold tracking-wide text-slate-400 uppercase">
              Largest data files
            </p>
            <RTable
              headers={['Tablespace', 'File', 'Size (GB)', 'Autoextend', 'Max (GB)']}
              rows={[...dataFileRows].sort((a, b) => num(b.size_gb) - num(a.size_gb)).slice(0, 12)
                .map((f) => [
                  f.tablespace,
                  <span className="block max-w-[220px] truncate font-mono text-[10px]">{f.file_name}</span>,
                  Number(f.size_gb).toFixed(2),
                  f.autoextend === 'YES' ? 'Yes' : 'No',
                  f.autoextend === 'YES' ? Number(f.max_gb).toFixed(1) : '—',
                ])}
              emptyMsg="dba_data_files could not be read"
            />
          </div>
        </div>
      </RSection>

      {/* ══ 10 · TOP SQL ══ */}
      <RSection title="Top SQL by Elapsed Time" icon={Zap} color={C.orange} pageBreak>
        <RTable
          headers={['SQL ID', 'Statement', 'Schema', 'Executions', 'Avg elapsed (ms)', 'Total (ms)', 'Buffer gets', 'Disk reads']}
          rows={sqlRows.slice(0, 20).map((s) => [
            <span className="font-mono text-[10px]">{s.sql_id}</span>,
            <span className="block max-w-[300px] truncate font-mono text-[11px]">
              {String(s.sql_text || '').replace(/\s+/g, ' ').slice(0, 110)}
            </span>,
            s.parsing_schema_name || '—',
            fmtNum(s.executions),
            fmtNum(s.avg_elapsed_ms),
            fmtNum(s.elapsed_ms),
            fmtNum(s.buffer_gets),
            fmtNum(s.disk_reads),
          ])}
          emptyMsg="v$sql has no statement with an execution"
        />
      </RSection>

      {/* ══ 11 · WAITS + SESSIONS ══ */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <RSection title="Top Wait Events" icon={Clock} color={C.red} className="!mb-0">
          <RTable
            headers={['Event', 'Class', 'Waits', 'Time (s)', 'Avg (ms)', 'What it means']}
            rows={busyWaits.slice(0, 12).map((w) => [
              <span className="font-mono text-[11px]">{w.event}</span>,
              w.wait_class || '—',
              fmtNum(w.total_waits),
              fmtNum(Math.round(num(w.time_waited_seconds))),
              w.avg_wait_ms,
              <span className="block max-w-[220px] text-[10px] leading-snug text-slate-500">
                {explainWait(w.event, w.wait_class).label}
              </span>,
            ])}
            emptyMsg="v$system_event has no non-idle wait"
          />
          {waitClasses.length > 0 && (
            <p className="mt-2 text-[11px] text-slate-400">
              By class: {waitClasses.slice(0, 5).map((c) => `${c.wait_class} ${fmtNum(Math.round(num(c.time_seconds)))}s`).join(' · ')}
            </p>
          )}
        </RSection>

        <RSection title="Sessions" icon={Users} color={C.indigo} className="!mb-0">
          <div className="mb-3 grid grid-cols-3 gap-3">
            <KStat label="Total" value={sessionSummary.total ?? sessionRows.length} />
            <KStat label="Active" value={sessionSummary.active ?? '—'} color={C.green} />
            <KStat label="Blocked" value={sessionSummary.blocking ?? '—'}
              color={num(sessionSummary.blocking) ? C.red : C.green} />
          </div>
          <RTable
            headers={['Status', 'Count']}
            rows={Object.entries(sessionCounts).length
              ? Object.entries(sessionCounts).map(([k, v]) => [statusBadge(k), v])
              : [
                ['ACTIVE', sessionSummary.active],
                ['INACTIVE', sessionSummary.inactive],
                ['USER', sessionSummary.user],
                ['BACKGROUND', sessionSummary.background],
              ].filter(([, v]) => v != null).map(([k, v]) => [statusBadge(k), v])}
            emptyMsg="v$session could not be read"
          />
        </RSection>
      </div>

      {/* ══ 12 · LIVE QUERIES ══ */}
      <RSection title={`Live Sessions (${liveRows.length})`} icon={Activity} color={C.green}>
        <RTable
          headers={['SID', 'User', 'Status', 'Client', 'Waiting on', 'For (s)', 'Statement']}
          rows={liveRows.slice(0, 20).map((r) => [
            <span className="font-mono">{r.sid}</span>,
            r.username || '—',
            statusBadge(r.status),
            <span className="block max-w-[140px] truncate text-[11px]">{r.machine}</span>,
            <span className="font-mono text-[10px]">{r.wait_event || 'on CPU'}</span>,
            fmtNum(r.seconds_in_wait),
            <span className="block max-w-[240px] truncate font-mono text-[10px]">
              {String(r.sql_text || '').replace(/\s+/g, ' ').slice(0, 90)}
            </span>,
          ])}
          emptyMsg="No user session is connected"
        />
      </RSection>

      {/* ══ 13 · LOCKS ══ */}
      <RSection title={`Lock Waits (${lockRows.length})`} icon={Lock}
        color={lockRows.length ? C.red : C.green}>
        {lockRows.length === 0 ? (
          <p className="flex items-center gap-2 text-sm font-semibold text-emerald-600">
            <Shield size={15} /> No session is waiting for a lock another session holds
          </p>
        ) : (
          <RTable
            headers={['Waiting SID', 'Waiter', 'Held by SID', 'Holder', 'Waiting (s)', 'Lock', 'Blocked statement']}
            rows={lockRows.slice(0, 15).map((l) => [
              <span className="font-mono">{l.waiter_sid}</span>,
              l.waiter_user || '—',
              <b className="font-mono text-red-600">{l.holder_sid}</b>,
              l.holder_user || '—',
              fmtNum(l.seconds_in_wait),
              l.lock_type,
              <span className="block max-w-[220px] truncate font-mono text-[10px]">{l.waiter_sql}</span>,
            ])}
          />
        )}
        {enqueueRows.length > 0 && (
          <>
            <p className="mt-4 mb-1.5 text-[11px] font-bold tracking-wide text-slate-400 uppercase">
              Cumulative enqueue waits since startup
            </p>
            <RTable
              headers={['Type', 'Requests', 'Waits', 'Failed', 'Cumulative wait (s)']}
              rows={enqueueRows.slice(0, 10).map((e) => [
                <span className="font-mono font-bold">{e.eq_type}</span>,
                fmtNum(e.total_req),
                fmtNum(e.total_wait),
                fmtNum(e.failed_req),
                fmtNum(e.cum_wait_sec),
              ])}
            />
          </>
        )}
      </RSection>

      {/* ══ 14 · REDO + DATA GUARD ══ */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <RSection title="Redo Log Groups" icon={RotateCcw} color={C.blue} className="!mb-0">
          <RTable
            headers={['Group', 'Thread', 'Sequence', 'Members', 'Size (MB)', 'Status', 'Archived']}
            rows={redoGroups.map((g) => [
              <span className="font-mono font-bold">{g.group}</span>,
              g.thread,
              /* A log sequence is an identifier — abbreviating 90215 to "90.2K"
                 makes it useless in a RECOVER command. */
              <span className="font-mono">{g.sequence}</span>,
              <b style={{ color: num(g.members) < 2 ? C.amber : undefined }}>{g.members}</b>,
              fmtNum(g.size_mb),
              statusBadge(g.status),
              g.archived || '—',
            ])}
            emptyMsg="v$log could not be read"
          />
          {singleMemberGroups.length > 0 && (
            <p className="mt-2 text-[11px] text-amber-600">
              {singleMemberGroups.length} group{singleMemberGroups.length === 1 ? ' has' : 's have'} a
              single member — losing that one file loses the group.
            </p>
          )}
        </RSection>

        <RSection title="Data Guard" icon={Shield}
          color={dataGuard.data?.configured ? C.purple : C.slate} className="!mb-0">
          {dataGuard.data?.configured ? (
            <>
              <RTable
                headers={['Destination', 'Target', 'Status', 'Synchronisation', 'Applied SCN']}
                rows={archiveDests.map((a) => [
                  <span className="font-mono text-[11px]">{a.dest_name}</span>,
                  a.target || '—',
                  statusBadge(a.status),
                  a.synchronization_status || '—',
                  <span className="font-mono text-[11px]">{a.applied_scn || '—'}</span>,
                ])}
                emptyMsg="No archive destination reported"
              />
              {standbyLogs.length > 0 && (
                <>
                  <p className="mt-3 mb-1.5 text-[11px] font-bold tracking-wide text-slate-400 uppercase">
                    Standby redo logs
                  </p>
                  <RTable
                    headers={['Group', 'Thread', 'Sequence', 'Size (MB)', 'Status']}
                    rows={standbyLogs.map((s) => [
                      <span className="font-mono">{s.group}</span>,
                      s.thread,
                      <span className="font-mono">{s.sequence}</span>,
                      fmtNum(s.size_mb),
                      statusBadge(s.status),
                    ])}
                  />
                </>
              )}
              {dgMessages.filter((m) => /error|fatal/i.test(m.severity || '')).length > 0 && (
                <p className="mt-2 text-[11px] text-red-600">
                  {dgMessages.filter((m) => /error|fatal/i.test(m.severity || '')).length} error
                  message{dgMessages.filter((m) => /error|fatal/i.test(m.severity || '')).length === 1 ? '' : 's'}
                  {' '}in v$dataguard_status — the most recent:
                  {' '}{dgMessages.find((m) => /error|fatal/i.test(m.severity || ''))?.message}
                </p>
              )}
            </>
          ) : (
            <p className="text-sm text-slate-500">
              No standby destination and no standby redo log — Data Guard is not configured, so
              there is no failover target for this database.
            </p>
          )}
        </RSection>
      </div>

      {/* ══ 15 · BACKGROUND PROCESSES ══ */}
      <RSection title="Background Processes" icon={Server} color={C.slate} pageBreak>
        <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <KStat label="Processes" value={processes.data?.total ?? procRows.length} />
          <KStat label="PGA allocated"
            value={processes.data?.total_pga_mb != null ? `${fmtNum(processes.data.total_pga_mb)} MB` : '—'} />
          <KStat label="Largest single process"
            value={procRows.length ? `${fmtNum(Math.max(...procRows.map((p) => num(p.pga_alloc_mb))))} MB` : '—'} />
        </div>
        <RTable
          headers={['Process', 'Role', 'OS PID', 'PGA used (MB)', 'PGA allocated (MB)', 'PGA peak (MB)']}
          rows={procRows.slice(0, 20).map((p) => [
            <span className="font-mono font-bold">{p.pname}</span>,
            <span className="block max-w-[260px] truncate text-[11px]">{p.description}</span>,
            <span className="font-mono text-[11px]">{p.spid}</span>,
            fmtNum(p.pga_used_mb),
            fmtNum(p.pga_alloc_mb),
            fmtNum(p.pga_max_mb),
          ])}
          emptyMsg="v$bgprocess could not be read"
        />
      </RSection>

      {/* ══ 16 · SYSTEM STATISTICS ══ */}
      <RSection title="System Statistics" icon={BarChart2} color={C.slate}>
        {Object.keys(keyStats).length === 0 ? (
          <p className="text-sm text-slate-400">
            v$sysstat could not be read{sysStats.data?.error ? `: ${sysStats.data.error}` : ''}.
          </p>
        ) : (
          <>
            <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {['physical reads', 'physical writes', 'user commits', 'user rollbacks'].map((k) => (
                <KStat key={k} label={k} value={fmtNum(keyStats[k])} />
              ))}
            </div>
            <RTable
              headers={['Statistic', 'Value']}
              rows={Object.entries(keyStats).map(([k, v]) => [
                <span className="text-slate-700">{k}</span>, fmtNum(v),
              ])}
            />
            <p className="mt-2 text-[11px] text-slate-400">
              Counters since instance startup, not rates — compare two reports to get a rate.
            </p>
          </>
        )}
      </RSection>

      {/* ══ 17 · EBS, only for an E-Business Suite database ══ */}
      {(ebsWf.data?.is_ebs || ebsConc.data?.is_ebs) && (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <RSection title={`EBS Workflow (${ebsWf.data?.total_stuck ?? 0} stuck)`} icon={Activity}
            color={num(ebsWf.data?.total_stuck) ? C.red : C.green} className="!mb-0">
            <RTable
              headers={['Item type', 'Item key', 'Status', 'Stuck since', 'Days']}
              rows={(ebsWf.data?.stuck || []).slice(0, 15).map((w) => [
                <span className="font-mono text-[11px]">{w.item_type}</span>,
                <span className="block max-w-[140px] truncate font-mono text-[10px]">{w.item_key}</span>,
                statusBadge(w.status),
                String(w.begin_date || '').slice(0, 16),
                <b style={{ color: num(w.days_stuck) > 7 ? C.red : C.amber }}>{w.days_stuck}</b>,
              ])}
              emptyMsg="No workflow activity has been stuck for more than an hour"
            />
          </RSection>

          <RSection title="Concurrent Managers" icon={Server} color={C.cyan} className="!mb-0">
            <RTable
              headers={['Manager', 'Enabled', 'Running', 'Target', 'Description']}
              rows={(ebsConc.data?.managers || []).slice(0, 15).map((m) => [
                <span className="font-semibold text-slate-800">{m.display || m.name}</span>,
                m.enabled === 'Y' ? 'Yes' : 'No',
                <b style={{ color: num(m.running) < num(m.min) ? C.red : undefined }}>{m.running}</b>,
                `${m.min}–${m.max}`,
                <span className="block max-w-[200px] truncate text-[11px]">{m.description}</span>,
              ])}
              emptyMsg="No concurrent manager found"
            />
            {(ebsConc.data?.running_requests || []).length > 0 && (
              <p className="mt-2 text-[11px] text-slate-400">
                {ebsConc.data.running_requests.length} request
                {ebsConc.data.running_requests.length === 1 ? '' : 's'} running; longest{' '}
                {Math.max(...ebsConc.data.running_requests.map((r) => num(r.running_mins)))} minutes.
              </p>
            )}
          </RSection>
        </div>
      )}
    </ReportShell>
  );
}
