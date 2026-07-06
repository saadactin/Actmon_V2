import React, { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, RefreshCw, Server, Cpu, MemoryStick, HardDrive, Activity,
  Network, Plug, Wifi, Box, Clock, AlertTriangle, Loader2, Globe, Info,
  Folder, FileText, ChevronRight, Link2, Lock, KeyRound, Eye, EyeOff, X,
} from 'lucide-react';
import { getHostInfraDetail, fsList, fsRead, updateOsServer } from '../../api/servers';

const C = { blue: '#2563eb', green: '#16a34a', amber: '#d97706', red: '#dc2626', violet: '#7c3aed', cyan: '#0891b2', slate: '#475569' };
const pctColor = (p) => (p > 90 ? C.red : p > 75 ? C.amber : C.blue);
const fmtMB = (mb) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`);
const fmtBytes = (b) => {
  if (b == null) return '—';
  if (b >= 1 << 30) return `${(b / (1 << 30)).toFixed(1)} GB`;
  if (b >= 1 << 20) return `${(b / (1 << 20)).toFixed(1)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${b} B`;
};

const TABS = ['Overview', 'Ports', 'Processes', 'Storage', 'Network'];

function Section({ title, icon: Icon, count, color = C.blue, children, action }) {
  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
      <div className="px-5 py-3.5 flex items-center gap-2 border-b border-slate-100">
        {Icon && <Icon size={16} style={{ color }} />}
        <h3 className="font-black text-slate-800 text-[15px]">{title}</h3>
        {count != null && <span className="ml-1 px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 text-[12px] font-bold">{count}</span>}
        {action && <div className="ml-auto">{action}</div>}
      </div>
      <div className="p-5">{children}</div>
    </div>
  );
}

function Stat({ icon: Icon, label, value, sub, color = '#1e293b', iconBg = 'bg-blue-50', iconColor = 'text-blue-500' }) {
  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm px-5 py-4 flex items-center gap-3.5">
      <div className={`w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0 ${iconBg} ${iconColor}`}><Icon size={20} /></div>
      <div className="min-w-0">
        <p className="text-[26px] font-black leading-none" style={{ color }}>{value}</p>
        <p className="text-[13px] font-semibold text-slate-600 mt-1 truncate">{label}</p>
        {sub && <p className="text-[12px] text-slate-400 truncate">{sub}</p>}
      </div>
    </div>
  );
}

function Table({ headers, rows, empty = 'No data' }) {
  if (!rows || rows.length === 0) return <p className="text-[15px] text-slate-400 py-2">{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[14px]">
        <thead><tr className="bg-slate-50 border-b border-slate-200">
          {headers.map((h) => <th key={h} className="px-3.5 py-2.5 text-left text-[12px] font-bold text-slate-400 uppercase whitespace-nowrap">{h}</th>)}
        </tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={`border-b border-slate-100 ${i % 2 ? 'bg-slate-50/40' : ''}`}>
              {r.map((c, j) => <td key={j} className="px-3.5 py-2.5 text-slate-700 align-top">{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ── File Explorer — flow: filesystem → folders → files → file content ── */
function FileExplorer({ serverId, root, onClose }) {
  const qc = useQueryClient();
  const [path, setPath] = useState(root || '/');
  const [file, setFile] = useState(null);           // opened file path
  const [ssh, setSsh] = useState({ user: '', pass: '', port: 22 });
  const [showPass, setShowPass] = useState(false);
  const [saving, setSaving] = useState(false);

  const { data: dir, isFetching, error } = useQuery({
    queryKey: ['fsList', serverId, path],
    queryFn: () => fsList(serverId, path),
    enabled: !file,
    retry: false,
  });
  const { data: doc, isFetching: reading, error: readErr } = useQuery({
    queryKey: ['fsRead', serverId, file],
    queryFn: () => fsRead(serverId, file),
    enabled: !!file,
    retry: false,
  });

  const needsSsh = dir?.needs_ssh || doc?.needs_ssh;
  const errMsg = error?.response?.data?.detail || readErr?.response?.data?.detail;

  const saveSsh = async () => {
    setSaving(true);
    try {
      await updateOsServer(serverId, { ssh_username: ssh.user, ssh_password: ssh.pass, ssh_port: Number(ssh.port) || 22 });
      qc.invalidateQueries({ queryKey: ['fsList', serverId] });
    } finally { setSaving(false); }
  };

  // Breadcrumb segments for the current location.
  const active = file || path;
  const crumbs = active === '/' ? [] : active.replace(/^\/+/, '').split('/');
  const crumbPath = (i) => '/' + crumbs.slice(0, i + 1).join('/');

  return (
    <div className="border border-slate-200 rounded-2xl overflow-hidden">
      {/* Explorer header: breadcrumb path */}
      <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 flex items-center gap-1.5 flex-wrap">
        <HardDrive size={15} className="text-cyan-600 flex-shrink-0" />
        <button onClick={() => { setFile(null); setPath('/'); }} className="text-[14px] font-bold text-blue-600 hover:underline">/</button>
        {crumbs.map((c, i) => (
          <React.Fragment key={i}>
            <ChevronRight size={13} className="text-slate-300" />
            {i === crumbs.length - 1 ? (
              <span className="text-[14px] font-black text-slate-800">{c}</span>
            ) : (
              <button onClick={() => { setFile(null); setPath(crumbPath(i)); }} className="text-[14px] font-bold text-blue-600 hover:underline">{c}</button>
            )}
          </React.Fragment>
        ))}
        <div className="ml-auto flex items-center gap-2">
          {(isFetching || reading) && <Loader2 size={15} className="animate-spin text-blue-500" />}
          <button onClick={onClose} className="w-7 h-7 rounded-lg hover:bg-slate-200 flex items-center justify-center text-slate-500" title="Close explorer"><X size={15} /></button>
        </div>
      </div>

      {/* SSH needed — one-time credential form */}
      {needsSsh && (
        <div className="p-5">
          <div className="flex items-start gap-3 rounded-xl bg-amber-50 border border-amber-200 p-4">
            <Lock size={18} className="text-amber-500 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-[15px] font-black text-slate-800">SSH credentials needed for file browsing</p>
              <p className="text-[14px] text-slate-600 mt-1">{(dir || doc)?.message}</p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-3 max-w-xl">
                <input value={ssh.user} onChange={(e) => setSsh((s) => ({ ...s, user: e.target.value }))} placeholder="SSH username"
                  className="h-10 px-3 rounded-lg border border-slate-300 text-[14px] outline-none focus:border-blue-400 bg-white" />
                <div className="relative">
                  <input value={ssh.pass} type={showPass ? 'text' : 'password'} onChange={(e) => setSsh((s) => ({ ...s, pass: e.target.value }))} placeholder="SSH password"
                    className="w-full h-10 px-3 pr-9 rounded-lg border border-slate-300 text-[14px] outline-none focus:border-blue-400 bg-white" />
                  <button onClick={() => setShowPass((v) => !v)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400">{showPass ? <EyeOff size={14} /> : <Eye size={14} />}</button>
                </div>
                <input value={ssh.port} type="number" onChange={(e) => setSsh((s) => ({ ...s, port: e.target.value }))} placeholder="22"
                  className="h-10 px-3 rounded-lg border border-slate-300 text-[14px] outline-none focus:border-blue-400 bg-white" />
              </div>
              <button onClick={saveSsh} disabled={saving || !ssh.user || !ssh.pass}
                className="mt-3 h-10 px-5 rounded-lg bg-blue-600 text-white text-[14px] font-bold hover:bg-blue-700 disabled:opacity-40 flex items-center gap-2">
                {saving ? <Loader2 size={15} className="animate-spin" /> : <KeyRound size={15} />} Save & Browse
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Error */}
      {!needsSsh && errMsg && (
        <div className="p-5">
          <div className="flex items-center gap-2.5 rounded-xl bg-red-50 border border-red-200 p-3.5 text-[14px] text-red-700">
            <AlertTriangle size={16} className="flex-shrink-0" /> {errMsg}
            {file && <button onClick={() => setFile(null)} className="ml-auto font-bold text-blue-600 hover:underline flex-shrink-0">← Back to folder</button>}
          </div>
        </div>
      )}

      {/* Directory listing */}
      {!needsSsh && !errMsg && !file && dir?.entries && (
        <div className="max-h-[460px] overflow-y-auto">
          <table className="w-full text-[14px]">
            <thead className="sticky top-0 bg-white shadow-[0_1px_0_#e2e8f0]"><tr>
              {['Name', 'Size', 'Modified', 'Owner', 'Permissions'].map((h) => (
                <th key={h} className="px-4 py-2.5 text-left text-[12px] font-bold text-slate-400 uppercase">{h}</th>))}
            </tr></thead>
            <tbody>
              {path !== '/' && (
                <tr className="border-b border-slate-100 hover:bg-blue-50/40 cursor-pointer" onClick={() => setPath(dir.parent)}>
                  <td className="px-4 py-2.5 flex items-center gap-2.5 font-bold text-slate-500" colSpan={1}><Folder size={16} className="text-slate-300" /> ..</td>
                  <td colSpan={4} />
                </tr>
              )}
              {dir.entries.map((e) => {
                const isDir = e.type === 'dir';
                const isLink = e.type === 'link';
                const open = () => {
                  const full = `${path === '/' ? '' : path}/${e.name}`;
                  if (isDir) setPath(full);
                  else if (isLink && e.link_target?.startsWith('/')) setPath(e.link_target);
                  else setFile(full);
                };
                return (
                  <tr key={e.name} onClick={open} className="border-b border-slate-100 hover:bg-blue-50/40 cursor-pointer">
                    <td className="px-4 py-2.5">
                      <span className="flex items-center gap-2.5 font-semibold text-slate-800">
                        {isDir ? <Folder size={16} className="text-amber-500 flex-shrink-0" />
                          : isLink ? <Link2 size={15} className="text-cyan-500 flex-shrink-0" />
                            : <FileText size={15} className="text-blue-400 flex-shrink-0" />}
                        <span className="truncate max-w-[360px]">{e.name}</span>
                        {isLink && e.link_target && <span className="text-[12px] text-slate-400 font-normal">→ {e.link_target}</span>}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-slate-500 whitespace-nowrap">{isDir ? '—' : fmtBytes(e.size)}</td>
                    <td className="px-4 py-2.5 text-slate-500 whitespace-nowrap">{e.modified}</td>
                    <td className="px-4 py-2.5 text-slate-500">{e.owner}</td>
                    <td className="px-4 py-2.5 font-mono text-[12px] text-slate-400">{e.perms}</td>
                  </tr>
                );
              })}
              {dir.entries.length === 0 && (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-[14px] text-slate-400">Empty folder</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* File content viewer */}
      {!needsSsh && !errMsg && file && doc && !doc.needs_ssh && (
        <div>
          <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-100 flex items-center gap-3 text-[13px] text-slate-500">
            <button onClick={() => setFile(null)} className="font-bold text-blue-600 hover:underline flex items-center gap-1"><ArrowLeft size={13} /> Back</button>
            <span className="font-mono">{fmtBytes(doc.size)}</span>
            {doc.truncated && <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 text-[11px] font-bold">showing first {fmtBytes(doc.read_bytes)}</span>}
          </div>
          {doc.binary ? (
            <p className="p-6 text-[14px] text-slate-400">Binary file — preview not available.</p>
          ) : (
            <pre className="p-4 text-[13px] leading-relaxed font-mono text-slate-800 whitespace-pre-wrap break-all max-h-[460px] overflow-y-auto bg-white">{doc.content || '(empty file)'}</pre>
          )}
        </div>
      )}
    </div>
  );
}

export function InfraHostDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [tab, setTab] = useState('Overview');
  const [explorerRoot, setExplorerRoot] = useState(null);   // mount being browsed

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['hostInfraDetail', id],
    queryFn: () => getHostInfraDetail(id),
    retry: false,
    refetchInterval: 30000,
  });

  const host = data?.host || {};
  const failed = data?.status === 'error';

  return (
    <div className="-mx-6 md:-mx-8 min-h-full bg-[#f1f4f9]">
      {/* Header */}
      <div className="bg-gradient-to-r from-slate-900 via-blue-800 to-sky-700 px-6 pt-3 pb-0 relative overflow-hidden">
        <div className="absolute inset-0 opacity-[0.04]"
          style={{ backgroundImage: 'linear-gradient(#fff 1px,transparent 1px),linear-gradient(90deg,#fff 1px,transparent 1px)', backgroundSize: '28px 28px' }} />
        <div className="relative flex items-center gap-2 text-[13px] text-slate-300/70 mb-2.5">
          <button onClick={() => navigate('/infra')} className="hover:text-white">Infrastructure</button>
          <span>›</span><span className="text-white font-semibold">{host.server_name || `Host #${id}`}</span>
        </div>
        <div className="relative flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <button onClick={() => navigate('/infra')} className="w-8 h-8 rounded-lg bg-white/10 hover:bg-white/20 border border-white/10 flex items-center justify-center text-white flex-shrink-0">
              <ArrowLeft size={16} />
            </button>
            <div className="w-10 h-10 rounded-lg bg-sky-400/20 border border-sky-400/40 flex items-center justify-center flex-shrink-0">
              <Server size={19} className="text-sky-200" />
            </div>
            <div>
              <h1 className="text-xl font-black text-white tracking-tight leading-none">{host.server_name || `Host #${id}`}</h1>
              <p className="text-sky-200/70 text-[13px] mt-1 font-mono">{host.hostname || host.ip_address || ''}{host.os_type ? ` · ${host.os_type}` : ''}{host.collector ? ` · via ${host.collector}` : ''}</p>
            </div>
          </div>
          <button onClick={() => qc.invalidateQueries(['hostInfraDetail', id])}
            className="h-9 px-3.5 rounded-lg bg-white/10 hover:bg-white/20 border border-white/20 text-white text-[14px] font-semibold flex items-center gap-1.5">
            <RefreshCw size={14} className={isFetching ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>
        {/* SolarWinds-style tab strip in the hero */}
        <div className="relative flex items-center gap-1 mt-4">
          {TABS.map((t) => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-4 py-2.5 text-[14px] font-bold rounded-t-lg transition-colors ${
                tab === t ? 'bg-[#f1f4f9] text-slate-900' : 'text-sky-100/80 hover:text-white hover:bg-white/10'}`}>
              {t}
            </button>
          ))}
        </div>
      </div>

      <div className="max-w-[1600px] mx-auto px-6 py-6 space-y-4">
        {isLoading ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <Loader2 className="animate-spin text-blue-500 mb-3" size={28} />
            <p className="text-slate-500 font-semibold text-[15px]">Gathering host details…</p>
          </div>
        ) : failed ? (
          <div className="bg-white rounded-2xl border border-red-200 shadow-sm p-8 text-center">
            <AlertTriangle className="mx-auto text-red-400 mb-3" size={32} />
            <p className="font-black text-red-600 text-[16px]">Could not reach this host</p>
            <p className="text-[14px] text-slate-500 mt-1 font-mono break-all">{data?.message}</p>
          </div>
        ) : (
          <>
            {/* Metric strip — always visible */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Stat icon={Cpu} label="CPU Usage" value={data.cpu_pct != null ? `${data.cpu_pct}%` : '—'} color={pctColor(data.cpu_pct || 0)} iconBg="bg-blue-50" iconColor="text-blue-500" />
              <Stat icon={MemoryStick} label="Memory" value={data.memory ? `${data.memory.used_pct}%` : '—'} sub={data.memory ? `${fmtMB(data.memory.used_mb)} / ${fmtMB(data.memory.total_mb)}` : ''} color={pctColor(data.memory?.used_pct || 0)} iconBg="bg-violet-50" iconColor="text-violet-500" />
              <Stat icon={Activity} label="Load (1m)" value={data.load ? data.load.one : '—'} sub={data.load ? `5m ${data.load.five} · 15m ${data.load.fifteen}` : ''} iconBg="bg-amber-50" iconColor="text-amber-500" />
              <Stat icon={Clock} label="Uptime" value={(data.uptime || '—').replace(/^up\s*/, '')} iconBg="bg-emerald-50" iconColor="text-emerald-500" />
            </div>

            {/* ── OVERVIEW ── */}
            {tab === 'Overview' && (
              <Section title="System Information" icon={Info}>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                  {[
                    ['Operating System', data.system?.os],
                    ['Kernel', data.system?.kernel],
                    ['Hostname', data.system?.hostname],
                    ['IP Address', host.ip_address],
                    ['Environment', host.environment],
                    ['Collector', host.collector === 'agent' ? 'ActMon Agent (push)' : 'SSH (poll)'],
                  ].map(([k, v]) => (
                    <div key={k} className="bg-slate-50 border border-slate-100 rounded-xl p-4">
                      <p className="text-[12px] font-bold text-slate-400 uppercase">{k}</p>
                      <p className="text-slate-800 font-semibold text-[15px] mt-1 break-all">{v || '—'}</p>
                    </div>
                  ))}
                </div>
              </Section>
            )}

            {/* ── PORTS ── */}
            {tab === 'Ports' && (
              <Section title="Listening Ports & Process" icon={Plug} count={data.ports?.length} color={C.blue}>
                <Table headers={['Port', 'Address', 'Process', 'PID']}
                  rows={(data.ports || []).map((p) => [
                    <span className="font-mono font-black text-blue-700 text-[15px]">{p.port}</span>,
                    <span className="font-mono text-[13px] text-slate-500">{p.address}</span>,
                    <span className="font-semibold">{p.process}</span>,
                    <span className="font-mono text-slate-400">{p.pid || '—'}</span>,
                  ])} empty="No listening ports detected" />
              </Section>
            )}

            {/* ── PROCESSES ── */}
            {tab === 'Processes' && (
              <Section title="Top Processes" icon={Box} count={data.processes?.length} color={C.violet}>
                <Table headers={['PID', 'User', 'CPU %', 'Memory %', 'Command']}
                  rows={(data.processes || []).map((p) => [
                    <span className="font-mono text-slate-400">{p.pid}</span>,
                    p.user,
                    <span className="font-bold" style={{ color: pctColor(p.cpu) }}>{p.cpu}%</span>,
                    <span className="font-bold" style={{ color: pctColor(p.mem) }}>{p.mem}%</span>,
                    <span className="font-mono text-[13px]">{p.command}</span>,
                  ])} empty="No process data" />
              </Section>
            )}

            {/* ── STORAGE: filesystems → click → file explorer ── */}
            {tab === 'Storage' && (
              <>
                <Section title="Filesystems" icon={HardDrive} count={data.filesystems?.length} color={C.cyan}
                  action={<span className="text-[12px] text-slate-400 font-semibold">Click a mount to browse its folders & files</span>}>
                  <div className="overflow-x-auto">
                    <table className="w-full text-[14px]">
                      <thead><tr className="bg-slate-50 border-b border-slate-200">
                        {['Mount', 'Filesystem', 'Size', 'Used', 'Avail', 'Use %', ''].map((h) => (
                          <th key={h} className="px-3.5 py-2.5 text-left text-[12px] font-bold text-slate-400 uppercase whitespace-nowrap">{h}</th>))}
                      </tr></thead>
                      <tbody>
                        {(data.filesystems || []).map((f, i) => (
                          <tr key={i} onClick={() => setExplorerRoot(f.mount)}
                            className={`border-b border-slate-100 cursor-pointer hover:bg-blue-50/50 ${explorerRoot === f.mount ? 'bg-blue-50' : i % 2 ? 'bg-slate-50/40' : ''}`}>
                            <td className="px-3.5 py-2.5"><span className="flex items-center gap-2 font-bold text-slate-800"><Folder size={15} className="text-amber-500" />{f.mount}</span></td>
                            <td className="px-3.5 py-2.5 font-mono text-[13px] text-slate-500">{f.filesystem}</td>
                            <td className="px-3.5 py-2.5">{f.size}</td>
                            <td className="px-3.5 py-2.5">{f.used}</td>
                            <td className="px-3.5 py-2.5">{f.avail}</td>
                            <td className="px-3.5 py-2.5">
                              <div className="flex items-center gap-2 min-w-[130px]">
                                <div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden"><div className="h-full rounded-full" style={{ width: `${f.use_pct}%`, background: pctColor(f.use_pct) }} /></div>
                                <span className="font-bold text-[13px]" style={{ color: pctColor(f.use_pct) }}>{f.use_pct}%</span>
                              </div>
                            </td>
                            <td className="px-3.5 py-2.5 text-blue-600 font-bold text-[13px] whitespace-nowrap">Browse →</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Section>

                {explorerRoot && (
                  <Section title={`File Explorer — ${explorerRoot}`} icon={Folder} color={C.amber}>
                    <FileExplorer serverId={id} root={explorerRoot} onClose={() => setExplorerRoot(null)} />
                  </Section>
                )}
              </>
            )}

            {/* ── NETWORK ── */}
            {tab === 'Network' && (
              <>
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                  <Section title="Network Interfaces" icon={Network} count={data.interfaces?.length} color={C.green}>
                    <Table headers={['Interface', 'State', 'Addresses']}
                      rows={(data.interfaces || []).map((n) => [
                        <span className="font-mono font-bold text-slate-700">{n.iface}</span>,
                        <span className={`px-2 py-0.5 rounded-full text-[12px] font-bold ${String(n.state).toUpperCase() === 'UP' ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>{n.state}</span>,
                        <span className="font-mono text-[13px] text-slate-500">{(n.addresses || []).join(', ') || '—'}</span>,
                      ])} empty="No interfaces" />
                  </Section>

                  <Section title="Connected Devices" icon={Wifi} count={data.neighbors?.length} color={C.amber}>
                    <Table headers={['IP', 'MAC', 'Interface', 'State']}
                      rows={(data.neighbors || []).map((d) => [
                        <span className="font-mono font-semibold text-slate-700">{d.ip}</span>,
                        <span className="font-mono text-[13px] text-slate-500">{d.mac || '—'}</span>,
                        d.dev || '—',
                        <span className={`text-[13px] font-bold ${String(d.state).toUpperCase() === 'REACHABLE' ? 'text-emerald-600' : 'text-slate-400'}`}>{d.state}</span>,
                      ])} empty="No neighbor devices" />
                  </Section>
                </div>

                <Section title="Active Connections" icon={Globe} count={data.connections?.count} color={C.slate}>
                  {(!data.connections || data.connections.count === 0) ? (
                    <p className="text-[15px] text-slate-400">No established connections</p>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {(data.connections.peers || []).map((p, i) => (
                        <span key={i} className="font-mono text-[13px] px-2.5 py-1 rounded-lg bg-slate-50 border border-slate-200 text-slate-600">{p}</span>
                      ))}
                    </div>
                  )}
                </Section>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
