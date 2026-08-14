import React, { useState, useEffect, useRef, lazy, Suspense } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient, useIsFetching } from '@tanstack/react-query';
import {
  Server, CheckCircle2, AlertTriangle, XCircle, Database, GitBranch,
  Terminal, ArrowRight, RefreshCw, Trash2, Plus, Loader2, Search, X,
  Activity, Layers, ChevronRight, Network, Clock, ChevronLeft, LayoutGrid, List, Stethoscope,
} from 'lucide-react';

import {
  listOsServers, getServerSummary, refreshServerStatus, deleteOsServer, getLiveStatus,
} from '@/api/servers';
import { listConnections } from '@/api/connections';
import { usePermissions } from '@/hooks/usePermissions';
import PageHeader from '@/components/layout/PageHeader';
import HeaderRefreshButton from '@/components/layout/HeaderRefreshButton';
import { engineColor } from '@/config/agents';

/* ══════════════════════════════════════════════════════
   TECHNOLOGY CONFIGURATION
══════════════════════════════════════════════════════ */
const TECH_CONFIG = [
  {
    id: 'mysql',
    name: 'MySQL',
    subtitle: 'MariaDB Compatible',
    emoji: '🐬',
    gradient: 'from-orange-400 to-orange-600',
    lightBg: 'bg-orange-50',
    border: 'border-orange-200',
    text: 'text-orange-700',
    badgeBg: 'bg-orange-100',
    hover: 'hover:border-orange-300 hover:shadow-orange-100/60',
    accent: 'bg-gradient-to-br from-orange-400 to-orange-600',
  },
  {
    id: 'postgresql',
    name: 'PostgreSQL',
    subtitle: 'Advanced Open Source',
    emoji: '🐘',
    gradient: 'from-indigo-400 to-indigo-700',
    lightBg: 'bg-indigo-50',
    border: 'border-indigo-200',
    text: 'text-indigo-700',
    badgeBg: 'bg-indigo-100',
    hover: 'hover:border-indigo-300 hover:shadow-indigo-100/60',
    accent: 'bg-gradient-to-br from-indigo-400 to-indigo-700',
  },
  {
    id: 'mongodb',
    name: 'MongoDB',
    subtitle: 'Document Database',
    emoji: '🍃',
    gradient: 'from-emerald-400 to-emerald-700',
    lightBg: 'bg-emerald-50',
    border: 'border-emerald-200',
    text: 'text-emerald-700',
    badgeBg: 'bg-emerald-100',
    hover: 'hover:border-emerald-300 hover:shadow-emerald-100/60',
    accent: 'bg-gradient-to-br from-emerald-400 to-emerald-700',
  },
  {
    id: 'mssql',
    name: 'SQL Server',
    subtitle: 'Microsoft MSSQL',
    emoji: '🖥️',
    gradient: 'from-sky-400 to-sky-700',
    lightBg: 'bg-sky-50',
    border: 'border-sky-200',
    text: 'text-sky-700',
    badgeBg: 'bg-sky-100',
    hover: 'hover:border-sky-300 hover:shadow-sky-100/60',
    accent: 'bg-gradient-to-br from-sky-400 to-sky-700',
  },
  {
    id: 'oracle',
    name: 'Oracle DB',
    subtitle: 'Enterprise RDBMS',
    emoji: '☀️',
    gradient: 'from-red-400 to-red-600',
    lightBg: 'bg-red-50',
    border: 'border-red-200',
    text: 'text-red-700',
    badgeBg: 'bg-red-100',
    hover: 'hover:border-red-300 hover:shadow-red-100/60',
    accent: 'bg-gradient-to-br from-red-400 to-red-600',
  },
  {
    id: 'clickhouse',
    name: 'ClickHouse',
    subtitle: 'Columnar Analytics',
    emoji: '⚡',
    gradient: 'from-yellow-400 to-amber-500',
    lightBg: 'bg-yellow-50',
    border: 'border-yellow-200',
    text: 'text-yellow-700',
    badgeBg: 'bg-yellow-100',
    hover: 'hover:border-yellow-300 hover:shadow-yellow-100/60',
    accent: 'bg-gradient-to-br from-yellow-400 to-amber-500',
  },
];

/* ══════════════════════════════════════════════════════
   CLOUD-BASED DATABASES — managed cloud DB services (no OS host to monitor,
   just a connection). Azure Cosmos DB is wired up for real; the rest are
   listed as "Coming soon" so the category's extensibility is visible without
   pretending they're already supported.
══════════════════════════════════════════════════════ */
const CLOUD_TECH_CONFIG = [
  {
    id: 'cosmosdb', name: 'Azure Cosmos DB', subtitle: 'Multi-model, globally distributed', emoji: '🌌',
    accent: 'bg-gradient-to-br from-sky-500 to-blue-700', lightBg: 'bg-sky-50', border: 'border-sky-200', text: 'text-sky-700', available: true,
  },
  { id: 'dynamodb', name: 'Amazon DynamoDB', subtitle: 'Key-value & document', emoji: '🟧', available: false },
  { id: 'firestore', name: 'Google Cloud Firestore', subtitle: 'Document database', emoji: '🔶', available: false },
  { id: 'bigtable', name: 'Google Cloud Bigtable', subtitle: 'Wide-column store', emoji: '🟦', available: false },
  { id: 'tablestorage', name: 'Azure Table Storage', subtitle: 'NoSQL key-value store', emoji: '🗂️', available: false },
  { id: 'documentdb', name: 'Amazon DocumentDB', subtitle: 'MongoDB-compatible', emoji: '📄', available: false },
  { id: 'mongoatlas', name: 'MongoDB Atlas', subtitle: 'Managed MongoDB', emoji: '🍃', available: false },
  { id: 'couchbase', name: 'Couchbase Capella', subtitle: 'Managed Couchbase', emoji: '🛋️', available: false },
  { id: 'firebase', name: 'Firebase Realtime Database', subtitle: 'Realtime JSON store', emoji: '🔥', available: false },
];

function serverMatchesTech(server, tech) {
  const svcs = (server.database_services || []).map(s => s.toLowerCase());
  if (tech === 'mysql') return svcs.some(s => s === 'mysql' || s === 'mariadb');
  return svcs.some(s => s === tech);
}
function connMatchesTech(conn, tech) {
  const type = (conn.db_type || '').toLowerCase();
  if (tech === 'mysql') return type === 'mysql' || type === 'mariadb';
  return type === tech;
}

function getDashboardPath(conn) {
  const type = (conn.db_type || '').toLowerCase();
  const map = {
    mysql: `/mysql-dashboard/${conn.id}`,
    postgresql: `/postgresql-dashboard/${conn.id}`,
    oracle: `/oracle-dashboard/${conn.id}`,
    mssql: `/mssql-dashboard/${conn.id}`,
    mongodb: `/mongodb-dashboard/${conn.id}`,
    clickhouse: `/clickhouse-dashboard/${conn.id}`,
    cosmosdb: `/cosmosdb-dashboard/${conn.id}`,
  };
  return map[type] || '/connections';
}

const normDb = (t) => ((t === 'mariadb' ? 'mysql' : t) || '').toLowerCase();

/** Default listener per engine, for pre-filling the "connect this host" form. */
const DEFAULT_PORTS = {
  mysql: 3306, postgresql: 5432, oracle: 1521, mssql: 1433, mongodb: 27017, clickhouse: 8123,
};

/**
 * Where opening a server goes. ONE definition, used by the row, the card and the
 * action button alike — clicking anywhere on a server must land in the same place
 * as its button, whichever technology's list it is.
 *
 * Order matters: an unhealthy database goes to the Diagnosis Center rather than a
 * dashboard that would render stale cached numbers as if they were live; a host
 * with no connection yet goes to the connect form.
 */
export function serverTarget({ node, conn, linkedInst, want, dbUp }) {
  const connId = conn?.id || linkedInst?.connection_id;
  if (connId && !dbUp) return `/diagnose/${connId}`;
  if (conn) return getDashboardPath(conn);
  if (linkedInst) return getDashboardPath({ db_type: linkedInst.db_type, id: linkedInst.connection_id });
  const db = want || node.database_services?.[0]?.toLowerCase() || 'mysql';
  return `/connections/add?type=${db}&host=${node.ip_address}`
    + `&port=${DEFAULT_PORTS[db] || 3306}`
    + `&name=${encodeURIComponent(`${node.server_name}-${db}`)}`;
}

/** What the click does, in words — the row's tooltip and the button's title. */
function serverTargetLabel({ conn, linkedInst, dbUp }) {
  if (!(conn || linkedInst)) return 'Connect';
  return dbUp ? 'Dashboard' : 'Diagnose';
}

// Resolve the connection for a host, biased to a specific technology when given —
// so a host running BOTH MySQL and PostgreSQL resolves to the right one per tab.
function findConn(allConnections, server, preferType = null) {
  const services = (server.database_services || []).map((d) => d.toLowerCase());
  const want = preferType ? normDb(preferType) : null;
  const candidates = allConnections.filter((c) => {
    const sameHost = c.host === server.ip_address;
    const connType = normDb(c.db_type);
    const sameType = services.some((s) => normDb(s) === connType);
    return sameHost && sameType;
  });
  if (want) {
    const exact = candidates.find((c) => normDb(c.db_type) === want);
    if (exact) return exact;
  }
  return candidates[0] || null;
}

const XTerminal = lazy(() => import('../../components/terminal/XTerminal'));
const ENV_FILTERS = ['All', 'Production', 'UAT', 'Development', 'Testing'];

