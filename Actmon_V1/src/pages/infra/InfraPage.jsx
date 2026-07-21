import React, { useState, lazy, Suspense } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Server, HardDrive, Cpu, MemoryStick, Activity, RefreshCw, Search,
  Terminal, CheckCircle2, AlertTriangle, XCircle, Globe, Clock, X, Loader2,
  LayoutDashboard, List, Network, ShieldCheck, Database, Gauge as GaugeIcon,
} from 'lucide-react';
import {
  PieChart, Pie, Cell, ResponsiveContainer, ScatterChart, Scatter,
  XAxis, YAxis, ZAxis, CartesianGrid, Tooltip,
} from 'recharts';
import { listOsServers, getServerSummary, getLiveStatus, refreshServerStatus } from '../../api/servers';
import { usePermissions } from '../../hooks/usePermissions';

const XTerminal = lazy(() => import('../../components/terminal/XTerminal'));

const ENV_FILTERS = ['All', 'Production', 'Staging', 'Development', 'Testing'];

/* ── helpers ── */
const statusLevel = (s) => {
  const v = String(s || '').toLowerCase();
  if (['connected', 'online', 'up', 'running', 'healthy'].includes(v)) return 'online';
  if (['warning', 'degraded', 'slow'].includes(v)) return 'warning';
  return 'offline';
};
// cpu/ram/disk arrive as strings like "26%" — parseFloat (NOT Number, which yields NaN).
const pct = (v) => Math.max(0, Math.min(100, Math.round(parseFloat(v) || 0)));
const barColor = (p) => (p > 90 ? '#d13438' : p > 75 ? '#d83b01' : '#0078d4');
const LEVEL_COLOR = { online: '#107c10', warning: '#ff8c00', offline: '#d13438' };
const osMeta = (os) => {
  const v = String(os || '').toLowerCase();
  if (v.includes('win')) return { kind: 'Windows', emoji: '🪟', cls: 'bg-sky-50 text-sky-700 border-sky-200' };
  if (v.includes('linux') || v.includes('ubuntu') || v.includes('rhel') || v.includes('cent') || v.includes('deb'))
    return { kind: 'Linux', emoji: '🐧', cls: 'bg-amber-50 text-amber-700 border-amber-200' };
  return { kind: 'Other', emoji: '💻', cls: 'bg-slate-100 text-slate-600 border-slate-200' };
};
const DB_COLORS = {
  MySQL: '#00758f', PostgreSQL: '#336791', MSSQL: '#a91d22', Oracle: '#c74634',
  MongoDB: '#4db33d', ClickHouse: '#e6b400',
};

function Bar({ icon: Icon, label, pct: p }) {
  const c = barColor(p);
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="flex items-center gap-1 text-[10px] font-bold text-slate-400 uppercase tracking-wide">
          <Icon size={11} /> {label}
        </span>
        <span className="text-[11px] font-black" style={{ color: c }}>{p}%</span>
      </div>
      <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${p}%`, background: c }} />
      </div>
    </div>
  );
}

function HostStatusPill({ level }) {
  const map = {
    online: { cls: 'bg-emerald-100 text-emerald-700', dot: 'bg-emerald-500 animate-pulse', label: 'Online' },
    warning: { cls: 'bg-amber-100 text-amber-700', dot: 'bg-amber-500', label: 'Warning' },
    offline: { cls: 'bg-red-100 text-red-700', dot: 'bg-red-500', label: 'Offline' },
  };
  const m = map[level] || map.offline;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-black ${m.cls}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${m.dot}`} />{m.label}
    </span>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
   Azure-Monitor-style overview building blocks
──────────────────────────────────────────────────────────────────────────── */

// Section band (title + faded rule) — the grey "Application / Security / …" headers.
function SectionBand({ icon: Icon, title, right }) {
  return (
    <div className="flex items-center gap-2.5 mt-7 mb-3 first:mt-0">
      {Icon && <Icon size={18} className="text-slate-400" />}
      <h2 className="text-lg font-black text-slate-800 tracking-tight">{title}</h2>
      <div className="flex-1 h-px bg-slate-200" />
      {right}
    </div>
  );
}

