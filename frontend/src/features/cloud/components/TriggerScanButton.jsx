import { useTriggerDiscovery } from '../hooks/useDiscovery';
import { useCloudStore } from '../state/cloudStore';
import { usePermissions } from '@/hooks/usePermissions';
import Button from '@/components/ui/Button';

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
    <Button
      type="button"
      variant="primary"
      icon="refresh"
      loading={isScanning}
      onClick={handleScan}
    >
      {activeJobId ? 'Scan Running...' : 'Run Discovery Scan'}
    </Button>
  );
};
