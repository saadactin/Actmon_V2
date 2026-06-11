import { useState, useEffect } from 'react';
import { DrawerPanel } from '../../components/ui/DrawerPanel';
import { Spinner } from '@fluentui/react-components';
import { analyzeResource } from '../../api/cloud';
import { useToast } from '../../components/ui/ToastProvider';
import EC2DetailPanel from '../../components/cloud/EC2DetailPanel';
import LambdaDetailPanel from '../../components/cloud/LambdaDetailPanel';
import S3DetailPanel from '../../components/cloud/S3DetailPanel';
import DynamoDBDetailPanel from '../../components/cloud/DynamoDBDetailPanel';

export default function ResourceDetailDrawer({ open, onClose, resource, accountId, provider }) {
  const [loading, setLoading] = useState(false);
  const [analysisData, setAnalysisData] = useState(null);
  const [error, setError] = useState(null);
  const { addToast } = useToast();

  useEffect(() => {
    if (open && resource && accountId) {
      fetchAnalysis();
    }
  }, [open, resource, accountId]);

  const fetchAnalysis = async () => {
    setLoading(true);
    setError(null);
    setAnalysisData(null);

    try {
      const identifier = getResourceIdentifier(resource);
      console.log('Analyzing resource:', { accountId, provider, resource_type: resource.resource_type, identifier });
      const data = await analyzeResource(accountId, provider, resource.resource_type, identifier);
      console.log('Analysis data received:', data);
      setAnalysisData(data);
    } catch (err) {
      setError(err.message || 'Failed to analyze resource');
      addToast(`Failed to analyze ${resource.resource_name}`, 'error');
    } finally {
      setLoading(false);
    }
  };

  const getResourceIdentifier = (res) => {
    // Extract appropriate ID/name based on resource type
    // EC2: instance_id, Lambda: function_name, S3: bucket_name, DynamoDB: table_name
    return res.id || res.resource_name;
  };

  const renderDetailPanel = () => {
    if (loading) {
      return (
        <div className="flex flex-col items-center justify-center py-20">
          <Spinner size="large" label={`Analyzing ${resource?.resource_name}...`} />
        </div>
      );
    }

    if (error) {
      return (
        <div className="p-4 bg-red-50 border border-red-200 rounded text-red-700">
          <strong>Error:</strong> {error}
        </div>
      );
    }

    if (!analysisData) return null;

    const resourceType = resource?.resource_type?.toLowerCase() || '';

    // Check resource type with flexible matching
    if (resourceType.includes('ec2') || resourceType.includes('instance')) {
      return <EC2DetailPanel data={analysisData} resource={resource} />;
    }

    if (resourceType.includes('lambda') || resourceType.includes('function')) {
      return <LambdaDetailPanel data={analysisData} resource={resource} />;
    }

    if (resourceType.includes('s3') || resourceType.includes('bucket')) {
      return <S3DetailPanel data={analysisData} resource={resource} />;
    }

    if (resourceType.includes('dynamodb') || resourceType.includes('table')) {
      return <DynamoDBDetailPanel data={analysisData} resource={resource} />;
    }

    return (
      <div className="p-4 bg-yellow-50 border border-yellow-200 rounded">
        Analysis not yet implemented for resource type: <strong>{resource?.resource_type}</strong>
      </div>
    );
  };

  return (
    <DrawerPanel
      open={open}
      onClose={onClose}
      title={`${resource?.resource_type || 'Resource'} Analysis: ${resource?.resource_name || ''}`}
    >
      {renderDetailPanel()}
    </DrawerPanel>
  );
}
