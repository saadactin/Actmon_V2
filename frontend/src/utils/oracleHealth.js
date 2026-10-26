/**
 * Shared Oracle health-score formula — used by OracleDashboard and
 * OracleReportsPage so the two never diverge again. Previously each computed
 * its own inline score with different weights and different inputs (e.g. the
 * same instance could score differently on the dashboard vs the report).
 *
 * Every input is OPTIONAL — a signal a caller doesn't have (undefined/null)
 * contributes no penalty, rather than being treated as a bad 0. Only pass a
 * field when it was genuinely measured.
 *
 * Returns null when NOTHING was measured. That case is not a 100: starting at
 * 100 and subtracting penalties means "no signal" and "no problem" produce the
 * same number, and the page then prints "Health 100" across a database it
 * could not connect to. An unmeasured instance has an unknown score, and the
 * caller is made to say so.
 */
export function computeInstanceHealthScore({
  sessionPct, bufHitPct, maxTsPct, waitCount, hostCpuPct,
  rmanFailed, archiveGapCount, invalidObjectsTotal,
} = {}) {
  // A signal counts as measured when it arrived as a real number. Zero is a
  // legitimate reading, so only null/undefined/NaN mean absent.
  const real = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));
  const measured = [sessionPct, bufHitPct, maxTsPct, waitCount, hostCpuPct,
                    rmanFailed, archiveGapCount, invalidObjectsTotal].filter(real);
  if (!measured.length) return null;

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
/** Metric keys behind each health input, as the backend names them in
 *  `failed_metrics`. A health input is unmeasured when any source it is built
 *  from failed to collect. */
const HEALTH_SOURCES = {
  sessionPct: ['active_sessions', 'total_sessions', 'max_sessions'],
  bufHitPct: ['buffer_cache_hit'],
  maxTsPct: ['tablespaces'],
  waitCount: ['top_waits'],
  hostCpuPct: ['host_cpu_sysmetric', 'host_cpu_osstat', 'osstat'],
};

/**
 * The set of metrics a dashboard payload could not read.
 *
 * Needed because every numeric field in that payload is initialised to 0
 * server-side and only overwritten on success: a failed query is otherwise
 * indistinguishable from a genuine zero, which is how an instance that
 * answered nothing was shown as "Health 100" over a row of green ticks.
 *
 * Prefers the backend's explicit `failed_metrics`; falls back to the
 * "<metric>: <message>" errors list so an older backend still reports.
 */
export function failedMetricsOf(payload = {}) {
  const explicit = payload.failed_metrics;
  if (Array.isArray(explicit) && explicit.length) return new Set(explicit);
  return new Set(
    (Array.isArray(payload.errors) ? payload.errors : [])
      .filter((e) => typeof e === 'string' && e.includes(':'))
      .map((e) => e.split(':')[0].trim())
      .filter(Boolean),
  );
}

/**
 * Health inputs for a dashboard payload, with every unread metric passed as
 * null rather than as the zero the payload carries.
 */
export function healthInputsFromPayload(payload = {}) {
  const hs = payload.health_summary || {};
  const failed = failedMetricsOf(payload);
  const unread = (key) => HEALTH_SOURCES[key].some((m) => failed.has(m));
  const tsList = Array.isArray(payload.tablespaces) ? payload.tablespaces : [];
  const waitList = Array.isArray(payload.wait_events) ? payload.wait_events : [];
  const n = (v) => (v === null || v === undefined ? null : Number(v));

  return {
    sessionPct: unread('sessionPct') ? null : n(hs.session_pct),
    bufHitPct: unread('bufHitPct') ? null : n(hs.buffer_cache_hit_pct),
    maxTsPct: unread('maxTsPct') || !tsList.length
      ? null
      : tsList.reduce((m, t) => Math.max(m, Number(t.used_pct) || 0), 0),
    waitCount: unread('waitCount') ? null : waitList.length,
    hostCpuPct: unread('hostCpuPct') ? null : n(hs.host_cpu_pct),
  };
}

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
  unknown: { label: 'Unknown', tone: 'neutral' },
};

export function healthBand(status) {
  return BANDS[status] || BANDS.not_applicable;
}

export function bandForScore(score) {
  // Unknown is its own answer, not the bottom of the scale and not the top.
  if (score === null || score === undefined) return BANDS.unknown;
  if (score >= 80) return BANDS.healthy;
  if (score >= 60) return BANDS.warning;
  return BANDS.critical;
}
