import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useDiscoveryStatus } from '../hooks/useDiscovery';
import { useCloudStore } from '../state/cloudStore';

/**
 * Headless, always-mounted watcher for every in-flight discovery job.
 *
 * Mounted once in CloudShell so live progress works on ALL cloud pages
 * (Dashboard, Cost, Security, …), not only the Resources page where the
 * DiscoveryStatus badge happens to render. It is the single owner of discovery
 * side-effects: refreshing the resource lists as batches land, and clearing +
 * toasting when a job finishes. DiscoveryStatus is display-only.
 *
 * `push` is CloudShell's own useToasts() emitter, passed down rather than a
 * global toast context.
 */
const JobWatcher = ({ accountId, jobId, push }) => {
  const { data: job } = useDiscoveryStatus(jobId);
  const setActiveDiscoveryJob = useCloudStore((s) => s.setActiveDiscoveryJob);
  const queryClient = useQueryClient();

  const runningCount = job?.resources_found ?? 0;

  // Live progress: refresh the resource tables as the backend commits batches.
  useEffect(() => {
    if ((job?.status === 'RUNNING' || job?.status === 'PENDING') && runningCount > 0) {
      queryClient.invalidateQueries({ queryKey: ['resources', accountId] });
      queryClient.invalidateQueries({ queryKey: ['allResources'] });
    }
  }, [runningCount, job?.status, accountId, queryClient]);

  // Terminal states: clear the active job (stops polling) and refresh everything.
  useEffect(() => {
    if (job?.status === 'COMPLETED') {
      push?.(`Discovery completed. Found ${job.resources_found} resources.`, 'success');
      setActiveDiscoveryJob(accountId, null);
      queryClient.invalidateQueries({ queryKey: ['resources', accountId] });
      queryClient.invalidateQueries({ queryKey: ['allResources'] });
      queryClient.invalidateQueries({ queryKey: ['cloudAccounts'] });
    } else if (job?.status === 'FAILED') {
      push?.(`Discovery failed: ${job.error_message || 'Unknown error'}`, 'error');
      setActiveDiscoveryJob(accountId, null);
    }
  }, [job?.status, accountId, setActiveDiscoveryJob, push, queryClient]);

  return null;
};

export const DiscoveryWatcher = ({ push }) => {
  const activeJobs = useCloudStore((s) => s.activeDiscoveryJobs);
  return (
    <>
      {Object.entries(activeJobs).map(([accountId, jobId]) => (
        <JobWatcher key={jobId} accountId={accountId} jobId={jobId} push={push} />
      ))}
    </>
  );
};
