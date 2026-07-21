import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAgentsList } from '../hooks/useAgents';
import { listActiveAlerts } from '../api/alerts';
import { usePermissions } from '../hooks/usePermissions';
import { listOsServers, getServerSummary } from '../api/servers';
import { listAccounts } from '../api/cloud';
import { Spinner } from '@fluentui/react-components';
import {
  PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, RadialBarChart, RadialBar, Legend,
} from 'recharts';
import {
  Server, CheckCircle, Bell, ArrowRight, RefreshCw, Activity, ChevronRight,
  Database, Cloud, Cpu, ShieldCheck, Settings, Bot, Brain, HardDrive,
  MemoryStick, TrendingUp,
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
const pct = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
const avg = (arr) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0);

const osCounts = (list) => ({
  total:   list.length,
  online:  list.filter((s) => s.status === 'Connected').length,
  warning: list.filter((s) => s.status === 'Warning').length,
  offline: list.filter((s) => s.status !== 'Connected' && s.status !== 'Warning').length,
});

const DB_TECHS = [
  { id: 'mysql',      name: 'MySQL',      emoji: '🐬', color: '#ea580c' },
  { id: 'postgresql', name: 'PostgreSQL', emoji: '🐘', color: '#4f46e5' },
  { id: 'oracle',     name: 'Oracle',     emoji: '☀️', color: '#dc2626' },
  { id: 'mssql',      name: 'SQL Server', emoji: '🖥️', color: '#0284c7' },
  { id: 'mongodb',    name: 'MongoDB',    emoji: '🍃', color: '#059669' },
  { id: 'clickhouse', name: 'ClickHouse', emoji: '⚡', color: '#d97706' },
];
function serverMatchesTech(server, tech) {
  const svcs = (server.database_services || []).map((s) => s.toLowerCase());
  if (tech === 'mysql') return svcs.some((s) => s === 'mysql' || s === 'mariadb');
  return svcs.some((s) => s === tech);
}

const ST = { online: '#22c55e', warning: '#f59e0b', offline: '#ef4444' };
// ─── clean light chart tooltips (no black boxes, clear short labels) ─────────
const TipCard = ({ title, line, dot }) => (
  <div className="bg-white border border-slate-200 shadow-lg rounded-lg px-3 py-1.5">
    <div className="text-[12px] font-bold text-slate-800 flex items-center gap-1.5">
      {dot && <span className="w-2 h-2 rounded-full" style={{ background: dot }} />}{title}
    </div>
    <div className="text-[11px] text-slate-500 mt-0.5">{line}</div>
  </div>
);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
// pies / status donuts — payload[0].name is the slice
const CountTip = ({ active, payload, noun = 'items' }) =>
  active && payload?.length ? <TipCard title={payload[0].name} line={plural(payload[0].value, noun)} dot={payload[0].payload?.color || payload[0].color} /> : null;
// top-hosts CPU bar — label is the host
const CpuTip = ({ active, payload, label }) =>
  active && payload?.length ? <TipCard title={label} line={`CPU ${payload[0].value}%`} /> : null;
// radial resource gauges — payload[0].payload.name
const ResTip = ({ active, payload }) =>
  active && payload?.length ? <TipCard title={payload[0].payload?.name} line={`${payload[0].value}% used`} dot={payload[0].payload?.fill} /> : null;
// servers-by-technology stacked bar — label is the engine
const TechTip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  const g = (k) => payload.find((p) => p.dataKey === k)?.value ?? 0;
  return <TipCard title={label} line={`Online ${g('online')} · Warning ${g('warning')} · Offline ${g('offline')}`} />;
};
// alerts-by-severity bar — payload[0].payload.name
const SevTip = ({ active, payload }) =>
  active && payload?.length ? <TipCard title={payload[0].payload?.name} line={plural(payload[0].value, 'alert')} dot={payload[0].payload?.color} /> : null;