// A white dashboard tile with a light title bar.
function Tile({ title, sub, children, className = '', onClick }) {
  return (
    <div onClick={onClick}
      className={`bg-white rounded-xl border border-slate-200 shadow-sm flex flex-col ${onClick ? 'cursor-pointer hover:shadow-md hover:border-blue-300 transition-all' : ''} ${className}`}>
      <div className="px-4 pt-3.5 pb-2">
        <p className="text-[13px] font-black text-slate-700 leading-tight">{title}</p>
        {sub && <p className="text-[11px] text-slate-400 mt-0.5 uppercase tracking-wide font-semibold">{sub}</p>}
      </div>
      <div className="px-4 pb-4 flex-1 min-h-0">{children}</div>
    </div>
  );
}

// Donut with a big number in the middle + legend rows on the right (Azure Antimalware/Update style).
function DonutStat({ data, centerValue, centerLabel, onSlice }) {
  const total = data.reduce((s, d) => s + d.value, 0);
  const chart = total === 0 ? [{ name: 'none', value: 1, color: '#e9edf3' }] : data;
  return (
    <div className="flex items-center gap-4 h-full">
      <div className="relative flex-shrink-0" style={{ width: 132, height: 132 }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={chart} dataKey="value" cx="50%" cy="50%" innerRadius={44} outerRadius={62}
              startAngle={90} endAngle={-270} stroke="none" paddingAngle={total ? 2 : 0}>
              {chart.map((d, i) => (
                <Cell key={i} fill={d.color} cursor={onSlice && total ? 'pointer' : 'default'}
                  onClick={onSlice && total ? () => onSlice(d) : undefined} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <span className="text-[26px] font-black text-slate-800 leading-none">{centerValue}</span>
          {centerLabel && <span className="text-[10px] font-bold text-slate-400 uppercase mt-1 text-center leading-tight">{centerLabel}</span>}
        </div>
      </div>
      <div className="flex-1 min-w-0 space-y-1.5">
        {data.map((d) => (
          <button key={d.name} onClick={onSlice && d.value ? () => onSlice(d) : undefined}
            className={`w-full flex items-center gap-2 text-left ${onSlice && d.value ? 'hover:opacity-70' : 'cursor-default'}`}>
            <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: d.color }} />
            <span className="text-[12px] text-slate-600 font-semibold truncate flex-1">{d.name}</span>
            <span className="text-[13px] font-black text-slate-800">{d.value}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// Horizontal ranked bar list (top hosts by metric, DB service counts, …).
function RankList({ items, max, unit = '%', empty = 'No data', onItem }) {
  if (!items.length) return <p className="text-[13px] text-slate-400 py-6 text-center">{empty}</p>;
  const top = max ?? Math.max(...items.map((i) => i.value), 1);
  return (
    <div className="space-y-2.5 pt-1">
      {items.map((it) => {
        const w = top ? Math.max(3, (it.value / top) * 100) : 0;
        const c = it.color || barColor(it.value);
        return (
          <button key={it.name} onClick={onItem ? () => onItem(it) : undefined}
            className={`w-full text-left group ${onItem ? '' : 'cursor-default'}`}>
            <div className="flex items-center justify-between mb-1">
              <span className="text-[12px] font-semibold text-slate-600 truncate max-w-[70%] group-hover:text-blue-600">{it.name}</span>
              <span className="text-[12px] font-black" style={{ color: c }}>{it.value}{unit}</span>
            </div>
            <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
              <div className="h-full rounded-full transition-all" style={{ width: `${w}%`, background: c }} />
            </div>
          </button>
        );
      })}
    </div>
  );
}

// Three compact gauges — average CPU / Memory / Disk.
function AvgGauges({ cpu, ram, disk }) {
  const items = [
    { label: 'CPU', value: cpu, color: '#0078d4' },
    { label: 'Memory', value: ram, color: '#5c2d91' },
    { label: 'Disk', value: disk, color: '#0099bc' },
  ];
  return (
    <div className="grid grid-cols-3 gap-2 h-full items-center">
      {items.map((g) => (
        <div key={g.label} className="flex flex-col items-center">
          <div className="relative" style={{ width: 84, height: 84 }}>
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={[{ value: g.value }, { value: 100 - g.value }]} dataKey="value" cx="50%" cy="50%"
                  innerRadius={28} outerRadius={38} startAngle={90} endAngle={-270} stroke="none">
                  <Cell fill={g.color} /><Cell fill="#eef2f7" />
                </Pie>
              </PieChart>
            </ResponsiveContainer>
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="text-[15px] font-black" style={{ color: g.color }}>{g.value}%</span>
            </div>
          </div>
          <span className="text-[11px] font-bold text-slate-500 mt-1">{g.label}</span>
        </div>
      ))}
    </div>
  );
}

function ScatterTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="bg-white border border-slate-200 rounded-lg shadow-lg px-3 py-2 text-[12px]">
      <p className="font-black text-slate-800 mb-0.5">{p.name}</p>
      <p className="text-slate-500">CPU <b className="text-slate-700">{p.x}%</b> · Mem <b className="text-slate-700">{p.y}%</b> · Disk <b className="text-slate-700">{p.z}%</b></p>
    </div>
  );
}

// CPU vs Memory scatter (bubble size = disk) — the "availability scatter" analogue.
function ResourceScatter({ points }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <ScatterChart margin={{ top: 10, right: 12, bottom: 22, left: -8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
        <XAxis type="number" dataKey="x" domain={[0, 100]} tick={{ fontSize: 10, fill: '#94a3b8' }}
          tickLine={false} axisLine={{ stroke: '#e2e8f0' }}
          label={{ value: 'CPU %', position: 'insideBottom', offset: -10, fontSize: 11, fill: '#94a3b8' }} />
        <YAxis type="number" dataKey="y" domain={[0, 100]} width={34} tick={{ fontSize: 10, fill: '#94a3b8' }}
          tickLine={false} axisLine={{ stroke: '#e2e8f0' }}
          label={{ value: 'Mem %', angle: -90, position: 'insideLeft', offset: 18, fontSize: 11, fill: '#94a3b8' }} />
        <ZAxis type="number" dataKey="z" range={[70, 400]} />
        <Tooltip content={<ScatterTooltip />} cursor={{ strokeDasharray: '3 3' }} />
        <Scatter data={points}>
          {points.map((p, i) => <Cell key={i} fill={p.color} fillOpacity={0.75} />)}
        </Scatter>
      </ScatterChart>
    </ResponsiveContainer>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
   Overview dashboard
──────────────────────────────────────────────────────────────────────────── */
function InfraOverview({ hosts, counts, drill }) {
  const lvl = (h) => statusLevel(h.status);
  const avg = (key) => (hosts.length ? Math.round(hosts.reduce((s, h) => s + pct(h[key]), 0) / hosts.length) : 0);
  const avgCpu = avg('cpu_usage'), avgRam = avg('ram_usage'), avgDisk = avg('disk_usage');
  const availability = counts.total ? (counts.online / counts.total) * 100 : 0;

  const statusData = [
    { name: 'Online', value: counts.online, color: LEVEL_COLOR.online, key: 'online' },
    { name: 'Warning', value: counts.warning, color: LEVEL_COLOR.warning, key: 'warning' },
    { name: 'Offline', value: counts.offline, color: LEVEL_COLOR.offline, key: 'offline' },
  ];

  const osGroups = hosts.reduce((m, h) => {
    const k = osMeta(h.os_type).kind; m[k] = (m[k] || 0) + 1; return m;
  }, {});
  const winCount = osGroups.Windows || 0, linCount = osGroups.Linux || 0, otherCount = osGroups.Other || 0;
  const osData = [
    { name: 'Windows', value: winCount, color: '#0078d4' },
    { name: 'Linux', value: linCount, color: '#d83b01' },
    ...(otherCount ? [{ name: 'Other', value: otherCount, color: '#605e5c' }] : []),
  ];

  const envData = ENV_FILTERS.slice(1).map((e, i) => ({
    name: e, value: hosts.filter((h) => h.environment === e).length,
    color: ['#0078d4', '#5c2d91', '#0099bc', '#ff8c00'][i],
  })).filter((d) => d.value);
  const envUnassigned = hosts.filter((h) => !ENV_FILTERS.slice(1).includes(h.environment)).length;
  if (envUnassigned) envData.push({ name: 'Other', value: envUnassigned, color: '#605e5c' });

  const agentCount = hosts.filter((h) => h.collector === 'agent').length;
  const collectorData = [
    { name: 'ActMon Agent', value: agentCount, color: '#0099bc' },
    { name: 'SSH (poll)', value: counts.total - agentCount, color: '#107c10' },
  ];

  const svcCounts = {};
  hosts.forEach((h) => (Array.isArray(h.database_services) ? h.database_services : [])
    .forEach((s) => { svcCounts[s] = (svcCounts[s] || 0) + 1; }));
  const svcData = Object.entries(svcCounts)
    .map(([name, value]) => ({ name, value, color: DB_COLORS[name] || '#605e5c' }))
    .sort((a, b) => b.value - a.value);

  const rank = (key) => hosts
    .map((h) => ({ name: h.server_name || h.hostname || `Host #${h.id}`, value: pct(h[key]), id: h.id }))
    .sort((a, b) => b.value - a.value).slice(0, 6);
  const topCpu = rank('cpu_usage'), topRam = rank('ram_usage'), topDisk = rank('disk_usage');

  const scatter = hosts.map((h) => ({
    name: h.server_name || h.hostname || `Host #${h.id}`,
    x: pct(h.cpu_usage), y: pct(h.ram_usage), z: pct(h.disk_usage),
    color: LEVEL_COLOR[lvl(h)], id: h.id,
  }));

  const attention = hosts.filter((h) => lvl(h) !== 'online');

  return (
    <div>
      {/* ── HEALTH & AVAILABILITY ── */}
      <SectionBand icon={ShieldCheck} title="Health & Availability" />
      <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-4 gap-4">
        <Tile title="Host status" sub={`${counts.total} hosts registered`} className="xl:col-span-2">
          <DonutStat data={statusData} centerValue={counts.total} centerLabel="Total hosts"
            onSlice={(d) => drill(d.key)} />
        </Tile>

        <Tile title="Availability" sub="reachable now">
          <div className="flex flex-col items-center justify-center h-full py-2">
            <p className="text-[44px] font-black leading-none"
              style={{ color: availability >= 99 ? '#107c10' : availability >= 90 ? '#ff8c00' : '#d13438' }}>
              {availability.toFixed(1)}%
            </p>
            <p className="text-[12px] text-slate-500 font-semibold mt-2">{counts.online} of {counts.total} online</p>
            <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden mt-3">
              <div className="h-full rounded-full" style={{ width: `${availability}%`, background: '#107c10' }} />
            </div>
          </div>
        </Tile>

        <Tile title="OS platform" sub="operating systems">
          <div className="flex items-center justify-around h-full">
            <div className="text-center">
              <p className="text-[40px] leading-none">🪟</p>
              <p className="text-[26px] font-black text-slate-800 mt-1 leading-none">{winCount}</p>
              <p className="text-[11px] text-slate-400 font-bold uppercase mt-0.5">Windows</p>
            </div>
            <div className="w-px h-16 bg-slate-100" />
            <div className="text-center">
              <p className="text-[40px] leading-none">🐧</p>
              <p className="text-[26px] font-black text-slate-800 mt-1 leading-none">{linCount}</p>
              <p className="text-[11px] text-slate-400 font-bold uppercase mt-0.5">Linux</p>
            </div>
          </div>
        </Tile>
      </div>

      {/* ── RESOURCE UTILIZATION ── */}
      <SectionBand icon={GaugeIcon} title="Resource Utilization" />
      <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-4 gap-4">
        <Tile title="Average utilization" sub="across all hosts">
          <AvgGauges cpu={avgCpu} ram={avgRam} disk={avgDisk} />
        </Tile>
        <Tile title="Top hosts by CPU" sub="highest first">
          <RankList items={topCpu} max={100} empty="No CPU data" onItem={(it) => drill(null, it.id)} />
        </Tile>
        <Tile title="Top hosts by Memory" sub="highest first">
          <RankList items={topRam} max={100} empty="No memory data" onItem={(it) => drill(null, it.id)} />
        </Tile>
        <Tile title="Top hosts by Disk" sub="highest first">
          <RankList items={topDisk} max={100} empty="No disk data" onItem={(it) => drill(null, it.id)} />
        </Tile>
        <Tile title="CPU vs Memory — all hosts" sub="bubble size = disk usage" className="xl:col-span-2">
          {scatter.length ? <ResourceScatter points={scatter} /> : <p className="text-[13px] text-slate-400 py-10 text-center">No hosts to plot</p>}
        </Tile>
        <Tile title="Needs attention" sub="warning / offline" className="xl:col-span-2">
          {attention.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full py-6 text-center">
              <CheckCircle2 size={30} className="text-emerald-500 mb-2" />
              <p className="text-[14px] font-bold text-slate-600">All hosts healthy</p>
            </div>
          ) : (
            <div className="space-y-1.5 pt-1 max-h-[190px] overflow-y-auto">
              {attention.map((h) => {
                const level = lvl(h);
                return (
                  <button key={h.id} onClick={() => drill(null, h.id)}
                    className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg hover:bg-slate-50 text-left">
                    <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: LEVEL_COLOR[level] }} />
                    <span className="text-[13px] font-bold text-slate-700 truncate flex-1">{h.server_name || h.hostname}</span>
                    <span className="text-[11px] font-mono text-slate-400 truncate hidden sm:inline">{h.ip_address}</span>
                    <span className="text-[10px] font-black uppercase px-2 py-0.5 rounded-full"
                      style={{ background: `${LEVEL_COLOR[level]}18`, color: LEVEL_COLOR[level] }}>{level}</span>
                  </button>
                );
              })}
            </div>
          )}
        </Tile>
      </div>

      {/* ── COMPOSITION & SERVICES ── */}
      <SectionBand icon={Network} title="Composition & Services" />
      <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
        <Tile title="Environments" sub="by deployment stage">
          {envData.length ? <DonutStat data={envData} centerValue={counts.total} centerLabel="Hosts" />
            : <p className="text-[13px] text-slate-400 py-8 text-center">No environment data</p>}
        </Tile>
        <Tile title="Collector" sub="how hosts report">
          <DonutStat data={collectorData} centerValue={counts.total} centerLabel="Hosts" />
        </Tile>
        <Tile title="Database services" sub="monitored engines">
          <RankList items={svcData} unit="" empty="No database services on any host" />
        </Tile>
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
   Page
──────────────────────────────────────────────────────────────────────────── */
export function InfraPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { canHere } = usePermissions();
  const [view, setView] = useState('overview');       // 'overview' | 'hosts'
  const [search, setSearch] = useState('');
  const [envFilter, setEnvFilter] = useState('All');
  const [osFilter, setOsFilter] = useState('All');
  const [statusFilter, setStatusFilter] = useState(null);
  const [terminalServer, setTerminalServer] = useState(null);

  const { data: serversData, isLoading } = useQuery({ queryKey: ['osServers', 'infra'], queryFn: () => listOsServers(), refetchInterval: 60000 });
  const { data: liveData } = useQuery({ queryKey: ['liveStatus'], queryFn: getLiveStatus, refetchInterval: 15000, staleTime: 10000 });
  useQuery({ queryKey: ['serverSummary'], queryFn: getServerSummary, refetchInterval: 30000 });

  const refreshMutation = useMutation({ mutationFn: refreshServerStatus, onSuccess: () => qc.invalidateQueries(['osServers']) });

  const liveMap = {};
  for (const r of (liveData?.data || [])) liveMap[r.id] = r;
  const hosts = (serversData?.data || []).map((s) => (liveMap[s.id] ? { ...s, status: liveMap[s.id].os_status } : s));

  const lvl = (h) => statusLevel(h.status);
  const counts = {
    total: hosts.length,
    online: hosts.filter((h) => lvl(h) === 'online').length,
    warning: hosts.filter((h) => lvl(h) === 'warning').length,
    offline: hosts.filter((h) => lvl(h) === 'offline').length,
  };
  const healthPct = counts.total ? Math.round((counts.online / counts.total) * 100) : 0;
  const osTypes = Array.from(new Set(hosts.map((h) => h.os_type).filter(Boolean)));

  // From an overview tile → jump into the host list (optionally to a specific host).
  const drill = (status, hostId) => {
    if (hostId) { navigate(`/infra/${hostId}`); return; }
    setStatusFilter(status);
    setView('hosts');
  };

  const shown = hosts
    .filter((h) => !statusFilter || lvl(h) === statusFilter)
    .filter((h) => envFilter === 'All' || h.environment === envFilter)
    .filter((h) => osFilter === 'All' || h.os_type === osFilter)
    .filter((h) => {
      if (!search.trim()) return true;
      const q = search.toLowerCase();
      return (h.server_name || '').toLowerCase().includes(q)
        || (h.hostname || '').toLowerCase().includes(q)
        || (h.ip_address || '').includes(search);
    });

  if (isLoading) {
    return <div className="min-h-full flex items-center justify-center bg-[#f1f4f9]"><Loader2 className="animate-spin text-blue-500" size={28} /></div>;
  }

  return (
    <div className="-mx-6 md:-mx-8 min-h-full bg-[#f1f4f9]">
      {/* ── Header ── */}
      <div className="bg-gradient-to-r from-slate-900 via-blue-800 to-sky-700 px-6 pt-3 pb-4 relative overflow-hidden">
        <div className="absolute inset-0 opacity-[0.04]"
          style={{ backgroundImage: 'linear-gradient(#fff 1px,transparent 1px),linear-gradient(90deg,#fff 1px,transparent 1px)', backgroundSize: '28px 28px' }} />
        <div className="relative flex items-center gap-2 text-xs text-slate-300/70 mb-2.5">
          <span>ActMon</span><span>›</span><span className="text-white font-semibold">Infrastructure</span>
        </div>
        <div className="relative flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-sky-400/20 border border-sky-400/40 flex items-center justify-center flex-shrink-0">
              <Server size={18} className="text-sky-200" />
            </div>
            <div>
              <h1 className="text-lg font-black text-white tracking-tight leading-none">Infrastructure</h1>
              <p className="text-sky-200/70 text-[11px] mt-0.5">{counts.total} host{counts.total !== 1 ? 's' : ''} · live OS monitoring</p>
            </div>
          </div>
          <div className="flex items-center gap-2.5 flex-shrink-0">
            {/* Overview / Hosts switch */}
            <div className="flex bg-white/10 border border-white/15 rounded-xl p-0.5 backdrop-blur-sm">
              {[['overview', 'Overview', LayoutDashboard], ['hosts', 'Hosts', List]].map(([k, label, Icon]) => (
                <button key={k} onClick={() => setView(k)}
                  className={`h-8 px-3 rounded-lg text-[12px] font-bold flex items-center gap-1.5 transition-all ${
                    view === k ? 'bg-white text-slate-800 shadow' : 'text-white/70 hover:text-white'}`}>
                  <Icon size={13} /> {label}
                </button>
              ))}
            </div>
            <div className="hidden md:flex items-center gap-2.5 bg-white/10 border border-white/15 rounded-xl px-3 py-1.5 backdrop-blur-sm">
              <span className={`w-2 h-2 rounded-full ${healthPct > 0 ? 'bg-emerald-400 animate-pulse' : 'bg-slate-400'}`} />
              <div>
                <p className="text-white font-black text-[13px] leading-none">{counts.online}/{counts.total}</p>
                <p className="text-sky-200/70 text-[10px] mt-0.5">{healthPct}% online</p>
              </div>
            </div>
            <button onClick={() => { qc.invalidateQueries(['osServers']); qc.invalidateQueries(['liveStatus']); }}
              className="h-9 px-3 rounded-lg bg-white/10 hover:bg-white/20 border border-white/20 text-white text-sm font-semibold flex items-center gap-1.5">
              <RefreshCw size={13} /> Refresh
            </button>
          </div>
        </div>
      </div>

      {/* ── Content ── */}
      <div className="max-w-[1800px] mx-auto px-6 py-6">
        {view === 'overview' ? (
          <InfraOverview hosts={hosts} counts={counts} drill={drill} />
        ) : (
          <>
            {/* Filter bar */}
            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm px-4 py-3 flex flex-wrap items-center gap-2 mb-6">
              <div className="flex items-center gap-1 flex-wrap">
                {ENV_FILTERS.map((env) => (
                  <button key={env} onClick={() => setEnvFilter(env)}
                    className={`h-7 px-3.5 rounded-lg font-bold text-[11px] transition-all ${envFilter === env ? 'bg-slate-900 text-white shadow' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800'}`}>
                    {env}
                  </button>
                ))}
              </div>
              {osTypes.length > 0 && (
                <div className="flex items-center gap-1 ml-2 pl-2 border-l border-slate-200 flex-wrap">
                  <button onClick={() => setOsFilter('All')} className={`h-7 px-3 rounded-lg text-[11px] font-bold ${osFilter === 'All' ? 'bg-blue-600 text-white' : 'text-slate-500 hover:bg-slate-100'}`}>All OS</button>
                  {osTypes.map((os) => (
                    <button key={os} onClick={() => setOsFilter(os)}
                      className={`h-7 px-3 rounded-lg text-[11px] font-bold ${osFilter === os ? 'bg-blue-600 text-white' : 'text-slate-500 hover:bg-slate-100'}`}>{os}</button>
                  ))}
                </div>
              )}
              <div className="relative ml-auto">
                <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search host or IP…"
                  className="h-9 pl-9 pr-3 rounded-xl border border-slate-200 text-sm outline-none focus:border-blue-400 bg-white w-56" />
              </div>
            </div>

            {statusFilter && (
              <div className="flex items-center gap-2 mb-4 -mt-2">
                <span className="text-xs text-slate-500">Filtered by <b className="text-slate-700 capitalize">{statusFilter}</b> · {shown.length} of {hosts.length}</span>
                <button onClick={() => setStatusFilter(null)} className="text-xs font-bold text-blue-600 hover:text-blue-700">Clear</button>
              </div>
            )}

            {/* Host grid */}
            {shown.length === 0 ? (
              <div className="bg-white rounded-2xl border border-dashed border-slate-300 py-16 text-center">
                <Server size={40} className="mx-auto mb-3 text-slate-200" />
                <p className="font-bold text-slate-500">No hosts match the current filters</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
                {shown.map((h) => {
                  const level = lvl(h);
                  const cpu = pct(h.cpu_usage), ram = pct(h.ram_usage), disk = pct(h.disk_usage);
                  const services = Array.isArray(h.database_services) ? h.database_services : [];
                  const barColorTop = LEVEL_COLOR[level];
                  const os = osMeta(h.os_type);
                  return (
                    <div key={h.id} onClick={() => navigate(`/infra/${h.id}`)}
                      className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden hover:shadow-md hover:-translate-y-0.5 transition-all cursor-pointer">
                      <div className="h-1" style={{ background: barColorTop }} />
                      <div className="p-5">
                        <div className="flex items-start justify-between gap-2 mb-3">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-md border ${os.cls}`}>{os.emoji} {h.os_type || os.kind}</span>
                            {h.environment && <span className="text-[10px] font-bold px-2 py-0.5 rounded-md bg-slate-100 text-slate-500">{h.environment}</span>}
                            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-md border ${h.collector === 'agent' ? 'bg-sky-50 text-sky-700 border-sky-200' : 'bg-emerald-50 text-emerald-700 border-emerald-200'}`}>
                              {h.collector === 'agent' ? 'AGENT' : 'SSH'}
                            </span>
                          </div>
                          <HostStatusPill level={level} />
                        </div>

                        <h3 className="text-base font-black text-slate-900 leading-tight truncate">{h.server_name}</h3>
                        <p className="text-[12px] text-slate-400 font-mono flex items-center gap-1 mt-0.5">
                          <Globe size={11} /> {h.hostname || h.ip_address || '—'}
                        </p>

                        <div className="space-y-2.5 mt-4">
                          <Bar icon={Cpu} label="CPU" pct={cpu} />
                          <Bar icon={MemoryStick} label="Memory" pct={ram} />
                          <Bar icon={HardDrive} label="Disk" pct={disk} />
                        </div>

                        <div className="flex items-center justify-between mt-4 pt-3 border-t border-slate-100">
                          <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                            {services.length > 0
                              ? services.slice(0, 3).map((s) => <span key={s} className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-100">{s}</span>)
                              : <span className="text-[10px] text-slate-300">No DB services</span>}
                          </div>
                          <span className="text-[10px] text-slate-400 flex items-center gap-1 flex-shrink-0"><Clock size={10} /> {h.uptime || '—'}</span>
                        </div>

                        <div className="flex gap-2 mt-4">
                          <button onClick={(e) => { e.stopPropagation(); navigate(`/infra/${h.id}`); }}
                            className="flex-1 h-9 rounded-xl bg-blue-600 text-white hover:bg-blue-700 text-[12px] font-bold flex items-center justify-center gap-1.5 transition-all">
                            <Activity size={13} /> Details
                          </button>
                          {canHere('execute') && (
                            <button onClick={(e) => { e.stopPropagation(); setTerminalServer(h); }}
                              className="h-9 px-3 rounded-xl bg-blue-50 text-blue-700 border border-blue-200 hover:bg-blue-100 text-[12px] font-bold flex items-center justify-center gap-1.5 transition-all">
                              <Terminal size={13} /> SSH
                            </button>
                          )}
                          <button onClick={(e) => { e.stopPropagation(); refreshMutation.mutate(h.id); }}
                            className="w-9 h-9 rounded-xl border border-slate-200 text-slate-400 hover:bg-blue-50 hover:text-blue-500 hover:border-blue-300 flex items-center justify-center transition-all"
                            title="Refresh (SSH)">
                            <RefreshCw size={13} className={refreshMutation.isPending && refreshMutation.variables === h.id ? 'animate-spin' : ''} />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>

      {/* ── SSH terminal modal ── */}
      {terminalServer && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setTerminalServer(null)}>
          <div onClick={(e) => e.stopPropagation()} className="relative w-full max-w-4xl h-[70vh] bg-[#0b1220] rounded-2xl shadow-2xl overflow-hidden flex flex-col">
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/10 flex-shrink-0">
              <p className="text-sm font-bold text-white flex items-center gap-2"><Terminal size={14} className="text-emerald-400" /> {terminalServer.server_name} — SSH</p>
              <button onClick={() => setTerminalServer(null)} className="w-7 h-7 rounded-lg bg-white/10 hover:bg-white/20 flex items-center justify-center text-white"><X size={14} /></button>
            </div>
            <div className="flex-1 min-h-0">
              <Suspense fallback={<div className="h-full flex items-center justify-center"><Loader2 className="animate-spin text-emerald-400" size={24} /></div>}>
                <XTerminal serverId={terminalServer.id} serverName={terminalServer.server_name} height="100%" />
              </Suspense>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
