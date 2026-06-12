import React, { useState, lazy, Suspense } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, Server, Terminal, RefreshCw, Database, Activity,
  HardDrive, Cpu, CheckCircle2, AlertTriangle, Loader2,
  GitBranch, Globe, Clock, Link2, ChevronRight, X, Search,
  LayoutGrid, ExternalLink, Plus,
} from 'lucide-react';

import { getOsServer, refreshServerStatus, linkDbInstance } from '../../api/servers';
import { listConnections } from '../../api/connections';

// Lazy-load xterm so it doesn't bloat the initial bundle
const XTerminal = lazy(() => import('../../components/terminal/XTerminal'));

/* =====================================================
   CONSTANTS
===================================================== */

const DB_COLORS = {
  MySQL:      { bg: 'bg-orange-50', border: 'border-orange-300', text: 'text-orange-700', strip: 'bg-orange-400', badge: 'bg-orange-100' },
  PostgreSQL: { bg: 'bg-blue-50',   border: 'border-blue-300',   text: 'text-blue-700',   strip: 'bg-blue-400',   badge: 'bg-blue-100' },
  Oracle:     { bg: 'bg-red-50',    border: 'border-red-300',    text: 'text-red-700',    strip: 'bg-red-400',    badge: 'bg-red-100' },
  MongoDB:    { bg: 'bg-green-50',  border: 'border-green-300',  text: 'text-green-700',  strip: 'bg-green-400',  badge: 'bg-green-100' },
  MSSQL:      { bg: 'bg-purple-50', border: 'border-purple-300', text: 'text-purple-700', strip: 'bg-purple-400', badge: 'bg-purple-100' },
  ClickHouse: { bg: 'bg-yellow-50', border: 'border-yellow-300', text: 'text-yellow-700', strip: 'bg-yellow-400', badge: 'bg-yellow-100' },
  MariaDB:    { bg: 'bg-teal-50',   border: 'border-teal-300',   text: 'text-teal-700',   strip: 'bg-teal-400',   badge: 'bg-teal-100' },
};

const DB_DASHBOARD_ROUTES = {
  MySQL:      (id) => `/mysql-dashboard/${id}`,
  MariaDB:    (id) => `/mysql-dashboard/${id}`,
  PostgreSQL: (id) => `/postgresql-dashboard/${id}`,
  Oracle:     (id) => `/oracle-dashboard/${id}`,
  MSSQL:      (id) => `/mssql-dashboard/${id}`,
  MongoDB:    (id) => `/mongodb-dashboard/${id}`,
  ClickHouse: (id) => `/clickhouse-dashboard/${id}`,
};

const TABS = [
  { id: 'overview',  label: 'Overview',  icon: LayoutGrid },
  { id: 'databases', label: 'Databases', icon: Database },
  { id: 'terminal',  label: 'Terminal',  icon: Terminal },
];

/* =====================================================
   MAIN COMPONENT
===================================================== */

