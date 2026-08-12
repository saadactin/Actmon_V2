import { useResourceDetail } from '../hooks/useResources';
import { useCloudStore } from '../state/cloudStore';
import Drawer from '@/components/ui/Drawer';
import { Loader2 } from 'lucide-react';

export const ResourceDetailDrawer = () => {
  const selectedResourceId = useCloudStore((state) => state.selectedResourceForDetail);
  const setSelectedResourceForDetail = useCloudStore((state) => state.setSelectedResourceForDetail);
  const { data: detail, isLoading } = useResourceDetail(selectedResourceId);

  return (
    <Drawer
      open={!!selectedResourceId}
      onClose={() => setSelectedResourceForDetail(null)}
      title="Resource Configuration Details"
    >
      {isLoading ? (
        <div className="flex flex-col items-center justify-center py-24 gap-3">
          <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
          <span className="text-sm text-gray-500">Loading details…</span>
        </div>
      ) : detail ? (
        <div className="space-y-6">
          <div>
            <h3 className="text-lg font-bold text-gray-900">{detail.resource_name}</h3>
            <div className="flex flex-wrap gap-2 mt-2">
              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-semibold border bg-blue-50 text-blue-700 border-blue-200">
                {detail.resource_type}
              </span>
              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-semibold border bg-gray-100 text-gray-600 border-gray-200">
                {detail.region_or_zone}
              </span>
            </div>
          </div>

          <div>
            <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Tags</h4>
            <div className="flex flex-wrap gap-2">
              {Object.entries(detail.tags || {}).map(([key, val]) => (
                <span key={key} className="text-xs border border-gray-200 bg-gray-50 text-gray-700 px-2 py-1 rounded-md">
                  <span className="font-semibold text-gray-900">{key}:</span> {val}
                </span>
              ))}
            </div>
          </div>

          <div>
            <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Raw Configuration</h4>
            <pre className="bg-gray-50 border border-gray-200 rounded-lg p-3 text-xs font-mono text-gray-700 overflow-x-auto max-h-96">
              {JSON.stringify(detail.config, null, 2)}
            </pre>
          </div>
        </div>
      ) : (
        <div className="py-12 text-center text-sm text-gray-500">Resource not found.</div>
      )}
    </Drawer>
  );
};
