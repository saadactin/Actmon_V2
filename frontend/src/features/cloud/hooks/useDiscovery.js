import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { triggerDiscovery, triggerAllDiscovery, getDiscoveryStatus } from '../api/discovery.api';
import { useCloudStore } from '../state/cloudStore';

export const useTriggerDiscovery = () => {
  const queryClient = useQueryClient();
  const setActiveDiscoveryJob = useCloudStore((state) => state.setActiveDiscoveryJob);

  return useMutation({
    mutationFn: (accountId) => triggerDiscovery(accountId),
    onSuccess: (data, accountId) => {
      // Store the active job in UI state
      setActiveDiscoveryJob(accountId, data.id);
      // Invalidate status query to start polling immediately
      queryClient.invalidateQueries({ queryKey: ['discoveryStatus', data.id] });
    },
    onError: (error) => {
      console.error('Discovery trigger failed:', error);
      alert(`Failed to trigger discovery: ${error?.response?.data?.detail || error.message}`);
    },
  });
};

export const useTriggerAllDiscovery = () => {
  const queryClient = useQueryClient();
  const setActiveDiscoveryJob = useCloudStore((state) => state.setActiveDiscoveryJob);

  return useMutation({
    mutationFn: () => triggerAllDiscovery(),
    onSuccess: (jobs) => {
      // Register every returned job so the global watcher polls each one.
      jobs.forEach((job) => {
        setActiveDiscoveryJob(job.account_id, job.id);
        queryClient.invalidateQueries({ queryKey: ['discoveryStatus', job.id] });
      });
    },
    onError: (error) => {
      console.error('Scan-all trigger failed:', error);
      alert(`Failed to start scan for all accounts: ${error?.response?.data?.detail || error.message}`);
    },
  });
};

export const useDiscoveryStatus = (jobId) => useQuery({
  queryKey: ['discoveryStatus', jobId],
  queryFn: () => (jobId ? getDiscoveryStatus(jobId) : Promise.resolve(null)),
  enabled: !!jobId,
  // Poll every 5 seconds if running/pending
  refetchInterval: (query) => {
    const data = query?.state?.data;
    if (!data) return 5000;
    const { status } = data;
    if (status === 'RUNNING' || status === 'PENDING') return 5000;
    return false;
  },
});