export default function ServerDetail() {
  const { serverId } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const [activeTab, setActiveTab] = useState('overview');
  const [linkModal, setLinkModal] = useState(null); // { instance }

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['osServer', serverId],
    queryFn: () => getOsServer(serverId),
  });

  // Fetch all DB connections so we can auto-match by IP+port (no manual Link step)
  const { data: allConnections = [] } = useQuery({
    queryKey: ['allConnections'],
    queryFn: async () => {
      const types = ['mysql', 'postgresql', 'oracle', 'mssql', 'mongodb', 'clickhouse'];
      const results = await Promise.allSettled(types.map((t) => listConnections(t)));
      return results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
    },
    staleTime: 60000,
  });

  const refreshMutation = useMutation({
    mutationFn: () => refreshServerStatus(serverId),
    onSuccess: () => { qc.invalidateQueries(['osServer', serverId]); refetch(); },
  });

  const linkMutation = useMutation({
    mutationFn: ({ instanceId, connectionId }) =>
      linkDbInstance(Number(serverId), instanceId, connectionId),
    onSuccess: () => {
      setLinkModal(null);
      qc.invalidateQueries(['osServer', serverId]);
    },
  });

  const server = data?.data;

  /* ──────── Loading / Error ──────── */
  if (isLoading) {
    return (
      <div className="min-h-screen bg-[#f5f7fb] flex items-center justify-center">
        <Loader2 className="animate-spin text-slate-500" size={36} />
      </div>
    );
  }
  if (error || !server) {
    return (
      <div className="min-h-screen bg-[#f5f7fb] p-6">
        <div className="max-w-xl mx-auto bg-red-50 border border-red-200 rounded-2xl p-6 text-red-700 text-sm">
          {error?.message || 'Server not found'}
          <button onClick={() => navigate(-1)} className="ml-4 underline">Go back</button>
        </div>
      </div>
    );
  }

  const statusMeta =
    server.status === 'Connected'     ? { pill: 'bg-green-100 text-green-700 border-green-200', dot: 'bg-green-500 animate-pulse' }
    : server.status === 'Warning'     ? { pill: 'bg-yellow-100 text-yellow-700 border-yellow-200', dot: 'bg-yellow-500' }
    : server.status === 'Disconnected'? { pill: 'bg-red-100 text-red-700 border-red-200', dot: 'bg-red-500' }
    : { pill: 'bg-slate-100 text-slate-600 border-slate-200', dot: 'bg-slate-400' };

  /* ──────── Render ──────── */
  return (
    <div className="min-h-screen bg-[#f5f7fb] flex flex-col">

      {/* ══ STICKY HEADER ══ */}
      <div className="bg-white border-b border-slate-200 px-6 py-4 sticky top-0 z-30">
        <div className="max-w-[1400px] mx-auto">

          {/* Breadcrumb */}
          <div className="flex items-center gap-1.5 text-slate-400 text-xs mb-3">
            <button onClick={() => navigate('/databases')} className="hover:text-slate-700 transition-colors">Databases</button>
            <ChevronRight size={11} />
            <span className="text-slate-700 font-semibold">{server.server_name}</span>
          </div>

          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-center gap-3">
              <button
                onClick={() => navigate('/databases')}
                className="w-9 h-9 rounded-xl border border-slate-200 flex items-center justify-center hover:bg-slate-100 flex-shrink-0"
              >
                <ArrowLeft size={16} />
              </button>
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <h1 className="text-xl font-bold text-slate-900">{server.server_name}</h1>
                  <span className={`flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold border ${statusMeta.pill}`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${statusMeta.dot}`} />
                    {server.status || 'Unknown'}
                  </span>
                  {server.cluster_name && (
                    <span className="px-2.5 py-0.5 rounded-full bg-purple-100 text-purple-700 text-xs font-semibold border border-purple-200">
                      {server.node_type} · {server.cluster_name}
                    </span>
                  )}
                </div>
                <p className="text-slate-500 text-xs mt-0.5">{server.ip_address} · {server.os_type} · {server.environment}</p>
              </div>
            </div>

            <div className="flex gap-2 flex-shrink-0">
              <button
                onClick={() => refreshMutation.mutate()}
                disabled={refreshMutation.isPending}
                className="h-9 px-4 rounded-xl border border-slate-200 bg-white flex items-center gap-2 hover:bg-slate-50 font-semibold text-sm transition-all"
              >
                <RefreshCw size={14} className={refreshMutation.isPending ? 'animate-spin' : ''} />
                Refresh
              </button>
              <button
                onClick={() => setActiveTab('terminal')}
                className="h-9 px-4 rounded-xl bg-slate-900 text-white flex items-center gap-2 hover:bg-slate-700 font-semibold text-sm transition-all"
              >
                <Terminal size={14} />
                Terminal
              </button>
            </div>
          </div>

          {/* TABS */}
          <div className="flex gap-1 mt-4 -mb-px">
            {TABS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setActiveTab(id)}
                className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-semibold border-b-2 transition-all rounded-t-lg ${
                  activeTab === id
                    ? 'border-slate-900 text-slate-900 bg-slate-50'
                    : 'border-transparent text-slate-500 hover:text-slate-700 hover:bg-slate-50'
                }`}
              >
                <Icon size={14} />
                {label}
                {id === 'databases' && server.db_instances?.length > 0 && (
                  <span className="ml-1 px-1.5 py-0.5 rounded-full bg-slate-200 text-slate-600 text-[10px] font-bold leading-none">
                    {server.db_instances.length}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ══ TAB CONTENT ══ */}
      <div className="flex-1 max-w-[1400px] mx-auto w-full p-6">

        {/* ─── OVERVIEW TAB ─── */}
        {activeTab === 'overview' && (
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">

            {/* LEFT column */}
            <div className="xl:col-span-2 space-y-5">

              {/* Server Info */}
              <div className="bg-white rounded-2xl border border-slate-200 p-6">
                <SectionTitle icon={<Server size={15} />}>Server Information</SectionTitle>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-5 mt-4">
                  <InfoItem label="Hostname" value={server.hostname || server.ip_address} />
                  <InfoItem label="IP Address" value={server.ip_address} mono />
                  <InfoItem label="OS Type" value={server.os_type} />
                  <InfoItem label="Node Type" value={server.node_type} />
                  <InfoItem label="Environment" value={server.environment} />
                  <InfoItem label="Uptime" value={server.uptime || '—'} />
                  {server.cluster_name && <InfoItem label="Cluster" value={server.cluster_name} />}
                  <InfoItem label="SSH Port" value={server.ssh_port || 22} mono />
                  <InfoItem label="Auto Discovery" value={server.auto_discovery ? 'Enabled' : 'Disabled'} />
                </div>
              </div>

              {/* Live Metrics */}
              <div className="bg-white rounded-2xl border border-slate-200 p-6">
                <div className="flex items-center justify-between mb-4">
                  <SectionTitle icon={<Activity size={15} />}>Live Metrics</SectionTitle>
                  {refreshMutation.isPending && (
                    <span className="text-xs text-slate-400 flex items-center gap-1.5">
                      <Loader2 size={12} className="animate-spin" /> Refreshing…
                    </span>
                  )}
                </div>
                <div className="grid grid-cols-3 gap-4">
                  <MetricGauge label="CPU" value={server.cpu_usage} icon={<Cpu size={18} />} color="orange" />
                  <MetricGauge label="RAM" value={server.ram_usage} icon={<Activity size={18} />} color="purple" />
                  <MetricGauge label="Disk" value={server.disk_usage} icon={<HardDrive size={18} />} color="blue" />
                </div>
                {!server.cpu_usage && (
                  <p className="text-slate-400 text-xs text-center mt-3">
                    Click "Refresh" to pull live metrics via SSH
                  </p>
                )}
              </div>

              {/* Cluster siblings */}
              {server.cluster_siblings?.length > 0 && (
                <div className="bg-white rounded-2xl border border-slate-200 p-6">
                  <SectionTitle icon={<GitBranch size={15} className="text-purple-500" />}>
                    Cluster: {server.cluster_name}
                  </SectionTitle>
                  <div className="space-y-2 mt-4">
                    {server.cluster_siblings.map((sib) => (
                      <div key={sib.id} className="flex items-center justify-between bg-slate-50 rounded-xl px-4 py-3 border border-slate-100">
                        <div className="flex items-center gap-3">
                          <PulsingDot status={sib.status} />
                          <div>
                            <p className="font-semibold text-slate-900 text-sm">{sib.server_name}</p>
                            <p className="text-slate-500 text-xs">{sib.ip_address} · {sib.node_type}</p>
                          </div>
                        </div>
                        <button onClick={() => navigate(`/connections/server/${sib.id}`)} className="text-slate-400 hover:text-slate-800">
                          <ChevronRight size={16} />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* RIGHT column */}
            <div className="space-y-5">

              {/* DB summary */}
              <div className="bg-white rounded-2xl border border-slate-200 p-6">
                <div className="flex items-center justify-between mb-4">
                  <SectionTitle icon={<Database size={15} />}>
                    Databases <span className="font-normal text-slate-400 text-xs ml-1">({server.db_instances?.length || 0})</span>
                  </SectionTitle>
                  <button onClick={() => setActiveTab('databases')} className="text-xs text-blue-600 hover:underline">
                    Manage →
                  </button>
                </div>
                {!server.db_instances?.length ? (
                  <p className="text-slate-400 text-sm">No databases detected yet.</p>
                ) : (
                  <div className="space-y-2">
                    {server.db_instances.map((inst) => {
                      const c = DB_COLORS[inst.db_type] || { bg: 'bg-slate-50', border: 'border-slate-200', text: 'text-slate-700', strip: 'bg-slate-400' };
                      const dashRoute = inst.connection_id && DB_DASHBOARD_ROUTES[inst.db_type]
                        ? DB_DASHBOARD_ROUTES[inst.db_type](inst.connection_id)
                        : null;
                      return (
                        <div
                          key={inst.id}
                          onClick={() => dashRoute ? navigate(dashRoute) : setActiveTab('databases')}
                          className={`flex items-center justify-between px-3 py-2.5 rounded-xl ${c.bg} border ${c.border} cursor-pointer hover:brightness-95 transition-all group`}
                          title={dashRoute ? `Open ${inst.db_type} Dashboard` : 'Go to Databases tab to link a connection'}
                        >
                          <div className="flex items-center gap-2">
                            <div className={`w-2 h-2 rounded-full ${c.strip}`} />
                            <span className={`text-sm font-semibold ${c.text}`}>{inst.db_type}</span>
                            {inst.port && <span className="text-xs text-slate-400">:{inst.port}</span>}
                          </div>
                          <div className="flex items-center gap-1.5">
                            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${
                              inst.status === 'Running' ? 'bg-green-100 text-green-700'
                              : inst.status === 'Stopped' ? 'bg-red-100 text-red-700'
                              : 'bg-slate-100 text-slate-500'
                            }`}>
                              {inst.status || 'Unknown'}
                            </span>
                            <ChevronRight size={12} className={`${c.text} opacity-0 group-hover:opacity-100 transition-opacity`} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* SSH access */}
              <div className="bg-white rounded-2xl border border-slate-200 p-6">
                <SectionTitle icon={<LockIcon size={15} />}>SSH Access</SectionTitle>
                <div className="space-y-2.5 mt-4 text-sm">
                  {[
                    ['Username', <span className="font-mono">{server.ssh_username || '—'}</span>],
                    ['Port', <span className="font-mono">{server.ssh_port || 22}</span>],
                    ['Password', <span className="font-mono text-slate-400">{'•'.repeat(8)}</span>],
                    ['Monitoring', server.monitoring_enabled
                      ? <span className="text-green-600 font-semibold">Enabled</span>
                      : <span className="text-slate-400">Disabled</span>],
                  ].map(([label, val]) => (
                    <div key={label} className="flex justify-between items-center border-b border-slate-50 pb-2 last:border-0 last:pb-0">
                      <span className="text-slate-500">{label}</span>
                      <span>{val}</span>
                    </div>
                  ))}
                </div>
                <button
                  onClick={() => setActiveTab('terminal')}
                  className="w-full mt-5 h-10 rounded-xl bg-slate-900 text-white font-semibold flex items-center justify-center gap-2 hover:bg-slate-700 transition-all text-sm"
                >
                  <Terminal size={14} /> Open SSH Terminal
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ─── DATABASES TAB ─── */}
        {activeTab === 'databases' && (
          <div className="space-y-5">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div>
                <h2 className="text-lg font-bold text-slate-800">Installed Databases</h2>
                <p className="text-slate-500 text-sm mt-0.5">
                  Link a connection profile to each database to unlock monitoring dashboards.
                </p>
              </div>
              <button
                onClick={() => refreshMutation.mutate()}
                disabled={refreshMutation.isPending}
                className="h-9 px-4 rounded-xl border border-slate-200 bg-white text-sm font-semibold flex items-center gap-2 hover:bg-slate-50"
              >
                <RefreshCw size={14} className={refreshMutation.isPending ? 'animate-spin' : ''} />
                Refresh & Detect
              </button>
            </div>

            {!server.db_instances?.length ? (
              <div className="bg-white rounded-2xl border border-slate-200 p-16 text-center">
                <Database size={48} className="mx-auto text-slate-200 mb-4" />
                <h3 className="text-lg font-bold text-slate-600 mb-2">No databases detected</h3>
                <p className="text-slate-400 text-sm mb-5 max-w-sm mx-auto">
                  Click "Refresh & Detect" to auto-discover running database services via SSH.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
                {server.db_instances.map((inst) => (
                  <DbInstanceCard
                    key={inst.id}
                    inst={inst}
                    serverId={serverId}
                    serverIp={server.ip_address}
                    allConnections={allConnections}
                    onLink={() => setLinkModal({ instance: inst })}
                    onOpenDashboard={(route) => navigate(route)}
                    onSetupConnection={() => navigate(
                      `/connections/add?type=${inst.db_type?.toLowerCase()}&host=${server.ip_address}&port=${inst.port}&name=${server.server_name}-${inst.db_type}`
                    )}
                  />
                ))}
              </div>
            )}

            {/* How to link guide */}
            <div className="bg-blue-50 border border-blue-200 rounded-2xl p-5 text-sm text-blue-800">
              <p className="font-semibold mb-2">How to open a monitoring dashboard</p>
              <ol className="space-y-1 list-decimal list-inside text-blue-700">
                <li>Go to <button onClick={() => navigate('/connections/add')} className="underline font-semibold">Add Connection</button> and create a MySQL (or other DB) connection with host = <span className="font-mono">{server.ip_address}</span></li>
                <li>Come back here → click <strong>Link</strong> on the database card</li>
                <li>Select the connection you created → click <strong>Link Connection</strong></li>
                <li>The <strong>Open Dashboard</strong> button will activate instantly</li>
              </ol>
            </div>
          </div>
        )}

        {/* ─── TERMINAL TAB ─── */}
        {activeTab === 'terminal' && (
          <div
            className="bg-[#0d1117] rounded-2xl overflow-hidden border border-[#30363d] shadow-2xl flex flex-col"
            style={{ height: 'calc(100vh - 280px)', minHeight: 420 }}
          >
            {/* Title bar */}
            <div className="h-10 bg-[#161b22] border-b border-[#30363d] flex items-center justify-between px-4 flex-shrink-0">
              <div className="flex items-center gap-3">
                <div className="flex gap-1.5">
                  <div className="w-3 h-3 rounded-full bg-[#ff5f57]" />
                  <div className="w-3 h-3 rounded-full bg-[#febc2e]" />
                  <div className="w-3 h-3 rounded-full bg-[#28c840]" />
                </div>
                <span className="text-slate-300 text-xs font-mono">
                  <span className="text-green-400">{server.ssh_username || 'root'}</span>
                  <span className="text-slate-500">@</span>
                  <span className="text-slate-200">{server.server_name}</span>
                  <span className="text-slate-500"> — {server.ip_address}</span>
                </span>
              </div>
              <span className="text-slate-600 text-xs">Real PTY · su/sudo/mysql all supported</span>
            </div>

            {/* xterm.js terminal */}
            <div className="flex-1 min-h-0">
              <Suspense fallback={
                <div className="w-full h-full bg-[#0d1117] flex items-center justify-center">
                  <Loader2 className="animate-spin text-green-500" size={28} />
                </div>
              }>
                <XTerminal
                  serverId={Number(serverId)}
                  serverName={server.server_name}
                  height="100%"
                />
              </Suspense>
            </div>
          </div>
        )}
      </div>

      {/* ══ LINK CONNECTION MODAL ══ */}
      {linkModal && (
        <LinkConnectionModal
          instance={linkModal.instance}
          serverIp={server.ip_address}
          onLink={(cid) => linkMutation.mutate({ instanceId: linkModal.instance.id, connectionId: cid })}
          onClose={() => setLinkModal(null)}
          linking={linkMutation.isPending}
          navigateToAdd={() => navigate(`/connections/add`)}
        />
      )}
    </div>
  );
}

/* =====================================================
   DATABASE INSTANCE CARD
===================================================== */

function DbInstanceCard({ inst, serverId, serverIp, allConnections, onLink, onOpenDashboard, onSetupConnection }) {
  const c = DB_COLORS[inst.db_type] || { bg: 'bg-slate-50', border: 'border-slate-200', text: 'text-slate-700', strip: 'bg-slate-400', badge: 'bg-slate-100' };

  // 1. Auto-match: find any connection with the same host IP + port (no manual Link step)
  const norm = (t) => (t || '').toLowerCase() === 'mariadb' ? 'mysql' : (t || '').toLowerCase();
  const autoMatch = (allConnections || []).find((conn) => {
    const sameHost = conn.host === serverIp ||
      conn.host === 'localhost' ||
      conn.host === '127.0.0.1';
    const samePort = String(conn.port) === String(inst.port);
    const sameType = norm(conn.db_type) === norm(inst.db_type);
    return sameHost && samePort && sameType;
  });

  // 2. Prefer explicitly linked connection, fall back to auto-matched
  const resolvedConn = inst.connection || autoMatch;
  const resolvedId   = inst.connection_id || autoMatch?.id;
  const route = resolvedId && DB_DASHBOARD_ROUTES[inst.db_type]
    ? DB_DASHBOARD_ROUTES[inst.db_type](resolvedId)
    : null;

  const btnColor =
    inst.db_type === 'MySQL' || inst.db_type === 'MariaDB' ? 'bg-orange-500 hover:bg-orange-600'
    : inst.db_type === 'PostgreSQL' ? 'bg-blue-600 hover:bg-blue-700'
    : inst.db_type === 'Oracle'     ? 'bg-red-600 hover:bg-red-700'
    : inst.db_type === 'MongoDB'    ? 'bg-green-600 hover:bg-green-700'
    : 'bg-slate-800 hover:bg-slate-700';

  return (
    <div className={`rounded-2xl border-2 ${c.border} bg-white overflow-hidden shadow-sm hover:shadow-lg transition-all`}>
      <div className={`h-1.5 ${c.strip}`} />
      <div className="p-5">

        {/* Header */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2.5">
            <div className={`w-10 h-10 rounded-xl ${c.badge} flex items-center justify-center`}>
              <Database size={18} className={c.text} />
            </div>
            <div>
              <p className={`font-bold text-base ${c.text}`}>{inst.db_type}</p>
              {inst.db_version && <p className="text-xs text-slate-400">{inst.db_version}</p>}
              {inst.port && <p className="text-xs text-slate-400 font-mono">:{inst.port}</p>}
            </div>
          </div>
          <span className={`px-2.5 py-1 rounded-full text-[11px] font-bold ${
            inst.status === 'Running' ? 'bg-green-100 text-green-700'
            : inst.status === 'Stopped' ? 'bg-red-100 text-red-700'
            : 'bg-slate-100 text-slate-500'
          }`}>
            {inst.status || 'Unknown'}
          </span>
        </div>

        {/* Connection status */}
        {resolvedConn ? (
          <div className="flex items-center gap-2 bg-green-50 rounded-xl p-3 mb-4 border border-green-100">
            <CheckCircle2 size={13} className="text-green-600 flex-shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold text-green-800 truncate">{resolvedConn.connection_name}</p>
              <p className="text-[11px] text-green-600">{resolvedConn.host}:{resolvedConn.port}</p>
            </div>
            {autoMatch && !inst.connection_id && (
              <span className="text-[9px] font-bold px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded-full flex-shrink-0">AUTO</span>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-2 bg-slate-50 rounded-xl p-3 mb-4 border border-slate-200">
            <AlertTriangle size={13} className="text-slate-400 flex-shrink-0" />
            <p className="text-xs text-slate-500">No matching connection found</p>
          </div>
        )}

        {/* Actions */}
        <div className="flex flex-col gap-2">
          {route ? (
            <button
              onClick={() => onOpenDashboard(route)}
              className={`w-full h-10 rounded-xl font-bold text-sm text-white transition-all flex items-center justify-center gap-2 shadow-sm ${btnColor}`}
            >
              <ExternalLink size={14} /> Open {inst.db_type} Dashboard
            </button>
          ) : (
            <button
              onClick={onSetupConnection}
              className={`w-full h-10 rounded-xl font-bold text-sm transition-all flex items-center justify-center gap-2 border-2 border-dashed ${c.border} ${c.text} hover:bg-orange-50`}
            >
              <Plus size={14} /> Setup {inst.db_type} Connection
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* =====================================================
   LINK CONNECTION MODAL
===================================================== */

function LinkConnectionModal({ instance, serverIp, onLink, onClose, linking, navigateToAdd }) {
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(null);

  // MariaDB connections are stored under 'mysql' type
  const resolvedType = instance.db_type === 'MariaDB' ? 'mysql' : instance.db_type;
  const { data: connections = [], isLoading } = useQuery({
    queryKey: ['connections', resolvedType],
    queryFn: () => listConnections(resolvedType),
    staleTime: 30000,
  });

  const filtered = connections.filter((c) =>
    !search ||
    c.connection_name?.toLowerCase().includes(search.toLowerCase()) ||
    c.host?.includes(search)
  );

  return (
    <div className="fixed inset-0 z-[99999] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
          <div>
            <h3 className="font-bold text-slate-900">Link {instance.db_type} Connection</h3>
            <p className="text-slate-500 text-xs mt-0.5">Associate a connection profile to enable the monitoring dashboard</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-lg hover:bg-slate-100 flex items-center justify-center">
            <X size={15} className="text-slate-500" />
          </button>
        </div>

        {/* Search */}
        <div className="px-6 py-3 border-b border-slate-100">
          <div className="relative">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={`Search ${instance.db_type} connections…`}
              className="w-full h-9 pl-9 pr-4 rounded-xl border border-slate-200 text-sm outline-none focus:border-slate-400"
              autoFocus
            />
          </div>
        </div>

        {/* List */}
        <div className="px-6 py-3 max-h-64 overflow-y-auto">
          {isLoading ? (
            <div className="flex justify-center py-6"><Loader2 className="animate-spin text-slate-400" size={22} /></div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-8">
              <Database size={32} className="mx-auto text-slate-200 mb-3" />
              <p className="text-slate-500 text-sm font-semibold">
                {search ? `No matches for "${search}"` : `No ${instance.db_type} connections found`}
              </p>
              <p className="text-slate-400 text-xs mt-1 mb-4">
                Create a connection profile first, then link it here.
              </p>
              <button
                onClick={() => { onClose(); navigateToAdd(); }}
                className="h-9 px-4 rounded-xl bg-slate-900 text-white text-xs font-semibold flex items-center gap-2 mx-auto hover:bg-slate-700"
              >
                <Plus size={13} /> Add {instance.db_type} Connection
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              {filtered.map((conn) => (
                <button
                  key={conn.id}
                  onClick={() => setSelected(conn.id === selected ? null : conn.id)}
                  className={`w-full flex items-center justify-between p-3 rounded-xl border-2 transition-all text-left ${
                    selected === conn.id
                      ? 'border-slate-900 bg-slate-900 text-white'
                      : 'border-slate-200 hover:border-slate-400'
                  }`}
                >
                  <div>
                    <p className="font-semibold text-sm">{conn.connection_name}</p>
                    <p className={`text-xs ${selected === conn.id ? 'text-slate-300' : 'text-slate-500'}`}>
                      {conn.host}:{conn.port} {conn.database_name ? `· ${conn.database_name}` : ''}
                    </p>
                  </div>
                  {selected === conn.id && <CheckCircle2 size={15} className="text-green-400 flex-shrink-0" />}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-slate-100 flex justify-end gap-2">
          <button onClick={onClose} className="h-9 px-4 rounded-xl border border-slate-200 text-sm font-semibold hover:bg-slate-50">
            Cancel
          </button>
          <button
            onClick={() => selected && onLink(selected)}
            disabled={!selected || linking}
            className="h-9 px-5 rounded-xl bg-slate-900 text-white text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2 hover:bg-slate-700 transition-all"
          >
            {linking && <Loader2 size={13} className="animate-spin" />}
            Link Connection
          </button>
        </div>
      </div>
    </div>
  );
}

/* =====================================================
   REUSABLE SUB-COMPONENTS
===================================================== */

function SectionTitle({ icon, children }) {
  return (
    <div className="flex items-center gap-2 text-slate-700 font-bold text-sm">
      <span className="text-slate-400">{icon}</span>
      {children}
    </div>
  );
}

function InfoItem({ label, value, mono }) {
  return (
    <div>
      <p className="text-[11px] text-slate-400 mb-0.5 uppercase tracking-wide">{label}</p>
      <p className={`font-semibold text-slate-900 text-sm ${mono ? 'font-mono' : ''}`}>{value || '—'}</p>
    </div>
  );
}

function MetricGauge({ label, value, icon, color }) {
  const pct = Math.min(parseFloat(value) || 0, 100);
  const danger = pct > 85;
  const colorMap = {
    orange: { text: 'text-orange-500', bar: 'bg-orange-400' },
    purple: { text: 'text-purple-500', bar: 'bg-purple-400' },
    blue:   { text: 'text-blue-500',   bar: 'bg-blue-400' },
  };
  const { text, bar } = colorMap[color] || colorMap.blue;

  return (
    <div className="bg-slate-50 rounded-xl border border-slate-200 p-4 text-center">
      <div className={`flex justify-center mb-1.5 ${danger ? 'text-red-500' : text}`}>{icon}</div>
      <p className={`text-xl font-bold ${danger ? 'text-red-600' : 'text-slate-900'}`}>{value || '—'}</p>
      <p className="text-[11px] text-slate-400 mt-0.5 mb-2">{label}</p>
      {pct > 0 && (
        <div className="h-1.5 rounded-full bg-slate-200 overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${danger ? 'bg-red-500' : bar}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </div>
  );
}

function PulsingDot({ status }) {
  if (status === 'Connected') {
    return (
      <span className="relative flex h-2.5 w-2.5 flex-shrink-0">
        <span className="animate-ping absolute h-full w-full rounded-full bg-green-400 opacity-75" />
        <span className="relative rounded-full h-2.5 w-2.5 bg-green-500" />
      </span>
    );
  }
  const c = status === 'Warning' ? 'bg-yellow-500' : status === 'Disconnected' ? 'bg-red-500' : 'bg-slate-400';
  return <div className={`w-2.5 h-2.5 rounded-full ${c} flex-shrink-0`} />;
}

function LockIcon({ size }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
      <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
    </svg>
  );
}

