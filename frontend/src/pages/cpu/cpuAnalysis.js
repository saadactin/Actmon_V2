/**
 * Pure calculations for the CPU Performance page. Inputs are the real samples from
 * GET /metrics/history/{server_name}?kind=infra&tech=host (ClickHouse metrics_infra.host_cpu).
 *
 * Missing samples: a bucket or row whose host_cpu is null/not a number is SKIPPED, never
 * treated as 0 — averages, peaks and minimums are over the samples that exist, and the count
 * of those samples is returned so the page can say how many readings an aggregate rests on.
 */

/** ClickHouse timestamps come back as "YYYY-MM-DD HH:MM:SS" in UTC (metrics_history_service pins them). */
export function parseTs(ts) {
  if (ts == null) return null;
  if (typeof ts === 'number') return new Date(ts);
  const s = String(ts).trim();
  const iso = s.includes('T') ? s : s.replace(' ', 'T');
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** samples (newest-first or any order) -> [{t: ms, v: pct}] oldest-first, invalid rows dropped. */
export function toSeries(samples) {
  const out = [];
  for (const s of samples || []) {
    const d = parseTs(s.ts ?? s.bucket);
    const v = typeof s.host_cpu === 'string' ? Number(s.host_cpu) : s.host_cpu;
    if (!d || typeof v !== 'number' || !Number.isFinite(v)) continue;
    out.push({ t: d.getTime(), v: Math.max(0, Math.min(100, v)) });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

/** Average / peak (with time) / minimum (with time) over the points; null when there are none. */
export function stats(points) {
  if (!points.length) return null;
  let sum = 0;
  let peak = points[0];
  let min = points[0];
  for (const p of points) {
    sum += p.v;
    if (p.v > peak.v) peak = p;
    if (p.v < min.v) min = p;
  }
  return { avg: sum / points.length, peak, min, count: points.length, from: points[0].t, to: points[points.length - 1].t };
}

/** Split a series fetched for 2x the window into [previous window, current window] at `now - minutes`. */
export function splitWindows(points, minutes, now = Date.now()) {
  const cut = now - minutes * 60_000;
  return { previous: points.filter((p) => p.t < cut), current: points.filter((p) => p.t >= cut) };
}

/**
 * Spikes: runs of consecutive points at or above `threshold` (ActMon's "High" band starts at 75%).
 * A gap larger than `maxGapMs` between two points ends a run, so missing data never bridges two
 * separate episodes. For each run: start, end, duration, peak, and the average of the same-length
 * window before and after it (only from points that exist).
 */
export function findSpikes(points, { threshold = 75, maxGapMs = 10 * 60_000 } = {}) {
  const runs = [];
  let cur = null;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const gap = i > 0 ? p.t - points[i - 1].t : 0;
    if (p.v >= threshold && (!cur || gap <= maxGapMs)) {
      if (!cur) cur = { first: i, last: i };
      else cur.last = i;
    } else {
      if (cur) runs.push(cur);
      cur = p.v >= threshold ? { first: i, last: i } : null;
    }
  }
  if (cur) runs.push(cur);
  return runs.map(({ first, last }) => {
    const seg = points.slice(first, last + 1);
    const start = seg[0].t;
    const end = seg[seg.length - 1].t;
    const span = Math.max(end - start, 0);
    const peak = seg.reduce((a, b) => (b.v > a.v ? b : a), seg[0]);
    const win = Math.max(span, 5 * 60_000);
    const before = stats(points.filter((p) => p.t < start && p.t >= start - win));
    const after = stats(points.filter((p) => p.t > end && p.t <= end + win));
    return { start, end, durationMs: span, samples: seg.length, peak, avg: stats(seg).avg, beforeAvg: before?.avg ?? null, afterAvg: after?.avg ?? null };
  }).sort((a, b) => b.peak.v - a.peak.v);
}

/** Freshness of the newest reading. Agent hosts report every ~15 s, SSH hosts every ~3 min. */
export function freshness(lastMs, { collector = 'ssh', now = Date.now() } = {}) {
  if (lastMs == null) return { state: 'none', ageMs: null };
  const ageMs = Math.max(0, now - lastMs);
  const staleAfter = collector === 'agent' ? 2 * 60_000 : 10 * 60_000;
  return { state: ageMs > staleAfter ? 'stale' : 'fresh', ageMs };
}

/** "2 min 10 s", "3 h 5 min" … */
export function fmtDuration(ms) {
  if (ms == null) return 'N/A';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min${s % 60 ? ` ${s % 60} s` : ''}`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h${m % 60 ? ` ${m % 60} min` : ''}`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

/** Ranges and the bucket sizes each one supports. The history API returns at most 5000 rows, so a
 *  range only offers buckets that fit (and "raw" only where 15 s agent samples fit). */
export const RANGES = [
  { minutes: 15, label: 'Last 15 minutes', buckets: [0, 60] },
  { minutes: 30, label: 'Last 30 minutes', buckets: [0, 60, 300] },
  { minutes: 60, label: 'Last 1 hour', buckets: [0, 60, 300] },
  { minutes: 360, label: 'Last 6 hours', buckets: [60, 300, 900] },
  { minutes: 1440, label: 'Last 24 hours', buckets: [300, 900, 3600] },
  { minutes: 10080, label: 'Last 7 days', buckets: [900, 3600] },
];
export const BUCKET_LABEL = { 0: 'Every sample', 60: 'Per minute', 300: 'Per 5 minutes', 900: 'Per 15 minutes', 3600: 'Per hour' };
