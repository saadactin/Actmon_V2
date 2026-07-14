import React, { useEffect } from 'react';
import { useDiscoveryStatus } from '../hooks/useDiscovery';
import { useCloudStore } from '../state/cloudStore';
import { CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { useToast } from '../../../components/ui/ToastProvider';
import { useQueryClient } from '@tanstack/react-query';

interface Props {
  accountId: string;
}

const PILL_BASE = 'inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-bold border';

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

  const isRunning = isLoading || job?.status === 'RUNNING' || job?.status === 'PENDING';

  return (
    <div className="flex items-center gap-2">
      {isRunning ? (
        <span className={`${PILL_BASE} bg-blue-50 text-blue-700 border-blue-200`}>
          <Loader2 size={12} className="animate-spin" />
          Discovery running
        </span>
      ) : job?.status === 'COMPLETED' ? (
        <span className={`${PILL_BASE} bg-green-50 text-green-700 border-green-200`}>
          <CheckCircle2 size={12} />
          Discovery completed
        </span>
      ) : (
        <span className={`${PILL_BASE} bg-red-50 text-red-700 border-red-200`}>
          <XCircle size={12} />
          Discovery failed
        </span>
      )}
      {job?.started_at && (
        <span className="text-xs text-gray-400">
          Started {new Date(job.started_at).toLocaleTimeString()}
        </span>
      )}
    </div>
  );
};