const NODE_META = {
  Primary:        { label:'PRIMARY',     text:'text-emerald-700', bg:'bg-emerald-100',  dot:'bg-emerald-500', accent:'border-l-emerald-500', glow:'shadow-emerald-100' },
  Master:         { label:'MASTER',      text:'text-emerald-700', bg:'bg-emerald-100',  dot:'bg-emerald-500', accent:'border-l-emerald-500', glow:'shadow-emerald-100' },
  Secondary:      { label:'SECONDARY',   text:'text-blue-700',   bg:'bg-blue-100',     dot:'bg-blue-500',    accent:'border-l-blue-400',    glow:'shadow-blue-100' },
  Replica:        { label:'REPLICA',     text:'text-blue-700',   bg:'bg-blue-100',     dot:'bg-blue-500',    accent:'border-l-blue-400',    glow:'shadow-blue-100' },
  Slave:          { label:'SLAVE',       text:'text-blue-700',   bg:'bg-blue-100',     dot:'bg-blue-500',    accent:'border-l-blue-400',    glow:'shadow-blue-100' },
  'Galera Node':  { label:'GALERA',      text:'text-purple-700', bg:'bg-purple-100',   dot:'bg-purple-500',  accent:'border-l-purple-500',  glow:'shadow-purple-100' },
  Arbiter:        { label:'ARBITER',     text:'text-amber-700',  bg:'bg-amber-100',    dot:'bg-amber-400',   accent:'border-l-amber-400',   glow:'shadow-amber-100' },
  Standalone:     { label:'STANDALONE',  text:'text-slate-600',  bg:'bg-slate-100',    dot:'bg-slate-400',   accent:'border-l-slate-300',   glow:'shadow-slate-100' },
  'Cluster Node': { label:'NODE',        text:'text-slate-600',  bg:'bg-slate-100',    dot:'bg-slate-400',   accent:'border-l-slate-300',   glow:'shadow-slate-100' },
};
function nodeMeta(t) { return NODE_META[t] || NODE_META['Cluster Node']; }
function isGalera(nodes) { return nodes.some((n) => n.node_type === 'Galera Node'); }
function sortNodes(nodes) {
  const ord = { Primary:0, Master:1, Secondary:2, Replica:3, Slave:4, 'Galera Node':5, Arbiter:6, 'Cluster Node':7, Standalone:9 };
  return [...nodes].sort((a,b) => (ord[a.node_type]??99)-(ord[b.node_type]??99));
}
function parsePct(v) { return v ? parseFloat(v)||0 : null; }
function clusterAverages(nodes) {
  const cpus  = nodes.map((n)=>parsePct(n.cpu_usage)).filter((v)=>v!==null);
  const rams  = nodes.map((n)=>parsePct(n.ram_usage)).filter((v)=>v!==null);
  const disks = nodes.map((n)=>parsePct(n.disk_usage)).filter((v)=>v!==null);
  const avg   = (arr)=>arr.length ? Math.round(arr.reduce((a,b)=>a+b,0)/arr.length) : null;
  return { cpu:avg(cpus), ram:avg(rams), disk:avg(disks) };
}

const DB_COLORS = {
  mysql:'bg-orange-100 text-orange-700 border-orange-200',
  mariadb:'bg-orange-100 text-orange-700 border-orange-200',
  postgresql:'bg-indigo-100 text-indigo-700 border-indigo-200',
  oracle:'bg-red-100 text-red-700 border-red-200',
  mssql:'bg-sky-100 text-sky-700 border-sky-200',
  mongodb:'bg-emerald-100 text-emerald-700 border-emerald-200',
  clickhouse:'bg-yellow-100 text-yellow-700 border-yellow-200',
};
function dbColor(s) { return DB_COLORS[(s||'').toLowerCase()] || 'bg-slate-100 text-slate-600 border-slate-200'; }

/* ══════════════════════════════════════════════════════
   HEADER STATS  (was drawn inline in each gradient hero)
══════════════════════════════════════════════════════ */
function OnlineBadge({ connected = 0, total = 0, pct }) {
  const percent = pct ?? (total > 0 ? Math.round((connected / total) * 100) : 0);
  const tone = percent > 80 ? 'var(--status-good)'
    : percent > 50 ? 'var(--status-warning)'
      : 'var(--status-critical)';
  // Same h-control height as every button/pill beside it in the header — one
  // line, not two stacked lines, which is what made this taller than its
  // neighbours (padding-based sizing instead of the shared height token).
  return (
    <span className="hidden h-control items-center gap-2 rounded-control border border-border px-3 text-[13px] font-semibold text-fg md:flex">
      <span className="tabular-nums">{connected}/{total}</span>
      <span className="font-normal text-subtle">online</span>
      <span
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ background: total > 0 && connected > 0 ? tone : 'var(--status-unknown)' }}
      />
      <span className="text-muted tabular-nums">{percent}%</span>
    </span>
  );
}

