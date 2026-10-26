/**
 * Reading rules for the RAC topology view.
 *
 * Kept out of the component because these are the decisions worth testing: a
 * diagram is exactly the place where a missing reading turns into a confident
 * claim, and "0%" where nothing was measured reads as an idle host rather than
 * an unknown one.
 */

/**
 * A percentage the collector actually reported, or null when it reported
 * nothing. The host payload carries both `"35%"` and `35`, and 0 is a real
 * reading that must survive — so only null, undefined, empty and unparseable
 * text mean absent.
 */
export function pct(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace('%', '').trim());
  return Number.isFinite(n) ? n : null;
}

/** Bar and figure colour for a utilisation reading; grey where there is none. */
export const barTone = (v) => (v == null ? '#CBD5E1' : v >= 85 ? '#EF4444' : v >= 70 ? '#F59E0B' : '#22C55E');

/**
 * What a state word means, rather than where it sits in a list. An instance
 * that is not OPEN is not "slightly less green" — it is not serving, and an
 * unrecognised state is not quietly treated as healthy.
 */
export function toneFor(state) {
  const s = String(state || '').toUpperCase();
  if (!s) return 'unknown';
  if (['OPEN', 'ACTIVE', 'ONLINE', 'CONNECTED', 'MOUNTED', 'RUNNING'].includes(s)) return 'ok';
  if (['MOUNTED(CLOSED)', 'STARTED', 'RESTRICTED'].includes(s)) return 'warn';
  return 'bad';
}

export const DOT_COLOR = { ok: '#22C55E', warn: '#F59E0B', bad: '#EF4444', unknown: '#94A3B8' };

/**
 * The cluster's health, counted from its instances. Derived rather than read
 * from a single field so the headline can never disagree with the node cards
 * directly beneath it.
 */
export function clusterHealth(nodes = []) {
  if (!nodes.length) return { tone: 'neutral', label: 'Unknown' };
  const open = nodes.filter((n) => String(n.instance_status).toUpperCase() === 'OPEN').length;
  if (open === nodes.length) return { tone: 'success', label: 'Cluster Healthy' };
  if (open > 0) return { tone: 'warning', label: `${nodes.length - open} instance(s) not open` };
  return { tone: 'danger', label: 'No instance is open' };
}