const ENVS = ['Production', 'UAT', 'Development', 'Testing'];
const ENV_COLORS = { Production: '#2563eb', UAT: '#7c3aed', Development: '#0891b2', Testing: '#65a30d', Other: '#94a3b8' };

// ─── UI pieces ───────────────────────────────────────────────────────────────
const Kpi = ({ icon, iconBg, iconColor, value, label, sub, onClick }) => (
  <button onClick={onClick}
    className="group text-left bg-white rounded-2xl border border-slate-200 shadow-sm px-4 py-3 flex items-center gap-3 transition-all hover:shadow-md hover:-translate-y-0.5 hover:border-slate-300">
    <div className={`w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0 ${iconBg} ${iconColor}`}>{icon}</div>
    <div className="min-w-0 flex-1">
      <div className="text-2xl font-black text-slate-800 leading-none">{value}</div>
      <div className="text-[12px] font-bold text-slate-600 mt-0.5 truncate">{label}</div>
      {sub && <div className="text-[10px] text-slate-400 truncate">{sub}</div>}
    </div>
    <ChevronRight className="h-4 w-4 text-slate-300 group-hover:text-blue-500 transition-colors flex-shrink-0" />
  </button>
);

const Panel = ({ title, icon, action, children, className = '' }) => (
  <div className={`bg-white rounded-2xl border border-slate-200 shadow-sm flex flex-col ${className}`}>
    <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
      <h2 className="text-[13px] font-black text-slate-700 flex items-center gap-2">{icon}{title}</h2>
      {action}
    </div>
    <div className="p-4 flex-1">{children}</div>
  </div>
);

const NotifItem = ({ notif }) => {
  const sev = notif.severity?.toLowerCase();
  const bc = sev === 'critical' ? '#ef4444' : sev === 'warning' ? '#f59e0b' : '#3b82f6';
  const bg = sev === 'critical' ? '#fef2f2' : sev === 'warning' ? '#fffbeb' : '#eff6ff';
  const tc = sev === 'critical' ? '#991b1b' : sev === 'warning' ? '#92400e' : '#1e40af';
  return (
    <div className="p-2.5 rounded-lg text-xs leading-relaxed" style={{ borderLeft: `3px solid ${bc}`, backgroundColor: bg }}>
      <div className="flex items-center justify-between mb-1">
        <span className="font-bold text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wide" style={{ backgroundColor: bc, color: '#fff' }}>{notif.severity}</span>
        <span className="text-slate-400 text-[10px]">{ago(notif.timestamp || notif.created_at)}</span>
      </div>
      {(notif.source || notif.agent_name) && <div className="font-semibold text-slate-600 mb-0.5 text-[11px]">{notif.source || notif.agent_name}</div>}
      <p style={{ color: tc }}>{notif.message}</p>
    </div>
  );
};

const donutLabel = (total, subtitle) => (
  <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
    <span className="text-3xl font-black text-slate-800 leading-none">{total}</span>
    <span className="text-[10px] font-semibold text-slate-400 mt-0.5">{subtitle}</span>
  </div>
);

