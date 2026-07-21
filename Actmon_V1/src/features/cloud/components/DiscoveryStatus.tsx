import React from 'react';
import { useDiscoveryStatus } from '../hooks/useDiscovery';
import { useCloudStore } from '../state/cloudStore';
import { CheckCircle2, Loader2, XCircle } from 'lucide-react';

interface Props {
  accountId: string;
}

const PILL_BASE = 'inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-bold border';

// Display-only badge. All discovery side-effects (live resource refresh, toasts,
// clearing finished jobs) are owned by the global <DiscoveryWatcher/> so they
// fire on every page, not only where this badge is mounted.
export const DiscoveryStatus: React.FC<Props> = ({ accountId }) => {
  const activeJobId = useCloudStore(state => state.activeDiscoveryJobs[accountId]);
  const { data: job, isLoading } = useDiscoveryStatus(activeJobId);
  const runningCount = job?.resources_found ?? 0;

  if (!activeJobId) return null;

  const isRunning = isLoading || job?.status === 'RUNNING' || job?.status === 'PENDING';

  return (
    <div className="flex items-center gap-2">
      {isRunning ? (
        <span className={`${PILL_BASE} bg-blue-50 text-blue-700 border-blue-200`}>
          <Loader2 size={12} className="animate-spin" />
          Discovery running{runningCount > 0 ? ` · ${runningCount} resources found` : ' · starting…'}
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
