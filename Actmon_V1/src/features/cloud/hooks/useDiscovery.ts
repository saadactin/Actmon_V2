import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { triggerDiscovery, getDiscoveryStatus } from '../api/discovery.api';
import { DiscoveryJob } from '../types/cloud';
import { useCloudStore } from '../state/cloudStore';

export const useTriggerDiscovery = () => {
  const queryClient = useQueryClient();
  const setActiveDiscoveryJob = useCloudStore((state) => state.setActiveDiscoveryJob);

  return useMutation({
    mutationFn: (accountId: string) => triggerDiscovery(accountId),
    onSuccess: (data, accountId) => {
      // Store the active job in UI state
      setActiveDiscoveryJob(accountId, data.id);
      // Invalidate status query to start polling immediately
      queryClient.invalidateQueries({ queryKey: ['discoveryStatus', data.id] });
    },
    onError: (error: any) => {
      console.error('Discovery trigger failed:', error);
      alert('Failed to trigger discovery: ' + (error?.response?.data?.detail || error.message));
    }
  });
};

export const useDiscoveryStatus = (jobId: string | null) => {
  return useQuery<DiscoveryJob | null>({
    queryKey: ['discoveryStatus', jobId],
    queryFn: () => (jobId ? getDiscoveryStatus(jobId) : Promise.resolve(null)),
    enabled: !!jobId,
    // Poll every 5 seconds if running/pending
    refetchInterval: (query: any) => {
      const data = query?.state?.data;
      if (!data) return 5000;
      const status = data.status;
      if (status === 'RUNNING' || status === 'PENDING') return 5000;
      return false;
    },
  });
};
