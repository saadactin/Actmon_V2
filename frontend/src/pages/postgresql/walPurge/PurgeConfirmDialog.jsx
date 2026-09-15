import { useState } from 'react';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import Icon from '@/components/ui/Icon';
import Input from '@/components/ui/Input';
import Notice from '@/components/ui/Notice';
import Switch from '@/components/ui/Switch';
import { errorText } from '@/api/client';

/**
 * Typed-acknowledgement destructive dialog for Purge Now / Schedule Purge —
 * modeled directly on oracle/maintenanceShared.jsx's OperationConfirmDialog.
 * `mode='execute'` requires typing PURGE; `mode='schedule'` requires typing
 * SCHEDULE (a real cron/Task Scheduler entry gets installed on the DB host).
 */
export default function PurgeConfirmDialog({ open, mode, safety, config, schedulerLabel, loading, error, onCancel, onConfirm }) {
  const [ack, setAck] = useState('');
  const [warningsOk, setWarningsOk] = useState(false);
  const word = mode === 'schedule' ? 'SCHEDULE' : 'PURGE';
  const hasWarnings = mode === 'execute' && (safety?.warnings?.length || 0) > 0;
  const ackNeeded = ack.trim().toUpperCase() !== word;
  const confirmDisabled = ackNeeded || (hasWarnings && !warningsOk);

  const reset = () => { setAck(''); setWarningsOk(false); };

  return (
    <ConfirmDialog
      open={open}
      title={mode === 'schedule' ? 'Schedule WAL Archive Purge?' : 'Purge WAL Archive?'}
      tone="danger"
      icon="alert"
      confirmLabel={mode === 'schedule' ? 'Schedule, I understand' : 'Purge, I understand'}
      cancelLabel="Cancel"
      loading={loading}
      confirmDisabled={confirmDisabled}
      onCancel={() => { reset(); onCancel(); }}
      onConfirm={() => onConfirm({ acknowledge_warnings: warningsOk })}
    >
      <div className="space-y-3">
        {mode === 'execute' ? (
          <>
            <p className="text-[13px] text-muted">
              This operation will <span className="font-semibold text-fg">permanently remove</span> archived
              WAL files that are determined to be safe for deletion. Files deleted from the archive cannot be
              used for point-in-time recovery. This cannot be undone.
            </p>
            <div className="grid grid-cols-2 gap-2 rounded-control border border-border bg-sunken p-2.5 text-[12px]">
              <Row label="Files to purge" value={safety?.files_to_purge} />
              <Row label="Space to reclaim" value={safety?.space_reclaimable_pretty} />
              <Row label="Purge boundary" value={safety?.safe_boundary_wal} mono />
              <Row label="Retention" value={config?.retention_days ? `${config.retention_days} days` : '—'} />
            </div>
          </>
        ) : (
          <p className="text-[13px] text-muted">
            This installs a real {schedulerLabel || (config?.scheduler_type === 'schtasks' ? 'Windows Scheduled Task' : 'cron job')} on
            the database host. From then on, purges run automatically on the configured schedule — each one
            re-checks safety fresh at run time, but nothing here is reversible after it fires.
          </p>
        )}

        {hasWarnings && (
          <div className="space-y-1.5 rounded-control border border-warning-soft bg-warning-soft p-2.5">
            {safety.warnings.map((w, i) => (
              <p key={i} className="flex items-start gap-1.5 text-[12px] text-warning-fg">
                <Icon name="alert" size={13} className="mt-0.5 shrink-0" />{w.message}
              </p>
            ))}
            <label className="flex items-center gap-2 pt-1 text-[12px] font-semibold text-warning-fg">
              <Switch checked={warningsOk} onChange={setWarningsOk} size="sm" />
              I acknowledge these warnings
            </label>
          </div>
        )}

        <div>
          <label className="mb-1 block text-[11px] font-bold tracking-wide text-subtle uppercase">
            Type {word} to enable the button
          </label>
          <Input value={ack} onChange={(e) => setAck(e.target.value)} placeholder={word} size="sm" />
        </div>

        {error && (
          <div className="space-y-1.5">
            <p className="text-[12px] font-semibold text-danger-fg">{errorText(error)}</p>
            {(error?.detail?.blocking_reasons || []).map((r, i) => (
              <Notice key={i} tone="danger">{r.message}</Notice>
            ))}
          </div>
        )}
      </div>
    </ConfirmDialog>
  );
}

function Row({ label, value, mono }) {
  return (
    <div>
      <p className="text-subtle">{label}</p>
      <p className={`font-semibold text-fg ${mono ? 'font-mono' : ''}`}>{value ?? '—'}</p>
    </div>
  );
}
