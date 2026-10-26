import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend as RLegend, Line, LineChart, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import {
  Activity, ArrowDown, ArrowUp, Bell, BellRing, Boxes, Calendar, CircleDollarSign, Crosshair, Cylinder, Database, FileText, FolderTree, Gauge,
  GitBranch, HardDrive, Layers, Leaf, Network, RefreshCw, Search, Server, Settings, Shield, Table2, TrendingUp, Users, Waypoints, Zap,
} from 'lucide-react';
import {
  atlasAckAlert, atlasAlerts, atlasBackups, atlasClusters, atlasClusterUsage, atlasNodes, atlasCollections, atlasCost, atlasStorageTrend, atlasCurrentOps, atlasErrorText,
  atlasIndexes, atlasMeasurements, atlasOverview, atlasReplication, atlasSecurity, atlasSlowQueries,
  deleteAtlasConnection, retestAtlasConnection,
} from '@/api/atlas';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import Drawer from '@/components/ui/Drawer';
import Icon from '@/components/ui/Icon';
import Notice from '@/components/ui/Notice';
import Select from '@/components/ui/Select';
import { InlineLoading, PageLoading } from '@/components/ui/Loading';
import { fmtBytes } from '@/config/dbCatalog';
import { usePermissions } from '@/hooks/usePermissions';
import { ago, fullTime } from '@/lib/format';
import cn from '@/lib/cn';
import { ATLAS_STATUS } from './AtlasConnectionsPage';

/**
 * MongoDB Atlas dashboard — eleven tabs, each backed by a real read:
 *   data plane (pymongo through the ActMon server): databases, collections, indexes, replica set, current ops,
 *     and live-sampled op rates when there is no API key;
 *   Atlas Admin API: clusters, processes, Atlas metric history, alerts, backups, users / access list,
 *     Performance Advisor.
 * A section whose source is not configured, not permitted or not supported by the tier says exactly that — it never
 * shows a placeholder number.
 */
export const ATLAS_TABS = [
  { id: 'overview', label: 'Overview', icon: Activity },
  { id: 'clusters', label: 'Atlas Clusters', icon: Server },
  { id: 'databases', label: 'Databases', icon: Database },
  { id: 'collections', label: 'Collections', icon: FolderTree },
  { id: 'performance', label: 'Performance', icon: Zap },
  { id: 'replication', label: 'Replication & Sharding', icon: GitBranch },
  { id: 'backups', label: 'Backups', icon: HardDrive },
  { id: 'security', label: 'Security & Access', icon: Shield },
  { id: 'query', label: 'Query Analytics', icon: Search },
  { id: 'schemas', label: 'Schemas & Indexes', icon: Table2 },
  { id: 'capacity', label: 'Capacity & Storage', icon: Cylinder },
  { id: 'cost', label: 'Cost & Usage', icon: CircleDollarSign },
  { id: 'settings', label: 'Settings', icon: Settings },
];
// Alerts has no tab in the strip (it is not in the reference) but stays a real route — Recent Alerts' View All opens it.
const TAB_IDS = [...ATLAS_TABS.map((t) => t.id), 'alerts'];
const REFRESH_OPTIONS = [{ id: '10', label: '10s' }, { id: '30', label: '30s' }, { id: '60', label: '60s' }, { id: '0', label: 'Off' }];
const PERIODS = [{ id: '1h', label: 'Last 1 hour' }, { id: '6h', label: 'Last 6 hours' }, { id: '24h', label: 'Last 24 hours' }, { id: '7d', label: 'Last 7 days' }];
const C = { read: '#2F6FED', write: '#16A34A', del: '#EF4444', upd: '#F59E0B', cmd: '#8B5CF6', in: '#2F6FED', out: '#16A34A', cpu: '#3B82F6', mem: '#8B5CF6', disk: '#F59E0B', lat: '#8B5CF6', data: '#8B5CF6', index: '#2F6FED' };
const HEALTH = { healthy: { label: 'Healthy', color: '#16A34A', tone: 'success' }, warning: { label: 'Warning', color: '#F59E0B', tone: 'warning' }, critical: { label: 'Critical', color: '#DC2626', tone: 'danger' } };

const n = (v) => (v == null ? '—' : Number(v).toLocaleString());
const big = (v) => {
  if (v == null) return '—';
  const x = Number(v);
  if (x >= 1e9) return `${(x / 1e9).toFixed(1)} B`;
  if (x >= 1e6) return `${(x / 1e6).toFixed(1)} M`;
  if (x >= 1e4) return `${(x / 1e3).toFixed(1)} K`;
  return x.toLocaleString(undefined, { maximumFractionDigits: 1 });
};
const t = (iso) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

