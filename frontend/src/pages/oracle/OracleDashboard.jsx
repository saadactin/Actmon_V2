import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Key, Lock, Table } from 'lucide-react';
import client from '@/api/client';

import EngineDashboardHeader from '@/components/layout/EngineDashboardHeader';
import HostResources from '@/pages/postgresql/PgHostResources';
import TrendChart from '@/components/gauges/TrendChart';
import ChartCard from '@/components/charts/ChartCard';
import { STATUS, bandFor } from '@/components/charts/status';
import { computeInstanceHealthScore } from '@/utils/oracleHealth';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Icon from '@/components/ui/Icon';
import Input from '@/components/ui/Input';
import Notice from '@/components/ui/Notice';
import Select from '@/components/ui/Select';
import Table2, { EmptyState } from '@/components/ui/Table';
import { InlineLoading, PageLoading } from '@/components/ui/Loading';
import { Paged } from '@/components/ui/Pagination';
import { DashboardScopeProvider } from '@/context/DashboardAppearanceContext';

import ObjectTable from '@/pages/_shared/ObjectTable';
import TableDetailsDialog from '@/pages/_shared/TableDetails';
import { adaptOracleTableDetails } from '@/pages/_shared/tableDetailsAdapters';
import OracleMaintenanceModule from './OracleMaintenanceModule';
import {
  DefRow, MetricTile, Panel, SqlCell, StatCell, StateChip, StatusPill, TablePanel, UsageBar,
} from '@/pages/_shared/enginePanels';
import {
  ORACLE_TABLE_HINTS, TABLESPACE_COLUMNS, TABLE_COLUMNS,
  fmtBytes, fmtNumber, oracleTableRow, orderColumns, withHints,
} from '@/config/dbCatalog';
import { WAIT_CLASS_TONES, explainWait, isIdleWait } from '@/config/oracleWaits';
import { tabsForTopology } from '@/config/oracleDashboardNav';
import { healthBand } from '@/utils/oracleHealth';
import OracleLiveQueries from './LiveQueries';

/**
 * Oracle dashboard — sixteen tabs, each backed by its own endpoint.
 *
 * The queries are `enabled` per tab on purpose: the Oracle service issues real
 * v$ / dba_ queries per call, and fetching all sixteen on every load would put a
 * pointless load on the instance being monitored. Only the tab you are looking at
 * polls, and the overview's own payload covers the headline numbers.
 *
 * Wait events carry their explanation from `config/oracleWaits` rather than being
 * listed as bare names — a wait event only helps someone who already knows what it
 * means.
 */

const REFRESH_INTERVAL = 15; // seconds

const get = (id, path, params) =>
  client.get(`/connections/oracle/${id}/${path}`, params ? { params } : undefined).then((r) => r.data);

const num = (v) => Number(v) || 0;
const mb = (v) => num(v) * 1048576;

/**
 * A log sequence, an SCN or a PID is an IDENTIFIER, not a magnitude — it gets
 * compared and quoted, never summed. `fmtNumber` would render sequence 90215 as
 * "90.2K", which cannot be typed into a RECOVER command.
 */
const idNum = (v) => (v === null || v === undefined || v === '' ? null : String(v));

/**
 * One tab's query. A hook rather than an inline call so the dashboard reads as
 * fifteen declarations instead of fifteen near-identical `useQuery` blocks;
 * `enabled` is what keeps a tab from polling the instance while it is off screen.
 */
function useTabQuery(id, key, path, opts = {}) {
  return useQuery({
    queryKey: [key, id],
    queryFn: () => get(id, path),
    retry: false,
    ...opts,
  });
}

/* Session and account states, mapped once. */
const SESSION_TONES = { ACTIVE: 'success', INACTIVE: 'neutral', KILLED: 'danger', SNIPED: 'warning' };
const ACCOUNT_TONES = {
  OPEN: 'success',
  'EXPIRED(GRACE)': 'warning',
  EXPIRED: 'warning',
  LOCKED: 'danger',
  'LOCKED(TIMED)': 'danger',
  'EXPIRED & LOCKED': 'danger',
  'EXPIRED(GRACE) & LOCKED(TIMED)': 'danger',
};
const REDO_TONES = { CURRENT: 'success', ACTIVE: 'warning', INACTIVE: 'neutral', UNUSED: 'neutral' };

function HealthBadge({ score }) {
  const band = score >= 80 ? STATUS.good : score >= 60 ? STATUS.warning : STATUS.critical;
  return (
    <span
      className="flex h-control shrink-0 items-center gap-1.5 rounded-control px-2.5 text-[12px] font-bold text-white"
      style={{ background: band.color }}
      title={`Composite of session use, buffer cache hit rate, fullest tablespace, host CPU and wait count (${score}/100)`}
    >
      <Icon name="activity" size={13} />
      Health {score}
    </span>
  );
}

const DEPLOYMENT_OPTIONS = [
  { id: 'standalone', label: 'Standalone' },
  { id: 'rac', label: 'RAC' },
  { id: 'data_guard', label: 'Data Guard' },
  { id: 'rac_dg', label: 'RAC + Data Guard' },
];

function detectedTopologyLabel(topology) {
  if (!topology || (!topology.is_rac && !topology.is_dataguard)) return 'Standalone';
  if (topology.is_rac && topology.is_dataguard) return 'RAC + Data Guard';
  if (topology.is_rac) return 'RAC';
  return 'Data Guard';
}

function detectedDeploymentType(topology) {
  if (topology?.is_rac && topology?.is_dataguard) return 'rac_dg';
  if (topology?.is_rac) return 'rac';
  if (topology?.is_dataguard) return 'data_guard';
  return 'standalone';
}

/**
 * §1 — the user's selection is a hint, never a source of truth. This banner
 * lets them record it (client.put persists ConnectionMaster.oracle_deployment_type)
 * while always showing what was actually auto-detected from GV$INSTANCE/
 * V$DATABASE, and flags a mismatch rather than silently trusting the dropdown.
 */
