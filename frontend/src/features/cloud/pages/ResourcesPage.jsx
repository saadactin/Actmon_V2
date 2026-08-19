import { useNavigate } from 'react-router-dom';
import { ResourceTable } from '../components/ResourceTable';
import { TriggerScanButton } from '../components/TriggerScanButton';
import { DiscoveryStatus } from '../components/DiscoveryStatus';
import CloudPageHeader from '../components/CloudPageHeader';
import CloudToolbar from '../components/CloudToolbar';
import { useCloudScope } from '../hooks/useCloudScope';
import { accountLocation } from '../utils/regions';
import { useCloudStore } from '../state/cloudStore';
import { Cloud, Layers, MapPin, Clock, RefreshCw } from 'lucide-react';

const SUMMARY_ICONS = {
  Provider: Cloud,
  Environment: Layers,
  Region: MapPin,
  // Same slot, different meaning when the account carries a tenant GUID.
  Tenant: MapPin,
  'Last Scan': Clock,
  'Auto Discovery': RefreshCw,
};

export const ResourcesPage = ({ embedded = false }) => {
  const navigate = useNavigate();
  const setDrawerOpen = useCloudStore((state) => state.setAddAccountDrawerOpen);

  // Scope-aware: inside a provider, only that provider's accounts are offered and
  // the selected account is always one of them (never a stale cross-provider id).
  // When embedded (a tab of one account's own dashboard), the scope is already
  // fixed by the route — see CloudDashboard.jsx / useSyncScopeFromUrl.
  const scope = useCloudScope();
  const accounts = scope.scopedAccounts;
  const selectedAccountId = scope.accountId;
  const setSelectedAccountId = scope.setAccountScope;
  const selectedAccount = scope.account;

  const handleAddAccount = () => {
    navigate('/cloud/accounts');
    setTimeout(() => setDrawerOpen(true), 100);
  };

  return (
    <>
      {embedded ? (
        selectedAccountId && (
          <div className="mb-4 flex justify-end">
            <TriggerScanButton accountId={selectedAccountId} />
          </div>
        )
      ) : (
        <CloudPageHeader
          backTo="/cloud"
          title="Resource Inventory"
          description={
            accounts && accounts.length > 0
              ? (scope.isScoped
                ? `Discovered assets in ${scope.providerKey} · ${accounts.length} account${accounts.length > 1 ? 's' : ''}`
                : 'Discovered assets across your cloud providers')
              : scope.isScoped
                ? `No ${scope.providerKey} accounts connected yet`
                : 'Connect a cloud account to view resources'
          }
          icon="boxes"
          actions={accounts && accounts.length > 0 ? (
            <CloudToolbar
              selectorProps={{
                accounts,
                mode: 'single',
                selected: selectedAccountId,
                onSelect: (id) => id && setSelectedAccountId(id),
                onAddAccount: handleAddAccount,
              }}
            >
              {selectedAccountId ? <TriggerScanButton accountId={selectedAccountId} /> : undefined}
            </CloudToolbar>
          ) : undefined}
        />
      )}

      <div className="space-y-6">
        {/* Discovery status */}
        {selectedAccountId && (
          <DiscoveryStatus accountId={selectedAccountId} />
        )}

        {/* Account summary card */}
        {selectedAccount && (
          <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(180px,1fr))]">
            {[
              { label: 'Provider', value: selectedAccount.provider },
              { label: 'Environment', value: selectedAccount.environment || 'N/A' },
              // Azure accounts may store a tenant GUID here rather than a region.
              { label: accountLocation(selectedAccount).kind === 'tenant' ? 'Tenant' : 'Region',
                value: accountLocation(selectedAccount).text },
              { label: 'Last Scan', value: selectedAccount.last_discovery ? new Date(selectedAccount.last_discovery).toLocaleString() : 'Never' },
              { label: 'Auto Discovery', value: selectedAccount.auto_discovery ? 'Enabled' : 'Disabled' },
            ].map((stat) => {
              const Icon = SUMMARY_ICONS[stat.label];
              return (
                <div key={stat.label} className="card px-4 py-3.5">
                  <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted">
                    <Icon className="h-3.5 w-3.5 text-subtle" />
                    {stat.label}
                  </div>
                  <div className="text-sm font-semibold text-fg">{stat.value}</div>
                </div>
              );
            })}
          </div>
        )}

        {/* Resource table */}
        {selectedAccountId && (
          <ResourceTable accountId={selectedAccountId} />
        )}

        {!selectedAccountId && (
          <div className="card flex flex-col items-center justify-center py-12 text-center">
            <Cloud className="mx-auto mb-3 h-10 w-10 text-subtle" />
            <h3 className="text-base font-semibold text-fg">No account selected</h3>
            <p className="mt-1 text-sm text-muted">Add a cloud account to start discovering resources</p>
          </div>
        )}
      </div>
    </>
  );
};
