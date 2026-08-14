import { useEffect } from 'react';
import { Outlet, useLocation, useParams } from 'react-router-dom';
import { useCloudStore } from '../state/cloudStore';
import { keyFromSlug } from '../utils/providerScope';
import Drawer from '@/components/ui/Drawer';
import Toasts, { useToasts } from '@/components/ui/Toast';
import { AddCloudAccountForm } from './AddCloudAccountForm';
import { DiscoveryWatcher } from './DiscoveryWatcher';
import { usePermissions } from '@/hooks/usePermissions';

// /cloud/aws-accounts, /cloud/azure-accounts/:accountId, … — `provider` is a
// literal path segment (not a dynamic route param, see App.jsx), so it's
// parsed from the pathname directly rather than read off useParams().
const PROVIDER_PATH_RE = /^\/cloud\/(aws|azure|oci)-accounts(?:\/|$)/;

/**
 * Mirror the provider/account in the URL into the persisted scope.
 *
 * Deep links (/cloud/aws-accounts/acct-123, …) carry no provider segment on
 * some sibling routes, so without this the scope would be lost the moment you
 * left the account dashboard. Landing on /cloud (the chooser) clears the
 * scope, which is what makes "All providers" the natural reset.
 */
const useSyncScopeFromUrl = () => {
  const { pathname } = useLocation();
  const { accountId: routeAccountId } = useParams();
  const providerSlug = pathname.match(PROVIDER_PATH_RE)?.[1] ?? null;
  const setProviderScope = useCloudStore((s) => s.setScopeProviderKey);
  const setAccountScope = useCloudStore((s) => s.setSelectedAccountId);
  const clearScope = useCloudStore((s) => s.clearScope);

  useEffect(() => {
    // Provider chooser is the "everything" view — drop any previous scope.
    if (pathname.replace(/\/+$/, '') === '/cloud') {
      clearScope();
      return;
    }
    const key = keyFromSlug(providerSlug);
    if (key) setProviderScope(key);
    if (routeAccountId) setAccountScope(routeAccountId);
  }, [pathname, providerSlug, routeAccountId, setProviderScope, setAccountScope, clearScope]);
};

/**
 * Layout wrapper for all /cloud/* routes.
 *
 * Owns no header or navigation chrome of its own — the Cloud hub (the /cloud
 * landing page) links to each section directly, the same way Databases has
 * no persistent sub-nav of its own between its tech list and a server's
 * dashboard. Every page renders its own CloudPageHeader with a `backTo="/cloud"`
 * link back to that hub. This shell is only cross-cutting state: scope sync,
 * discovery polling, toasts, and the add-account drawer.
 */
export const CloudShell = () => {
  const isDrawerOpen = useCloudStore((s) => s.isAddAccountDrawerOpen);
  const setDrawerOpen = useCloudStore((s) => s.setAddAccountDrawerOpen);
  const { canHere } = usePermissions();
  const canAdd = canHere('add');
  useSyncScopeFromUrl();
  const { toasts, push, dismiss } = useToasts();

  return (
    <>
      {/* Always-on watcher: live resource refresh + completion toasts on every page */}
      <DiscoveryWatcher push={push} />
      <Toasts toasts={toasts} onDismiss={dismiss} />

      <Outlet context={{ push }} />

      {/* Add Cloud Account drawer (global — works from any cloud page; add-gated) */}
      <Drawer open={isDrawerOpen && canAdd} onClose={() => setDrawerOpen(false)} title="Connect a Cloud Provider">
        <AddCloudAccountForm onSuccess={() => setDrawerOpen(false)} push={push} />
      </Drawer>
    </>
  );
};
