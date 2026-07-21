import React, { useEffect } from 'react';
import { useDiscoveryStatus } from '../hooks/useDiscovery';
import { useCloudStore } from '../state/cloudStore';
import { Spinner, ProgressBar } from '@fluentui/react-components';
import { CheckCircle, XCircle } from 'lucide-react';
import { useToast } from '../../../components/ui/ToastProvider';
import { useQueryClient } from '@tanstack/react-query';

interface Props {
  accountId: string;
}

export const DiscoveryStatus: React.FC<Props> = ({ accountId }) => {
  const activeJobId = useCloudStore(state => state.activeDiscoveryJobs[accountId]);
  const setActiveDiscoveryJob = useCloudStore(state => state.setActiveDiscoveryJob);
  const { data: job, isLoading } = useDiscoveryStatus(activeJobId);
  const { addToast } = useToast();

  const queryClient = useQueryClient();

  useEffect(() => {
    if (job?.status === 'COMPLETED') {
      addToast(`Discovery completed. Found ${job.resources_found} resources.`, 'success');
      setActiveDiscoveryJob(accountId, null); // Clear active job
      queryClient.invalidateQueries({ queryKey: ['resources', accountId] }); // Fetch new resources
    } else if (job?.status === 'FAILED') {
      addToast(`Discovery failed: ${job.error_message}`, 'error');
      setActiveDiscoveryJob(accountId, null); // Clear active job
    }
  }, [job?.status, accountId, setActiveDiscoveryJob, addToast, queryClient]);

  if (!activeJobId) return null;

  return (
    <div className="bg-blue-50 border border-blue-200 p-4 rounded-md flex flex-col gap-2">
      <div className="flex items-center justify-between text-sm text-blue-800 font-semibold">
        <span>Discovery Scan in Progress...</span>
        {isLoading || job?.status === 'RUNNING' || job?.status === 'PENDING' ? (
          <Spinner size="tiny" />
        ) : job?.status === 'COMPLETED' ? (
          <CheckCircle className="h-4 w-4 text-green-600" />
        ) : (
          <XCircle className="h-4 w-4 text-red-600" />
        )}
      </div>
      <ProgressBar value={job?.status === 'COMPLETED' ? 1 : undefined} />
    </div>
  );
};
