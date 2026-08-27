/** Shared between StorageHealth.jsx and StorageObjectDetailPage.jsx — kept
 * in its own module so the two don't import each other. */

export const STATUS_TONES = { healthy: 'success', monitor: 'info', warning: 'warning', critical: 'danger' };
export const EXECUTABLE_ACTIONS = new Set(['shrink_space', 'move', 'index_maintenance_rebuild']);

export const ACTION_LABELS = {
  shrink_space: 'Shrink Space',
  move: 'Move',
  index_maintenance_rebuild: 'Rebuild Index',
  tablespace_datafile_management: 'Tablespace/Datafile Mgmt (manual)',
  partition_maintenance: 'Partition Maintenance (manual)',
  continue_monitoring: 'Continue Monitoring',
  no_action: 'No Action',
};

export const JOB_STATUS_TONES = {
  pending_approval: 'warning', approved: 'info', running: 'info',
  succeeded: 'success', failed: 'danger', rejected: 'neutral',
};

/** Every job/session timestamp from the backend is a real UTC instant
 * (marked with a "Z" suffix) — always display it in Indian time regardless
 * of the viewer's own browser/OS timezone, since that's who this app is for. */
export function fmtIST(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short',
  });
}