// ─── Main ──────────────────────────────────────────────────────────────────
export const Dashboard = () => {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { can, isHub, isGoverned } = usePermissions();
  const showModule = (r) => can(r, 'view') || isHub(r) || !isGoverned(r);

  const { data: serversData, isLoading } = useQuery({ queryKey: ['dashOsServers'], queryFn: () => listOsServers(), refetchInterval: 60000 });
  const { data: summaryData } = useQuery({ queryKey: ['dashServerSummary'], queryFn: getServerSummary, refetchInterval: 30000 });
  const { data: cloudAccounts } = useQuery({ queryKey: ['dashCloudAccounts'], queryFn: listAccounts, retry: false, refetchInterval: 60000 });
  const { data: agents = [] } = useAgentsList(true);
  // same gated feed as the Alerts page (shared query cache) → both stay in sync
  const { data: activeAlerts = [] } = useQuery({ queryKey: ['activeAlerts'], queryFn: listActiveAlerts, refetchInterval: 15000 });

  const [clock, setClock] = useState(new Date());
  useEffect(() => { const t = setInterval(() => setClock(new Date()), 1000); return () => clearInterval(t); }, []);
  const [countdown, setCountdown] = useState(30);
  const refreshAll = () => {
    ['dashOsServers', 'dashServerSummary', 'dashCloudAccounts'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
    setCountdown(30);
  };
  useEffect(() => {
    const t = setInterval(() => setCountdown((c) => { if (c <= 1) { refreshAll(); return 30; } return c - 1; }), 1000);
    return () => clearInterval(t);
  }, []); // eslint-disable-line

  const allServers = serversData?.data || [];
  const infra = summaryData || {};
  const infraCounts = {
    total: infra.total ?? allServers.length,
    online: infra.connected ?? osCounts(allServers).online,
    warning: infra.warning ?? osCounts(allServers).warning,
    offline: infra.disconnected ?? osCounts(allServers).offline,
  };
  const infraHealth = infraCounts.total ? Math.round((infraCounts.online / infraCounts.total) * 100) : 0;

  const perTech = useMemo(() => {
    const m = {};
    DB_TECHS.forEach((t) => { m[t.id] = osCounts(allServers.filter((s) => serverMatchesTech(s, t.id))); });
    return m;
  }, [allServers]);
  const dbServers = useMemo(() => allServers.filter((s) => DB_TECHS.some((t) => serverMatchesTech(s, t.id))), [allServers]);
  const dbCounts = osCounts(dbServers);

  const agentCounts = useMemo(() => ({
    total: agents.length,
    online: agents.filter((a) => statusLevel(a.status) === 'online').length,
    warning: agents.filter((a) => statusLevel(a.status) === 'warning').length,
    offline: agents.filter((a) => ['critical', 'offline'].includes(statusLevel(a.status))).length,
  }), [agents]);

  const cloudList = Array.isArray(cloudAccounts) ? cloudAccounts : [];

  // ── chart datasets ──
  const healthData = [
    { name: 'Online', value: infraCounts.online, color: ST.online },
    { name: 'Warning', value: infraCounts.warning, color: ST.warning },
    { name: 'Offline', value: infraCounts.offline, color: ST.offline },
  ].filter((d) => d.value > 0);

  const allowedTechs = DB_TECHS.filter((t) => can(`/${t.id}-servers`, 'view'));
  const dbTechs = allowedTechs.length ? allowedTechs : DB_TECHS;
  const canDb = allowedTechs.length > 0 || showModule('/databases');

  const techBar = dbTechs.map((t) => ({ id: t.id, name: t.name, color: t.color, ...perTech[t.id] }));
  const enginePie = techBar.filter((t) => t.total > 0).map((t) => ({ id: t.id, name: t.name, value: t.total, color: t.color }));

  const topCpu = useMemo(() => allServers
    .map((s) => ({ name: s.server_name || s.ip_address || '—', cpu: pct(s.cpu_usage) }))
    .filter((s) => s.cpu > 0)
    .sort((a, b) => b.cpu - a.cpu)
    .slice(0, 8)
    .map((s) => ({ ...s, name: s.name.length > 16 ? s.name.slice(0, 15) + '…' : s.name })), [allServers]);

  const resAvg = useMemo(() => {
    const cpu = allServers.map((s) => pct(s.cpu_usage)).filter((v) => v > 0);
    const ram = allServers.map((s) => pct(s.ram_usage)).filter((v) => v > 0);
    const disk = allServers.map((s) => pct(s.disk_usage)).filter((v) => v > 0);
    return { cpu: avg(cpu), ram: avg(ram), disk: avg(disk) };
  }, [allServers]);
  const radialData = [
    { name: 'Disk', value: resAvg.disk, fill: '#3b82f6' },
    { name: 'RAM', value: resAvg.ram, fill: '#a855f7' },
    { name: 'CPU', value: resAvg.cpu, fill: '#f97316' },
  ];

  const envPie = useMemo(() => {
    const m = {};
    allServers.forEach((s) => { const e = ENVS.includes(s.environment) ? s.environment : 'Other'; m[e] = (m[e] || 0) + 1; });
    return Object.entries(m).map(([name, value]) => ({ name, value, color: ENV_COLORS[name] || '#94a3b8' }));
  }, [allServers]);

  const cloudPie = useMemo(() => {
    const m = {};
    cloudList.forEach((a) => { const p = (a.provider || a.cloud_provider || 'Other').toUpperCase(); m[p] = (m[p] || 0) + 1; });
    const C = { AWS: '#ff9900', AZURE: '#0078d4', OCI: '#c74634', GCP: '#ea4335', OTHER: '#94a3b8' };
    return Object.entries(m).map(([name, value]) => ({ name, value, color: C[name] || '#94a3b8' }));
  }, [cloudList]);

  const alertsBySev = useMemo(() => {
    const m = { Critical: 0, Warning: 0, Info: 0 };
    activeAlerts.forEach((n) => {
      const s = (n.severity || 'info').toLowerCase();
      if (s === 'critical') m.Critical++; else if (s === 'warning') m.Warning++; else m.Info++;
    });
    return [
      { name: 'Critical', value: m.Critical, color: '#ef4444' },
      { name: 'Warning', value: m.Warning, color: '#f59e0b' },
      { name: 'Info', value: m.Info, color: '#3b82f6' },
    ];
  }, [activeAlerts]);

  const clockStr = clock.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const dateStr = clock.toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });

  const goTech = (id) => id && navigate(`/${id}-servers`);
  const pickId = (d) => d?.id || d?.payload?.id;

  if (isLoading && allServers.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4">
        <Spinner size="large" /><p className="text-slate-500 text-sm font-medium">Loading ACTMON dashboard…</p>
      </div>
    );
  }

  // ActMon AI is reachable via the floating widget + sidebar; no header button needed.
  const tiles = [].filter((t) => showModule(t.route));

  return (
    <div className="-mx-6 md:-mx-8 min-h-full bg-[#f1f4f9]">

      {/* HERO */}
      <div className="bg-gradient-to-r from-slate-900 via-blue-800 to-sky-700 px-6 md:px-8 pt-3 pb-4 relative overflow-hidden sticky top-0 z-30 shadow-md">
        <div className="absolute inset-0 opacity-[0.04]"
          style={{ backgroundImage: 'linear-gradient(#fff 1px,transparent 1px),linear-gradient(90deg,#fff 1px,transparent 1px)', backgroundSize: '28px 28px' }} />
        <div className="relative flex items-center gap-2 text-xs text-slate-300/70 mb-2.5">
          <span>ActMon</span><ChevronRight size={11} /><span className="text-white font-semibold">Dashboard</span>
        </div>
        <div className="relative flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-sky-400/20 border border-sky-400/40 flex items-center justify-center flex-shrink-0">
              <Activity size={18} className="text-sky-200" />
            </div>
            <div>
              <h1 className="text-lg font-black text-white tracking-tight leading-none">Monitoring Overview</h1>
              <p className="text-sky-200/70 text-[11px] mt-0.5">Live analytics across every ActMon module</p>
            </div>
          </div>
          <div className="flex items-center gap-3 flex-shrink-0">
            {tiles.length > 0 && (
              <div className="hidden lg:flex items-center gap-1.5">
                {tiles.map((t) => (
                  <button key={t.route} onClick={() => navigate(t.route)} title={t.title}
                    className="h-8 px-2.5 rounded-lg bg-white/10 hover:bg-white/20 border border-white/15 text-white text-[11px] font-semibold flex items-center gap-1.5 transition-colors">
                    {t.icon}<span className="hidden xl:inline">{t.title}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="text-right">
              <div className="text-xl font-mono font-bold text-white tabular-nums leading-none">{clockStr}</div>
              <div className="text-[10px] text-sky-200/70 mt-0.5">{dateStr}</div>
            </div>
            <div className="flex flex-col items-center gap-0.5">
              <button onClick={refreshAll} title="Refresh now"
                className="w-9 h-9 flex items-center justify-center rounded-lg bg-white/10 hover:bg-white/20 border border-white/15 text-white transition-colors">
                <RefreshCw className="h-4 w-4" />
              </button>
              <span className="text-[10px] text-sky-200/60 tabular-nums">{countdown}s</span>
            </div>
          </div>
        </div>
      </div>

      <div className="px-6 md:px-8 py-6 space-y-6 max-w-[1800px] mx-auto">

        {/* KPI strip */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          {canDb && <Kpi icon={<Database className="h-5 w-5" />} iconBg="bg-blue-50" iconColor="text-blue-600" value={dbCounts.total} label="Database Servers" sub={`${dbCounts.online} online · ${dbCounts.offline} offline`} onClick={() => navigate('/databases')} />}
          {showModule('/infra') && <Kpi icon={<Server className="h-5 w-5" />} iconBg="bg-emerald-50" iconColor="text-emerald-600" value={infraCounts.total} label="Infra Hosts" sub={`${infraHealth}% healthy`} onClick={() => navigate('/infra')} />}
          {showModule('/cloud') && <Kpi icon={<Cloud className="h-5 w-5" />} iconBg="bg-sky-50" iconColor="text-sky-600" value={cloudList.length} label="Cloud Accounts" sub={cloudPie.map((c) => c.name).join(' · ') || 'None'} onClick={() => navigate('/cloud')} />}
          {showModule('/agents') && <Kpi icon={<Cpu className="h-5 w-5" />} iconBg="bg-violet-50" iconColor="text-violet-600" value={agentCounts.total} label="Agents" sub={`${agentCounts.online} online`} onClick={() => navigate('/agents')} />}
          {showModule('/alerts') && <Kpi icon={<Bell className="h-5 w-5" />} iconBg="bg-amber-50" iconColor="text-amber-600" value={activeAlerts.length} label="Active Alerts" sub={`${alertsBySev[0].value} critical · ${alertsBySev[1].value} warning`} onClick={() => navigate('/alerts')} />}
        </div>

        {/* Alerts row — surfaced first so problems are visible before the charts */}
        {showModule('/alerts') && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <Panel title="Alerts by Severity" icon={<Bell size={14} className="text-amber-500" />}>
              <div style={{ height: 220 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={alertsBySev} margin={{ top: 10, right: 10, left: -18, bottom: 0 }} barCategoryGap="30%">
                    <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" vertical={false} />
                    <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#64748b' }} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#94a3b8' }} />
                    <Tooltip content={<SevTip />} cursor={{ fill: '#f1f5f9' }} />
                    <Bar dataKey="value" name="Alerts" radius={[6, 6, 0, 0]} barSize={54}>
                      {alertsBySev.map((e, i) => <Cell key={i} fill={e.color} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Panel>

            <Panel title="Recent Alerts" icon={<Bell size={14} className="text-blue-500" />} className="lg:col-span-2"
              action={
                <button onClick={() => navigate('/alerts')} className="text-[11px] text-slate-500 hover:text-blue-600 flex items-center gap-1 font-medium">View all <ArrowRight size={11} /></button>
              }>
              <div className="overflow-y-auto space-y-2 pr-1" style={{ maxHeight: 240 }}>
                {activeAlerts.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-40 text-center">
                    <CheckCircle className="h-8 w-8 text-green-400 mb-2" />
                    <p className="text-sm font-semibold text-slate-600">All Clear</p>
                    <p className="text-xs text-slate-400">No active alerts.</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {activeAlerts.slice(0, 10).map((nf, i) => <NotifItem key={nf.id ?? i} notif={nf} />)}
                  </div>
                )}
              </div>
            </Panel>
          </div>
        )}

        {/* Charts row 1 */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Fleet health donut */}
          <Panel title="Fleet Health" icon={<Activity size={14} className="text-emerald-500" />}
            action={<span className="text-[11px] font-bold text-emerald-600">{infraHealth}% healthy</span>}>
            <div className="relative" style={{ height: 220 }}>
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={healthData.length ? healthData : [{ name: 'No data', value: 1, color: '#e2e8f0' }]}
                    dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={62} outerRadius={90} paddingAngle={2} stroke="none">
                    {(healthData.length ? healthData : [{ color: '#e2e8f0' }]).map((e, i) => <Cell key={i} fill={e.color} />)}
                  </Pie>
                  <Tooltip content={<CountTip noun="host" />} />
                </PieChart>
              </ResponsiveContainer>
              {donutLabel(infraCounts.total, 'total hosts')}
            </div>
            <div className="flex items-center justify-center gap-4 mt-1">
              {[['Online', infraCounts.online, ST.online], ['Warning', infraCounts.warning, ST.warning], ['Offline', infraCounts.offline, ST.offline]].map(([l, v, c]) => (
                <div key={l} className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-500">
                  <span className="w-2.5 h-2.5 rounded-full" style={{ background: c }} />{l} <b className="text-slate-700">{v}</b>
                </div>
              ))}
            </div>
          </Panel>

          {/* Servers by technology (clickable) */}
          {canDb && (
            <Panel title="Servers by Technology" icon={<Database size={14} className="text-blue-500" />}
              action={<button onClick={() => navigate('/databases')} className="text-[11px] font-bold text-blue-600 hover:text-blue-700 flex items-center gap-1">All <ArrowRight size={11} /></button>}>
              <div style={{ height: 240 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={techBar} margin={{ top: 6, right: 6, left: -18, bottom: 0 }} barCategoryGap="22%">
                    <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" vertical={false} />
                    <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#64748b' }} interval={0} angle={-18} textAnchor="end" height={46} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#94a3b8' }} />
                    <Tooltip content={<TechTip />} cursor={{ fill: '#f1f5f9' }} />
                    <Bar dataKey="online" stackId="s" name="Online" fill={ST.online} radius={[0, 0, 0, 0]} cursor="pointer" onClick={(d) => goTech(pickId(d))} />
                    <Bar dataKey="warning" stackId="s" name="Warning" fill={ST.warning} cursor="pointer" onClick={(d) => goTech(pickId(d))} />
                    <Bar dataKey="offline" stackId="s" name="Offline" fill={ST.offline} radius={[4, 4, 0, 0]} cursor="pointer" onClick={(d) => goTech(pickId(d))} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <p className="text-center text-[10px] text-slate-400 mt-1">Click a bar to open that technology’s servers</p>
            </Panel>
          )}

          {/* Engine distribution pie (clickable) */}
          {canDb && (
            <Panel title="Engine Distribution" icon={<Database size={14} className="text-indigo-500" />}>
              {enginePie.length ? (
                <div className="flex items-center gap-2" style={{ height: 240 }}>
                  <ResponsiveContainer width="60%" height="100%">
                    <PieChart>
                      <Pie data={enginePie} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={88} innerRadius={0} paddingAngle={1} stroke="#fff" strokeWidth={2}
                        cursor="pointer" onClick={(d) => goTech(pickId(d))}>
                        {enginePie.map((e, i) => <Cell key={i} fill={e.color} />)}
                      </Pie>
                      <Tooltip content={<CountTip noun="server" />} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="flex-1 space-y-1.5">
                    {enginePie.map((e) => (
                      <button key={e.id} onClick={() => goTech(e.id)} className="w-full flex items-center gap-2 text-[11px] font-semibold text-slate-600 hover:text-slate-900 group">
                        <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: e.color }} />
                        <span className="truncate group-hover:underline">{e.name}</span>
                        <span className="ml-auto font-black text-slate-800">{e.value}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : <div className="flex items-center justify-center text-slate-400 text-sm" style={{ height: 240 }}>No database servers yet</div>}
            </Panel>
          )}
        </div>

        {/* Charts row 2 */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Top hosts by CPU */}
          <Panel title="Top Hosts by CPU" icon={<TrendingUp size={14} className="text-orange-500" />} className="lg:col-span-1">
            {topCpu.length ? (
              <div style={{ height: 240 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={topCpu} layout="vertical" margin={{ top: 4, right: 26, left: 6, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" horizontal={false} />
                    <XAxis type="number" domain={[0, 100]} tick={{ fontSize: 10, fill: '#94a3b8' }} unit="%" />
                    <YAxis type="category" dataKey="name" width={104} tick={{ fontSize: 10, fill: '#475569' }} />
                    <Tooltip content={<CpuTip />} cursor={{ fill: '#f1f5f9' }} />
                    <Bar dataKey="cpu" radius={[0, 4, 4, 0]} barSize={14}>
                      {topCpu.map((s, i) => <Cell key={i} fill={s.cpu >= 85 ? '#ef4444' : s.cpu >= 65 ? '#f59e0b' : '#22c55e'} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            ) : <div className="flex items-center justify-center text-slate-400 text-sm" style={{ height: 240 }}>No CPU data</div>}
          </Panel>

          {/* Avg resource usage — radial */}
          <Panel title="Avg Resource Usage" icon={<Cpu size={14} className="text-purple-500" />}>
            <div className="relative" style={{ height: 200 }}>
              <ResponsiveContainer width="100%" height="100%">
                <RadialBarChart innerRadius="35%" outerRadius="100%" data={radialData} startAngle={90} endAngle={-270}>
                  <RadialBar minAngle={2} background={{ fill: '#f1f5f9' }} dataKey="value" cornerRadius={8} />
                  <Tooltip content={<ResTip />} />
                </RadialBarChart>
              </ResponsiveContainer>
            </div>
            <div className="flex items-center justify-center gap-4 mt-1">
              {[['CPU', resAvg.cpu, '#f97316', <Cpu size={12} key="c" />], ['RAM', resAvg.ram, '#a855f7', <MemoryStick size={12} key="m" />], ['Disk', resAvg.disk, '#3b82f6', <HardDrive size={12} key="d" />]].map(([l, v, c, ic]) => (
                <div key={l} className="flex flex-col items-center">
                  <span className="flex items-center gap-1 text-[11px] font-bold" style={{ color: c }}>{ic}{l}</span>
                  <span className="text-lg font-black text-slate-800 leading-none">{v}%</span>
                </div>
              ))}
            </div>
          </Panel>

          {/* Environment / Cloud distribution */}
          <Panel title={cloudPie.length ? 'Cloud by Provider' : 'Hosts by Environment'} icon={cloudPie.length ? <Cloud size={14} className="text-sky-500" /> : <Server size={14} className="text-blue-500" />}>
            {(cloudPie.length ? cloudPie : envPie).length ? (
              <div className="flex items-center gap-2" style={{ height: 232 }}>
                <ResponsiveContainer width="58%" height="100%">
                  <PieChart>
                    <Pie data={cloudPie.length ? cloudPie : envPie} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={44} outerRadius={84} paddingAngle={2} stroke="#fff" strokeWidth={2}>
                      {(cloudPie.length ? cloudPie : envPie).map((e, i) => <Cell key={i} fill={e.color} />)}
                    </Pie>
                    <Tooltip content={<CountTip noun={cloudPie.length ? 'account' : 'host'} />} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="flex-1 space-y-1.5">
                  {(cloudPie.length ? cloudPie : envPie).map((e) => (
                    <div key={e.name} className="flex items-center gap-2 text-[11px] font-semibold text-slate-600">
                      <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: e.color }} />
                      <span className="truncate">{e.name}</span>
                      <span className="ml-auto font-black text-slate-800">{e.value}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : <div className="flex items-center justify-center text-slate-400 text-sm" style={{ height: 232 }}>No data</div>}
          </Panel>
        </div>

      </div>
    </div>
  );
};
