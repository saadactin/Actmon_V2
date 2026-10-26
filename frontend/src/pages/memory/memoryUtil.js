/* Pure helpers for the memory pages (unit-tested in memoryUtil.test.mjs). Bytes in, labelled values out; a value the
   platform does not report stays null and renders as N/A — never 0. */

export const RANGES = [
  { label: 'Last 15 minutes', short: '15 min', minutes: 15, buckets: [0, 60] },
  { label: 'Last 30 minutes', short: '30 min', minutes: 30, buckets: [0, 60, 300] },
  { label: 'Last 1 Hour', short: 'hour', minutes: 60, buckets: [60, 0, 300] },
  { label: 'Last 6 Hours', short: '6 hours', minutes: 360, buckets: [60, 300, 900] },
  { label: 'Last 24 Hours', short: '24 hours', minutes: 1440, buckets: [300, 900, 3600] },
  { label: 'Last 7 Days', short: '7 days', minutes: 10080, buckets: [900, 3600] },
];
export const BUCKET_LABEL = { 0: 'Raw (15 s)', 60: 'Per Minute', 300: 'Per 5 Minutes', 900: 'Per 15 Minutes', 3600: 'Per Hour' };

export function fmtBytes(b, d = 1) {
  if (b == null || Number.isNaN(Number(b))) return 'N/A';
  const n = Number(b);
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(i >= 3 ? d : 0)} ${u[i]}`;
}
export const pct = (v, d = 1) => (v == null || Number.isNaN(Number(v)) ? 'N/A' : `${Number(v).toFixed(d)}%`);
export const share = (part, whole) => (part != null && whole ? (100 * part) / whole : null);

/** Split current / previous window from 2x-range samples ({t}). */
export function splitWindows(samples, minutes, nowMs) {
  const cut = nowMs - minutes * 60000;
  return { previous: samples.filter((s) => s.t < cut), current: samples.filter((s) => s.t >= cut) };
}

/**
 * Non-overlapping slices of physical memory for the donut. Every slice is a disjoint OS-reported component, so they
 * sum to the denominator (installed RAM on Windows when known, else visible RAM) — nothing counted twice.
 *   Windows: In Use (excl. modified) · Modified · Standby (cached) · Free · Hardware Reserved
 *   Linux:   Used (excl. cache) · Buffers/Cache (reclaimable) · Free
 * Returns null when the components needed are missing.
 */
export function breakdown(m) {
  if (!m || !m.total_bytes || m.available_bytes == null) return null;
  if (m.platform === 'linux' || (m.platform !== 'windows' && m.cached_bytes != null && m.modified_bytes == null)) {
    if (m.free_bytes == null || m.cached_bytes == null) return null;
    const used = Math.max(0, m.total_bytes - m.free_bytes - m.cached_bytes);
    const parts = [
      { id: 'used', label: 'Used Memory', bytes: used, color: '#2563eb' },
      { id: 'cache', label: 'Buffers / Cache', bytes: m.cached_bytes, color: '#f97316' },
      { id: 'free', label: 'Free Memory', bytes: m.free_bytes, color: '#16a34a' },
    ];
    return finish(parts, m.total_bytes, 'Used (excl. cache)');
  }
  const total = m.installed_bytes && m.installed_bytes >= m.total_bytes ? m.installed_bytes : m.total_bytes;
  const modified = m.modified_bytes ?? 0;
  const inUse = Math.max(0, m.total_bytes - m.available_bytes - modified);
  const standby = m.cached_bytes;
  const free = m.free_bytes;
  if (standby == null || free == null) {
    return finish([
      { id: 'used', label: 'In Use', bytes: m.total_bytes - m.available_bytes, color: '#2563eb' },
      { id: 'avail', label: 'Available', bytes: m.available_bytes, color: '#16a34a' },
      ...(total > m.total_bytes ? [{ id: 'hw', label: 'Hardware Reserved', bytes: total - m.total_bytes, color: '#7c3aed' }] : []),
    ], total, 'In Use');
  }
  // available = standby + free + (zero-page rounding); any remainder stays inside "Free" so the sum is exact
  const freeExact = Math.max(0, m.available_bytes - standby);
  return finish([
    { id: 'used', label: 'In Use', bytes: inUse, color: '#2563eb' },
    ...(m.modified_bytes != null ? [{ id: 'modified', label: 'Modified', bytes: modified, color: '#eab308' }] : []),
    { id: 'cache', label: 'Cached (Standby)', bytes: standby, color: '#f97316' },
    { id: 'free', label: 'Free', bytes: freeExact, color: '#16a34a' },
    ...(total > m.total_bytes ? [{ id: 'hw', label: 'Hardware Reserved', bytes: total - m.total_bytes, color: '#7c3aed' }] : []),
  ], total, 'In Use');
}
function finish(parts, total, centerLabel) {
  return { total, centerLabel, parts: parts.map((p) => ({ ...p, pct: (100 * p.bytes) / total })) };
}

/** Linear-time CSV with quoting; header from `cols` [[key,label]]. */
export function toCsv(rows, cols) {
  const q = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.map((c) => q(c[1])).join(','), ...rows.map((r) => cols.map((c) => q(r[c[0]])).join(','))].join('\n');
}

export function downloadCsv(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Normalise a live (infra-detail) or stored (ClickHouse) process row to one shape. */
export function normProc(p, totalBytes) {
  const ws = p.ws_bytes ?? null;
  return {
    pid: p.pid, name: p.name || '?', start_t: p.start_t ?? (p.start ? Date.parse(p.start) : null),
    ws, private: p.private_bytes ?? null, commit: p.commit_bytes ?? null, peak: p.peak_ws_bytes ?? null,
    memPct: p.mem_pct ?? (ws != null && totalBytes ? (100 * ws) / totalBytes : null),
    cpu: p.cpu_pct ?? p.cpu ?? null, threads: p.threads ?? null, user: p.user_name ?? p.user ?? null,
    status: p.status || null, path: p.path || null, running_s: p.running_s ?? null,
  };
}
