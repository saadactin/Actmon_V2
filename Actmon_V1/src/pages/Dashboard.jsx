import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAgentsList } from '../hooks/useAgents';
import { useNotifications } from '../hooks/useNotifications';
import { DBTypeBadge } from '../components/ui/DBTypeBadge';
import { StatusPill } from '../components/ui/StatusPill';
import { MetricBar } from '../components/ui/MetricBar';
import { formatTimeAgo } from '../utils/formatters';
import { Spinner } from '@fluentui/react-components';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell, AreaChart, Area,
} from 'recharts';
import {
  Server, CheckCircle, ShieldAlert, AlertTriangle, WifiOff,
  Bell, ArrowRight, RefreshCw, Activity, Cpu, Users, Timer,
  ChevronRight, Database, Search, Globe, TrendingUp, TrendingDown,
  HardDrive,
} from 'lucide-react';

// ─── helpers ────────────────────────────────────────────────────────────────

const statusLevel = (s) => {
  const v = s?.toLowerCase();
  if (v === 'online' || v === 'healthy') return 'online';
  if (v === 'warning' || v === 'degraded') return 'warning';
  if (v === 'offline') return 'offline';
  return 'critical';
};

const ago = (ts) => {
  if (!ts) return 'Never';
  const d = Math.floor((Date.now() - new Date(ts)) / 1000);
  if (d < 60) return d + 's ago';
  if (d < 3600) return Math.floor(d / 60) + 'm ago';
  if (d < 86400) return Math.floor(d / 3600) + 'h ago';
  return Math.floor(d / 86400) + 'd ago';
};

const STATUS_COLORS = {
  online:   '#22c55e',
  warning:  '#f59e0b',
  offline:  '#94a3b8',
  critical: '#ef4444',
};

const DB_COLORS = {
  mysql:      '#f59e0b',
  postgresql: '#3b82f6',
  oracle:     '#ef4444',
  mssql:      '#a855f7',
  sqlserver:  '#a855f7',
  mongodb:    '#22c55e',
  clickhouse: '#f97316',
};

const getDbColor = (type) => DB_COLORS[type?.toLowerCase()] || '#64748b';

const cpuColor = (v) => {
  if (v == null) return '#22c55e';
  if (v >= 80) return '#ef4444';
  if (v >= 60) return '#f59e0b';
  return '#22c55e';
};

const metricTextColor = (v) => {
  if (v == null) return '#22c55e';
  if (v >= 80) return '#ef4444';
  if (v >= 60) return '#f59e0b';
  return '#22c55e';
};

// Custom tooltip for BarChart
const CustomBarTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs shadow-xl">
      <p className="text-slate-300 font-semibold mb-1">{label}</p>
      {payload.map((p) => (
        <p key={p.dataKey} style={{ color: p.fill }} className="font-bold">
          {p.name}: {(p.value ?? 0).toFixed(1)}%
        </p>
      ))}
    </div>
  );
};

// ─── Sub-components ──────────────────────────────────────────────────────────

const StatPill = ({ icon, label, value, color = '#94a3b8' }) => (
  <div
    className="flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold"
    style={{ backgroundColor: `${color}18`, border: `1px solid ${color}40`, color: '#f1f5f9' }}
  >
    <span style={{ color }}>{icon}</span>
    <span className="text-slate-400">{label}:</span>
    <span style={{ color }} className="font-bold">{value}</span>
  </div>
);

const KPICard = ({ icon, label, value, sub, iconBg, valueColor = '#0f172a', trend, onClick, active }) => {
  const Tag = onClick ? 'button' : 'div';
  return (
  <Tag
    onClick={onClick}
    className={`text-left w-full bg-white rounded-xl border shadow-sm px-4 py-3 flex items-center gap-3 transition-all ${
      onClick ? 'cursor-pointer hover:shadow-md hover:-translate-y-0.5' : 'hover:shadow-md'
    } ${active ? 'border-transparent ring-2 ring-blue-400' : 'border-slate-200'}`}
  >
    <div
      className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
      style={{ backgroundColor: iconBg }}
    >
      {icon}
    </div>
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-2">
        <span className="text-2xl font-extrabold tracking-tight leading-none" style={{ color: valueColor }}>
          {value}
        </span>
        {trend !== undefined && (
          <span
            className="flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded-full"
            style={{
              color: trend >= 0 ? '#16a34a' : '#ef4444',
              backgroundColor: trend >= 0 ? '#dcfce7' : '#fee2e2',
            }}
          >
            {trend >= 0 ? <TrendingUp className="h-2.5 w-2.5" /> : <TrendingDown className="h-2.5 w-2.5" />}
            {Math.abs(trend)}
          </span>
        )}
      </div>
      <div className="text-[12px] font-semibold text-slate-700 mt-0.5 truncate">{label}</div>
      {sub && <div className="text-[10px] text-slate-400 truncate">{sub}</div>}
    </div>
  </Tag>
  );
};

