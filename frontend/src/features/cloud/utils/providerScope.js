/**
 * Provider slug ↔ key helpers, shared by the chooser, the accounts list and the
 * scope hook. Previously duplicated in CloudProviderChooser and
 * CloudProviderAccountsPage, which meant the "Oracle" → "OCI" normalisation had
 * to be remembered in every new place that filtered by provider.
 */

/** URL slug → canonical provider key used on the account records. */
export const SLUG_TO_KEY = { aws: 'AWS', azure: 'Azure', oci: 'OCI' };

/** Canonical provider key → URL slug. */
export const KEY_TO_SLUG = { AWS: 'aws', Azure: 'azure', OCI: 'oci' };

/**
 * The API stores OCI accounts as "Oracle" on some records and "OCI" on others —
 * always compare providers through this.
 */
export const providerKeyOf = (p) => (p === 'Oracle' ? 'OCI' : (p || ''));

/** Resolve a route slug (or a raw provider value) to a canonical key. */
export const keyFromSlug = (slug) => {
  if (!slug) return null;
  return SLUG_TO_KEY[slug.toLowerCase()] || providerKeyOf(slug) || null;
};

/** Route slug for an account's provider, e.g. an "Oracle" account → "oci". */
export const slugForProvider = (p) => {
  const key = providerKeyOf(p);
  return KEY_TO_SLUG[key] || (key || '').toLowerCase();
};

/** True when an account belongs to the given provider key (null key = no filter). */
export const accountInProvider = (account, providerKey) => !providerKey || providerKeyOf(account?.provider) === providerKey;
