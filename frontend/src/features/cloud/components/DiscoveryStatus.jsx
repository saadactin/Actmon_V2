import { useDiscoveryStatus } from '../hooks/useDiscovery';
import { useCloudStore } from '../state/cloudStore';
import { CheckCircle2, Loader2, XCircle } from 'lucide-react';
import Badge from '@/components/ui/Badge';

// Display-only badge. All discovery side-effects (live resource refresh, toasts,
// clearing finished jobs) are owned by the global <DiscoveryWatcher/> so they
// fire on every page, not only where this badge is mounted.
export const DiscoveryStatus = ({ accountId }) => {
  const activeJobId = useCloudStore((state) => state.activeDiscoveryJobs[accountId]);
  const { data: job, isLoading } = useDiscoveryStatus(activeJobId);
  const runningCount = job?.resources_found ?? 0;

  if (!activeJobId) return null;

  const isRunning = isLoading || job?.status === 'RUNNING' || job?.status === 'PENDING';

  return (
    <div className="flex items-center gap-2">
      {isRunning ? (
        <Badge tone="info" size="sm">
          <Loader2 size={12} className="animate-spin" />
          Discovery running{runningCount > 0 ? ` · ${runningCount} resources found` : ' · starting…'}
        </Badge>
      ) : job?.status === 'COMPLETED' ? (
        <Badge tone="success" size="sm">
          <CheckCircle2 size={12} />
          Discovery completed
        </Badge>
      ) : (
        <Badge tone="danger" size="sm">
          <XCircle size={12} />
          Discovery failed
        </Badge>
      )}
      {job?.started_at && (
        <span className="text-xs text-subtle">
          Started {new Date(job.started_at).toLocaleTimeString()}
        </span>
      )}
    </div>
  );
};
