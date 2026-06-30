import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useCloudAccounts, useDeleteCloudAccount } from '../hooks/useCloudAccounts';
import { CloudAccount } from '../types/cloud';
import { useCloudStore } from '../state/cloudStore';
import { Cloud, Trash2 } from 'lucide-react';
import { Button, Spinner, Card } from '@fluentui/react-components';
import { formatDate } from '../utils/formatters';

export const CloudAccountList = () => {
  const { data: accounts, isLoading } = useCloudAccounts();
  const { mutate: deleteAccount } = useDeleteCloudAccount();
  const { selectedAccountId, setSelectedAccountId } = useCloudStore();
  const navigate = useNavigate();

  if (isLoading) {
    return <div className="flex justify-center p-8"><Spinner size="medium" /></div>;
  }

  if (!accounts || accounts.length === 0) {
    return (
      <div style={{ padding: 32, textAlign: 'center', border: '1px dashed rgba(255,255,255,0.1)', borderRadius: 12 }}>
        <Cloud className="h-12 w-12 text-gray-500 mx-auto mb-2" />
        <h3 style={{ fontWeight: 600, color: '#f1f5f9' }}>No Cloud Accounts</h3>
        <p style={{ fontSize: 14, color: '#94a3b8', marginTop: 4 }}>Connect a provider to get started.</p>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {accounts.map((acc: CloudAccount) => {
        const isSelected = selectedAccountId === acc.id;
        return (
          <div
            key={acc.id}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '16px 20px',
              background: isSelected ? 'rgba(59, 130, 246, 0.1)' : 'rgba(255,255,255,0.02)',
              border: isSelected ? '1px solid rgba(59, 130, 246, 0.4)' : '1px solid rgba(255,255,255,0.04)',
              borderRadius: 12,
              cursor: 'pointer',
              transition: 'background 0.2s',
            }}
            onClick={() => {
              setSelectedAccountId(acc.id);
              navigate('/cloud/resources');
            }}
          >
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontWeight: 600, color: '#f1f5f9', fontSize: 16 }}>{acc.account_name}</span>
                <span style={{ 
                  fontSize: 11, 
                  padding: '2px 6px', 
                  borderRadius: 4, 
                  background: 'rgba(255,255,255,0.1)', 
                  color: '#e2e8f0', 
                  fontWeight: 600, 
                  textTransform: 'uppercase' 
                }}>
                  {acc.provider}
                </span>
              </div>
              <div style={{ fontSize: 13, color: '#94a3b8', marginTop: 4 }}>
                Region: {acc.tenant_or_region} &bull; Last Scan: {formatDate(acc.last_discovery || '')}
              </div>
            </div>
            <Button 
              appearance="subtle" 
              icon={<Trash2 className="h-4 w-4 text-red-500" />} 
              onClick={(e) => { e.stopPropagation(); deleteAccount(acc.id); }}
            />
          </div>
        );
      })}
    </div>
  );
};