export default function AtlasDashboard() {
  const { id, tab: tabParam } = useParams();
  const navigate = useNavigate();
  const activeTab = TAB_IDS.includes(tabParam) ? tabParam : 'overview';
  // Scope: ?cluster=<name> or ?node=<process id> narrows every tab to one cluster or one instance (like a RAC node).
  const [sp] = useSearchParams();
  const qs = sp.toString();
  const setTab = (tid) => navigate(`/mongoatlas-dashboard/${id}${tid === 'overview' ? '' : `/${tid}`}${qs ? `?${qs}` : ''}`);
  const openScope = (next) => {
    const q = new URLSearchParams();
    if (next?.node) q.set('node', next.node); else if (next?.cluster) q.set('cluster', next.cluster);
    try { if (next?.node) sessionStorage.setItem(`atlas-proc-${id}`, next.node); } catch { /* non-fatal */ }
    navigate(`/mongoatlas-dashboard/${id}${q.toString() ? `?${q}` : ''}`);
  };
  const [period, setPeriod] = useState('1h');
  const [refreshSec, setRefreshSec] = useState(() => { try { return localStorage.getItem('atlas-refresh') || '10'; } catch { return '10'; } });
  const every = Number(refreshSec) * 1000 || false;
  const [countdown, setCountdown] = useState(Number(refreshSec) || 0);

  const ov = useQuery({ queryKey: ['atlas', id, 'overview'], queryFn: () => atlasOverview(id), refetchInterval: every, retry: false });
  const cl = useQuery({ queryKey: ['atlas', id, 'clusters'], queryFn: () => atlasClusters(id), refetchInterval: every ? Math.max(every, 60000) : false, retry: false });
  useEffect(() => {
    if (!every) return undefined;
    const h = setInterval(() => setCountdown((c) => (c <= 1 ? Number(refreshSec) : c - 1)), 1000);
    return () => clearInterval(h);
  }, [every, refreshSec]);
  useEffect(() => { setCountdown(Number(refreshSec) || 0); }, [ov.dataUpdatedAt, refreshSec]);
  const changeRefresh = (v) => { setRefreshSec(v); try { localStorage.setItem('atlas-refresh', v); } catch { /* non-fatal */ } };

  if (ov.isLoading) return <PageLoading title="Connecting to MongoDB Atlas…" />;
  if (ov.isError) {
    return (
      <div className="space-y-gutter">
        <Notice tone="danger" title="This Atlas connection could not be loaded.">{atlasErrorText(ov.error)}</Notice>
        <Button icon="chevron-left" onClick={() => navigate('/mongoatlas-servers')}>Back to connections</Button>
      </div>
    );
  }

  const raw = ov.data;
  const conn = raw.connection;
  const allClusters = cl.data?.available ? cl.data.clusters : (raw.clusters?.available ? raw.clusters.clusters : []);
  const allProcs = cl.data?.processes || [];
  const nodeProc = sp.get('node') ? allProcs.find((p) => p.id === sp.get('node')) : null;
  const scopeCluster = nodeProc?.cluster || sp.get('cluster') || null;
  const clusters = scopeCluster ? allClusters.filter((c) => c.name === scopeCluster) : allClusters;
  const clusterProcs = scopeCluster ? allProcs.filter((p) => p.cluster === scopeCluster) : allProcs;
  const processes = nodeProc ? [nodeProc] : clusterProcs;
  // Narrow the overview payload to the scope: alerts and Atlas-sourced databases carry their cluster.
  const d = scopeCluster ? (() => {
    const dp = raw.data_plane || {};
    const dbs = dp.source === 'atlas' ? (dp.databases || []).filter((r) => r.cluster === scopeCluster) : dp.databases;
    return {
      ...raw,
      alerts: raw.alerts?.available ? { ...raw.alerts, alerts: raw.alerts.alerts.filter((a) => a.cluster === scopeCluster) } : raw.alerts,
      data_plane: dp.source === 'atlas' ? { ...dp, databases: dbs, totals: {
        databases: dbs.length, collections: dbs.reduce((a, r) => a + (r.collections || 0), 0), documents: dbs.reduce((a, r) => a + (r.objects || 0), 0),
        storage_bytes: dbs.reduce((a, r) => a + (r.storage_size || 0), 0), index_bytes: dbs.reduce((a, r) => a + (r.index_size || 0), 0) } } : dp,
    };
  })() : raw;
  const scope = { cluster: scopeCluster, node: nodeProc?.id || null };
  const ctx = { id, d, conn, clusters, processes, allProcesses: clusterProcs, period, cluster: scopeCluster || '__all__', setTab, clData: cl.data, every, scope, openScope };

  // Header badge: the connection first, then the worst cluster / alert state.
  const alerts = d.alerts?.available ? d.alerts.alerts : [];
  const health = conn.status === 'error' || (!d.data_plane?.available && !d.clusters?.available) ? 'critical'
    : clusters.some((c) => c.health === 'critical') || alerts.some((a) => a.severity === 'critical') ? 'critical'
      : clusters.some((c) => c.health === 'warning') || alerts.length ? 'warning' : 'healthy';
  const hb = HEALTH[health];

  return (
    <div className="flex min-h-full flex-col">
      <header className="flex flex-wrap items-center gap-3 pb-3">
        <button type="button" onClick={() => navigate('/databases')} aria-label="Back to Databases"
          className="grid h-10 w-10 place-items-center rounded-lg border border-border bg-surface text-fg shadow-xs hover:bg-sunken"><Icon name="chevron-left" size={18} /></button>
        <span className="grid h-12 w-12 place-items-center rounded-xl bg-[#E8F6EC]"><Leaf size={24} className="text-[#13A04A]" fill="#13A04A" /></span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-[22px] leading-tight font-bold text-fg">MongoDB Atlas Dashboard</h1>
            <span className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[12.5px] font-semibold"
              style={{ color: hb.color, borderColor: `color-mix(in srgb, ${hb.color} 35%, transparent)`, background: `color-mix(in srgb, ${hb.color} 10%, transparent)` }}
              title={`${conn.connection_name} · checked ${ago(d.fetched_at)}`}>
              <Icon name={health === 'healthy' ? 'check' : 'alert'} size={12} />{hb.label}
            </span>
            {nodeProc && <span className="rounded-full bg-indigo-50 px-2.5 py-0.5 text-[11.5px] font-bold text-indigo-700">Instance · {String(nodeProc.type || '').replace('REPLICA_', '')}</span>}
            {(scope.node || scope.cluster) && <button type="button" onClick={() => openScope(null)} className="text-[12px] font-semibold text-accent-text hover:underline">Show all clusters</button>}
          </div>
          <p className="mt-0.5 text-[13px] text-muted">
            Monitor your MongoDB Atlas clusters, performance, and health in real-time
            <span className="text-subtle"> · {[conn.connection_name, conn.project_label || d.clusters?.project].filter(Boolean).join(' · ')}</span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {allClusters.length > 0 && (
            <label className="relative inline-flex h-10 max-w-[260px] items-center rounded-lg border border-border bg-surface shadow-xs">
                <select aria-label="Scope" value={scope.node ? `n:${scope.node}` : scope.cluster ? `c:${scope.cluster}` : ''}
                  onChange={(e) => { const v = e.target.value; openScope(v.startsWith('n:') ? { node: v.slice(2) } : v.startsWith('c:') ? { cluster: v.slice(2) } : null); }}
                  className="h-full min-w-0 appearance-none truncate bg-transparent pr-8 pl-3 text-[13.5px] font-semibold text-fg outline-none">
                  <option value="">All clusters ({allClusters.length})</option>
                  {allClusters.map((c) => [
                    <option key={c.name} value={`c:${c.name}`}>{c.name} — whole cluster</option>,
                    ...allProcs.filter((p) => p.cluster === c.name).map((p) => (
                      <option key={p.id} value={`n:${p.id}`}>{'   '}{(p.alias || p.host).split('.')[0]} · {String(p.type || '').replace('REPLICA_', '').toLowerCase()}</option>
                    )),
                  ])}
                </select>
                <Icon name="chevron-down" size={12} className="pointer-events-none absolute right-2.5 text-muted" />
              </label>
          )}
          <label className="relative inline-flex h-10 items-center rounded-lg border border-border bg-surface pl-3 shadow-xs">
            <Calendar size={16} className="text-accent" />
            <select aria-label="Time range" value={period} onChange={(e) => setPeriod(e.target.value)} className="h-full appearance-none bg-transparent pr-8 pl-2 text-[13.5px] font-semibold text-fg outline-none">
              {PERIODS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
            <Icon name="chevron-down" size={14} className="pointer-events-none absolute right-2.5 text-muted" />
          </label>
          <label className="relative inline-flex h-10 items-center gap-1 rounded-lg border border-border bg-surface pl-3 shadow-xs" title="Refresh now / refresh interval">
            <button type="button" aria-label="Refresh now" onClick={() => { ov.refetch(); cl.refetch(); }} className="text-accent">
              <RefreshCw size={16} className={ov.isFetching ? 'animate-spin' : undefined} />
            </button>
            <select aria-label="Refresh interval" value={refreshSec} onChange={(e) => changeRefresh(e.target.value)} className="h-full appearance-none bg-transparent pr-3 pl-1.5 text-[13.5px] font-semibold text-fg tabular-nums outline-none">
              {REFRESH_OPTIONS.map((o) => <option key={o.id} value={o.id}>{o.id !== '0' && every && o.id === refreshSec ? `${countdown}s` : o.label}</option>)}
            </select>
          </label>
          <button type="button" onClick={() => navigate('/mongoatlas/new')}
            className="inline-flex h-10 items-center gap-2 rounded-lg bg-[#2563EB] px-4 text-[13.5px] font-semibold text-white shadow-sm hover:bg-[#1D4ED8]">
            <Crosshair size={16} />Add Cluster
          </button>
        </div>
      </header>

      <nav role="tablist" aria-label="MongoDB Atlas sections" className="no-scrollbar -mx-1 mb-4 flex overflow-x-auto border-b border-border">
        {ATLAS_TABS.map((tb) => {
          const TI = tb.icon;
          const on = tb.id === activeTab;
          return (
            <button key={tb.id} type="button" role="tab" aria-selected={on} onClick={() => setTab(tb.id)}
              className={cn('relative flex shrink-0 items-center gap-1.5 px-[9px] pt-2 pb-3 text-[12.5px] font-medium whitespace-nowrap transition-colors',
                on ? 'text-[#2563EB]' : 'text-[#475569] hover:text-fg')}>
              <TI size={14} strokeWidth={1.8} />{tb.label}
              {on && <span className="absolute inset-x-1 bottom-0 h-[2.5px] rounded-full bg-[#2563EB]" />}
            </button>
          );
        })}
      </nav>

      {activeTab === 'overview' && <OverviewTab {...ctx} />}
      {activeTab === 'clusters' && <ClustersTab {...ctx} loading={cl.isLoading} />}
      {activeTab === 'performance' && <PerformanceTab {...ctx} />}
      {activeTab === 'databases' && <DatabasesTab {...ctx} />}
      {activeTab === 'collections' && <CollectionsTab {...ctx} />}
      {activeTab === 'query' && <QueryTab {...ctx} />}
      {activeTab === 'replication' && <ReplicationTab {...ctx} />}
      {activeTab === 'alerts' && <AlertsTab {...ctx} />}
      {activeTab === 'backups' && <BackupsTab {...ctx} />}
      {activeTab === 'security' && <SecurityTab {...ctx} />}
      {activeTab === 'schemas' && <SchemasTab {...ctx} />}
      {activeTab === 'capacity' && <CapacityTab {...ctx} />}
      {activeTab === 'cost' && <CostTab {...ctx} />}
      {activeTab === 'settings' && <SettingsTab {...ctx} />}
    </div>
  );
}

/* ── building blocks ─────────────────────────────────────────────────────── */

function Card({ title, icon, actions, children, className, sub }) {
  return (
    <section className={cn('card flex min-w-0 flex-col p-card', className)}>
      {(title || actions) && (
        <header className="mb-3 flex flex-wrap items-center gap-2">
          {icon && <span className="grid h-8 w-8 place-items-center rounded-lg bg-accent-soft text-accent"><Icon name={icon} size={15} /></span>}
          <div className="min-w-0 flex-1">
            <h3 className="text-[15px] font-bold text-fg">{title}</h3>
            {sub && <p className="text-[11px] text-subtle">{sub}</p>}
          </div>
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}

const REQUIRES = {
  api_key: { text: 'Add an Atlas API key in Settings to enable this.', action: 'Add API key' },
  api_key_permission: { text: 'Check the API key pair, give it the Project Read Only role, and add the ActMon server IP to its API access list.', action: 'Edit API key' },
  uri_or_credentials: { text: 'Add a connection URI or database user in Settings to enable this.', action: 'Add database access' },
  clusterMonitor: { text: 'Grant the database user the clusterMonitor role.' },
  'M10+ cluster tier': { text: 'Performance Advisor is available on M10 and larger clusters.' },
};

function Unavailable({ data, id, compact }) {
  const req = REQUIRES[data?.requires];
  return (
    <div className={cn('grid place-items-center text-center', compact ? 'py-6' : 'py-10')}>
      <span className="grid h-10 w-10 place-items-center rounded-full bg-sunken text-subtle"><Icon name="info" size={18} /></span>
      <p className="mt-2 max-w-md text-[13px] font-semibold text-fg">{data?.reason || 'Not available for this connection.'}</p>
      {req?.text && <p className="mt-1 max-w-md text-[12px] text-muted">{req.text}</p>}
      {req?.action && id && <Link to={`/mongoatlas-edit/${id}`} className="mt-3 text-[12px] font-semibold text-accent-text hover:underline">{req.action} →</Link>}
    </div>
  );
}

function Kpi({ icon, label, value, sub, tone = 'accent', onClick }) {
  const tones = { accent: 'bg-accent-soft text-accent', good: 'bg-success-soft text-success-fg', warn: 'bg-warning-soft text-warning-fg', bad: 'bg-danger-soft text-danger-fg', violet: 'bg-[color-mix(in_srgb,#8B5CF6_16%,transparent)] text-[#7C3AED]' };
  const W = onClick ? 'button' : 'div';
  return (
    <W type={onClick ? 'button' : undefined} onClick={onClick} className={cn('card flex items-start gap-3 p-card text-left', onClick && 'transition hover:-translate-y-0.5 hover:shadow-md')}>
      <span className={cn('grid h-11 w-11 shrink-0 place-items-center rounded-xl', tones[tone])}><Icon name={icon} size={19} /></span>
      <span className="min-w-0">
        <span className="block text-[12.5px] font-semibold text-muted">{label}</span>
        <span className="block text-[24px] leading-tight font-black text-fg tabular-nums">{value}</span>
        {sub && <span className="mt-0.5 block text-[11.5px] text-subtle">{sub}</span>}
      </span>
    </W>
  );
}

function DataTable({ cols, rows, empty = 'Nothing to show.', onRow, rowKey }) {
  if (!rows?.length) return <p className="py-6 text-center text-[12.5px] text-subtle">{empty}</p>;
  return (
    <div className="-mx-card overflow-x-auto">
      <table className="w-full min-w-[560px] text-[12.5px]">
        <thead>
          <tr className="border-b border-border text-left text-[11px] font-bold tracking-wide text-subtle uppercase">
            {cols.map((c) => <th key={c.key} className={cn('px-3 py-2 first:pl-card last:pr-card', c.right && 'text-right')}>{c.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={rowKey ? rowKey(r) : i} onClick={onRow ? () => onRow(r) : undefined}
              className={cn('border-b border-border last:border-0', onRow && 'cursor-pointer hover:bg-sunken')}>
              {cols.map((c) => <td key={c.key} className={cn('px-3 py-2 align-top first:pl-card last:pr-card', c.right && 'text-right tabular-nums')}>{c.render ? c.render(r) : r[c.key] ?? '—'}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Bar100({ pct, color }) {
  const p = Math.max(0, Math.min(100, pct || 0));
  const col = color || (p >= 90 ? '#DC2626' : p >= 75 ? '#F59E0B' : '#16A34A');
  return (
    <span className="flex items-center gap-2">
      <span className="h-1.5 w-20 overflow-hidden rounded-full bg-sunken"><span className="block h-full rounded-full" style={{ width: `${p}%`, background: col }} /></span>
      <span className="tabular-nums">{pct == null ? '—' : `${p.toFixed(0)}%`}</span>
    </span>
  );
}

function TimeChart({ data, series, height = 210, unit = '', area = true, empty }) {
  if (!data?.length) return <p className="grid place-items-center px-6 text-center text-[12px] text-subtle" style={{ height }}>{empty || 'No data points in this range yet.'}</p>;
  const Chart = area ? AreaChart : LineChart;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <Chart data={data} margin={{ top: 6, right: 8, left: -12, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
        <XAxis dataKey="ts" tickFormatter={t} tick={{ fontSize: 11, fill: 'var(--fg-subtle)' }} minTickGap={36} />
        <YAxis tick={{ fontSize: 11, fill: 'var(--fg-subtle)' }} tickFormatter={(v) => (unit === 'B' ? fmtBytes(v) : big(v))} width={56} />
        <Tooltip labelFormatter={(v) => fullTime(v)} formatter={(v, name) => [unit === 'B' ? fmtBytes(v) : `${Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 })}${unit && unit !== 'B' ? ` ${unit}` : ''}`, name]}
          contentStyle={{ fontSize: 12, borderRadius: 8 }} />
        <RLegend wrapperStyle={{ fontSize: 12 }} />
        {series.map((s) => (area
          ? <Area key={s.key} type="monotone" dataKey={s.key} name={s.name} stroke={s.color} fill={s.color} fillOpacity={0.12} strokeWidth={2} dot={false} isAnimationActive={false} />
          : <Line key={s.key} type="monotone" dataKey={s.key} name={s.name} stroke={s.color} strokeWidth={2} dot={false} isAnimationActive={false} />))}
      </Chart>
    </ResponsiveContainer>
  );
}

/** Merge Atlas measurement series ({name:{points:[{ts,v}]}}) into rows keyed by timestamp. */
function mergeSeries(series, map) {
  const byTs = new Map();
  Object.entries(map).forEach(([key, metric]) => {
    (series?.[metric]?.points || []).forEach((p) => {
      if (p.v == null) return;
      const row = byTs.get(p.ts) || { ts: p.ts };
      row[key] = (row[key] || 0) + p.v;
      byTs.set(p.ts, row);
    });
  });
  return [...byTs.values()].sort((a, b) => a.ts.localeCompare(b.ts));
}

function useMeasurements(id, processes, period, enabled) {
  const [proc, setProc] = useState(() => { try { return sessionStorage.getItem(`atlas-proc-${id}`); } catch { return null; } });
  const primary = processes.find((p) => p.type === 'REPLICA_PRIMARY') || processes[0];
  const pid = proc && processes.some((p) => p.id === proc) ? proc : primary?.id;
  const q = useQuery({ queryKey: ['atlas', id, 'meas', pid, period], queryFn: () => atlasMeasurements(id, pid, period), enabled: Boolean(enabled && pid), refetchInterval: 60000, retry: false });
  const picker = processes.length > 0 && (
    <Select size="sm" width="auto" value={pid || ''} onChange={setProc} aria-label="Process"
      options={processes.map((p) => ({ id: p.id, label: `${p.alias || p.host} · ${String(p.type || '').replace('REPLICA_', '').toLowerCase()}` }))} />
  );
  return { q, pid, picker };
}

/* ── Overview (reference layout: 6 KPIs · 3 × 3 panels) ──────────────────── */

const TINT = {
  violet: { fg: '#7C3AED', bg: '#F1EAFE' }, green: { fg: '#16A34A', bg: '#E7F6EC' }, purple: { fg: '#8B5CF6', bg: '#F3EEFF' },
  blue: { fg: '#2563EB', bg: '#E8F0FE' }, red: { fg: '#DC2626', bg: '#FDECEC' },
};

function DiskArt({ color }) {
  // decorative only (aria-hidden) — three stacked disks in the card's tint, as in the reference
  const g = `art-${color.replace('#', '')}`;
  return (
    <svg aria-hidden="true" width="64" height="62" viewBox="0 0 64 62" className="pointer-events-none absolute top-3 right-3" style={{ opacity: 0.4 }}>
      <defs><linearGradient id={g} x1="0" x2="1"><stop offset="0" stopColor={color} stopOpacity="0.18" /><stop offset="1" stopColor={color} stopOpacity="0.05" /></linearGradient></defs>
      {[38, 24, 10].map((y) => (
        <g key={y}>
          <path d={`M6 ${y} v10 a26 7 0 0 0 52 0 v-10`} fill={`url(#${g})`} stroke={color} strokeOpacity="0.18" />
          <ellipse cx="32" cy={y} rx="26" ry="7" fill={`url(#${g})`} stroke={color} strokeOpacity="0.22" />
        </g>
      ))}
    </svg>
  );
}

function Trend({ value, suffix, period }) {
  if (value == null) return null;
  const up = value > 0;
  const flat = value === 0;
  const txt = `${up ? '+' : ''}${Number.isInteger(value) ? value.toLocaleString() : value.toFixed(1)}${suffix || ''}`;
  return (
    <span className={cn('inline-flex items-center gap-1 font-medium', flat ? 'text-[#64748B]' : up ? 'text-[#16A34A]' : 'text-[#DC2626]')}>
      {!flat && (up ? <ArrowUp size={13} strokeWidth={2.4} /> : <ArrowDown size={13} strokeWidth={2.4} />)}
      {flat ? `No change ${period}` : `${txt} ${period}`}
    </span>
  );
}

function OvKpi({ tint, icon: I, label, value, children, spark, sparkTitle, onClick }) {
  const tc = TINT[tint];
  const gid = `spk-${tint}-${label.replace(/\W/g, '')}`;
  return (
    <button type="button" onClick={onClick} title={sparkTitle}
      className="relative flex min-h-[132px] flex-col overflow-hidden rounded-xl border border-[#E6EAF0] bg-surface px-4 pt-4 pb-10 text-left shadow-[0_1px_3px_rgba(16,24,40,0.06)] transition hover:-translate-y-0.5 hover:shadow-md">
      <DiskArt color={tc.fg} />
      <div className="relative flex items-start gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl" style={{ background: tc.bg, color: tc.fg }}><I size={21} strokeWidth={1.9} /></span>
        <span className="min-w-0">
          <span className="block text-[13px] font-semibold text-[#1E293B]">{label}</span>
          <span className="mt-0.5 block text-[26px] leading-tight font-extrabold text-[#0F172A] tabular-nums">{value}</span>
        </span>
      </div>
      <div className="relative mt-1 pl-14 text-[12.5px] text-[#475569]">{children}</div>
      {spark?.length > 1 && (
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-11">
          <ResponsiveContainer><AreaChart data={spark} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
            <defs><linearGradient id={gid} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={tc.fg} stopOpacity={0.28} /><stop offset="100%" stopColor={tc.fg} stopOpacity={0.02} /></linearGradient></defs>
            <YAxis hide domain={['dataMin', 'dataMax']} />
            <Area type="monotone" dataKey="v" stroke={tc.fg} strokeOpacity={0.55} strokeWidth={1.3} fill={`url(#${gid})`} dot={false} isAnimationActive={false} />
          </AreaChart></ResponsiveContainer>
        </div>
      )}
    </button>
  );
}

const Dot = ({ color }) => <span className="inline-block h-2 w-2 rounded-full align-middle" style={{ background: color }} />;

function Panel({ icon: I, title, note, viewAll, period, onPeriod, children, className, legend }) {
  return (
    <section className={cn('flex min-w-0 flex-col rounded-xl border border-[#E6EAF0] bg-surface p-4 shadow-[0_1px_3px_rgba(16,24,40,0.06)]', className)}>
      <header className="mb-2 flex items-center gap-2.5">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[#E8F0FE] text-[#2563EB]"><I size={18} strokeWidth={1.9} /></span>
        <h3 className="min-w-0 flex-1 truncate text-[15.5px] font-bold text-[#0F172A]">{title}{note && <span className="text-[13px] font-medium text-[#64748B]"> {note}</span>}</h3>
        {onPeriod && (
          <label className="relative inline-flex h-8 items-center rounded-md border border-[#E2E8F0] bg-surface">
            <select aria-label={`${title} time range`} value={period} onChange={(e) => onPeriod(e.target.value)}
              className="h-full appearance-none bg-transparent pr-7 pl-2.5 text-[12px] font-medium text-[#334155] outline-none">
              {PERIODS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
            <Icon name="chevron-down" size={12} className="pointer-events-none absolute right-2 text-[#64748B]" />
          </label>
        )}
        {viewAll && <button type="button" onClick={viewAll} className="h-8 rounded-md border border-[#E2E8F0] px-3 text-[12.5px] font-semibold text-[#2563EB] hover:bg-[#F1F5FF]">View All</button>}
      </header>
      {legend && <div className="mb-1 flex flex-wrap justify-end gap-4 text-[12px] text-[#475569]">{legend.map((l) => <span key={l.name} className="inline-flex items-center gap-1.5"><Dot color={l.color} />{l.name}</span>)}</div>}
      <div className="min-h-0 flex-1">{children}</div>
    </section>
  );
}

function MiniChart({ data, series, unit = '', height = 150, area = true, empty, fmt }) {
  if (!data?.length) return <p className="grid place-items-center px-4 text-center text-[12px] text-subtle" style={{ height }}>{empty || 'No data points in this range yet.'}</p>;
  const tick = fmt || ((v) => (unit === 'B' ? fmtBytes(v) : big(v)));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 6, right: 6, left: -14, bottom: 0 }}>
        <CartesianGrid stroke="#EEF2F6" vertical={false} />
        <XAxis dataKey="ts" tickFormatter={t} tick={{ fontSize: 10.5, fill: '#64748B' }} axisLine={false} tickLine={false} minTickGap={34} />
        <YAxis tick={{ fontSize: 10.5, fill: '#64748B' }} tickFormatter={tick} axisLine={false} tickLine={false} width={68} />
        <Tooltip labelFormatter={(v) => fullTime(v)} formatter={(v, name) => [`${tick(v)}${unit && unit !== 'B' ? ` ${unit}` : ''}`, name]} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
        {series.map((s) => <Area key={s.key} type="monotone" dataKey={s.key} name={s.name} stroke={s.color} strokeWidth={1.8} fill={s.color} fillOpacity={area ? (s.fill ?? 0.14) : 0} dot={false} isAnimationActive={false} />)}
      </AreaChart>
    </ResponsiveContainer>
  );
}

function usePanelPeriod(period) {
  const [p, setP] = useState(period);
  useEffect(() => { setP(period); }, [period]);
  return [p, setP];
}

/** Atlas measurements for one process + period, shared through the react-query cache. */
function useMeas(id, pid, period, enabled, every) {
  return useQuery({ queryKey: ['atlas', id, 'meas', pid, period], queryFn: () => atlasMeasurements(id, pid, period), enabled: Boolean(enabled && pid), refetchInterval: every ? Math.max(every, 60000) : false, retry: false });
}

const notReported = (m, names) => names.every((x) => m?.not_reported?.includes(x));

function OverviewTab({ id, d, conn, clusters, processes, period, setTab, every, scope }) {
  const dp = d.data_plane || {};
  const totals = dp.totals || {};
  const hasApi = conn.has_api_key;
  const alerts = d.alerts?.available ? d.alerts.alerts : [];
  const crit = alerts.filter((a) => a.severity === 'critical').length;
  const counts = clusters.reduce((a, c) => ({ ...a, [c.health]: (a[c.health] || 0) + 1 }), {});
  const sampled = d.sampled || [];
  const primary = processes.find((p) => p.type === 'REPLICA_PRIMARY') || processes[0];
  const pid = primary?.id;
  const tier = clusters.find((c) => c.tier)?.tier;

  const [pOps, setPOps] = usePanelPeriod(period);
  const [pLat, setPLat] = usePanelPeriod(period);
  const [pConn, setPConn] = usePanelPeriod(period);
  const [pNet, setPNet] = usePanelPeriod(period);
  const [pSto, setPSto] = usePanelPeriod(period);
  const mOps = useMeas(id, pid, pOps, hasApi, every);
  const mLat = useMeas(id, pid, pLat, hasApi, every);
  const mConn = useMeas(id, pid, pConn, hasApi, every);
  const mNet = useMeas(id, pid, pNet, hasApi, every);
  const m1h = useMeas(id, pid, '1h', hasApi, every);
  const usage = useQuery({ queryKey: ['atlas', id, 'usage'], queryFn: () => atlasClusterUsage(id), enabled: hasApi, refetchInterval: every ? Math.max(every, 60000) : false, retry: false });
  const sto = useQuery({ queryKey: ['atlas', id, 'storage', pid, pSto], queryFn: () => atlasStorageTrend(id, pid, pSto), refetchInterval: every ? Math.max(every, 60000) : false, retry: false });

  const api = (q) => (q.data?.available ? q.data : null);
  const ser = (q) => api(q)?.series;
  // ops: Atlas measurements when there is a key, else ActMon's own serverStatus samples
  const opsData = ser(mOps)
    ? mergeSeries(ser(mOps), { read: 'OPCOUNTER_QUERY', getmore: 'OPCOUNTER_GETMORE', ins: 'OPCOUNTER_INSERT', upd: 'OPCOUNTER_UPDATE', del: 'OPCOUNTER_DELETE' })
      .map((r) => ({ ts: r.ts, read: (r.read || 0) + (r.getmore || 0), write: (r.ins || 0) + (r.upd || 0), del: r.del || 0 }))
    : sampled.map((s) => ({ ts: s.ts, read: s.reads, write: s.inserts + s.updates, del: s.deletes }));
  const latData = ser(mLat) ? mergeSeries(ser(mLat), { lat: 'OP_EXECUTION_TIME_READS' }) : sampled.map((s) => ({ ts: s.ts, lat: s.read_latency_ms }));
  const connData = ser(mConn) ? mergeSeries(ser(mConn), { c: 'CONNECTIONS' }) : sampled.map((s) => ({ ts: s.ts, c: s.connections }));
  const netData = (ser(mNet) ? mergeSeries(ser(mNet), { in: 'NETWORK_BYTES_IN', out: 'NETWORK_BYTES_OUT' }) : sampled.map((s) => ({ ts: s.ts, in: s.net_in, out: s.net_out })))
    .map((r) => ({ ts: r.ts, in: ((r.in || 0) * 8) / 1e6, out: ((r.out || 0) * 8) / 1e6 }));
  const stoData = (sto.data?.available ? sto.data.series : []).map((r) => ({ ts: r.ts, data: (r.data || 0) / 1e9, index: (r.index || 0) / 1e9 }));
  // Project-wide history (Atlas database measurements, 7 days hourly) — only meaningful unscoped.
  const hist = !scope?.cluster && dp.source === 'atlas' ? (dp.history || []) : [];
  const trends = !scope?.cluster && dp.source === 'atlas' ? (dp.trends || {}) : {};
  const last48 = hist.slice(-48);
  const sp = (k) => last48.map((b) => ({ v: b[k] }));
  // alerts raised per hour over the last 24 h, from Atlas' open + closed alerts
  const closed = useQuery({ queryKey: ['atlas', id, 'alerts', 'CLOSED'], queryFn: () => atlasAlerts(id, 'CLOSED'), enabled: hasApi, refetchInterval: every ? Math.max(every, 300000) : false, retry: false });
  const alertSpark = (() => {
    const all = [...alerts, ...(closed.data?.alerts || [])];
    if (!d.alerts?.available) return [];
    const now = Date.now();
    return Array.from({ length: 24 }, (_, i) => ({ v: all.filter((a) => { const t = Date.parse(a.created); return t > now - (24 - i) * 3600e3 && t <= now - (23 - i) * 3600e3; }).length }));
  })();
  const disk = api(m1h)?.disks?.[0];
  const diskSpark = disk ? mergeSeries(disk.series, { v: 'DISK_PARTITION_SPACE_PERCENT_USED' }) : [];
  const connSpark = connData.map((r) => ({ v: r.c }));

  // Storage card: used = dbStats total when there is database access; capacity = the clusters' disk sizes from Atlas.
  const capacityGb = clusters.reduce((a, c) => a + (Number(c.disk_gb) || 0), 0) || null;
  const usageRows = (api(usage)?.clusters || []).filter((r) => clusters.some((c) => c.name === r.name));
  const diskPct = usageRows.find((r) => r.storage != null)?.storage ?? null;
  const usedBytes = dp.available ? totals.storage_bytes : (capacityGb && diskPct != null ? (diskPct / 100) * capacityGb * 1e9 : null);
  const usedPct = capacityGb && usedBytes != null ? Math.min(100, (usedBytes / (capacityGb * 1e9)) * 100) : diskPct;
  const src = (q) => (ser(q) ? null : sampled.length ? 'Sampled by ActMon' : null);
  const noDp = 'Needs database access (connection URI or database user)';
  const latEmpty = ser(mLat) && notReported(api(mLat), ['OP_EXECUTION_TIME_READS'])
    ? `Atlas does not report operation latency for ${tier || 'this'} clusters${/^M[025]$/i.test(tier || '') ? ' — it needs a dedicated (M10+) cluster' : ''}.` : undefined;

  return (
    <div className="space-y-4">
      {dp.available === false && dp.requires !== 'uri_or_credentials' && dp.reason && <Notice tone="danger" title="The cluster could not be reached.">{dp.reason}</Notice>}
      {d.clusters?.available === false && hasApi && <Notice tone="warning" title="The Atlas Admin API returned an error.">{d.clusters.reason}</Notice>}

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 2xl:grid-cols-6">
        <OvKpi tint="violet" icon={Network} label="Total Clusters" value={d.clusters?.available ? clusters.length : '—'} onClick={() => setTab('clusters')}
          spark={opsData.slice(-60).map((r) => ({ v: (r.read || 0) + (r.write || 0) + (r.del || 0) }))} sparkTitle="Sparkline: operations per second on the primary">
          {d.clusters?.available ? <span className="flex flex-wrap gap-x-3"><span><Dot color="#16A34A" /> {counts.healthy || 0} Healthy</span>{(counts.warning || 0) > 0 && <span><Dot color="#F59E0B" /> {counts.warning} Warning</span>}{(counts.critical || 0) > 0 && <span><Dot color="#DC2626" /> {counts.critical} Critical</span>}</span> : 'Needs an Atlas API key'}
        </OvKpi>
        <OvKpi tint="green" icon={Database} label="Total Databases" value={dp.available ? n(totals.databases) : '—'} onClick={() => setTab('databases')}
          spark={sp('databases')} sparkTitle="Sparkline: databases reported by Atlas, last 48 h">
          {dp.available ? (trends.databases_week != null ? <Trend value={trends.databases_week} period="this week" /> : 'excluding admin, local, config') : noDp}
        </OvKpi>
        <OvKpi tint="purple" icon={Layers} label="Total Collections" value={dp.available ? n(totals.collections) : '—'} onClick={() => setTab('collections')}
          spark={sp('collections')} sparkTitle="Sparkline: collections, last 48 h">
          {dp.available ? (trends.collections_week != null ? <Trend value={trends.collections_week} period="this week" /> : `in ${n(totals.databases)} database${totals.databases === 1 ? '' : 's'}`) : noDp}
        </OvKpi>
        <OvKpi tint="blue" icon={FileText} label="Total Documents" value={dp.available ? big(totals.documents) : '—'} onClick={() => setTab('databases')}
          spark={sp('documents')} sparkTitle="Sparkline: documents, last 48 h">
          {dp.available ? (trends.documents_24h_pct != null ? <Trend value={trends.documents_24h_pct} suffix="%" period="(24h)" /> : totals.documents == null ? 'dbStats not permitted' : 'across all collections') : noDp}
        </OvKpi>
        <OvKpi tint="blue" icon={HardDrive} label="Storage Usage" value={usedBytes != null ? fmtBytes(usedBytes) : '—'} onClick={() => setTab('capacity')}
          spark={hist.length ? sp('storage') : diskSpark} sparkTitle={hist.length ? 'Sparkline: storage size, last 48 h' : 'Sparkline: disk used %'}>
          {capacityGb ? (
            <span className="block pr-2">
              of {capacityGb >= 1 ? `${capacityGb} GB` : `${Math.round(capacityGb * 1024)} MB`}{usedPct != null ? ` (${Math.round(usedPct)}%)` : ''}
              {usedPct != null && <span className="mt-1.5 block h-1.5 overflow-hidden rounded-full bg-[#E8EEF7]"><span className="block h-full rounded-full bg-[#2563EB]" style={{ width: `${usedPct}%` }} /></span>}
            </span>
          ) : dp.available ? `Indexes ${fmtBytes(totals.index_bytes)}` : 'Needs an API key or database access'}
        </OvKpi>
        <OvKpi tint="red" icon={Bell} label="Active Alerts" value={d.alerts?.available ? alerts.length : '—'} onClick={() => setTab('alerts')}
          spark={alertSpark} sparkTitle="Sparkline: Atlas alerts raised per hour, last 24 h">
          {d.alerts?.available ? <span className="flex flex-wrap gap-x-3"><span><Dot color="#DC2626" /> {crit} Critical</span><span><Dot color="#F59E0B" /> {alerts.length - crit} Warning</span></span> : 'Needs an Atlas API key'}
        </OvKpi>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.05fr_1.05fr_0.95fr]">
        <Panel icon={Boxes} title="Cluster Health" viewAll={() => setTab('clusters')}>
          {d.clusters?.available ? <HealthDonut clusters={clusters} /> : <Unavailable data={d.clusters} id={id} compact />}
        </Panel>
        <Panel icon={Activity} title="Operations (Ops/sec)" period={pOps} onPeriod={setPOps}
          legend={[{ name: 'Read', color: C.read }, { name: 'Write', color: C.write }, { name: 'Delete', color: C.del }]}>
          <MiniChart data={opsData} height={160} series={[{ key: 'read', name: 'Read', color: C.read }, { key: 'write', name: 'Write', color: C.write, fill: 0.08 }, { key: 'del', name: 'Delete', color: C.del, fill: 0 }]}
            empty={dp.available || hasApi ? 'Collecting samples — the first rate appears after the next refresh.' : noDp} />
          {src(mOps) && <p className="text-right text-[10.5px] text-subtle">{src(mOps)}</p>}
        </Panel>
        <Panel icon={Gauge} title="Latency (Average)" period={pLat} onPeriod={setPLat}>
          <MiniChart data={latData} height={175} unit="ms" fmt={(v) => `${Math.round(v)} ms`} series={[{ key: 'lat', name: 'Read latency', color: C.lat, fill: 0.18 }]} empty={latEmpty || (dp.available ? 'Collecting samples…' : noDp)} />
        </Panel>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.3fr_1fr_0.95fr]">
        <Panel icon={Boxes} title="Top Clusters by Resource Usage" viewAll={() => setTab('clusters')}>
          {!hasApi ? <Unavailable data={{ reason: 'Per-cluster CPU, memory and storage need an Atlas API key.', requires: 'api_key' }} id={id} compact />
            : usage.isLoading ? <InlineLoading label="Reading cluster metrics…" /> : !api(usage) ? <Unavailable data={usage.data} id={id} compact /> : (
              <table className="w-full text-[12.5px]">
                <thead><tr className="border-b border-[#EEF2F6] text-left text-[12px] font-semibold text-[#334155]"><th className="py-2 pr-2">#</th><th className="pr-2">Cluster Name</th><th className="pr-2">Status</th><th className="pr-2">CPU</th><th className="pr-2">Memory</th><th className="pr-2">Storage</th><th className="text-right">Ops/sec</th></tr></thead>
                <tbody>
                  {usageRows.map((r, i) => (
                    <tr key={r.name} className="border-b border-[#F1F5F9] last:border-0">
                      <td className="py-2.5 pr-2 text-[#334155]">{i + 1}</td>
                      <td className="pr-2"><button type="button" onClick={() => setTab('clusters')} className="font-medium text-[#2563EB] hover:underline">{r.name}</button></td>
                      <td className="pr-2"><span className="inline-flex items-center gap-1.5 text-[#334155]"><Dot color={(HEALTH[r.health] || HEALTH.warning).color} />{(HEALTH[r.health] || HEALTH.warning).label}</span></td>
                      <td className="pr-2"><UseBar v={r.cpu} why={tier} /></td>
                      <td className="pr-2"><UseBar v={r.memory} why={tier} /></td>
                      <td className="pr-2"><UseBar v={r.storage} /></td>
                      <td className="text-right font-semibold text-[#0F172A] tabular-nums">{r.ops != null ? big(r.ops) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
        </Panel>
        <Panel icon={Database} title="Database Size" note="(Top 5)" viewAll={() => setTab('databases')}>
          {dp.available ? <DbSizeTable rows={(dp.databases || []).slice(0, 5)} /> : <Unavailable data={{ reason: 'Database sizes are read from the cluster itself.', requires: 'uri_or_credentials' }} id={id} compact />}
        </Panel>
        <Panel icon={BellRing} title="Recent Alerts" viewAll={() => setTab('alerts')}>
          {!d.alerts?.available ? <Unavailable data={d.alerts} id={id} compact />
            : alerts.length ? <ul className="space-y-2">{alerts.slice(0, 3).map((a) => <AlertCard key={a.id} a={a} onClick={() => setTab('alerts')} />)}</ul>
              : <p className="grid h-[150px] place-items-center text-[12.5px] text-[#16A34A]"><span><Icon name="check" size={14} className="mr-1 inline" />No open Atlas alerts.</span></p>}
        </Panel>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Panel icon={Users} title="Connections" period={pConn} onPeriod={setPConn} legend={[{ name: 'Active Connections', color: C.read }]}>
          <MiniChart data={connData} height={130} series={[{ key: 'c', name: 'Active connections', color: C.read, fill: 0.16 }]} empty={dp.available || hasApi ? 'Collecting samples…' : noDp} />
        </Panel>
        <Panel icon={Waypoints} title="Network Traffic" period={pNet} onPeriod={setPNet} legend={[{ name: 'In (Read)', color: C.in }, { name: 'Out (Write)', color: C.out }]}>
          <MiniChart data={netData} height={130} fmt={(v) => `${v >= 10 ? Math.round(v) : v.toFixed(2)} Mbps`} series={[{ key: 'in', name: 'In (Read)', color: C.in, fill: 0.14 }, { key: 'out', name: 'Out (Write)', color: C.out, fill: 0.14 }]} empty={dp.available || hasApi ? 'Collecting samples…' : noDp} />
        </Panel>
        <Panel icon={TrendingUp} title="Storage Usage Trend" period={pSto} onPeriod={setPSto} legend={[{ name: 'Data Size', color: C.data }, { name: 'Index Size', color: C.index }]}>
          {sto.isLoading ? <InlineLoading label="Loading…" />
            : sto.data?.available ? <MiniChart data={stoData} height={130} fmt={(v) => `${v >= 10 ? Math.round(v) : v.toFixed(2)} GB`} series={[{ key: 'data', name: 'Data Size', color: C.data, fill: 0.16 }, { key: 'index', name: 'Index Size', color: C.index, fill: 0.16 }]}
              empty={sto.data.source === 'sampled' ? 'Sampled by ActMon every minute — the trend builds while the dashboard is open.' : undefined} />
              : <Unavailable data={sto.data?.reason ? { ...sto.data, requires: sto.data.requires || 'uri_or_credentials' } : sto.data} id={id} compact />}
        </Panel>
      </div>
      {connSpark.length === 0 && null}
    </div>
  );
}

function UseBar({ v, why }) {
  if (v == null) return <span className="text-[#94A3B8]" title={why ? `Atlas does not report this metric for ${why} clusters` : 'Not reported by Atlas'}>—</span>;
  const col = v >= 80 ? '#EF4444' : v >= 60 ? '#F59E0B' : '#22C55E';
  return (
    <span className="block w-[74px]">
      <span className="font-semibold text-[#0F172A] tabular-nums">{Math.round(v)}%</span>
      <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-[#EEF2F6]"><span className="block h-full rounded-full" style={{ width: `${Math.min(100, v)}%`, background: col }} /></span>
    </span>
  );
}

function DbSizeTable({ rows }) {
  const max = Math.max(1, ...rows.map((r) => r.storage_size || r.size_on_disk || 0));
  if (!rows.length) return <p className="py-8 text-center text-[12.5px] text-subtle">No user databases.</p>;
  return (
    <table className="w-full text-[12.5px]">
      <thead><tr className="border-b border-[#EEF2F6] text-left text-[12px] font-semibold text-[#334155]"><th className="py-2 pr-2">#</th><th className="pr-2">Database</th><th className="pr-2">Size</th><th className="pr-2 text-right">Collections</th><th className="text-right">Documents</th></tr></thead>
      <tbody>
        {rows.map((r, i) => {
          const v = r.storage_size || r.size_on_disk || 0;
          return (
            <tr key={r.name} className="border-b border-[#F1F5F9] last:border-0">
              <td className="py-2 pr-2 text-[#334155]">{i + 1}</td>
              <td className="pr-2 text-[#0F172A]">{r.name}</td>
              <td className="pr-2"><span className="flex items-center gap-2"><span className="h-1.5 w-16 overflow-hidden rounded-full bg-[#EEF2F6]"><span className="block h-full rounded-full bg-[#2563EB]" style={{ width: `${(v / max) * 100}%` }} /></span><span className="whitespace-nowrap tabular-nums">{fmtBytes(v)}</span></span></td>
              <td className="pr-2 text-right tabular-nums">{n(r.collections)}</td>
              <td className="text-right tabular-nums">{big(r.objects)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function AlertCard({ a, onClick }) {
  const sev = a.severity === 'critical' ? { c: '#DC2626', bg: '#FDECEC', label: 'Critical' } : a.severity === 'info' ? { c: '#2563EB', bg: '#E8F0FE', label: 'Info' } : { c: '#D97706', bg: '#FEF6E7', label: 'Warning' };
  return (
    <li>
      <button type="button" onClick={onClick} className="flex w-full items-start gap-3 rounded-lg border-l-[3px] p-2.5 text-left" style={{ borderColor: sev.c, background: sev.bg }}>
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-white/70" style={{ color: sev.c }}><Bell size={16} /></span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-bold text-[#0F172A]">{humanEvent(a)}</span>
          <span className="block truncate text-[12px] text-[#475569]">{a.cluster || a.host || '—'}</span>
          {a.metric != null && <span className="block truncate text-[12px] text-[#475569]">Current value {Number(a.metric).toLocaleString()} {a.units && a.units !== 'RAW' ? a.units.toLowerCase() : ''}</span>}
        </span>
        <span className="shrink-0 text-right text-[11.5px]"><span className="block text-[#475569]">{ago(a.created)}</span><b className="mt-1 inline-block rounded px-1.5 py-0.5" style={{ color: sev.c, background: 'rgba(255,255,255,.7)' }}>{sev.label}</b></span>
      </button>
    </li>
  );
}

function HealthPill({ h, state }) {
  const m = HEALTH[h] || HEALTH.warning;
  return <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold" title={state}><span className="h-2 w-2 rounded-full" style={{ background: m.color }} />{m.label}{state && state !== 'IDLE' ? ` (${state.toLowerCase()})` : ''}</span>;
}

function HealthDonut({ clusters }) {
  const total = clusters.length;
  const data = Object.entries(HEALTH).map(([k, m]) => ({ key: k, name: m.label, value: clusters.filter((c) => c.health === k).length, color: m.color }));
  if (!total) return <p className="py-8 text-center text-[12.5px] text-subtle">No clusters in this project.</p>;
  return (
    <div className="flex items-center gap-6 py-1">
      <div className="relative h-[170px] w-[170px] shrink-0">
        <ResponsiveContainer><PieChart><Pie data={data.filter((x) => x.value)} dataKey="value" innerRadius={56} outerRadius={80} startAngle={90} endAngle={-270} stroke="none" isAnimationActive={false}>
          {data.filter((x) => x.value).map((x) => <Cell key={x.key} fill={x.color} />)}</Pie></PieChart></ResponsiveContainer>
        <span className="pointer-events-none absolute inset-0 grid place-items-center text-center"><span><b className="block text-[26px] leading-none text-[#0F172A]">{total}</b><span className="text-[12px] text-[#475569]">Clusters</span></span></span>
      </div>
      <ul className="flex-1 space-y-3.5 text-[13px]">
        {data.map((x) => (
          <li key={x.key} className="grid grid-cols-[14px_1fr_32px_52px] items-center gap-2">
            <span className="h-3 w-3 rounded-[3px]" style={{ background: x.color }} />
            <span className="text-[#334155]">{x.name}</span>
            <b className="text-right text-[#0F172A]">{x.value}</b>
            <span className="text-right text-[#64748B]">{((x.value / total) * 100).toFixed(1)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const humanEvent = (a) => {
  const base = (a.metric_name || a.event || 'Alert').replace(/_/g, ' ').toLowerCase();
  return base.charAt(0).toUpperCase() + base.slice(1);
};

/* ── Schemas & Indexes / Capacity & Storage / Cost & Usage ───────────────── */

function SchemasTab({ id, d, conn, processes }) {
  const dbs = (d.data_plane?.databases || []).map((r) => r.name);
  const [db, setDb] = useState(conn.database_name && dbs.includes(conn.database_name) ? conn.database_name : dbs[0]);
  const [coll, setColl] = useState(null);
  const q = useQuery({ queryKey: ['atlas', id, 'colls', db], queryFn: () => atlasCollections(id, db), enabled: Boolean(db), retry: false });
  const cols = (q.data?.collections || []).filter((c) => c.type === 'collection');
  const pick = coll && cols.some((c) => c.name === coll) ? coll : cols[0]?.name;
  const iq = useQuery({ queryKey: ['atlas', id, 'idx', db, pick], queryFn: () => atlasIndexes(id, db, pick), enabled: Boolean(db && pick), retry: false });
  const primary = processes.find((p) => p.type === 'REPLICA_PRIMARY') || processes[0];
  const sq = useQuery({ queryKey: ['atlas', id, 'slow', primary?.id, 24], queryFn: () => atlasSlowQueries(id, primary.id, 24), enabled: Boolean(conn.has_api_key && primary), retry: false });
  if (!d.data_plane?.available || d.data_plane.source === 'atlas') {
    return <Card><Unavailable data={{ reason: 'Collection-level detail (each collection’s documents, sizes and indexes) is read from the cluster itself. With an API key only, Atlas exposes per-database totals — those are on the Databases tab.', requires: 'uri_or_credentials' }} id={id} /></Card>;
  }
  return (
    <div className="space-y-gutter">
      <div className="flex items-center gap-2 text-[12.5px] text-muted">Database <Select size="sm" width="auto" value={db} onChange={(v) => { setDb(v); setColl(null); }} options={dbs.map((x) => ({ id: x, label: x }))} /></div>
      <div className="grid gap-gutter xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <Card title={`Collections in ${db}`} icon="layers" sub="Pick a collection to see its indexes">
          {q.isLoading ? <InlineLoading label="Reading collStats…" /> : (
            <DataTable rowKey={(r) => r.name} rows={cols} onRow={(r) => setColl(r.name)} empty="No collections."
              cols={[{ key: 'name', label: 'Collection', render: (r) => <span className={cn('font-semibold', r.name === pick ? 'text-accent' : 'text-fg')}>{r.name}</span> },
                { key: 'indexes', label: 'Indexes', right: true, render: (r) => n(r.indexes) }, { key: 'index_size', label: 'Index size', right: true, render: (r) => fmtBytes(r.index_size) },
                { key: 'ratio', label: 'Index / data', right: true, render: (r) => (r.size ? `${Math.round(((r.index_size || 0) / r.size) * 100)}%` : '—') }]} />
          )}
        </Card>
        <Card title={pick ? `Indexes on ${pick}` : 'Indexes'} icon="layers" sub="Key pattern, options and how often each index was used since the last restart">
          {iq.isLoading ? <InlineLoading label="Loading indexes…" /> : !iq.data?.available ? <Unavailable data={iq.data} id={id} compact /> : (
            <DataTable rowKey={(r) => r.name} rows={iq.data.indexes}
              cols={[{ key: 'name', label: 'Index', render: (r) => <span className="font-mono text-[12px]">{r.name}</span> },
                { key: 'key', label: 'Keys', render: (r) => <span className="font-mono text-[11.5px] text-muted">{r.key.map(([k, v]) => `${k}: ${v}`).join(', ')}</span> },
                { key: 'opts', label: 'Options', render: (r) => <span className="flex flex-wrap gap-1">{r.unique && <Badge size="xs" tone="accent">unique</Badge>}{r.sparse && <Badge size="xs" tone="outline">sparse</Badge>}{r.ttl_sec != null && <Badge size="xs" tone="outline">TTL {r.ttl_sec}s</Badge>}</span> },
                { key: 'ops', label: 'Uses', right: true, render: (r) => (r.ops == null ? '—' : r.ops === 0 && r.name !== '_id_' ? <b className="text-warning-fg">0 · unused</b> : Number(r.ops).toLocaleString()) }]} />
          )}
        </Card>
      </div>
      <Card title="Suggested indexes" icon="search" sub="From Atlas Performance Advisor">
        {!conn.has_api_key ? <Unavailable data={{ reason: 'Index suggestions come from Atlas Performance Advisor.', requires: 'api_key' }} id={id} compact />
          : sq.isLoading ? <InlineLoading label="Reading Performance Advisor…" /> : !sq.data?.available ? <Unavailable data={sq.data} id={id} compact /> : (
            <DataTable rows={sq.data.suggested_indexes} empty="Performance Advisor has no index suggestions."
              cols={[{ key: 'ns', label: 'Namespace', render: (r) => <span className="font-mono text-[12px]">{r.ns}</span> },
                { key: 'index', label: 'Index', render: (r) => <span className="font-mono text-[12px]">{JSON.stringify(Object.assign({}, ...(r.index || [])))}</span> },
                { key: 'weight', label: 'Impact', right: true, render: (r) => (r.weight != null ? Number(r.weight).toFixed(1) : '—') }]} />
          )}
      </Card>
    </div>
  );
}

function CapacityTab({ id, d, conn, clusters, processes, period }) {
  const usage = useQuery({ queryKey: ['atlas', id, 'usage'], queryFn: () => atlasClusterUsage(id), enabled: conn.has_api_key, retry: false });
  const primary = processes.find((p) => p.type === 'REPLICA_PRIMARY') || processes[0];
  const m = useQuery({ queryKey: ['atlas', id, 'meas', primary?.id, period], queryFn: () => atlasMeasurements(id, primary.id, period), enabled: Boolean(conn.has_api_key && primary), retry: false });
  const sto = useQuery({ queryKey: ['atlas', id, 'storage', primary?.id, period], queryFn: () => atlasStorageTrend(id, primary?.id, period), retry: false });
  const dp = d.data_plane || {};
  const byName = Object.fromEntries((usage.data?.clusters || []).map((r) => [r.name, r]));
  const disk = m.data?.available ? m.data.disks?.[0] : null;
  const total = dp.totals?.storage_bytes || 0;
  return (
    <div className="space-y-gutter">
      <Card title="Cluster disk capacity" icon="desktop" sub="Provisioned disk per cluster from Atlas, and how full the primary's data partition is">
        {!conn.has_api_key ? <Unavailable data={{ reason: 'Provisioned disk and usage come from the Atlas Admin API.', requires: 'api_key' }} id={id} compact /> : (
          <DataTable rowKey={(r) => r.name} rows={clusters} empty="No clusters."
            cols={[{ key: 'name', label: 'Cluster', render: (r) => <b className="text-fg">{r.name}</b> }, { key: 'tier', label: 'Tier' },
              { key: 'disk_gb', label: 'Provisioned', right: true, render: (r) => (r.disk_gb ? (r.disk_gb >= 1 ? `${r.disk_gb} GB` : `${Math.round(r.disk_gb * 1024)} MB`) : '—') },
              { key: 'used', label: 'Used', render: (r) => <UseBar v={byName[r.name]?.storage} /> },
              { key: 'free', label: 'Free (approx.)', right: true, render: (r) => (r.disk_gb && byName[r.name]?.storage != null ? `${(r.disk_gb * (1 - byName[r.name].storage / 100)).toFixed(2)} GB` : '—') }]} />
        )}
      </Card>
      <div className="grid gap-gutter xl:grid-cols-2">
        <Card title={`Disk used (%)${disk ? ` · ${disk.partition}` : ''}`} icon="desktop" sub="Atlas measurement on the primary">
          {disk ? <TimeChart unit="%" data={mergeSeries(disk.series, { p: 'DISK_PARTITION_SPACE_PERCENT_USED' })} series={[{ key: 'p', name: 'Used', color: C.disk }]} />
            : <Unavailable data={m.data || { reason: 'Disk history comes from the Atlas Admin API.', requires: 'api_key' }} id={id} compact />}
        </Card>
        <Card title="Data and index size" icon="database" sub={sto.data?.source === 'sampled' ? 'Sampled by ActMon every minute while the dashboard is open' : 'Atlas per-database measurements'}>
          {sto.data?.available ? <TimeChart unit="B" data={sto.data.series} series={[{ key: 'data', name: 'Data', color: C.data }, { key: 'index', name: 'Indexes', color: C.index }]} />
            : <Unavailable data={sto.data ? { ...sto.data, requires: sto.data.requires || 'uri_or_credentials' } : null} id={id} compact />}
        </Card>
      </div>
      <Card title="Storage by database" icon="database" sub="Share of the cluster's on-disk size">
        {!dp.available ? <Unavailable data={{ reason: 'Per-database sizes are read from the cluster itself.', requires: 'uri_or_credentials' }} id={id} compact /> : (
          <DataTable rowKey={(r) => r.name} rows={dp.databases || []}
            cols={[{ key: 'name', label: 'Database', render: (r) => <b className="text-fg">{r.name}</b> },
              { key: 'storage_size', label: 'Storage', right: true, render: (r) => fmtBytes(r.storage_size ?? r.size_on_disk) },
              { key: 'share', label: 'Share', render: (r) => <Bar100 pct={total ? ((r.storage_size ?? r.size_on_disk ?? 0) / total) * 100 : null} color="#2563EB" /> },
              { key: 'index_size', label: 'Indexes', right: true, render: (r) => fmtBytes(r.index_size) }]} />
        )}
      </Card>
    </div>
  );
}

function CostTab({ id, conn }) {
  const q = useQuery({ queryKey: ['atlas', id, 'cost'], queryFn: () => atlasCost(id), enabled: conn.has_api_key, retry: false });
  const usd = (c) => (c == null ? '—' : `$${(c / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  if (!conn.has_api_key) return <Card><Unavailable data={{ reason: 'Cost comes from the Atlas billing API.', requires: 'api_key' }} id={id} /></Card>;
  if (q.isLoading) return <InlineLoading label="Reading the pending invoice…" />;
  if (!q.data?.available) {
    return (
      <Card>
        <Unavailable data={q.data} id={id} />
        {q.data?.requires === 'billing_role' && <p className="pb-6 text-center text-[12px] text-muted">Atlas → Organization Access Manager → API Keys → create a key with <b>Organization Billing Viewer</b>, then use it on this connection.</p>}
      </Card>
    );
  }
  const c = q.data;
  return (
    <div className="space-y-gutter">
      <div className="grid gap-gutter md:grid-cols-3">
        <Kpi icon="activity" label="This project, month to date" value={usd(c.project_cents)} sub={c.period_start ? `${new Date(c.period_start).toLocaleDateString()} – ${new Date(c.period_end).toLocaleDateString()}` : undefined} />
        <Kpi icon="cloud" tone="violet" label="Whole organisation, pending" value={usd(c.org_cents)} />
        <Kpi icon="server" tone="good" label="Clusters billed" value={c.by_cluster.filter((x) => x.name !== 'Project').length} />
      </div>
      <div className="grid gap-gutter xl:grid-cols-2">
        <Card title="By cluster" icon="server"><DataTable rows={c.by_cluster} rowKey={(r) => r.name} cols={[{ key: 'name', label: 'Cluster' }, { key: 'cents', label: 'Cost', right: true, render: (r) => usd(r.cents) }]} empty="No charges yet this month." /></Card>
        <Card title="By item" icon="list"><DataTable rows={c.by_sku} rowKey={(r) => r.name} cols={[{ key: 'name', label: 'Item' }, { key: 'cents', label: 'Cost', right: true, render: (r) => usd(r.cents) }]} empty="No charges yet this month." /></Card>
      </div>
    </div>
  );
}

/* ── Atlas Clusters — cluster topology, same card language as the PostgreSQL / Oracle cluster pages ── */

const ROLE = {
  REPLICA_PRIMARY: { label: 'PRIMARY', text: 'text-indigo-700', bg: 'bg-indigo-100' },
  REPLICA_SECONDARY: { label: 'SECONDARY', text: 'text-cyan-700', bg: 'bg-cyan-100' },
  REPLICA_ARBITER: { label: 'ARBITER', text: 'text-slate-600', bg: 'bg-slate-100' },
  SHARD_MONGOS: { label: 'MONGOS', text: 'text-violet-700', bg: 'bg-violet-100' },
  SHARD_CONFIG_PRIMARY: { label: 'CONFIG PRIMARY', text: 'text-indigo-700', bg: 'bg-indigo-100' },
  SHARD_CONFIG_SECONDARY: { label: 'CONFIG SECONDARY', text: 'text-cyan-700', bg: 'bg-cyan-100' },
  SHARD_PRIMARY: { label: 'SHARD PRIMARY', text: 'text-indigo-700', bg: 'bg-indigo-100' },
  SHARD_SECONDARY: { label: 'SHARD SECONDARY', text: 'text-cyan-700', bg: 'bg-cyan-100' },
};
const STALE_MS = 10 * 60 * 1000;   // a process with no Atlas sample for 10 min is not reported as up

function ClustersTab({ id, clData, clusters, allProcesses, loading, openScope, scope }) {
  const nq = useQuery({ queryKey: ['atlas', id, 'nodes'], queryFn: () => atlasNodes(id), enabled: Boolean(clData?.available), refetchInterval: 60000, retry: false });
  if (loading) return <InlineLoading label="Loading clusters…" />;
  if (!clData?.available) return <Card><Unavailable data={clData} id={id} /></Card>;
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <span className="h-6 w-1 rounded-full bg-indigo-500" />
        <h2 className="text-[15px] font-black tracking-wide text-fg uppercase">Cluster topology</h2>
        <span className="rounded-full bg-indigo-50 px-2.5 py-0.5 text-[11px] font-bold text-indigo-700">{clusters.length} cluster{clusters.length === 1 ? '' : 's'}</span>
        {clData.processes_error && <span className="text-[12px] text-warning-fg">{clData.processes_error}</span>}
      </div>
      <ClusterTopology clusters={clusters} processes={allProcesses} nodes={nq.data?.nodes} nodesLoading={nq.isLoading}
        highlight={scope?.node} onOpenNode={(p) => openScope({ node: p.id })} onOpenCluster={(c) => openScope({ cluster: c.name })} />
    </div>
  );
}

/**
 * One section per Atlas cluster with a card per mongod / mongos — the same layout as the Oracle RAC and PostgreSQL
 * cluster pages. Shared by the Atlas Clusters tab and the MongoDB Atlas connections page.
 */
export function ClusterTopology({ clusters, processes, nodes: nodeList, nodesLoading, onOpenNode, onOpenCluster, highlight }) {
  const nodes = Object.fromEntries((nodeList || []).map((x) => [x.id, x]));
  if (!clusters.length) return <Card><p className="py-8 text-center text-[12.5px] text-subtle">No clusters in this project.</p></Card>;
  return (
    <div className="space-y-6">
      {clusters.map((c) => {
        const mine = processes.filter((p) => p.cluster === c.name)
          .sort((a, b) => (a.type === 'REPLICA_PRIMARY' ? -1 : b.type === 'REPLICA_PRIMARY' ? 1 : (a.alias || '').localeCompare(b.alias || '')));
        const prim = mine.find((p) => p.type === 'REPLICA_PRIMARY');
        const pm = prim ? nodes[prim.id] : null;
        const hm = HEALTH[c.health] || HEALTH.warning;
        return (
          <section key={c.name} className="overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
            <header className="flex flex-wrap items-center gap-4 border-b border-border bg-sunken/40 px-6 py-4">
              <span className="grid h-11 w-11 place-items-center rounded-xl bg-indigo-50 text-indigo-600"><GitBranch size={19} /></span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-[17px] font-black text-fg">{c.name}</h3>
                  <span className="rounded-md bg-indigo-100 px-2 py-0.5 text-[11px] font-bold text-indigo-700">{c.type === 'SHARDED' ? 'Sharded cluster' : 'Replica set'}</span>
                  {c.tier && <span className="rounded-md bg-slate-100 px-2 py-0.5 text-[11px] font-bold text-slate-600">{c.tier}</span>}
                  <span className="text-[12px] text-subtle">{[c.provider, c.regions.join(', ')].filter(Boolean).join(' · ')}</span>
                  <span className="text-[12px] text-subtle"><Layers size={11} className="mr-1 inline" />{mine.length} node{mine.length === 1 ? '' : 's'}</span>
                  {c.version && <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-bold text-emerald-700">MongoDB {c.version}</span>}
                </div>
              </div>
              <div className="flex items-center gap-4 rounded-xl border border-border bg-surface px-4 py-2 text-center" title="Primary node, latest Atlas sample">
                {[['CPU', pm?.cpu, 'text-orange-600'], ['RAM', pm?.memory, 'text-violet-600'], ['DISK', pm?.disk, 'text-blue-600']].map(([k, v, cls]) => (
                  <div key={k}><p className="text-[10px] font-bold text-subtle">{k}</p><p className={cn('text-[14px] font-black tabular-nums', v == null ? 'text-subtle' : cls)}>{v == null ? '—' : `${Math.round(v)}%`}</p></div>
                ))}
              </div>
              <span className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12px] font-black uppercase" style={{ color: hm.color, borderColor: `color-mix(in srgb, ${hm.color} 35%, transparent)`, background: `color-mix(in srgb, ${hm.color} 9%, transparent)` }}>
                <span className="h-2 w-2 rounded-full" style={{ background: hm.color }} />{c.paused ? 'Paused' : hm.label}
              </span>
              {onOpenCluster && (
                <button type="button" onClick={() => onOpenCluster(c)} className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-slate-900 px-3.5 text-[12.5px] font-bold text-white hover:bg-indigo-700">
                  <Activity size={13} />Cluster dashboard
                </button>
              )}
            </header>
            <div className="flex flex-wrap items-stretch justify-center gap-4 p-6">
              {mine.length === 0 && <p className="py-6 text-[12.5px] text-subtle">Atlas lists no processes for this cluster.</p>}
              {mine.map((p, i) => (
                <div key={p.id} className="flex items-center gap-4">
                  {i > 0 && (
                    <div className="hidden flex-col items-center text-[10px] font-bold text-subtle lg:flex">
                      <span className="h-px w-12 bg-slate-300" /><span className="mt-1 tracking-wide">REPLICATION</span>
                    </div>
                  )}
                  <NodeCard p={p} m={nodes[p.id]} loading={nodesLoading} active={highlight === p.id} onOpen={onOpenNode ? () => onOpenNode(p, c) : undefined} />
                </div>
              ))}
            </div>
            <footer className="flex flex-wrap gap-x-6 gap-y-1 border-t border-border px-6 py-3 text-[12px] text-muted">
              <span>Disk {c.disk_gb ? `${c.disk_gb} GB` : '—'}</span>
              <span>Backups {c.backup == null ? '—' : c.backup ? 'enabled' : 'off'}</span>
              <span>Termination protection {c.termination_protection ? 'on' : 'off'}</span>
              {c.created && <span>Created {new Date(c.created).toLocaleDateString()}</span>}
              <span className="text-subtle">State {c.state}</span>
            </footer>
          </section>
        );
      })}
    </div>
  );
}

function NodeCard({ p, m, loading, onOpen, active }) {
  const role = ROLE[p.type] || { label: String(p.type || 'NODE').replace(/_/g, ' '), text: 'text-slate-600', bg: 'bg-slate-100' };
  const fresh = m?.last_sample ? Date.now() - new Date(m.last_sample).getTime() < STALE_MS : null;
  const up = fresh === true;
  const short = (p.alias || p.host || '').split('.')[0];
  return (
    <article className={cn('flex w-[300px] flex-col overflow-hidden rounded-2xl border-2 bg-surface shadow-md', active && 'ring-4 ring-indigo-300', up ? 'border-emerald-100' : fresh === false ? 'border-red-100' : 'border-border')}>
      <span className={cn('h-1.5', up ? 'bg-emerald-500' : fresh === false ? 'bg-red-500' : 'bg-slate-300')} />
      <div className="flex flex-1 flex-col p-5">
        <div className="mb-4 flex items-center justify-between">
          <span className={cn('rounded-lg px-2.5 py-1 text-[11px] font-black tracking-wider', role.text, role.bg)}>{role.label}</span>
          <span className="flex flex-col items-center gap-0.5" title={m?.last_sample ? `Last Atlas sample ${fullTime(m.last_sample)}` : 'No recent Atlas sample'}>
            <span className={cn('h-2.5 w-2.5 rounded-full', up ? 'animate-pulse bg-emerald-500' : fresh === false ? 'bg-red-500' : 'bg-slate-300')} />
            <span className={cn('text-[9px] font-black', up ? 'text-emerald-600' : fresh === false ? 'text-red-500' : 'text-slate-400')}>DB</span>
          </span>
        </div>
        <h4 className="truncate text-[16px] leading-tight font-black text-fg" title={p.alias || p.host}>{short}</h4>
        <p className="mt-1 truncate font-mono text-[11.5px] text-muted" title={`${p.host}:${p.port}`}>{p.host}:{p.port}</p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {p.version && <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-bold text-emerald-700">v{p.version}</span>}
          {p.replica_set && <span className="rounded-full bg-slate-100 px-2 py-0.5 font-mono text-[10.5px] text-slate-600">{p.replica_set}</span>}
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2">
          <div className={cn('flex items-center gap-1.5 rounded-xl border px-3 py-2 text-[11px] font-bold', up ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : fresh === false ? 'border-red-200 bg-red-50 text-red-600' : 'border-slate-200 bg-slate-50 text-slate-500')}>
            <Server size={11} />{up ? 'Reporting' : fresh === false ? 'No samples' : loading ? 'Checking…' : 'Unknown'}
          </div>
          <div className={cn('flex items-center gap-1.5 rounded-xl border px-3 py-2 text-[11px] font-bold', p.type === 'REPLICA_PRIMARY' ? 'border-indigo-200 bg-indigo-50 text-indigo-700' : 'border-cyan-200 bg-cyan-50 text-cyan-700')}>
            <Database size={11} />{p.type === 'REPLICA_PRIMARY' ? 'Accepts writes' : 'Read replica'}
          </div>
        </div>
        <dl className="mt-4 grid grid-cols-4 gap-1 text-center">
          {[['CPU', m?.cpu, '%'], ['RAM', m?.memory, '%'], ['Conn', m?.connections, ''], ['Ops/s', m?.ops, '']].map(([k, v, u]) => (
            <div key={k} className="rounded-lg bg-sunken px-1 py-1.5"><dt className="text-[9.5px] font-bold text-subtle">{k}</dt><dd className="text-[12.5px] font-black text-fg tabular-nums">{v == null ? '—' : `${u ? Math.round(v) : big(Math.round(v))}${u}`}</dd></div>
          ))}
        </dl>
        <p className="mt-3 text-[11px] text-subtle"><Icon name="clock" size={11} className="mr-1 inline" />{m?.last_sample ? `sampled ${ago(m.last_sample)}` : m?.error || (loading ? 'loading metrics…' : 'no Atlas sample')}</p>
        {onOpen && (
          <button type="button" onClick={onOpen} className="mt-4 inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-slate-900 text-[13px] font-bold text-white hover:bg-indigo-700">
            <Activity size={14} />{active ? 'Viewing this instance' : 'Dashboard'}
          </button>
        )}
      </div>
    </article>
  );
}

/* ── Performance ─────────────────────────────────────────────────────────── */

function PerformanceTab({ id, d, conn, processes, period, clusters }) {
  const { q, picker } = useMeasurements(id, processes, period, conn.has_api_key);
  const ops = useQuery({ queryKey: ['atlas', id, 'ops'], queryFn: () => atlasCurrentOps(id, 0), refetchInterval: 15000, retry: false, enabled: Boolean(conn.has_uri || conn.username) });
  const ms = q.data?.available ? q.data.series : null;
  const sampled = d.sampled || [];
  const disk = q.data?.disks?.[0];
  // Metrics Atlas refused for this cluster (free / shared tiers expose only a subset) — said plainly, not as "no data yet".
  const tier = clusters.find((c) => c.tier)?.tier;
  const nr = (...names) => (names.every((x) => q.data?.not_reported?.includes(x))
    ? `Atlas does not report this metric for ${tier ? `${tier} ` : 'this tier of '}clusters${/^M[025]$|FLEX/i.test(tier || '') ? ' — it needs a dedicated (M10+) cluster' : ''}.`
    : undefined);
  return (
    <div className="space-y-gutter">
      {conn.has_api_key ? (
        q.isLoading ? <InlineLoading label="Loading Atlas metrics…" /> : !ms ? <Card><Unavailable data={q.data} id={id} /></Card> : (
          <>
            <div className="flex items-center gap-2 text-[12px] text-muted">Process {picker}<span className="text-subtle">· Atlas metrics, {q.data.granularity.replace('PT', '').toLowerCase()} granularity</span></div>
            <div className="grid gap-gutter xl:grid-cols-2">
              <Card title="CPU usage (%)" icon="cpu"><TimeChart empty={nr('SYSTEM_NORMALIZED_CPU_USER')} data={mergeSeries(ms, { user: 'SYSTEM_NORMALIZED_CPU_USER', kernel: 'SYSTEM_NORMALIZED_CPU_KERNEL' })} unit="%" series={[{ key: 'user', name: 'User', color: C.cpu }, { key: 'kernel', name: 'Kernel', color: C.mem }]} /></Card>
              <Card title="Memory" icon="memory"><TimeChart empty={nr('SYSTEM_MEMORY_USED')} data={mergeSeries(ms, { used: 'SYSTEM_MEMORY_USED', avail: 'SYSTEM_MEMORY_AVAILABLE' }).map((r) => ({ ...r, used: r.used * 1024, avail: r.avail * 1024 }))} unit="B" series={[{ key: 'used', name: 'Used', color: C.mem }, { key: 'avail', name: 'Available', color: C.write }]} /></Card>
              <Card title="Operations (ops/sec)" icon="zap"><TimeChart data={mergeSeries(ms, { q: 'OPCOUNTER_QUERY', i: 'OPCOUNTER_INSERT', u: 'OPCOUNTER_UPDATE', d: 'OPCOUNTER_DELETE', g: 'OPCOUNTER_GETMORE', c: 'OPCOUNTER_CMD' })} series={[{ key: 'q', name: 'Query', color: C.read }, { key: 'i', name: 'Insert', color: C.write }, { key: 'u', name: 'Update', color: C.upd }, { key: 'd', name: 'Delete', color: C.del }, { key: 'c', name: 'Command', color: C.cmd }]} /></Card>
              <Card title="Operation execution time (ms)" icon="clock"><TimeChart empty={nr('OP_EXECUTION_TIME_READS', 'OP_EXECUTION_TIME_WRITES')} area={false} unit="ms" data={mergeSeries(ms, { r: 'OP_EXECUTION_TIME_READS', w: 'OP_EXECUTION_TIME_WRITES', c: 'OP_EXECUTION_TIME_COMMANDS' })} series={[{ key: 'r', name: 'Reads', color: C.read }, { key: 'w', name: 'Writes', color: C.write }, { key: 'c', name: 'Commands', color: C.cmd }]} /></Card>
              <Card title="Connections" icon="link"><TimeChart data={mergeSeries(ms, { c: 'CONNECTIONS' })} series={[{ key: 'c', name: 'Connections', color: C.read }]} /></Card>
              <Card title="Network (bytes/sec)" icon="activity"><TimeChart unit="B" data={mergeSeries(ms, { in: 'NETWORK_BYTES_IN', out: 'NETWORK_BYTES_OUT' })} series={[{ key: 'in', name: 'In', color: C.in }, { key: 'out', name: 'Out', color: C.out }]} /></Card>
              <Card title={`Disk used (%)${disk ? ` · ${disk.partition}` : ''}`} icon="desktop">
                {disk ? <TimeChart unit="%" data={mergeSeries(disk.series, { p: 'DISK_PARTITION_SPACE_PERCENT_USED' })} series={[{ key: 'p', name: 'Used', color: C.disk }]} /> : <p className="py-8 text-center text-[12px] text-subtle">Atlas returned no disk partitions for this process.</p>}
              </Card>
              <Card title="Query targeting (scanned / returned)" icon="search" sub="Above 1000 means queries scan far more than they return — usually a missing index">
                <TimeChart empty={nr('QUERY_TARGETING_SCANNED_PER_RETURNED')} area={false} data={mergeSeries(ms, { s: 'QUERY_TARGETING_SCANNED_PER_RETURNED' })} series={[{ key: 's', name: 'Scanned per returned', color: C.del }]} />
              </Card>
            </div>
          </>
        )
      ) : (
        <>
          <Notice tone="info" title="Live-sampled metrics">CPU, memory and disk history come from the Atlas Admin API. Without an API key, ActMon samples serverStatus every 15 s while this page is open. <Link className="font-semibold underline" to={`/mongoatlas-edit/${id}`}>Add an API key</Link></Notice>
          <div className="grid gap-gutter xl:grid-cols-2">
            <Card title="Operations (ops/sec)" icon="zap"><TimeChart data={sampled} series={[{ key: 'reads', name: 'Reads', color: C.read }, { key: 'inserts', name: 'Inserts', color: C.write }, { key: 'updates', name: 'Updates', color: C.upd }, { key: 'deletes', name: 'Deletes', color: C.del }]} /></Card>
            <Card title="Latency (ms)" icon="clock"><TimeChart area={false} unit="ms" data={sampled} series={[{ key: 'read_latency_ms', name: 'Reads', color: C.read }, { key: 'write_latency_ms', name: 'Writes', color: C.write }]} /></Card>
            <Card title="Connections" icon="link"><TimeChart data={sampled} series={[{ key: 'connections', name: 'Connections', color: C.read }]} /></Card>
            <Card title="Network (bytes/sec)" icon="activity"><TimeChart unit="B" data={sampled} series={[{ key: 'net_in', name: 'In', color: C.in }, { key: 'net_out', name: 'Out', color: C.out }]} /></Card>
          </div>
        </>
      )}
      <CurrentOps q={ops} id={id} enabled={Boolean(conn.has_uri || conn.username)} />
    </div>
  );
}

function CurrentOps({ q, id, enabled }) {
  return (
    <Card title="Current operations" icon="zap" sub="Running now · op type, namespace and duration only — query values are never shown">
      {!enabled ? <Unavailable data={{ reason: 'Needs database access.', requires: 'uri_or_credentials' }} id={id} compact />
        : q.isLoading ? <InlineLoading label="Reading currentOp…" /> : !q.data?.available ? <Unavailable data={q.data} id={id} compact />
          : <DataTable rowKey={(r) => r.opid} rows={q.data.ops} empty="No user operations running right now."
            cols={[{ key: 'op', label: 'Op' }, { key: 'ns', label: 'Namespace', render: (r) => <span className="font-mono text-[12px]">{r.ns}</span> },
              { key: 'secs', label: 'Running', right: true, render: (r) => (r.micros != null ? `${(r.micros / 1000).toFixed(0)} ms` : `${r.secs}s`) },
              { key: 'plan', label: 'Plan', render: (r) => <span className={cn('text-[12px]', r.plan === 'COLLSCAN' && 'font-bold text-danger-fg')}>{r.plan || '—'}</span> },
              { key: 'client', label: 'Client app' }, { key: 'waiting_lock', label: 'Lock wait', render: (r) => (r.waiting_lock ? 'Yes' : 'No') }]} />}
    </Card>
  );
}

/* ── Databases / Collections ─────────────────────────────────────────────── */

function DatabasesTab({ id, d, setTab }) {
  const dp = d.data_plane || {};
  if (!dp.available) return <Card><Unavailable data={{ reason: 'Databases lists every database on the cluster with its size, collection and document counts. It is read from the cluster itself.', requires: 'uri_or_credentials' }} id={id} /></Card>;
  const rows = dp.databases || [];
  const atlasSrc = dp.source === 'atlas';
  const chart = rows.slice(0, 10).map((r) => ({ name: r.name, data: r.data_size || 0, index: r.index_size || 0 }));
  return (
    <div className="space-y-gutter">
      {dp.databases_error && <Notice tone="warning" title="Database list is incomplete.">{dp.databases_error}</Notice>}
      {chart.length > 0 && (
        <Card title="Data vs index size (top 10)" icon="database">
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={chart} margin={{ top: 6, right: 8, left: -6, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
              <XAxis dataKey="name" tick={{ fontSize: 11, fill: 'var(--fg-subtle)' }} interval={0} />
              <YAxis tickFormatter={fmtBytes} tick={{ fontSize: 11, fill: 'var(--fg-subtle)' }} width={64} />
              <Tooltip formatter={(v, nm) => [fmtBytes(v), nm]} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
              <RLegend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="data" name="Data" stackId="a" fill={C.read} radius={[0, 0, 0, 0]} />
              <Bar dataKey="index" name="Indexes" stackId="a" fill={C.cmd} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Card>
      )}
      <Card title={`Databases (${rows.length})`} icon="database"
        sub={atlasSrc ? 'From Atlas database measurements (API key) — refreshed every 5 minutes' : 'Click a database to browse its collections'}>
        <DataTable rowKey={(r) => `${r.cluster || ''}.${r.name}`} rows={rows} onRow={atlasSrc ? undefined : (r) => { try { sessionStorage.setItem(`atlas-db-${id}`, r.name); } catch { /* non-fatal */ } setTab('collections'); }}
          cols={[{ key: 'name', label: 'Database', render: (r) => <span className={cn('font-semibold', atlasSrc ? 'text-fg' : 'text-accent-text')}>{r.name}</span> },
            ...(atlasSrc ? [{ key: 'cluster', label: 'Cluster' }] : []),
            { key: 'storage_size', label: 'Storage', right: true, render: (r) => fmtBytes(r.storage_size ?? r.size_on_disk) },
            { key: 'data_size', label: 'Data', right: true, render: (r) => fmtBytes(r.data_size) },
            { key: 'index_size', label: 'Indexes', right: true, render: (r) => fmtBytes(r.index_size) },
            { key: 'collections', label: 'Collections', right: true, render: (r) => n(r.collections) },
            { key: 'objects', label: 'Documents', right: true, render: (r) => n(r.objects) },
            { key: 'indexes', label: '# Indexes', right: true, render: (r) => n(r.indexes) }]} />
      </Card>
    </div>
  );
}

function CollectionsTab({ id, d, conn }) {
  const dbs = (d.data_plane?.databases || []).map((r) => r.name);
  const initial = (() => { try { return sessionStorage.getItem(`atlas-db-${id}`); } catch { return null; } })();
  const [db, setDb] = useState(initial && dbs.includes(initial) ? initial : (conn.database_name && dbs.includes(conn.database_name) ? conn.database_name : dbs[0]));
  const [coll, setColl] = useState(null);
  const q = useQuery({ queryKey: ['atlas', id, 'colls', db], queryFn: () => atlasCollections(id, db), enabled: Boolean(db), retry: false });
  const iq = useQuery({ queryKey: ['atlas', id, 'idx', db, coll], queryFn: () => atlasIndexes(id, db, coll), enabled: Boolean(db && coll), retry: false });
  if (!d.data_plane?.available || d.data_plane.source === 'atlas') return <Card><Unavailable data={{ reason: 'Collection-level detail (each collection’s documents, sizes and indexes) is read from the cluster itself. With an API key only, Atlas exposes per-database totals — those are on the Databases tab.', requires: 'uri_or_credentials' }} id={id} /></Card>;
  if (!dbs.length) return <Card><p className="py-8 text-center text-[12.5px] text-subtle">No user databases on this cluster.</p></Card>;
  return (
    <div className="space-y-gutter">
      <div className="flex items-center gap-2 text-[12.5px] text-muted">Database <Select size="sm" width="auto" value={db} onChange={(v) => { setDb(v); setColl(null); }} options={dbs.map((x) => ({ id: x, label: x }))} /></div>
      <Card title={`Collections in ${db}`} icon="layers" sub="Click a collection to see its indexes and how often each is used">
        {q.isLoading ? <InlineLoading label="Reading collStats…" /> : !q.data?.available ? <Unavailable data={q.data} id={id} compact /> : (
          <DataTable rowKey={(r) => r.name} rows={q.data.collections} onRow={(r) => r.type === 'collection' && setColl(r.name)} empty="No collections."
            cols={[{ key: 'name', label: 'Collection', render: (r) => <span className="font-semibold text-accent-text">{r.name}{r.type !== 'collection' && <Badge tone="outline" size="xs" className="ml-2">{r.type}</Badge>}{r.capped && <Badge tone="outline" size="xs" className="ml-2">capped</Badge>}</span> },
              { key: 'count', label: 'Documents', right: true, render: (r) => n(r.count) },
              { key: 'size', label: 'Data', right: true, render: (r) => fmtBytes(r.size) },
              { key: 'storage_size', label: 'Storage', right: true, render: (r) => fmtBytes(r.storage_size) },
              { key: 'index_size', label: 'Index size', right: true, render: (r) => fmtBytes(r.index_size) },
              { key: 'indexes', label: '# Indexes', right: true, render: (r) => n(r.indexes) },
              { key: 'avg_obj_size', label: 'Avg doc', right: true, render: (r) => fmtBytes(r.avg_obj_size) }]} />
        )}
      </Card>
      <Drawer open={Boolean(coll)} onClose={() => setColl(null)} title={coll || ''} subtitle={`Indexes · ${db}`} icon="layers">
        {iq.isLoading ? <InlineLoading label="Loading indexes…" /> : !iq.data?.available ? <Unavailable data={iq.data} id={id} compact /> : (
          <ul className="space-y-2">
            {iq.data.indexes.map((ix) => (
              <li key={ix.name} className="rounded-lg border border-border p-3 text-[12.5px]">
                <div className="flex items-center justify-between gap-2"><b className="font-mono text-fg">{ix.name}</b><span className="text-muted">{ix.ops != null ? `${Number(ix.ops).toLocaleString()} uses` : 'usage n/a'}</span></div>
                <p className="mt-1 font-mono text-[11.5px] text-muted">{'{ '}{ix.key.map(([k, v]) => `${k}: ${v}`).join(', ')}{' }'}</p>
                <div className="mt-1.5 flex flex-wrap gap-1">{ix.unique && <Badge size="xs" tone="accent">unique</Badge>}{ix.sparse && <Badge size="xs" tone="outline">sparse</Badge>}{ix.ttl_sec != null && <Badge size="xs" tone="outline">TTL {ix.ttl_sec}s</Badge>}{ix.ops === 0 && ix.name !== '_id_' && <Badge size="xs" tone="warning">unused since {String(ix.since || '').slice(0, 10)}</Badge>}</div>
              </li>
            ))}
          </ul>
        )}
      </Drawer>
    </div>
  );
}

/* ── Query Analytics ─────────────────────────────────────────────────────── */

function QueryTab({ id, conn, processes, period }) {
  const hours = { '1h': 1, '6h': 6, '24h': 24, '7d': 168 }[period] || 24;
  const { pid, picker } = useMeasurements(id, processes, period, false);
  const sq = useQuery({ queryKey: ['atlas', id, 'slow', pid, hours], queryFn: () => atlasSlowQueries(id, pid, hours), enabled: Boolean(conn.has_api_key && pid), retry: false });
  const ops = useQuery({ queryKey: ['atlas', id, 'ops-slow'], queryFn: () => atlasCurrentOps(id, 1), refetchInterval: 15000, retry: false, enabled: Boolean(conn.has_uri || conn.username) });
  const rows = sq.data?.queries || [];
  const byNs = useMemo(() => {
    const m = {};
    rows.forEach((r) => { const k = r.ns || '—'; m[k] = m[k] || { ns: k, count: 0, total: 0, max: 0, examined: 0, returned: 0, collscan: 0 }; const x = m[k]; x.count += 1; x.total += r.duration_ms || 0; x.max = Math.max(x.max, r.duration_ms || 0); x.examined += r.docs_examined || 0; x.returned += r.returned || 0; if (r.plan === 'COLLSCAN') x.collscan += 1; });
    return Object.values(m).sort((a, b) => b.total - a.total);
  }, [rows]);
  return (
    <div className="space-y-gutter">
      <Card title="Slow queries (Performance Advisor)" icon="search" sub={`Slower than Atlas' threshold, ${PERIODS.find((p) => p.id === period)?.label.toLowerCase()} · namespace and timings only`} actions={picker}>
        {!conn.has_api_key ? <Unavailable data={{ reason: 'Slow queries come from Atlas Performance Advisor.', requires: 'api_key' }} id={id} compact />
          : sq.isLoading ? <InlineLoading label="Reading Performance Advisor…" /> : !sq.data?.available ? <Unavailable data={sq.data} id={id} compact /> : (
            <DataTable rows={byNs} rowKey={(r) => r.ns} empty="No slow queries in this range."
              cols={[{ key: 'ns', label: 'Namespace', render: (r) => <span className="font-mono text-[12px]">{r.ns}</span> },
                { key: 'count', label: 'Count', right: true }, { key: 'avg', label: 'Avg ms', right: true, render: (r) => Math.round(r.total / r.count).toLocaleString() },
                { key: 'max', label: 'Max ms', right: true, render: (r) => r.max.toLocaleString() },
                { key: 'ratio', label: 'Scanned / returned', right: true, render: (r) => (r.returned ? Math.round(r.examined / r.returned).toLocaleString() : r.examined ? '∞' : '—') },
                { key: 'collscan', label: 'COLLSCAN', right: true, render: (r) => (r.collscan ? <b className="text-danger-fg">{r.collscan}</b> : 0) }]} />
          )}
      </Card>
      {sq.data?.available && (
        <Card title="Suggested indexes" icon="layers" sub="From Atlas Performance Advisor">
          <DataTable rows={sq.data.suggested_indexes} empty="Performance Advisor has no index suggestions."
            cols={[{ key: 'ns', label: 'Namespace', render: (r) => <span className="font-mono text-[12px]">{r.ns}</span> },
              { key: 'index', label: 'Index', render: (r) => <span className="font-mono text-[12px]">{JSON.stringify(Object.assign({}, ...(r.index || [])))}</span> },
              { key: 'weight', label: 'Impact', right: true, render: (r) => (r.weight != null ? Number(r.weight).toFixed(1) : '—') }]} />
        </Card>
      )}
      <CurrentOps q={ops} id={id} enabled={Boolean(conn.has_uri || conn.username)} />
    </div>
  );
}

/* ── Replication & Sharding ──────────────────────────────────────────────── */

function ReplicationTab({ id, conn, allProcesses }) {
  const q = useQuery({ queryKey: ['atlas', id, 'repl'], queryFn: () => atlasReplication(id), refetchInterval: 30000, retry: false, enabled: Boolean(conn.has_uri || conn.username) });
  const rs = q.data?.replica_set;
  const sh = q.data?.sharding;
  const STATE = { PRIMARY: 'success', SECONDARY: 'accent', ARBITER: 'outline' };
  return (
    <div className="space-y-gutter">
      <Card title={rs?.set ? `Replica set ${rs.set}` : 'Replica set'} icon="branch" sub="replSetGetStatus — refreshed every 30 s">
        {!(conn.has_uri || conn.username) ? (allProcesses.length ? (
          <DataTable rows={allProcesses} rowKey={(r) => r.id} cols={[{ key: 'alias', label: 'Member', render: (r) => <span className="font-mono text-[12px]">{r.alias || r.host}:{r.port}</span> }, { key: 'type', label: 'Role (Atlas API)', render: (r) => String(r.type || '').replace(/_/g, ' ').toLowerCase() }, { key: 'replica_set', label: 'Set' }]} />
        ) : <Unavailable data={{ reason: 'Member state needs database access.', requires: 'uri_or_credentials' }} id={id} compact />)
          : q.isLoading ? <InlineLoading label="Reading replica set…" /> : !q.data?.available ? <Unavailable data={q.data} id={id} compact />
            : rs?.available === false ? <Unavailable data={rs} id={id} compact /> : (
              <DataTable rows={rs.members} rowKey={(r) => r.name}
                cols={[{ key: 'name', label: 'Member', render: (r) => <span className="font-mono text-[12px]">{r.name}</span> },
                  { key: 'state', label: 'State', render: (r) => <Badge size="xs" tone={STATE[r.state] || 'danger'}>{r.state}</Badge> },
                  { key: 'health', label: 'Health', render: (r) => (r.health === 1 ? <span className="text-success-fg">Up</span> : <b className="text-danger-fg">Down</b>) },
                  { key: 'lag_sec', label: 'Replication lag', right: true, render: (r) => (r.lag_sec == null ? '—' : <span className={cn(r.lag_sec > 60 && 'font-bold text-danger-fg', r.lag_sec > 10 && r.lag_sec <= 60 && 'text-warning-fg')}>{r.lag_sec.toFixed(0)} s</span>) },
                  { key: 'ping_ms', label: 'Ping', right: true, render: (r) => (r.ping_ms != null ? `${r.ping_ms} ms` : '—') },
                  { key: 'sync_source', label: 'Syncing from', render: (r) => <span className="font-mono text-[11.5px]">{r.sync_source || '—'}</span> },
                  { key: 'uptime_sec', label: 'Uptime', right: true, render: (r) => (r.uptime_sec != null ? `${Math.floor(r.uptime_sec / 86400)}d ${Math.floor((r.uptime_sec % 86400) / 3600)}h` : '—') }]} />
            )}
      </Card>
      <Card title="Sharding" icon="layers">
        {!q.data?.available || !sh ? <p className="py-6 text-center text-[12.5px] text-subtle">{conn.has_uri || conn.username ? 'Waiting for the replica-set read…' : 'Needs database access.'}</p>
          : sh.available === false ? <Unavailable data={sh} id={id} compact />
            : !sh.sharded ? <p className="py-6 text-center text-[12.5px] text-muted">This is a replica set, not a sharded cluster — there is no shard distribution or balancer.</p> : (
              <>
                <p className="mb-3 text-[12.5px] text-muted">Balancer: <b className="text-fg">{sh.balancer?.mode}</b>{sh.balancer?.in_round ? ' · balancing now' : ''}</p>
                <DataTable rows={sh.shards} rowKey={(r) => r.id} cols={[{ key: 'id', label: 'Shard' }, { key: 'host', label: 'Hosts', render: (r) => <span className="font-mono text-[11.5px]">{r.host}</span> }, { key: 'state', label: 'State', render: (r) => (r.state === 1 ? 'Active' : r.state ?? '—') }]} />
              </>
            )}
      </Card>
    </div>
  );
}

/* ── Alerts ──────────────────────────────────────────────────────────────── */

function AlertsTab({ id, conn }) {
  const { can } = usePermissions();
  const qc = useQueryClient();
  const [status, setStatus] = useState('OPEN');
  const [open, setOpen] = useState(null);
  const [ackHours, setAckHours] = useState('24');
  const q = useQuery({ queryKey: ['atlas', id, 'alerts', status], queryFn: () => atlasAlerts(id, status), refetchInterval: 30000, retry: false, enabled: conn.has_api_key });
  const ack = useMutation({
    mutationFn: () => atlasAckAlert(id, open.id, Number(ackHours)),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['atlas', id] }); setOpen(null); },
  });
  if (!conn.has_api_key) return <Card><Unavailable data={{ reason: 'Atlas alerts are read through the Atlas Admin API.', requires: 'api_key' }} id={id} /></Card>;
  const rows = q.data?.alerts || [];
  return (
    <Card title="Atlas alerts" icon="bell" sub="Raised by the alert settings of the Atlas project" actions={<Select size="sm" width="auto" value={status} onChange={setStatus} options={[{ id: 'OPEN', label: 'Open' }, { id: 'TRACKING', label: 'Tracking' }, { id: 'CLOSED', label: 'Closed' }]} />}>
      {q.isLoading ? <InlineLoading label="Loading alerts…" /> : !q.data?.available ? <Unavailable data={q.data} id={id} compact /> : (
        <DataTable rows={rows} rowKey={(r) => r.id} onRow={setOpen} empty={`No ${status.toLowerCase()} alerts.`}
          cols={[{ key: 'event', label: 'Alert', render: (r) => <span className="font-semibold text-fg">{humanEvent(r)}</span> },
            { key: 'cluster', label: 'Cluster', render: (r) => r.cluster || r.host || '—' },
            { key: 'severity', label: 'Severity', render: (r) => <Badge size="xs" tone={r.severity === 'critical' ? 'danger' : 'warning'}>{r.severity}</Badge> },
            { key: 'metric', label: 'Value', right: true, render: (r) => (r.metric != null ? `${Number(r.metric).toLocaleString()} ${r.units || ''}` : '—') },
            { key: 'created', label: 'Triggered', render: (r) => <span title={fullTime(r.created)}>{ago(r.created)}</span> },
            { key: 'status', label: 'Status', render: (r) => (r.acknowledged_until && new Date(r.acknowledged_until) > new Date() ? <Badge size="xs" tone="outline">Acknowledged</Badge> : <Badge size="xs" tone={r.status === 'OPEN' ? 'danger' : 'outline'}>{r.status.toLowerCase()}</Badge>) }]} />
      )}
      <Drawer open={Boolean(open)} onClose={() => setOpen(null)} title={open ? humanEvent(open) : ''} subtitle={open?.cluster || open?.host} icon="bell">
        {open && (
          <div className="space-y-4 text-[13px]">
            <dl className="grid grid-cols-2 gap-3">
              {[['Severity', open.severity], ['Status', open.status], ['Event', open.event], ['Metric', open.metric_name || '—'], ['Current value', open.metric != null ? `${open.metric} ${open.units || ''}` : '—'], ['Host', open.host || '—'],
                ['Triggered', fullTime(open.created)], ['Updated', fullTime(open.updated)], ['Last notified', open.last_notified ? fullTime(open.last_notified) : '—'],
                ['Acknowledged until', open.acknowledged_until ? fullTime(open.acknowledged_until) : '—'], ['Acknowledged by', open.acknowledged_by || '—']]
                .map(([k, v]) => <div key={k}><dt className="text-[11.5px] text-subtle">{k}</dt><dd className="font-semibold break-words text-fg">{v}</dd></div>)}
            </dl>
            {open.status === 'OPEN' && can('/alerts', 'edit') && (
              <div className="rounded-lg border border-border p-3">
                <p className="mb-2 text-[12.5px] font-semibold text-fg">Acknowledge in Atlas</p>
                <div className="flex items-center gap-2">
                  <Select size="sm" width="auto" value={ackHours} onChange={setAckHours} options={[{ id: '1', label: 'for 1 hour' }, { id: '4', label: 'for 4 hours' }, { id: '24', label: 'for 24 hours' }, { id: '168', label: 'for 7 days' }]} />
                  <Button size="sm" variant="primary" icon="check" loading={ack.isPending} onClick={() => ack.mutate()}>Acknowledge</Button>
                </div>
                {ack.isError && <p className="mt-2 text-[12px] text-danger-fg">{atlasErrorText(ack.error)}</p>}
                <p className="mt-2 text-[11px] text-subtle">Needs the API key to have Project Owner. Atlas stops notifying until the time you pick.</p>
              </div>
            )}
          </div>
        )}
      </Drawer>
    </Card>
  );
}

/* ── Backups / Security ──────────────────────────────────────────────────── */

function BackupsTab({ id, conn }) {
  const q = useQuery({ queryKey: ['atlas', id, 'backups'], queryFn: () => atlasBackups(id), retry: false, enabled: conn.has_api_key, refetchInterval: 300000 });
  if (!conn.has_api_key) return <Card><Unavailable data={{ reason: 'Backups are read through the Atlas Admin API.', requires: 'api_key' }} id={id} /></Card>;
  if (q.isLoading) return <InlineLoading label="Loading backups…" />;
  if (!q.data?.available) return <Card><Unavailable data={q.data} id={id} /></Card>;
  return (
    <div className="space-y-gutter">
      {q.data.clusters.map((c) => {
        const latest = c.snapshots?.[0];
        const stale = latest && Date.now() - new Date(latest.created).getTime() > 36 * 3600 * 1000;
        return (
          <Card key={c.cluster} title={c.cluster} icon="desktop"
            sub={c.backup_enabled === false ? 'Cloud backup is OFF for this cluster' : latest ? `Last snapshot ${ago(latest.created)}${c.next_snapshot ? ` · next ${fullTime(c.next_snapshot)}` : ''}` : undefined}
            actions={c.backup_enabled === false ? <Badge tone="danger">Backups off</Badge> : stale ? <Badge tone="warning">No snapshot in 36 h</Badge> : latest ? <Badge tone="success">Healthy</Badge> : null}>
            {c.error ? <Notice tone="warning" title="Snapshots could not be read.">{c.error}</Notice> : (
              <>
                {c.policy?.length > 0 && <div className="mb-3 flex flex-wrap gap-1.5">{c.policy.map((p, i) => <Badge key={i} tone="outline" size="xs">{p.frequency?.toLowerCase()} · keep {p.retention}</Badge>)}</div>}
                <DataTable rows={c.snapshots} rowKey={(r) => r.id} empty="No snapshots yet."
                  cols={[{ key: 'created', label: 'Taken', render: (r) => fullTime(r.created) }, { key: 'status', label: 'Status', render: (r) => <Badge size="xs" tone={r.status === 'completed' ? 'success' : r.status === 'failed' ? 'danger' : 'outline'}>{r.status}</Badge> },
                    { key: 'type', label: 'Type' }, { key: 'frequency', label: 'Frequency' }, { key: 'size_bytes', label: 'Size', right: true, render: (r) => fmtBytes(r.size_bytes) }, { key: 'expires', label: 'Expires', render: (r) => (r.expires ? fullTime(r.expires) : '—') }]} />
              </>
            )}
          </Card>
        );
      })}
    </div>
  );
}

function SecurityTab({ id, conn }) {
  const q = useQuery({ queryKey: ['atlas', id, 'security'], queryFn: () => atlasSecurity(id), retry: false, enabled: conn.has_api_key, refetchInterval: 300000 });
  if (!conn.has_api_key) return <Card><Unavailable data={{ reason: 'Database users and the IP access list are read through the Atlas Admin API.', requires: 'api_key' }} id={id} /></Card>;
  if (q.isLoading) return <InlineLoading label="Loading security settings…" />;
  if (!q.data?.available) return <Card><Unavailable data={q.data} id={id} /></Card>;
  const { users, access_list: al } = q.data;
  const open = Array.isArray(al) && al.some((a) => a.open_to_world);
  return (
    <div className="space-y-gutter">
      {open && <Notice tone="danger" title="The IP access list allows 0.0.0.0/0.">Any address on the internet can attempt to connect to these clusters. Restrict it to known networks.</Notice>}
      <div className="grid gap-gutter xl:grid-cols-2">
        <Card title="Database users" icon="users">
          {users?.available === false ? <Unavailable data={users} compact /> : (
            <DataTable rows={users} rowKey={(r) => `${r.auth_db}.${r.username}`} cols={[{ key: 'username', label: 'User', render: (r) => <b className="text-fg">{r.username}</b> }, { key: 'auth', label: 'Auth' },
              { key: 'roles', label: 'Roles', render: (r) => <span className="flex flex-wrap gap-1">{r.roles.map((x) => <Badge key={x} size="xs" tone={/atlasAdmin|dbAdminAnyDatabase|readWriteAnyDatabase|root/.test(x) ? 'warning' : 'outline'}>{x}</Badge>)}</span> },
              { key: 'scopes', label: 'Clusters', render: (r) => (r.scopes.length ? r.scopes.join(', ') : 'All') }, { key: 'expires', label: 'Expires', render: (r) => (r.expires ? fullTime(r.expires) : 'Never') }]} />
          )}
        </Card>
        <Card title="IP access list" icon="shield">
          {al?.available === false ? <Unavailable data={al} compact /> : (
            <DataTable rows={al} rowKey={(r) => r.entry} cols={[{ key: 'entry', label: 'Entry', render: (r) => <span className={cn('font-mono text-[12px]', r.open_to_world && 'font-bold text-danger-fg')}>{r.entry}</span> }, { key: 'comment', label: 'Comment' }, { key: 'expires', label: 'Expires', render: (r) => (r.expires ? fullTime(r.expires) : 'Permanent') }]} />
          )}
        </Card>
      </div>
    </div>
  );
}

/* ── Settings ────────────────────────────────────────────────────────────── */

function SettingsTab({ id, conn }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { can } = usePermissions();
  const [confirm, setConfirm] = useState(false);
  const retest = useMutation({ mutationFn: () => retestAtlasConnection(id), onSettled: () => qc.invalidateQueries({ queryKey: ['atlas', id] }) });
  const del = useMutation({ mutationFn: () => deleteAtlasConnection(id), onSuccess: () => { qc.invalidateQueries({ queryKey: ['atlasConnections'] }); navigate('/mongoatlas-servers'); } });
  const rows = [['Name', conn.connection_name], ['Environment', conn.environment], ['Project label', conn.project_label || '—'], ['Authentication', { uri: 'Connection URI', credentials: 'Database credentials', api_key: 'Atlas API key only' }[conn.auth_method]],
    ['Cluster host', conn.host || '—'], ['Database user', conn.username || (conn.has_uri ? 'in URI' : '—')], ['Default database', conn.database_name || '—'],
    ['Atlas project ID', conn.project_id || '—'], ['API key', conn.has_api_key ? `${conn.api_public_key} (private key stored encrypted)` : 'Not configured'],
    ['Monitoring scope', conn.monitoring_scope?.join(', ') || 'all'], ['Last check', conn.last_checked ? `${fullTime(conn.last_checked)} — ${conn.status}` : 'never']];
  return (
    <div className="grid gap-gutter xl:grid-cols-[minmax(0,1fr)_360px]">
      <Card title="Connection" icon="settings" actions={can('/databases', 'edit') && <Button size="sm" variant="primary" icon="settings" onClick={() => navigate(`/mongoatlas-edit/${id}`)}>Edit</Button>}>
        <dl className="divide-y divide-border text-[13px]">{rows.map(([k, v]) => <div key={k} className="flex gap-4 py-2"><dt className="w-40 shrink-0 text-subtle">{k}</dt><dd className="min-w-0 font-semibold break-words text-fg">{v}</dd></div>)}</dl>
        {conn.last_error && <Notice tone="danger" title="Last error" className="mt-3">{conn.last_error}</Notice>}
      </Card>
      <div className="space-y-gutter">
        <Card title="Reconnect" icon="refresh">
          <p className="mb-3 text-[12.5px] text-muted">Runs the connection test again with the saved settings.</p>
          <Button icon="refresh" loading={retest.isPending} onClick={() => retest.mutate()}>Test now</Button>
          {retest.data && (
            <ul className="mt-3 space-y-1.5 text-[12px]">{Object.entries(retest.data.results || {}).map(([k, r]) => <li key={k} className={r.ok ? 'text-success-fg' : 'text-danger-fg'}>{k === 'database' ? 'Cluster' : 'Atlas API'}: {r.ok ? 'OK' : r.message}</li>)}</ul>
          )}
          {retest.isError && <p className="mt-2 text-[12px] text-danger-fg">{atlasErrorText(retest.error)}</p>}
        </Card>
        {can('/databases', 'delete') && (
          <Card title="Remove connection" icon="trash">
            <p className="mb-3 text-[12.5px] text-muted">Deletes the stored URI, password and API key from ActMon. Atlas itself is not changed.</p>
            <Button variant="danger" icon="trash" onClick={() => setConfirm(true)}>Remove…</Button>
          </Card>
        )}
      </div>
      <ConfirmDialog open={confirm} onCancel={() => setConfirm(false)} onConfirm={() => del.mutate()} loading={del.isPending} tone="danger" title="Remove this Atlas connection?" confirmLabel="Remove" cancelLabel="Cancel">
        <p className="text-[13px] text-muted"><b className="text-fg">{conn.connection_name}</b> and its stored secrets are deleted from ActMon.</p>
      </ConfirmDialog>
    </div>
  );
}
