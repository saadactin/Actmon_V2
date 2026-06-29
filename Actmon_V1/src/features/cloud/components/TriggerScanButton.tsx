import React from 'react';
import { useTriggerDiscovery } from '../hooks/useDiscovery';
import { Button, Spinner } from '@fluentui/react-components';
import { Search } from 'lucide-react';
import { useCloudStore } from '../state/cloudStore';

interface Props {
  accountId: string;
}

export const TriggerScanButton: React.FC<Props> = ({ accountId }) => {
  const { mutate: triggerScan, isPending } = useTriggerDiscovery();
  const activeJobId = useCloudStore(state => state.activeDiscoveryJobs[accountId]);

  const handleScan = () => {
    triggerScan(accountId);
  };

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
