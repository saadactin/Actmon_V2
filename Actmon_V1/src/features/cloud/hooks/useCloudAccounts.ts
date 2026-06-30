import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getCloudAccounts, createCloudAccount, deleteCloudAccount } from '../api/cloudAccounts.api';
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
