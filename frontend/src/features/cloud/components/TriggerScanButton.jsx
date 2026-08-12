import { useTriggerDiscovery } from '../hooks/useDiscovery';
import { RefreshCw } from 'lucide-react';
import { useCloudStore } from '../state/cloudStore';
import { usePermissions } from '@/hooks/usePermissions';

export const TriggerScanButton = ({ accountId }) => {
  const { mutate: triggerScan, isPending } = useTriggerDiscovery();
  const activeJobId = useCloudStore((state) => state.activeDiscoveryJobs[accountId]);
  const { canHere } = usePermissions();

  const handleScan = () => {
    triggerScan(accountId);
  };

  // Running discovery is a state-changing action → requires Execute on this page.
  if (!canHere('execute')) return null;

  const isScanning = isPending || !!activeJobId;

  return (
    <button
      type="button"
      onClick={handleScan}
      disabled={isScanning}
      className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold bg-blue-600 text-white hover:bg-blue-700 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
    >
      <RefreshCw className={`h-4 w-4 ${isScanning ? 'animate-spin' : ''}`} />
      {activeJobId ? 'Scan Running...' : 'Run Discovery Scan'}
    </button>
  );
};
