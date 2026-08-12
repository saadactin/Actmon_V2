import { useNavigate } from 'react-router-dom';
import { useCloudAccounts, useDeleteCloudAccount } from '../hooks/useCloudAccounts';
import { useCloudScope } from '../hooks/useCloudScope';
import { useCloudStore } from '../state/cloudStore';
import { Cloud, Trash2, Loader2 } from 'lucide-react';
import { formatDate } from '../utils/formatters';
import { usePermissions } from '@/hooks/usePermissions';

function providerBadgeClass(provider) {
  const p = (provider || '').toLowerCase();
  if (p.includes('azure')) return 'bg-sky-50 text-sky-700 border-sky-200';
  if (p.includes('aws')) return 'bg-orange-50 text-orange-700 border-orange-200';
  if (p.includes('oci') || p.includes('oracle')) return 'bg-red-50 text-red-700 border-red-200';
  return 'bg-gray-100 text-gray-600 border-gray-200';
}

export const CloudAccountList = () => {
  const { isLoading } = useCloudAccounts();
  const { mutate: deleteAccount } = useDeleteCloudAccount();
  const { selectedAccountId, setSelectedAccountId } = useCloudStore();
  // Only list accounts for the provider currently scoped (all when unscoped).
  const scope = useCloudScope();
  const accounts = scope.scopedAccounts;
  const { canHere } = usePermissions();
  const navigate = useNavigate();

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-3">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
        <span className="text-sm text-gray-500">Loading accounts…</span>
      </div>
    );
  }

  if (!accounts || accounts.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-gray-300 py-12 text-center">
        <Cloud className="h-10 w-10 text-gray-300 mx-auto mb-3" />
        <h3 className="text-base font-semibold text-gray-900">No Cloud Accounts</h3>
        <p className="text-sm text-gray-500 mt-1">Connect a provider to get started.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {accounts.map((acc) => {
        const isSelected = selectedAccountId === acc.id;
        return (
          <div
            key={acc.id}
            className={`flex items-center justify-between px-5 py-4 rounded-xl border cursor-pointer transition-colors ${
              isSelected
                ? 'ring-2 ring-blue-500 border-blue-300 bg-blue-50/40'
                : 'bg-white border-gray-200 shadow-sm hover:bg-gray-50'
            }`}
            onClick={() => {
              setSelectedAccountId(acc.id);
              navigate('/cloud/resources');
            }}
          >
            <div>
              <div className="flex items-center gap-2">
                <span className="text-[15px] font-semibold text-gray-900">{acc.account_name}</span>
                <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-semibold border uppercase ${providerBadgeClass(acc.provider)}`}>
                  {acc.provider}
                </span>
              </div>
              <div className="mt-1 text-xs text-gray-500">
                {acc.environment ? <>{acc.environment} &bull; </> : null}
                Region: {acc.tenant_or_region || 'NA'}
                <span className="text-gray-400"> &bull; Last Scan: {acc.last_discovery ? formatDate(acc.last_discovery) : 'NA'}</span>
              </div>
            </div>
            {canHere('delete') && (
              <button
                type="button"
                aria-label="Delete account"
                className="p-2 rounded-lg text-red-600 hover:bg-red-50 transition-colors"
                onClick={(e) => { e.stopPropagation(); deleteAccount(acc.id); }}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
};
