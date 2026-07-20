import React, { useEffect } from 'react';
import { ResourceTable } from '../components/ResourceTable';
import { TriggerScanButton } from '../components/TriggerScanButton';
import { DiscoveryStatus } from '../components/DiscoveryStatus';
import { CloudProviderSelector } from '../components/CloudProviderSelector';
import { useCloudAccounts } from '../hooks/useCloudAccounts';
import { useCloudStore } from '../state/cloudStore';
import { useNavigate } from 'react-router-dom';
import { Boxes, Cloud, Layers, MapPin, Clock, RefreshCw } from 'lucide-react';

const SUMMARY_ICONS = {
  Provider: Cloud,
  Environment: Layers,
  Region: MapPin,
  'Last Scan': Clock,
  'Auto Discovery': RefreshCw,
} as const;

export const ResourcesPage = () => {
  const navigate = useNavigate();
  const { data: accounts } = useCloudAccounts();
  const selectedAccountId = useCloudStore(state => state.selectedAccountId);
  const setSelectedAccountId = useCloudStore(state => state.setSelectedAccountId);
  const setDrawerOpen = useCloudStore(state => state.setAddAccountDrawerOpen);

  useEffect(() => {
    if (!selectedAccountId && accounts && accounts.length > 0) {
      setSelectedAccountId(accounts[0].id);
    }
  }, [accounts, selectedAccountId, setSelectedAccountId]);

  const selectedAccount = accounts?.find(a => a.id === selectedAccountId);

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
              ? `Discovered assets across your cloud providers`
              : 'Connect a cloud account to view resources'}
          </p>
        </div>

        {/* Standardized provider selector + scan button */}
        {accounts && accounts.length > 0 && (
          <CloudProviderSelector
            accounts={accounts}
            mode="single"
            selected={selectedAccountId}
            onSelect={id => id && setSelectedAccountId(id)}
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
            { label: 'Provider' as const, value: selectedAccount.provider },
            { label: 'Environment' as const, value: selectedAccount.environment || 'N/A' },
            { label: 'Region' as const, value: selectedAccount.tenant_or_region || 'N/A' },
            { label: 'Last Scan' as const, value: selectedAccount.last_discovery ? new Date(selectedAccount.last_discovery).toLocaleString() : 'Never' },
            { label: 'Auto Discovery' as const, value: selectedAccount.auto_discovery ? 'Enabled' : 'Disabled' },
          ].map(stat => {
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
