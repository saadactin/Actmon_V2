import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import client from '@/api/client';
import Badge from '@/components/ui/Badge';
import Icon from '@/components/ui/Icon';
import { PageLoading } from '@/components/ui/Loading';
import Notice from '@/components/ui/Notice';
import { fmtNumber } from '@/config/dbCatalog';
import { RefreshBar } from './maintenanceShared';
import { fmtIST } from './storageHealthConstants';

const REFRESH_SECONDS = 30;

const CATEGORY_META = {
  table: { icon: 'table', description: 'Shrink, move, truncate — reclaimable space and row-movement state' },
  index: { icon: 'key', description: 'Rebuild, coalesce — B-tree health and unusable indexes' },
  statistics: { icon: 'chart-bar', description: 'Gather statistics — stale optimizer stats by table' },
  partition: { icon: 'layers', description: 'Move, shrink, merge, split, drop — per-partition maintenance' },
  space: { icon: 'database', description: 'Tablespaces, datafiles, recycle bin' },
};

const STATUS_META = {
  healthy: { label: 'Healthy', tone: 'success' },
  attention_required: { label: 'Attention Required', tone: 'warning' },
  in_progress: { label: 'In Progress', tone: 'info' },
  unavailable: { label: 'Unavailable', tone: 'danger' },
};

function CategoryCard({ id, cat, onOpen }) {
  const meta = CATEGORY_META[id] || {};
  const status = STATUS_META[cat.status] || STATUS_META.healthy;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="card flex flex-col gap-3 p-card text-left transition-colors hover:border-strong"
    >
      <div className="flex items-start justify-between gap-3">
        <span className="flex items-center gap-2">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-accent-soft text-accent-text">
            <Icon name={meta.icon || 'wrench'} size={18} />
          </span>
          <span>
            <span className="block text-[14px] font-bold text-fg">{cat.label}</span>
            <span className="block text-[11px] text-subtle">{meta.description}</span>
          </span>
        </span>
        <Badge tone={status.tone} size="sm">{status.label}</Badge>
      </div>

      {cat.status === 'unavailable' ? (
        <p className="border-t border-border pt-3 text-[12px] text-danger-fg">{cat.error || 'Could not load this category right now.'}</p>
      ) : (
      <div className="grid grid-cols-2 gap-2 border-t border-border pt-3 sm:grid-cols-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-wide text-subtle">Objects</p>
          <p className="text-[15px] font-bold text-fg">{fmtNumber(cat.objects)}</p>
        </div>
        <div>
          <p className="text-[10px] font-bold uppercase tracking-wide text-subtle">Needs Attention</p>
          <p className={cat.needing_maintenance ? 'text-[15px] font-bold text-warning-fg' : 'text-[15px] font-bold text-fg'}>
            {fmtNumber(cat.needing_maintenance)}
          </p>
        </div>
        {cat.reclaimable_mb != null && (
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wide text-subtle">Reclaimable</p>
            <p className="text-[15px] font-bold text-fg">{fmtNumber(cat.reclaimable_mb)} MB</p>
          </div>
        )}
        <div>
          <p className="text-[10px] font-bold uppercase tracking-wide text-subtle">Running</p>
          <p className={cat.running ? 'text-[15px] font-bold text-info-fg' : 'text-[15px] font-bold text-fg'}>{cat.running}</p>
        </div>
        <div>
          <p className="text-[10px] font-bold uppercase tracking-wide text-subtle">Failed</p>
          <p className={cat.failed ? 'text-[15px] font-bold text-danger-fg' : 'text-[15px] font-bold text-fg'}>{cat.failed}</p>
        </div>
        <div>
          <p className="text-[10px] font-bold uppercase tracking-wide text-subtle">Last Run</p>
          <p className="text-[12px] font-semibold text-fg">{cat.last_execution_at ? fmtIST(cat.last_execution_at) : 'Never'}</p>
        </div>
      </div>
      )}
    </button>
  );
}

export default function MaintenanceOverview({ connId, onOpenCategory }) {
  const q = useQuery({
    queryKey: ['oracleMaintenanceOverview', connId],
    queryFn: () => client.get(`/connections/oracle/${connId}/oracle-maintenance-overview`).then((r) => r.data),
    retry: false,
    refetchInterval: REFRESH_SECONDS * 1000,
  });

  const [countdown, setCountdown] = useState(REFRESH_SECONDS);
  useEffect(() => {
    const t = setInterval(() => setCountdown((c) => (c <= 1 ? REFRESH_SECONDS : c - 1)), 1000);
    return () => clearInterval(t);
  }, []);

  if (q.isLoading) return <PageLoading title="Reading live maintenance telemetry from the connected Oracle instance…" illustration />;

  if (q.error || q.data?.status === 'error') {
    return (
      <Notice tone="danger" title="Could not load maintenance overview.">
        {q.data?.error || q.error?.message}
      </Notice>
    );
  }

  const categories = q.data?.categories || {};
  const order = ['table', 'index', 'statistics', 'partition', 'space'];

  return (
    <div className="space-y-gutter">
      <RefreshBar
        seconds={countdown} isFetching={q.isFetching}
        onRefresh={() => { q.refetch(); setCountdown(REFRESH_SECONDS); }}
        lastUpdatedAt={q.data?.generated_at}
      />

      {(q.data?.errors || []).length > 0 && (
        <Notice tone="warning" title="Some telemetry could not be collected.">
          {q.data.errors.join(' · ')}
        </Notice>
      )}

      <div className="grid grid-cols-1 gap-gutter md:grid-cols-2 xl:grid-cols-3">
        {order.filter((id) => categories[id]).map((id) => (
          <CategoryCard key={id} id={id} cat={categories[id]} onOpen={() => onOpenCategory(id)} />
        ))}
      </div>
    </div>
  );
}
