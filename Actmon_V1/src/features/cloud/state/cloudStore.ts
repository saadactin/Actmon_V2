import { create } from 'zustand';
import { CloudAccount } from '../types/cloud';
import { CloudResource } from '../types/resource';

// ── Scope persistence ────────────────────────────────────────────────────────
// The provider/account you pick in the chooser has to survive tab navigation and
// a page reload, otherwise every tab falls back to accounts[0] and shows another
// provider's data. Kept in localStorage rather than the URL so the existing flat
// tab routes (/cloud/cost, /cloud/resources, …) keep working unchanged.
const SCOPE_PROVIDER_KEY = 'actmon_cloud_scope_provider';
const SCOPE_ACCOUNT_KEY = 'actmon_cloud_scope_account';

const readScope = (key: string): string | null => {
  try {
    const v = localStorage.getItem(key);
    return v && v !== 'null' ? v : null;
  } catch {
    return null; // private-mode / storage-disabled: scope just won't persist
  }
};

const writeScope = (key: string, value: string | null) => {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch { /* non-fatal */ }
};

interface CloudState {
  // Accounts
  selectedAccountId: string | null;
  setSelectedAccountId: (id: string | null) => void;

  /** Provider the user drilled into ('AWS' | 'Azure' | 'OCI'), or null for all. */
  scopeProviderKey: string | null;
  setScopeProviderKey: (key: string | null) => void;
  /** Clear both provider and account scope (the "All providers" action). */
  clearScope: () => void;

  // UI State for Drawers/Modals
  isAddAccountDrawerOpen: boolean;
  setAddAccountDrawerOpen: (isOpen: boolean) => void;
  
  selectedResourceForDetail: string | null;
  setSelectedResourceForDetail: (id: string | null) => void;
  
  // Tracking active discovery jobs per account
  activeDiscoveryJobs: Record<string, string>; // accountId -> jobId
  setActiveDiscoveryJob: (accountId: string, jobId: string | null) => void;
}

export const useCloudStore = create<CloudState>((set) => ({
  selectedAccountId: readScope(SCOPE_ACCOUNT_KEY),
  setSelectedAccountId: (id) => {
    writeScope(SCOPE_ACCOUNT_KEY, id);
    set({ selectedAccountId: id });
  },

  scopeProviderKey: readScope(SCOPE_PROVIDER_KEY),
  setScopeProviderKey: (key) => {
    writeScope(SCOPE_PROVIDER_KEY, key);
    set({ scopeProviderKey: key });
  },
  clearScope: () => {
    writeScope(SCOPE_PROVIDER_KEY, null);
    writeScope(SCOPE_ACCOUNT_KEY, null);
    set({ scopeProviderKey: null, selectedAccountId: null });
  },

  isAddAccountDrawerOpen: false,
  setAddAccountDrawerOpen: (isOpen) => set({ isAddAccountDrawerOpen: isOpen }),

  selectedResourceForDetail: null,
  setSelectedResourceForDetail: (id) => set({ selectedResourceForDetail: id }),

  activeDiscoveryJobs: {},
  setActiveDiscoveryJob: (accountId, jobId) => set((state) => {
    const newJobs = { ...state.activeDiscoveryJobs };
    if (jobId === null) {
      delete newJobs[accountId];
    } else {
      newJobs[accountId] = jobId;
    }
    return { activeDiscoveryJobs: newJobs };
  }),
}));
