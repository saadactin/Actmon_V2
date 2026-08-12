import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getCloudAccounts, createCloudAccount, deleteCloudAccount, getAccountDiagnostics,
} from '../api/cloudAccounts.api';

export const useCloudAccounts = () => useQuery({
  queryKey: ['cloudAccounts'],
  queryFn: getCloudAccounts,
});

export const useCreateCloudAccount = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload) => createCloudAccount(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cloudAccounts'] });
    },
  });
};

export const useDeleteCloudAccount = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (accountId) => deleteCloudAccount(accountId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cloudAccounts'] });
    },
  });
};

// Lazy — only fetched when a diagnostic popup is actually opened (`enabled`),
// not on every page load, since it's purely explanatory.
export const useAccountDiagnostics = (accountId, enabled) => useQuery({
  queryKey: ['accountDiagnostics', accountId],
  queryFn: () => getAccountDiagnostics(accountId),
  enabled: enabled && !!accountId,
  staleTime: 10_000,
});
