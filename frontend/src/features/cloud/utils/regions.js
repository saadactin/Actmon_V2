/**
 * Region display helpers.
 *
 * `region_or_zone` historically held three different levels of the same
 * hierarchy — a region, an OCI availability domain, or an AWS availability zone —
 * which made the dashboard's region breakdown show five "regions" for a tenancy
 * that has two. The scanners now store the region and keep the finer placement in
 * config, but this normalises defensively so resources discovered before that fix
 * still group correctly instead of needing a rescan to look right.
 *
 * Mirrors Backend/cloud/app/utils/regions.py — keep the two in step.
 */

/** Our label for resources that genuinely have no region (IAM, tenancy-level). */
export const GLOBAL = 'global';

// OCI availability domain: "<tenancy-prefix>:<REGION>-AD-<n>".
const OCI_AD = /^[^:]*:(.+?)-AD-\d+$/i;
// AWS availability zone: region plus one trailing letter, e.g. "ap-south-1b".
const AWS_AZ = /^([a-z]{2,4}-[a-z0-9-]+-\d+)[a-z]$/i;

/** Reduce a region / availability domain / availability zone to its region. */
export function normalizeRegion(value) {
  if (!value) return null;
  const v = String(value).trim();
  if (!v) return null;
  if (v.toLowerCase() === GLOBAL) return GLOBAL;

  const ad = v.match(OCI_AD);
  if (ad) return ad[1].toLowerCase();

  const az = v.match(AWS_AZ);
  if (az) return az[1].toLowerCase();

  return v === v.toUpperCase() ? v.toLowerCase() : v;
}

/**
 * Human label for a region bucket. "global" is our own marker, not a provider
 * region name — IAM in AWS and OCI really has no region — so say that rather than
 * listing it as if the customer had a region called "global".
 */
export function regionLabel(value) {
  const r = normalizeRegion(value);
  if (!r) return 'Unknown';
  if (r === GLOBAL) return 'Global (no region)';
  return r;
}

// A bare UUID — an Azure tenant (directory) ID looks exactly like this.
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * How to label an account's `tenant_or_region`.
 *
 * That one column holds different things depending on how the account was added:
 * a region for AWS ("ap-south-1") and OCI ("ap-mumbai-1"), but for Azure either a
 * region ("eastus") or the tenant GUID. Displaying a tenant GUID under a heading
 * that says "Region" is simply wrong, so detect it and say what it is.
 *
 * It is also the wrong concept for Azure in the first place: an Azure account is
 * scoped to a subscription and its resources span many regions, so no single
 * region describes it.
 *
 * Returns { text, kind, title } — `kind` is 'tenant' | 'region' | 'none'.
 */
export function accountLocation(account) {
  const raw = (account?.tenant_or_region || '').trim();
  if (!raw) return { text: 'NA', kind: 'none', title: null };
  if (GUID.test(raw)) {
    return {
      text: `Tenant ${raw.slice(0, 8)}…`,
      kind: 'tenant',
      title: `Azure tenant (directory) ID: ${raw}`,
    };
  }
  return { text: raw, kind: 'region', title: null };
}

/** Count resources per region, normalised, with global sorted last. */
export function regionBreakdown(resources) {
  const counts = {};
  (resources || []).forEach((r) => {
    const key = normalizeRegion(r.region_or_zone) || 'unknown';
    counts[key] = (counts[key] || 0) + 1;
  });
  return Object.entries(counts)
    .map(([key, value]) => ({ key, name: regionLabel(key), value }))
    .sort((a, b) => {
      // Non-regional resources are not a place; keep them out of the lead.
      if (a.key === GLOBAL) return 1;
      if (b.key === GLOBAL) return -1;
      return b.value - a.value;
    });
}
