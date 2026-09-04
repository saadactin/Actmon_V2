import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import client, { errorText } from '@/api/client';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import Icon from '@/components/ui/Icon';
import Input from '@/components/ui/Input';
import Popover from '@/components/ui/Popover';
import cn from '@/lib/cn';
import { StatCell } from '@/pages/_shared/enginePanels';
import { ACTION_LABELS, DESTRUCTIVE_ACTIONS } from './storageHealthConstants';

/** Per-row "Actions" menu — each entry can be individually disabled with a
 * reason (shown as a tooltip), so ineligible operations are visible but
 * inert rather than hidden (the DBA can see WHY shrink isn't offered, e.g.
 * "row movement disabled", instead of just not seeing the button at all). */
export function ActionsMenu({ actions, onPick, label = 'Actions' }) {
  const [open, setOpen] = useState(false);
  if (!actions?.length) return <span className="text-subtle">—</span>;
  return (
    <div className="relative inline-block" onClick={(e) => e.stopPropagation()}>
      <Button size="sm" variant="secondary" iconRight="chevron-down" onClick={() => setOpen((o) => !o)}>
        {label}
      </Button>
      <Popover open={open} onClose={() => setOpen(false)} width={260} align="right">
        <div className="py-1">
          {actions.map((a) => (
            <button
              key={a.action}
              type="button"
              disabled={a.disabled}
              title={a.disabled ? a.reason : undefined}
              onClick={() => { setOpen(false); onPick(a.action); }}
              className={cn(
                'flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[12px] transition-colors',
                a.disabled ? 'cursor-not-allowed text-subtle' : 'text-fg hover:bg-sunken',
              )}
            >
              <span>{a.label}</span>
              {DESTRUCTIVE_ACTIONS.has(a.action) && <Icon name="alert" size={12} className="shrink-0 text-danger-fg" />}
            </button>
          ))}
        </div>
      </Popover>
    </div>
  );
}

/**
 * Shared building blocks for the Oracle Maintenance module's 5 detail pages
 * (Table/Index/Statistics/Partition/Space) — the confirm-and-execute flow,
 * the summary stat row, and the manual-refresh control are identical shapes
 * across every category, so they live here once instead of five times.
 */

/** POST /oracle-maintenance/request-direct, then jump straight to the job's
 * own live page — the same JobDetailPage the Storage Health flow already
 * uses for real-time queued -> running -> succeeded/failed status.
 * `section` is which Maintenance sub-tab this was launched from (table/
 * index/statistics/partition/space) — threaded through as router state so
 * the job page's Back button returns to that same sub-tab, not Overview. */
export function useDirectMaintenance(connId, navigate, section) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ objectType, objectName, action, params, recipients }) =>
      client.post(`/connections/oracle/${connId}/oracle-maintenance/request-direct`, {
        object_type: objectType, object_name: objectName, action, params, recipients,
      }).then((r) => r.data),
    onSuccess: (job) => {
      qc.invalidateQueries({ queryKey: ['oracleMaintenanceOverview', connId] });
      // Its own path (not Storage Health's) so the page's Back button and
      // "no job selected" fallback correctly point back at the Maintenance
      // module instead of a page this job has nothing to do with.
      navigate(`/oracle-dashboard/${connId}/maintenance/job`, { state: { job, maintenanceSection: section } });
    },
  });
}

/** The confirmation dialog every operation button opens. Destructive actions
 * (truncate/drop) get red styling and a typed "acknowledge" step in addition
 * to the normal Confirm button — a click alone is never enough for those. */
export function OperationConfirmDialog({ open, action, objectLabel, sql, warnings, extra, loading, error, onCancel, onConfirm }) {
  const destructive = action && DESTRUCTIVE_ACTIONS.has(action);
  const [ack, setAck] = useState('');
  const label = ACTION_LABELS[action] || action;
  const ackNeeded = destructive ? ack.trim().toUpperCase() !== 'CONFIRM' : false;

  return (
    <ConfirmDialog
      open={open}
      title={destructive ? `${label} — this cannot be undone` : `${label}?`}
      tone={destructive ? 'danger' : 'warning'}
      icon="alert"
      confirmLabel={destructive ? `${label}, I understand` : label}
      cancelLabel="Cancel"
      loading={loading}
      confirmDisabled={ackNeeded}
      onCancel={() => { setAck(''); onCancel(); }}
      onConfirm={onConfirm}
    >
      <div className="space-y-3">
        <p className="text-[13px] text-muted">
          {destructive ? 'This permanently destroys data and cannot be rolled back. ' : ''}
          This will run against <span className="font-semibold text-fg">{objectLabel}</span>.
        </p>
        {sql && (
          <pre className="overflow-x-auto rounded-control border border-border bg-sunken p-2.5 font-mono text-[11px] text-fg">{sql}</pre>
        )}
        {warnings?.length > 0 && (
          <div className="space-y-1 rounded-control border border-warning-soft bg-warning-soft p-2.5">
            {warnings.map((w, i) => (
              <p key={i} className="flex items-start gap-1.5 text-[12px] text-warning-fg">
                <Icon name="alert" size={13} className="mt-0.5 shrink-0" />{w}
              </p>
            ))}
          </div>
        )}
        {extra}
        {destructive && (
          <div>
            <label className="mb-1 block text-[11px] font-bold tracking-wide text-subtle uppercase">
              Type CONFIRM to enable the button
            </label>
            <Input value={ack} onChange={(e) => setAck(e.target.value)} placeholder="CONFIRM" size="sm" />
          </div>
        )}
        {error && <p className="text-[12px] text-danger-fg">{errorText(error)}</p>}
      </div>
    </ConfirmDialog>
  );
}

/** The "Overview / Current Status" stat row every detail page opens with. */
export function CategorySummaryBar({ items }) {
  return (
    <div className="grid grid-cols-2 gap-gutter-sm sm:grid-cols-3 lg:grid-cols-6">
      {items.map((it, i) => <StatCell key={i} {...it} />)}
    </div>
  );
}

/** Manual refresh + last-updated — the countdown itself is owned by the
 * caller since each page's poll interval can differ. */
export function RefreshBar({ seconds, isFetching, onRefresh, lastUpdatedAt }) {
  return (
    <div className="flex items-center justify-between">
      <p className="text-[11px] text-subtle">
        {lastUpdatedAt ? `Last refreshed ${new Date(lastUpdatedAt).toLocaleTimeString()}` : 'Loading…'}
      </p>
      <Button size="sm" variant="secondary" icon="refresh" loading={isFetching} onClick={onRefresh}>
        {isFetching ? 'Refreshing…' : `Refresh (${seconds}s)`}
      </Button>
    </div>
  );
}

export function RecommendationBadge({ action }) {
  if (!action) return <span className="text-subtle">—</span>;
  return <Badge tone="warning" size="xs">{ACTION_LABELS[action] || action}</Badge>;
}

export function LastOpCell({ operation, status }) {
  if (!operation) return <span className="text-subtle">—</span>;
  const tone = status === 'succeeded' ? 'success' : status === 'failed' ? 'danger'
    : status === 'running' ? 'info' : 'neutral';
  return (
    <span className="flex flex-col gap-0.5">
      <span className="text-[12px] text-fg">{ACTION_LABELS[operation] || operation}</span>
      <Badge tone={tone} size="xs">{status}</Badge>
    </span>
  );
}
