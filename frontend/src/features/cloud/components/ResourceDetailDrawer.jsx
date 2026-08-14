import { useResourceDetail } from '../hooks/useResources';
import { useCloudStore } from '../state/cloudStore';
import Drawer from '@/components/ui/Drawer';
import { InlineLoading } from '@/components/ui/Loading';
import Badge from '@/components/ui/Badge';

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
        <InlineLoading label="Loading details…" className="py-24" />
      ) : detail ? (
        <div className="space-y-6">
          <div>
            <h3 className="text-lg font-bold text-fg">{detail.resource_name}</h3>
            <div className="mt-2 flex flex-wrap gap-2">
              <Badge tone="accent" size="xs">{detail.resource_type}</Badge>
              <Badge tone="neutral" size="xs">{detail.region_or_zone}</Badge>
            </div>
          </div>

          <div>
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">Tags</h4>
            <div className="flex flex-wrap gap-2">
              {Object.entries(detail.tags || {}).map(([key, val]) => (
                <span key={key} className="rounded-md border border-border bg-sunken px-2 py-1 text-xs text-muted">
                  <span className="font-semibold text-fg">{key}:</span> {val}
                </span>
              ))}
            </div>
          </div>

          <div>
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">Raw Configuration</h4>
            <pre className="max-h-96 overflow-x-auto rounded-control border border-border bg-sunken p-3 font-mono text-xs text-muted">
              {JSON.stringify(detail.config, null, 2)}
            </pre>
          </div>
        </div>
      ) : (
        <div className="py-12 text-center text-sm text-muted">Resource not found.</div>
      )}
    </Drawer>
  );
};
