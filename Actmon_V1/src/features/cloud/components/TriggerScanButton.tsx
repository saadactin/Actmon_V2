import React from 'react';
import { useTriggerDiscovery } from '../hooks/useDiscovery';
import { Button, Spinner } from '@fluentui/react-components';
import { Search } from 'lucide-react';
import { useCloudStore } from '../state/cloudStore';
import { usePermissions } from '../../../hooks/usePermissions';

interface Props {
  accountId: string;
}

export const TriggerScanButton: React.FC<Props> = ({ accountId }) => {
  const { mutate: triggerScan, isPending } = useTriggerDiscovery();
  const activeJobId = useCloudStore(state => state.activeDiscoveryJobs[accountId]);
  const { canHere } = usePermissions();

  const handleScan = () => {
    triggerScan(accountId);
  };

  // Running discovery is a state-changing action → requires Execute on this page.
  if (!canHere('execute')) return null;

  return (
    <Button 
      appearance="primary" 
      icon={isPending || activeJobId ? <Spinner size="tiny" /> : <Search className="h-4 w-4" />} 
      onClick={handleScan}
      disabled={isPending || !!activeJobId}
    >
      {activeJobId ? 'Scan Running...' : 'Run Discovery Scan'}
    </Button>
  );
};
