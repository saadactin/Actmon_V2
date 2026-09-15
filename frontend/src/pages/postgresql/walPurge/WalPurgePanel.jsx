import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Clock, HardDrive, FileText, Shield, Server, CalendarClock, CheckCircle2, Loader2 } from 'lucide-react';
import cn from '@/lib/cn';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import CopyButton from '@/components/ui/CopyButton';
import Notice from '@/components/ui/Notice';
import { Field, Select, Switch } from '@/components/ui/Field';
import Input from '@/components/ui/Input';
import { Paged } from '@/components/ui/Pagination';
import { PageLoading } from '@/components/ui/Loading';
import { errorText } from '@/api/client';
import { fullTime } from '@/lib/format';
import KpiTile from '@/pages/_shared/engineKpi';
import { usePermissions } from '@/hooks/usePermissions';
import PurgeConfirmDialog from './PurgeConfirmDialog';
import {
  useWalArchiveInfo, useWalPurgeSafety, useWalPurgeConfig, useWalPurgeHistory,
  useSaveWalPurgeConfig, usePreviewWalPurge, useTestWalPurge, useExecuteWalPurge,
  useWalPurgeRunStatus, invalidateWalPurge,
  useScheduleWalPurge, useDisableWalPurgeSchedule,
} from './walPurgeApi';
import useCriticalOperationGuard from '@/hooks/useCriticalOperationGuard';

const RETENTION_PRESETS = [
  { id: '1d', label: '1 day', days: 1 }, { id: '3d', label: '3 days', days: 3 },
  { id: '7d', label: '7 days', days: 7 }, { id: '14d', label: '14 days', days: 14 },
  { id: '30d', label: '30 days', days: 30 }, { id: 'custom', label: 'Custom' },
];
const FREQUENCIES = [
  { id: 'daily', label: 'Daily' }, { id: 'weekly', label: 'Weekly' }, { id: 'monthly', label: 'Monthly' },
];
const DOW = [
  { id: '0', label: 'Sunday' }, { id: '1', label: 'Monday' }, { id: '2', label: 'Tuesday' },
  { id: '3', label: 'Wednesday' }, { id: '4', label: 'Thursday' }, { id: '5', label: 'Friday' },
  { id: '6', label: 'Saturday' },
];

const SAFETY_TONE = { SAFE: 'success', WARNING: 'warning', CRITICAL: 'danger' };
const ARCHIVE_STATUS_LABEL = {
  ok: 'OK', not_configured: 'Not configured yet', unreachable: 'Unreachable',
  mismatch: 'Path mismatch', too_large_to_scan: 'Too large to scan',
};
const ARCHIVE_STATUS_COLOR = {
  ok: '#22C55E', not_configured: '#64748B', unreachable: '#EF4444',
  mismatch: '#EF4444', too_large_to_scan: '#F97316',
};
const STATUS_TONE = {
  success: 'success', failed: 'danger', blocked: 'warning', missed: 'warning',
  running: 'info', skipped: 'neutral',
};
// One distinct accent per retention preset — a longer window is stricter
// (fewer/no files old enough yet), so the palette runs cool→warm as the
// window shortens, matching how much more it would actually reclaim.
const RETENTION_PREVIEW_COLORS = { 1: '#EF4444', 3: '#F97316', 7: '#EAB308', 14: '#22C55E', 30: '#3B82F6' };

// Always shown in IST (see lib/format.js's fullTime) — every purge run's
// wall-clock time is meaningful to the DBA operating it, and everyone
// looking at this screen should see the same time regardless of their own
// browser's timezone.
const fmtDateTime = fullTime;