/* ══════════════════════════════════════════════════════
   TECH SELECTOR SCREEN
══════════════════════════════════════════════════════ */
function TechSelectorScreen({ onSelect, techCounts, summary, navigate, techs = TECH_CONFIG, canAdd = true, cosmosCount = 0, countdown, onRefresh, refreshing }) {
  return (
    <>
      {/* Shared app header — same on every page. The breadcrumb the old hero
          drew inline is already provided by the top bar. */}
      <PageHeader
        title="Database Infrastructure"
        icon="database"
        hideBreadcrumbs
        description="Select a database technology to explore servers, clusters &amp; connections"
        actions={(
          <div className="flex items-center gap-2">
            <OnlineBadge connected={summary.connected} total={summary.total} />
            <HeaderRefreshButton seconds={countdown} onClick={onRefresh} spinning={refreshing} />
            {canAdd && (
              <button
                onClick={() => navigate('/databases/add-os-server')}
                className="flex h-control shrink-0 items-center gap-1.5 rounded-control bg-accent px-3.5 text-[13px] font-semibold text-accent-fg transition-colors hover:bg-accent-hover"
              >
                <Plus size={15} /> Add Server
              </button>
            )}
          </div>
        )}
      />

      {/* Tech Grid */}
      <div className="mx-auto w-full">
        <div className="flex items-center gap-3 mb-7">
          <h2 className="text-[18px] font-black text-fg">Choose Technology</h2>
          <div className="flex-1 h-px bg-border"/>
          <span className="text-xs text-muted font-medium">{techs.length} technolog{techs.length !== 1 ? 'ies' : 'y'} available</span>
        </div>

        {techs.length === 0 ? (
          <div className="bg-surface rounded-2xl border border-dashed border-strong p-16 text-center">
            <div className="w-16 h-16 rounded-2xl bg-sunken flex items-center justify-center mx-auto mb-4"><Database size={28} className="text-subtle"/></div>
            <h3 className="text-lg font-black text-fg">No database access</h3>
            <p className="text-muted text-sm mt-1">Your role hasn't been granted access to any database technology yet.</p>
          </div>
        ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {techs.map((tech) => {
            const counts = techCounts[tech.id] || { servers: 0, connections: 0 };
            return (
              <button
                key={tech.id}
                onClick={() => onSelect(tech.id)}
                className={`group relative bg-surface rounded-2xl border-2 border-border p-6 text-left
                  shadow-md hover:shadow-xl transition-all duration-200 hover:-translate-y-1
                  ${tech.hover}`}
              >
                {/* glow on hover */}
                <div className={`absolute top-0 right-0 w-28 h-28 rounded-2xl opacity-0 group-hover:opacity-[0.07] transition-opacity ${tech.accent} pointer-events-none`}/>

                <div className="flex items-start gap-4">
                  <div className={`w-14 h-14 rounded-2xl ${tech.accent} flex items-center justify-center flex-shrink-0 shadow-lg`}>
                    <span className="text-2xl select-none">{tech.emoji}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="text-[17px] font-black text-fg leading-tight">{tech.name}</h3>
                    <p className="text-xs text-muted mt-0.5 font-medium">{tech.subtitle}</p>
                    <div className="flex items-center gap-3 mt-3 flex-wrap">
                      <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg ${tech.lightBg} ${tech.border} border`}>
                        <Server size={11} className={tech.text}/>
                        <span className={`text-[12px] font-black ${tech.text}`}>{counts.servers}</span>
                        <span className={`text-[10px] ${tech.text} opacity-70`}>servers</span>
                      </div>
                      <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg ${tech.lightBg} ${tech.border} border`}>
                        <Database size={11} className={tech.text}/>
                        <span className={`text-[12px] font-black ${tech.text}`}>{counts.connections}</span>
                        <span className={`text-[10px] ${tech.text} opacity-70`}>connections</span>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="flex items-center justify-between mt-5 pt-4 border-t border-border">
                  {counts.servers === 0 && counts.connections === 0 ? (
                    <span className="text-[11px] text-muted font-medium">No servers yet · click to add</span>
                  ) : (
                    <span className={`text-[12px] font-bold ${tech.text}`}>
                      Explore {counts.servers > 0 ? `${counts.servers} server${counts.servers !== 1 ? 's' : ''}` : 'connections'}
                    </span>
                  )}
                  <ChevronRight size={15} className={`${tech.text} group-hover:translate-x-1 transition-transform`}/>
                </div>

                {counts.servers > 0 && (
                  <div className="absolute top-4 right-4">
                    <span className="relative flex h-2.5 w-2.5">
                      <span className="animate-ping absolute h-full w-full rounded-full bg-emerald-400 opacity-60"/>
                      <span className="relative rounded-full h-2.5 w-2.5 bg-emerald-500"/>
                    </span>
                  </div>
                )}
              </button>
            );
          })}
        </div>
        )}

        {/* global summary strip */}
        <div className="mt-8 bg-surface rounded-2xl border border-border shadow-sm px-6 py-4 grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { icon: <Server size={16}/>,       label: 'Total Servers',  value: summary.total,        color: 'text-fg' },
            { icon: <CheckCircle2 size={16}/>,  label: 'Online',         value: summary.connected,    color: 'text-emerald-600' },
            { icon: <AlertTriangle size={16}/>, label: 'Warning',        value: summary.warning,      color: 'text-amber-500' },
            { icon: <GitBranch size={16}/>,     label: 'HA Clusters',    value: summary.clusters,     color: 'text-indigo-600' },
          ].map(({ icon, label, value, color }) => (
            <div key={label} className="flex items-center gap-3">
              <div className={`w-9 h-9 rounded-xl bg-sunken border border-border flex items-center justify-center ${color}`}>
                {icon}
              </div>
              <div>
                <p className={`text-xl font-black ${color} leading-none`}>{value ?? 0}</p>
                <p className="text-xs text-muted mt-0.5">{label}</p>
              </div>
            </div>
          ))}
        </div>

        {/* Cloud-Based Databases */}
        <div className="flex items-center gap-3 mt-12 mb-7">
          <h2 className="text-[18px] font-black text-fg">Cloud-Based Databases</h2>
          <div className="flex-1 h-px bg-border"/>
          <span className="text-xs text-muted font-medium">{CLOUD_TECH_CONFIG.length} technologies · more coming soon</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {CLOUD_TECH_CONFIG.map((tech) => (
            <button
              key={tech.id}
              type="button"
              disabled={!tech.available}
              onClick={() => tech.available && navigate('/cosmosdb-servers')}
              className={`group relative bg-surface rounded-2xl border-2 p-6 text-left transition-all duration-200 ${
                tech.available
                  ? `border-border shadow-md hover:shadow-xl hover:-translate-y-1 ${tech.border ? `hover:${tech.border}` : ''}`
                  : 'border-border opacity-60 cursor-not-allowed'}`}
            >
              <div className="flex items-start gap-4">
                <div className={`w-14 h-14 rounded-2xl flex items-center justify-center flex-shrink-0 shadow-lg ${tech.accent || 'bg-gradient-to-br from-slate-300 to-slate-400'}`}>
                  <span className="text-2xl select-none">{tech.emoji}</span>
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="text-[17px] font-black text-fg leading-tight">{tech.name}</h3>
                  <p className="text-xs text-muted mt-0.5 font-medium">{tech.subtitle}</p>
                  {tech.available && (
                    <div className="flex items-center gap-3 mt-3 flex-wrap">
                      <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg ${tech.lightBg} ${tech.border} border`}>
                        <Database size={11} className={tech.text}/>
                        <span className={`text-[12px] font-black ${tech.text}`}>{cosmosCount}</span>
                        <span className={`text-[10px] ${tech.text} opacity-70`}>connections</span>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <div className="flex items-center justify-between mt-5 pt-4 border-t border-border">
                {tech.available ? (
                  <span className={`text-[12px] font-bold ${tech.text}`}>
                    {cosmosCount > 0 ? `Explore ${cosmosCount} connection${cosmosCount !== 1 ? 's' : ''}` : 'No connections yet · click to add'}
                  </span>
                ) : (
                  <span className="text-[11px] font-black text-muted uppercase tracking-wide bg-sunken px-2.5 py-1 rounded-lg">Coming Soon</span>
                )}
                {tech.available && <ChevronRight size={15} className={`${tech.text} group-hover:translate-x-1 transition-transform`}/>}
              </div>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

/* ══════════════════════════════════════════════════════
   PAGE
══════════════════════════════════════════════════════ */
export default function DatabaseServersPage({ tech = null }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { can, canHere } = usePermissions();
  // Only the technologies the user's role can view (hub shows just these).
  const allowedTechs = TECH_CONFIG.filter((t) => can(`/${t.id}-servers`, 'view'));
  // The selected technology is driven by the ROUTE (tech prop), not internal
  // state — so /databases shows the grid and /{tech}-servers shows that tech.
  const selectedTech = tech;
  // Navigate to a technology's server-list route (or back to the grid for null).
  const goToTech = (id) => navigate(id ? `/${id}-servers` : '/databases');
  const [envFilter, setEnvFilter]           = useState('All');
  const [search, setSearch]                 = useState('');
  const [serverView, setServerView]         = useState('grid');   // 'grid' | 'list'
  const [terminalServer, setTerminalServer] = useState(null);
  const [statusFilter, setStatusFilter]     = useState(null); // null | online | warning | offline | clusters (KPI card click)

  const { data: summaryData } = useQuery({
    queryKey: ['serverSummary'],
    queryFn: getServerSummary,
    refetchInterval: 30000,
  });

  const { data: serversData, isLoading } = useQuery({
    queryKey: ['osServers', envFilter],
    queryFn: () => listOsServers(envFilter !== 'All' ? { environment: envFilter } : {}),
    refetchInterval: 60000,
  });

  const { data: liveData } = useQuery({
    queryKey: ['liveStatus'],
    queryFn: getLiveStatus,
    refetchInterval: 15000,
    staleTime: 10000,
  });

  const { data: allConnections = [] } = useQuery({
    queryKey: ['allConnections'],
    queryFn: async () => {
      const types = ['mysql', 'postgresql', 'oracle', 'mssql', 'mongodb', 'clickhouse'];
      const results = await Promise.allSettled(types.map((t) => listConnections(t)));
      return results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
    },
    staleTime: 60000,
  });

  const { data: cosmosConnections = [] } = useQuery({
    queryKey: ['cosmosdbConnections'],
    queryFn: () => listConnections('cosmosdb'),
    staleTime: 60000,
  });

  // Same countdown-pill header refresh as Agents/Dashboard/Infrastructure/
  // Alerts. This page has no single polling interval (30s/60s/15s across its
  // four queries) — 15s (liveData, the source of the "N/M online" badge) is
  // the one shown, and a manual refresh invalidates all four at once rather
  // than waiting out whichever interval is slowest.
  const REFRESH_SECONDS = 15;
  const [countdown, setCountdown] = useState(REFRESH_SECONDS);
  useEffect(() => {
    const t = setInterval(() => setCountdown((c) => (c <= 1 ? REFRESH_SECONDS : c - 1)), 1000);
    return () => clearInterval(t);
  }, []);
  // Three separate calls, not chained with `||` — that would short-circuit
  // and skip later hooks once an earlier one returns truthy, which is a
  // conditional hook call (exactly the crash this once caused).
  const fetchingSummary = useIsFetching({ queryKey: ['serverSummary'] });
  const fetchingServers = useIsFetching({ queryKey: ['osServers'] });
  const fetchingLive = useIsFetching({ queryKey: ['liveStatus'] });
  const isFetchingAny = fetchingSummary || fetchingServers || fetchingLive;
  const refreshNow = () => {
    qc.invalidateQueries({ queryKey: ['serverSummary'] });
    qc.invalidateQueries({ queryKey: ['osServers'] });
    qc.invalidateQueries({ queryKey: ['liveStatus'] });
    qc.invalidateQueries({ queryKey: ['allConnections'] });
    qc.invalidateQueries({ queryKey: ['cosmosdbConnections'] });
    setCountdown(REFRESH_SECONDS);
  };

  const refreshMutation = useMutation({
    mutationFn: refreshServerStatus,
    onSuccess: () => qc.invalidateQueries(['osServers']),
  });
  const deleteMutation = useMutation({
    mutationFn: deleteOsServer,
    onSuccess: () => { qc.invalidateQueries(['osServers']); qc.invalidateQueries(['serverSummary']); },
  });

  const liveMap = {};
  for (const r of (liveData?.data || [])) liveMap[r.id] = r;

  const mergeNode = (s) => {
    const live = liveMap[s.id];
    if (!live) return s;
    const mergedInstances = (s.db_instances || []).map(inst => ({
      ...inst,
      status: live.db_services?.[inst.db_type] || inst.status,
    }));
    for (const [svc, st] of Object.entries(live.db_services || {})) {
      if (!mergedInstances.find(i => i.db_type === svc)) {
        mergedInstances.push({ db_type: svc, port: null, status: st });
      }
    }
    return { ...s, status: live.os_status, db_status: live.db_status, db_instances: mergedInstances };
  };

  const allServers = (serversData?.data || []).map(mergeNode);

  const techCounts = TECH_CONFIG.reduce((acc, t) => {
    acc[t.id] = {
      servers:     allServers.filter(s => serverMatchesTech(s, t.id)).length,
      connections: allConnections.filter(c => connMatchesTech(c, t.id)).length,
    };
    return acc;
  }, {});

  const summary = summaryData || { total:0, connected:0, warning:0, disconnected:0, clusters:0 };
  const healthPct = summary.total > 0 ? Math.round((summary.connected / summary.total) * 100) : 0;

  if (isLoading) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <div className="text-center">
          <div className="w-16 h-16 border-4 border-indigo-900 border-t-indigo-400 rounded-full animate-spin mx-auto mb-4"/>
          <p className="text-slate-400 font-semibold">Loading infrastructure…</p>
        </div>
      </div>
    );
  }

  /* ── Tech selector (default landing) ─────────────── */
  if (!selectedTech) {
    return (
      <TechSelectorScreen
        techCounts={techCounts}
        summary={summary}
        onSelect={goToTech}
        navigate={navigate}
        techs={allowedTechs}
        canAdd={canHere('add')}
        cosmosCount={cosmosConnections.length}
        countdown={countdown}
        onRefresh={refreshNow}
        refreshing={!!isFetchingAny}
      />
    );
  }

  /* ── Filtered view for selected technology ────────── */
  const techConfig = TECH_CONFIG.find(t => t.id === selectedTech) || TECH_CONFIG[0];

  const servers = allServers
    .filter(s => serverMatchesTech(s, selectedTech))
    .filter(s =>
      !search ||
      s.server_name.toLowerCase().includes(search.toLowerCase()) ||
      s.ip_address.includes(search)
    );

  // ── Tech-specific counts (only THIS technology's servers, not the global 11) ──
  const isOnline  = (s) => s.status === 'Connected';
  const isWarning = (s) => s.status === 'Warning';
  const isOffline = (s) => s.status !== 'Connected' && s.status !== 'Warning';
  const isClustered = (s) => s.node_type !== 'Standalone' && !!s.cluster_name;
  const techSummary = {
    total:        servers.length,
    connected:    servers.filter(isOnline).length,
    warning:      servers.filter(isWarning).length,
    disconnected: servers.filter(isOffline).length,
    clusters:     new Set(servers.filter(isClustered).map((s) => s.cluster_name)).size,
  };
  const techHealthPct = techSummary.total > 0 ? Math.round((techSummary.connected / techSummary.total) * 100) : 0;

  // ── Apply the KPI-card click filter to the displayed servers ──
  const matchesStatus = (s) => {
    if (!statusFilter) return true;
    if (statusFilter === 'online')   return isOnline(s);
    if (statusFilter === 'warning')  return isWarning(s);
    if (statusFilter === 'offline')  return isOffline(s);
    if (statusFilter === 'clusters') return isClustered(s);
    return true;
  };
  const shownServers = servers.filter(matchesStatus);

  const clusterMap = {};
  const standaloneList = [];
  for (const s of shownServers) {
    if (s.node_type !== 'Standalone' && s.cluster_name) {
      (clusterMap[s.cluster_name] = clusterMap[s.cluster_name] || []).push(s);
    } else {
      standaloneList.push(s);
    }
  }


  return (
    <>
      <PageHeader
        title={`${techConfig.name} Servers`}
        /* The engine's own mark, as the original hero showed — emoji on a tile
           tinted with that engine's validated slot colour. */
        leading={(
          <span
            className="grid h-10 w-10 shrink-0 place-items-center rounded-md text-[20px]"
            style={{ background: `color-mix(in srgb, ${engineColor(techConfig.name)} 16%, transparent)` }}
          >
            {techConfig.emoji}
          </span>
        )}
        description={`${servers.length} server${servers.length !== 1 ? 's' : ''} · ${techConfig.subtitle}`}
        actions={(
          <div className="flex items-center gap-2">
            <button
              onClick={() => goToTech(null)}
              title="Back to technologies"
              className="flex h-control shrink-0 items-center gap-1.5 rounded-control border border-border px-2.5 text-[12px] font-semibold text-muted transition-colors hover:bg-sunken hover:text-fg"
            >
              <ChevronLeft size={14} /> Technologies
            </button>
            <OnlineBadge connected={techSummary.connected} total={techSummary.total} pct={techHealthPct} />
            {canHere('add') && (
              <button
                onClick={() => navigate('/databases/add-os-server')}
                className="flex h-control shrink-0 items-center gap-1.5 rounded-control bg-accent px-3.5 text-[13px] font-semibold text-accent-fg transition-colors hover:bg-accent-hover"
              >
                <Plus size={15} /> Add Server
              </button>
            )}
          </div>
        )}
      />

      {/* ══════════════════ CONTENT ══════════════════ */}
      <div className="mx-auto w-full">

        {/* KPI cards — show THIS technology's counts; click to filter the list below */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
          {[
            { key:null,        icon:<Server size={18}/>,        label:'Total',    value:techSummary.total,        sub:'servers',        iconBg:'bg-slate-100',   iconColor:'text-slate-500',   valueColor:'text-slate-800',   ring:'ring-slate-300' },
            { key:'online',    icon:<CheckCircle2 size={18}/>,  label:'Online',   value:techSummary.connected,    sub:'connected now',  iconBg:'bg-emerald-50',  iconColor:'text-emerald-500', valueColor:'text-emerald-600', ring:'ring-emerald-300' },
            { key:'warning',   icon:<AlertTriangle size={18}/>, label:'Warning',  value:techSummary.warning,      sub:'need attention', iconBg:'bg-amber-50',    iconColor:'text-amber-500',   valueColor:'text-amber-600',   ring:'ring-amber-300' },
            { key:'offline',   icon:<XCircle size={18}/>,       label:'Offline',  value:techSummary.disconnected, sub:'unreachable',    iconBg:'bg-red-50',      iconColor:'text-red-500',     valueColor:'text-red-600',     ring:'ring-red-300' },
            { key:'clusters',  icon:<GitBranch size={18}/>,     label:'Clusters', value:techSummary.clusters,     sub:'HA groups',      iconBg:'bg-blue-50',     iconColor:'text-blue-500',    valueColor:'text-blue-600',    ring:'ring-blue-300' },
          ].map(({ key, icon, label, value, sub, iconBg, iconColor, valueColor, ring }) => {
            const active = statusFilter === key && key !== null ? true : (key === null && statusFilter === null);
            return (
              <button key={label} type="button"
                onClick={() => setStatusFilter((prev) => (key === null ? null : (prev === key ? null : key)))}
                className={`text-left bg-white rounded-2xl border shadow-sm px-4 py-3.5 flex items-center gap-3 transition-all hover:shadow-md hover:-translate-y-0.5 ${
                  active ? `border-transparent ring-2 ${ring}` : 'border-slate-200'}`}>
                <div className={`w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0 ${iconBg} ${iconColor}`}>
                  {icon}
                </div>
                <div className="min-w-0">
                  <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wide">{label}</p>
                  <p className={`text-2xl font-black leading-none ${valueColor}`}>{value ?? 0}</p>
                  <p className="text-[10px] text-slate-400 mt-0.5 truncate">{sub}</p>
                </div>
              </button>
            );
          })}
        </div>

        {/* active filter indicator */}
        {statusFilter && (
          <div className="flex items-center gap-2 mb-4 -mt-2">
            <span className="text-xs text-slate-500">Filtered by <b className="text-slate-700 capitalize">{statusFilter}</b> · {shownServers.length} of {servers.length}</span>
            <button onClick={() => setStatusFilter(null)} className="text-xs font-bold text-blue-600 hover:text-blue-700">Clear</button>
          </div>
        )}

        {/* filter + search + tech switcher */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm px-4 py-3 flex flex-wrap items-center gap-2 mb-6">
          <div className="flex items-center gap-1 flex-wrap">
            {ENV_FILTERS.map((env) => (
              <button key={env} onClick={() => setEnvFilter(env)}
                className={`h-7 px-3.5 rounded-lg font-bold text-[11px] transition-all ${envFilter===env
                  ? 'bg-slate-900 text-white shadow'
                  : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800'}`}>
                {env}
              </button>
            ))}
          </div>

          {/* tech switcher pills */}
          <div className="flex items-center gap-1 ml-2 pl-2 border-l border-slate-200 flex-wrap">
            {allowedTechs.map(t => (
              <button
                key={t.id}
                onClick={() => { setSearch(''); goToTech(t.id); }}
                className={`h-7 px-3 rounded-lg text-[11px] font-bold transition-all flex items-center gap-1.5 ${
                  t.id === selectedTech
                    ? `${t.accent} text-white shadow`
                    : `${t.lightBg} ${t.text} border ${t.border} hover:opacity-80`
                }`}
              >
                <span>{t.emoji}</span>
                <span className="hidden sm:inline">{t.name}</span>
              </button>
            ))}
          </div>

          <div className="ml-auto flex items-center gap-2">
            <div className="relative">
              <Search size={12} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"/>
              <input value={search} onChange={(e) => setSearch(e.target.value)}
                placeholder="Search server or IP…"
                className="h-8 pl-8 pr-9 rounded-xl border border-slate-200 text-[12px] outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-50 w-56 transition-all"/>
              {search && (
                <button onClick={() => setSearch('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-300 hover:text-slate-500">
                  <X size={11}/>
                </button>
              )}
            </div>
            <div className="flex bg-slate-100 rounded-xl p-0.5">
              {[['grid', LayoutGrid], ['list', List]].map(([v, Ico]) => (
                <button key={v} onClick={() => setServerView(v)} title={`${v} view`}
                  className={`h-8 w-9 rounded-lg flex items-center justify-center transition-all ${serverView === v ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}>
                  <Ico size={15}/>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* empty state */}
        {servers.length === 0 && (
          <div className="bg-white rounded-2xl border border-dashed border-slate-300 p-20 text-center">
            <div className={`w-20 h-20 rounded-3xl ${techConfig.lightBg} flex items-center justify-center mx-auto mb-5`}>
              <span className="text-4xl">{techConfig.emoji}</span>
            </div>
            <h2 className="text-xl font-black text-slate-700 mb-2">
              {search ? `No ${techConfig.name} servers matching "${search}"` : `No ${techConfig.name} servers yet`}
            </h2>
            <p className="text-slate-400 text-sm mb-6">
              {search ? 'Try a different search term.' : `Add a server with ${techConfig.name} installed to start monitoring.`}
            </p>
            {!search && canHere('add') && (
              <button onClick={() => navigate('/databases/add-os-server')}
                className="h-10 px-6 rounded-xl bg-slate-900 text-white font-bold text-sm hover:bg-slate-700 shadow transition-all">
                + Add OS Server
              </button>
            )}
          </div>
        )}

        {/* ── CLUSTER TOPOLOGY ── */}
        {Object.keys(clusterMap).length > 0 && (
          <section className="mb-8">
            <div className="flex items-center gap-3 mb-4">
              <div className="flex items-center gap-2">
                <div className="w-1 h-5 rounded-full bg-indigo-500"/>
                <h2 className="text-[15px] font-black text-slate-900 uppercase tracking-wide">Cluster Topology</h2>
              </div>
              <span className="px-2.5 py-0.5 rounded-full bg-indigo-100 text-indigo-700 text-[11px] font-black">
                {Object.keys(clusterMap).length} cluster{Object.keys(clusterMap).length>1?'s':''}
              </span>
            </div>

            <div className="space-y-5">
              {Object.entries(clusterMap).map(([clusterName, rawNodes]) => {
                const nodes   = sortNodes(rawNodes);
                const galera  = isGalera(nodes);
                const allOk   = nodes.every((n) => n.status === 'Connected');
                const anyWarn = nodes.some((n) => n.status === 'Warning');
                const status  = allOk ? 'HEALTHY' : anyWarn ? 'WARNING' : 'DEGRADED';
                const dbTypes = [...new Set(nodes.flatMap((n) => n.database_services || []))];
                const avgs    = clusterAverages(nodes);

                return (
                  <div key={clusterName} className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                    <div className={`px-6 py-4 border-b flex flex-wrap items-center justify-between gap-3 ${
                      status==='HEALTHY'?'border-b-slate-100 bg-gradient-to-r from-emerald-50/40 to-white':
                      status==='WARNING'?'border-b-amber-100 bg-gradient-to-r from-amber-50/40 to-white':
                      'border-b-red-100 bg-gradient-to-r from-red-50/30 to-white'}`}>
                      <div className="flex items-center gap-3 flex-wrap">
                        <div className="flex items-center gap-2.5">
                          <div className={`w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 ${galera?'bg-purple-100':'bg-indigo-100'}`}>
                            <GitBranch size={17} className={galera?'text-purple-600':'text-indigo-600'}/>
                          </div>
                          <div>
                            <h3 className="text-base font-black text-slate-900 leading-none">{clusterName}</h3>
                            <div className="flex items-center gap-2 mt-0.5">
                              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${galera?'bg-purple-100 text-purple-700':'bg-indigo-100 text-indigo-700'}`}>
                                {galera ? 'Galera Multi-Primary' : 'Streaming Replication'}
                              </span>
                              <span className="text-slate-400 text-[10px]">{nodes[0]?.environment}</span>
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-slate-400 text-[11px] flex items-center gap-1">
                            <Layers size={10}/> {nodes.length} nodes
                          </span>
                          {dbTypes.map((d) => (
                            <span key={d} className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${dbColor(d)}`}>{d}</span>
                          ))}
                        </div>
                      </div>

                      <div className="flex items-center gap-3">
                        <div className="hidden lg:flex items-center gap-4 bg-slate-50 border border-slate-100 rounded-xl px-4 py-2">
                          {[
                            { label:'CPU', val:avgs.cpu,  color:'text-orange-600' },
                            { label:'RAM', val:avgs.ram,  color:'text-purple-600' },
                            { label:'Disk',val:avgs.disk, color:'text-blue-600'   },
                          ].map(({ label, val, color }) => (
                            <div key={label} className="text-center">
                              <p className="text-[9px] text-slate-400 font-bold uppercase">{label}</p>
                              <p className={`text-[13px] font-black ${color}`}>{val!==null ? `${val}%` : '—'}</p>
                            </div>
                          ))}
                        </div>
                        <span className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[11px] font-black ${
                          status==='HEALTHY' ?'bg-emerald-100 text-emerald-700':
                          status==='WARNING' ?'bg-amber-100 text-amber-700':'bg-red-100 text-red-700'}`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${status==='HEALTHY'?'bg-emerald-500 animate-pulse':status==='WARNING'?'bg-amber-500':'bg-red-500'}`}/>
                          {status}
                        </span>
                      </div>
                    </div>

                    <div className="px-6 py-6 overflow-x-auto">
                      {galera
                        ? <GaleraTopology nodes={nodes} navigate={navigate} openTerminal={setTerminalServer} refreshMutation={refreshMutation} allConnections={allConnections} tech={selectedTech}/>
                        : <ReplicationTopology nodes={nodes} navigate={navigate} openTerminal={setTerminalServer} refreshMutation={refreshMutation} allConnections={allConnections} tech={selectedTech}/>
                      }
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* ── STANDALONE SERVERS ── */}
        {standaloneList.length > 0 && (
          <section className="mb-8">
            <div className="flex items-center gap-3 mb-4">
              <div className="flex items-center gap-2">
                <div className="w-1 h-5 rounded-full bg-slate-400"/>
                <h2 className="text-[15px] font-black text-slate-900 uppercase tracking-wide">Standalone Servers</h2>
              </div>
              <span className="px-2.5 py-0.5 rounded-full bg-slate-100 text-slate-600 text-[11px] font-black">
                {standaloneList.length} server{standaloneList.length>1?'s':''}
              </span>
            </div>
            {serverView === 'list' ? (
              <ServerTable
                servers={standaloneList}
                navigate={navigate}
                openTerminal={setTerminalServer}
                refreshMutation={refreshMutation}
                allConnections={allConnections}
                tech={selectedTech}
                onDeleteServer={(server) => { if (confirm(`Delete "${server.server_name}"?`)) deleteMutation.mutate(server.id); }}
              />
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {standaloneList.map((server) => (
                  <TopologyNodeCard
                    key={server.id}
                    node={server}
                    navigate={navigate}
                    openTerminal={setTerminalServer}
                    refreshMutation={refreshMutation}
                    allConnections={allConnections}
                    tech={selectedTech}
                    onDelete={() => { if (confirm(`Delete "${server.server_name}"?`)) deleteMutation.mutate(server.id); }}
                    showMetricsInline
                  />
                ))}
              </div>
            )}
          </section>
        )}

        {/* legend */}
        <div className="bg-white rounded-xl border border-slate-100 px-5 py-3 flex flex-wrap gap-5 text-[11px] text-slate-500">
          <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest self-center">Legend</span>
          {[
            ['bg-emerald-500 animate-pulse','Connected'],
            ['bg-amber-500','Warning'],
            ['bg-red-500','Offline'],
            ['bg-emerald-500','Primary / Master'],
            ['bg-blue-500','Secondary / Replica'],
            ['bg-purple-500','Galera Node'],
          ].map(([cls,label]) => (
            <span key={label} className="flex items-center gap-1.5">
              <span className={`w-2 h-2 rounded-full inline-block ${cls}`}/>{label}
            </span>
          ))}
        </div>
      </div>

      {terminalServer && (
        <TerminalWindow server={terminalServer} onClose={() => setTerminalServer(null)}/>
      )}
    </>
  );
}

/* ══════════════════════════════════════════════════════
   REPLICATION TOPOLOGY
══════════════════════════════════════════════════════ */
function ReplicationTopology({ nodes, navigate, openTerminal, refreshMutation, allConnections=[], tech=null }) {
  const primary     = nodes.filter((n)=>n.node_type==='Primary'||n.node_type==='Master');
  const secondaries = nodes.filter((n)=>!['Primary','Master'].includes(n.node_type));
  const ordered     = [...primary, ...secondaries];

  return (
    <div className="flex items-stretch justify-center gap-0 flex-wrap md:flex-nowrap">
      {ordered.map((node, idx) => (
        <React.Fragment key={node.id}>
          <div className="flex-shrink-0 w-[296px]">
            <TopologyNodeCard node={node} navigate={navigate} openTerminal={openTerminal} refreshMutation={refreshMutation} allConnections={allConnections} tech={tech} fullWidth/>
          </div>
          {idx < ordered.length-1 && (
            <div className="flex flex-col items-center justify-center px-2 flex-shrink-0 self-center">
              <div className="flex flex-col items-center gap-1.5">
                <div className="w-px h-4 bg-slate-200"/>
                <div className="relative w-8 h-8 rounded-full border-2 border-dashed border-blue-300 bg-blue-50 flex items-center justify-center">
                  <ArrowRight size={13} className="text-blue-400"/>
                  <span className="absolute -bottom-4 left-1/2 -translate-x-1/2 text-[8px] font-bold text-slate-400 whitespace-nowrap">stream</span>
                </div>
                <div className="w-px h-7 bg-slate-200"/>
              </div>
            </div>
          )}
        </React.Fragment>
      ))}
    </div>
  );
}

/* ══════════════════════════════════════════════════════
   GALERA TOPOLOGY
══════════════════════════════════════════════════════ */
function GaleraTopology({ nodes, navigate, openTerminal, refreshMutation, allConnections=[], tech=null }) {
  return (
    <div>
      <div className="flex justify-center mb-5">
        <div className="flex items-center gap-2 px-4 py-1.5 rounded-full bg-purple-50 border border-purple-200">
          <Network size={12} className="text-purple-500"/>
          <span className="text-[11px] font-bold text-purple-700">Multi-Primary · All nodes accept writes · wsrep sync replication</span>
        </div>
      </div>
      <div className="flex items-stretch justify-center gap-0 flex-wrap md:flex-nowrap">
        {nodes.map((node, idx) => (
          <React.Fragment key={node.id}>
            <div className="flex-shrink-0 w-[296px]">
              <TopologyNodeCard node={node} navigate={navigate} openTerminal={openTerminal} refreshMutation={refreshMutation} allConnections={allConnections} tech={tech} fullWidth/>
            </div>
            {idx < nodes.length-1 && (
              <div className="flex flex-col items-center justify-center px-2 flex-shrink-0 self-center">
                <div className="flex flex-col items-center gap-1.5">
                  <div className="w-px h-4 bg-purple-100"/>
                  <div className="w-8 h-8 rounded-full border-2 border-purple-300 bg-purple-50 flex items-center justify-center shadow-sm">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5 text-purple-500">
                      <path d="M7 16V4m0 0L3 8m4-4 4 4M17 8v12m0 0 4-4m-4 4-4-4"/>
                    </svg>
                  </div>
                  <div className="w-px h-7 bg-purple-100"/>
                </div>
              </div>
            )}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════
   SERVER TABLE — proper tabular list view (list-mode toggle)
══════════════════════════════════════════════════════ */
const ROW_ACCENTS = [
  'from-indigo-500 to-blue-600', 'from-rose-500 to-pink-600', 'from-emerald-500 to-teal-600',
  'from-amber-500 to-orange-600', 'from-violet-500 to-purple-600', 'from-cyan-500 to-sky-600',
];
const rowInitials = (s) => {
  const str = String(s ?? '').trim();
  if (!str) return '#';
  const w = str.split(/\s+/);
  return ((w[0][0] || '') + (w[1]?.[0] || (w[0][1] || ''))).toUpperCase();
};

function ServerTable({ servers, navigate, openTerminal, refreshMutation, allConnections = [], tech = null, onDeleteServer }) {
  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200">
              <th className="text-left px-4 py-3.5 text-[13px] font-bold text-slate-700 whitespace-nowrap">Server</th>
              <th className="text-left px-4 py-3.5 text-[13px] font-bold text-slate-700 whitespace-nowrap">Host / OS</th>
              <th className="text-left px-4 py-3.5 text-[13px] font-bold text-slate-700 whitespace-nowrap">OS Status</th>
              <th className="text-left px-4 py-3.5 text-[13px] font-bold text-slate-700 whitespace-nowrap">DB Status</th>
              <th className="text-left px-4 py-3.5 text-[13px] font-bold text-slate-700 whitespace-nowrap">Resources</th>
              <th className="text-left px-4 py-3.5 text-[13px] font-bold text-slate-700 whitespace-nowrap">Uptime</th>
              <th className="px-4 py-3.5 text-right text-[13px] font-bold text-slate-700 whitespace-nowrap">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {servers.map((node, i) => (
              <ServerTableRow key={node.id} node={node} idx={i} navigate={navigate} openTerminal={openTerminal}
                refreshMutation={refreshMutation} allConnections={allConnections} tech={tech}
                onDelete={() => onDeleteServer(node)} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ServerTableRow({ node, idx, navigate, openTerminal, refreshMutation, allConnections = [], tech = null, onDelete }) {
  const isRefreshing = refreshMutation.isPending && refreshMutation.variables === node.id;
  const want = tech ? normDb(tech) : null;
  const linkedInst = want
    ? (node.db_instances || []).find((i) => i.connection_id && normDb(i.db_type) === want)
    : (node.db_instances || []).find((i) => i.connection_id);
  const conn = (linkedInst && allConnections.find((c) => c.id === linkedInst.connection_id))
    || findConn(allConnections, node, tech);

  const osUp   = node.status === 'Connected';
  const osWarn = node.status === 'Warning';
  const osDown = node.status === 'Disconnected';

  const dbStatus   = (want && linkedInst) ? (linkedInst.status || 'Unknown') : (node.db_status || 'Unknown');
  const dbUp       = dbStatus === 'Running';
  const dbDegraded = dbStatus === 'Degraded';
  const dbDown     = dbStatus === 'Stopped';

  const accent = ROW_ACCENTS[idx % ROW_ACCENTS.length];
  const connected = conn || linkedInst;
  const openLabel = serverTargetLabel({ conn, linkedInst, dbUp });
  const onOpenDashboard = () => navigate(serverTarget({ node, conn, linkedInst, want, dbUp }));

  const metrics = [
    { label: 'CPU', val: node.cpu_usage },
    { label: 'RAM', val: node.ram_usage },
    { label: 'Disk', val: node.disk_usage },
  ];

  return (
    // The whole row opens the server, not just its button.
    <tr
      onClick={onOpenDashboard}
      title={`${openLabel} — ${conn?.connection_name || node.server_name}`}
      className="hover:bg-slate-50/70 transition-colors cursor-pointer"
    >
      <td className="px-4 py-3 align-middle">
        <span className="inline-flex items-center gap-2.5 min-w-0">
          <span className={`w-8 h-8 rounded-lg bg-gradient-to-br ${accent} flex items-center justify-center text-white font-black text-[11px] shadow ring-2 ring-white flex-shrink-0`}>
            {rowInitials(conn?.connection_name || node.server_name)}
          </span>
          <span className="min-w-0">
            <span className="block font-bold text-slate-800 truncate max-w-[180px]">{conn?.connection_name || node.server_name}</span>
            {conn?.connection_name && conn.connection_name !== node.server_name && (
              <span className="block text-[11px] text-slate-400 truncate max-w-[180px]">{node.server_name}</span>
            )}
          </span>
        </span>
      </td>
      <td className="px-4 py-3 align-middle whitespace-nowrap">
        <span className="font-mono text-[12px] text-slate-600 font-semibold">{node.ip_address}</span>
        {node.os_type && <span className="ml-2 px-1.5 py-0.5 bg-slate-100 text-slate-500 text-[10px] font-bold rounded-md">{node.os_type}</span>}
      </td>
      <td className="px-4 py-3 align-middle whitespace-nowrap">
        <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold ${
          osUp ? 'bg-emerald-50 text-emerald-700' : osWarn ? 'bg-amber-50 text-amber-700' : osDown ? 'bg-red-50 text-red-600' : 'bg-slate-100 text-slate-500'}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${osUp ? 'bg-emerald-500' : osWarn ? 'bg-amber-500' : osDown ? 'bg-red-500' : 'bg-slate-400'}`} />
          {osUp ? 'Online' : osDown ? 'Offline' : node.status || 'Unknown'}
        </span>
      </td>
      <td className="px-4 py-3 align-middle whitespace-nowrap">
        <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold ${
          dbUp ? 'bg-emerald-50 text-emerald-700' : dbDegraded ? 'bg-amber-50 text-amber-700' : dbDown ? 'bg-red-50 text-red-600' : 'bg-slate-100 text-slate-500'}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${dbUp ? 'bg-emerald-500 animate-pulse' : dbDegraded ? 'bg-amber-500' : dbDown ? 'bg-red-500' : 'bg-slate-400'}`} />
          {dbUp ? 'Running' : dbDown ? 'Stopped' : dbDegraded ? 'Degraded' : 'Unknown'}
        </span>
      </td>
      <td className="px-4 py-3 align-middle">
        <div className="flex items-center gap-3 min-w-[180px]">
          {metrics.map(({ label, val }) => {
            const pct = parseFloat(val) || 0;
            const barColor = pct > 85 ? 'bg-red-500' : pct > 65 ? 'bg-amber-400' : 'bg-emerald-500';
            return (
              <div key={label} className="flex-1" title={`${label}: ${val || '—'}`}>
                <div className="flex justify-between mb-0.5">
                  <span className="text-[9px] font-bold text-slate-400 uppercase">{label}</span>
                  <span className="text-[9px] font-black text-slate-600">{val || '—'}</span>
                </div>
                <div className="h-1 rounded-full bg-slate-200 overflow-hidden">
                  {val && <div className={`h-full rounded-full ${barColor}`} style={{ width: `${Math.min(pct, 100)}%` }} />}
                </div>
              </div>
            );
          })}
        </div>
      </td>
      <td className="px-4 py-3 align-middle whitespace-nowrap text-slate-500 text-[12px] font-semibold">{node.uptime || '—'}</td>
      {/* Actions do their own thing — they must not also trigger the row. */}
      <td className="px-4 py-3 align-middle" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-end gap-1.5">
          <button onClick={() => openTerminal(node)} title="Open SSH Terminal"
            className="h-9 px-3 rounded-xl bg-slate-800 hover:bg-indigo-700 text-white text-[11px] font-bold flex items-center gap-1.5 transition-all">
            <Terminal size={12} />SSH
          </button>
          <button onClick={onOpenDashboard} title={openLabel}
            className={`h-9 w-9 rounded-xl border flex items-center justify-center transition-all ${
              connected ? 'border-slate-200 text-slate-600 hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-600'
                        : 'border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100'}`}>
            {connected ? (dbUp ? <Activity size={15} /> : <Stethoscope size={15} />) : <Plus size={15} />}
          </button>
          <button onClick={() => refreshMutation.mutate(node.id)} title="Deep refresh (SSH)"
            className={`h-9 w-9 rounded-xl border flex items-center justify-center transition-all ${
              isRefreshing ? 'border-indigo-300 bg-indigo-50 text-indigo-500' : 'border-slate-200 hover:border-indigo-300 hover:bg-indigo-50 text-slate-400 hover:text-indigo-500'}`}>
            <RefreshCw size={13} className={isRefreshing ? 'animate-spin' : ''} />
          </button>
          <button onClick={onDelete} title="Delete"
            className="h-9 w-9 rounded-xl border border-red-100 text-red-400 hover:bg-red-50 hover:border-red-200 flex items-center justify-center transition-all">
            <Trash2 size={13} />
          </button>
        </div>
      </td>
    </tr>
  );
}

/* ══════════════════════════════════════════════════════
   NODE CARD — uniform height via h-full + flex-col
══════════════════════════════════════════════════════ */
function TopologyNodeCard({ node, navigate, openTerminal, refreshMutation, allConnections=[], onDelete, showMetricsInline=false, fullWidth=false, tech=null, connectionOnly=false }) {
  const [hovered, setHovered] = useState(false);
  const m = nodeMeta(node.node_type);
  const hasMetrics = node.cpu_usage || node.ram_usage || node.disk_usage;
  const isRefreshing = refreshMutation.isPending && refreshMutation.variables === node.id;
  // A DB instance may carry a linked connection_id (agent-registered DBs) — that IS the
  // dashboard. On a host running MULTIPLE engines, resolve to the one for THIS tab's tech
  // (else the PostgreSQL tab would open the MySQL dashboard, and vice-versa).
  const want = tech ? normDb(tech) : null;
  const linkedInst = want
    ? (node.db_instances || []).find((i) => i.connection_id && normDb(i.db_type) === want)
    : (node.db_instances || []).find((i) => i.connection_id);
  const conn = (linkedInst && allConnections.find((c) => c.id === linkedInst.connection_id))
    || findConn(allConnections, node, tech);

  const osUp   = node.status === 'Connected';
  const osWarn = node.status === 'Warning';
  const osDown = node.status === 'Disconnected';

  // Database-specific status: on a per-engine tab, show ONLY that engine's DB
  // status (never aggregate the host's other databases into "Degraded").
  const dbStatus   = (want && linkedInst) ? (linkedInst.status || 'Unknown') : (node.db_status || 'Unknown');
  const dbUp       = dbStatus === 'Running';
  const dbDegraded = dbStatus === 'Degraded';
  const dbDown     = dbStatus === 'Stopped';

  const borderCls = osDown
    ? 'border-red-100'
    : (dbDown || dbDegraded) ? 'border-amber-200'
    : 'border-slate-200';

  const topBarCls = osDown
    ? 'bg-gradient-to-r from-red-400 to-red-500'
    : dbDown     ? 'bg-gradient-to-r from-amber-400 to-orange-500'
    : dbDegraded ? 'bg-gradient-to-r from-amber-300 to-amber-400'
    : osUp       ? 'bg-gradient-to-r from-emerald-400 to-emerald-500'
    : 'bg-gradient-to-r from-slate-300 to-slate-400';

  const dbInstances = node.db_instances || [];

  // Clicking the card is the same action as its primary button — resolved once,
  // in serverTarget(), so the card, the row and the button always agree.
  const openLabel = serverTargetLabel({ conn, linkedInst, dbUp });
  const onOpen = () => navigate(serverTarget({ node, conn, linkedInst, want, dbUp }));

  return (
    <div
      onClick={onOpen}
      title={`${openLabel} — ${conn?.connection_name || node.server_name}`}
      className={`relative rounded-2xl border bg-white transition-all duration-200 h-full flex flex-col cursor-pointer
        ${hovered ? 'shadow-xl -translate-y-1' : 'shadow-md'}
        ${borderCls}
        ${fullWidth ? 'w-full' : ''}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className={`h-1.5 w-full rounded-t-2xl flex-shrink-0 ${topBarCls}`}/>

      <div className="p-5 flex flex-col flex-1">
        {/* top row: role badge + live dots */}
        <div className="flex items-center justify-between mb-4">
          <span className={`px-2.5 py-1 rounded-lg text-[11px] font-black tracking-wider uppercase ${m.text} ${m.bg} shadow-sm`}>
            {m.label}
          </span>
          <div className="flex items-center gap-3">
            {!connectionOnly && (
              <div className="flex flex-col items-center gap-0.5" title={`OS: ${node.status||'Unknown'}`}>
                <PulsingDot status={node.status}/>
                <span className={`text-[9px] font-black ${osUp?'text-emerald-600':osDown?'text-red-500':'text-slate-400'}`}>OS</span>
              </div>
            )}
            <div className="flex flex-col items-center gap-0.5" title={`DB: ${dbStatus}`}>
              <DbDot status={dbStatus}/>
              <span className={`text-[9px] font-black ${dbUp?'text-emerald-600':dbDown?'text-red-500':dbDegraded?'text-amber-500':'text-slate-400'}`}>DB</span>
            </div>
            {!connectionOnly && (
              <button
                onClick={(e) => { e.stopPropagation(); openTerminal(node); }}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-slate-800 hover:bg-indigo-700 text-white text-[10px] font-bold transition-all shadow-sm hover:shadow-md"
                title="Open SSH Terminal"
              >
                <Terminal size={12}/>SSH
              </button>
            )}
          </div>
        </div>

        {/* connection name (for this tech) + host/IP */}
        <div className="mb-4">
          <h3 className="text-[17px] font-black text-slate-900 leading-tight truncate">{conn?.connection_name || node.server_name}</h3>
          <div className="flex items-center gap-2 mt-1">
            <span className="font-mono text-[12px] text-slate-500 font-semibold">{node.ip_address}</span>
            {node.os_type && (
              <span className="px-1.5 py-0.5 bg-slate-100 text-slate-500 text-[10px] font-bold rounded-md">{node.os_type}</span>
            )}
          </div>
          {conn?.connection_name && conn.connection_name !== node.server_name && (
            <p className="text-[11px] text-slate-400 mt-1 truncate flex items-center gap-1">
              <Server size={10} /> {node.server_name}
            </p>
          )}
        </div>

        {/* DB services — scoped to the current tech tab; a host running several
            engines side by side shouldn't clutter e.g. the MySQL Servers page
            with equally-prominent Oracle/MSSQL/ClickHouse badges. */}
        {node.database_services?.length > 0 && (() => {
          const matched = tech ? node.database_services.filter((svc) => normDb(svc) === normDb(tech)) : node.database_services;
          const others  = tech ? node.database_services.filter((svc) => normDb(svc) !== normDb(tech)) : [];
          return (
            <div className="flex flex-wrap items-center gap-1.5 mb-4">
              {matched.map((svc) => {
                const inst  = dbInstances.find(i => i.db_type === svc);
                const st    = inst?.status || 'Unknown';
                const stDot = st==='Running'?'bg-emerald-500':st==='Stopped'?'bg-red-500':st==='Degraded'?'bg-amber-500':'bg-slate-300';
                return (
                  <span key={svc} className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold border ${dbColor(svc)}`}>
                    <span className={`w-2 h-2 rounded-full flex-shrink-0 ${stDot} ${st==='Running'?'animate-pulse':''}`}/>
                    {svc}
                    {st==='Stopped' && <span className="font-black text-red-600">↓</span>}
                  </span>
                );
              })}
              {others.length > 0 && (
                <span title={`This host also runs: ${others.join(', ')}`}
                  className="px-2.5 py-1 rounded-full text-[11px] font-bold text-slate-400 bg-slate-50 border border-slate-200">
                  +{others.length} other{others.length !== 1 ? 's' : ''} on this host
                </span>
              )}
            </div>
          );
        })()}

        {/* OS + DB status badges */}
        <div className={`grid gap-2 mb-4 ${connectionOnly ? 'grid-cols-1' : 'grid-cols-2'}`}>
          {!connectionOnly && (
          <div className={`flex items-center gap-1.5 px-3 py-2 rounded-xl border text-[11px] font-bold ${
            osUp   ? 'bg-emerald-50 border-emerald-200 text-emerald-700' :
            osWarn ? 'bg-amber-50 border-amber-200 text-amber-700' :
            osDown ? 'bg-red-50 border-red-200 text-red-600' :
            'bg-slate-50 border-slate-200 text-slate-500'}`}>
            <Server size={11}/>
            <span>{osUp?'OS Online':osDown?'OS Offline':node.status||'OS Unknown'}</span>
          </div>
          )}
          <div className={`flex items-center gap-1.5 px-3 py-2 rounded-xl border text-[11px] font-bold ${
            dbUp       ? 'bg-emerald-50 border-emerald-200 text-emerald-700' :
            dbDegraded ? 'bg-amber-50 border-amber-200 text-amber-700' :
            dbDown     ? 'bg-red-50 border-red-200 text-red-600' :
            'bg-slate-50 border-slate-200 text-slate-500'}`}>
            <Database size={11}/>
            <span>{dbUp?'DB Running':dbDown?'DB Stopped':dbDegraded?'Degraded':'DB Unknown'}</span>
          </div>
        </div>

        {/* uptime */}
        {node.uptime && (
          <div className="flex items-center gap-1.5 mb-4 text-slate-400">
            <Clock size={11}/>
            <span className="text-[11px]">{node.uptime}</span>
          </div>
        )}

        {/* inline metrics */}
        {showMetricsInline && hasMetrics && (
          <div className="space-y-1.5 mb-3 p-2.5 bg-slate-50 rounded-xl border border-slate-100">
            {[
              { label:'CPU',  val:node.cpu_usage,  color:'text-orange-600', barBase:'bg-orange-500' },
              { label:'RAM',  val:node.ram_usage,  color:'text-purple-600', barBase:'bg-purple-500' },
              { label:'Disk', val:node.disk_usage, color:'text-blue-600',   barBase:'bg-blue-500'   },
            ].map(({ label, val, color, barBase }) => {
              const pct = parseFloat(val)||0;
              const barColor = pct>85?'bg-red-500':pct>65?'bg-amber-400':barBase;
              return (
                <div key={label}>
                  <div className="flex justify-between mb-0.5">
                    <span className="text-[9px] font-bold text-slate-500 uppercase">{label}</span>
                    <span className={`text-[10px] font-black ${color}`}>{val || (isRefreshing?'…':'—')}</span>
                  </div>
                  <div className="h-1 rounded-full bg-slate-200 overflow-hidden">
                    {val && <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width:`${Math.min(pct,100)}%` }}/>}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* spacer pushes actions to bottom */}
        <div className="flex-1"/>

        {/* actions — each stops the click from also firing the card */}
        <div className="flex gap-2 mt-2" onClick={(e) => e.stopPropagation()}>
          {(() => {
            // Same DB dashboard for SSH AND agent hosts — a linked connection_id IS the dashboard.
            const connected = conn || linkedInst;
            return (
              <button onClick={onOpen}
                className={`flex-1 h-9 rounded-xl text-[12px] font-bold transition-all flex items-center justify-center gap-2 ${
                  connected ? 'bg-slate-900 text-white hover:bg-indigo-600 hover:shadow-lg hover:shadow-indigo-200'
                            : 'bg-indigo-50 text-indigo-700 border border-indigo-200 hover:bg-indigo-100'}`}>
                {connected ? (dbUp ? <><Activity size={12}/>Dashboard</> : <><Stethoscope size={12}/>Diagnose</>) : <><Plus size={12}/>Connect</>}
              </button>
            );
          })()}
          {!connectionOnly && (
            <button
              onClick={() => refreshMutation.mutate(node.id)}
              className={`w-9 h-9 rounded-xl border flex items-center justify-center transition-all
                ${isRefreshing?'border-indigo-300 bg-indigo-50 text-indigo-500':'border-slate-200 hover:border-indigo-300 hover:bg-indigo-50 text-slate-400 hover:text-indigo-500'}`}
              title="Deep refresh (SSH)"
            >
              <RefreshCw size={13} className={isRefreshing?'animate-spin':''}/>
            </button>
          )}
          {onDelete && (
            <button
              onClick={onDelete}
              className="w-9 h-9 rounded-xl border border-red-100 text-red-400 hover:bg-red-50 hover:border-red-200 flex items-center justify-center transition-all"
              title="Delete"
            >
              <Trash2 size={13}/>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════
   MICRO-COMPONENTS
══════════════════════════════════════════════════════ */
function PulsingDot({ status }) {
  if (status==='Connected') return (
    <span className="relative flex h-2.5 w-2.5 flex-shrink-0">
      <span className="animate-ping absolute h-full w-full rounded-full bg-emerald-400 opacity-75"/>
      <span className="relative rounded-full h-2.5 w-2.5 bg-emerald-500"/>
    </span>
  );
  const c = status==='Warning'?'bg-amber-500':status==='Disconnected'?'bg-red-500':'bg-slate-300';
  return <div className={`w-2.5 h-2.5 rounded-full ${c} flex-shrink-0`}/>;
}

function DbDot({ status }) {
  if (status==='Running') return (
    <span className="relative flex h-2.5 w-2.5 flex-shrink-0">
      <span className="animate-ping absolute h-full w-full rounded-full bg-emerald-400 opacity-50"/>
      <span className="relative rounded-full h-2.5 w-2.5 bg-emerald-500"/>
    </span>
  );
  const c = status==='Stopped'?'bg-red-500':status==='Degraded'?'bg-amber-500':'bg-slate-300';
  return <div className={`w-2.5 h-2.5 rounded-full ${c} flex-shrink-0`}/>;
}

/* ══════════════════════════════════════════════════════
   TERMINAL WINDOW — floating, draggable, min/max/close
══════════════════════════════════════════════════════ */
function TerminalWindow({ server, onClose }) {
  const IW = Math.min(980, window.innerWidth  - 60);
  const IH = Math.min(600, window.innerHeight - 60);
  const IX = Math.round((window.innerWidth  - IW) / 2);
  const IY = Math.round((window.innerHeight - IH) / 2);

  const [pos,       setPos]       = useState({ x: IX, y: IY });
  const [size,      setSize]      = useState({ w: IW, h: IH });
  const [minimized, setMinimized] = useState(false);
  const [maximized, setMaximized] = useState(false);

  const savedState = useRef({ pos: { x: IX, y: IY }, size: { w: IW, h: IH } });
  const drag       = useRef({ active: false, ox: 0, oy: 0 });
  const resize     = useRef({ active: false, edge: '', ox: 0, oy: 0, x: 0, y: 0, w: 0, h: 0 });

  useEffect(() => {
    const onMove = (e) => {
      if (drag.current.active) {
        setPos({
          x: Math.max(0, Math.min(e.clientX - drag.current.ox, window.innerWidth  - size.w)),
          y: Math.max(0, Math.min(e.clientY - drag.current.oy, window.innerHeight - 44)),
        });
      }
      if (resize.current.active) {
        const { edge, ox, oy, x, y, w, h } = resize.current;
        const dx = e.clientX - ox, dy = e.clientY - oy;
        let nx=x, ny=y, nw=w, nh=h;
        if (edge.includes('e')) nw = Math.max(520, w + dx);
        if (edge.includes('s')) nh = Math.max(320, h + dy);
        if (edge.includes('w')) { nw = Math.max(520, w - dx); nx = x + w - nw; }
        if (edge.includes('n')) { nh = Math.max(320, h - dy); ny = y + h - nh; }
        setSize({ w: nw, h: nh });
        setPos({ x: nx, y: ny });
      }
    };
    const onUp = () => { drag.current.active = false; resize.current.active = false; };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
    return () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
  }, [size]);

  const onTitleDrag = (e) => {
    if (maximized || e.target.closest('button')) return;
    e.preventDefault();
    drag.current = { active: true, ox: e.clientX - pos.x, oy: e.clientY - pos.y };
  };

  const startResize = (edge) => (e) => {
    e.preventDefault(); e.stopPropagation();
    resize.current = { active: true, edge, ox: e.clientX, oy: e.clientY, ...pos, ...size };
  };

  const toggleMax = () => {
    if (maximized) { setPos(savedState.current.pos); setSize(savedState.current.size); }
    else { savedState.current = { pos: { ...pos }, size: { ...size } }; }
    setMaximized(v => !v);
    setMinimized(false);
  };

  const toggleMin = () => setMinimized(v => !v);

  const wStyle = maximized
    ? { position:'fixed', inset:0, borderRadius:0, border:'none' }
    : { position:'fixed', left:pos.x, top:pos.y, width:size.w, height: minimized ? 'auto' : size.h,
        borderRadius:'10px', border:'1px solid #30363d' };

  const RH = ({ edge, cls }) => (
    <div onMouseDown={startResize(edge)}
      className={`absolute z-10 ${cls}`}
      style={{ cursor:`${edge}-resize` }}/>
  );

  return (
    <div style={{ ...wStyle, zIndex:99999 }}
      className="flex flex-col bg-[#0d1117] shadow-2xl shadow-black/80 overflow-hidden">

      {!maximized && !minimized && <>
        <RH edge="n"  cls="top-0 left-3 right-3 h-[4px]"/>
        <RH edge="s"  cls="bottom-0 left-3 right-3 h-[4px]"/>
        <RH edge="e"  cls="right-0 top-3 bottom-3 w-[4px]"/>
        <RH edge="w"  cls="left-0 top-3 bottom-3 w-[4px]"/>
        <RH edge="nw" cls="top-0 left-0 w-4 h-4"/>
        <RH edge="ne" cls="top-0 right-0 w-4 h-4"/>
        <RH edge="sw" cls="bottom-0 left-0 w-4 h-4"/>
        <RH edge="se" cls="bottom-0 right-0 w-4 h-4"/>
      </>}

      {/* TITLE BAR */}
      <div
        onMouseDown={onTitleDrag}
        className="flex-shrink-0 h-10 flex items-center justify-between bg-[#1c1c1e] border-b border-[#2d2d2d] cursor-move select-none"
      >
        <div className="flex items-center gap-2.5 pl-3 min-w-0">
          <div className="w-6 h-6 rounded-md bg-[#2a2a2e] flex items-center justify-center flex-shrink-0">
            <Terminal size={12} className="text-emerald-400"/>
          </div>
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-[12px] font-mono text-emerald-400 font-bold leading-none">{server.ssh_username||'root'}</span>
            <span className="text-[#555] text-[12px] font-mono">@</span>
            <span className="text-[#d0d0d0] text-[12px] font-mono font-semibold truncate max-w-[150px]">{server.server_name}</span>
            <span className="text-[#555] text-[11px] font-mono hidden sm:block">{server.ip_address}</span>
          </div>
          <div className="hidden md:flex items-center gap-1 ml-1">
            <span className="relative flex h-1.5 w-1.5 flex-shrink-0">
              <span className="animate-ping absolute h-full w-full rounded-full bg-emerald-400 opacity-60"/>
              <span className="relative rounded-full h-full w-full bg-emerald-500"/>
            </span>
            <span className="text-[10px] text-emerald-500 font-semibold">connected</span>
          </div>
        </div>

        <div className="flex items-stretch h-full flex-shrink-0" onMouseDown={e=>e.stopPropagation()}>
          <button onClick={toggleMin} title={minimized ? 'Restore' : 'Minimize'}
            className="w-12 h-full flex items-center justify-center text-[#888] hover:text-white hover:bg-[#2a2a2e] transition-colors">
            <svg width="12" height="2" viewBox="0 0 12 2"><rect width="12" height="2" rx="1" fill="currentColor"/></svg>
          </button>
          <button onClick={toggleMax} title={maximized ? 'Restore' : 'Maximize'}
            className="w-12 h-full flex items-center justify-center text-[#888] hover:text-white hover:bg-[#2a2a2e] transition-colors">
            {maximized ? (
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
                <rect x="3.5" y="0.5" width="9" height="9" rx="1.2" stroke="currentColor" strokeWidth="1.3"/>
                <rect x="0.5" y="3.5" width="9" height="9" rx="1.2" fill="#1c1c1e" stroke="currentColor" strokeWidth="1.3"/>
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <rect x="0.75" y="0.75" width="10.5" height="10.5" rx="1.5" stroke="currentColor" strokeWidth="1.4"/>
              </svg>
            )}
          </button>
          <button onClick={onClose} title="Close"
            className="w-12 h-full flex items-center justify-center bg-[#c0392b] hover:bg-[#e74c3c] text-white transition-colors"
            style={{ borderRadius: maximized ? 0 : '0 9px 0 0' }}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <line x1="1.5" y1="1.5" x2="10.5" y2="10.5" stroke="white" strokeWidth="1.8" strokeLinecap="round"/>
              <line x1="10.5" y1="1.5" x2="1.5" y2="10.5" stroke="white" strokeWidth="1.8" strokeLinecap="round"/>
            </svg>
          </button>
        </div>
      </div>

      {/* TERMINAL BODY */}
      {!minimized && (
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="flex-shrink-0 flex items-end bg-[#141416] border-b border-[#2d2d2d] px-2 pt-1.5">
            <div className="flex items-center gap-1.5 px-3 py-1 bg-[#0d1117] border border-b-0 border-[#2d2d2d] rounded-t-lg">
              <span className="relative flex h-1.5 w-1.5">
                <span className="animate-ping absolute h-full w-full rounded-full bg-emerald-400 opacity-50"/>
                <span className="relative rounded-full h-full w-full bg-emerald-500"/>
              </span>
              <span className="text-[11px] font-mono text-[#ccc] max-w-[140px] truncate">{server.server_name}</span>
            </div>
          </div>
          <div className="flex-1 min-h-0">
            <Suspense fallback={
              <div className="w-full h-full flex items-center justify-center bg-[#0d1117]">
                <div className="text-center">
                  <Loader2 className="animate-spin text-emerald-500 mx-auto mb-3" size={30}/>
                  <p className="text-[#555] text-xs font-mono">Connecting to {server.server_name}…</p>
                </div>
              </div>
            }>
              <XTerminal serverId={server.id} serverName={server.server_name} height="100%"/>
            </Suspense>
          </div>
          <div className="flex-shrink-0 h-5 bg-[#0d1117] border-t border-[#1c1c1e] flex items-center px-4 gap-4">
            <span className="text-[9px] font-mono text-[#444] flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-600 inline-block"/>
              {server.ip_address}:{server.ssh_port||22}
            </span>
            <span className="ml-auto text-[9px] font-mono text-[#444]">Real PTY · bash</span>
          </div>
        </div>
      )}

      {minimized && (
        <div className="bg-[#141416] border-t border-[#2d2d2d] px-4 py-2 flex items-center gap-2">
          <span className="text-[10px] text-[#555] font-mono">Session minimized</span>
          <button onClick={toggleMin} className="ml-auto text-[10px] font-bold text-emerald-500 hover:text-emerald-400 font-mono">
            restore
          </button>
        </div>
      )}
    </div>
  );
}
