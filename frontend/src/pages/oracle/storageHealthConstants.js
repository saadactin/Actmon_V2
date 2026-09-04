/** Shared between StorageHealth.jsx and StorageObjectDetailPage.jsx — kept
 * in its own module so the two don't import each other. */

export const STATUS_TONES = { healthy: 'success', monitor: 'info', warning: 'warning', critical: 'danger' };
export const EXECUTABLE_ACTIONS = new Set(['shrink_space', 'move', 'index_maintenance_rebuild']);

export const ACTION_LABELS = {
  shrink_space: 'Shrink Space',
  move: 'Move',
  truncate_table: 'Truncate Table',
  enable_row_movement: 'Enable Row Movement',
  disable_row_movement: 'Disable Row Movement',
  index_maintenance_rebuild: 'Rebuild Index',
  index_rebuild_online: 'Rebuild Index Online',
  index_coalesce: 'Coalesce Index',
  index_rebuild_unusable: 'Rebuild Unusable Index',
  gather_table_stats: 'Gather Table Statistics',
  gather_schema_stats: 'Gather Schema Statistics',
  gather_index_stats: 'Gather Index Statistics',
  move_partition: 'Move Partition',
  shrink_partition: 'Shrink Partition',
  rebuild_partition: 'Rebuild Partition',
  merge_partition: 'Merge Partition',
  split_partition: 'Split Partition',
  drop_partition: 'Drop Partition',
  purge_recyclebin: 'Purge Recycle Bin',
  datafile_resize: 'Resize Datafile',
  tablespace_datafile_management: 'Tablespace/Datafile Mgmt (manual)',
  partition_maintenance: 'Partition Maintenance (manual)',
  continue_monitoring: 'Continue Monitoring',
  no_action: 'No Action',
};

/** Actions the backend refuses to run without an explicit confirm flag —
 * the frontend must show a strong destructive warning for these, not just
 * the normal confirmation dialog (see DESTRUCTIVE_ACTIONS in
 * oracle_maintenance_service.py, which this must stay in sync with). */
export const DESTRUCTIVE_ACTIONS = new Set(['truncate_table', 'drop_partition']);

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
