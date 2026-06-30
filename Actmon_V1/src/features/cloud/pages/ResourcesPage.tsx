import React, { useEffect } from 'react';
import { ResourceTable } from '../components/ResourceTable';
import { TriggerScanButton } from '../components/TriggerScanButton';
import { DiscoveryStatus } from '../components/DiscoveryStatus';
import { CloudProviderSelector } from '../components/CloudProviderSelector';
import { useCloudAccounts } from '../hooks/useCloudAccounts';
import { useCloudStore } from '../state/cloudStore';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';

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
    <div style={PAGE_STYLE}>
      {/* Header */}
      <div style={{ marginBottom: 28 }}>
        <button onClick={() => navigate('/cloud')} style={BACK_BTN}>
          <ArrowLeft size={14} /> Cloud Control Center
        </button>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginTop: 10, flexWrap: 'wrap', gap: 14 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 26, fontWeight: 800, color: '#1e293b', letterSpacing: -0.5 }}>
              ☁️ Resource Inventory
            </h1>
            <p style={{ margin: '6px 0 0', color: '#64748b', fontSize: 14 }}>
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
      </div>

      {/* Discovery status */}
      {selectedAccountId && (
        <div style={{ marginBottom: 20 }}>
          <DiscoveryStatus accountId={selectedAccountId} />
        </div>
      )}

      {/* Account summary card */}
      {selectedAccount && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: 14,
          marginBottom: 24,
        }}>
          {[
            { label: 'Provider', value: selectedAccount.provider, icon: '☁️' },
            { label: 'Environment', value: selectedAccount.environment || 'N/A', icon: '🏗️' },
            { label: 'Region', value: selectedAccount.tenant_or_region || 'Multi', icon: '📍' },
            { label: 'Last Scan', value: selectedAccount.last_discovery ? new Date(selectedAccount.last_discovery).toLocaleString() : 'Never', icon: '🕐' },
            { label: 'Auto Discovery', value: selectedAccount.auto_discovery ? 'Enabled' : 'Disabled', icon: '🔄' },
          ].map(stat => (
            <div key={stat.label} style={{
              background: '#f8fafc',
              border: '1px solid #e2e8f0',
              borderRadius: 12,
              padding: '14px 18px',
            }}>
              <div style={{ color: '#64748b', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 4 }}>
                {stat.icon} {stat.label}
              </div>
              <div style={{ color: '#334155', fontSize: 14, fontWeight: 600 }}>{stat.value}</div>
            </div>
          ))}
        </div>
      )}

      {/* Resource table */}
      {selectedAccountId && (
        <ResourceTable accountId={selectedAccountId} />
      )}

      {!selectedAccountId && (
        <div style={{
          textAlign: 'center', padding: '80px 24px',
          background: '#f8fafc',
          border: '1px solid #e2e8f0',
          borderRadius: 20,
        }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>☁️</div>
          <h3 style={{ margin: 0, color: '#94a3b8', fontWeight: 600 }}>No account selected</h3>
          <p style={{ color: '#64748b', marginTop: 8 }}>Add a cloud account to start discovering resources</p>
        </div>
      )}
    </div>
  );
};

const PAGE_STYLE: React.CSSProperties = {
  minHeight: '100%',
  background: '#f1f5f9',
  padding: '28px 32px',
  fontFamily: "'Inter', -apple-system, sans-serif",
};

const BACK_BTN: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '6px 12px',
  background: '#ffffff',
  border: '1px solid #e2e8f0',
  borderRadius: 8,
  color: '#94a3b8',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
  fontFamily: 'inherit',
};
