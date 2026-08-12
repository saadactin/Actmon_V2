/** Shared value formatting, so the same number never renders two ways. */

/** 1284 → "1,284"; 12900 → "12.9K"; 4200000 → "4.2M" */
export function compact(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
  const v = Number(n);
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 10_000) return `${(v / 1000).toFixed(1)}K`;
  return v.toLocaleString();
}

/** Relative time, e.g. "4m ago". */
export function ago(ts) {
  if (!ts) return '—';
  const then = new Date(ts).getTime();
  if (!Number.isFinite(then)) return '—';
  const secs = Math.floor((Date.now() - then) / 1000);
  if (secs < 0) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86_400) return `${Math.floor(secs / 3600)}h ago`;
  if (secs < 2_592_000) return `${Math.floor(secs / 86_400)}d ago`;
  return new Date(ts).toLocaleDateString();
}

/** Sortable age in seconds (ascending = newest first). */
export const ageSeconds = (ts) => {
  const then = new Date(ts).getTime();
  return Number.isFinite(then) ? Math.max(0, Math.floor((Date.now() - then) / 1000)) : Infinity;
};

/** 0 → "immediately"; 90 → "1m 30s"; 3600 → "1h" */
export function duration(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return 'immediately';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem ? `${m}m ${rem}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return remM ? `${h}h ${remM}m` : `${h}h`;
}

/** Absolute timestamp for tooltips / detail rows. */
export function fullTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return Number.isFinite(d.getTime()) ? d.toLocaleString() : '—';
}

/** Trim a numeric value to at most 1 decimal, dropping a trailing ".0". */
export function num(v, unit = '') {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  const s = Number.isInteger(n) ? String(n) : n.toFixed(1);
  return `${s}${unit}`;
}

/** A delivery latency in milliseconds → "84 ms" / "3.56 s", never a raw float. */
export function responseTime(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1000) return `${Math.round(n)} ms`;
  return `${(n / 1000).toFixed(2)} s`;
}

/**
 * A database engine's error, trimmed to the part a human can act on.
 *
 * ClickHouse (and Oracle, and MSSQL) append a full native stack trace to every
 * exception — hundreds of frames of mangled C++ symbols. Rendered verbatim in a
 * page banner it buries the one sentence that matters under several screens of
 * `DB::Exception::Exception(...) @ 0x00000000...`, which is exactly what the
 * ClickHouse overview was doing.
 *
 * So: cut at the trace marker, collapse whitespace, and cap the length. The full
 * text stays available to the caller for a `title` — nothing is thrown away, it
 * just stops being the first thing you see.
 */
export function dbError(message, max = 220) {
  const raw = String(message ?? '').trim();
  if (!raw) return '';

  // everything from the first trace marker onward is machine detail
  const head = raw.split(/\s*(?:Stack trace:|\(version [\d.]+)/i)[0];
  const clean = head.replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '');

  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

/**
 * A locally-unique id, safe outside a secure context.
 *
 * `crypto.randomUUID()` only exists on HTTPS or localhost — on a plain-HTTP LAN
 * deployment (e.g. http://192.168.x.x:2106, exactly how this app gets reached
 * during on-prem testing) it is simply undefined, and calling it throws. Falls
 * back to `crypto.getRandomValues` (available over plain HTTP) and, failing
 * that, a time+pseudo-random string — always unique enough for a React key or a
 * client-side message id, never used for anything security-sensitive.
 */
export function uid() {
  const c = typeof window !== 'undefined' ? window.crypto : undefined;
  if (c?.randomUUID) return c.randomUUID();
  if (c?.getRandomValues) {
    const b = new Uint8Array(16);
    c.getRandomValues(b);
    return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  }
  return `${Date.now().toString(16)}${Math.floor(Math.random() * 1e12).toString(16)}`;
}
