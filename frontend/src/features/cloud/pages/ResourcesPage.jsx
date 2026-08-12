import { useNavigate } from 'react-router-dom';
import { ResourceTable } from '../components/ResourceTable';
import { TriggerScanButton } from '../components/TriggerScanButton';
import { DiscoveryStatus } from '../components/DiscoveryStatus';
import { CloudProviderSelector } from '../components/CloudProviderSelector';
import { useCloudScope } from '../hooks/useCloudScope';
import { useCloudStore } from '../state/cloudStore';
import { Boxes, Cloud, Layers, MapPin, Clock, RefreshCw } from 'lucide-react';

const SUMMARY_ICONS = {
  Provider: Cloud,
  Environment: Layers,
  Region: MapPin,
  'Last Scan': Clock,
  'Auto Discovery': RefreshCw,
};

export const ResourcesPage = () => {
  const navigate = useNavigate();
  const setDrawerOpen = useCloudStore((state) => state.setAddAccountDrawerOpen);

  // Scope-aware: inside a provider, only that provider's accounts are offered and
  // the selected account is always one of them (never a stale cross-provider id).
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
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2.5">
            <span className="p-2 rounded-lg bg-blue-50 text-blue-600">
              <Boxes className="h-5 w-5" />
            </span>
            Resource Inventory
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            {accounts && accounts.length > 0
              ? (scope.isScoped
                ? `Discovered assets in ${scope.providerKey} · ${accounts.length} account${accounts.length > 1 ? 's' : ''}`
                : 'Discovered assets across your cloud providers')
              : scope.isScoped
                ? `No ${scope.providerKey} accounts connected yet`
                : 'Connect a cloud account to view resources'}
          </p>
        </div>

        {/* Standardized provider selector + scan button */}
        {accounts && accounts.length > 0 && (
          <CloudProviderSelector
            accounts={accounts}
            mode="single"
            selected={selectedAccountId}
            onSelect={(id) => id && setSelectedAccountId(id)}
            onAddAccount={handleAddAccount}
            ScanButton={selectedAccountId ? <TriggerScanButton accountId={selectedAccountId} /> : undefined}
          />
        )}
      </div>

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
            { label: 'Region', value: selectedAccount.tenant_or_region || 'N/A' },
            { label: 'Last Scan', value: selectedAccount.last_discovery ? new Date(selectedAccount.last_discovery).toLocaleString() : 'Never' },
            { label: 'Auto Discovery', value: selectedAccount.auto_discovery ? 'Enabled' : 'Disabled' },
          ].map((stat) => {
            const Icon = SUMMARY_ICONS[stat.label];
            return (
              <div key={stat.label} className="bg-white rounded-xl border border-gray-200 shadow-sm px-4 py-3.5">
                <div className="flex items-center gap-1.5 text-[11px] font-semibold text-gray-500 uppercase tracking-wider mb-1">
                  <Icon className="h-3.5 w-3.5 text-gray-400" />
                  {stat.label}
                </div>
                <div className="text-sm font-semibold text-gray-900">{stat.value}</div>
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
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm py-12 text-center">
          <Cloud className="h-10 w-10 text-gray-300 mx-auto mb-3" />
          <h3 className="text-base font-semibold text-gray-900">No account selected</h3>
          <p className="text-sm text-gray-500 mt-1">Add a cloud account to start discovering resources</p>
        </div>
      )}
    </div>
  );
};
