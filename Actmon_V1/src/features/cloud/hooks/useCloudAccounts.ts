import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getCloudAccounts, createCloudAccount, deleteCloudAccount, getAccountDiagnostics } from '../api/cloudAccounts.api';
import { CloudAccount, CloudAccountCreatePayload } from '../types/cloud';

export const useCloudAccounts = () => {
  return useQuery<CloudAccount[]>({
    queryKey: ['cloudAccounts'],
    queryFn: getCloudAccounts,
  });
};

export const useCreateCloudAccount = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: CloudAccountCreatePayload) => createCloudAccount(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cloudAccounts'] });
    },
  });
};

export const useDeleteCloudAccount = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (accountId: string) => deleteCloudAccount(accountId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cloudAccounts'] });
    },
  });
};

// Lazy — only fetched when a diagnostic popup is actually opened (`enabled`),
// not on every page load, since it's purely explanatory.
export const useAccountDiagnostics = (accountId: string | null, enabled: boolean) => {
  return useQuery<any>({
    queryKey: ['accountDiagnostics', accountId],
    queryFn: () => getAccountDiagnostics(accountId as string),
    enabled: enabled && !!accountId,
    staleTime: 10_000,
  });
};
