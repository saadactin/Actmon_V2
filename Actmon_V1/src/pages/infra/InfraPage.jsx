import React, { useState, lazy, Suspense } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Server, HardDrive, Cpu, MemoryStick, Activity, RefreshCw, Search,
  Terminal, CheckCircle2, AlertTriangle, XCircle, Globe, Clock, X, Loader2,
} from 'lucide-react';
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
const metric = (v) => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
const barColor = (p) => (p > 90 ? '#dc2626' : p > 75 ? '#d97706' : '#2563eb');
const osMeta = (os) => {
  const v = String(os || '').toLowerCase();
  if (v.includes('win')) return { label: os || 'Windows', cls: 'bg-sky-50 text-sky-700 border-sky-200' };
  if (v.includes('linux') || v.includes('ubuntu') || v.includes('rhel') || v.includes('cent') || v.includes('deb'))
    return { label: os || 'Linux', cls: 'bg-amber-50 text-amber-700 border-amber-200' };
  return { label: os || 'Unknown', cls: 'bg-slate-100 text-slate-600 border-slate-200' };
};

function Bar({ icon: Icon, label, pct }) {
  const c = barColor(pct);
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="flex items-center gap-1 text-[10px] font-bold text-slate-400 uppercase tracking-wide">
          <Icon size={11} /> {label}
        </span>
        <span className="text-[11px] font-black" style={{ color: c }}>{pct}%</span>
      </div>
      <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: c }} />
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

export function InfraPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { canHere } = usePermissions();
  const [search, setSearch] = useState('');
  const [envFilter, setEnvFilter] = useState('All');
  const [osFilter, setOsFilter] = useState('All');
  const [statusFilter, setStatusFilter] = useState(null);
  const [terminalServer, setTerminalServer] = useState(null);

  const { data: serversData, isLoading } = useQuery({ queryKey: ['osServers', 'infra'], queryFn: () => listOsServers(), refetchInterval: 60000 });
  const { data: liveData } = useQuery({ queryKey: ['liveStatus'], queryFn: getLiveStatus, refetchInterval: 15000, staleTime: 10000 });
  const { data: summaryData } = useQuery({ queryKey: ['serverSummary'], queryFn: getServerSummary, refetchInterval: 30000 });

  const refreshMutation = useMutation({ mutationFn: refreshServerStatus, onSuccess: () => qc.invalidateQueries(['osServers']) });

  const liveMap = {};
  for (const r of (liveData?.data || [])) liveMap[r.id] = r;
  const hosts = (serversData?.data || []).map((s) => (liveMap[s.id] ? { ...s, status: liveMap[s.id].os_status } : s));

  // tech-agnostic infra counts
  const lvl = (h) => statusLevel(h.status);
  const counts = {
    total: hosts.length,
    online: hosts.filter((h) => lvl(h) === 'online').length,
    warning: hosts.filter((h) => lvl(h) === 'warning').length,
    offline: hosts.filter((h) => lvl(h) === 'offline').length,
  };
  const avg = (key) => (hosts.length ? Math.round(hosts.reduce((s, h) => s + (Number(h[key]) || 0), 0) / hosts.length) : 0);
  const avgCpu = avg('cpu_usage'), avgRam = avg('ram_usage'), avgDisk = avg('disk_usage');
  const healthPct = counts.total ? Math.round((counts.online / counts.total) * 100) : 0;

  const osTypes = Array.from(new Set(hosts.map((h) => h.os_type).filter(Boolean)));

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

  const KPIS = [
    { key: null, icon: Server, label: 'Total Hosts', value: counts.total, sub: 'registered', iconBg: 'bg-slate-100', iconColor: 'text-slate-500', valueColor: 'text-slate-800', ring: 'ring-slate-300' },
    { key: 'online', icon: CheckCircle2, label: 'Online', value: counts.online, sub: 'reachable', iconBg: 'bg-emerald-50', iconColor: 'text-emerald-500', valueColor: 'text-emerald-600', ring: 'ring-emerald-300' },
    { key: 'warning', icon: AlertTriangle, label: 'Warning', value: counts.warning, sub: 'degraded', iconBg: 'bg-amber-50', iconColor: 'text-amber-500', valueColor: 'text-amber-600', ring: 'ring-amber-300' },
    { key: 'offline', icon: XCircle, label: 'Offline', value: counts.offline, sub: 'unreachable', iconBg: 'bg-red-50', iconColor: 'text-red-500', valueColor: 'text-red-600', ring: 'ring-red-300' },
    { key: '__cpu', icon: Cpu, label: 'Avg CPU', value: `${avgCpu}%`, sub: 'across hosts', iconBg: 'bg-blue-50', iconColor: 'text-blue-500', valueColor: 'text-blue-600' },
    { key: '__ram', icon: MemoryStick, label: 'Avg Memory', value: `${avgRam}%`, sub: 'across hosts', iconBg: 'bg-violet-50', iconColor: 'text-violet-500', valueColor: 'text-violet-600' },
    { key: '__disk', icon: HardDrive, label: 'Avg Disk', value: `${avgDisk}%`, sub: 'across hosts', iconBg: 'bg-cyan-50', iconColor: 'text-cyan-500', valueColor: 'text-cyan-600' },
  ];

  if (isLoading) {
    return <div className="min-h-full flex items-center justify-center bg-[#f1f4f9]"><Loader2 className="animate-spin text-blue-500" size={28} /></div>;
  }

  return (
    <div className="-mx-6 md:-mx-8 min-h-full bg-[#f1f4f9]">
      {/* ── Header (full-bleed cloud-blue, compact) ── */}
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
        {/* KPI cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-3 mb-6">
          {KPIS.map(({ key, icon: Icon, label, value, sub, iconBg, iconColor, valueColor, ring }) => {
            const clickable = key === null || ['online', 'warning', 'offline'].includes(key);
            const active = clickable && (key === statusFilter || (key === null && statusFilter === null));
            const Tag = clickable ? 'button' : 'div';
            return (
              <Tag key={label}
                onClick={clickable ? () => setStatusFilter((p) => (key === null ? null : (p === key ? null : key))) : undefined}
                className={`text-left w-full bg-white rounded-2xl border shadow-sm px-4 py-3 flex items-center gap-3 transition-all ${clickable ? 'cursor-pointer hover:shadow-md hover:-translate-y-0.5' : 'hover:shadow-md'} ${active ? `border-transparent ring-2 ${ring}` : 'border-slate-200'}`}>
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${iconBg} ${iconColor}`}><Icon size={18} /></div>
                <div className="min-w-0">
                  <p className={`text-2xl font-black leading-none ${valueColor}`}>{value}</p>
                  <p className="text-[11px] font-semibold text-slate-600 mt-0.5 truncate">{label}</p>
                  <p className="text-[10px] text-slate-400 truncate">{sub}</p>
                </div>
              </Tag>
            );
          })}
        </div>

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
              const cpu = metric(h.cpu_usage), ram = metric(h.ram_usage), disk = metric(h.disk_usage);
              const services = Array.isArray(h.database_services) ? h.database_services : [];
              const barColorTop = level === 'online' ? '#10b981' : level === 'warning' ? '#f59e0b' : '#ef4444';
              const os = osMeta(h.os_type);
              return (
                <div key={h.id} onClick={() => navigate(`/infra/${h.id}`)}
                  className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden hover:shadow-md hover:-translate-y-0.5 transition-all cursor-pointer">
                  <div className="h-1" style={{ background: barColorTop }} />
                  <div className="p-5">
                    <div className="flex items-start justify-between gap-2 mb-3">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-md border ${os.cls}`}>{os.label}</span>
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
