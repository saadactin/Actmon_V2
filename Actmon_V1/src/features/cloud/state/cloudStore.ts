import { create } from 'zustand';
import { CloudAccount } from '../types/cloud';
import { CloudResource } from '../types/resource';

interface CloudState {
  // Accounts
  selectedAccountId: string | null;
  setSelectedAccountId: (id: string | null) => void;

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
  selectedAccountId: null,
  setSelectedAccountId: (id) => set({ selectedAccountId: id }),

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
