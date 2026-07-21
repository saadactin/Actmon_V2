import React from 'react';
import { useResourceDetail } from '../hooks/useResources';
import { useCloudStore } from '../state/cloudStore';
import { DrawerPanel } from '../../../components/ui/DrawerPanel';
import { Spinner } from '@fluentui/react-components';

export const ResourceDetailDrawer = () => {
  const selectedResourceId = useCloudStore(state => state.selectedResourceForDetail);
  const setSelectedResourceForDetail = useCloudStore(state => state.setSelectedResourceForDetail);
  const { data: detail, isLoading } = useResourceDetail(selectedResourceId);

  return (
    <DrawerPanel
      open={!!selectedResourceId}
      onClose={() => setSelectedResourceForDetail(null)}
      title="Resource Configuration Details"
    >
      {isLoading ? (
        <div className="flex justify-center p-8"><Spinner /></div>
      ) : detail ? (
        <div className="space-y-6">
          <div>
            <h3 className="font-bold text-lg">{detail.resource_name}</h3>
            <div className="flex gap-2 mt-2">
              <span className="text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded">{detail.resource_type}</span>
              <span className="text-xs bg-gray-100 text-gray-800 px-2 py-1 rounded">{detail.region_or_zone}</span>
            </div>
          </div>
          
          <div>
            <h4 className="font-semibold text-sm mb-2 text-gray-600">Tags</h4>
            <div className="flex flex-wrap gap-2">
              {Object.entries(detail.tags || {}).map(([key, val]) => (
                <span key={key} className="text-xs border px-2 py-1 rounded bg-gray-50">
                  <span className="font-semibold">{key}:</span> {val as string}
                </span>
              ))}
            </div>
          </div>

          <div>
            <h4 className="font-semibold text-sm mb-2 text-gray-600">Raw Configuration</h4>
            <pre className="bg-gray-900 text-green-400 p-4 rounded text-xs overflow-x-auto max-h-96">
              {JSON.stringify(detail.config, null, 2)}
            </pre>
          </div>
        </div>
      ) : (
        <div className="p-8 text-center text-gray-500">Resource not found.</div>
      )}
    </DrawerPanel>
  );
};
