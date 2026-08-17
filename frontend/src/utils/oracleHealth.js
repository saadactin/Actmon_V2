/**
 * Shared Oracle health-score formula — used by OracleDashboard and
 * OracleReportsPage so the two never diverge again. Previously each computed
 * its own inline score with different weights and different inputs (e.g. the
 * same instance could score differently on the dashboard vs the report).
 *
 * Every input is OPTIONAL — a signal a caller doesn't have (undefined/null)
 * contributes no penalty, rather than being treated as a bad 0. Only pass a
 * field when it was genuinely measured.
 */
export function computeInstanceHealthScore({
  sessionPct, bufHitPct, maxTsPct, waitCount, hostCpuPct,
  rmanFailed, archiveGapCount, invalidObjectsTotal,
} = {}) {
  let score = 100;
  if (sessionPct > 90) score -= 25;
  else if (sessionPct > 75) score -= 12;
  if (bufHitPct != null && bufHitPct > 0 && bufHitPct < 80) score -= 25;
  else if (bufHitPct != null && bufHitPct > 0 && bufHitPct < 90) score -= 12;
  if (maxTsPct > 95) score -= 25;
  else if (maxTsPct > 85) score -= 12;
  if (hostCpuPct > 90) score -= 15;
  else if (hostCpuPct > 75) score -= 8;
  if (waitCount > 20) score -= 8;
  if (rmanFailed > 0) score -= 15;
  if (archiveGapCount > 10) score -= 20;
  else if (archiveGapCount > 5) score -= 10;
  if (invalidObjectsTotal > 50) score -= 10;
  return Math.max(0, score);
}

/** Topology-aware RAC cluster rollup (§23) — NOT a flat average of node
 * scores: all instances OPEN → healthy, some down → warning, all down →
 * critical. Mirrors the backend's oracle_rac_nodes() computation exactly so
 * the badge always agrees with what the API already decided. */
export function clusterHealthFromNodes(nodes = []) {
  if (!nodes.length) return 'not_applicable';
  const openCount = nodes.filter((n) => String(n.instance_status || '').toUpperCase() === 'OPEN').length;
  if (openCount === nodes.length) return 'healthy';
  if (openCount === 0) return 'critical';
  return 'warning';
}

const BANDS = {
  healthy: { label: 'Healthy', tone: 'success' },
  warning: { label: 'Warning', tone: 'warning' },
  critical: { label: 'Critical', tone: 'danger' },
  not_configured: { label: 'Not Configured', tone: 'neutral' },
  not_applicable: { label: 'N/A', tone: 'neutral' },
};

export function healthBand(status) {
  return BANDS[status] || BANDS.not_applicable;
}

export function bandForScore(score) {
  if (score >= 80) return BANDS.healthy;
  if (score >= 60) return BANDS.warning;
  return BANDS.critical;
}