const AgentChip = ({ agent, onClick }) => {
  const level = statusLevel(agent.status);
  const color = STATUS_COLORS[level];
  return (
    <button
      onClick={() => onClick(agent)}
      className="flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold border whitespace-nowrap transition-all hover:scale-105 hover:shadow-md"
      style={{
        backgroundColor: `${color}12`,
        borderColor: `${color}40`,
        color: '#334155',
      }}
    >
      <span
        className="w-2 h-2 rounded-full flex-shrink-0 animate-pulse"
        style={{ backgroundColor: color }}
      />
      <span className="font-bold" style={{ color }}>{agent.name}</span>
      <span className="text-slate-400">{agent.db_type}</span>
    </button>
  );
};

const NotifItem = ({ notif }) => {
  const sev = notif.severity?.toLowerCase();
  const borderColor = sev === 'critical' ? '#ef4444' : sev === 'warning' ? '#f59e0b' : '#3b82f6';
  const bg = sev === 'critical' ? '#fef2f2' : sev === 'warning' ? '#fffbeb' : '#eff6ff';
  const textColor = sev === 'critical' ? '#991b1b' : sev === 'warning' ? '#92400e' : '#1e40af';

  return (
    <div
      className="p-3 rounded-lg text-xs leading-relaxed"
      style={{
        borderLeft: `3px solid ${borderColor}`,
        backgroundColor: bg,
        paddingLeft: '12px',
      }}
    >
      <div className="flex items-center justify-between mb-1">
        <span
          className="font-bold text-xs px-1.5 py-0.5 rounded uppercase tracking-wide"
          style={{ backgroundColor: borderColor, color: '#fff' }}
        >
          {notif.severity}
        </span>
        <span className="text-slate-400">{ago(notif.timestamp || notif.created_at)}</span>
      </div>
      {notif.agent_name && (
        <div className="font-semibold text-slate-600 mb-0.5">{notif.agent_name}</div>
      )}
      <p style={{ color: textColor }}>{notif.message}</p>
    </div>
  );
};

// ─── Main Component ──────────────────────────────────────────────────────────