function OracleDeploymentBanner({ id, connection, topology, onSaved }) {
  const [saving, setSaving] = useState(false);
  const selected = connection?.oracle_deployment_type || 'standalone';
  const detected = detectedDeploymentType(topology);
  const mismatch = selected !== detected;

  const save = async (value) => {
    setSaving(true);
    try {
      await client.put(`/connections/oracle/${id}/deployment-type`, { deployment_type: value });
      onSaved?.();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-control border border-border bg-sunken px-3 py-2">
      <span className="text-[12px] font-semibold text-muted">Oracle Deployment:</span>
      <Select value={selected} onChange={save} options={DEPLOYMENT_OPTIONS} size="sm" width="auto" disabled={saving} />
      <Badge tone={mismatch ? 'warning' : 'neutral'} size="xs">
        Detected: {detectedTopologyLabel(topology)}
      </Badge>
      {mismatch && (
        <span className="text-[11px] text-warning-fg">
          Selection does not match the detected topology — ActMon always monitors the detected state.
        </span>
      )}
    </div>
  );
}

/**
 * Data Guard standbys are separate connections/databases (§9, §13) — this
 * lists the ones already linked via oracle_topology_links and lets the user
 * link another already-registered Oracle connection as a standby/far-sync/
 * cascaded-standby peer. No new inline connection sub-wizard: link an Oracle
 * connection registered the normal way (Add OS Server / Add Data), same as
 * every other engine.
 */
function OracleTopologyPeers({ id }) {
  const [peerId, setPeerId] = useState('');
  const [linkType, setLinkType] = useState('standby');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const peersQ = useQuery({
    queryKey: ['oracleTopologyPeers', id],
    queryFn: () => client.get(`/connections/oracle/${id}/topology/peers`).then((r) => r.data),
    retry: false,
  });
  const allConnsQ = useQuery({
    queryKey: ['oracleAllConnections'],
    queryFn: () => client.get('/connections/oracle/').then((r) => r.data),
    retry: false,
  });

  const downstream = peersQ.data?.downstream || [];
  const upstream = peersQ.data?.upstream || [];
  const candidates = (allConnsQ.data?.data || []).filter((c) => String(c.id) !== String(id));

  const addPeer = async () => {
    if (!peerId) return;
    setSaving(true); setError(null);
    try {
      await client.post(`/connections/oracle/${id}/topology/peers`, { peer_connection_id: Number(peerId), link_type: linkType });
      setPeerId('');
      peersQ.refetch();
    } catch (e) {
      setError(e?.response?.data?.detail || 'Could not link that connection.');
    } finally {
      setSaving(false);
    }
  };

  const removePeer = async (linkId) => {
    await client.delete(`/connections/oracle/topology/peers/${linkId}`);
    peersQ.refetch();
  };

  return (
    <Panel title="Data Guard Peers" icon="branch" subtitle="Standby / far-sync / cascaded-standby connections linked to this primary">
      {upstream.length > 0 && (
        <p className="mb-2 text-[12px] text-muted">
          This connection is a <strong>{upstream[0].link_type}</strong> of{' '}
          <strong>{upstream[0].peer?.name || `connection #${upstream[0].connection_id}`}</strong>.
        </p>
      )}
      {downstream.length === 0 ? (
        <EmptyState icon="branch" title="No standby peers linked yet" body="Link an already-registered Oracle connection as this primary's standby." />
      ) : (
        <ul className="mb-gutter-sm space-y-1.5">
          {downstream.map((l) => (
            <li key={l.id} className="flex items-center justify-between rounded-control border border-border px-3 py-1.5 text-[12px]">
              <span>
                <Badge tone="accent" size="xs">{l.link_type}</Badge>{' '}
                <span className="font-semibold">{l.peer?.name || `Connection #${l.peer_connection_id}`}</span>
                {l.peer?.host && <span className="ml-1 text-muted">({l.peer.host}:{l.peer.port})</span>}
              </span>
              <Button size="xs" variant="ghost" onClick={() => removePeer(l.id)}>Unlink</Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <Select value={peerId} onChange={setPeerId} width="auto" size="sm"
          placeholder="Choose a connection…"
          options={candidates.map((c) => ({ id: String(c.id), label: `${c.connection_name} (${c.host}:${c.port})` }))} />
        <Select value={linkType} onChange={setLinkType} width="auto" size="sm"
          options={[
            { id: 'standby', label: 'Standby' },
            { id: 'far_sync', label: 'Far Sync' },
            { id: 'cascaded_standby', label: 'Cascaded Standby' },
          ]} />
        <Button size="sm" onClick={addPeer} disabled={!peerId || saving}>Add Standby</Button>
      </div>
      {error && <p className="mt-1.5 text-[11px] text-danger-fg">{error}</p>}
    </Panel>
  );
}

function TopologyNodeBox({ label, sub, ok }) {
  return (
    <div className="flex min-w-[140px] flex-col rounded-control border border-border bg-panel px-3 py-2">
      <span className="flex items-center gap-1.5 text-[12px] font-semibold text-fg">
        <span className={cnDot(ok)} />
        {label}
      </span>
      {sub && <span className="mt-0.5 text-[11px] text-subtle">{sub}</span>}
    </div>
  );
}
function cnDot(ok) {
  return `inline-block h-2 w-2 rounded-full ${ok ? 'bg-success' : 'bg-danger'}`;
}

/**
 * §25 — a clear visual: who's Primary, who's Standby, which nodes/instances
 * are running, is transport/apply healthy, what's the lag. Auto-discovered
 * from oracle_rac_nodes/oracle_data_guard, not hand-curated like the existing
 * host-level ReplicationTopology/GaleraTopology on DatabaseServersPage.
 */
function OracleTopologyDiagram({ topology, racNodes, dataGuard }) {
  const nodes = racNodes?.nodes || [];
  const isRac = topology?.is_rac;
  const isDg = topology?.is_dataguard;

  if (!isRac && !isDg) {
    return <TopologyNodeBox label="Standalone Instance" sub="No RAC, no Data Guard" ok />;
  }

  return (
    <div className="flex flex-col gap-gutter">
      <div>
        <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-subtle">
          {isRac ? 'RAC Cluster (Primary)' : 'Primary'}
        </p>
        <div className="flex flex-wrap gap-2">
          {isRac ? nodes.map((n) => (
            <TopologyNodeBox key={n.instance_number}
              label={`Node ${n.instance_number} / ${n.instance_name}`}
              sub={`${n.host_name} — ${n.instance_status}`}
              ok={String(n.instance_status).toUpperCase() === 'OPEN'} />
          )) : (
            <TopologyNodeBox label={dataGuard?.role || 'Primary'} sub={dataGuard?.open_mode} ok />
          )}
        </div>
      </div>

      {isDg && (
        <>
          <div className="flex items-center gap-2 pl-2 text-[11px] text-muted">
            <span>↓ Redo Transport</span>
            <Badge tone={dataGuard?.transport_status === 'failed' ? 'danger' : 'neutral'} size="xs">
              {dataGuard?.transport_status || 'unknown'}
            </Badge>
            <span>Lag: {dataGuard?.transport_lag_sec != null ? `${dataGuard.transport_lag_sec}s` : 'N/A'}</span>
          </div>
          <div>
            <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-subtle">Standby</p>
            <TopologyNodeBox label="Standby database" sub={`Apply: ${dataGuard?.apply_status || 'unknown'} · Lag: ${dataGuard?.apply_lag_sec != null ? `${dataGuard.apply_lag_sec}s` : 'N/A'}`}
              ok={dataGuard?.apply_status !== 'stopped'} />
          </div>
        </>
      )}
    </div>
  );
}

/** A wait event with its meaning attached. */
function WaitEventCell({ event, waitClass }) {
  const k = explainWait(event, waitClass);
  if (!event) return <span className="text-subtle">—</span>;
  return (
    <span className="block">
      <span className="flex items-center gap-1.5">
        <span className="truncate-safe max-w-[200px] font-mono text-[11px] text-fg">{event}</span>
        {waitClass && (
          <Badge tone={WAIT_CLASS_TONES[waitClass] || 'neutral'} size="xs">{waitClass}</Badge>
        )}
      </span>
      {k.why && <span className="mt-0.5 block max-w-[380px] text-[11px] leading-snug text-subtle">{k.why}</span>}
    </span>
  );
}

/* Oracle's Tables tab lists one schema's tables. Oracle reports a single segment
   size, so the data/index split columns are dropped rather than left blank. */
const ORACLE_TABLE_COLUMNS = orderColumns(
  withHints(TABLE_COLUMNS, ORACLE_TABLE_HINTS),
  ['name', 'rows', 'total', 'cols', 'idx', 'updated', 'actions'],
);

export default function OracleDashboard() {
  const { id, tab } = useParams();
  const navigate = useNavigate();

  const activeTab = tab || 'overview';
  const setActiveTab = (t) =>
    navigate(`/oracle-dashboard/${id}${t && t !== 'overview' ? `/${t}` : ''}`);

  const [countdown, setCountdown] = useState(REFRESH_INTERVAL);
  const [trend, setTrend] = useState({ sessions: [], bufHit: [], pga: [] });
  const [schemaOwner, setSchemaOwner] = useState('');
  const [statSearch, setStatSearch] = useState('');
  const [paramSearch, setParamSearch] = useState('');
  const [paramScope, setParamScope] = useState('key');
  const [selectedTable, setSelectedTable] = useState(null); // { owner, name }
  const [openMonitor, setOpenMonitor] = useState(null); // { sql_id, sql_exec_id }
  const countRef = useRef(null);

  const on = (t) => activeTab === t;

  const { data, isLoading, error, refetch, isFetching, dataUpdatedAt } = useQuery({
    queryKey: ['oracleDashboard', id],
    queryFn: () => get(id, 'oracle-dashboard'),
    retry: false,
    refetchInterval: REFRESH_INTERVAL * 1000,
  });

  /* Per-tab, so only what is on screen queries the instance. `useTabQuery` is a
     custom hook (see below) — every call below is unconditional and in the same
     order on every render, which is what the rules of hooks require. */
  const q = (key, path, opts) => useTabQuery(id, key, path, opts);

  const sga = q('oracleSga', 'oracle-sga-detail', { refetchInterval: 30000, enabled: on('performance') });
  const pga = q('oraclePga', 'oracle-pga-detail', { refetchInterval: 30000, enabled: on('performance') });
  const waits = q('oracleWaits', 'oracle-wait-events', { refetchInterval: 15000, enabled: on('performance') || on('overview') });
  const sessions = q('oracleSessions', 'oracle-sessions', { refetchInterval: 10000, enabled: on('sessions') });
  const topSql = q('oracleTopSql', 'oracle-top-sql', { refetchInterval: 30000, enabled: on('sql') });
  const planInstability = q('oraclePlanInstability', 'oracle-plan-instability', { refetchInterval: 30000, enabled: on('sql') });
  const tablespaces = q('oracleTablespaces', 'oracle-tablespaces', { refetchInterval: 30000, enabled: on('tablespaces') || on('overview') });
  const objects = q('oracleObjects', 'oracle-objects', { refetchInterval: 60000, enabled: on('objects') });
  const users = q('oracleUsers', 'oracle-users', { refetchInterval: 60000, enabled: on('users') });
  const redo = q('oracleRedo', 'oracle-redo-logs', { refetchInterval: 30000, enabled: on('redologs') });
  const dataGuard = q('oracleDg', 'oracle-data-guard', { refetchInterval: 30000, enabled: on('dataguard') });
  const processes = q('oracleProcs', 'oracle-processes', { refetchInterval: 15000, enabled: on('processes') });
  const sysStats = q('oracleSysStats', 'oracle-system-stats', { refetchInterval: 30000, enabled: on('systemstats') });
  const slowSql = q('oracleSlowSql', 'oracle-slow-queries', { refetchInterval: 30000, enabled: on('slowqueries') });
  const locks = q('oracleLocks', 'oracle-locks', { refetchInterval: 10000, enabled: on('locks') });
  const sqlMonitor = q('oracleSqlMonitor', 'oracle-sql-monitor', { refetchInterval: 5000, enabled: on('sqlmonitor') });
  // One pass instead of 3 separate .filter() calls over the same array on
  // every render (this data refreshes every 5s; the countdown tick re-runs
  // the render every 1s regardless).
  const sqlMonitorCounts = useMemo(() => {
    const rows = sqlMonitor.data?.executions || [];
    let executing = 0; let parallel = 0; let finished = 0;
    for (const e of rows) {
      if (e.status === 'EXECUTING') executing++; else finished++;
      if (num(e.px_allocated) > 0) parallel++;
    }
    return { executing, parallel, finished };
  }, [sqlMonitor.data]);
  const params = q('oracleParams', 'oracle-parameters', { staleTime: 120000, enabled: on('parameters') });
  // Was an inline IIFE re-filtering up to ~400 parameters on every render —
  // including the once-a-second countdown tick this whole dashboard re-
  // renders on, even while the Parameters tab sits idle with nothing typed.
  // Memoized on the actual inputs that can change its result instead.
  const filteredParams = useMemo(() => {
    const base = paramScope === 'key' ? (params.data?.key_params || []) : (params.data?.all_params || []);
    const scoped = paramScope === 'modified' ? base.filter((p) => p.ismodified && p.ismodified !== 'FALSE') : base;
    const term = paramSearch.trim().toLowerCase();
    return term ? scoped.filter((p) => `${p.name} ${p.value}`.toLowerCase().includes(term)) : scoped;
  }, [params.data, paramScope, paramSearch]);

  // Per-step live progress for one monitored execution — only fetched once a
  // row is actually opened, not for the whole list every tick.
  const monitorDetail = useQuery({
    queryKey: ['oracleSqlMonitorDetail', id, openMonitor?.sql_id, openMonitor?.sql_exec_id],
    queryFn: () => client
      .get(`/connections/oracle/${id}/oracle-sql-monitor-detail`, {
        params: { sql_id: openMonitor.sql_id, sql_exec_id: openMonitor.sql_exec_id },
      })
      .then((r) => r.data),
    enabled: on('sqlmonitor') && !!openMonitor,
    refetchInterval: 3000,
    retry: false,
  });

  // Topology detection (§1) — always enabled (not tab-gated): the tab list
  // itself depends on this, and it's a single cheap query (GV$INSTANCE count +
  // a couple of V$ lookups), not a heavy collection.
  const topologyQ = useQuery({
    queryKey: ['oracleTopology', id],
    queryFn: () => get(id, 'oracle-topology'),
    retry: false,
    staleTime: 60000,
  });
  const topology = topologyQ.data || {};

  const racNodes = q('oracleRacNodes', 'oracle-rac-nodes', { refetchInterval: 15000, enabled: on('rac') });
  const racEvents = q('oracleRacEvents', 'oracle-rac-eviction-events', { refetchInterval: 30000, enabled: on('rac') });
  const services = q('oracleServices', 'oracle-services', { refetchInterval: 30000, enabled: on('services') });
  const asm = q('oracleAsm', 'oracle-asm', { refetchInterval: 60000, enabled: on('asm') });
  const cdbPdb = q('oracleCdbPdb', 'oracle-cdb-pdb', { refetchInterval: 60000, enabled: on('multitenant') });

  const schema = useQuery({
    queryKey: ['oracleSchemaTables', id, schemaOwner],
    queryFn: () => get(id, 'oracle-schema-tables', schemaOwner ? { owner: schemaOwner } : undefined),
    retry: false,
    staleTime: 60000,
    enabled: on('tables'),
  });

  // Table details — the shared ActMon Table Details UI.
  const {
    data: tableDetailData, isLoading: tableDetailLoading,
    isError: tableDetailError, refetch: refetchTableDetail,
  } = useQuery({
    queryKey: ['oracleTableDetail', id, selectedTable?.owner, selectedTable?.name],
    queryFn: () => get(id, 'oracle-table-detail', { owner: selectedTable.owner, table: selectedTable.name }),
    enabled: !!selectedTable,
    retry: false,
  });

  useEffect(() => {
    setCountdown(REFRESH_INTERVAL);
    clearInterval(countRef.current);
    countRef.current = setInterval(
      () => setCountdown((c) => (c <= 1 ? REFRESH_INTERVAL : c - 1)),
      1000,
    );
    return () => clearInterval(countRef.current);
  }, [dataUpdatedAt]);

  useEffect(() => {
    if (!data) return;
    const hs = data.health_summary || {};
    const t = new Date().toLocaleTimeString();
    setTrend((prev) => ({
      sessions: [...prev.sessions.slice(-19), { t, v: num(hs.active_sessions) }],
      bufHit: [...prev.bufHit.slice(-19), { t, v: num(hs.buffer_cache_hit_pct) }],
      pga: [...prev.pga.slice(-19), { t, v: num(hs.pga_used_pct) }],
    }));
  }, [data]);

  /* Derived once, above the early returns — hooks may not follow a conditional
     return, and this also gives the memo something stable to key on. */
  const d = useMemo(() => {
    const p = data || {};
    const hs = p.health_summary || {};
    const tsList = Array.isArray(p.tablespaces) ? p.tablespaces : [];
    const waitList = Array.isArray(p.wait_events) ? p.wait_events : [];
    const maxTsPct = tsList.reduce((m, t) => Math.max(m, num(t.used_pct)), 0);
    const sessionPct = num(hs.session_pct);
    const bufHitPct = num(hs.buffer_cache_hit_pct);
    const hostCpuPct = num(hs.host_cpu_pct);

    return {
      connection: p.connection || {},
      hs,
      tsList,
      waitList,
      redoList: Array.isArray(p.redo_logs) ? p.redo_logs : [],
      collectorErrors: Array.isArray(p.errors) ? p.errors.filter(Boolean) : [],
      sessionPct,
      bufHitPct,
      libHitPct: num(hs.library_cache_hit_pct),
      hostCpuPct,
      dbCpuPct: num(hs.db_cpu_pct),
      sgaUsedPct: num(hs.sga_used_pct),
      pgaUsedPct: num(hs.pga_used_pct),
      maxTsPct,
      fullestTs: tsList.find((t) => num(t.used_pct) === maxTsPct) || null,
      criticalTs: tsList.filter((t) => num(t.used_pct) > 85),
      healthScore: computeInstanceHealthScore({
        sessionPct, bufHitPct, maxTsPct, waitCount: waitList.length, hostCpuPct,
      }),
    };
  }, [data]);

  if (isLoading) return <PageLoading title="Connecting to Oracle…" />;

  if (error || data?.status === 'error') {
    return (
      <div className="max-w-2xl">
        <Notice tone="danger" title="Connection failed.">
          {data?.error || error?.message || 'Oracle did not respond.'}
        </Notice>
        <Button variant="primary" icon="refresh" onClick={() => refetch()}>Retry</Button>
      </div>
    );
  }

  const {
    connection, hs, tsList, waitList, collectorErrors, sessionPct, bufHitPct,
    libHitPct, hostCpuPct, dbCpuPct, sgaUsedPct, pgaUsedPct, maxTsPct, fullestTs,
    criticalTs, healthScore,
  } = d;

  /* Live wait events are richer than the overview payload's copy — prefer them
     when the Performance tab has fetched them. */
  const waitRows = waits.data?.events || waitList;
  const busyWaits = waitRows.filter((w) => !isIdleWait(w.event, w.wait_class));

  const tsRows = tablespaces.data?.tablespaces || tsList;
  const alerts = {
    tablespaces: criticalTs.length,
    locks: num(locks.data?.total_waits),
    sessions: (sessions.data?.summary?.blocking) || 0,
  };

  return (
    <DashboardScopeProvider tech="oracle">
      <div className="flex min-h-full flex-col">
        <EngineDashboardHeader
          tech="oracle"
          connectionId={id}
          connection={connection}
          tabs={tabsForTopology(topology)}
          activeTab={activeTab}
          onTabChange={setActiveTab}
          alerts={alerts}
          health={<HealthBadge score={healthScore} />}
          onRefresh={() => refetch()}
          isFetching={isFetching}
          countdown={countdown}
        />

        {collectorErrors.length > 0 && (
          <Notice tone="warning" title="Some metrics could not be collected.">
            {collectorErrors.join(' · ')}
          </Notice>
        )}

        {/* ══ OVERVIEW ══════════════════════════════════════════════════════ */}
        {on('overview') && (
          <div className="space-y-gutter">
            {/* Deployment-type control belongs on Overview only — it used to
                render above every tab, so switching to Sessions/Locks/etc.
                repeated the same "Detected: Standalone" banner for no reason. */}
            <OracleDeploymentBanner id={id} connection={connection} topology={topology} onSaved={() => { refetch(); topologyQ.refetch(); }} />

            <div className="grid grid-cols-2 gap-gutter-sm sm:grid-cols-4 xl:grid-cols-8">
              <MetricTile label="Instance" icon="server" value={hs.instance_name || '—'}
                sub={hs.host_name || undefined} />
              <MetricTile label="Database" icon="database" value={hs.db_name || '—'}
                sub={hs.db_unique_name && hs.db_unique_name !== hs.db_name ? hs.db_unique_name : undefined} />
              <MetricTile label="Status" icon="activity" value={hs.status || '—'}
                tone={hs.status === 'OPEN' ? 'good' : hs.status ? 'warn' : 'neutral'}
                sub={hs.log_mode || undefined} />
              <MetricTile label="Sessions" icon="users"
                value={`${num(hs.total_sessions)}/${num(hs.max_sessions)}`}
                tone={sessionPct > 90 ? 'bad' : sessionPct > 75 ? 'warn' : 'good'}
                sub={`${sessionPct}% of the limit`}
                onClick={() => setActiveTab('sessions')} />
              <MetricTile label="Host CPU" icon="cpu" value={`${hostCpuPct}%`}
                tone={hostCpuPct > 85 ? 'bad' : hostCpuPct > 65 ? 'warn' : 'good'}
                sub={hs.cpu_count ? `${hs.cpu_count} CPUs` : undefined}
                onClick={() => setActiveTab('performance')} />
              <MetricTile label="SGA" icon="memory" value={`${fmtNumber(hs.sga_mb)} MB`}
                sub={hs.sga_target_mb ? `target ${fmtNumber(hs.sga_target_mb)} MB` : undefined}
                onClick={() => setActiveTab('performance')} />
              <MetricTile label="PGA" icon="memory" value={`${fmtNumber(hs.pga_mb)} MB`}
                sub={hs.pga_target_mb ? `target ${fmtNumber(hs.pga_target_mb)} MB` : undefined}
                onClick={() => setActiveTab('performance')} />
              <MetricTile label="Database size" icon="desktop"
                value={hs.db_size_gb ? `${hs.db_size_gb} GB` : '—'}
                sub={tsRows.length ? `${tsRows.length} tablespaces` : undefined}
                onClick={() => setActiveTab('tablespaces')} />
            </div>

            <HostResources connId={id} tech="oracle" />

            <div className="flex flex-wrap gap-2">
              <StatusPill ok={hs.status === 'OPEN'} label={`Instance ${hs.status || 'unknown'}`} />
              <StatusPill ok={sessionPct < 80} label={`Sessions ${sessionPct}%`}
                onClick={() => setActiveTab('sessions')} />
              <StatusPill ok={bufHitPct >= 90} label={`Buffer cache ${bufHitPct}%`}
                hint="Below 90% means logical reads are going to disk more often than they should."
                onClick={() => setActiveTab('performance')} />
              <StatusPill ok={libHitPct >= 95} label={`Library cache ${libHitPct}%`}
                hint="A low library-cache hit rate usually means SQL is not using bind variables."
                onClick={() => setActiveTab('performance')} />
              <StatusPill ok={hostCpuPct < 85} label={`Host CPU ${hostCpuPct}%`} />
              <StatusPill ok={maxTsPct <= 85}
                label={fullestTs ? `Fullest tablespace: ${fullestTs.tablespace_name} ${maxTsPct}%` : 'No tablespace data'}
                onClick={() => setActiveTab('tablespaces')} />
              <StatusPill ok={hs.log_mode === 'ARCHIVELOG'}
                label={`Log mode: ${hs.log_mode || 'unknown'}`}
                hint="NOARCHIVELOG means no point-in-time recovery and no Data Guard." />
            </div>

            {criticalTs.length > 0 && (
              <Notice tone={maxTsPct > 95 ? 'danger' : 'warning'}
                title={`${criticalTs.length} tablespace${criticalTs.length === 1 ? '' : 's'} over 85% full.`}>
                {criticalTs.map((t) => `${t.tablespace_name} ${t.used_pct}%`).join(' · ')}. A
                tablespace that reaches 100% stops accepting writes.{' '}
                <button type="button" onClick={() => setActiveTab('tablespaces')}
                  className="font-semibold underline">Open Tablespaces</button>
              </Notice>
            )}

            <div className="grid gap-gutter xl:grid-cols-2">
              <ChartCard
                cardId="oracle-utilisation"
                family="ratio"
                items={[
                  { key: 'sessions', label: 'Sessions', value: sessionPct, icon: 'users',
                    hint: `${num(hs.total_sessions)} of ${num(hs.max_sessions)} allowed` },
                  { key: 'cpu', label: 'Host CPU', value: hostCpuPct, icon: 'cpu',
                    hint: `Database's share of it: ${dbCpuPct}%` },
                  { key: 'sga', label: 'SGA', value: sgaUsedPct, icon: 'memory',
                    hint: `${fmtNumber(hs.sga_mb)} MB against a ${fmtNumber(hs.sga_target_mb)} MB target` },
                  { key: 'pga', label: 'PGA', value: pgaUsedPct, icon: 'memory',
                    hint: `${fmtNumber(hs.pga_mb)} MB against a ${fmtNumber(hs.pga_target_mb)} MB target` },
                  { key: 'ts', label: 'Fullest tablespace', value: maxTsPct, icon: 'desktop',
                    hint: fullestTs ? fullestTs.tablespace_name : 'No tablespace data' },
                ]}
                title="Utilisation"
                icon="gauge"
                subtitle="Each against its own ceiling"
                loading={isFetching}
                tableColumns={[
                  { key: 'resource', label: 'Resource' },
                  { key: 'used', label: 'Used', align: 'right' },
                  { key: 'band', label: 'Band', align: 'right' },
                ]}
                tableRows={[
                  ['Sessions', sessionPct], ['Host CPU', hostCpuPct], ['SGA', sgaUsedPct],
                  ['PGA', pgaUsedPct], ['Fullest tablespace', maxTsPct],
                ].map(([label, v]) => ({
                  key: label,
                  cells: { resource: label, used: `${v}%`, band: bandFor(v).label },
                }))}
              />

              <ChartCard
                cardId="oracle-waits"
                family="flat"
                items={busyWaits.slice(0, 8).map((w) => ({
                  key: w.event,
                  label: w.event,
                  value: num(w.time_waited_seconds),
                }))}
                chartProps={{
                  unit: 's', format: (v) => fmtNumber(Math.round(v)), labelWidth: 165,
                  emptyLabel: 'No non-idle wait events recorded',
                }}
                title="Where time is spent waiting"
                icon="clock"
                subtitle="Cumulative since startup, idle waits excluded"
                loading={waits.isFetching || isFetching}
                tableColumns={[
                  { key: 'event', label: 'Event' },
                  { key: 'class', label: 'Class' },
                  { key: 'waits', label: 'Waits', align: 'right' },
                  { key: 'sec', label: 'Seconds', align: 'right' },
                  { key: 'avg', label: 'Avg (ms)', align: 'right' },
                ]}
                tableRows={busyWaits.map((w) => ({
                  key: w.event,
                  cells: {
                    event: w.event,
                    class: w.wait_class,
                    waits: fmtNumber(w.total_waits),
                    sec: fmtNumber(Math.round(num(w.time_waited_seconds))),
                    avg: w.avg_wait_ms,
                  },
                }))}
              />
            </div>

            {trend.sessions.length > 2 ? (
              <div className="grid gap-gutter md:grid-cols-3">
                <Panel title="Active sessions" icon="users">
                  <TrendChart data={trend.sessions} series={[{ key: 'v', label: 'sessions' }]}
                    height={150} yDomain={['auto', 'auto']} />
                </Panel>
                <Panel title="Buffer cache hit" icon="memory">
                  <TrendChart data={trend.bufHit} series={[{ key: 'v', label: '%' }]} height={150} />
                </Panel>
                <Panel title="PGA used" icon="memory">
                  <TrendChart data={trend.pga} series={[{ key: 'v', label: '%' }]} height={150} />
                </Panel>
              </div>
            ) : (
              <Panel>
                <p className="text-center text-[12px] text-subtle">
                  Live trends build up from this page — the first points appear after the next
                  {' '}{REFRESH_INTERVAL}-second refresh.
                </p>
              </Panel>
            )}

            <div className="grid gap-gutter xl:grid-cols-3">
              <Panel title="Instance" icon="server">
                <DefRow label="Instance" value={hs.instance_name} mono />
                <DefRow label="Host" value={hs.host_name} mono />
                <DefRow label="Version" value={hs.version} mono />
                <DefRow label="Status" value={hs.status} />
                <DefRow label="Started" value={hs.startup_time} mono />
                <DefRow label="CPUs" value={hs.cpu_count ? `${hs.cpu_count} (${hs.cpu_cores || '?'} cores)` : null}
                  hint="cpu_count is what Oracle uses for its own parallelism decisions." />
                <DefRow label="Physical memory" value={hs.physical_mem_mb ? fmtBytes(mb(hs.physical_mem_mb)) : null} />
              </Panel>

              <Panel title="Database" icon="database">
                <DefRow label="Name" value={hs.db_name} mono />
                <DefRow label="Unique name" value={hs.db_unique_name} mono />
                <DefRow label="Log mode" value={hs.log_mode}
                  tone={hs.log_mode === 'ARCHIVELOG' ? 'good' : 'warn'}
                  hint="ARCHIVELOG is required for point-in-time recovery and for Data Guard." />
                <DefRow label="Size" value={hs.db_size_gb ? `${hs.db_size_gb} GB` : null} />
                <DefRow label="Tablespaces" value={tsRows.length || null} />
                <DefRow label="Buffer cache hit" value={bufHitPct ? `${bufHitPct}%` : null}
                  tone={bufHitPct > 0 && bufHitPct < 90 ? 'warn' : undefined} />
                <DefRow label="Library cache hit" value={libHitPct ? `${libHitPct}%` : null}
                  tone={libHitPct > 0 && libHitPct < 95 ? 'warn' : undefined} />
              </Panel>

              <Panel title="Memory" icon="memory">
                <UsageBar label="SGA against target" pct={sgaUsedPct}
                  sub={`${fmtNumber(hs.sga_mb)} MB of ${fmtNumber(hs.sga_target_mb)} MB`} className="mb-3" />
                <UsageBar label="PGA against target" pct={pgaUsedPct}
                  sub={`${fmtNumber(hs.pga_mb)} MB of ${fmtNumber(hs.pga_target_mb)} MB`} className="mb-3" />
                <DefRow label="Sessions (active)" value={num(hs.active_sessions)} />
                <DefRow label="Sessions (total)" value={num(hs.total_sessions)} />
                <DefRow label="Session limit" value={num(hs.max_sessions)} />
                <DefRow label="Database CPU share" value={`${dbCpuPct}%`}
                  hint="Database CPU time as a proportion of total DB time — not host CPU." />
              </Panel>
            </div>
          </div>
        )}

        {/* ══ PERFORMANCE ═══════════════════════════════════════════════════ */}
        {on('performance') && (
          <div className="space-y-gutter">
            <div className="grid grid-cols-2 gap-gutter-sm md:grid-cols-4">
              <MetricTile label="Buffer cache hit" value={bufHitPct ? `${bufHitPct}%` : '—'} icon="memory"
                tone={bufHitPct === 0 ? 'neutral' : bufHitPct < 90 ? 'bad' : 'good'} />
              <MetricTile label="Library cache hit" value={libHitPct ? `${libHitPct}%` : '—'} icon="layers"
                tone={libHitPct === 0 ? 'neutral' : libHitPct < 95 ? 'warn' : 'good'} />
              <MetricTile label="SGA total" value={sga.data?.total_mb ? `${fmtNumber(sga.data.total_mb)} MB` : `${fmtNumber(hs.sga_mb)} MB`}
                icon="memory" />
              <MetricTile label="PGA allocated"
                value={pga.data?.summary?.total_allocated_mb != null
                  ? `${fmtNumber(pga.data.summary.total_allocated_mb)} MB`
                  : `${fmtNumber(hs.pga_mb)} MB`}
                icon="memory" />
            </div>

            <div className="grid gap-gutter xl:grid-cols-2">
              <ChartCard
                cardId="oracle-sga-pools"
                family="flat"
                items={(sga.data?.pools || []).slice(0, 8).map((p) => ({
                  key: p.pool, label: p.pool, value: num(p.mb),
                }))}
                chartProps={{ unit: ' MB', format: (v) => fmtNumber(Math.round(v)), labelWidth: 140,
                  emptyLabel: 'v$sgastat could not be read' }}
                title="SGA by pool"
                icon="memory"
                subtitle="Where the SGA is actually allocated"
                loading={sga.isFetching}
                tableColumns={[
                  { key: 'pool', label: 'Pool' },
                  { key: 'mb', label: 'MB', align: 'right' },
                ]}
                tableRows={(sga.data?.pools || []).map((p) => ({
                  key: p.pool, cells: { pool: p.pool, mb: fmtNumber(p.mb) },
                }))}
              />

              <Panel title="PGA" icon="memory" subtitle="v$pgastat — work areas and the aggregate target">
                {pga.isLoading ? <InlineLoading label="Reading v$pgastat…" /> : (
                  <div className="grid gap-gutter-sm sm:grid-cols-2">
                    <StatCell label="Allocated"
                      value={pga.data?.summary?.total_allocated_mb != null ? `${fmtNumber(pga.data.summary.total_allocated_mb)} MB` : '—'} />
                    <StatCell label="Aggregate target"
                      value={pga.data?.summary?.aggregate_target_mb != null ? `${fmtNumber(pga.data.summary.aggregate_target_mb)} MB` : '—'} />
                    <StatCell label="Cache hit"
                      value={pga.data?.summary?.cache_hit_pct != null ? `${pga.data.summary.cache_hit_pct}%` : '—'}
                      tone={num(pga.data?.summary?.cache_hit_pct) > 0 && num(pga.data.summary.cache_hit_pct) < 90 ? 'warn' : 'neutral'}
                      hint="Sorts and hashes completed in memory" />
                    <StatCell label="Work areas active"
                      value={pga.data?.summary?.work_areas_active ?? '—'} />
                    <StatCell label="Used for manual areas"
                      value={pga.data?.summary?.total_used_mb != null ? `${fmtNumber(pga.data.summary.total_used_mb)} MB` : '—'} />
                  </div>
                )}
              </Panel>
            </div>

            {(sga.data?.sga_info || []).length > 0 && (
              <TablePanel title="SGA components" icon="memory"
                subtitle="v$sgainfo — resizeable components can be moved by automatic memory management">
                <Paged rows={sga.data.sga_info} unit="components">
                  {(page, pager) => (
                    <>
                      <Table2
                        columns={[
                          { key: 'name', label: 'Component' },
                          { key: 'mb', label: 'Size', align: 'right' },
                          { key: 'resizeable', label: 'Resizeable' },
                        ]}
                        rows={page.map((s, i) => ({
                          key: `${s.name}-${i}`,
                          cells: {
                            name: <span className="text-[12px] text-fg">{s.name}</span>,
                            mb: <span className="font-mono text-[12px]">{fmtBytes(mb(s.mb))}</span>,
                            resizeable: s.resizeable
                              ? <Badge tone={s.resizeable === 'Yes' ? 'success' : 'neutral'} size="xs">{s.resizeable}</Badge>
                              : null,
                          },
                        }))}
                        empty={<EmptyState icon="memory" title="No SGA components" />}
                      />
                      {pager}
                    </>
                  )}
                </Paged>
              </TablePanel>
            )}

            <TablePanel title="Wait events" icon="clock"
              subtitle="v$system_event since startup, idle waits excluded — each with what it means">
              {waits.isLoading ? <InlineLoading label="Reading wait events…" /> : (
                <Paged rows={busyWaits} unit="events">
                  {(page, pager) => (
                    <>
                      <Table2
                        columns={[
                          { key: 'event', label: 'Event and what it means' },
                          { key: 'waits', label: 'Waits', align: 'right' },
                          { key: 'timeouts', label: 'Timeouts', align: 'right' },
                          { key: 'sec', label: 'Total wait', align: 'right' },
                          { key: 'avg', label: 'Avg', align: 'right' },
                          { key: 'action', label: 'What to do' },
                        ]}
                        rows={page.map((w, i) => {
                          const k = explainWait(w.event, w.wait_class);
                          return {
                            key: `${w.event}-${i}`,
                            cells: {
                              event: <WaitEventCell event={w.event} waitClass={w.wait_class} />,
                              waits: <span className="font-mono">{fmtNumber(w.total_waits)}</span>,
                              timeouts: <span className="font-mono">{fmtNumber(w.total_timeouts)}</span>,
                              sec: <span className="font-mono font-semibold">{fmtNumber(Math.round(num(w.time_waited_seconds)))}s</span>,
                              avg: <span className="font-mono">{w.avg_wait_ms} ms</span>,
                              action: <span className="block max-w-[280px] text-[11px] leading-snug text-muted">{k.action}</span>,
                            },
                          };
                        })}
                        empty={<EmptyState icon="clock" title="No non-idle waits"
                          body="Nothing has waited on a non-idle event since startup — unusual on a busy instance, so check the login can read v$system_event." />}
                      />
                      {pager}
                    </>
                  )}
                </Paged>
              )}
            </TablePanel>

            {(waits.data?.class_breakdown || []).length > 0 && (
              <ChartCard
                cardId="oracle-wait-classes"
                family="flat"
                items={waits.data.class_breakdown.map((c) => ({
                  key: c.wait_class, label: c.wait_class, value: num(c.time_seconds),
                }))}
                chartProps={{ unit: 's', format: (v) => fmtNumber(Math.round(v)), labelWidth: 130 }}
                title="Wait time by class"
                icon="chart-pie"
                subtitle="Which kind of waiting dominates"
                tableColumns={[
                  { key: 'class', label: 'Wait class' },
                  { key: 'sec', label: 'Seconds', align: 'right' },
                ]}
                tableRows={waits.data.class_breakdown.map((c) => ({
                  key: c.wait_class,
                  cells: { class: c.wait_class, sec: fmtNumber(Math.round(num(c.time_seconds))) },
                }))}
              />
            )}
          </div>
        )}

        {/* ══ SESSIONS ══════════════════════════════════════════════════════ */}
        {on('sessions') && (
          <div className="space-y-gutter">
            <div className="grid grid-cols-2 gap-gutter-sm md:grid-cols-3 xl:grid-cols-6">
              <MetricTile label="Total" value={sessions.data?.summary?.total ?? '—'} icon="users" />
              <MetricTile label="Active" value={sessions.data?.summary?.active ?? '—'} icon="activity" tone="good" />
              <MetricTile label="Inactive" value={sessions.data?.summary?.inactive ?? '—'} icon="clock" />
              <MetricTile label="Blocked" value={sessions.data?.summary?.blocking ?? '—'} icon="lock"
                tone={num(sessions.data?.summary?.blocking) ? 'bad' : 'good'}
                hint="Sessions waiting on a lock another session holds" />
              <MetricTile label="User" value={sessions.data?.summary?.user ?? '—'} icon="user" />
              <MetricTile label="Background" value={sessions.data?.summary?.background ?? '—'} icon="cpu" />
            </div>

            {sessions.data?.status === 'error' && (
              <Notice tone="danger" title="Could not read sessions.">{sessions.data.error}</Notice>
            )}

            <SessionsPanel rows={sessions.data?.sessions || []} loading={sessions.isLoading} />
          </div>
        )}

        {/* ══ TOP SQL ═══════════════════════════════════════════════════════ */}
        {on('sql') && (
          <div className="space-y-gutter">
            {topSql.isLoading ? <PageLoading title="Reading v$sql…" illustration /> : (
              <>
                {topSql.data?.status === 'error' && (
                  <Notice tone="danger" title="Could not read v$sql.">{topSql.data.error}</Notice>
                )}
                <TopSqlPanel rows={topSql.data?.sql || []} full
                  title={`Top SQL by elapsed time (${topSql.data?.total ?? 0})`} />

                {(planInstability.data?.unstable || []).length > 0 && (
                  <TablePanel
                    title="Plan instability"
                    icon="alert"
                    subtitle="Statements currently holding more than one distinct execution plan in the shared pool — Oracle is flip-flopping plans for the same SQL right now"
                  >
                    <Table2
                      columns={[
                        { key: 'sql', label: 'SQL' },
                        { key: 'plans', label: 'Distinct plans', align: 'right' },
                        { key: 'cursors', label: 'Child cursors', align: 'right' },
                        { key: 'exec', label: 'Total executions', align: 'right' },
                      ]}
                      rows={(planInstability.data?.unstable || []).map((u, i) => ({
                        key: `${u.sql_id}-${i}`,
                        cells: {
                          sql: <SqlCell sql={u.sql_text} max={90} />,
                          plans: <span className="font-mono font-bold text-warning-fg">{u.plan_count}</span>,
                          cursors: <span className="font-mono">{fmtNumber(u.child_cursors)}</span>,
                          exec: <span className="font-mono text-muted">{fmtNumber(u.total_executions)}</span>,
                        },
                      }))}
                      empty={<EmptyState icon="check" title="No plan instability" />}
                    />
                  </TablePanel>
                )}
              </>
            )}
          </div>
        )}

        {/* ══ TABLESPACES ═══════════════════════════════════════════════════ */}
        {on('tablespaces') && (
          <div className="space-y-gutter">
            <div className="grid grid-cols-2 gap-gutter-sm md:grid-cols-4">
              <MetricTile label="Tablespaces" value={tsRows.length} icon="desktop" />
              <MetricTile label="Over 85%" value={(tablespaces.data?.critical || criticalTs).length} icon="alert"
                tone={(tablespaces.data?.critical || criticalTs).length ? 'bad' : 'good'} />
              <MetricTile label="70–85%" value={(tablespaces.data?.warning || []).length} icon="alert"
                tone={(tablespaces.data?.warning || []).length ? 'warn' : 'good'} />
              <MetricTile label="Allocated" icon="database"
                value={fmtBytes(tsRows.reduce((a, t) => a + mb(t.total_mb), 0))}
                sub={`${fmtBytes(tsRows.reduce((a, t) => a + mb(t.used_mb), 0))} used`} />
            </div>

            {tablespaces.data?.status === 'error' && (
              <Notice tone="danger" title="Could not read tablespace usage.">
                {tablespaces.data.error}
              </Notice>
            )}

            <ObjectTable
              title="Tablespaces"
              icon="desktop"
              columns={TABLESPACE_COLUMNS}
              items={tsRows}
              loading={tablespaces.isFetching}
              searchOn={['tablespace_name', 'contents', 'status']}
              searchPlaceholder="Search tablespaces…"
              defaultSort={{ key: 'used', dir: 'desc' }}
              sizeOf={(t) => mb(t.total_mb)}
              keyOf={(t) => t.tablespace_name}
              unit="tablespaces"
              views={['table']}
              note="Usage is against the maximum size, so autoextensible files count their headroom"
              emptyTitle="No tablespace data"
              emptyBody="dba_tablespace_usage_metrics returned nothing — the login may lack SELECT on the DBA views."
            />
          </div>
        )}

        {/* ══ OBJECTS ═══════════════════════════════════════════════════════ */}
        {on('objects') && (
          <div className="space-y-gutter">
            {objects.isLoading ? <PageLoading title="Counting objects…" illustration /> : (
              <>
                <div className="grid grid-cols-2 gap-gutter-sm md:grid-cols-4 xl:grid-cols-5">
                  <MetricTile label="Objects" value={fmtNumber(objects.data?.summary?.total_objects)} icon="boxes" />
                  <MetricTile label="Tables" value={fmtNumber(objects.data?.summary?.tables)} icon="table" />
                  <MetricTile label="Indexes" value={fmtNumber(objects.data?.summary?.indexes)} icon="layers" />
                  <MetricTile label="Packages" value={fmtNumber(objects.data?.summary?.packages)} icon="boxes" />
                  <MetricTile label="Invalid" value={objects.data?.summary?.invalid_objects ?? '—'} icon="alert"
                    tone={num(objects.data?.summary?.invalid_objects) ? 'bad' : 'good'}
                    hint="Objects that need recompiling before they can be used" />
                </div>

                {num(objects.data?.summary?.invalid_objects) > 0 && (
                  <Notice tone="warning" title={`${objects.data.summary.invalid_objects} invalid object${objects.data.summary.invalid_objects === 1 ? '' : 's'}.`}>
                    An INVALID package or view raises an error the first time something calls it.
                    Recompile with <span className="font-mono">UTL_RECOMP</span> or by recompiling
                    the individual objects.
                  </Notice>
                )}

                <div className="grid gap-gutter xl:grid-cols-2">
                  <ChartCard
                    cardId="oracle-objects-by-type"
                    family="flat"
                    items={(objects.data?.by_type || []).slice(0, 10).map((b) => ({
                      key: b.object_type, label: b.object_type, value: num(b.count),
                    }))}
                    chartProps={{ format: fmtNumber, labelWidth: 130, emptyLabel: 'No objects found' }}
                    title="Objects by type"
                    icon="boxes"
                    subtitle="User schemas only — Oracle's own are excluded"
                    tableColumns={[
                      { key: 'type', label: 'Type' },
                      { key: 'count', label: 'Count', align: 'right' },
                    ]}
                    tableRows={(objects.data?.by_type || []).map((b) => ({
                      key: b.object_type, cells: { type: b.object_type, count: fmtNumber(b.count) },
                    }))}
                  />

                  <ChartCard
                    cardId="oracle-largest-tables"
                    family="flat"
                    items={(objects.data?.top_tables || []).slice(0, 10).map((t) => ({
                      key: `${t.owner}.${t.table_name}`,
                      label: `${t.owner}.${t.table_name}`,
                      value: mb(t.size_mb),
                    }))}
                    chartProps={{ format: (v) => fmtBytes(v), labelWidth: 190,
                      emptyLabel: 'No segment sizes available' }}
                    title="Largest tables"
                    icon="table"
                    subtitle="By segment size across all user schemas"
                    tableColumns={[
                      { key: 'owner', label: 'Owner' },
                      { key: 'table', label: 'Table' },
                      { key: 'size', label: 'Size', align: 'right' },
                    ]}
                    tableRows={(objects.data?.top_tables || []).map((t) => ({
                      key: `${t.owner}.${t.table_name}`,
                      cells: { owner: t.owner, table: t.table_name, size: fmtBytes(mb(t.size_mb)) },
                    }))}
                  />
                </div>
              </>
            )}
          </div>
        )}

        {/* ══ TABLES ════════════════════════════════════════════════════════ */}
        {on('tables') && (
          <div className="space-y-gutter">
            {schema.isLoading ? <PageLoading title="Reading the schema…" illustration /> : (
              <ObjectTable
                title={`Tables in ${schema.data?.owner || 'schema'}`}
                icon="table"
                columns={ORACLE_TABLE_COLUMNS}
                items={(schema.data?.tables || []).map((t) => oracleTableRow(t, schema.data?.owner))}
                loading={schema.isFetching}
                searchOn={['name']}
                searchPlaceholder="Search tables…"
                filter={{
                  value: schemaOwner || schema.data?.owner || '',
                  onChange: setSchemaOwner,
                  options: (schema.data?.schemas || []).map((s) => ({ id: s, label: s })),
                }}
                defaultSort={{ key: 'total', dir: 'desc' }}
                sizeOf={(t) => num(t.total_bytes)}
                keyOf={(t) => t.name}
                unit="tables"
                note="Row counts and sizes come from optimiser statistics, not a live count"
                emptyTitle="No tables"
                emptyBody="This schema has no tables, or the login cannot see them."
                onOpen={(t) => setSelectedTable({ owner: t.database, name: t.name })}
                onRowClick={(t) => setSelectedTable({ owner: t.database, name: t.name })}
              />
            )}

            {/* Table details — the shared ActMon Table Details UI */}
            <TableDetailsDialog
              open={!!selectedTable}
              onClose={() => setSelectedTable(null)}
              breadcrumb={selectedTable ? { database: selectedTable.owner, schema: null, table: selectedTable.name } : null}
              isLoading={tableDetailLoading}
              isError={tableDetailError}
              onRetry={refetchTableDetail}
              data={adaptOracleTableDetails(tableDetailData)}
            />
          </div>
        )}

        {/* ══ DATA GUARD ════════════════════════════════════════════════════ */}
        {on('dataguard') && (
          <div className="space-y-gutter">
            {dataGuard.isLoading ? <PageLoading title="Reading Data Guard status…" illustration /> : (
              <>
                <Panel title="Data Guard" icon="shield"
                  subtitle={dataGuard.data?.configured
                    ? 'Standby destinations and their synchronisation state'
                    : 'No standby destination or standby redo log was found'}
                  actions={(
                    <Badge tone={dataGuard.data?.configured ? 'accent' : 'neutral'} size="xs">
                      {dataGuard.data?.configured ? 'Configured' : 'Not configured'}
                    </Badge>
                  )}
                >
                  {dataGuard.data?.configured ? (
                    <div className="grid gap-gutter-sm sm:grid-cols-2 xl:grid-cols-4">
                      <StatCell label="Destinations" value={(dataGuard.data.archive_dests || []).length} />
                      <StatCell label="Standby redo logs" value={(dataGuard.data.standby_logs || []).length} />
                      <StatCell label="Status messages" value={(dataGuard.data.dg_status || []).length} />
                      <StatCell label="Errors reported"
                        value={(dataGuard.data.dg_status || []).filter((s) => /error|fatal/i.test(s.severity || '')).length}
                        tone={(dataGuard.data.dg_status || []).some((s) => /error|fatal/i.test(s.severity || '')) ? 'bad' : 'good'} />
                    </div>
                  ) : (
                    <EmptyState icon="shield" title="No Data Guard configuration"
                      body="This instance has no standby destination beyond the local archive, and no standby redo logs. Without Data Guard there is no automatic failover target." />
                  )}
                </Panel>

                {dataGuard.data?.role && (
                  <Panel title="Role / Protection / Lag" icon="activity"
                    subtitle="Real role, protection mode and transport/apply lag — not just a configured flag"
                    actions={(
                      <Badge tone={healthBand(dataGuard.data.health?.status).tone} size="xs">
                        {healthBand(dataGuard.data.health?.status).label}
                      </Badge>
                    )}
                  >
                    <div className="grid gap-gutter-sm sm:grid-cols-2 xl:grid-cols-4">
                      <StatCell label="Role" value={dataGuard.data.role || 'N/A'} />
                      <StatCell label="Protection Mode" value={dataGuard.data.protection_mode || 'N/A'} />
                      <StatCell label="Transport" value={dataGuard.data.transport_status || 'Unknown'} />
                      <StatCell label="Apply" value={dataGuard.data.apply_status || 'Unknown'} />
                      <StatCell label="Transport Lag"
                        value={dataGuard.data.transport_lag_sec != null ? `${dataGuard.data.transport_lag_sec}s` : 'N/A'}
                        tone={dataGuard.data.transport_lag_sec > 60 ? 'bad' : 'good'} />
                      <StatCell label="Apply Lag"
                        value={dataGuard.data.apply_lag_sec != null ? `${dataGuard.data.apply_lag_sec}s` : 'N/A'}
                        tone={dataGuard.data.apply_lag_sec > 60 ? 'bad' : 'good'} />
                      <StatCell label="Archive Gap" value={dataGuard.data.archive_gap ?? 'N/A'}
                        tone={(dataGuard.data.archive_gap || 0) > 0 ? 'bad' : 'good'} />
                      <StatCell label="Switchover Status" value={dataGuard.data.switchover_status || 'N/A'} />
                    </div>
                    {dataGuard.data.health?.reason && (
                      <p className="mt-gutter-sm text-[12px] text-danger-fg">Reason: {dataGuard.data.health.reason}</p>
                    )}
                  </Panel>
                )}

                <OracleTopologyPeers id={id} />

                {(dataGuard.data?.archive_dests || []).length > 0 && (
                  <TablePanel title="Archive destinations" icon="branch"
                    subtitle="v$archive_dest_status — where redo is shipped">
                    <Table2
                      columns={[
                        { key: 'dest', label: 'Destination' },
                        { key: 'target', label: 'Target' },
                        { key: 'status', label: 'Status' },
                        { key: 'sync', label: 'Synchronisation' },
                        { key: 'archiver', label: 'Archiver' },
                        { key: 'scn', label: 'Applied SCN', align: 'right' },
                        { key: 'path', label: 'Path' },
                      ]}
                      rows={(dataGuard.data.archive_dests || []).map((a, i) => ({
                        key: `${a.dest_id}-${i}`,
                        cells: {
                          dest: (
                            <span className="flex flex-col">
                              <span className="font-mono text-[12px] font-semibold">{a.dest_name}</span>
                              {a.db_unique_name && <span className="text-[10px] text-subtle">{a.db_unique_name}</span>}
                            </span>
                          ),
                          target: <StateChip value={a.target} tones={{ STANDBY: 'accent', PRIMARY: 'info' }} />,
                          status: <StateChip value={a.status} tones={{ VALID: 'success', ERROR: 'danger', DEFERRED: 'warning' }} />,
                          sync: <StateChip value={a.synchronization_status}
                            tones={{ OK: 'success', 'CHECK CONFIGURATION': 'danger' }} />,
                          archiver: <span className="text-[11px] text-muted">{a.archiver}</span>,
                          scn: <span className="font-mono text-[11px]">{idNum(a.applied_scn)}</span>,
                          path: (
                            <span title={a.destination}
                              className="truncate-safe block max-w-[200px] font-mono text-[11px] text-subtle">
                              {a.destination}
                            </span>
                          ),
                        },
                      }))}
                      empty={<EmptyState icon="branch" title="No active destinations" />}
                    />
                  </TablePanel>
                )}

                {(dataGuard.data?.dg_status || []).length > 0 && (
                  <TablePanel title="Data Guard messages" icon="logs"
                    subtitle="v$dataguard_status — newest first">
                    <Paged rows={dataGuard.data.dg_status} unit="messages">
                      {(page, pager) => (
                        <>
                          <Table2
                            columns={[
                              { key: 'when', label: 'Time' },
                              { key: 'sev', label: 'Severity' },
                              { key: 'dest', label: 'Dest', align: 'right' },
                              { key: 'msg', label: 'Message' },
                            ]}
                            rows={page.map((s, i) => ({
                              key: `dg-${i}`,
                              cells: {
                                when: <span className="font-mono text-[11px] whitespace-nowrap text-muted">{s.timestamp}</span>,
                                sev: <StateChip value={s.severity}
                                  tones={{ Error: 'danger', Fatal: 'danger', Warning: 'warning', Informational: 'neutral' }} />,
                                dest: <span className="font-mono">{s.dest_id || null}</span>,
                                msg: <span className="text-[12px] break-words text-fg">{s.message}</span>,
                              },
                            }))}
                            empty={<EmptyState icon="logs" title="No messages" />}
                          />
                          {pager}
                        </>
                      )}
                    </Paged>
                  </TablePanel>
                )}
              </>
            )}
          </div>
        )}

        {/* ══ RAC ═══════════════════════════════════════════════════════════ */}
        {on('rac') && (
          <div className="space-y-gutter">
            {racNodes.isLoading ? <PageLoading title="Reading RAC instance status…" illustration /> : (
              <>
                <Panel title="RAC Cluster" icon="server"
                  subtitle={`${racNodes.data?.nodes_total ?? (racNodes.data?.nodes || []).length} instance(s) via GV$INSTANCE`}
                  actions={(
                    <Badge tone={healthBand(racNodes.data?.cluster_health).tone} size="xs">
                      {healthBand(racNodes.data?.cluster_health).label}
                    </Badge>
                  )}
                >
                  <div className="grid gap-gutter-sm sm:grid-cols-2 xl:grid-cols-4">
                    <StatCell label="Instances Open" value={`${racNodes.data?.nodes_open ?? 0} / ${racNodes.data?.nodes_total ?? 0}`} />
                    <StatCell label="Cluster Health" value={healthBand(racNodes.data?.cluster_health).label} />
                  </div>
                </Panel>
                <TablePanel title="Nodes / Instances" icon="server" subtitle="GV$INSTANCE — one row per RAC instance">
                  <Table2
                    columns={[
                      { key: 'inst', label: 'Instance #', align: 'right' },
                      { key: 'name', label: 'Instance Name' },
                      { key: 'host', label: 'Host' },
                      { key: 'status', label: 'Status' },
                      { key: 'dbstatus', label: 'DB Status' },
                      { key: 'sessions', label: 'Active Sessions', align: 'right' },
                      { key: 'blocking', label: 'Blocking Sessions', align: 'right' },
                    ]}
                    rows={(racNodes.data?.nodes || []).map((n) => ({
                      key: n.instance_number,
                      cells: {
                        inst: <span className="font-mono">{n.instance_number}</span>,
                        name: <span className="font-semibold">{n.instance_name}</span>,
                        host: n.host_name,
                        status: <StateChip value={n.instance_status} tones={{ OPEN: 'success', MOUNTED: 'warning' }} />,
                        dbstatus: <StateChip value={n.database_status} tones={{ ACTIVE: 'success' }} />,
                        sessions: n.active_sessions ?? 'N/A',
                        blocking: <span className={n.blocking_sessions > 0 ? 'text-danger-fg font-semibold' : ''}>{n.blocking_sessions ?? 'N/A'}</span>,
                      },
                    }))}
                    empty={<EmptyState icon="server" title="No RAC nodes found" />}
                  />
                </TablePanel>

                <TablePanel title="Recent cluster events" icon="alert"
                  subtitle="Real eviction/rejoin transitions only — not a re-alert on every cycle a node stays down">
                  <Table2
                    columns={[
                      { key: 'when', label: 'When' },
                      { key: 'inst', label: 'Instance', align: 'right' },
                      { key: 'host', label: 'Host' },
                      { key: 'event', label: 'Event' },
                      { key: 'change', label: 'Status change' },
                    ]}
                    rows={(racEvents.data?.events || []).map((e, i) => ({
                      key: `${e.ts}-${e.instance_number}-${i}`,
                      cells: {
                        when: <span className="font-mono text-[11px] text-muted">{e.ts}</span>,
                        inst: <span className="font-mono">{e.instance_number}</span>,
                        host: e.host_name,
                        event: (
                          <Badge tone={e.event_type === 'evicted' ? 'danger' : 'success'} size="xs">
                            {e.event_type}
                          </Badge>
                        ),
                        change: <span className="font-mono text-[11px]">{e.previous_status} → {e.new_status}</span>,
                      },
                    }))}
                    empty={<EmptyState icon="check" title="No eviction or rejoin events recorded"
                      body="A node has stayed in the same state for as long as history has been collected." />}
                  />
                </TablePanel>
              </>
            )}
          </div>
        )}

        {/* ══ SERVICES ══════════════════════════════════════════════════════ */}
        {on('services') && (
          <div className="space-y-gutter">
            {services.isLoading ? <PageLoading title="Reading Oracle Services…" illustration /> : (
              <TablePanel title="Oracle Services" icon="branch" subtitle="DBA_SERVICES / GV$ACTIVE_SERVICES — per-instance availability, independent of overall database health">
                <Table2
                  columns={[
                    { key: 'name', label: 'Service' },
                    { key: 'status', label: 'Overall Status' },
                    { key: 'instances', label: 'Per-Instance' },
                  ]}
                  rows={(services.data?.services || []).map((s) => ({
                    key: s.service_name,
                    cells: {
                      name: <span className="font-semibold">{s.service_name}</span>,
                      status: <StateChip value={s.status} tones={{ online: 'success', partial: 'warning', offline: 'danger' }} />,
                      instances: (
                        <span className="flex flex-wrap gap-1">
                          {(s.instances || []).map((i, idx) => (
                            <Badge key={idx} tone={i.status === 'online' ? 'success' : 'danger'} size="xs">
                              #{i.instance_number ?? '—'} {i.status}
                            </Badge>
                          ))}
                        </span>
                      ),
                    },
                  }))}
                  empty={<EmptyState icon="branch" title="No services found" />}
                />
              </TablePanel>
            )}
          </div>
        )}

        {/* ══ ASM ═══════════════════════════════════════════════════════════ */}
        {on('asm') && (
          <div className="space-y-gutter">
            {asm.isLoading ? <PageLoading title="Reading ASM disk groups…" illustration /> : (
              asm.data?.status !== 'success' ? (
                <EmptyState icon="disk" title="ASM Not Configured" body="This instance does not use Automatic Storage Management." />
              ) : (
                <TablePanel title="ASM Disk Groups" icon="disk" subtitle="V$ASM_DISKGROUP">
                  <Table2
                    columns={[
                      { key: 'name', label: 'Disk Group' },
                      { key: 'state', label: 'State' },
                      { key: 'total', label: 'Total (MB)', align: 'right' },
                      { key: 'used', label: 'Used %', align: 'right' },
                      { key: 'free', label: 'Free (MB)', align: 'right' },
                      { key: 'offline', label: 'Offline Disks', align: 'right' },
                      { key: 'sev', label: 'Severity' },
                    ]}
                    rows={(asm.data?.diskgroups || []).map((dg) => ({
                      key: dg.name,
                      cells: {
                        name: <span className="font-semibold">{dg.name}</span>,
                        state: <StateChip value={dg.state} tones={{ MOUNTED: 'success', CONNECTED: 'success' }} />,
                        total: fmtNumber(dg.total_mb),
                        used: dg.used_pct != null ? `${dg.used_pct}%` : 'N/A',
                        free: fmtNumber(dg.free_mb),
                        offline: <span className={dg.offline_disks > 0 ? 'text-danger-fg font-semibold' : ''}>{dg.offline_disks}</span>,
                        sev: <Badge tone={healthBand(dg.severity === 'healthy' ? 'healthy' : dg.severity).tone} size="xs">{dg.severity}</Badge>,
                      },
                    }))}
                    empty={<EmptyState icon="disk" title="No disk groups found" />}
                  />
                </TablePanel>
              )
            )}
          </div>
        )}

        {/* ══ MULTITENANT (CDB/PDB) ═════════════════════════════════════════ */}
        {on('multitenant') && (
          <div className="space-y-gutter">
            {cdbPdb.isLoading ? <PageLoading title="Reading CDB/PDB status…" illustration /> : (
              cdbPdb.data?.status !== 'success' ? (
                <EmptyState icon="boxes" title="Not a Multitenant (CDB) Database" body="This instance is not a Container Database." />
              ) : (
                <TablePanel title="Pluggable Databases" icon="boxes" subtitle={`V$PDBS — ${cdbPdb.data?.pdb_count ?? 0} PDB(s)`}>
                  <Table2
                    columns={[
                      { key: 'conid', label: 'CON_ID', align: 'right' },
                      { key: 'name', label: 'Name' },
                      { key: 'mode', label: 'Open Mode' },
                      { key: 'restricted', label: 'Restricted' },
                    ]}
                    rows={(cdbPdb.data?.pdbs || []).map((p) => ({
                      key: p.con_id,
                      cells: {
                        conid: <span className="font-mono">{p.con_id}</span>,
                        name: <span className="font-semibold">{p.name}</span>,
                        mode: <StateChip value={p.open_mode} tones={{ 'READ WRITE': 'success', 'READ ONLY': 'warning', MOUNTED: 'neutral' }} />,
                        restricted: <StateChip value={p.restricted} tones={{ NO: 'success', YES: 'warning' }} />,
                      },
                    }))}
                    empty={<EmptyState icon="boxes" title="No PDBs found" />}
                  />
                </TablePanel>
              )
            )}
          </div>
        )}

        {/* ══ TOPOLOGY ══════════════════════════════════════════════════════ */}
        {on('topology') && (
          <div className="space-y-gutter">
            <Panel title="Topology" icon="branch" subtitle="Auto-discovered from Oracle metadata — not the registration-time selection">
              <OracleTopologyDiagram topology={topology} racNodes={racNodes.data} dataGuard={dataGuard.data} />
            </Panel>
          </div>
        )}

        {/* ══ REDO LOGS ═════════════════════════════════════════════════════ */}
        {on('redologs') && (
          <div className="space-y-gutter">
            {redo.isLoading ? <PageLoading title="Reading redo log groups…" illustration /> : (
              <>
                <div className="grid grid-cols-2 gap-gutter-sm md:grid-cols-4">
                  <MetricTile label="Groups" value={(redo.data?.log_groups || []).length} icon="refresh" />
                  <MetricTile label="Members" value={(redo.data?.logfiles || []).length} icon="logs"
                    hint="More than one member per group is what protects you from losing a redo file" />
                  <MetricTile label="Current group" value={redo.data?.current_group ?? '—'} icon="activity" />
                  <MetricTile label="Log mode" value={redo.data?.log_mode || '—'} icon="archive"
                    tone={redo.data?.log_mode === 'ARCHIVELOG' ? 'good' : 'warn'} />
                </div>

                {(redo.data?.log_groups || []).some((g) => num(g.members) < 2) && (
                  <Notice tone="warning" title="A redo log group has only one member.">
                    Losing that single file loses the group. Add a second member on different
                    storage with <span className="font-mono">ALTER DATABASE ADD LOGFILE MEMBER</span>.
                  </Notice>
                )}

                <TablePanel title="Redo log groups" icon="refresh" subtitle="v$log">
                  <Table2
                    columns={[
                      { key: 'group', label: 'Group', align: 'right' },
                      { key: 'thread', label: 'Thread', align: 'right' },
                      { key: 'seq', label: 'Sequence', align: 'right' },
                      { key: 'members', label: 'Members', align: 'right' },
                      { key: 'size', label: 'Size', align: 'right' },
                      { key: 'status', label: 'Status' },
                      { key: 'archived', label: 'Archived' },
                      { key: 'scn', label: 'First change (SCN)', align: 'right' },
                      { key: 'first', label: 'First change at' },
                    ]}
                    rows={(redo.data?.log_groups || []).map((g) => ({
                      key: String(g.group),
                      cells: {
                        group: <span className="font-mono font-semibold">{g.group}</span>,
                        thread: <span className="font-mono">{g.thread}</span>,
                        seq: <span className="font-mono font-semibold">{idNum(g.sequence)}</span>,
                        scn: <span className="font-mono text-[11px] text-muted">{idNum(g.first_change)}</span>,
                        members: (
                          <span className={num(g.members) < 2 ? 'font-mono font-bold text-warning-fg' : 'font-mono'}>
                            {g.members}
                          </span>
                        ),
                        size: <span className="font-mono text-[12px]">{fmtBytes(mb(g.size_mb))}</span>,
                        status: <StateChip value={g.status} tones={REDO_TONES} />,
                        archived: <StateChip value={g.archived} tones={{ YES: 'success', NO: 'warning' }} />,
                        first: <span className="font-mono text-[11px] whitespace-nowrap text-muted">{g.first_time}</span>,
                      },
                    }))}
                    empty={<EmptyState icon="refresh" title="No redo log groups"
                      body={redo.data?.error || 'v$log returned nothing.'} />}
                  />
                </TablePanel>

                <TablePanel title="Redo log members" icon="logs" subtitle="v$logfile — the files on disk">
                  <Paged rows={redo.data?.logfiles || []} unit="members">
                    {(page, pager) => (
                      <>
                        <Table2
                          columns={[
                            { key: 'group', label: 'Group', align: 'right' },
                            { key: 'type', label: 'Type' },
                            { key: 'status', label: 'Status' },
                            { key: 'member', label: 'File' },
                          ]}
                          rows={page.map((f, i) => ({
                            key: `${f.group}-${i}`,
                            cells: {
                              group: <span className="font-mono font-semibold">{f.group}</span>,
                              type: <span className="text-[11px] text-muted">{f.type}</span>,
                              status: f.file_status
                                ? <StateChip value={f.file_status} tones={{ INVALID: 'danger', STALE: 'warning', DELETED: 'neutral' }} />
                                : <Badge tone="success" size="xs">In use</Badge>,
                              member: (
                                <span title={f.member} className="truncate-safe block max-w-[420px] font-mono text-[11px] text-fg">
                                  {f.member}
                                </span>
                              ),
                            },
                          }))}
                          empty={<EmptyState icon="logs" title="No redo members" />}
                        />
                        {pager}
                      </>
                    )}
                  </Paged>
                </TablePanel>
              </>
            )}
          </div>
        )}

        {/* ══ PROCESSES ═════════════════════════════════════════════════════ */}
        {on('processes') && (
          <div className="space-y-gutter">
            {processes.isLoading ? <PageLoading title="Reading background processes…" illustration /> : (
              <>
                <div className="grid grid-cols-2 gap-gutter-sm md:grid-cols-3">
                  <MetricTile label="Background processes" value={processes.data?.total ?? '—'} icon="cpu" />
                  <MetricTile label="PGA allocated"
                    value={processes.data?.total_pga_mb != null ? fmtBytes(mb(processes.data.total_pga_mb)) : '—'}
                    icon="memory" />
                  <MetricTile label="Largest single process" icon="memory"
                    value={(processes.data?.processes || []).length
                      ? fmtBytes(mb(Math.max(...processes.data.processes.map((p) => num(p.pga_alloc_mb)))))
                      : '—'} />
                </div>

                <TablePanel title="Background processes" icon="cpu"
                  subtitle="v$bgprocess joined to v$process — Oracle's own processes and their memory">
                  <Paged rows={processes.data?.processes || []} unit="processes">
                    {(page, pager) => (
                      <>
                        <Table2
                          columns={[
                            { key: 'name', label: 'Process' },
                            { key: 'desc', label: 'Role' },
                            { key: 'pid', label: 'PID', align: 'right' },
                            { key: 'spid', label: 'OS PID', align: 'right' },
                            { key: 'used', label: 'PGA used', align: 'right' },
                            { key: 'alloc', label: 'PGA allocated', align: 'right' },
                            { key: 'max', label: 'PGA peak', align: 'right' },
                          ]}
                          rows={page.map((p, i) => ({
                            key: `${p.pname}-${i}`,
                            cells: {
                              name: <span className="font-mono text-[12px] font-semibold text-accent-text">{p.pname}</span>,
                              desc: <span className="truncate-safe block max-w-[280px] text-[11px] text-muted">{p.description}</span>,
                              pid: <span className="font-mono">{p.pid}</span>,
                              spid: <span className="font-mono text-[11px]">{p.spid}</span>,
                              used: <span className="font-mono text-[12px]">{fmtBytes(mb(p.pga_used_mb))}</span>,
                              alloc: <span className="font-mono text-[12px] font-semibold">{fmtBytes(mb(p.pga_alloc_mb))}</span>,
                              max: <span className="font-mono text-[12px] text-muted">{fmtBytes(mb(p.pga_max_mb))}</span>,
                            },
                          }))}
                          empty={<EmptyState icon="cpu" title="No processes"
                            body={processes.data?.error || 'v$bgprocess returned nothing.'} />}
                        />
                        {pager}
                      </>
                    )}
                  </Paged>
                </TablePanel>
              </>
            )}
          </div>
        )}

        {/* ══ USERS ═════════════════════════════════════════════════════════ */}
        {on('users') && (
          <div className="space-y-gutter">
            {users.isLoading ? <PageLoading title="Reading dba_users…" illustration /> : (
              <>
                <div className="grid grid-cols-2 gap-gutter-sm md:grid-cols-4">
                  <MetricTile label="Accounts" value={users.data?.total ?? '—'} icon="key" />
                  <MetricTile label="Open" value={users.data?.open ?? '—'} icon="check" tone="good" />
                  <MetricTile label="Locked" value={users.data?.locked ?? '—'} icon="lock"
                    tone={num(users.data?.locked) ? 'warn' : 'good'} />
                  <MetricTile label="Expired" value={users.data?.expired ?? '—'} icon="clock"
                    tone={num(users.data?.expired) ? 'warn' : 'good'}
                    hint="An expired password blocks the next login attempt" />
                </div>

                <ObjectTable
                  title="Database accounts"
                  icon="key"
                  columns={USER_COLUMNS}
                  items={users.data?.users || []}
                  loading={users.isFetching}
                  searchOn={['username', 'profile', 'default_tablespace', 'account_status']}
                  searchPlaceholder="Search accounts…"
                  defaultSort={{ key: 'username', dir: 'asc' }}
                  keyOf={(u) => u.username}
                  unit="accounts"
                  views={['table']}
                  note="dba_users — includes Oracle's own accounts, most of which are locked by design"
                  emptyTitle="No accounts"
                  emptyBody={users.data?.error || 'dba_users returned nothing.'}
                />
              </>
            )}
          </div>
        )}

        {/* ══ SYSTEM STATS ══════════════════════════════════════════════════ */}
        {on('systemstats') && (
          <div className="space-y-gutter">
            {sysStats.isLoading ? <PageLoading title="Reading v$sysstat…" illustration /> : (
              <>
                {Object.keys(sysStats.data?.key_stats || {}).length > 0 && (
                  <Panel title="Statistics worth watching" icon="trend"
                    subtitle="Counters since instance startup, not rates">
                    <div className="grid gap-gutter-sm sm:grid-cols-3 xl:grid-cols-5">
                      {Object.entries(sysStats.data.key_stats).map(([name, value]) => (
                        <StatCell key={name} label={name} value={fmtNumber(value)} />
                      ))}
                    </div>
                  </Panel>
                )}

                <TablePanel
                  title="All system statistics"
                  icon="chart-bar"
                  subtitle={`${sysStats.data?.total ?? 0} counters with a non-zero value, grouped by Oracle's own statistic class`}
                  actions={(
                    <Input
                      value={statSearch}
                      onChange={(e) => setStatSearch(e.target.value)}
                      onClear={() => setStatSearch('')}
                      placeholder="Search statistics…"
                      icon="search"
                      size="sm"
                      wrapperClassName="w-44"
                    />
                  )}
                >
                  <Paged
                    rows={(sysStats.data?.stats || []).filter(
                      (s) => !statSearch.trim()
                        || s.name.toLowerCase().includes(statSearch.trim().toLowerCase()),
                    )}
                    unit="statistics"
                  >
                    {(page, pager) => (
                      <>
                        <Table2
                          columns={[
                            { key: 'name', label: 'Statistic' },
                            { key: 'class', label: 'Class' },
                            { key: 'value', label: 'Value', align: 'right' },
                          ]}
                          rows={page.map((s, i) => ({
                            key: `${s.name}-${i}`,
                            cells: {
                              name: <span className="text-[12px] text-fg">{s.name}</span>,
                              class: <Badge tone="neutral" size="xs">{STAT_CLASSES[s.class] || `Class ${s.class}`}</Badge>,
                              value: <span className="font-mono">{fmtNumber(s.value)}</span>,
                            },
                          }))}
                          empty={<EmptyState icon="chart-bar" title="No statistics"
                            body={sysStats.data?.error || 'No counter has a non-zero value.'} />}
                        />
                        {pager}
                      </>
                    )}
                  </Paged>
                </TablePanel>
              </>
            )}
          </div>
        )}

        {/* ══ SLOW SQL ══════════════════════════════════════════════════════ */}
        {on('slowqueries') && (
          <div className="space-y-gutter">
            {slowSql.isLoading ? <PageLoading title="Reading v$sqlarea…" illustration /> : (
              <>
                <div className="grid grid-cols-2 gap-gutter-sm md:grid-cols-4">
                  <MetricTile label="Statements" value={slowSql.data?.total ?? 0} icon="clock" />
                  <MetricTile label="Slowest average" icon="trend"
                    value={(slowSql.data?.queries || []).length
                      ? `${(slowSql.data.queries[0].avg_elapsed_sec ?? 0).toFixed(2)}s`
                      : '—'} />
                  <MetricTile label="Over 1s per run" icon="alert"
                    value={(slowSql.data?.queries || []).filter((q) => num(q.avg_elapsed_sec) >= 1).length}
                    tone={(slowSql.data?.queries || []).some((q) => num(q.avg_elapsed_sec) >= 1) ? 'warn' : 'good'} />
                  <MetricTile label="Source" value={slowSql.data?.source || '—'} icon="database" />
                </div>
                <SlowSqlPanel
                  rows={slowSql.data?.queries || []}
                  onOpen={() => navigate(`/oracle-dashboard/${id}/slow-queries`)}
                  onRowOpen={(sqlId, raw) => navigate(`/oracle-dashboard/${id}/slow-queries/detail`, {
                    state: {
                      row: (slowSql.data?.normalized || []).find((n) => n.query_id === sqlId),
                      raw,
                    },
                  })}
                />
              </>
            )}
          </div>
        )}

        {/* ══ MAINTENANCE ═══════════════════════════════════════════════════ */}
        {on('maintenance') && <OracleMaintenanceModule connId={id} />}

        {/* ══ LIVE QUERIES ══════════════════════════════════════════════════ */}
        {on('live') && <OracleLiveQueries connId={id} embedded />}

        {/* ══ LOCKS ═════════════════════════════════════════════════════════ */}
        {on('locks') && (
          <div className="space-y-gutter">
            {locks.isLoading ? <PageLoading title="Reading v$lock…" illustration /> : (
              <>
                <div className="grid grid-cols-2 gap-gutter-sm md:grid-cols-3">
                  <MetricTile label="Sessions waiting on a lock" value={locks.data?.total_waits ?? 0} icon="lock"
                    tone={num(locks.data?.total_waits) ? 'bad' : 'good'} />
                  <MetricTile label="Longest wait" icon="clock"
                    value={(locks.data?.lock_waits || []).length
                      ? `${fmtNumber(Math.max(...locks.data.lock_waits.map((l) => num(l.seconds_in_wait))))}s`
                      : '—'} />
                  <MetricTile label="Enqueue types with waits"
                    value={(locks.data?.enqueue_stats || []).length} icon="layers" />
                </div>

                {num(locks.data?.total_waits) > 0 && (
                  <Notice tone="danger" title="A session is blocked.">
                    A blocked session cannot make progress until the holder commits or rolls back —
                    tuning the blocked statement will not help.
                  </Notice>
                )}

                <TablePanel title="Lock waits" icon="lock"
                  subtitle="Who is waiting, and who is holding the lock they need">
                  <Paged rows={locks.data?.lock_waits || []} unit="waits">
                    {(page, pager) => (
                      <>
                        <Table2
                          columns={[
                            { key: 'waiter', label: 'Waiting session' },
                            { key: 'holder', label: 'Held by' },
                            { key: 'secs', label: 'Waiting', align: 'right' },
                            { key: 'type', label: 'Lock' },
                            { key: 'event', label: 'Wait event' },
                            { key: 'sql', label: 'Blocked statement' },
                          ]}
                          rows={page.map((l, i) => ({
                            key: `lock-${l.waiter_sid}-${i}`,
                            cells: {
                              waiter: (
                                <span className="flex flex-col">
                                  <span className="font-mono text-[12px] font-semibold">SID {l.waiter_sid}</span>
                                  <span className="text-[10px] text-subtle">{l.waiter_user} · {l.waiter_machine}</span>
                                </span>
                              ),
                              holder: (
                                <span className="flex flex-col">
                                  <Badge tone="danger" size="xs">SID {l.holder_sid}</Badge>
                                  <span className="mt-0.5 text-[10px] text-subtle">{l.holder_user} · {l.holder_machine}</span>
                                </span>
                              ),
                              secs: <span className="font-mono font-bold text-danger-fg">{fmtNumber(l.seconds_in_wait)}s</span>,
                              type: <Badge tone="warning" size="xs">{l.lock_type}</Badge>,
                              event: <WaitEventCell event={l.wait_event} />,
                              sql: <SqlCell sql={l.waiter_sql} max={80} />,
                            },
                          }))}
                          empty={<EmptyState icon="check" title="No lock waits"
                            body="No session is waiting for a lock another session holds." />}
                        />
                        {pager}
                      </>
                    )}
                  </Paged>
                </TablePanel>

                <TablePanel title="Enqueue statistics" icon="layers"
                  subtitle="v$enqueue_statistics — cumulative lock waits by resource type since startup">
                  <Paged rows={locks.data?.enqueue_stats || []} unit="types">
                    {(page, pager) => (
                      <>
                        <Table2
                          columns={[
                            { key: 'type', label: 'Enqueue type' },
                            { key: 'req', label: 'Requests', align: 'right' },
                            { key: 'waits', label: 'Waits', align: 'right' },
                            { key: 'failed', label: 'Failed', align: 'right' },
                            { key: 'sec', label: 'Cumulative wait', align: 'right' },
                          ]}
                          rows={page.map((e, i) => ({
                            key: `${e.eq_type}-${i}`,
                            cells: {
                              type: <span className="font-mono text-[12px] font-semibold">{e.eq_type}</span>,
                              req: <span className="font-mono">{fmtNumber(e.total_req)}</span>,
                              waits: <span className="font-mono">{fmtNumber(e.total_wait)}</span>,
                              failed: (
                                <span className={num(e.failed_req) ? 'font-mono font-bold text-danger-fg' : 'font-mono'}>
                                  {fmtNumber(e.failed_req)}
                                </span>
                              ),
                              sec: <span className="font-mono font-semibold">{fmtNumber(e.cum_wait_sec)}s</span>,
                            },
                          }))}
                          empty={<EmptyState icon="layers" title="No enqueue waits"
                            body="No lock type has recorded a wait since startup." />}
                        />
                        {pager}
                      </>
                    )}
                  </Paged>
                </TablePanel>
              </>
            )}
          </div>
        )}

        {/* ══ SQL MONITOR ═══════════════════════════════════════════════════ */}
        {on('sqlmonitor') && (
          <div className="space-y-gutter">
            {sqlMonitor.isLoading ? <PageLoading title="Reading v$sql_monitor…" illustration /> : (
              <>
                {sqlMonitor.data?.licensed === false && (
                  <Notice tone="warning" title="Real-Time SQL Monitoring is not available on this instance.">
                    {sqlMonitor.data?.note}
                  </Notice>
                )}

                {sqlMonitor.data?.licensed !== false && (
                  <>
                    <div className="grid grid-cols-2 gap-gutter-sm md:grid-cols-3">
                      <MetricTile
                        label="Executing now"
                        value={sqlMonitorCounts.executing}
                        icon="activity"
                        tone={sqlMonitorCounts.executing > 0 ? 'accent' : 'neutral'}
                      />
                      <MetricTile
                        label="Parallel executions"
                        value={sqlMonitorCounts.parallel}
                        icon="layers"
                      />
                      <MetricTile
                        label="Recently finished (10 min)"
                        value={sqlMonitorCounts.finished}
                        icon="clock"
                      />
                    </div>

                    <TablePanel
                      title="Monitored executions"
                      icon="activity"
                      subtitle="v$sql_monitor — currently executing or finished in the last 10 minutes. Select a row for per-step progress."
                    >
                      <Paged rows={sqlMonitor.data?.executions || []} unit="executions">
                        {(page, pager) => (
                          <>
                            <Table2
                              columns={[
                                { key: 'sql', label: 'SQL' },
                                { key: 'status', label: 'Status' },
                                { key: 'elapsed', label: 'Elapsed', align: 'right' },
                                { key: 'cpu', label: 'CPU', align: 'right' },
                                { key: 'px', label: 'Parallel' },
                                { key: 'user', label: 'User' },
                              ]}
                              rows={page.map((e, i) => {
                                const key = `${e.sql_id}-${e.sql_exec_id}-${i}`;
                                return {
                                  key,
                                  onClick: () => setOpenMonitor(
                                    openMonitor?.sql_id === e.sql_id && openMonitor?.sql_exec_id === e.sql_exec_id
                                      ? null : { sql_id: e.sql_id, sql_exec_id: e.sql_exec_id },
                                  ),
                                  cells: {
                                    sql: <SqlCell sql={e.sql_text} max={90} />,
                                    status: (
                                      <Badge tone={e.status === 'EXECUTING' ? 'accent' : e.status?.includes('ERROR') ? 'danger' : 'success'} size="xs">
                                        {e.status}
                                      </Badge>
                                    ),
                                    elapsed: <span className="font-mono">{fmtNumber(e.elapsed_ms)}ms</span>,
                                    cpu: <span className="font-mono text-muted">{fmtNumber(e.cpu_ms)}ms</span>,
                                    px: num(e.px_allocated) > 0
                                      ? <Badge tone="info" size="xs">{e.px_allocated}/{e.px_requested} PX</Badge>
                                      : <span className="text-subtle">—</span>,
                                    user: <span className="font-mono text-[11px]">{e.username}</span>,
                                  },
                                };
                              })}
                              empty={<EmptyState icon="check" title="Nothing executing"
                                body="No SQL is currently monitored, and nothing finished in the last 10 minutes." />}
                            />
                            {openMonitor && (
                              <div className="border-t border-border bg-sunken px-card py-3">
                                {monitorDetail.isLoading ? <InlineLoading label="Reading v$sql_plan_monitor…" /> : (
                                  <Table2
                                    columns={[
                                      { key: 'op', label: 'Operation' },
                                      { key: 'status', label: 'Status' },
                                      { key: 'rows', label: 'Rows out / est.', align: 'right' },
                                      { key: 'time', label: 'Active time', align: 'right' },
                                    ]}
                                    rows={(monitorDetail.data?.steps || []).map((s, i) => ({
                                      key: `${s.plan_line_id}-${i}`,
                                      cells: {
                                        op: (
                                          <span className="font-mono text-[11px]">
                                            {s.operation} {s.options || ''}
                                            {s.object_name && <span className="ml-1 text-subtle">{s.object_name}</span>}
                                          </span>
                                        ),
                                        status: <Badge tone={s.status === 'EXECUTING' ? 'accent' : s.status === 'DONE' ? 'success' : 'neutral'} size="xs">{s.status}</Badge>,
                                        rows: <span className="font-mono">{fmtNumber(s.output_rows)} / {fmtNumber(s.estimated_rows)}</span>,
                                        time: <span className="font-mono">{fmtNumber(s.time_active_sec)}s</span>,
                                      },
                                    }))}
                                    empty={<EmptyState icon="terminal" title="No step data yet" />}
                                  />
                                )}
                              </div>
                            )}
                            {pager}
                          </>
                        )}
                      </Paged>
                    </TablePanel>
                  </>
                )}
              </>
            )}
          </div>
        )}

        {/* ══ PARAMETERS ════════════════════════════════════════════════════ */}
        {on('parameters') && (
          <div className="space-y-gutter">
            {params.isLoading ? <PageLoading title="Reading v$parameter…" illustration /> : (
              <TablePanel
                title="Initialisation parameters"
                icon="settings"
                subtitle="A parameter marked modified differs from Oracle's default for this instance"
                actions={(
                  <>
                    <Select
                      value={paramScope}
                      onChange={setParamScope}
                      options={[
                        { id: 'key', label: `Key parameters (${(params.data?.key_params || []).length})` },
                        { id: 'all', label: `All (${params.data?.total ?? 0})` },
                        { id: 'modified', label: 'Changed from default' },
                      ]}
                      size="sm"
                      width="auto"
                    />
                    <Input
                      value={paramSearch}
                      onChange={(e) => setParamSearch(e.target.value)}
                      onClear={() => setParamSearch('')}
                      placeholder="Search parameters…"
                      icon="search"
                      size="sm"
                      wrapperClassName="w-44"
                    />
                  </>
                )}
              >
                <Paged
                  rows={filteredParams}
                  unit="parameters"
                >
                  {(page, pager) => (
                    <>
                      <Table2
                        columns={[
                          { key: 'name', label: 'Parameter' },
                          { key: 'value', label: 'Value' },
                          { key: 'default', label: 'Default' },
                          { key: 'modifiable', label: 'Changeable now' },
                          { key: 'desc', label: 'What it does' },
                        ]}
                        rows={page.map((p, i) => ({
                          key: `${p.name}-${i}`,
                          cells: {
                            name: <span className="font-mono text-[12px] font-semibold text-accent-text">{p.name}</span>,
                            value: (
                              <span title={p.value}
                                className="truncate-safe block max-w-[220px] font-mono text-[12px] text-fg">
                                {p.value || <span className="text-subtle">(empty)</span>}
                              </span>
                            ),
                            default: p.isdefault === 'TRUE'
                              ? <Badge tone="neutral" size="xs">Default</Badge>
                              : <Badge tone="accent" size="xs">Changed</Badge>,
                            modifiable: <StateChip value={p.modifiable}
                              tones={{ IMMEDIATE: 'success', DEFERRED: 'warning', FALSE: 'neutral' }} />,
                            desc: <span className="block max-w-[300px] text-[11px] leading-snug text-muted">{p.description}</span>,
                          },
                        }))}
                        empty={<EmptyState icon="settings" title="No parameters"
                          body={params.data?.error || 'v$parameter returned nothing for this filter.'} />}
                      />
                      {pager}
                    </>
                  )}
                </Paged>
              </TablePanel>
            )}
          </div>
        )}
      </div>
    </DashboardScopeProvider>
  );
}

/* ── shared table panels ───────────────────────────────────────────────────── */

const STAT_CLASSES = {
  1: 'User', 2: 'Redo', 4: 'Enqueue', 8: 'Cache', 16: 'OS',
  32: 'Clusters', 64: 'SQL', 128: 'Debug',
};

const USER_COLUMNS = [
  {
    key: 'username',
    label: 'Account',
    sortable: true,
    sortValue: (u) => u.username || '',
    render: (u) => <span className="font-mono text-[12px] font-semibold text-accent-text">{u.username}</span>,
  },
  {
    key: 'status',
    label: 'Status',
    sortable: true,
    sortValue: (u) => u.account_status || '',
    render: (u) => (u.account_status
      ? <Badge tone={ACCOUNT_TONES[u.account_status] || 'neutral'} size="xs">{u.account_status}</Badge>
      : null),
  },
  {
    key: 'profile',
    label: 'Profile',
    sortable: true,
    sortValue: (u) => u.profile || '',
    render: (u) => <span className="text-[11px] text-muted">{u.profile}</span>,
  },
  {
    key: 'tablespace',
    label: 'Default / temp tablespace',
    sortable: true,
    sortValue: (u) => u.default_tablespace || '',
    render: (u) => (
      <span className="block text-[11px] leading-tight">
        <span className="block font-mono text-fg">{u.default_tablespace || '—'}</span>
        <span className="block text-subtle">{u.temporary_tablespace || '—'}</span>
      </span>
    ),
  },
  {
    key: 'created',
    label: 'Created',
    sortable: true,
    sortValue: (u) => u.created || '',
    render: (u) => <span className="font-mono text-[11px] whitespace-nowrap text-muted">{u.created}</span>,
  },
  {
    key: 'last_login',
    label: 'Last login',
    hint: 'dba_users.last_login is only populated on Oracle 12c and later.',
    sortable: true,
    sortValue: (u) => u.last_login || '',
    render: (u) => <span className="font-mono text-[11px] whitespace-nowrap text-muted">{u.last_login}</span>,
  },
];

function TopSqlPanel({ rows, title, actions, full = false }) {
  return (
    <TablePanel title={title} icon="zap"
      subtitle="v$sql, ordered by total elapsed time — the statements the instance spends its time on"
      actions={actions}>
      <Paged rows={rows} unit="statements" pageSize={full ? undefined : '10'}>
        {(page, pager) => (
          <>
            <Table2
              columns={[
                { key: 'sql', label: 'Statement' },
                { key: 'schema', label: 'Schema' },
                { key: 'execs', label: 'Executions', align: 'right' },
                { key: 'avg', label: 'Avg elapsed', align: 'right' },
                { key: 'total', label: 'Total elapsed', align: 'right' },
                { key: 'cpu', label: 'Avg CPU', align: 'right' },
                { key: 'gets', label: 'Buffer gets', align: 'right' },
                { key: 'reads', label: 'Disk reads', align: 'right' },
              ]}
              rows={page.map((s, i) => ({
                key: `${s.sql_id}-${i}`,
                cells: {
                  sql: (
                    <span className="block">
                      <SqlCell sql={s.sql_text} max={110} />
                      {s.sql_id && <span className="mt-0.5 block font-mono text-[10px] text-subtle">{s.sql_id}</span>}
                    </span>
                  ),
                  schema: s.parsing_schema_name
                    ? <Badge tone="accent" size="xs">{s.parsing_schema_name}</Badge> : null,
                  execs: <span className="font-mono">{fmtNumber(s.executions)}</span>,
                  avg: <span className="font-mono font-semibold">{fmtNumber(s.avg_elapsed_ms)} ms</span>,
                  total: <span className="font-mono">{fmtNumber(s.elapsed_ms)} ms</span>,
                  cpu: <span className="font-mono">{fmtNumber(s.avg_cpu_ms)} ms</span>,
                  gets: <span className="font-mono">{fmtNumber(s.buffer_gets)}</span>,
                  reads: (
                    <span className={num(s.disk_reads) > num(s.buffer_gets) * 0.1 ? 'font-mono font-bold text-warning-fg' : 'font-mono'}>
                      {fmtNumber(s.disk_reads)}
                    </span>
                  ),
                },
              }))}
              empty={<EmptyState icon="zap" title="No cached SQL"
                body="v$sql has no statement with at least one execution — the cache is cleared on restart." />}
            />
            {pager}
          </>
        )}
      </Paged>
    </TablePanel>
  );
}

function SlowSqlPanel({ rows, onOpen, onRowOpen }) {
  return (
    <TablePanel title="Slowest SQL by average elapsed time" icon="clock"
      subtitle="v$sqlarea — average per execution, so a statement run once is ranked on that one run"
      actions={<Button size="sm" variant="secondary" iconRight="chevron-right" onClick={onOpen}>
        Full analysis
      </Button>}>
      <Paged rows={rows} unit="statements">
        {(page, pager) => (
          <>
            <Table2
              columns={[
                { key: 'sql', label: 'Statement' },
                { key: 'schema', label: 'Schema' },
                { key: 'avg', label: 'Avg elapsed', align: 'right' },
                { key: 'cpu', label: 'Avg CPU', align: 'right' },
                { key: 'execs', label: 'Executions', align: 'right' },
                { key: 'reads', label: 'Avg disk reads', align: 'right' },
                { key: 'gets', label: 'Avg buffer gets', align: 'right' },
                { key: 'last', label: 'Last run' },
              ]}
              rows={page.map((s, i) => {
                const avg = num(s.avg_elapsed_sec);
                return {
                  key: `${s.sql_id}-${i}`,
                  onClick: onRowOpen ? () => onRowOpen(s.sql_id, s) : undefined,
                  cells: {
                    sql: (
                      <span className="block">
                        <SqlCell sql={s.sql_text} max={100} />
                        {s.sql_id && <span className="mt-0.5 block font-mono text-[10px] text-subtle">{s.sql_id}</span>}
                      </span>
                    ),
                    schema: s.parsing_schema_name
                      ? <Badge tone="accent" size="xs">{s.parsing_schema_name}</Badge> : null,
                    avg: (
                      <span className={avg >= 5 ? 'font-mono font-bold text-danger-fg'
                        : avg >= 1 ? 'font-mono font-bold text-warning-fg' : 'font-mono font-semibold'}>
                        {avg.toFixed(3)}s
                      </span>
                    ),
                    cpu: <span className="font-mono">{num(s.avg_cpu_sec).toFixed(3)}s</span>,
                    execs: <span className="font-mono">{fmtNumber(s.executions)}</span>,
                    reads: <span className="font-mono">{fmtNumber(s.avg_disk_reads)}</span>,
                    gets: <span className="font-mono">{fmtNumber(s.avg_buffer_gets)}</span>,
                    last: <span className="font-mono text-[11px] whitespace-nowrap text-muted">{s.last_active_time}</span>,
                  },
                };
              })}
              empty={<EmptyState icon="clock" title="No SQL in the shared area" />}
            />
            {pager}
          </>
        )}
      </Paged>
    </TablePanel>
  );
}

function SessionsPanel({ rows, loading }) {
  return (
    <TablePanel title={`Sessions (${rows.length})`} icon="users"
      subtitle="v$session — background processes included, longest waits first">
      {loading ? <InlineLoading label="Reading v$session…" /> : (
        <Paged rows={rows} unit="sessions">
          {(page, pager) => (
            <>
              <Table2
                columns={[
                  { key: 'sid', label: 'SID' },
                  { key: 'user', label: 'User' },
                  { key: 'type', label: 'Type' },
                  { key: 'status', label: 'Status' },
                  { key: 'client', label: 'Client' },
                  { key: 'wait', label: 'Waiting on' },
                  { key: 'secs', label: 'For', align: 'right' },
                  { key: 'blocker', label: 'Blocked by' },
                  { key: 'sql', label: 'Statement' },
                ]}
                rows={page.map((s, i) => ({
                  key: `${s.sid}-${s.serial_number}-${i}`,
                  cells: {
                    sid: (
                      <span className="font-mono text-[12px] font-semibold">
                        {s.sid}
                        <span className="text-subtle">,{s.serial_number}</span>
                      </span>
                    ),
                    user: <span className="truncate-safe block max-w-[110px] font-semibold text-accent-text">{s.username}</span>,
                    type: <StateChip value={s.type} tones={{ USER: 'accent', BACKGROUND: 'info' }} />,
                    status: <StateChip value={s.status} tones={SESSION_TONES} />,
                    client: (
                      /* module before program: "BillingBatch" identifies the code
                         that is running, "JDBC Thin Client" identifies every Java
                         app on the estate. */
                      <span className="block text-[11px] leading-tight">
                        <span className="truncate-safe block max-w-[130px] font-mono text-muted">{s.machine || '—'}</span>
                        <span className="truncate-safe block max-w-[130px] text-subtle">
                          {s.module || s.program || ''}
                        </span>
                      </span>
                    ),
                    wait: <WaitEventCell event={s.wait_event} waitClass={s.wait_class} />,
                    secs: <span className="font-mono">{fmtNumber(s.seconds_in_wait)}s</span>,
                    blocker: s.blocking_session
                      ? <Badge tone="danger" size="xs">SID {s.blocking_session}</Badge> : null,
                    sql: <SqlCell sql={s.sql_text} max={80} />,
                  },
                }))}
                empty={<EmptyState icon="users" title="No sessions" />}
              />
              {pager}
            </>
          )}
        </Paged>
      )}
    </TablePanel>
  );
}
