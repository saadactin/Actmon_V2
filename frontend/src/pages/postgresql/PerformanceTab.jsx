import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  Database, Activity, Users, FileText, RefreshCw, HardDrive, RotateCcw, Plug,
  ArrowUp, ArrowDown,
} from 'lucide-react';
import cn from '@/lib/cn';
import client from '@/api/client';
import Badge from '@/components/ui/Badge';
import PerfTrendChart from './PerfTrendChart';
import ProcessesTab from './ProcessesTab';

const STATUS_TONE = { good: 'success', warning: 'warning', critical: 'danger', unknown: 'neutral' };
const STATUS_LABEL = { good: 'Healthy', warning: 'Warning', critical: 'Critical', unknown: 'Unavailable' };

function fmtN(v) {
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(v / 1000).toFixed(2)}K`;
  return v.toFixed(2);
}
function fmtBytes(v) {
  const abs = Math.abs(v);
  if (abs >= 1_073_741_824) return `${(v / 1_073_741_824).toFixed(2)} GB`;
  if (abs >= 1_048_576) return `${(v / 1_048_576).toFixed(2)} MB`;
  if (abs >= 1024) return `${(v / 1024).toFixed(2)} KB`;
  return `${v.toFixed(0)} B`;
}

// One entry per KPI card — the friendly label + icon + accent + how to
// format that KPI's raw number. `process` links a card to the background
// worker it's driven by, so clicking it can jump straight to that process's
// own detail page (real PID/wait-event/technical detail + live charts)
// instead of duplicating a chart here. The five KPIs with no single owning
// process (they're instance-wide, not one background worker) stay static.
const KPI_META = {
  cache_hit_ratio: { label: 'Cache Hit Ratio', icon: Database, accent: '#22C55E', fmt: (v) => (v == null ? '—' : `${v.toFixed(2)}%`) },
  tps: { label: 'Transactions / sec', icon: Activity, accent: '#3B82F6', fmt: (v) => (v == null ? '—' : fmtN(v)) },
  active_sessions: { label: 'Active Sessions', icon: Users, accent: '#8B5CF6', fmt: (v) => (v == null ? '—' : String(v)) },
  wal_generation: { label: 'WAL Generation', icon: FileText, accent: '#F97316', fmt: (v) => (v == null ? '—' : `${fmtBytes(v)}/sec`), process: 'walwriter' },
  checkpoints: { label: 'Checkpoints', icon: RefreshCw, accent: '#06B6D4', fmt: (v) => (v == null ? '—' : `${v.toFixed(0)}% requested`), process: 'checkpointer' },
  database_io: { label: 'Database I/O', icon: HardDrive, accent: '#EAB308', fmt: (v) => (v == null ? '—' : `${fmtN(v)} blocks/sec`), process: 'bgwriter' },
  rollback_rate: { label: 'Rollback Rate', icon: RotateCcw, accent: '#EF4444', fmt: (v) => (v == null ? '—' : `${v.toFixed(2)}%`) },
  connection_usage: { label: 'Connection Usage', icon: Plug, accent: '#14B8A6', fmt: (v) => (v == null ? '—' : `${v.toFixed(1)}%`) },
};

function KpiCard({ id, kpi, staleSeconds, onOpen }) {
  const meta = KPI_META[id];
  if (!meta) return null;
  const Icon = meta.icon;
  const tone = STATUS_TONE[kpi?.status] || 'neutral';
  const trend = kpi?.trend;
  const trendUp = trend != null && trend > 0;
  const trendDown = trend != null && trend < 0;
  const clickable = !!meta.process;
  const Tag = clickable ? 'button' : 'div';

  return (
    <Tag
      type={clickable ? 'button' : undefined}
      onClick={clickable ? () => onOpen(meta.process) : undefined}
      className={cn(
        'card flex flex-col gap-2 p-card text-left transition-colors',
        clickable && 'cursor-pointer hover:bg-sunken',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full"
            style={{ background: `color-mix(in srgb, ${meta.accent} 16%, transparent)` }}>
            <Icon size={16} style={{ color: meta.accent }} />
          </span>
          <span className="truncate-safe text-[12px] font-semibold text-muted">{meta.label}</span>
        </span>
        <Badge tone={tone} size="sm">{STATUS_LABEL[kpi?.status] || 'Unavailable'}</Badge>
      </div>
      <p className="text-[22px] leading-none font-black text-fg tabular-nums">{meta.fmt(kpi?.value)}</p>
      <div className="flex items-center justify-between text-[11px]">
        {trend != null ? (
          <span className={cn('flex items-center gap-0.5 font-semibold', trendUp ? 'text-danger-fg' : trendDown ? 'text-success-fg' : 'text-subtle')}>
            {trendUp ? <ArrowUp size={11} /> : trendDown ? <ArrowDown size={11} /> : null}
            {Math.abs(trend).toFixed(2)}
          </span>
        ) : <span />}
        <span className="text-subtle">{staleSeconds != null ? `Updated ${staleSeconds}s ago` : '—'}</span>
      </div>
    </Tag>
  );
}

/**
 * Performance tab — a high-level "is this database healthy right now"
 * overview, PLUS the background-process list inline below it (no separate
 * "Processes" nav item — a KPI card driven by one specific background
 * worker, or a row in that list, opens that worker's own detail page for
 * real technical detail rather than duplicating a chart here).
 */
export default function PerformanceTab({ connId }) {
  const navigate = useNavigate();
  const { data, isLoading, isError } = useQuery({
    queryKey: ['pgPerfOverview', connId],
    queryFn: () => client.get(`/connections/postgresql/${connId}/performance/overview`).then((r) => r.data),
    enabled: !!connId,
    refetchInterval: 15000,
    placeholderData: keepPreviousData,
  });

  const kpis = data?.kpis || {};
  const openProcess = (processId) => navigate(`/postgresql-dashboard/${connId}/performance/${processId}`);

  return (
    <div className="space-y-5">
      {isError && (
        <div className="card flex items-center gap-2 p-card">
          <p className="text-[13px] font-semibold text-danger-fg">Unable to collect PostgreSQL metrics right now.</p>
        </div>
      )}

      {/* ── Key Performance Metrics ── */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {isLoading
          ? Array.from({ length: 8 }).map((_, i) => <div key={i} className="card h-[104px] animate-pulse bg-sunken" />)
          : Object.keys(KPI_META).map((id) => (
            <KpiCard key={id} id={id} kpi={kpis[id]} staleSeconds={data?.stale_seconds} onOpen={openProcess} />
          ))}
      </div>

      {/* ── Performance Trends ── */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <PerfTrendChart
          connId={connId}
          title="Transaction Activity"
          description="Commits vs rollbacks, per second"
          series={[
            { key: 'xact_commit_per_sec', label: 'Commits/sec', color: 'var(--chart-3)' },
            { key: 'xact_rollback_per_sec', label: 'Rollbacks/sec', color: 'var(--chart-8)' },
          ]}
        />
        <PerfTrendChart
          connId={connId}
          title="I/O Performance"
          description="Database read/write activity"
          series={[
            { key: 'blks_read_per_sec', label: 'Blocks Read/sec', color: 'var(--chart-1)' },
            { key: 'buffers_checkpoint_per_sec', label: 'Blocks Written/sec', color: 'var(--chart-4)' },
          ]}
        />
        <PerfTrendChart
          connId={connId}
          title="Cache Performance"
          description="Shared-buffer cache hit ratio"
          series={[{ key: 'cache_hit_pct', label: 'Cache Hit %', color: 'var(--chart-3)' }]}
          unit="%"
        />
        <PerfTrendChart
          connId={connId}
          title="Row Activity"
          description="Rows fetched, inserted, updated and deleted, per second"
          series={[
            { key: 'tup_fetched_per_sec', label: 'Fetched/sec', color: 'var(--chart-1)' },
            { key: 'tup_inserted_per_sec', label: 'Inserted/sec', color: 'var(--chart-3)' },
            { key: 'tup_updated_per_sec', label: 'Updated/sec', color: 'var(--chart-4)' },
            { key: 'tup_deleted_per_sec', label: 'Deleted/sec', color: 'var(--chart-8)' },
          ]}
        />
      </div>

      {/* ── PostgreSQL Processes ──
          Background-worker detail lives here, inline, rather than behind its
          own nav tab — every row opens that process's own detail page. */}
      <ProcessesTab connId={connId} />
    </div>
  );
}