export const Dashboard = () => {
  const navigate = useNavigate();

  const {
    data: agents = [],
    isLoading: agentsLoading,
    isError: agentsError,
    refetch,
  } = useAgentsList(true);

  const {
    notifications = [],
    isLoading: notifLoading,
    unreadCount,
    markAllRead,
  } = useNotifications(20);

  // Live clock
  const [clock, setClock] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // 30s countdown
  const [countdown, setCountdown] = useState(30);
  useEffect(() => {
    const t = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) { refetch(); return 30; }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [refetch]);

  // Search + sort + status filter for agent table
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState('name');
  const [sortDir, setSortDir] = useState('asc');
  const [statusFilter, setStatusFilter] = useState('all');

  const handleSort = useCallback((key) => {
    setSortKey((k) => {
      if (k === key) { setSortDir((d) => (d === 'asc' ? 'desc' : 'asc')); return key; }
      setSortDir('asc');
      return key;
    });
  }, []);

  // KPI metrics
  const metrics = useMemo(() => {
    const total = agents.length;
    const online = agents.filter((a) => statusLevel(a.status) === 'online').length;
    const warning = agents.filter((a) => statusLevel(a.status) === 'warning').length;
    const critical = agents.filter((a) => {
      const l = statusLevel(a.status);
      return l === 'critical' || l === 'offline';
    }).length;
    const avgCpu =
      total > 0
        ? agents.reduce((s, a) => s + (Number(a.db_cpu) || Number(a.cpu_usage) || 0), 0) / total
        : 0;
    const sessions = agents.reduce((s, a) => s + (Number(a.active_sessions) || 0), 0);
    const allOk = critical === 0 && warning === 0;
    return { total, online, warning, critical, avgCpu, sessions, allOk };
  }, [agents]);

  // DB type distribution
  const dbDistribution = useMemo(() => {
    const map = {};
    agents.forEach((a) => {
      const k = a.db_type || 'Unknown';
      map[k] = (map[k] || 0) + 1;
    });
    return Object.entries(map).map(([type, count]) => ({ type, count }));
  }, [agents]);

  // CPU chart data (top 12)
  const cpuChartData = useMemo(
    () =>
      [...agents]
        .sort((a, b) => (Number(b.db_cpu) || 0) - (Number(a.db_cpu) || 0))
        .slice(0, 12)
        .map((a) => ({
          name: a.name?.length > 14 ? a.name.slice(0, 13) + '…' : a.name,
          cpu: Number(a.db_cpu) || 0,
          fullName: a.name,
        })),
    [agents]
  );

  // Filtered + sorted agents for table
  const filteredAgents = useMemo(() => {
    let list = agents;
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (a) =>
          a.name?.toLowerCase().includes(q) ||
          a.hostname?.toLowerCase().includes(q) ||
          a.ip_address?.includes(q)
      );
    }
    if (statusFilter !== 'all') {
      list = list.filter((a) => {
        const l = statusLevel(a.status);
        // "Critical / Offline" KPI counts both levels — match both here too.
        return statusFilter === 'critical' ? (l === 'critical' || l === 'offline') : l === statusFilter;
      });
    }
    list = [...list].sort((a, b) => {
      let va = a[sortKey] ?? '';
      let vb = b[sortKey] ?? '';
      if (typeof va === 'string') va = va.toLowerCase();
      if (typeof vb === 'string') vb = vb.toLowerCase();
      if (va < vb) return sortDir === 'asc' ? -1 : 1;
      if (va > vb) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
    return list;
  }, [agents, search, statusFilter, sortKey, sortDir]);

  const clockStr = clock.toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const dateStr = clock.toLocaleDateString('en-IN', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });

  if (agentsLoading && agents.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4">
        <Spinner size="large" />
        <p className="text-slate-500 text-sm font-medium">Loading ACTMON dashboard...</p>
      </div>
    );
  }

  const SortIcon = ({ col }) => (
    <span className="ml-1 text-slate-400 text-xs">
      {sortKey === col ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}
    </span>
  );

  return (
    <div className="space-y-6 pb-8">

      {/* ── HERO HEADER ─────────────────────────────────────────────────── */}
      <div
        className="rounded-2xl overflow-hidden shadow-xl"
        style={{ background: 'linear-gradient(135deg, #1e293b 0%, #0f172a 100%)' }}
      >
        {/* Top row */}
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 px-6 pt-6 pb-4">
          {/* Left — branding */}
          <div>
            <div className="flex items-center gap-3">
              <div
                className="w-10 h-10 rounded-xl flex items-center justify-center"
                style={{ background: 'linear-gradient(135deg, #3b82f6, #6366f1)' }}
              >
                <Database className="h-5 w-5 text-white" />
              </div>
              <div>
                <h1 className="text-2xl font-extrabold text-white tracking-tight">ACTMON</h1>
                <p className="text-xs text-slate-400 font-medium">Database Monitoring Platform</p>
              </div>
            </div>
          </div>

          {/* Right — clock + refresh + status badge */}
          <div className="flex flex-col items-end gap-2">
            <div className="flex items-center gap-3">
              {/* Clock */}
              <div className="text-right">
                <div className="text-2xl font-mono font-bold text-white tabular-nums">{clockStr}</div>
                <div className="text-xs text-slate-400">{dateStr}</div>
              </div>

              {/* Refresh */}
              <div className="flex flex-col items-center gap-1">
                <button
                  onClick={() => { refetch(); setCountdown(30); }}
                  className="w-9 h-9 flex items-center justify-center rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-300 hover:text-white transition-colors"
                  title="Refresh now"
                >
                  <RefreshCw className="h-4 w-4" />
                </button>
                <span className="text-xs text-slate-500 tabular-nums">{countdown}s</span>
              </div>
            </div>
          </div>
        </div>

        {agentsError && (
          <div className="mx-6 mb-4 px-4 py-2 rounded-lg bg-red-900/40 border border-red-700/50 text-red-300 text-xs font-medium flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 flex-shrink-0" />
            Unable to reach the backend API. Showing cached data.
          </div>
        )}
      </div>

      {/* ── KPI CARDS ────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
        <KPICard
          icon={<Server className="h-5 w-5 text-blue-600" />}
          label="Total Agents"
          value={metrics.total}
          sub="Registered monitors"
          iconBg="#dbeafe"
          onClick={() => setStatusFilter('all')}
          active={statusFilter === 'all'}
        />
        <KPICard
          icon={<CheckCircle className="h-5 w-5 text-green-600" />}
          label="Online"
          value={metrics.online}
          sub="Healthy agents"
          iconBg="#dcfce7"
          valueColor="#16a34a"
          trend={metrics.total > 0 ? metrics.online : undefined}
          onClick={() => setStatusFilter('online')}
          active={statusFilter === 'online'}
        />
        <KPICard
          icon={<AlertTriangle className="h-5 w-5 text-amber-600" />}
          label="Warnings"
          value={metrics.warning}
          sub="Degraded agents"
          iconBg="#fef3c7"
          valueColor={metrics.warning > 0 ? '#d97706' : '#0f172a'}
          onClick={() => setStatusFilter('warning')}
          active={statusFilter === 'warning'}
        />
        <KPICard
          icon={<ShieldAlert className="h-5 w-5 text-red-600" />}
          label="Critical / Offline"
          value={metrics.critical}
          sub="Needs attention"
          iconBg="#fee2e2"
          valueColor={metrics.critical > 0 ? '#dc2626' : '#0f172a'}
          onClick={() => setStatusFilter('critical')}
          active={statusFilter === 'critical'}
        />
        <KPICard
          icon={<Cpu className="h-5 w-5 text-indigo-600" />}
          label="Avg DB CPU"
          value={`${metrics.avgCpu.toFixed(1)}%`}
          sub="Across all agents"
          iconBg="#e0e7ff"
          valueColor={cpuColor(metrics.avgCpu)}
        />
        <KPICard
          icon={<Users className="h-5 w-5 text-cyan-600" />}
          label="Active Sessions"
          value={metrics.sessions.toLocaleString()}
          sub="Total connections"
          iconBg="#cffafe"
        />
      </div>

      {/* ── AGENTS TABLE + ALERTS ─────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

        {/* Agents table — full-featured */}
        <div className="lg:col-span-2 bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          {/* Table header */}
          <div className="p-4 border-b border-slate-100">
            <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between">
              <h2 className="text-sm font-bold text-slate-700 flex items-center gap-2">
                <Server className="h-4 w-4 text-blue-500" />
                Monitored Agents
                <span className="text-xs font-normal text-slate-400">({filteredAgents.length})</span>
              </h2>
              {/* Search */}
              <div className="relative w-full sm:w-56">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
                <input
                  type="text"
                  placeholder="Search agents..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="w-full pl-8 pr-3 py-1.5 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400 bg-slate-50"
                />
              </div>
            </div>

          </div>

          {/* Table */}
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-100">
                  {[
                    { key: 'name', label: 'Agent / Host' },
                    { key: 'db_type', label: 'Engine' },
                    { key: 'environment', label: 'Env' },
                    { key: 'status', label: 'Status' },
                    { key: 'db_cpu', label: 'DB CPU' },
                    { key: 'active_sessions', label: 'Sessions' },
                    { key: 'last_heartbeat', label: 'Last Seen' },
                  ].map(({ key, label }) => (
                    <th
                      key={key}
                      onClick={() => handleSort(key)}
                      className="text-left px-4 py-2.5 font-semibold text-slate-500 cursor-pointer hover:text-slate-700 select-none whitespace-nowrap"
                    >
                      {label} <SortIcon col={key} />
                    </th>
                  ))}
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {filteredAgents.length === 0 && (
                  <tr>
                    <td colSpan={8} className="text-center py-12 text-slate-400">
                      <Server className="h-8 w-8 mx-auto mb-2 text-slate-200" />
                      No agents match the current filters.
                    </td>
                  </tr>
                )}
                {filteredAgents.map((agent) => {
                  const level = statusLevel(agent.status);
                  const statusColor = STATUS_COLORS[level];
                  const cpu = Number(agent.db_cpu) || 0;
                  return (
                    <tr
                      key={agent.name}
                      onClick={() => navigate(`/agents/${agent.name}`)}
                      className="border-b border-slate-50 hover:bg-blue-50/40 cursor-pointer transition-colors group"
                      style={{ borderLeft: `4px solid ${statusColor}` }}
                    >
                      <td className="px-4 py-3">
                        <div className="font-bold text-slate-800 group-hover:text-blue-600 transition-colors">
                          {agent.name}
                        </div>
                        <div className="text-slate-400 flex items-center gap-1 mt-0.5">
                          <Globe className="h-3 w-3" />
                          {agent.hostname || agent.ip_address || '—'}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <DBTypeBadge type={agent.db_type} />
                      </td>
                      <td className="px-4 py-3">
                        <span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 font-semibold text-xs">
                          {agent.environment || '—'}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <StatusPill status={agent.status} />
                      </td>
                      <td className="px-4 py-3 w-28">
                        <div className="flex flex-col gap-1">
                          <div className="h-1.5 w-full bg-slate-100 rounded-full overflow-hidden">
                            <div
                              className="h-full rounded-full transition-all"
                              style={{ width: `${Math.min(cpu, 100)}%`, backgroundColor: cpuColor(cpu) }}
                            />
                          </div>
                          <span className="text-xs font-bold" style={{ color: cpuColor(cpu) }}>
                            {cpu.toFixed(1)}%
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span className="font-semibold text-slate-700">
                          {(agent.active_sessions ?? 0).toLocaleString()}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-slate-400 whitespace-nowrap">
                        {ago(agent.last_heartbeat)}
                      </td>
                      <td className="px-4 py-3">
                        <ChevronRight className="h-4 w-4 text-slate-300 group-hover:text-blue-500 transition-colors" />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Alerts panel */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm flex flex-col overflow-hidden">
          {/* Header */}
          <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
            <h2 className="text-sm font-bold text-slate-700 flex items-center gap-2">
              <Bell className="h-4 w-4 text-blue-500" />
              Alerts
              {unreadCount > 0 && (
                <span className="bg-red-500 text-white text-xs font-bold px-1.5 py-0.5 rounded-full">
                  {unreadCount}
                </span>
              )}
            </h2>
            <div className="flex items-center gap-2">
              {unreadCount > 0 && (
                <button
                  onClick={markAllRead}
                  className="text-xs text-blue-600 hover:text-blue-800 font-semibold underline underline-offset-2"
                >
                  Mark all read
                </button>
              )}
              <button
                onClick={() => navigate('/alerts')}
                className="text-xs text-slate-500 hover:text-blue-600 flex items-center gap-1 font-medium"
              >
                View all <ArrowRight className="h-3 w-3" />
              </button>
            </div>
          </div>

          {/* Notification list */}
          <div className="flex-1 overflow-y-auto p-3 space-y-2 max-h-[520px]">
            {notifLoading && notifications.length === 0 ? (
              <div className="flex items-center justify-center h-32">
                <Spinner size="tiny" />
              </div>
            ) : notifications.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-32 text-center">
                <CheckCircle className="h-8 w-8 text-green-400 mb-2" />
                <p className="text-sm font-semibold text-slate-600">All Clear</p>
                <p className="text-xs text-slate-400">No active alerts.</p>
              </div>
            ) : (
              notifications.slice(0, 15).map((n, i) => (
                <NotifItem key={n.id ?? i} notif={n} />
              ))
            )}
          </div>

          {/* Footer */}
          <div className="px-4 py-2 border-t border-slate-100 bg-slate-50 flex items-center justify-between">
            <span className="text-xs text-slate-400">
              {notifications.length} total &middot; {unreadCount} unread
            </span>
            <button
              onClick={() => navigate('/alerts')}
              className="text-xs text-blue-600 hover:text-blue-800 font-semibold flex items-center gap-1"
            >
              Manage <ArrowRight className="h-3 w-3" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