export default function WalPurgePanel({ connId, onBack }) {
  const { canHere } = usePermissions();
  const canEdit = canHere('edit');
  const qc = useQueryClient();

  const { data: info, isLoading: infoLoading, refetch: refetchInfo } = useWalArchiveInfo(connId);
  const { data: safety, isLoading: safetyLoading, refetch: refetchSafety } = useWalPurgeSafety(connId);
  const { data: config, isLoading: configLoading, refetch: refetchConfig } = useWalPurgeConfig(connId);
  const [historyPage, setHistoryPage] = useState({ limit: 20, offset: 0 });
  const { data: history } = useWalPurgeHistory(connId, historyPage);

  const saveMutation = useSaveWalPurgeConfig(connId);
  const previewMutation = usePreviewWalPurge(connId);
  const testMutation = useTestWalPurge(connId);
  const executeMutation = useExecuteWalPurge(connId);
  const scheduleMutation = useScheduleWalPurge(connId);
  const disableMutation = useDisableWalPurgeSchedule(connId);

  const [form, setForm] = useState(null);
  const [previewResult, setPreviewResult] = useState(null);
  const [testResult, setTestResult] = useState(null);
  const [runId, setRunId] = useState(null); // the currently-tracked live purge run, if any
  const [confirmMode, setConfirmMode] = useState(null); // 'execute' | 'schedule'
  // Which button (if any) triggered the current auto-save-before-acting —
  // NOT just "is a save happening", since a plain manual click on Save
  // Configuration was making every OTHER button (Test/Preview/Schedule/Purge
  // Now) light up as loading too, as they all shared the same bare
  // `saveMutation.isPending` check with no way to tell which one asked for it.
  const [pendingAction, setPendingAction] = useState(null); // 'test' | 'preview' | 'schedule' | 'execute' | null

  const runStatus = useWalPurgeRunStatus(connId, runId);
  const purgeRunning = runId != null && runStatus.data?.run_status !== 'success' && runStatus.data?.run_status !== 'failed';

  // The run just finished (success or failed) — refresh everything the run
  // affects (archive info/safety/config/history) exactly once, right here,
  // instead of on every poll tick.
  useEffect(() => {
    const status = runStatus.data?.run_status;
    if (runId && status && status !== 'running') {
      invalidateWalPurge(qc, connId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runStatus.data?.run_status]);

  // Guards against losing track of a purge mid-flight: blocks a hard
  // refresh/tab close outright, and asks for confirmation before leaving
  // the page via in-app navigation (back link, top nav) — a purge keeps
  // running server-side regardless, but walking away from the live view
  // means losing the one place that shows real progress while it happens.
  const { confirmLeave } = useCriticalOperationGuard(
    purgeRunning || testMutation.isPending || scheduleMutation.isPending,
    'A WAL purge is still in progress. Leaving this page will not stop it, but you\'ll lose the live progress view.',
  );

  const f = form || (config?.exists ? config : {
    archive_dir: config?.archive_dir || '', cleanup_binary: config?.cleanup_binary || 'pg_archivecleanup',
    cleanup_method: 'pg_archivecleanup',
    retention_preset: '7d', retention_days: 7, require_standby_ok: true, max_standby_lag_mb: 1024,
    frequency: 'daily', hour: 2, minute: 30, day_of_week: 0, day_of_month: 1,
    callback_base_url: '', missed_grace_minutes: 15,
  });
  const setF = (patch) => setForm({ ...f, ...patch });

  if (infoLoading && !info) return <PageLoading title="Loading WAL archive information…" illustration={false} />;

  const archive = info?.archive || {};
  const agent = info?.agent || {};
  const schedulerLabel = agent.scheduler === 'schtasks' ? 'Windows Task Scheduler' : agent.scheduler === 'cron' ? 'cron' : '—';

  const buildSavePayload = () => ({
    ...f,
    retention_days: f.retention_preset === 'custom' ? Number(f.retention_days) :
      RETENTION_PRESETS.find((p) => p.id === f.retention_preset)?.days || f.retention_days,
  });

  const handleSave = () => {
    saveMutation.mutate(buildSavePayload(), { onSuccess: () => setForm(null) });
  };

  // Test/Preview/Schedule/Purge Now all act on whatever config is currently
  // SAVED in the database, not on whatever's sitting in the form — so an
  // edited-but-unsaved field (e.g. a new Execution Time) would otherwise be
  // silently ignored, installing a schedule (or running a test) against the
  // stale prior value. Save first whenever the form has unsaved edits, then
  // run the actual action against what's now actually persisted.
  const withSavedConfig = (key, action) => {
    if (form) {
      setPendingAction(key);
      saveMutation.mutate(buildSavePayload(), {
        onSuccess: () => { setForm(null); action(); },
        onSettled: () => setPendingAction(null),
      });
    } else {
      action();
    }
  };

  const refreshAll = () => { refetchInfo(); refetchSafety(); refetchConfig(); };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <button type="button" onClick={() => { if (confirmLeave()) onBack(); }}
          className="flex items-center gap-1.5 text-[12px] font-semibold text-muted hover:text-fg">
          <ArrowLeft size={14} /> Back to Configuration
        </button>
        <div className="flex items-center gap-2">
          {safety && <Badge tone={SAFETY_TONE[safety.safety_state] || 'neutral'}>{safety.safety_state}</Badge>}
          <Button size="sm" variant="secondary" icon="refresh" onClick={refreshAll}>Refresh</Button>
        </div>
      </div>

      <h2 className="text-[16px] font-black text-fg">Purge WAL Archive</h2>

      {/* ── WAL Archive info ── */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <KpiTile icon={HardDrive} title="Archive Size" value={archive.size_pretty || '—'} accent="#F97316" />
        <KpiTile icon={FileText} title="WAL Files" value={archive.segment_count ?? '—'} accent="#3B82F6" />
        <KpiTile icon={Clock} title="Oldest Archived WAL" value={archive.oldest_wal || '—'} accent="#8B5CF6" />
        <KpiTile icon={Clock} title="Latest Archived WAL" value={archive.latest_wal || '—'} accent="#06B6D4" />
        <KpiTile icon={Shield} title="Archive Status" value={ARCHIVE_STATUS_LABEL[archive.status] || archive.status || '—'}
          accent={ARCHIVE_STATUS_COLOR[archive.status] || '#64748B'} />
        <KpiTile icon={Server} title="Agent" value={agent.hostname || 'No agent'} sub={agent.os_type} accent="#64748B" />
      </div>

      <div className="grid grid-cols-1 gap-3 rounded-card border border-border bg-surface p-3 text-[12px] sm:grid-cols-2">
        <Detail label="Instance" value={`${info?.instance?.name || ''} · ${info?.instance?.host}:${info?.instance?.port}`} />
        <Detail label="Archive Path" value={archive.archive_dir || '(not configured)'} mono copy={archive.archive_dir} />
        <Detail label="archive_mode / archive_command" value={`${archive.archive_mode || '—'} · ${archive.archive_command || '—'}`} mono />
        <Detail label="Archiver failures" value={String(archive.failed_count ?? 0)} />
      </div>

      {/* ── Safety ── */}
      <div className="rounded-card border border-border bg-surface p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-[13px] font-bold text-fg">Safety</h3>
          {safety && <Badge tone={SAFETY_TONE[safety.safety_state]}>{safety.safety_state}</Badge>}
        </div>
        {safetyLoading && !safety ? <p className="text-[12px] text-subtle">Computing…</p> : safety && (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <SafetyStat label="Safe WAL Purge Boundary" value={safety.safe_boundary_wal} />
              <SafetyStat label="Oldest Required WAL" value={safety.oldest_required_wal} />
              <SafetyStat label="Estimated Space Reclaimable"
                value={`${safety.space_reclaimable_pretty} (${safety.files_to_purge} files)`} mono={false} />
            </div>
            {safety.blocking_reasons?.map((r, i) => (
              <Notice key={`b${i}`} tone="danger" className="mt-3">{r.message}</Notice>
            ))}
            {safety.warnings?.map((w, i) => (
              <Notice key={`w${i}`} tone="warning" className="mt-3">{w.message}</Notice>
            ))}
            {(safety.slots?.length > 0 || safety.standbys?.length > 0) && (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className="text-left text-subtle">
                      <th className="pb-1 pr-3">Slot / Standby</th><th className="pb-1 pr-3">Active</th>
                      <th className="pb-1 pr-3">WAL Status</th><th className="pb-1">Lag (MB)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(safety.slots || []).map((s) => (
                      <tr key={s.slot_name} className="border-t border-border">
                        <td className="py-1 pr-3 font-mono">{s.slot_name}</td>
                        <td className="py-1 pr-3">{s.active ? 'yes' : 'no'}</td>
                        <td className="py-1 pr-3">{s.wal_status || '—'}</td>
                        <td className="py-1">{s.lag_mb ?? '—'}</td>
                      </tr>
                    ))}
                    {(safety.standbys || []).map((sb, i) => (
                      <tr key={`sb${i}`} className="border-t border-border">
                        <td className="py-1 pr-3 font-mono">{sb.application_name}</td>
                        <td className="py-1 pr-3">—</td><td className="py-1 pr-3">{sb.sync_state || '—'}</td>
                        <td className="py-1">{sb.lag_mb ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Retention preview: what each window would reclaim, right now ── */}
      {safety?.retention_preview?.length > 0 && (
        <div className="rounded-card border border-border bg-surface p-4">
          <h3 className="mb-1 text-[13px] font-bold text-fg">Retention Preview</h3>
          <p className="mb-3 text-[11px] text-subtle">
            For each retention window: how many files (and how much space) would be purged right now, versus how
            many would still remain afterward. Together they always add up to the full archive
            ({archive.segment_count ?? 0} files, {archive.size_pretty || '—'}). Still respects replication safety,
            so a shorter window here never counts a file a standby/slot still needs.
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {safety.retention_preview.map((r) => {
              const isCurrent = config?.exists && Number(config.retention_days) === r.days;
              const color = RETENTION_PREVIEW_COLORS[r.days] || '#64748B';
              return (
                <div
                  key={r.days}
                  className={cn(
                    'flex flex-col gap-2.5 rounded-card border border-border bg-surface p-3',
                    isCurrent && 'ring-2 ring-accent ring-offset-2 ring-offset-surface',
                  )}
                >
                  <div className="flex items-center justify-between gap-1">
                    <span className="flex items-center gap-1.5">
                      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full"
                        style={{ background: `color-mix(in srgb, ${color} 16%, transparent)` }}>
                        <CalendarClock size={14} style={{ color }} />
                      </span>
                      <span className="text-[12px] font-bold text-fg">{r.days} Day{r.days === 1 ? '' : 's'}</span>
                    </span>
                    {isCurrent && (
                      <span className="rounded-full bg-inverse px-1.5 py-0.5 text-[9px] font-bold text-on-inverse">CURRENT</span>
                    )}
                  </div>

                  <div>
                    <p className="text-[10px] font-bold tracking-wide text-subtle uppercase">To purge</p>
                    <p className="text-[16px] leading-tight font-black text-fg">
                      {r.files_count} file{r.files_count === 1 ? '' : 's'}
                    </p>
                    <p className="text-[11px] text-muted">{r.space_pretty}</p>
                  </div>

                  <div className="border-t border-border pt-2">
                    <p className="text-[10px] font-bold tracking-wide text-subtle uppercase">Remaining after</p>
                    <p className="text-[14px] leading-tight font-bold text-fg">
                      {r.files_remaining} file{r.files_remaining === 1 ? '' : 's'}
                    </p>
                    <p className="text-[11px] text-muted">{r.space_remaining_pretty}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Purge Configuration ── */}
      <div className="rounded-card border border-border bg-surface p-4">
        <h3 className="mb-3 text-[13px] font-bold text-fg">Purge Configuration</h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Archive Path" hint={
            f.archive_dir && archive.archive_dir_detected ? 'Auto-detected from archive_command — edit if this is wrong.'
              : archive.suggested_archive_dir && archive.suggested_archive_dir !== f.archive_dir
                ? `archive_command suggests: ${archive.suggested_archive_dir}` : undefined
          }>
            <Input value={f.archive_dir || ''} disabled={!canEdit}
              onChange={(e) => setF({ archive_dir: e.target.value })} placeholder="/var/lib/pgsql/wal_archive" size="sm" />
          </Field>
          <Field label="pg_archivecleanup path" hint={
            !form && config?.cleanup_binary_detected ? 'Auto-detected next to the data directory — edit if this is wrong.' : undefined
          }>
            <Input value={f.cleanup_binary || ''} disabled={!canEdit}
              onChange={(e) => setF({ cleanup_binary: e.target.value })} placeholder="pg_archivecleanup" size="sm" />
          </Field>
          <Field label="Cleanup method">
            <Input value="pg_archivecleanup" disabled size="sm" />
          </Field>
          <Field label="Retention period">
            <Select value={f.retention_preset} onChange={(v) => {
              const preset = RETENTION_PRESETS.find((p) => p.id === v);
              setF({ retention_preset: v, retention_days: preset?.days ?? f.retention_days });
            }} options={RETENTION_PRESETS} disabled={!canEdit} />
          </Field>
          {f.retention_preset === 'custom' && (
            <Field label="Custom retention (days)">
              <Input type="number" value={f.retention_days} disabled={!canEdit}
                onChange={(e) => setF({ retention_days: e.target.value })} size="sm" />
            </Field>
          )}
          <Field label="Frequency">
            <Select value={f.frequency} onChange={(v) => setF({ frequency: v })} options={FREQUENCIES} disabled={!canEdit} />
          </Field>
          <Field label="Execution time">
            <div className="flex items-center gap-1.5">
              <Input type="number" min={0} max={23} value={f.hour} disabled={!canEdit}
                onChange={(e) => setF({ hour: e.target.value })} size="sm" wrapperClassName="w-16" />
              <span className="text-subtle">:</span>
              <Input type="number" min={0} max={59} value={f.minute} disabled={!canEdit}
                onChange={(e) => setF({ minute: e.target.value })} size="sm" wrapperClassName="w-16" />
            </div>
          </Field>
          {f.frequency === 'weekly' && (
            <Field label="Day of week">
              <Select value={String(f.day_of_week)} onChange={(v) => setF({ day_of_week: Number(v) })} options={DOW} disabled={!canEdit} />
            </Field>
          )}
          {f.frequency === 'monthly' && (
            <Field label="Day of month">
              <Input type="number" min={1} max={28} value={f.day_of_month} disabled={!canEdit}
                onChange={(e) => setF({ day_of_month: e.target.value })} size="sm" />
            </Field>
          )}
          <Field label="Require a healthy standby" inline>
            <Switch checked={!!f.require_standby_ok} onChange={(v) => setF({ require_standby_ok: v })} disabled={!canEdit} />
          </Field>
          <Field label="Max standby lag (MB)">
            <Input type="number" value={f.max_standby_lag_mb} disabled={!canEdit}
              onChange={(e) => setF({ max_standby_lag_mb: e.target.value })} size="sm" />
          </Field>
          <Field label="Callback URL (advanced)" hint="Auto-detected from the agent if left blank">
            <Input value={f.callback_base_url || ''} disabled={!canEdit}
              onChange={(e) => setF({ callback_base_url: e.target.value })} placeholder="https://actmon.example.com:8000" size="sm" />
          </Field>
        </div>
        {saveMutation.isError && <p className="mt-2 text-[12px] text-danger-fg">{errorText(saveMutation.error)}</p>}
      </div>

      {/* ── Scheduler (auto-detected, non-editable) ── */}
      <div className="rounded-card border border-border bg-surface p-4">
        <h3 className="mb-2 text-[13px] font-bold text-fg">Scheduler</h3>
        <p className="text-[12px] text-muted">
          Agent OS: <span className="font-semibold text-fg">{agent.os_type || '—'}</span>
          {' → '}Scheduler: <span className="font-semibold text-fg">{schedulerLabel}</span>
        </p>
        <div className="mt-2 flex items-center gap-2">
          <Badge tone={config?.enabled ? (config?.schedule_present ? 'success' : 'warning') : 'neutral'}>
            {config?.enabled ? (config?.schedule_present ? 'Entry present' : 'Entry MISSING on host') : 'Disabled'}
          </Badge>
          {config?.scheduler_entry_name && <span className="text-[11px] font-mono text-subtle">{config.scheduler_entry_name}</span>}
        </div>
        {scheduleMutation.data?.installed_command && (
          <div className="mt-2 flex items-center justify-between gap-2 rounded-control border border-border bg-sunken px-2.5 py-2">
            <code className="truncate text-[11px] text-fg">{scheduleMutation.data.installed_command}</code>
            <CopyButton text={scheduleMutation.data.installed_command} label="" />
          </div>
        )}
      </div>

      {/* ── Actions ── */}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" icon="play"
          loading={testMutation.isPending || (saveMutation.isPending && pendingAction === 'test')}
          onClick={() => withSavedConfig('test', () => testMutation.mutate(undefined, { onSuccess: setTestResult }))}>Test Purge</Button>
        <Button size="sm" variant="secondary" icon="eye"
          loading={previewMutation.isPending || (saveMutation.isPending && pendingAction === 'preview')}
          onClick={() => withSavedConfig('preview', () => previewMutation.mutate(undefined, { onSuccess: setPreviewResult }))}>Preview Purge</Button>
        {canEdit && (
          <>
            <Button size="sm" variant="primary" icon="save" loading={saveMutation.isPending && !pendingAction} onClick={handleSave}>
              Save Configuration
            </Button>
            <Button size="sm" variant="secondary" icon="calendar"
              loading={scheduleMutation.isPending || (saveMutation.isPending && pendingAction === 'schedule')}
              onClick={() => withSavedConfig('schedule', () => setConfirmMode('schedule'))}>
              Schedule Purge
            </Button>
            {config?.enabled && (
              <Button size="sm" variant="secondary" icon="close" loading={disableMutation.isPending}
                onClick={() => disableMutation.mutate()}>Disable Schedule</Button>
            )}
            <Button size="sm" variant="danger" icon="trash" className="ml-auto"
              loading={executeMutation.isPending || (saveMutation.isPending && pendingAction === 'execute')}
              disabled={!safety || safety.safety_state === 'CRITICAL'}
              onClick={() => withSavedConfig('execute', () => setConfirmMode('execute'))}>Purge Now</Button>
          </>
        )}
      </div>

      {(previewResult || testResult) && (
        <div className="rounded-card border border-border bg-surface p-4 text-[12px]">
          <h3 className="mb-2 text-[13px] font-bold text-fg">
            {testResult ? 'Test Purge result' : 'Preview result'}
          </h3>
          {testResult && (
            <div className="space-y-1">
              <p>Binary exit code: <span className="font-mono">{testResult.exit_code}</span> ({testResult.binary_ok ? 'ok' : 'failed'})</p>
              <p>Would remove {testResult.would_delete_count} file(s), estimate was {testResult.estimate_count}.</p>
              {testResult.stdout_tail && <pre className="mt-1 max-h-40 overflow-auto rounded-control bg-sunken p-2 text-[10.5px]">{testResult.stdout_tail}</pre>}
            </div>
          )}
          {previewResult && !testResult && (
            <div className="space-y-1">
              <p>{previewResult.files_to_purge} file(s), {previewResult.space_reclaimable_pretty}, boundary <span className="font-mono">{previewResult.boundary}</span></p>
              <p className="text-subtle">{previewResult.note}</p>
              <Paged rows={previewResult.candidates || []} unit="candidate files" pageSize={10}>
                {(rows, pager) => (
                  <>
                    <ul className="mt-1 max-h-52 space-y-0.5 overflow-auto font-mono text-[10.5px]">
                      {rows.map((c) => (<li key={c.name}>{c.name} — {c.archived_at}</li>))}
                    </ul>
                    {pager}
                  </>
                )}
              </Paged>
            </div>
          )}
        </div>
      )}

      {runId && <ExecuteResultCard run={runStatus.data} onDismiss={() => setRunId(null)} />}

      {/* ── Status / Audit ── */}
      <div className="rounded-card border border-border bg-surface p-4">
        <h3 className="mb-3 text-[13px] font-bold text-fg">Status</h3>
        <div className="grid grid-cols-2 gap-3 text-[12px] sm:grid-cols-4">
          <Detail label="Schedule" value={config?.enabled ? 'Enabled' : 'Disabled'} />
          <Detail label="Scheduler type" value={config?.scheduler_type || '—'} />
          <Detail label="Last execution" value={fmtDateTime(config?.last_run_at)} />
          <Detail label="Next execution" value={fmtDateTime(config?.next_run_at)} />
          <Detail label="Last status" value={config?.last_status ?
            <Badge tone={STATUS_TONE[config.last_status] || 'neutral'}>{config.last_status}</Badge> : '—'} />
          <Detail label="Files purged" value={config?.last_files_purged ?? '—'} />
          <Detail label="Space reclaimed" value={config?.last_space_reclaimed_bytes ? `${(config.last_space_reclaimed_bytes / 1048576).toFixed(1)} MB` : '—'} />
          <Detail label="Created" value={fmtDateTime(config?.created_at)} />
        </div>
        {config?.last_error && <Notice tone="danger" className="mt-3">{config.last_error}</Notice>}
      </div>

      {/* ── Purge History ── */}
      <div className="rounded-card border border-border bg-surface p-4">
        <h3 className="mb-3 text-[13px] font-bold text-fg">Purge History</h3>
        <Paged rows={history?.rows || []} unit="runs" pageSize={10}>
          {(rows, pager) => (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="text-left text-subtle">
                      <th className="pb-1.5 pr-3">Date/Time</th><th className="pb-1.5 pr-3">Type</th>
                      <th className="pb-1.5 pr-3">Status</th><th className="pb-1.5 pr-3">Files</th>
                      <th className="pb-1.5 pr-3">Space Reclaimed</th><th className="pb-1.5">Duration</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.id} className="border-t border-border">
                        <td className="py-1.5 pr-3">{fmtDateTime(r.started_at)}</td>
                        <td className="py-1.5 pr-3">{r.run_type}</td>
                        <td className="py-1.5 pr-3"><Badge tone={STATUS_TONE[r.status] || 'neutral'}>{r.status}</Badge></td>
                        <td className="py-1.5 pr-3">{r.files_purged ?? '—'}</td>
                        <td className="py-1.5 pr-3">{r.space_reclaimed_pretty || '—'}</td>
                        <td className="py-1.5">{r.duration_ms ? `${(r.duration_ms / 1000).toFixed(1)}s` : '—'}</td>
                      </tr>
                    ))}
                    {rows.length === 0 && (
                      <tr><td colSpan={6} className="py-4 text-center text-subtle">No purge runs yet.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
              {pager}
            </>
          )}
        </Paged>
      </div>

      <PurgeConfirmDialog
        open={!!confirmMode}
        mode={confirmMode}
        safety={safety}
        config={config}
        schedulerLabel={schedulerLabel}
        loading={confirmMode === 'execute' ? executeMutation.isPending : scheduleMutation.isPending}
        error={confirmMode === 'execute' ? executeMutation.error : scheduleMutation.error}
        onCancel={() => setConfirmMode(null)}
        onConfirm={({ acknowledge_warnings }) => {
          if (confirmMode === 'execute') {
            executeMutation.mutate({ confirm: 'PURGE', acknowledge_warnings },
              { onSuccess: (data) => { setConfirmMode(null); setRunId(data.run_id); } });
          } else {
            scheduleMutation.mutate({ confirm: 'SCHEDULE' }, { onSuccess: () => setConfirmMode(null) });
          }
        }}
      />
    </div>
  );
}

function Detail({ label, value, mono, copy }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] text-subtle">{label}</p>
      <div className="flex items-center gap-1.5">
        <p className={`truncate text-[12px] font-semibold text-fg ${mono ? 'font-mono' : ''}`}>{value ?? '—'}</p>
        {copy && <CopyButton text={copy} label="" />}
      </div>
    </div>
  );
}

function SafetyStat({ label, value }) {
  return (
    <div className="rounded-control border border-border bg-sunken p-3">
      <p className="text-[11px] font-bold uppercase tracking-wide text-subtle">{label}</p>
      <p className="mt-1 truncate font-mono text-[13px] font-semibold text-fg">{value ?? '—'}</p>
    </div>
  );
}

/**
 * Live view of a purge run in progress, backed by real polling — the
 * backend runs pg_archivecleanup in chunks (see _run_purge_chunked) and
 * commits its real "files done so far" after each one, so this is showing
 * genuine incremental progress from the actual host, not a simulated
 * replay. Every chunk still goes through the exact same official
 * pg_archivecleanup binary a single call would have used.
 */
function ExecuteResultCard({ run, onDismiss }) {
  const status = run?.run_status;
  const progress = run?.progress;
  const running = !status || status === 'running';
  const failed = status === 'failed';

  const total = progress?.total_files || 0;
  const done = progress?.completed_files || 0;
  const pct = total ? Math.min(100, Math.round((done / total) * 100)) : (running ? 0 : 100);
  const files = run?.purged_files || [];

  return (
    <div className={cn('rounded-card border bg-surface p-4', failed ? 'border-danger-soft' : 'border-success-soft')}>
      <div className="mb-1 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-[13px] font-bold text-fg">
          {running ? (
            <Loader2 size={15} className="animate-spin text-accent-text" />
          ) : failed ? (
            <Shield size={15} className="text-danger-fg" />
          ) : (
            <CheckCircle2 size={15} className="text-success-fg" />
          )}
          {running ? 'Purge In Progress' : failed ? 'Purge Failed' : 'Purge Completed'}
        </h3>
        {!running && (
          <button type="button" onClick={onDismiss} className="text-[11px] font-semibold text-subtle hover:text-fg">
            Dismiss
          </button>
        )}
      </div>

      {running ? (
        <p className="mb-3 text-[12px] text-muted">
          Running pg_archivecleanup{progress?.chunks_total > 1 ? ` (batch ${progress.chunk} of ${progress.chunks_total})` : ''}
          {progress?.last_file && <> — last removed <span className="font-mono text-[11px] text-fg">{progress.last_file}</span></>}
        </p>
      ) : failed ? (
        <p className="mb-3 text-[12px] text-danger-fg">{run.error_message || 'The purge did not complete successfully.'}</p>
      ) : (
        <p className="mb-3 text-[12px] text-muted">
          Removed <b className="font-semibold text-fg">{run.files_purged}</b> file{run.files_purged === 1 ? '' : 's'},
          reclaiming <b className="font-semibold text-fg">{run.space_reclaimed_pretty}</b> in {((run.duration_ms || 0) / 1000).toFixed(1)}s.
        </p>
      )}

      {total > 0 && (
        <>
          <div className="mb-1.5 h-1.5 w-full overflow-hidden rounded-full bg-sunken">
            <div
              className={cn('h-full rounded-full transition-[width] duration-300 ease-out', failed ? 'bg-danger-fg' : 'bg-success-fg')}
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="mb-2 text-[11px] font-semibold text-subtle">
            {running ? `${done} / ${total} files removed so far…` : `${done} / ${total} files removed`}
          </p>
        </>
      )}

      {!running && files.length > 0 && (
        <ul className="max-h-52 space-y-0.5 overflow-auto rounded-control bg-sunken p-2 font-mono text-[11px]">
          {files.map((name) => (
            <li key={name} className="flex items-center gap-1.5 text-success-fg">
              <CheckCircle2 size={11} className="shrink-0" /> {name}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
