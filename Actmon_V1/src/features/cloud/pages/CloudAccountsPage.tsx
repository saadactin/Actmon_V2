import React from 'react';
import { CloudAccountList } from '../components/CloudAccountList';
import { AddCloudAccountForm } from '../components/AddCloudAccountForm';
import { DrawerPanel } from '../../../components/ui/DrawerPanel';
import { useCloudStore } from '../state/cloudStore';
import { Button } from '@fluentui/react-components';
import { Plus } from 'lucide-react';

const PAGE_STYLE: React.CSSProperties = {
  minHeight: '100vh',
  background: 'linear-gradient(160deg, #0d1117 0%, #0f1923 50%, #0d1117 100%)',
  padding: '28px 32px',
  fontFamily: "'Inter', -apple-system, sans-serif",
};

const UI_BTN_STYLE: React.CSSProperties = {
  background: 'rgba(255,255,255,0.05)',
  border: '1px solid rgba(255,255,255,0.1)',
  color: '#cbd5e1',
};

export const CloudAccountsPage = () => {
  const isDrawerOpen = useCloudStore(state => state.isAddAccountDrawerOpen);
  const setDrawerOpen = useCloudStore(state => state.setAddAccountDrawerOpen);

  return (
    <div style={PAGE_STYLE}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24, flexWrap: 'wrap', gap: 16 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 28, fontWeight: 800, color: '#f1f5f9', letterSpacing: -0.5 }}>
            ☁️ Cloud Accounts
          </h1>
          <p style={{ margin: '6px 0 0', color: '#64748b', fontSize: 14 }}>
            Manage connections to AWS, Azure, and OCI.
          </p>
        </div>
        <Button appearance="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setDrawerOpen(true)}>
          Add Account
        </Button>
      </div>

      <div style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 16, padding: '20px 24px' }}>
        <CloudAccountList />
      </div>

      <DrawerPanel
        open={isDrawerOpen}
        onClose={() => setDrawerOpen(false)}
        title="Connect Cloud Provider"
      >
        <AddCloudAccountForm onSuccess={() => setDrawerOpen(false)} />
      </DrawerPanel>
    </div>
  );
};
