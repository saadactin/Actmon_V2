import React from 'react';
import { CloudAccountList } from '../components/CloudAccountList';
import { useCloudStore } from '../state/cloudStore';
import { Button } from '@fluentui/react-components';
import { Plus } from 'lucide-react';
import { usePermissions } from '../../../hooks/usePermissions';

const PAGE_STYLE: React.CSSProperties = {
  minHeight: '100%',
  background: '#f1f5f9',
  padding: '28px 32px',
  fontFamily: "'Inter', -apple-system, sans-serif",
};

const UI_BTN_STYLE: React.CSSProperties = {
  background: '#ffffff',
  border: '1px solid #e2e8f0',
  color: '#475569',
};

export const CloudAccountsPage = () => {
  const setDrawerOpen = useCloudStore(state => state.setAddAccountDrawerOpen);
  const { canHere } = usePermissions();

  return (
    <div style={PAGE_STYLE}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24, flexWrap: 'wrap', gap: 16 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 28, fontWeight: 800, color: '#1e293b', letterSpacing: -0.5 }}>
            ☁️ Cloud Accounts
          </h1>
          <p style={{ margin: '6px 0 0', color: '#64748b', fontSize: 14 }}>
            Manage connections to AWS, Azure, and OCI.
          </p>
        </div>
        {canHere('add') && (
          <Button appearance="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setDrawerOpen(true)}>
            Add Account
          </Button>
        )}
      </div>

      <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 16, padding: '20px 24px' }}>
        <CloudAccountList />
      </div>
    </div>
  );
};
