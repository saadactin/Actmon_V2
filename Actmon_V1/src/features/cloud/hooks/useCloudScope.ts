import { useMemo } from 'react';
import { useCloudAccounts } from './useCloudAccounts';
import { useCloudStore } from '../state/cloudStore';
import { accountInProvider, providerKeyOf } from '../utils/providerScope';

/**
 * Single source of truth for "which provider/account am I looking at".
 *
 * Every cloud tab used to do `if (!selectedAccountId) setSelectedAccountId(accounts[0].id)`,
 * so drilling into OCI and then opening Cost/Resources/Security silently showed
 * whichever account happened to be first — usually a different provider. This
 * hook resolves the scope once, consistently:
 *
 *   1. the account the user picked, but only if it is still in the scoped provider
 *   2. otherwise the first account belonging to the scoped provider
 *   3. otherwise (no provider scope) the first account overall
 *
 * `scopedAccounts` is what selectors should offer, so an account picker inside an
 * OCI scope never lists Azure accounts.
 */
export interface CloudScope {
  /** 'AWS' | 'Azure' | 'OCI' — or null when viewing all providers. */
  providerKey: string | null;
  /** The account to render, already validated against the provider scope. */
  accountId: string | null;
  /** The resolved account record, if loaded. */
  account: any | null;
  /** Accounts visible under the current scope (all accounts when unscoped). */
  scopedAccounts: any[];
  /** Every account, regardless of scope. */
  allAccounts: any[];
  isScoped: boolean;
  isLoading: boolean;
  setProviderScope: (key: string | null) => void;
  setAccountScope: (id: string | null) => void;
  clearScope: () => void;
  /** Filter any account-keyed rows (resources, alerts, findings) down to the scope. */
  filterByScope: <T extends { account_id?: string | null }>(rows: T[] | undefined) => T[];
}

export const useCloudScope = (): CloudScope => {
  const { data: accounts, isLoading } = useCloudAccounts();
  const providerKey = useCloudStore((s) => s.scopeProviderKey);
  const storedAccountId = useCloudStore((s) => s.selectedAccountId);
  const setProviderScope = useCloudStore((s) => s.setScopeProviderKey);
  const setAccountScope = useCloudStore((s) => s.setSelectedAccountId);
  const clearScope = useCloudStore((s) => s.clearScope);

  const allAccounts = accounts || [];

  const scopedAccounts = useMemo(
    () => allAccounts.filter((a: any) => accountInProvider(a, providerKey)),
    [allAccounts, providerKey],
  );

  const accountId = useMemo(() => {
    const stored = storedAccountId
      ? scopedAccounts.find((a: any) => a.id === storedAccountId)
      : null;
    if (stored) return stored.id;
    // Stored account belongs to a different provider (or is gone) — fall back
    // inside the scope rather than to accounts[0] globally.
    return scopedAccounts[0]?.id ?? null;
  }, [storedAccountId, scopedAccounts]);

  const account = useMemo(
    () => scopedAccounts.find((a: any) => a.id === accountId) ?? null,
    [scopedAccounts, accountId],
  );

  const scopedAccountIds = useMemo(
    () => new Set(scopedAccounts.map((a: any) => a.id)),
    [scopedAccounts],
  );

  const filterByScope = <T extends { account_id?: string | null }>(rows: T[] | undefined): T[] => {
    if (!rows) return [];
    if (!providerKey) return rows;
    return rows.filter((r) => !r.account_id || scopedAccountIds.has(r.account_id));
  };

  return {
    providerKey,
    accountId,
    account,
    scopedAccounts,
    allAccounts,
    isScoped: !!providerKey,
    isLoading,
    setProviderScope,
    setAccountScope,
    clearScope,
    filterByScope,
  };
};

/** Provider key of an account record, re-exported for convenience. */
export { providerKeyOf };
