/**
 * Provider slug ↔ key helpers, shared by the chooser, the accounts list and the
 * scope hook. Previously duplicated in CloudProviderChooser and
 * CloudProviderAccountsPage, which meant the "Oracle" → "OCI" normalisation had
 * to be remembered in every new place that filtered by provider.
 */

/** URL slug → canonical provider key used on the account records. */
export const SLUG_TO_KEY: Record<string, string> = { aws: 'AWS', azure: 'Azure', oci: 'OCI' };

/** Canonical provider key → URL slug. */
export const KEY_TO_SLUG: Record<string, string> = { AWS: 'aws', Azure: 'azure', OCI: 'oci' };

/**
 * The API stores OCI accounts as "Oracle" on some records and "OCI" on others —
 * always compare providers through this.
 */
export const providerKeyOf = (p?: string | null): string => (p === 'Oracle' ? 'OCI' : (p || ''));

/** Resolve a route slug (or a raw provider value) to a canonical key. */
export const keyFromSlug = (slug?: string | null): string | null => {
  if (!slug) return null;
  return SLUG_TO_KEY[slug.toLowerCase()] || providerKeyOf(slug) || null;
};

/** Route slug for an account's provider, e.g. an "Oracle" account → "oci". */
export const slugForProvider = (p?: string | null): string => {
  const key = providerKeyOf(p);
  return KEY_TO_SLUG[key] || (key || '').toLowerCase();
};

/** True when an account belongs to the given provider key (null key = no filter). */
export const accountInProvider = (account: any, providerKey?: string | null): boolean =>
  !providerKey || providerKeyOf(account?.provider) === providerKey;
