import React from 'react';
import { CloudAccountList } from '../components/CloudAccountList';
import { useCloudStore } from '../state/cloudStore';
import { Cloud, Plus } from 'lucide-react';
import { usePermissions } from '../../../hooks/usePermissions';

export const CloudAccountsPage = () => {
  const setDrawerOpen = useCloudStore(state => state.setAddAccountDrawerOpen);
  const { canHere } = usePermissions();

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2.5">
            <span className="p-2 rounded-lg bg-blue-50 text-blue-600">
              <Cloud className="h-5 w-5" />
            </span>
            Cloud Accounts
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Manage connections to AWS, Azure, and OCI.
          </p>
        </div>
        {canHere('add') && (
          <button
            onClick={() => setDrawerOpen(true)}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 transition-colors"
          >
            <Plus className="h-4 w-4" />
            Add Account
          </button>
        )}
      </div>

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
        <CloudAccountList />
      </div>
    </div>
  );
};
