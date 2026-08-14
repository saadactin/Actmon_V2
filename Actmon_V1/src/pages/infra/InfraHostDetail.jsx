import React, { useState, useEffect } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, RefreshCw, Server, Cpu, MemoryStick, HardDrive, Activity,
  Network, Plug, Wifi, Box, Clock, AlertTriangle, Loader2, Globe, Info,
  Folder, FileText, ChevronRight, Link2, Route, ShieldCheck, Ban, Plus, Trash2,
  Power, Eye, EyeOff, X, Check, FileEdit, Save,
  Play, Square, RotateCw, Search, Settings2, Radio, Terminal, Database, Download,
} from 'lucide-react';
import {
  Cell, ResponsiveContainer, ScatterChart, Scatter,
  XAxis, YAxis, ZAxis, CartesianGrid, Tooltip,
} from 'recharts';
import {
  getHostInfraDetail, getNetConfig, listFirewall, addFirewallRule, deleteFirewallRule,
  listServices, restartService, rebootHost, getNetFiles, fsList, fsRead, fsWrite,
  serviceAction, netDiag, killProcess, regGet, regSet, runCommand, updateAgent,
} from '../../api/servers';
import Gauge from '../../components/gauges/Gauge';
import { DashboardScopeProvider } from '../../context/DashboardAppearanceContext';
import { PasswordPrompt, errText } from '../../components/ui/PasswordPrompt';

const C = { blue: '#2563eb', green: '#16a34a', amber: '#d97706', red: '#dc2626', violet: '#7c3aed', cyan: '#0891b2', slate: '#475569' };
const pctColor = (p) => (p > 90 ? C.red : p > 75 ? C.amber : C.blue);
// A process %'s should always read 0–100 (guards against a stale agent that once
// reported memory in MB rather than %).
const pctNum = (v) => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));

// Parse one route line (Windows "dest via gw dev iface metric N" or Linux `ip route`)
// into structured columns.
const parseRoute = (line) => {
  const t = String(line || '').trim().split(/\s+/);
  const grab = (key) => { const i = t.indexOf(key); return i >= 0 && t[i + 1] ? t[i + 1] : null; };
  const dest = t[0] === 'default' ? '0.0.0.0/0' : (t[0] || '');
  return {
    dest,
    isDefault: t[0] === 'default' || dest === '0.0.0.0/0',
    via: grab('via'),
    dev: grab('dev') || (t.indexOf('dev') === -1 && grab('interface')) || null,
    metric: grab('metric'),
    scope: grab('scope'),
    src: grab('src'),
    raw: String(line || ''),
  };
};
const fmtMB = (mb) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`);
const fmtBytes = (b) => {
  if (b == null) return '—';
  if (b >= 1 << 30) return `${(b / (1 << 30)).toFixed(1)} GB`;
  if (b >= 1 << 20) return `${(b / (1 << 20)).toFixed(1)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${b} B`;
};

const TABS = ['Overview', 'Ports', 'Processes', 'Storage', 'Network', 'Services', 'Diagnostics', 'IP Configuration', 'Config Files'];

const BarRow = ({ label, pct, right, color }) => (
  <div className="py-1.5">
    <div className="flex items-center justify-between text-[13px] mb-1">
      <span className="font-semibold text-slate-700 truncate max-w-[60%]">{label}</span>
      <span className="font-bold" style={{ color }}>{right}</span>
    </div>
    <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
      <div className="h-full rounded-full" style={{ width: `${Math.min(100, pct)}%`, background: color }} />
    </div>
  </div>
);

// Live IP configuration — interfaces, addresses, gateway, DNS, routes.
function IpConfigPanel({ id }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['netConfig', id], queryFn: () => getNetConfig(id), retry: false, refetchInterval: 60000,
  });
  const err = error ? errText(error, 'Could not read network configuration.') : null;
  return (
    <Section title="IP Configuration" icon={Route} color={C.blue}
      action={data?.source && <span className="text-[12px] font-bold text-slate-400">via {data.source}</span>}>
      {isLoading ? <p className="text-[15px] text-slate-400 flex items-center gap-2"><Loader2 size={15} className="animate-spin" /> Reading network configuration…</p>
        : err ? <p className="text-[15px] text-red-500">{err}</p>
          : !data ? <p className="text-[15px] text-slate-400">No network configuration available.</p>
          : (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                <div className="bg-slate-50 border border-slate-100 rounded-xl p-3">
                  <p className="text-[12px] font-bold text-slate-400 uppercase">Default Gateway</p>
                  <p className="font-mono font-semibold text-slate-800 text-[14px] mt-0.5">{data.gateway || '—'}</p>
                </div>
                <div className="bg-slate-50 border border-slate-100 rounded-xl p-3">
                  <p className="text-[12px] font-bold text-slate-400 uppercase">DNS Servers</p>
                  <p className="font-mono font-semibold text-slate-800 text-[14px] mt-0.5">{(data.dns?.nameservers || []).join(', ') || '—'}</p>
                </div>
                <div className="bg-slate-50 border border-slate-100 rounded-xl p-3 md:col-span-2">
                  <p className="text-[12px] font-bold text-slate-400 uppercase">Search Domain</p>
                  <p className="font-mono font-semibold text-slate-800 text-[14px] mt-0.5">{data.dns?.search || '—'}</p>
                </div>
              </div>
              <Table headers={['Interface', 'State', 'MAC', 'IP Addresses']}
                rows={(data.interfaces || []).map((n) => [
                  <span className="font-mono font-bold text-slate-700">{n.iface}</span>,
                  <span className={`px-2 py-0.5 rounded-full text-[12px] font-bold ${String(n.state).toUpperCase() === 'UP' ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>{n.state}</span>,
                  <span className="font-mono text-[13px] text-slate-500">{n.mac || '—'}</span>,
                  <span className="font-mono text-[13px] text-slate-600">{(n.addresses || []).join('  ·  ') || '—'}</span>,
                ])} empty="No interfaces" />
              {(data.routes || []).length > 0 && (
                <div className="mt-4">
                  <p className="text-[12px] font-bold text-slate-400 uppercase mb-1.5">Routing Table</p>
                  <div className="max-h-72 overflow-y-auto border border-slate-200 rounded-xl">
                    <table className="w-full text-[13px]">
                      <thead className="sticky top-0"><tr className="bg-slate-100 border-b border-slate-200">
                        {['Destination', 'Gateway', 'Interface', 'Metric'].map((h) => (
                          <th key={h} className="px-3.5 py-2 text-left text-[11px] font-bold text-slate-500 uppercase tracking-wide whitespace-nowrap">{h}</th>))}
                      </tr></thead>
                      <tbody>
                        {data.routes.map(parseRoute).map((r, i) => (
                          <tr key={i} className={`border-b border-slate-100 ${i % 2 ? 'bg-slate-50/40' : ''}`}>
                            <td className="px-3.5 py-2 font-mono font-semibold text-slate-700 whitespace-nowrap">
                              {r.isDefault ? <span>default <span className="text-slate-400 font-normal">(0.0.0.0/0)</span></span> : r.dest}
                            </td>
                            <td className="px-3.5 py-2 font-mono text-slate-600 whitespace-nowrap">
                              {r.via && r.via !== '0.0.0.0' ? r.via : <span className="text-slate-400">On-link</span>}
                            </td>
                            <td className="px-3.5 py-2 text-slate-600 whitespace-nowrap">{r.dev || '—'}</td>
                            <td className="px-3.5 py-2 font-mono text-slate-500">{r.metric ?? '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}
    </Section>
  );
}

// Advanced: edit real network config files, then apply by restarting networking.
function NetConfigEditor({ id }) {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ['netFiles', id], queryFn: () => getNetFiles(id), retry: false });
  const [openPath, setOpenPath] = useState(null);
  const [draft, setDraft] = useState('');
  const [orig, setOrig] = useState('');
  const [loadingFile, setLoadingFile] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);
  const [dirtyApplied, setDirtyApplied] = useState(false);   // saved a change → offer restart
  const [restart, setRestart] = useState(null);              // preset unit for RestartModal
  const [newPath, setNewPath] = useState('');                // "add config file" path
  const err = error ? errText(error, 'Could not detect network config files.') : null;

  // Map a config file → the service to restart so the change takes effect.
  const netUnits = data?.net_units || [];
  const unitFor = (p = '') => {
    const s = p.toLowerCase();
    if (s.includes('netplan') || s.includes('systemd/network')) return netUnits.find((u) => u.includes('networkd')) || 'systemd-networkd';
    if (s.includes('resolv.conf')) return netUnits.find((u) => u.includes('resolved')) || 'systemd-resolved';
    if (s.endsWith('interfaces')) return netUnits.find((u) => u.includes('networking')) || 'networking';
    return netUnits[0] || 'networking';
  };

  const openFile = async (p) => {
    setOpenPath(p); setMsg(null); setLoadingFile(true);
    try {
      const d = await fsRead(id, p);
      if (d.needs_ssh) { setMsg({ ok: false, text: d.message }); setDraft(''); }
      else if (d.binary) { setMsg({ ok: false, text: 'This file is binary and cannot be edited here.' }); setDraft(''); }
      else { setDraft(d.content || ''); setOrig(d.content || ''); }
    } catch (e) { setMsg({ ok: false, text: errText(e, 'Could not open file.') }); }
    finally { setLoadingFile(false); }
  };
  const save = async () => {
    setSaving(true); setMsg(null);
    try {
      await fsWrite(id, openPath, draft);
      setOrig(draft); setDirtyApplied(true);
      setMsg({ ok: true, text: 'Saved. A .actmon.bak backup was kept. Restart networking to apply the change.' });
    } catch (e) { setMsg({ ok: false, text: errText(e, 'Save failed.') }); }
    finally { setSaving(false); }
  };

  const netUnit = (data?.net_units || [])[0];

  return (
    <Section title="Edit Network Config" icon={FileEdit} color={C.blue}
      action={netUnit && <button onClick={() => setRestart(netUnit)}
        className="text-[13px] font-bold text-white bg-amber-600 hover:bg-amber-700 px-3 py-1.5 rounded-lg flex items-center gap-1.5"><Power size={13} /> Restart Networking</button>}>
      {isLoading ? <p className="text-[15px] text-slate-400 flex items-center gap-2"><Loader2 size={15} className="animate-spin" /> Detecting config files…</p>
        : err ? <p className="text-[15px] text-red-500">{err}</p>
          : !data ? <p className="text-[15px] text-slate-400">No editable network config files found.</p>
          : (
            <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-4">
              {/* file list */}
              <div className="space-y-1.5">
                <p className="text-[12px] font-bold text-slate-400 uppercase mb-1">Config Files</p>
                {(data.files || []).map((f) => (
                  <div key={f.path}
                    className={`w-full px-3 py-2.5 rounded-lg border transition-all flex items-center gap-2 ${
                      openPath === f.path ? 'border-blue-400 bg-blue-50' : 'border-slate-200 hover:border-blue-300 hover:bg-slate-50'}`}>
                    <button onClick={() => openFile(f.path)} className="flex items-center gap-2.5 min-w-0 flex-1 text-left">
                      <FileText size={16} className="text-blue-400 flex-shrink-0" />
                      <span className="min-w-0">
                        <span className="block text-[14px] font-bold text-slate-800 truncate">{f.label}</span>
                        <span className="block text-[12px] font-mono text-slate-400 truncate">{f.path}</span>
                      </span>
                    </button>
                    <button onClick={() => openFile(f.path)} title="Edit this file"
                      className="w-7 h-7 rounded-lg text-slate-400 hover:text-blue-600 hover:bg-blue-100 flex items-center justify-center flex-shrink-0">
                      <FileEdit size={14} />
                    </button>
                    <button onClick={() => setRestart(unitFor(f.path))} title={`Restart ${unitFor(f.path)}`}
                      className="w-7 h-7 rounded-lg text-slate-400 hover:text-amber-600 hover:bg-amber-100 flex items-center justify-center flex-shrink-0">
                      <Power size={14} />
                    </button>
                  </div>
                ))}
                {(data.files || []).length === 0 && <p className="text-[14px] text-slate-400">No known network config files found.</p>}

                {/* Add / open an arbitrary config file (created on save if missing) */}
                <div className="flex items-center gap-1.5 pt-2 mt-1 border-t border-slate-100">
                  <input value={newPath} onChange={(e) => setNewPath(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && newPath.trim()) { openFile(newPath.trim()); setNewPath(''); } }}
                    placeholder="/etc/…  add or open a file"
                    className="flex-1 h-9 px-2.5 rounded-lg border border-slate-300 text-[12px] font-mono outline-none focus:border-blue-400" />
                  <button onClick={() => { if (newPath.trim()) { openFile(newPath.trim()); setNewPath(''); } }} disabled={!newPath.trim()}
                    title="Open / add file"
                    className="h-9 px-2.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 flex items-center gap-1 text-[12px] font-bold">
                    <Plus size={14} /> Add
                  </button>
                </div>
                {netUnit && <p className="text-[12px] text-slate-400 mt-2">Active networking service: <span className="font-mono font-bold text-slate-600">{netUnit}</span></p>}
              </div>

              {/* editor */}
              <div>
                {!openPath ? (
                  <div className="min-h-[440px] flex items-center justify-center text-center border-2 border-dashed border-slate-200 rounded-xl">
                    <p className="text-[15px] text-slate-400">Select a config file on the left to view &amp; edit it.</p>
                  </div>
                ) : loadingFile ? (
                  <div className="min-h-[440px] flex items-center justify-center"><Loader2 size={20} className="animate-spin text-blue-500" /></div>
                ) : (
                  <>
                    <div className="flex items-center gap-2 mb-2">
                      <span className="font-mono text-[13px] font-bold text-slate-700">{openPath}</span>
                      {draft !== orig && <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 text-[11px] font-bold">unsaved changes</span>}
                      <div className="ml-auto flex gap-2">
                        <button onClick={() => setDraft(orig)} disabled={draft === orig}
                          className="h-9 px-3 rounded-lg border border-slate-300 text-slate-600 text-[13px] font-bold hover:bg-slate-100 disabled:opacity-40">Revert</button>
                        <button onClick={save} disabled={saving || draft === orig}
                          className="h-9 px-4 rounded-lg bg-emerald-600 text-white text-[13px] font-bold hover:bg-emerald-700 disabled:opacity-40 flex items-center gap-1.5">
                          {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save
                        </button>
                      </div>
                    </div>
                    <textarea value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false}
                      className="w-full h-[calc(100vh-340px)] min-h-[440px] p-3.5 rounded-xl border border-slate-300 text-[13px] leading-relaxed font-mono text-slate-800 outline-none focus:border-blue-400 resize-y bg-slate-900/[0.02]" />
                    {msg && <p className={`text-[13px] font-semibold mt-2 flex items-center gap-1.5 ${msg.ok ? 'text-emerald-600' : 'text-red-600'}`}>
                      {msg.ok ? <Check size={14} /> : <AlertTriangle size={14} />}{msg.text}</p>}
                    {dirtyApplied && (
                      <div className="mt-3 rounded-lg bg-amber-50 border border-amber-200 p-3 flex items-center gap-3">
                        <Power size={17} className="text-amber-600 flex-shrink-0" />
                        <p className="text-[14px] text-amber-800 flex-1">Config saved. Apply it by restarting <span className="font-mono font-bold">{unitFor(openPath)}</span>.</p>
                        <button onClick={() => setRestart(unitFor(openPath))} className="h-9 px-4 rounded-lg bg-amber-600 text-white text-[13px] font-bold hover:bg-amber-700 flex items-center gap-1.5">
                          <Power size={13} /> Restart {unitFor(openPath)}
                        </button>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
      {restart && <RestartModal id={id} hostName="" presetUnit={restart} title={`Restart ${restart}`} onClose={() => { setRestart(null); qc.invalidateQueries({ queryKey: ['netFiles', id] }); }} />}
    </Section>
  );
}

// Firewall — IP whitelist (allow) / blacklist (block) manager (nftables 'actmon').
function FirewallPanel({ id }) {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ['firewall', id], queryFn: () => listFirewall(id), retry: false,
  });
  const [ip, setIp] = useState('');
  const [action, setAction] = useState('block');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const err = error ? errText(error, 'Could not load firewall rules.') : null;

  const add = async () => {
    if (!ip.trim()) return;
    setBusy(true); setMsg(null);
    try {
      await addFirewallRule(id, ip.trim(), action);
      setIp(''); qc.invalidateQueries({ queryKey: ['firewall', id] });
    } catch (e) { setMsg(errText(e, 'Failed to add rule.')); }
    finally { setBusy(false); }
  };
  const remove = async (handle) => {
    setBusy(true); setMsg(null);
    try { await deleteFirewallRule(id, handle); qc.invalidateQueries({ queryKey: ['firewall', id] }); }
    catch (e) { setMsg(errText(e, 'Failed to remove rule.')); }
    finally { setBusy(false); }
  };

  const rules = data?.rules || [];
  const allow = rules.filter((r) => r.action === 'allow');
  const block = rules.filter((r) => r.action === 'block');

  return (
    <Section title="Firewall — IP Whitelist / Blacklist" icon={ShieldCheck} color={C.violet}
      action={data?.source && <span className="text-[12px] font-bold text-slate-400">via {data.source}</span>}>
      {/* Add form */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <input value={ip} onChange={(e) => setIp(e.target.value)} placeholder="IP address or CIDR (e.g. 10.0.0.5 or 192.168.1.0/24)"
          onKeyDown={(e) => e.key === 'Enter' && add()}
          className="flex-1 min-w-[240px] h-10 px-3.5 rounded-lg border border-slate-300 text-[14px] font-mono outline-none focus:border-blue-400" />
        <div className="flex rounded-lg border border-slate-300 overflow-hidden">
          <button onClick={() => setAction('allow')} className={`px-4 h-10 text-[13px] font-bold flex items-center gap-1.5 ${action === 'allow' ? 'bg-emerald-500 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>
            <ShieldCheck size={14} /> Allow
          </button>
          <button onClick={() => setAction('block')} className={`px-4 h-10 text-[13px] font-bold flex items-center gap-1.5 border-l border-slate-300 ${action === 'block' ? 'bg-red-500 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>
            <Ban size={14} /> Block
          </button>
        </div>
        <button onClick={add} disabled={busy || !ip.trim()}
          className="h-10 px-5 rounded-lg bg-blue-600 text-white text-[14px] font-bold hover:bg-blue-700 disabled:opacity-40 flex items-center gap-1.5">
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />} Add Rule
        </button>
      </div>
      {msg && <p className="text-[14px] text-red-600 mb-3">{msg}</p>}

      {isLoading ? <p className="text-[15px] text-slate-400 flex items-center gap-2"><Loader2 size={15} className="animate-spin" /> Loading rules…</p>
        : err ? <p className="text-[15px] text-red-500">{err}</p>
          : rules.length === 0 ? (
            <p className="text-[15px] text-slate-400">No firewall rules yet. Allowed IPs bypass restrictions; blocked IPs are dropped at the host.</p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <p className="text-[12px] font-bold text-emerald-600 uppercase mb-1.5 flex items-center gap-1.5"><ShieldCheck size={13} /> Whitelist ({allow.length})</p>
                {allow.length === 0 && <p className="text-[14px] text-slate-400">None</p>}
                {allow.map((r) => (
                  <div key={r.handle} className="flex items-center justify-between py-2 px-3 rounded-lg bg-emerald-50 border border-emerald-100 mb-1.5">
                    <span className="font-mono font-semibold text-emerald-800 text-[14px]">{r.ip}</span>
                    <button onClick={() => remove(r.handle)} disabled={busy} className="text-slate-400 hover:text-red-500"><Trash2 size={15} /></button>
                  </div>
                ))}
              </div>
              <div>
                <p className="text-[12px] font-bold text-red-600 uppercase mb-1.5 flex items-center gap-1.5"><Ban size={13} /> Blacklist ({block.length})</p>
                {block.length === 0 && <p className="text-[14px] text-slate-400">None</p>}
                {block.map((r) => (
                  <div key={r.handle} className="flex items-center justify-between py-2 px-3 rounded-lg bg-red-50 border border-red-100 mb-1.5">
                    <span className="font-mono font-semibold text-red-800 text-[14px]">{r.ip}</span>
                    <button onClick={() => remove(r.handle)} disabled={busy} className="text-slate-400 hover:text-red-500"><Trash2 size={15} /></button>
                  </div>
                ))}
              </div>
            </div>
          )}
    </Section>
  );
}

// Services inventory + control (start / stop / restart, each password-gated).
function ServicesPanel({ id }) {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ['services', id], queryFn: () => listServices(id), retry: false, refetchInterval: 30000 });
  const [q, setQ] = useState('');
  const [prompt, setPrompt] = useState(null);
  const err = error ? errText(error, 'Could not load services.') : null;
  const services = data?.services || [];
  const shown = services.filter((s) => {
    const t = q.trim().toLowerCase();
    return !t || s.unit.toLowerCase().includes(t) || (s.description || '').toLowerCase().includes(t);
  });
  const stColor = (s) => (s === 'running' ? 'bg-emerald-100 text-emerald-700' : s === 'failed' ? 'bg-red-100 text-red-700' : 'bg-slate-100 text-slate-500');
  const cap = (a) => a.charAt(0).toUpperCase() + a.slice(1);

  return (
    <Section title="Services" icon={Settings2} color={C.violet} count={services.length}
      action={<div className="relative"><Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter services…"
          className="h-8 w-52 pl-8 pr-3 rounded-lg border border-slate-300 text-[13px] outline-none focus:border-blue-400" /></div>}>
      {isLoading ? <p className="text-[15px] text-slate-400 flex items-center gap-2"><Loader2 size={15} className="animate-spin" /> Loading services…</p>
        : err ? <p className="text-[15px] text-red-500">{err}</p>
          : services.length === 0 ? <p className="text-[15px] text-slate-400">No services reported.</p>
            : (
              <div className="overflow-x-auto">
                <table className="w-full text-[14px]">
                  <thead><tr className="bg-slate-50 border-b border-slate-200">
                    {['Service', 'Status', 'Control'].map((h) => <th key={h} className="px-3.5 py-2.5 text-left text-[12px] font-bold text-slate-400 uppercase whitespace-nowrap">{h}</th>)}
                  </tr></thead>
                  <tbody>
                    {shown.map((s) => (
                      <tr key={s.unit} className="border-b border-slate-100 hover:bg-slate-50/50">
                        <td className="px-3.5 py-2.5">
                          <p className="font-bold text-slate-800 font-mono text-[13px]">{s.unit}</p>
                          {s.description && <p className="text-[12px] text-slate-400 truncate max-w-[420px]">{s.description}</p>}
                        </td>
                        <td className="px-3.5 py-2.5"><span className={`px-2 py-0.5 rounded-full text-[11px] font-black uppercase ${stColor(s.status)}`}>{s.status}</span></td>
                        <td className="px-3.5 py-2.5">
                          <div className="flex items-center gap-1.5">
                            <button onClick={() => setPrompt({ unit: s.unit, action: 'start' })} disabled={s.status === 'running'} title="Start"
                              className="h-8 px-2.5 rounded-lg bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100 disabled:opacity-40 flex items-center gap-1 text-[12px] font-bold"><Play size={12} /> Start</button>
                            <button onClick={() => setPrompt({ unit: s.unit, action: 'stop' })} disabled={s.status !== 'running'} title="Stop"
                              className="h-8 px-2.5 rounded-lg bg-red-50 text-red-700 border border-red-200 hover:bg-red-100 disabled:opacity-40 flex items-center gap-1 text-[12px] font-bold"><Square size={12} /> Stop</button>
                            <button onClick={() => setPrompt({ unit: s.unit, action: 'restart' })} title="Restart"
                              className="h-8 px-2.5 rounded-lg bg-amber-50 text-amber-700 border border-amber-200 hover:bg-amber-100 flex items-center gap-1 text-[12px] font-bold"><RotateCw size={12} /> Restart</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                    {shown.length === 0 && <tr><td colSpan={3} className="px-3.5 py-8 text-center text-slate-400 text-[14px]">No services match “{q}”.</td></tr>}
                  </tbody>
                </table>
              </div>
            )}
      {prompt && <PasswordPrompt title={`${cap(prompt.action)} — ${prompt.unit}`} confirmLabel={cap(prompt.action)} danger={prompt.action === 'stop'}
        onConfirm={(pw) => serviceAction(id, prompt.unit, prompt.action, pw).then((r) => { qc.invalidateQueries({ queryKey: ['services', id] }); return r; })}
        onClose={() => setPrompt(null)} />}
    </Section>
  );
}

// One diagnostic tool card (ping / TCP port test / DNS) — read-only, live.
function DiagTool({ id, kind, icon: Icon, color, title, desc, needsPort }) {
  const [target, setTarget] = useState('');
  const [port, setPort] = useState(kind === 'port' ? '22' : '');
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    if (!target.trim()) return;
    setBusy(true); setRes(null);
    try { const r = await netDiag(id, kind, target.trim(), needsPort ? port : undefined); setRes(r); }
    catch (e) { setRes({ output: errText(e, 'Failed.'), reachable: false }); }
    finally { setBusy(false); }
  };
  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
      <div className="px-5 py-3.5 flex items-center gap-2 border-b border-slate-100">
        <Icon size={16} style={{ color }} /><h3 className="font-black text-slate-800 text-[15px]">{title}</h3>
      </div>
      <div className="p-5">
        <p className="text-[13px] text-slate-500 mb-3">{desc}</p>
        <div className="flex flex-wrap items-center gap-2">
          <input value={target} onChange={(e) => setTarget(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && run()}
            placeholder="host or IP (e.g. 192.168.0.114)"
            className="flex-1 min-w-[200px] h-10 px-3 rounded-lg border border-slate-300 text-[14px] font-mono outline-none focus:border-blue-400" />
          {needsPort && <input value={port} onChange={(e) => setPort(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && run()}
            placeholder="port" className="w-24 h-10 px-3 rounded-lg border border-slate-300 text-[14px] font-mono outline-none focus:border-blue-400" />}
          <button onClick={run} disabled={busy || !target.trim()}
            className="h-10 px-5 rounded-lg text-white text-[14px] font-bold disabled:opacity-40 flex items-center gap-1.5" style={{ background: color }}>
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Play size={14} />} Run
          </button>
        </div>
        {res && (
          <div className="mt-3">
            <div className="flex items-center gap-2 mb-1.5">
              <span className={`px-2 py-0.5 rounded-full text-[11px] font-black ${res.reachable ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
                {res.reachable ? '● Reachable' : '● Unreachable'}
              </span>
              {res.source && <span className="text-[11px] text-slate-400 font-bold">via {res.source}</span>}
            </div>
            <pre className="bg-slate-900 text-emerald-300 rounded-xl p-3.5 text-[12.5px] font-mono whitespace-pre-wrap break-all max-h-72 overflow-y-auto">{res.output}</pre>
          </div>
        )}
      </div>
    </div>
  );
}

function DiagnosticsPanel({ id }) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <DiagTool id={id} kind="ping" icon={Radio} color="#2563eb" title="Ping" desc="ICMP reachability & round-trip time to a host." />
      <DiagTool id={id} kind="port" needsPort icon={Plug} color="#7c3aed" title="TCP Port Test" desc="Is a TCP port open? (like  Test-NetConnection host -Port 22)" />
      <DiagTool id={id} kind="dns" icon={Globe} color="#0891b2" title="DNS Lookup" desc="Resolve a hostname to its IP addresses." />
    </div>
  );
}

/* ── Enterprise Network dashboard ── */
const CONN_STATE_ORDER = ['ESTABLISHED', 'LISTEN', 'TIME_WAIT', 'CLOSE_WAIT', 'FIN_WAIT', 'SYN_SENT', 'SYN_RECEIVED', 'LAST_ACK', 'CLOSING', 'CLOSED'];
const netUp = (s) => String(s || '').toLowerCase() === 'up';
const numFmt = (v) => (v == null ? '—' : Number(v).toLocaleString());
const mbpsFmt = (v) => (v == null ? '—' : `${v} Mbps`);

function NetKpi({ label, value, sub, accent = 'cyan' }) {
  const acc = { cyan: 'border-l-cyan-500', green: 'border-l-green-500', blue: 'border-l-blue-500', violet: 'border-l-violet-500', orange: 'border-l-orange-500', red: 'border-l-red-500', slate: 'border-l-slate-400' };
  return (
    <div className={`bg-white rounded-xl border border-slate-200 border-l-4 ${acc[accent] || acc.slate} p-3.5`}>
      <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wide">{label}</p>
      <p className="text-[20px] font-black text-slate-800 mt-1 leading-none truncate">{value}</p>
      {sub && <p className="text-[11px] text-slate-400 mt-1 truncate">{sub}</p>}
    </div>
  );
}

function NetworkPanel({ data, id, navigate }) {
  const [view, setView] = useState(null);
  const [layout, setLayout] = useState('grid');

  const net = data.network || {};
  const ifaces = net.interfaces || (data.interfaces || []).map((i) => ({
    name: i.iface, status: i.state, mac: i.mac,
    ipv4: (i.addresses || []).filter((a) => !a.includes(':')),
    ipv6: (i.addresses || []).filter((a) => a.includes(':')),
  }));
  const upCount = ifaces.filter((i) => netUp(i.status)).length;
  const states = net.conn_states || {};
  const tcpTotal = net.tcp_total ?? data.connections?.count ?? 0;
  const udp = net.udp_count ?? 0;
  const arp = net.arp || data.neighbors || [];
  const routes = net.routes || data.routes || [];
  const gateway = net.gateway || '—';
  const dns = net.dns || data.dns?.nameservers || [];
  const wifi = net.wifi;
  const ports = data.ports || [];
  const gwMac = (arp.find((a) => a.ip === net.gateway) || {}).mac;
  const primaryIp = ifaces.map((i) => (i.ipv4 || [])[0]).find(Boolean) || '—';
  const hasRates = net.total_download_mbps != null;
  const totalErrors = ifaces.reduce((s, i) => s + (i.rx_errors || 0) + (i.tx_errors || 0) + (i.rx_dropped || 0) + (i.tx_dropped || 0), 0);

  const CARDS = [
    { key: 'iface_details', title: 'Network Interface Details', desc: 'MAC, MTU, speed, IPs, driver & type per interface.', icon: Network, color: '#2563eb', count: ifaces.length },
    { key: 'realtime', title: 'Real-Time Traffic', desc: 'Live upload/download throughput & packet rates.', icon: Activity, color: '#0891b2' },
    { key: 'conn_stats', title: 'Connection Statistics', desc: 'TCP states: established, listen, time_wait, etc.', icon: Link2, color: '#7c3aed', count: tcpTotal },
    { key: 'errors', title: 'Network Errors', desc: 'Receive/send errors & dropped packets.', icon: AlertTriangle, color: '#dc2626', count: totalErrors },
    { key: 'iface_table', title: 'Network Interfaces Table', desc: 'All interfaces: status, speed, traffic, errors.', icon: Server, color: '#16a34a', count: ifaces.length },
    { key: 'dns', title: 'DNS Monitoring', desc: 'Configured resolvers & resolution health.', icon: Globe, color: '#0891b2', count: dns.length },
    { key: 'gateway', title: 'Gateway Monitoring', desc: 'Default gateway, reachability & latency.', icon: Route, color: '#2563eb' },
    { key: 'tcp_udp', title: 'TCP / UDP Monitoring', desc: 'TCP & UDP connections, top peers, ports.', icon: Plug, color: '#d97706', count: tcpTotal + udp },
    { key: 'ports', title: 'Open Ports', desc: 'Listening ports with process, PID & exposure.', icon: Plug, color: '#7c3aed', count: ports.length },
    { key: 'bandwidth', title: 'Bandwidth Utilization', desc: 'Current vs capacity utilization per link.', icon: Activity, color: '#16a34a' },
    { key: 'wifi', title: 'Wi-Fi Information', desc: 'SSID, signal, channel, band & security.', icon: Wifi, color: '#d97706', count: wifi ? 1 : 0 },
    { key: 'routing', title: 'Routing Information', desc: 'Routing table, default & static routes.', icon: Route, color: '#475569', count: routes.length },
    { key: 'arp', title: 'ARP Table', desc: 'IP-to-MAC neighbor mappings.', icon: Radio, color: '#0891b2', count: arp.length },
    { key: 'processes', title: 'Network Processes', desc: 'Processes bound to listening ports.', icon: Box, color: '#7c3aed', count: null },
    { key: 'historical', title: 'Historical Charts', desc: 'Traffic trends over 1h / 24h / 7d.', icon: Clock, color: '#475569' },
  ];

  /* ── Card menu ── */
  if (!view) {
    return (
      <div>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2.5">
            <Network size={18} className="text-emerald-600" />
            <h2 className="text-lg font-black text-slate-800 tracking-tight">Network</h2>
            <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 text-[12px] font-bold">{CARDS.length} modules</span>
          </div>
          <div className="flex bg-white border border-slate-200 rounded-xl p-0.5 shadow-sm">
            {[['grid', 'Grid'], ['list', 'List']].map(([k, label]) => (
              <button key={k} onClick={() => setLayout(k)}
                className={`h-8 px-3.5 rounded-lg text-[12px] font-bold transition-all ${layout === k ? 'bg-slate-900 text-white shadow' : 'text-slate-500 hover:text-slate-800'}`}>{label}</button>
            ))}
          </div>
        </div>

        {layout === 'grid' ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
            {CARDS.map((c) => (
              <MenuCard key={c.key} icon={c.icon} color={c.color} title={c.title} desc={c.desc}
                count={c.count == null ? undefined : c.count} onClick={() => setView(c.key)} />
            ))}
          </div>
        ) : (
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm divide-y divide-slate-100 overflow-hidden">
            {CARDS.map((c) => (
              <button key={c.key} onClick={() => setView(c.key)} className="w-full flex items-center gap-4 px-5 py-3.5 hover:bg-slate-50 text-left transition-colors">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: `${c.color}18`, color: c.color }}>
                  <c.icon size={20} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[15px] font-black text-slate-800">{c.title}</p>
                  <p className="text-[13px] text-slate-500 truncate">{c.desc}</p>
                </div>
                {c.count != null && <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 text-[12px] font-bold flex-shrink-0">{c.count}</span>}
                <ChevronRight size={18} className="text-slate-300 flex-shrink-0" />
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  /* ── Drill-in section for the selected card ── */
  const card = CARDS.find((c) => c.key === view) || {};
  return (
    <>
      <BackBtn onClick={() => setView(null)} label="Network" />
      <NetworkView view={view} title={card.title} data={data} id={id} navigate={navigate}
        net={net} ifaces={ifaces} upCount={upCount} states={states} tcpTotal={tcpTotal} udp={udp}
        arp={arp} routes={routes} gateway={gateway} dns={dns} wifi={wifi} ports={ports}
        gwMac={gwMac} primaryIp={primaryIp} hasRates={hasRates} totalErrors={totalErrors} />
    </>
  );
}

// Renders the content for one Network module (the "develop one by one" surface).
function NetworkView(p) {
  const { view, title, ifaces, states, tcpTotal, udp, arp, routes, gateway, dns, wifi, ports, gwMac, primaryIp, hasRates, net, data, id, navigate } = p;
  const soon = (msg) => (
    <Section title={title} icon={Clock} color={C.slate}>
      <div className="py-10 text-center">
        <Clock size={30} className="mx-auto text-slate-300 mb-3" />
        <p className="text-[15px] font-bold text-slate-600">{msg}</p>
      </div>
    </Section>
  );

  if (view === 'iface_table' || view === 'iface_details') {
    return (
      <Section title={view === 'iface_details' ? 'Network Interface Details' : 'Network Interfaces Table'} icon={Network} count={ifaces.length} color={C.green}>
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead><tr className="bg-slate-50 border-b border-slate-200">
              {['Interface', 'Status', 'Type', 'Speed', 'MTU', 'MAC', 'IPv4', 'IPv6', 'Driver'].map((h) => (
                <th key={h} className="px-3 py-2 text-left text-[11px] font-bold text-slate-400 uppercase whitespace-nowrap">{h}</th>))}
            </tr></thead>
            <tbody>
              {ifaces.map((i, k) => (
                <tr key={i.name || k} className={`border-b border-slate-100 ${k % 2 ? 'bg-slate-50/40' : ''}`}>
                  <td className="px-3 py-2 font-mono font-bold text-slate-700 whitespace-nowrap">{i.name}
                    {i.desc && i.desc !== i.name && <span className="block text-[11px] font-normal text-slate-400 truncate max-w-[240px]">{i.desc}</span>}</td>
                  <td className="px-3 py-2"><span className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${netUp(i.status) ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>{i.status || '—'}</span></td>
                  <td className="px-3 py-2 text-[12px] text-slate-500 whitespace-nowrap">{i.type || '—'}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{i.speed_mbps ? `${i.speed_mbps} Mbps` : '—'}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{i.mtu || '—'}</td>
                  <td className="px-3 py-2 font-mono text-[12px] text-slate-500 whitespace-nowrap">{i.mac || '—'}</td>
                  <td className="px-3 py-2 font-mono text-[12px] text-slate-600">{(i.ipv4 || []).join(', ') || '—'}</td>
                  <td className="px-3 py-2 font-mono text-[11px] text-slate-400">{(i.ipv6 || []).join(', ') || '—'}</td>
                  <td className="px-3 py-2 text-[12px] text-slate-500 whitespace-nowrap">{i.driver || '—'}</td>
                </tr>
              ))}
              {ifaces.length === 0 && <tr><td colSpan={9} className="px-3 py-6 text-center text-slate-400">No interfaces</td></tr>}
            </tbody>
          </table>
        </div>
      </Section>
    );
  }

  if (view === 'realtime' || view === 'bandwidth') {
    if (!hasRates) return soon('Live throughput populates after the agent reports twice (≈ one interval).');
    return (
      <Section title={view === 'realtime' ? 'Real-Time Traffic' : 'Bandwidth Utilization'} icon={Activity} color={C.cyan}>
        <div className="grid grid-cols-2 gap-3 mb-4">
          <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 text-center"><p className="text-[11px] font-bold text-blue-400 uppercase">Total Download</p><p className="text-[26px] font-black text-blue-700 mt-1">{net.total_download_mbps} <span className="text-[14px]">Mbps</span></p></div>
          <div className="bg-violet-50 border border-violet-100 rounded-xl p-4 text-center"><p className="text-[11px] font-bold text-violet-400 uppercase">Total Upload</p><p className="text-[26px] font-black text-violet-700 mt-1">{net.total_upload_mbps} <span className="text-[14px]">Mbps</span></p></div>
        </div>
        {ifaces.filter((i) => netUp(i.status)).map((i) => {
          const dl = i.download_mbps || 0, ul = i.upload_mbps || 0;
          const util = i.download_util_pct ?? i.upload_util_pct;
          return (
            <div key={i.name} className="py-2 border-b border-slate-100 last:border-0">
              <div className="flex items-center justify-between text-[13px] mb-1">
                <span className="font-mono font-bold text-slate-700">{i.name}</span>
                <span className="text-slate-500">↓ {dl} · ↑ {ul} Mbps{i.speed_mbps ? ` / ${i.speed_mbps} Mbps` : ''}{util != null ? ` · ${util}%` : ''}</span>
              </div>
              <div className="h-2 bg-slate-100 rounded-full overflow-hidden"><div className="h-full rounded-full bg-cyan-500" style={{ width: `${Math.min(100, util || 0)}%` }} /></div>
            </div>
          );
        })}
      </Section>
    );
  }

  if (view === 'conn_stats' || view === 'tcp_udp') {
    return (
      <Section title={view === 'tcp_udp' ? 'TCP / UDP Monitoring' : 'Connection Statistics'} icon={Globe} color={C.slate}>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2.5">
          {CONN_STATE_ORDER.map((s) => (
            <div key={s} className="bg-slate-50 border border-slate-100 rounded-lg p-2.5 text-center">
              <p className="text-[18px] font-black text-slate-800 leading-none">{states[s] ?? 0}</p>
              <p className="text-[10px] font-bold text-slate-400 mt-1">{s.replace(/_/g, ' ')}</p>
            </div>
          ))}
          <div className="bg-slate-50 border border-slate-100 rounded-lg p-2.5 text-center"><p className="text-[18px] font-black text-slate-800 leading-none">{udp}</p><p className="text-[10px] font-bold text-slate-400 mt-1">UDP ENDPOINTS</p></div>
          <div className="bg-slate-50 border border-slate-100 rounded-lg p-2.5 text-center"><p className="text-[18px] font-black text-slate-800 leading-none">{tcpTotal}</p><p className="text-[10px] font-bold text-slate-400 mt-1">TCP TOTAL</p></div>
        </div>
        {(data.connections?.peers || []).length > 0 && (
          <>
            <p className="text-[12px] font-bold text-slate-400 uppercase mt-4 mb-1.5">Top Remote Peers</p>
            <div className="flex flex-wrap gap-1.5">{(data.connections.peers || []).slice(0, 40).map((pr, i) => <span key={i} className="font-mono text-[12px] px-2 py-0.5 rounded-lg bg-slate-50 border border-slate-200 text-slate-600">{pr}</span>)}</div>
          </>
        )}
        {Object.keys(states).length === 0 && <p className="text-[13px] text-slate-400 mt-3">Connection-state breakdown needs the updated agent.</p>}
      </Section>
    );
  }

  if (view === 'errors') {
    return (
      <Section title="Network Errors" icon={AlertTriangle} color={C.red}>
        <Table headers={['Interface', 'Rx Errors', 'Tx Errors', 'Rx Dropped', 'Tx Dropped', 'Total']}
          rows={ifaces.map((i) => {
            const t = (i.rx_errors || 0) + (i.tx_errors || 0) + (i.rx_dropped || 0) + (i.tx_dropped || 0);
            return [
              <span className="font-mono font-bold text-slate-700">{i.name}</span>,
              i.rx_errors ?? '—', i.tx_errors ?? '—', i.rx_dropped ?? '—', i.tx_dropped ?? '—',
              <span className={t ? 'font-bold text-red-600' : 'text-slate-400'}>{t}</span>,
            ];
          })} empty="No error counters (needs updated agent)" />
      </Section>
    );
  }

  if (view === 'dns') {
    return (
      <Section title="DNS Monitoring" icon={Globe} color={C.cyan}>
        <p className="text-[12px] font-bold text-slate-400 uppercase mb-2">Configured DNS Servers</p>
        {dns.length ? dns.map((s, i) => <div key={i} className="font-mono text-[14px] text-slate-800 py-1 border-b border-slate-100 last:border-0">{s}</div>) : <p className="text-slate-400">No DNS servers reported.</p>}
        <button onClick={() => navigate && navigate(`/infra/${id}`)} className="text-[12px] font-bold text-blue-600 hover:underline mt-3">Run a live DNS lookup in the Diagnostics tab →</button>
      </Section>
    );
  }

  if (view === 'gateway') {
    return (
      <Section title="Gateway Monitoring" icon={Route} color={C.blue}>
        <div className="divide-y divide-slate-100 text-[14px]">
          {[['Default Gateway', gateway], ['Gateway MAC', gwMac || '—'], ['Primary IPv4', primaryIp]].map(([k, v]) => (
            <div key={k} className="flex items-center gap-3 py-2.5"><span className="w-44 flex-shrink-0 text-[12px] font-bold text-slate-500 uppercase">{k}</span><span className="font-mono text-slate-800 break-all">{v}</span></div>
          ))}
        </div>
        <button onClick={() => navigate && navigate(`/infra/${id}`)} className="text-[12px] font-bold text-blue-600 hover:underline mt-3">Ping the gateway (reachability / latency) in Diagnostics →</button>
      </Section>
    );
  }

  if (view === 'ports') {
    return (
      <Section title="Open Ports" icon={Plug} count={ports.length} color={C.violet}>
        <div className="max-h-[60vh] overflow-y-auto">
          <Table headers={['Port', 'Address', 'Process', 'PID']}
            rows={[...ports].sort((a, b) => (a.port || 0) - (b.port || 0)).map((p) => [
              <span className="font-mono font-black text-blue-700">{p.port}</span>,
              <span className="font-mono text-[13px] text-slate-500">{p.address || '—'}</span>,
              <span className="font-semibold text-slate-700">{p.process || '—'}</span>,
              <span className="font-mono text-slate-400">{p.pid || '—'}</span>,
            ])} empty="No listening ports" />
        </div>
      </Section>
    );
  }

  if (view === 'wifi') {
    if (!wifi) return soon('No Wi-Fi adapter detected on this host.');
    return (
      <Section title="Wi-Fi Information" icon={Wifi} color={C.amber}>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-3 text-[14px]">
          {[['SSID', wifi.ssid], ['BSSID', wifi.bssid], ['Signal', wifi.signal], ['Channel', wifi.channel], ['Band', wifi.band], ['Radio', wifi.radio], ['Rx rate', wifi.rx_rate], ['Tx rate', wifi.tx_rate], ['Authentication', wifi.auth], ['Cipher', wifi.cipher]].filter(([, v]) => v).map(([k, v]) => (
            <div key={k}><span className="text-[11px] font-bold text-slate-400 uppercase block">{k}</span><span className="font-semibold text-slate-800">{v}</span></div>
          ))}
        </div>
      </Section>
    );
  }

  if (view === 'arp') {
    return (
      <Section title="ARP Table" icon={Radio} count={arp.length} color={C.cyan}>
        <div className="max-h-[60vh] overflow-y-auto">
          <Table headers={['IP Address', 'MAC Address', 'Interface', 'Entry State']}
            rows={arp.map((a) => [
              <span className="font-mono font-semibold text-slate-700">{a.ip}</span>,
              <span className="font-mono text-[13px] text-slate-500">{a.mac || '—'}</span>,
              a.dev || '—',
              <span className={`text-[13px] font-bold ${String(a.state).toUpperCase() === 'REACHABLE' ? 'text-emerald-600' : 'text-slate-400'}`}>{a.state}</span>,
            ])} empty="No ARP entries" />
        </div>
      </Section>
    );
  }

  if (view === 'routing') {
    return (
      <Section title="Routing Information" icon={Route} count={routes.length} color={C.blue}>
        <div className="max-h-[60vh] overflow-y-auto">
          <Table headers={['Destination', 'Gateway', 'Interface', 'Metric']}
            rows={routes.map(parseRoute).map((r) => [
              <span className="font-mono font-semibold text-slate-700">{r.isDefault ? 'default' : r.dest}</span>,
              <span className="font-mono text-[13px] text-slate-600">{r.via && r.via !== '0.0.0.0' ? r.via : 'On-link'}</span>,
              <span className="text-[13px]">{r.dev || '—'}</span>,
              <span className="font-mono text-[13px] text-slate-500">{r.metric ?? '—'}</span>,
            ])} empty="No routes" />
        </div>
      </Section>
    );
  }

  if (view === 'processes') {
    const byProc = {};
    ports.forEach((p) => {
      const key = `${p.process || '?'}|${p.pid || ''}`;
      (byProc[key] = byProc[key] || { process: p.process || '—', pid: p.pid, ports: [] }).ports.push(p.port);
    });
    const rows = Object.values(byProc).sort((a, b) => b.ports.length - a.ports.length);
    return (
      <Section title="Network Processes" icon={Box} count={rows.length} color={C.violet}>
        <Table headers={['Process', 'PID', 'Listening Ports', 'Count']}
          rows={rows.map((r) => [
            <span className="font-semibold text-slate-700">{r.process}</span>,
            <span className="font-mono text-slate-400">{r.pid || '—'}</span>,
            <span className="font-mono text-[12px] text-slate-600">{r.ports.sort((a, b) => a - b).join(', ')}</span>,
            r.ports.length,
          ])} empty="No processes bound to listening ports" />
      </Section>
    );
  }

  if (view === 'historical') {
    return soon('Historical traffic charts (1h / 24h / 7d) require the metrics history service. Coming soon.');
  }

  return soon('Module coming soon.');
}

/* ── IP Configuration helpers ── */
const maskFromPrefix = (p) => {
  p = Math.max(0, Math.min(32, Number(p) || 0));
  const o = [0, 0, 0, 0];
  for (let i = 0; i < p; i++) o[Math.floor(i / 8)] |= (128 >> (i % 8));
  return o.join('.');
};
const _oct = (ip) => String(ip || '').split('.').map(Number);
const netAddr = (ip, p) => { if (!ip || p == null) return null; const m = maskFromPrefix(p).split('.').map(Number); return _oct(ip).map((o, i) => o & m[i]).join('.'); };
const bcastAddr = (ip, p) => { if (!ip || p == null) return null; const m = maskFromPrefix(p).split('.').map(Number); return _oct(ip).map((o, i) => (o & m[i]) | (255 - m[i])).join('.'); };

function FieldGrid({ items }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-10 gap-y-3">
      {items.map(([k, v]) => (
        <div key={k} className="flex flex-col border-b border-slate-100 pb-2">
          <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wide">{k}</span>
          <span className="text-[14px] font-semibold text-slate-800 break-all mt-0.5">
            {v == null || v === '' ? <span className="text-slate-300 font-normal">—</span> : v}
          </span>
        </div>
      ))}
    </div>
  );
}

function IpConfigMenu({ data, id, navigate, isWin, initialView }) {
  const [view, setView] = useState(initialView !== undefined ? initialView : null);
  const [layout, setLayout] = useState('grid');
  const [sel, setSel] = useState(0);
  const [checks, setChecks] = useState({});

  const net = data.network || {};
  const ifaces = (net.interfaces && net.interfaces.length) ? net.interfaces
    : (data.interfaces || []).map((i) => ({ name: i.iface, status: i.state, mac: i.mac, ipv4: (i.addresses || []).filter((a) => !a.includes(':')), ipv6: (i.addresses || []).filter((a) => a.includes(':')) }));
  const dns = net.dns || data.dns?.nameservers || [];
  const routes = net.routes || data.routes || [];
  const gateway = net.gateway || null;
  const arp = net.arp || data.neighbors || [];
  const cur = ifaces[sel] || ifaces[0] || {};

  const CARDS = [
    { key: 'interface', title: 'Interface Configuration', desc: 'Name, type, status, MAC, MTU, link speed, driver.', icon: Network, color: '#2563eb' },
    { key: 'ipv4', title: 'IPv4 Configuration', desc: 'Address, subnet, gateway, DHCP lease details.', icon: Globe, color: '#0891b2' },
    { key: 'ipv6', title: 'IPv6 Configuration', desc: 'Link-local, global address, prefix & lifetimes.', icon: Globe, color: '#7c3aed' },
    { key: 'dns', title: 'DNS Configuration', desc: 'Primary/secondary DNS, suffixes, registration.', icon: Globe, color: '#16a34a' },
    { key: 'proxy', title: 'Proxy Configuration', desc: 'Proxy server, port, PAC script, bypass list.', icon: ShieldCheck, color: '#d97706' },
    { key: 'advanced', title: 'Advanced Configuration', desc: 'NetBIOS, WINS, routes, forwarding, jumbo frames.', icon: Settings2, color: '#475569' },
    { key: 'conflict', title: 'IP Conflict Detection', desc: 'Duplicate IP / MAC detection & conflict status.', icon: AlertTriangle, color: '#dc2626' },
    { key: 'changes', title: 'Configuration Changes', desc: 'Last IP / gateway / DNS / DHCP change events.', icon: Clock, color: '#475569' },
    { key: 'validation', title: 'Validation Checks', desc: 'Gateway, DNS, internet & public-IP reachability.', icon: Check, color: '#16a34a' },
    { key: 'export', title: 'Export Options', desc: 'Copy, JSON, CSV export of the IP configuration.', icon: Save, color: '#2563eb' },
    { key: 'import', title: 'Import Options', desc: 'Import configuration from JSON / CSV.', icon: Plus, color: '#7c3aed' },
    { key: 'edit', title: 'Edit Network Config', desc: 'Edit hosts / interfaces files, restart networking.', icon: FileEdit, color: '#0891b2' },
    { key: 'firewall', title: 'Firewall — Whitelist / Blacklist', desc: "Allow or block source IPs / CIDRs on this host's firewall.", icon: ShieldCheck, color: '#7c3aed' },
  ];

  /* ── Card menu ── */
  if (!view) {
    return (
      <div>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2.5">
            <Route size={18} className="text-blue-600" />
            <h2 className="text-lg font-black text-slate-800 tracking-tight">IP Configuration</h2>
            <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 text-[12px] font-bold">{CARDS.length} modules</span>
          </div>
          <div className="flex bg-white border border-slate-200 rounded-xl p-0.5 shadow-sm">
            {[['grid', 'Grid'], ['list', 'List']].map(([k, label]) => (
              <button key={k} onClick={() => setLayout(k)}
                className={`h-8 px-3.5 rounded-lg text-[12px] font-bold transition-all ${layout === k ? 'bg-slate-900 text-white shadow' : 'text-slate-500 hover:text-slate-800'}`}>{label}</button>
            ))}
          </div>
        </div>
        {layout === 'grid' ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
            {CARDS.map((c) => <MenuCard key={c.key} icon={c.icon} color={c.color} title={c.title} desc={c.desc} onClick={() => setView(c.key)} />)}
          </div>
        ) : (
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm divide-y divide-slate-100 overflow-hidden">
            {CARDS.map((c) => (
              <button key={c.key} onClick={() => setView(c.key)} className="w-full flex items-center gap-4 px-5 py-3.5 hover:bg-slate-50 text-left transition-colors">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: `${c.color}18`, color: c.color }}><c.icon size={20} /></div>
                <div className="flex-1 min-w-0"><p className="text-[15px] font-black text-slate-800">{c.title}</p><p className="text-[13px] text-slate-500 truncate">{c.desc}</p></div>
                <ChevronRight size={18} className="text-slate-300 flex-shrink-0" />
              </button>
            ))}
          </div>
        )}
        {isWin && <p className="text-[12px] text-slate-400 mt-3">Editing &amp; firewall run through the ActMon agent on Windows — keep the agent updated to enable them (viewing works now).</p>}
      </div>
    );
  }

  const back = <BackBtn onClick={() => setView(null)} label="IP Configuration" />;
  if (view === 'edit') return <>{back}<NetConfigEditor id={id} /></>;
  if (view === 'firewall') return <>{back}<FirewallPanel id={id} /></>;

  const ifaceSelect = ifaces.length > 1 ? (
    <select value={sel} onChange={(e) => setSel(+e.target.value)}
      className="mb-4 h-9 px-3 rounded-lg border border-slate-300 text-[13px] font-mono outline-none focus:border-blue-400">
      {ifaces.map((i, idx) => <option key={idx} value={idx}>{i.name}{i.status ? ` (${i.status})` : ''}</option>)}
    </select>
  ) : null;

  let body = null;

  if (view === 'interface') {
    body = (
      <Section title="Interface Configuration" icon={Network} color={C.blue}>
        {ifaceSelect}
        <FieldGrid items={[
          ['Interface Name', cur.name], ['Interface Alias', cur.name], ['Interface Description', cur.desc],
          ['Interface Type', cur.type || (cur.name && /wi-?fi|wlan/i.test(cur.name) ? 'Wi-Fi' : cur.name && /lo/i.test(cur.name) ? 'Loopback' : 'Ethernet')],
          ['Status', cur.status], ['MAC Address', cur.mac], ['MTU Size', cur.mtu],
          ['Link Speed', cur.speed_mbps ? `${cur.speed_mbps} Mbps` : null], ['Duplex Mode', cur.duplex],
          ['Driver Version', cur.driver], ['Interface Index', cur.index],
        ]} />
      </Section>
    );
  } else if (view === 'ipv4') {
    const v4 = (cur.ipv4 || [])[0] || '';
    const [ip4, p4] = v4.includes('/') ? v4.split('/') : [v4 || null, null];
    body = (
      <Section title="IPv4 Configuration" icon={Globe} color={C.cyan}>
        {ifaceSelect}
        <FieldGrid items={[
          ['IPv4 Address', ip4], ['Subnet Mask', p4 ? maskFromPrefix(p4) : null], ['CIDR Prefix Length', p4 ? `/${p4}` : null],
          ['Network Address', netAddr(ip4, p4)], ['Broadcast Address', bcastAddr(ip4, p4)], ['Default Gateway', gateway],
          ['IP Assignment', null], ['DHCP Server', null], ['DHCP Lease Obtained', null], ['DHCP Lease Expiry', null],
        ]} />
        <p className="text-[12px] text-slate-400 mt-3">DHCP lease &amp; assignment (static/DHCP) require the updated agent probe.</p>
      </Section>
    );
  } else if (view === 'ipv6') {
    const v6 = cur.ipv6 || [];
    const ll = v6.find((a) => /^fe80/i.test(a));
    const global = v6.find((a) => !/^fe80|^::1/i.test(a));
    body = (
      <Section title="IPv6 Configuration" icon={Globe} color={C.violet}>
        {ifaceSelect}
        <FieldGrid items={[
          ['IPv6 Address', v6.join(', ')], ['Link Local Address', ll], ['Global Address', global],
          ['Prefix Length', (global || ll || '').includes('/') ? `/${(global || ll).split('/')[1]}` : null],
          ['Default Gateway', null], ['Address Type', global ? 'Global unicast' : ll ? 'Link-local' : null],
          ['Temporary Address', null], ['Preferred Lifetime', null], ['Valid Lifetime', null],
        ]} />
      </Section>
    );
  } else if (view === 'dns') {
    body = (
      <Section title="DNS Configuration" icon={Globe} color={C.green}>
        <FieldGrid items={[
          ['Primary DNS Server', dns[0]], ['Secondary DNS Server', dns[1]],
          ['Additional DNS Servers', dns.slice(2).join(', ')], ['DNS Suffix', data.dns?.search],
          ['Connection-Specific DNS Suffix', null], ['DNS Registration Enabled', null],
          ['Dynamic DNS Enabled', null], ['DNS Resolution Status', null],
        ]} />
        <button onClick={() => setView('validation')} className="text-[12px] font-bold text-blue-600 hover:underline mt-3">Run a live DNS reachability check →</button>
      </Section>
    );
  } else if (view === 'proxy') {
    body = (
      <Section title="Proxy Configuration" icon={ShieldCheck} color={C.amber}>
        <FieldGrid items={[
          ['Proxy Enabled', null], ['Proxy Server', null], ['Proxy Port', null],
          ['Proxy Bypass List', null], ['Auto Detect Proxy', null], ['PAC Script URL', null],
        ]} />
        <p className="text-[12px] text-slate-400 mt-3">Proxy settings are not yet collected — planned via the agent (Windows: WinHTTP / registry, Linux: env &amp; APT/YUM proxy).</p>
      </Section>
    );
  } else if (view === 'advanced') {
    body = (
      <Section title="Advanced Configuration" icon={Settings2} color={C.slate}>
        <FieldGrid items={[
          ['NetBIOS Status', null], ['WINS Servers', null], ['ARP Cache Entries', arp.length],
          ['Static Routes', routes.filter((r) => !String(r).startsWith('default')).length],
          ['Dynamic Routes', null], ['IP Forwarding Status', null], ['ICMP Redirect Status', null],
          ['IPv6 Enabled', ifaces.some((i) => (i.ipv6 || []).length) ? 'Yes' : 'No'],
          ['Jumbo Frames Enabled', ifaces.some((i) => (i.mtu || 0) > 1500) ? 'Yes' : 'No'],
        ]} />
      </Section>
    );
  } else if (view === 'conflict') {
    const macCount = {}, ipCount = {};
    arp.forEach((a) => { if (a.mac) macCount[a.mac] = (macCount[a.mac] || 0) + 1; if (a.ip) ipCount[a.ip] = (ipCount[a.ip] || 0) + 1; });
    const dupMac = Object.entries(macCount).filter(([, c]) => c > 1);
    const dupIp = Object.entries(ipCount).filter(([, c]) => c > 1);
    const conflict = dupIp.length || dupMac.length;
    body = (
      <Section title="IP Conflict Detection" icon={AlertTriangle} color={conflict ? C.red : C.green}>
        <FieldGrid items={[
          ['Duplicate IP Detection', dupIp.length ? dupIp.map(([ip, c]) => `${ip} ×${c}`).join(', ') : 'None found'],
          ['Duplicate MAC Detection', dupMac.length ? dupMac.map(([m, c]) => `${m} ×${c}`).join(', ') : 'None found'],
          ['IP Conflict Status', conflict ? 'Conflict detected' : 'No conflict'],
          ['Last Conflict Time', null],
        ]} />
        <p className="text-[12px] text-slate-400 mt-3">Derived from the current ARP table. Continuous duplicate-address monitoring is planned.</p>
      </Section>
    );
  } else if (view === 'changes') {
    body = (
      <Section title="Configuration Changes" icon={Clock} color={C.slate}>
        <FieldGrid items={[
          ['Last IP Address Change', null], ['Last Gateway Change', null], ['Last DNS Change', null],
          ['Last DHCP Renewal', null], ['Interface State Changes', null],
        ]} />
        <p className="text-[12px] text-slate-400 mt-3">Change history requires the time-series store — coming with Historical Charts.</p>
      </Section>
    );
  } else if (view === 'validation') {
    const runCheck = async (key, kind, target, port) => {
      setChecks((c) => ({ ...c, [key]: { loading: true } }));
      try { const r = await netDiag(id, kind, target, port); setChecks((c) => ({ ...c, [key]: { ok: r.reachable, out: r.output } })); }
      catch (e) { setChecks((c) => ({ ...c, [key]: { ok: false, out: errText(e) } })); }
    };
    const CHECKS = [
      ['ip_valid', 'IP Address Valid', null, () => setChecks((c) => ({ ...c, ip_valid: { ok: !!(cur.ipv4 || [])[0], out: (cur.ipv4 || [])[0] || 'no IPv4' } }))],
      ['gateway', 'Gateway Reachable', gateway, () => gateway && runCheck('gateway', 'ping', gateway)],
      ['dns', 'DNS Reachable', dns[0], () => dns[0] && runCheck('dns', 'ping', dns[0])],
      ['internet', 'Internet Connectivity', '8.8.8.8', () => runCheck('internet', 'ping', '8.8.8.8')],
      ['public', 'Public IP Reachable', '1.1.1.1', () => runCheck('public', 'ping', '1.1.1.1')],
    ];
    body = (
      <Section title="Validation Checks" icon={Check} color={C.green}
        action={<button onClick={() => CHECKS.forEach(([, , , fn]) => fn())} className="h-8 px-3 rounded-lg bg-blue-600 text-white text-[12px] font-bold hover:bg-blue-700">Run all checks</button>}>
        <div className="divide-y divide-slate-100">
          {CHECKS.map(([key, label, target, fn]) => {
            const r = checks[key];
            return (
              <div key={key} className="flex items-center gap-3 py-2.5">
                <span className="w-52 flex-shrink-0 text-[13px] font-bold text-slate-700">{label}</span>
                <span className="text-[12px] font-mono text-slate-400 flex-1 truncate">{target || ''}</span>
                {r?.loading ? <Loader2 size={15} className="animate-spin text-blue-500" />
                  : r ? <span className={`px-2 py-0.5 rounded-full text-[11px] font-black ${r.ok ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>{r.ok ? 'PASS' : 'FAIL'}</span>
                    : <span className="text-[11px] text-slate-300 font-bold">not run</span>}
                <button onClick={fn} className="h-7 px-2.5 rounded-lg border border-slate-300 text-slate-600 text-[12px] font-bold hover:bg-slate-100">Test</button>
              </div>
            );
          })}
        </div>
        <p className="text-[12px] text-slate-400 mt-3">DHCP-working &amp; IPv6-connectivity checks are planned.</p>
      </Section>
    );
  } else if (view === 'export') {
    const cfg = {
      host: data.host?.server_name, os: data.host?.os_type, generatedAt: new Date().toISOString(),
      gateway, dns, routes,
      interfaces: ifaces.map((i) => ({ name: i.name, status: i.status, type: i.type, mac: i.mac, mtu: i.mtu, speed_mbps: i.speed_mbps, ipv4: i.ipv4 || [], ipv6: i.ipv6 || [] })),
    };
    const dl = (name, content, type) => { const b = new Blob([content], { type }); const u = URL.createObjectURL(b); const a = document.createElement('a'); a.href = u; a.download = name; a.click(); URL.revokeObjectURL(u); };
    const csv = ['name,status,type,mac,mtu,speed_mbps,ipv4,ipv6',
      ...ifaces.map((i) => [i.name, i.status, i.type, i.mac, i.mtu, i.speed_mbps, (i.ipv4 || []).join('|'), (i.ipv6 || []).join('|')].map((x) => `"${x ?? ''}"`).join(','))].join('\n');
    const base = (data.host?.server_name || 'host').replace(/[^\w.-]/g, '_');
    body = (
      <Section title="Export Options" icon={Save} color={C.blue}>
        <div className="flex flex-wrap gap-2.5">
          <button onClick={() => { navigator.clipboard?.writeText(JSON.stringify(cfg, null, 2)); }} className="h-10 px-4 rounded-lg bg-slate-800 text-white text-[13px] font-bold hover:bg-slate-700 flex items-center gap-2"><Copy2 /> Copy IP Configuration</button>
          <button onClick={() => dl(`${base}-ipconfig.json`, JSON.stringify(cfg, null, 2), 'application/json')} className="h-10 px-4 rounded-lg border border-slate-300 text-slate-700 text-[13px] font-bold hover:bg-slate-50">Export as JSON</button>
          <button onClick={() => dl(`${base}-ipconfig.csv`, csv, 'text/csv')} className="h-10 px-4 rounded-lg border border-slate-300 text-slate-700 text-[13px] font-bold hover:bg-slate-50">Export as CSV</button>
          <button onClick={() => window.print()} className="h-10 px-4 rounded-lg border border-slate-300 text-slate-700 text-[13px] font-bold hover:bg-slate-50">Export as PDF (Print)</button>
        </div>
        <pre className="mt-4 bg-slate-900 text-emerald-300 rounded-xl p-3.5 text-[12px] font-mono max-h-72 overflow-auto">{JSON.stringify(cfg, null, 2)}</pre>
      </Section>
    );
  } else if (view === 'import') {
    body = (
      <Section title="Import Options" icon={Plus} color={C.violet}>
        <p className="text-[14px] text-slate-600 mb-3">Import a saved configuration to review or (with agent support) apply.</p>
        <div className="flex flex-wrap gap-2.5">
          <label className="h-10 px-4 rounded-lg border border-slate-300 text-slate-700 text-[13px] font-bold hover:bg-slate-50 flex items-center gap-2 cursor-pointer">
            Import JSON <input type="file" accept=".json" className="hidden" onChange={(e) => e.target.files?.[0] && alert(`Selected ${e.target.files[0].name}. Applying imported config will be enabled with agent write-support.`)} />
          </label>
          <label className="h-10 px-4 rounded-lg border border-slate-300 text-slate-700 text-[13px] font-bold hover:bg-slate-50 flex items-center gap-2 cursor-pointer">
            Import CSV <input type="file" accept=".csv" className="hidden" onChange={(e) => e.target.files?.[0] && alert(`Selected ${e.target.files[0].name}. Applying imported config will be enabled with agent write-support.`)} />
          </label>
        </div>
        <p className="text-[12px] text-slate-400 mt-3">Applying an imported configuration to a live host will run through the agent's network-edit channel (with a confirmation + password) — wiring in progress.</p>
      </Section>
    );
  } else {
    body = <Section title="Module" icon={Info} color={C.slate}><p className="text-slate-400 py-6 text-center">Coming soon.</p></Section>;
  }

  return <>{back}{body}</>;
}

// small clipboard glyph (avoids another lucide import)
function Copy2() { return <FileText size={14} />; }

/* ── Configuration Files launcher ── */
const CFG_PALETTE = ['#2563eb', '#0891b2', '#7c3aed', '#16a34a', '#d97706', '#dc2626', '#475569', '#0d9488'];
// Typical on-disk sources per module (shown in the drill; used to seed File Explorer).
const CFG_FILE_HINTS = {
  boot: { linux: ['/boot/grub/grub.cfg', '/etc/default/grub'], win: ['bcdedit'] },
  kernel: { linux: ['/etc/sysctl.conf', '/etc/sysctl.d/', '/proc/cmdline'] },
  ssh: { linux: ['/etc/ssh/sshd_config', '/etc/ssh/ssh_config', '~/.ssh/authorized_keys'], win: ['C:\\ProgramData\\ssh\\sshd_config'] },
  user: { linux: ['/etc/passwd', '/etc/shadow'], win: ['net user'] },
  group: { linux: ['/etc/group'], win: ['net localgroup'] },
  auth: { linux: ['/etc/pam.d/', '/etc/nsswitch.conf'] },
  security: { linux: ['/etc/security/', '/etc/login.defs'] },
  sysctl: { linux: ['/etc/sysctl.conf', '/etc/sysctl.d/*.conf'] },
  systemd: { linux: ['/etc/systemd/system/', '/lib/systemd/system/'] },
  cron: { linux: ['/etc/crontab', '/etc/cron.d/', '/var/spool/cron/'], win: ['schtasks'] },
  tasks: { win: ['Task Scheduler', 'schtasks /query'], linux: ['/etc/cron.d/'] },
  ntp: { linux: ['/etc/chrony/chrony.conf', '/etc/ntp.conf', '/etc/systemd/timesyncd.conf'], win: ['w32tm /query /configuration'] },
  logging: { linux: ['/etc/rsyslog.conf', '/etc/systemd/journald.conf', '/var/log/'], win: ['Event Viewer'] },
  audit: { linux: ['/etc/audit/auditd.conf', '/etc/audit/rules.d/'], win: ['auditpol /get /category:*'] },
  package: { linux: ['/etc/apt/sources.list', '/etc/yum.repos.d/', '/etc/dnf/dnf.conf'] },
  selinux: { linux: ['/etc/selinux/config', '/etc/apparmor.d/'] },
  locale: { linux: ['/etc/locale.conf', '/etc/default/locale', '/etc/timezone'] },
  env: { linux: ['/etc/environment', '/etc/profile.d/'], win: ['Environment variables'] },
  sysvars: { linux: ['/etc/environment'], win: ['HKLM\\SYSTEM\\...\\Environment'] },
  cert: { linux: ['/etc/ssl/certs/', '/etc/pki/'], win: ['certlm.msc'] },
  docker: { linux: ['/etc/docker/daemon.json', 'docker info'] },
  k8s: { linux: ['/etc/kubernetes/', '~/.kube/config'] },
  vpn: { linux: ['/etc/openvpn/', '/etc/wireguard/'] },
  database: { linux: ['/etc/mysql/', '/etc/postgresql/', 'my.cnf', 'postgresql.conf'] },
  web: { linux: ['/etc/nginx/nginx.conf', '/etc/apache2/', '/etc/httpd/'], win: ['IIS applicationHost.config'] },
  mail: { linux: ['/etc/postfix/main.cf', '/etc/dovecot/'] },
  fileshare: { linux: ['/etc/samba/smb.conf', '/etc/exports'], win: ['net share'] },
  remote: { linux: ['/etc/ssh/sshd_config'], win: ['RDP settings'] },
  ldap: { linux: ['/etc/sssd/sssd.conf', '/etc/nslcd.conf'], win: ['Active Directory'] },
  domain: { win: ['domain / workgroup'], linux: ['/etc/krb5.conf'] },
  wireless: { linux: ['/etc/NetworkManager/system-connections/', 'wpa_supplicant.conf'], win: ['netsh wlan'] },
  printer: { linux: ['/etc/cups/'], win: ['Get-Printer'] },
  power: { linux: ['/etc/systemd/logind.conf'], win: ['powercfg /query'] },
  driver: { linux: ['lsmod', '/lib/modules/'], win: ['Get-WindowsDriver'] },
  device: { linux: ['lspci', 'lsusb', '/dev/'], win: ['Device Manager'] },
  usb: { linux: ['lsusb'], win: ['Get-PnpDevice'] },
  backup: { linux: ['/etc/cron.d/backup', 'rsync/borg config'] },
  monitoring: { linux: ['agent config', '/etc/prometheus/'] },
  license: { linux: ['/usr/share/doc/*/copyright'], win: ['slmgr /dlv'] },
  software: { linux: ['/var/lib/dpkg/status', '/var/log/dpkg.log', '/var/log/yum.log'], win: ['HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall'] },
  virt: { linux: ['/etc/libvirt/qemu.conf', '/etc/libvirt/libvirtd.conf'], win: ['Hyper-V Manager', 'Get-VM'] },
  container: { linux: ['/etc/containers/containers.conf', '/etc/containers/registries.conf'] },
  cloud: { linux: ['/etc/cloud/cloud.cfg', '/etc/cloud/cloud.cfg.d/'], win: ['EC2Launch config'] },
  appserver: { linux: ['/etc/tomcat/server.xml', '/opt/tomcat/conf/server.xml'], win: ['Tomcat service config'] },
  ha: { linux: ['/etc/corosync/corosync.conf', '/etc/pacemaker/'] },
  cluster: { linux: ['/etc/corosync/corosync.conf', '/etc/pcs/'] },
  lb: { linux: ['/etc/haproxy/haproxy.cfg', '/etc/nginx/conf.d/lb.conf'] },
  san: { linux: ['/etc/multipath.conf', '/etc/iscsi/iscsid.conf'] },
  regional: { linux: ['/etc/default/locale', '/etc/timezone'], win: ['Region Settings (intl.cpl)'] },
};

/* ── Config module drill: Files · Registry · Commands (per-module config) ── */

// Per-module config: which real files / registry keys / info commands each
// Config-Files card exposes. Each returns { title, files, regKeys, commands }.
function moduleConfig(key, isWin, fallbackTitle) {
  const M = {
    os: {
      title: 'Operating System',
      files: isWin ? [
        { label: 'Hosts file', path: 'C:\\Windows\\System32\\drivers\\etc\\hosts', restart: 'Dnscache' },
        { label: 'License (license.rtf)', path: 'C:\\Windows\\System32\\license.rtf' },
      ] : [
        { label: 'Hosts file', path: '/etc/hosts', restart: 'systemd-resolved' },
        { label: 'OS release', path: '/etc/os-release' },
        { label: 'Hostname', path: '/etc/hostname', restart: 'systemd-hostnamed' },
      ],
      regKeys: [
        { label: 'Windows Version', key: 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion' },
        { label: 'Computer Name', key: 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\ComputerName\\ComputerName' },
        { label: 'Environment', key: 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment' },
        { label: 'Time Zone', key: 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\TimeZoneInformation' },
      ],
      commands: isWin ? [
        { label: 'systeminfo', key: 'systeminfo' }, { label: 'wmic os', key: 'wmic_os' },
        { label: 'Get-ComputerInfo', key: 'get_computerinfo' }, { label: 'Get-CimInstance Win32_OperatingSystem', key: 'get_os' },
        { label: 'hostname', key: 'hostname' }, { label: 'ver', key: 'ver' },
      ] : [
        { label: 'uname -a', key: 'uname' }, { label: 'cat /etc/os-release', key: 'os_release' }, { label: 'hostname', key: 'hostname' },
      ],
    },
    hardware: {
      title: 'Hardware',
      regKeys: [
        { label: 'Hardware root', key: 'HKLM\\HARDWARE' },
        { label: 'System description', key: 'HKLM\\HARDWARE\\DESCRIPTION\\System' },
        { label: 'BIOS', key: 'HKLM\\HARDWARE\\DESCRIPTION\\System\\BIOS' },
        { label: 'Device Enum', key: 'HKLM\\SYSTEM\\CurrentControlSet\\Enum' },
        { label: 'Device Classes', key: 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\DeviceClasses' },
        { label: 'Driver Classes', key: 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Class' },
        { label: 'Services', key: 'HKLM\\SYSTEM\\CurrentControlSet\\Services' },
      ],
      // Hardware config is registry-based on Windows; the driver-install logs are
      // the only hardware-related text files. Editable hardware settings → Registry card.
      filesNote: isWin ? 'Windows keeps hardware configuration in the Registry (see the Registry card). The files below are driver-install diagnostic logs.' : null,
      files: isWin ? [
        { label: 'Device install log', path: 'C:\\Windows\\INF\\setupapi.dev.log' },
        { label: 'App install log', path: 'C:\\Windows\\INF\\setupapi.app.log' },
      ] : [
        { label: 'Kernel module options', path: '/etc/modprobe.d/blacklist.conf' },
        { label: 'Modules to load at boot', path: '/etc/modules' },
        { label: 'Persistent device (udev) rules', path: '/etc/udev/rules.d/70-persistent-net.rules' },
        { label: 'Sensors / lm-sensors', path: '/etc/sensors3.conf' },
        { label: 'X11 / GPU config', path: '/etc/X11/xorg.conf' },
      ],
    },
    cpu: {
      title: 'CPU',
      regKeys: [
        { label: 'Processor 0 (info)', key: 'HKLM\\HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\0' },
        { label: 'Processor control', key: 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Processor' },
        { label: 'Power (Session Manager)', key: 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Power' },
        { label: 'Priority control', key: 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\PriorityControl' },
        { label: 'Intel processor driver', key: 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\intelppm' },
      ],
      // Windows CPU tuning is registry + powercfg, not text files → no Files card.
      files: isWin ? null : [
        { label: 'CPU frequency scaling', path: '/etc/default/cpufrequtils' },
        { label: 'Scaling governor', path: '/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor' },
        { label: 'systemd CPU affinity', path: '/etc/systemd/system.conf' },
        { label: 'tuned (active profile)', path: '/etc/tuned/active_profile' },
        { label: 'CPU info (read-only)', path: '/proc/cpuinfo' },
        { label: 'Load average (read-only)', path: '/proc/loadavg' },
      ],
      commands: isWin ? [
        { label: 'wmic cpu', key: 'wmic_cpu' }, { label: 'Get-CimInstance Win32_Processor', key: 'get_cpu' },
        { label: 'Active power scheme', key: 'powercfg_scheme' }, { label: 'CPU load %', key: 'cpu_load' },
      ] : [
        { label: 'lscpu', key: 'lscpu' }, { label: 'cat /proc/cpuinfo', key: 'proc_cpuinfo' },
        { label: 'nproc', key: 'nproc' }, { label: 'uptime', key: 'uptime' },
      ],
    },
  };
  if (M[key]) return M[key];

  // Every other module: auto-build a real Files panel from its CFG_FILE_HINTS paths
  // (same OsFilesEditor as os/hardware/cpu — real view/edit, not a placeholder).
  const hint = CFG_FILE_HINTS[key];
  if (!hint) return null;
  const paths = (isWin ? (hint.win || hint.linux) : (hint.linux || hint.win)) || [];
  if (!paths.length) return null;
  return {
    title: fallbackTitle || key,
    files: paths.map((p) => ({ label: p, path: p })),
  };
}

// Drill for a config module: shows the Files / Registry / Commands sub-cards the
// module defines, then routes into the matching editor.
function ConfigModulePanel({ id, isWin, cfg, navigate, onBack }) {
  const [sub, setSub] = useState(null);
  if (sub === 'files') return <OsFilesEditor id={id} isWin={isWin} files={cfg.files} note={cfg.filesNote} title={`${cfg.title} — Files`} navigate={navigate} onBack={() => setSub(null)} />;
  if (sub === 'registry') return <OsRegistryPanel id={id} keys={cfg.regKeys} title={`${cfg.title} — Registry`} onBack={() => setSub(null)} />;
  if (sub === 'commands') return <OsCommandsPanel id={id} isWin={isWin} commands={cfg.commands} title={`${cfg.title} — Commands`} onBack={() => setSub(null)} />;

  const filesDesc = (cfg.files || []).slice(0, 3).map((f) => f.label).join(', ');
  const cards = [
    ...(cfg.regKeys && isWin ? [{ key: 'registry', title: 'Registry', icon: Settings2, color: C.violet,
      desc: `${cfg.regKeys.length} key${cfg.regKeys.length === 1 ? '' : 's'} — view & edit values` }] : []),
    ...(cfg.files ? [{ key: 'files', title: 'Files', icon: FileEdit, color: C.blue,
      desc: `${filesDesc}${(cfg.files || []).length > 3 ? '…' : ''} — view, edit & add` }] : []),
    ...(cfg.commands ? [{ key: 'commands', title: 'Commands', icon: Terminal, color: C.green,
      desc: (cfg.commands || []).slice(0, 4).map((c) => c.label).join(' · ') }] : []),
  ];

  return (
    <div className="space-y-4">
      <BackBtn onClick={onBack} label="Configuration Files" />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {cards.map((c) => (
          <button key={c.key} onClick={() => setSub(c.key)}
            className="text-left bg-white rounded-2xl border border-slate-200 shadow-sm p-5 flex items-start gap-4 hover:border-blue-400 hover:shadow-md transition-all">
            <div className="w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: `${c.color}18`, color: c.color }}><c.icon size={22} /></div>
            <div className="min-w-0 flex-1">
              <p className="text-[15px] font-black text-slate-800">{c.title}</p>
              <p className="text-[12px] text-slate-400 mt-0.5 leading-snug">{c.desc}</p>
            </div>
            <ChevronRight size={16} className="text-slate-300 flex-shrink-0 mt-1" />
          </button>
        ))}
      </div>
    </div>
  );
}

// Database Configuration — technology-aware: detect the DB engines actually
// present on this host (listening ports + processes), then edit each one's config.
function DatabaseConfigPanel({ id, isWin, data, navigate, onBack }) {
  const [tech, setTech] = useState(null);
  const [showAll, setShowAll] = useState(false);

  // Version lists so the probe can find whichever build is actually installed.
  const PG_V = ['17', '16', '15', '14', '13', '12'];
  const MY_V = [['8.4', 'MySQL84'], ['8.0', 'MySQL80'], ['5.7', 'MySQL57']];
  const MG_V = ['7.0', '6.0', '5.0'];
  const MS_V = [['16', 'MSSQL16'], ['15', 'MSSQL15'], ['14', 'MSSQL14']];

  const TECHS = [
    { key: 'mysql', name: 'MySQL / MariaDB', ports: [3306], proc: /mysqld|mariadb/i,
      files: isWin ? [
        ...MY_V.flatMap(([v, svc]) => [
          { label: `my.ini (MySQL ${v}, ProgramData)`, path: `C:\\ProgramData\\MySQL\\MySQL Server ${v}\\my.ini`, restart: svc },
          { label: `my.ini (MySQL ${v}, Program Files)`, path: `C:\\Program Files\\MySQL\\MySQL Server ${v}\\my.ini`, restart: svc },
        ]),
        { label: 'my.ini (MariaDB 11 data)', path: 'C:\\Program Files\\MariaDB 11.0\\data\\my.ini', restart: 'MariaDB' },
        { label: 'my.ini (Windows dir)', path: 'C:\\Windows\\my.ini', restart: 'MySQL80' },
        { label: 'my.cnf (C:\\)', path: 'C:\\my.cnf', restart: 'MySQL80' },
      ] : [
        { label: 'my.cnf (main)', path: '/etc/mysql/my.cnf', restart: 'mysql' },
        { label: '/etc/my.cnf', path: '/etc/my.cnf', restart: 'mysqld' },
        { label: 'mysqld.cnf', path: '/etc/mysql/mysql.conf.d/mysqld.cnf', restart: 'mysql' },
        { label: 'conf.d/mysql.cnf', path: '/etc/mysql/conf.d/mysql.cnf', restart: 'mysql' },
        { label: 'MariaDB 50-server.cnf', path: '/etc/mysql/mariadb.conf.d/50-server.cnf', restart: 'mariadb' },
        { label: 'MariaDB 50-client.cnf', path: '/etc/mysql/mariadb.conf.d/50-client.cnf', restart: 'mariadb' },
        { label: 'User ~/.my.cnf', path: '~/.my.cnf' },
      ] },
    { key: 'postgres', name: 'PostgreSQL', ports: [5432], proc: /postgres/i,
      files: isWin ? PG_V.flatMap((v) => [
        { label: `postgresql.conf (v${v})`, path: `C:\\Program Files\\PostgreSQL\\${v}\\data\\postgresql.conf`, restart: `postgresql-x64-${v}` },
        { label: `pg_hba.conf (v${v})`, path: `C:\\Program Files\\PostgreSQL\\${v}\\data\\pg_hba.conf`, restart: `postgresql-x64-${v}` },
      ]) : [
        ...PG_V.flatMap((v) => [
          { label: `postgresql.conf (v${v})`, path: `/etc/postgresql/${v}/main/postgresql.conf`, restart: 'postgresql' },
          { label: `pg_hba.conf (v${v})`, path: `/etc/postgresql/${v}/main/pg_hba.conf`, restart: 'postgresql' },
        ]),
        { label: 'postgresql.conf (RHEL)', path: '/var/lib/pgsql/data/postgresql.conf', restart: 'postgresql' },
        { label: 'pg_hba.conf (RHEL)', path: '/var/lib/pgsql/data/pg_hba.conf', restart: 'postgresql' },
      ] },
    { key: 'mssql', name: 'Microsoft SQL Server', ports: [1433], proc: /sqlservr/i,
      note: 'SQL Server is configured mainly via T-SQL (sp_configure) and the Registry. The entries below are its file-based config / logs where they exist.',
      files: isWin ? MS_V.map(([v, svc]) => ({ label: `ERRORLOG (MSSQL${v})`, path: `C:\\Program Files\\Microsoft SQL Server\\MSSQL${v}.MSSQLSERVER\\MSSQL\\Log\\ERRORLOG`, restart: svc }))
        : [
          { label: 'mssql.conf', path: '/var/opt/mssql/mssql.conf', restart: 'mssql-server' },
          { label: 'ERRORLOG', path: '/var/opt/mssql/log/errorlog' },
        ] },
    { key: 'mongodb', name: 'MongoDB', ports: [27017], proc: /mongod/i,
      files: isWin ? MG_V.map((v) => ({ label: `mongod.cfg (Server ${v})`, path: `C:\\Program Files\\MongoDB\\Server\\${v}\\bin\\mongod.cfg`, restart: 'MongoDB' }))
        : [
          { label: 'mongod.conf', path: '/etc/mongod.conf', restart: 'mongod' },
          { label: 'mongos.conf (sharding)', path: '/etc/mongos.conf' },
        ] },
    { key: 'redis', name: 'Redis', ports: [6379], proc: /redis-server|redis/i,
      files: isWin ? [
        { label: 'redis.windows.conf', path: 'C:\\Program Files\\Redis\\redis.windows.conf', restart: 'Redis' },
        { label: 'redis.windows-service.conf', path: 'C:\\Program Files\\Redis\\redis.windows-service.conf', restart: 'Redis' },
      ] : [
        { label: 'redis.conf', path: '/etc/redis/redis.conf', restart: 'redis-server' },
        { label: 'sentinel.conf', path: '/etc/redis/sentinel.conf', restart: 'redis-sentinel' },
      ] },
    { key: 'oracle', name: 'Oracle', ports: [1521], proc: /oracle|tnslsnr/i,
      files: isWin ? [
        { label: 'listener.ora', path: 'C:\\app\\oracle\\product\\network\\admin\\listener.ora', restart: 'OracleServiceORCL' },
        { label: 'tnsnames.ora', path: 'C:\\app\\oracle\\product\\network\\admin\\tnsnames.ora' },
        { label: 'sqlnet.ora', path: 'C:\\app\\oracle\\product\\network\\admin\\sqlnet.ora' },
        { label: 'ldap.ora', path: 'C:\\app\\oracle\\product\\network\\admin\\ldap.ora' },
        { label: 'init.ora', path: 'C:\\app\\oracle\\product\\dbs\\init.ora', restart: 'OracleServiceORCL' },
      ] : [
        { label: 'listener.ora', path: '/u01/app/oracle/network/admin/listener.ora' },
        { label: 'tnsnames.ora', path: '/u01/app/oracle/network/admin/tnsnames.ora' },
        { label: 'sqlnet.ora', path: '/u01/app/oracle/network/admin/sqlnet.ora' },
        { label: 'ldap.ora', path: '/u01/app/oracle/network/admin/ldap.ora' },
        { label: 'init.ora', path: '/u01/app/oracle/dbs/init.ora' },
      ] },
  ];

  // Detect from listening ports + running processes.
  const portSet = new Set((data.ports || []).map((p) => Number(p.port)).filter((n) => n));
  const blob = [
    ...(data.processes || []).map((p) => p.command || ''),
    ...(data.ports || []).map((p) => p.process || ''),
    ...(data.services || []).map((s) => s.unit || ''),
  ].join(' ').toLowerCase();
  const marked = TECHS.map((t) => ({ ...t, detected: t.ports.some((pt) => portSet.has(pt)) || t.proc.test(blob) }));
  const detected = marked.filter((t) => t.detected);
  const list = (detected.length && !showAll) ? detected : marked;

  if (tech) {
    const t = TECHS.find((x) => x.key === tech) || {};
    return <OsFilesEditor id={id} isWin={isWin} files={t.files} note={t.note} probe title={`${t.name} — Config Files`} navigate={navigate} onBack={() => setTech(null)} />;
  }

  return (
    <div className="space-y-4">
      <BackBtn onClick={onBack} label="Configuration Files" />
      <Section title="Database Configuration" icon={Database} color={C.cyan}
        action={detected.length > 0 && (
          <button onClick={() => setShowAll((v) => !v)} className="text-[12px] font-bold text-cyan-700 hover:underline">
            {showAll ? 'Show detected only' : 'Show all supported'}
          </button>
        )}>
        {detected.length === 0 ? (
          <div className="mb-4 rounded-lg bg-amber-50 border border-amber-100 px-3.5 py-2.5 flex items-start gap-2">
            <Info size={15} className="text-amber-500 flex-shrink-0 mt-0.5" />
            <p className="text-[13px] text-amber-800">No database engine detected on this host (checked listening ports &amp; processes). Showing all supported engines — open the one you installed.</p>
          </div>
        ) : (
          <p className="text-[13px] text-slate-500 mb-3">{detected.length} database engine{detected.length === 1 ? '' : 's'} detected on this host.</p>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {list.map((t) => (
            <button key={t.key} onClick={() => setTech(t.key)}
              className={`text-left bg-white rounded-2xl border shadow-sm p-5 flex items-start gap-4 hover:shadow-md transition-all ${t.detected ? 'border-cyan-300 hover:border-cyan-400' : 'border-slate-200 hover:border-slate-300'}`}>
              <div className="w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: `${C.cyan}18`, color: C.cyan }}><Database size={22} /></div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="text-[15px] font-black text-slate-800">{t.name}</p>
                  {t.detected && <span className="px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700 text-[10px] font-black uppercase">Running</span>}
                </div>
                <p className="text-[12px] text-slate-400 mt-0.5">{t.files.length} config file{t.files.length === 1 ? '' : 's'} · port {t.ports.join(', ')}</p>
              </div>
              <ChevronRight size={16} className="text-slate-300 flex-shrink-0 mt-1" />
            </button>
          ))}
        </div>
      </Section>
    </div>
  );
}

// Files — view / edit / add real files; folder entries open in File Explorer;
// files that need a service bounce show a password-gated Restart.
function OsFilesEditor({ id, isWin, files, note, probe, title = 'Operating System — Files', navigate, onBack }) {
  const FILES = files || (isWin ? [
    { label: 'Hosts file', path: 'C:\\Windows\\System32\\drivers\\etc\\hosts', restart: 'Dnscache' },
    { label: 'License (license.rtf)', path: 'C:\\Windows\\System32\\license.rtf' },
  ] : [
    { label: 'Hosts file', path: '/etc/hosts', restart: 'systemd-resolved' },
    { label: 'OS release', path: '/etc/os-release' },
    { label: 'Hostname', path: '/etc/hostname', restart: 'systemd-hostnamed' },
  ]);
  const [openPath, setOpenPath] = useState(null);
  const [draft, setDraft] = useState('');
  const [orig, setOrig] = useState('');
  const [loadingFile, setLoadingFile] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);
  const [newPath, setNewPath] = useState('');
  const [restart, setRestart] = useState(null);   // unit name
  const [saved, setSaved] = useState(false);
  const [browse, setBrowse] = useState(null);     // inline folder browser { path, loading, err, entries, parent }
  const [exist, setExist] = useState({});          // path -> bool (which candidate files actually exist)
  const [probing, setProbing] = useState(false);
  const [showAllLoc, setShowAllLoc] = useState(false);

  const pathsKey = FILES.map((f) => f.path).join('|');
  // When probing, check which candidate files actually exist so we don't list
  // a dozen "duplicate" locations that aren't there.
  useEffect(() => {
    if (!probe) return undefined;
    let cancelled = false;
    setProbing(true); setExist({});
    Promise.all(FILES.map(async (f) => {
      if (f.dir) return [f.path, true];
      try { const d = await fsRead(id, f.path); return [f.path, !d.needs_ssh && !d.error]; }
      catch { return [f.path, false]; }
    })).then((pairs) => { if (!cancelled) { setExist(Object.fromEntries(pairs)); setProbing(false); } });
    return () => { cancelled = true; };
  }, [probe, id, pathsKey]);   // eslint-disable-line react-hooks/exhaustive-deps

  const existCount = Object.values(exist).filter(Boolean).length;
  // Which files to list: while probing show none; when done show only the ones
  // that exist (toggle reveals every candidate location, dimmed if not present).
  const visibleFiles = !probe ? FILES
    : probing ? []
      : showAllLoc ? FILES
        : existCount > 0 ? FILES.filter((f) => exist[f.path])
          : [];

  const restartFor = (p) => (FILES.find((f) => f.path === p) || {}).restart;
  const sepOf = (p) => (p.includes('\\') ? '\\' : '/');
  const joinPath = (dir, name) => { const s = sepOf(dir); return dir.replace(/[\\/]+$/, '') + s + name; };

  const openFile = async (p) => {
    setBrowse(null); setOpenPath(p); setMsg(null); setSaved(false); setDraft(''); setOrig('');
    if (probe && exist[p] === false) {
      setLoadingFile(false);
      setMsg({ ok: false, text: 'This file does not exist on this host. Pick one marked present, or use Add to open a different path.' });
      return;
    }
    setLoadingFile(true);
    try {
      const d = await fsRead(id, p);
      if (d.needs_ssh) { setMsg({ ok: false, text: d.message }); }
      else if (d.binary) { setMsg({ ok: false, text: 'This file is binary and cannot be edited here.' }); }
      else { setDraft(d.content || ''); setOrig(d.content || ''); }
    } catch (e) { setMsg({ ok: false, text: errText(e, 'Could not open file.') }); }
    finally { setLoadingFile(false); }
  };
  const save = async () => {
    setSaving(true); setMsg(null);
    try {
      await fsWrite(id, openPath, draft);
      setOrig(draft); setSaved(true);
      setMsg({ ok: true, text: 'Saved. A .actmon.bak backup was kept.' });
    } catch (e) { setMsg({ ok: false, text: errText(e, 'Save failed.') }); }
    finally { setSaving(false); }
  };

  // Open a folder INLINE (right pane) — no page navigation.
  const browseDir = async (p) => {
    setOpenPath(null); setBrowse({ path: p, loading: true, err: null, entries: [], parent: null });
    try {
      const d = await fsList(id, p);
      if (d.needs_ssh) setBrowse({ path: p, loading: false, err: d.message, entries: [], parent: null });
      else setBrowse({ path: p, loading: false, err: null, entries: d.entries || [], parent: d.parent });
    } catch (e) { setBrowse({ path: p, loading: false, err: errText(e, 'Could not open folder.'), entries: [], parent: null }); }
  };

  return (
    <>
      <BackBtn onClick={onBack} label="Operating System" />
      <Section title={title} icon={FileEdit} color={C.blue}>
        {note && (
          <div className="mb-4 rounded-lg bg-blue-50 border border-blue-100 px-3.5 py-2.5 flex items-start gap-2">
            <Info size={15} className="text-blue-500 flex-shrink-0 mt-0.5" />
            <p className="text-[13px] text-blue-800">{note}</p>
          </div>
        )}
        <div className="grid grid-cols-1 lg:grid-cols-[340px_1fr] gap-4">
          {/* file list */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between mb-1">
              <p className="text-[12px] font-bold text-slate-400 uppercase">Files</p>
              {probe && (
                probing ? <span className="text-[11px] text-slate-400 flex items-center gap-1"><Loader2 size={11} className="animate-spin" /> checking…</span>
                  : existCount > 0 ? <button onClick={() => setShowAllLoc((v) => !v)} className="text-[11px] font-bold text-blue-600 hover:underline">{showAllLoc ? `Present only (${existCount})` : `All locations (${FILES.length})`}</button>
                    : null
              )}
            </div>
            {probe && !probing && existCount === 0 && (
              <div className="rounded-lg bg-amber-50 border border-amber-100 px-3 py-2 mb-1">
                <p className="text-[12px] text-amber-800">None of the standard config files were found on this host — this engine may not be installed here, or lives at a custom path. Use the box below to open an exact path{!showAllLoc ? ', or ' : '.'}
                  {!showAllLoc && <button onClick={() => setShowAllLoc(true)} className="font-bold underline">show all {FILES.length} candidate locations</button>}{!showAllLoc && '.'}
                </p>
              </div>
            )}
            {visibleFiles.map((f) => (
              <div key={f.path}
                className={`w-full px-3 py-2.5 rounded-lg border transition-all flex items-center gap-2 ${openPath === f.path ? 'border-blue-400 bg-blue-50' : 'border-slate-200 hover:border-blue-300 hover:bg-slate-50'}`}>
                <button onClick={() => (f.dir ? browseDir(f.path) : openFile(f.path))} className={`flex items-center gap-2.5 min-w-0 flex-1 text-left ${probe && !probing && exist[f.path] === false ? 'opacity-45' : ''}`}>
                  {f.dir ? <Folder size={16} className="text-amber-400 flex-shrink-0" /> : <FileText size={16} className="text-blue-400 flex-shrink-0" />}
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5 text-[14px] font-bold text-slate-800 truncate">{f.label}
                      {probe && !probing && exist[f.path] === false && <span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-400 text-[10px] font-bold uppercase flex-shrink-0">not found</span>}
                    </span>
                    <span className="block text-[12px] font-mono text-slate-400 truncate">{f.path}</span>
                  </span>
                </button>
                {f.dir ? (
                  <button onClick={() => browseDir(f.path)} title="Open in File Explorer"
                    className="w-7 h-7 rounded-lg text-slate-400 hover:text-amber-600 hover:bg-amber-100 flex items-center justify-center flex-shrink-0"><Folder size={14} /></button>
                ) : (
                  <button onClick={() => openFile(f.path)} title="Edit this file"
                    className="w-7 h-7 rounded-lg text-slate-400 hover:text-blue-600 hover:bg-blue-100 flex items-center justify-center flex-shrink-0"><FileEdit size={14} /></button>
                )}
                {f.restart && (
                  <button onClick={() => setRestart(f.restart)} title={`Restart ${f.restart}`}
                    className="w-7 h-7 rounded-lg text-slate-400 hover:text-amber-600 hover:bg-amber-100 flex items-center justify-center flex-shrink-0"><Power size={14} /></button>
                )}
              </div>
            ))}
            {/* Add / open an arbitrary file (created on save if missing) */}
            <div className="flex items-center gap-1.5 pt-2 mt-1 border-t border-slate-100">
              <input value={newPath} onChange={(e) => setNewPath(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && newPath.trim()) { openFile(newPath.trim()); setNewPath(''); } }}
                placeholder={isWin ? 'C:\\path\\to\\file  add or open' : '/etc/…  add or open a file'}
                className="flex-1 h-9 px-2.5 rounded-lg border border-slate-300 text-[12px] font-mono outline-none focus:border-blue-400" />
              <button onClick={() => { if (newPath.trim()) { openFile(newPath.trim()); setNewPath(''); } }} disabled={!newPath.trim()}
                title="Open / add file"
                className="h-9 px-2.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 flex items-center gap-1 text-[12px] font-bold"><Plus size={14} /> Add</button>
            </div>
          </div>

          {/* editor / inline folder browser */}
          <div>
            {browse ? (
              <div>
                {/* breadcrumb + up */}
                <div className="flex items-center gap-2 mb-2">
                  <Folder size={15} className="text-amber-500 flex-shrink-0" />
                  <span className="font-mono text-[13px] font-bold text-slate-700 truncate flex-1">{browse.path}</span>
                  {browse.parent && browse.parent !== browse.path && (
                    <button onClick={() => browseDir(browse.parent)}
                      className="h-8 px-2.5 rounded-lg border border-slate-300 text-slate-600 text-[12px] font-bold hover:bg-slate-100 flex items-center gap-1 flex-shrink-0"><ArrowLeft size={12} /> Up</button>
                  )}
                  <button onClick={() => setBrowse(null)} title="Close folder"
                    className="w-8 h-8 rounded-lg border border-slate-300 text-slate-500 hover:bg-slate-100 flex items-center justify-center flex-shrink-0"><X size={14} /></button>
                </div>
                {browse.loading ? (
                  <div className="min-h-[440px] flex items-center justify-center"><Loader2 size={20} className="animate-spin text-amber-500" /></div>
                ) : browse.err ? <p className="text-[15px] text-red-500 py-4">{browse.err}</p>
                  : (
                    <div className="border border-slate-200 rounded-xl overflow-hidden max-h-[calc(100vh-360px)] min-h-[440px] overflow-y-auto divide-y divide-slate-100">
                      {browse.entries.length === 0 && <p className="text-[14px] text-slate-400 px-4 py-6 text-center">This folder is empty.</p>}
                      {browse.entries.map((e) => {
                        const child = joinPath(browse.path, e.name);
                        const isDir = e.type === 'dir';
                        return (
                          <button key={e.name} onClick={() => (isDir ? browseDir(child) : openFile(child))}
                            className="w-full flex items-center gap-2.5 px-3.5 py-2 hover:bg-slate-50 text-left transition-colors">
                            {isDir ? <Folder size={15} className="text-amber-400 flex-shrink-0" /> : <FileText size={15} className="text-blue-400 flex-shrink-0" />}
                            <span className="text-[13px] font-semibold text-slate-700 truncate flex-1">{e.name}{isDir ? '' : ''}</span>
                            {!isDir && e.size != null && <span className="text-[11px] text-slate-400 flex-shrink-0">{fmtBytes(e.size)}</span>}
                            <ChevronRight size={14} className="text-slate-300 flex-shrink-0" />
                          </button>
                        );
                      })}
                    </div>
                  )}
                <p className="text-[12px] text-slate-400 mt-2">{browse.entries.length} item{browse.entries.length === 1 ? '' : 's'} · click a folder to open it, a file to view &amp; edit — all in place.</p>
              </div>
            ) : !openPath ? (
              <div className="min-h-[440px] flex items-center justify-center text-center border-2 border-dashed border-slate-200 rounded-xl">
                <p className="text-[15px] text-slate-400">Select a file or folder on the left to open it here.</p>
              </div>
            ) : loadingFile ? (
              <div className="min-h-[440px] flex items-center justify-center"><Loader2 size={20} className="animate-spin text-blue-500" /></div>
            ) : (
              <>
                <div className="flex items-center gap-2 mb-2">
                  <span className="font-mono text-[13px] font-bold text-slate-700 truncate">{openPath}</span>
                  {draft !== orig && <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 text-[11px] font-bold flex-shrink-0">unsaved changes</span>}
                  <div className="ml-auto flex gap-2 flex-shrink-0">
                    <button onClick={() => setDraft(orig)} disabled={draft === orig}
                      className="h-9 px-3 rounded-lg border border-slate-300 text-slate-600 text-[13px] font-bold hover:bg-slate-100 disabled:opacity-40">Revert</button>
                    <button onClick={save} disabled={saving || draft === orig}
                      className="h-9 px-4 rounded-lg bg-emerald-600 text-white text-[13px] font-bold hover:bg-emerald-700 disabled:opacity-40 flex items-center gap-1.5">
                      {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save
                    </button>
                  </div>
                </div>
                <textarea value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false}
                  className="w-full h-[calc(100vh-340px)] min-h-[440px] p-3.5 rounded-xl border border-slate-300 text-[13px] leading-relaxed font-mono text-slate-800 outline-none focus:border-blue-400 resize-y bg-slate-900/[0.02]" />
                {msg && <p className={`text-[13px] font-semibold mt-2 flex items-center gap-1.5 ${msg.ok ? 'text-emerald-600' : 'text-red-600'}`}>
                  {msg.ok ? <Check size={14} /> : <AlertTriangle size={14} />}{msg.text}</p>}
                {saved && restartFor(openPath) && (
                  <div className="mt-3 rounded-lg bg-amber-50 border border-amber-200 p-3 flex items-center gap-3">
                    <Power size={17} className="text-amber-600 flex-shrink-0" />
                    <p className="text-[14px] text-amber-800 flex-1">Saved. Apply it by restarting <span className="font-mono font-bold">{restartFor(openPath)}</span>.</p>
                    <button onClick={() => setRestart(restartFor(openPath))} className="h-9 px-4 rounded-lg bg-amber-600 text-white text-[13px] font-bold hover:bg-amber-700 flex items-center gap-1.5">
                      <Power size={13} /> Restart
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </Section>
      {restart && <PasswordPrompt title={`Restart ${restart}`} confirmLabel="Restart"
        onConfirm={(pw) => serviceAction(id, restart, 'restart', pw)} onClose={() => setRestart(null)} />}
    </>
  );
}

// OS Registry (Windows) — read the standard keys; edit a value (password-gated).
function OsRegistryPanel({ id, keys, title = 'Operating System — Registry', onBack }) {
  const KEYS = keys || [
    { label: 'Windows Version', key: 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion' },
    { label: 'Computer Name', key: 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\ComputerName\\ComputerName' },
    { label: 'Environment', key: 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment' },
    { label: 'Time Zone', key: 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\TimeZoneInformation' },
  ];
  const [sel, setSel] = useState(null);          // { label, key }
  const [values, setValues] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [customKey, setCustomKey] = useState('');
  const [editing, setEditing] = useState(null);  // value name being edited
  const [draftVal, setDraftVal] = useState('');
  const [commit, setCommit] = useState(null);     // { name, value } → password prompt

  const load = async (k) => {
    setSel(k); setLoading(true); setErr(null); setValues(null); setEditing(null);
    try { const d = await regGet(id, k.key); setValues(d.values || []); }
    catch (e) { setErr(errText(e, 'Could not read registry key.')); }
    finally { setLoading(false); }
  };

  return (
    <>
      <BackBtn onClick={onBack} label="Operating System" />
      <Section title={title} icon={Settings2} color={C.violet}>
        <div className="grid grid-cols-1 lg:grid-cols-[340px_1fr] gap-4">
          {/* key list */}
          <div className="space-y-1.5">
            <p className="text-[12px] font-bold text-slate-400 uppercase mb-1">Registry Keys</p>
            {KEYS.map((k) => (
              <button key={k.key} onClick={() => load(k)}
                className={`w-full text-left px-3 py-2.5 rounded-lg border transition-all ${sel?.key === k.key ? 'border-violet-400 bg-violet-50' : 'border-slate-200 hover:border-violet-300 hover:bg-slate-50'}`}>
                <span className="block text-[14px] font-bold text-slate-800">{k.label}</span>
                <span className="block text-[11px] font-mono text-slate-400 truncate">{k.key}</span>
              </button>
            ))}
            <div className="flex items-center gap-1.5 pt-2 mt-1 border-t border-slate-100">
              <input value={customKey} onChange={(e) => setCustomKey(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && customKey.trim()) load({ label: 'Custom key', key: customKey.trim() }); }}
                placeholder="HKLM\\…  open a key"
                className="flex-1 h-9 px-2.5 rounded-lg border border-slate-300 text-[12px] font-mono outline-none focus:border-violet-400" />
              <button onClick={() => customKey.trim() && load({ label: 'Custom key', key: customKey.trim() })} disabled={!customKey.trim()}
                className="h-9 px-2.5 rounded-lg bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-40 flex items-center gap-1 text-[12px] font-bold"><Search size={13} /> Open</button>
            </div>
          </div>

          {/* values */}
          <div>
            {!sel ? (
              <div className="min-h-[440px] flex items-center justify-center text-center border-2 border-dashed border-slate-200 rounded-xl">
                <p className="text-[15px] text-slate-400">Select a registry key to view &amp; edit its values.</p>
              </div>
            ) : loading ? (
              <div className="min-h-[440px] flex items-center justify-center"><Loader2 size={20} className="animate-spin text-violet-500" /></div>
            ) : err ? <p className="text-[15px] text-red-500">{err}</p>
              : (
                <>
                  <p className="font-mono text-[12px] text-slate-500 mb-2 break-all">{sel.key}</p>
                  {(!values || values.length === 0) ? <p className="text-[15px] text-slate-400">No values under this key.</p> : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-[14px]">
                        <thead><tr className="bg-slate-50 border-b border-slate-200">
                          {['Name', 'Value', 'Action'].map((h) => <th key={h} className="px-3.5 py-2.5 text-left text-[12px] font-bold text-slate-400 uppercase">{h}</th>)}
                        </tr></thead>
                        <tbody>
                          {values.map((v) => (
                            <tr key={v.name} className="border-b border-slate-100 align-top">
                              <td className="px-3.5 py-2.5 font-mono font-bold text-slate-700">{v.name}</td>
                              <td className="px-3.5 py-2.5">
                                {editing === v.name ? (
                                  <input value={draftVal} onChange={(e) => setDraftVal(e.target.value)} autoFocus
                                    className="w-full h-9 px-2.5 rounded-lg border border-violet-300 text-[13px] font-mono outline-none focus:border-violet-500" />
                                ) : <span className="font-mono text-slate-600 break-all">{v.value || <span className="text-slate-300">—</span>}</span>}
                              </td>
                              <td className="px-3.5 py-2.5 whitespace-nowrap">
                                {editing === v.name ? (
                                  <div className="flex gap-1.5">
                                    <button onClick={() => setCommit({ name: v.name, value: draftVal })} disabled={draftVal === (v.value || '')}
                                      className="h-8 px-2.5 rounded-lg bg-emerald-600 text-white text-[12px] font-bold hover:bg-emerald-700 disabled:opacity-40 flex items-center gap-1"><Save size={12} /> Save</button>
                                    <button onClick={() => setEditing(null)} className="h-8 px-2.5 rounded-lg border border-slate-300 text-slate-600 text-[12px] font-bold hover:bg-slate-100">Cancel</button>
                                  </div>
                                ) : (
                                  <button onClick={() => { setEditing(v.name); setDraftVal(v.value || ''); }}
                                    className="h-8 px-2.5 rounded-lg text-violet-700 border border-violet-200 hover:bg-violet-50 text-[12px] font-bold flex items-center gap-1"><FileEdit size={12} /> Edit</button>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}
          </div>
        </div>
      </Section>
      {commit && <PasswordPrompt title={`Set ${commit.name}`} confirmLabel="Save value" danger
        onConfirm={(pw) => regSet(id, sel.key, commit.name, commit.value, pw).then((r) => { setEditing(null); load(sel); return r; })}
        onClose={() => setCommit(null)} />}
    </>
  );
}

// Commands — run a whitelisted read-only info command and show its output.
function OsCommandsPanel({ id, isWin, commands, title = 'Operating System — Commands', onBack }) {
  const CMDS = commands || (isWin ? [
    { label: 'systeminfo', key: 'systeminfo' }, { label: 'wmic os', key: 'wmic_os' },
    { label: 'Get-ComputerInfo', key: 'get_computerinfo' }, { label: 'Get-CimInstance Win32_OperatingSystem', key: 'get_os' },
    { label: 'hostname', key: 'hostname' }, { label: 'ver', key: 'ver' },
  ] : [
    { label: 'uname -a', key: 'uname' }, { label: 'cat /etc/os-release', key: 'os_release' }, { label: 'hostname', key: 'hostname' },
  ]);
  const [sel, setSel] = useState(null);
  const [out, setOut] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const run = async (c) => {
    setSel(c.key); setBusy(true); setErr(null); setOut('');
    try { const d = await runCommand(id, c.key); setOut(d.output || '(no output)'); }
    catch (e) { setErr(errText(e, 'Command failed. The host may be unreachable or the agent needs updating.')); }
    finally { setBusy(false); }
  };

  return (
    <>
      <BackBtn onClick={onBack} label="Operating System" />
      <Section title={title} icon={Terminal} color={C.green}>
        <div className="flex flex-wrap gap-2 mb-4">
          {CMDS.map((c) => (
            <button key={c.key} onClick={() => run(c)} disabled={busy}
              className={`h-9 px-3.5 rounded-lg text-[13px] font-bold flex items-center gap-1.5 border transition-all disabled:opacity-50 ${sel === c.key ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-700 border-slate-300 hover:border-slate-500'}`}>
              <Terminal size={13} /> {c.label}
            </button>
          ))}
        </div>
        {busy ? <p className="text-[15px] text-slate-400 flex items-center gap-2"><Loader2 size={15} className="animate-spin" /> Running…</p>
          : err ? <p className="text-[15px] text-red-500">{err}</p>
            : out ? <pre className="w-full max-h-[520px] overflow-auto p-4 rounded-xl bg-slate-900 text-slate-100 text-[12.5px] font-mono whitespace-pre-wrap break-words">{out}</pre>
              : <p className="text-[15px] text-slate-400">Pick a command above to run it on this host. These are read-only informational commands.</p>}
      </Section>
    </>
  );
}

function ConfigFilesMenu({ data, id, navigate, setTab }) {
  const [view, setView] = useState(null);
  const [layout, setLayout] = useState('grid');
  const [q, setQ] = useState('');
  const isWin = /win/i.test(data.host?.os_type || '');
  const sys = data.system || {};
  const mem = data.memory || {};
  const fss = data.filesystems || [];

  const RAW = [
    ['Operating System Configuration', 'os', Info], ['Hardware Configuration', 'hardware', Server],
    ['CPU Configuration', 'cpu', Cpu], ['Memory Configuration', 'memory', MemoryStick],
    ['Disk Configuration', 'disk', HardDrive], ['Storage Configuration', 'storage', HardDrive],
    ['Filesystem Configuration', 'filesystem', HardDrive], ['Partition Configuration', 'partition', HardDrive],
    ['Boot Configuration', 'boot', Power], ['Kernel Configuration', 'kernel', Settings2],
    ['Network Configuration', 'network', Network], ['IP Configuration', 'ip', Route],
    ['DNS Configuration', 'dns', Globe], ['Proxy Configuration', 'proxy', ShieldCheck],
    ['Routing Configuration', 'routing', Route], ['Firewall Configuration', 'firewall', ShieldCheck],
    ['Security Configuration', 'security', ShieldCheck], ['Authentication Configuration', 'auth', ShieldCheck],
    ['User Configuration', 'user', Server], ['Group Configuration', 'group', Server],
    ['SSH Configuration', 'ssh', Settings2], ['Service Configuration', 'service', Settings2],
    ['Process Configuration', 'process', Box], ['Environment Configuration', 'env', Settings2],
    ['System Variables Configuration', 'sysvars', Settings2], ['Time & NTP Configuration', 'ntp', Clock],
    ['Logging Configuration', 'logging', FileText], ['Audit Configuration', 'audit', FileText],
    ['Package Management Configuration', 'package', Box], ['Software Configuration', 'software', Box],
    ['Driver Configuration', 'driver', Settings2], ['Device Configuration', 'device', Plug],
    ['Printer Configuration', 'printer', Plug], ['USB Device Configuration', 'usb', Plug],
    ['Power Management Configuration', 'power', Power], ['Scheduled Tasks Configuration', 'tasks', Clock],
    ['Cron Configuration', 'cron', Clock], ['Certificate Configuration', 'cert', ShieldCheck],
    ['Virtualization Configuration', 'virt', Box], ['Container Configuration', 'container', Box],
    ['Docker Configuration', 'docker', Box], ['Kubernetes Configuration', 'k8s', Box],
    ['Cloud Configuration', 'cloud', Globe], ['Database Configuration', 'database', Server],
    ['Web Server Configuration', 'web', Globe], ['Application Server Configuration', 'appserver', Server],
    ['Mail Server Configuration', 'mail', Globe], ['File Sharing Configuration', 'fileshare', Folder],
    ['Remote Access Configuration', 'remote', Plug], ['Monitoring Configuration', 'monitoring', Activity],
    ['Backup Configuration', 'backup', Save], ['High Availability Configuration', 'ha', Network],
    ['Cluster Configuration', 'cluster', Network], ['Load Balancer Configuration', 'lb', Network],
    ['Storage Network Configuration', 'san', HardDrive], ['VPN Configuration', 'vpn', ShieldCheck],
    ['Wireless Configuration', 'wireless', Wifi], ['Domain Configuration', 'domain', Globe],
    ['LDAP/Active Directory Configuration', 'ldap', Server], ['SELinux/AppArmor Configuration', 'selinux', ShieldCheck],
    ['Sysctl Configuration', 'sysctl', Settings2], ['Systemd Configuration', 'systemd', Settings2],
    ['Locale & Language Configuration', 'locale', Globe], ['Regional Settings Configuration', 'regional', Globe],
    ['License Configuration', 'license', FileText],
  ];
  const CARDS = RAW.map((r, idx) => ({ title: r[0], key: r[1], icon: r[2], goto: r[3], color: CFG_PALETTE[idx % CFG_PALETTE.length] }));

  const open = (c) => { if (c.goto) setTab(c.goto); else setView(c.key); };
  const term = q.trim().toLowerCase();
  const shown = term
    ? CARDS.filter((c) => c.title.toLowerCase().includes(term) || c.key.toLowerCase().includes(term) || (c.goto || '').toLowerCase().includes(term))
    : CARDS;

  if (!view) {
    return (
      <div>
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div className="flex items-center gap-2.5">
            <FileEdit size={18} className="text-teal-600" />
            <h2 className="text-lg font-black text-slate-800 tracking-tight">Configuration Files</h2>
            <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 text-[12px] font-bold">{term ? `${shown.length} of ${CARDS.length}` : `${CARDS.length} modules`}</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search modules…"
                className="h-9 w-56 pl-8 pr-8 rounded-xl border border-slate-200 shadow-sm text-[13px] outline-none focus:border-teal-400" />
              {q && <button onClick={() => setQ('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"><X size={14} /></button>}
            </div>
            <div className="flex bg-white border border-slate-200 rounded-xl p-0.5 shadow-sm">
              {[['grid', 'Grid'], ['list', 'List']].map(([k, label]) => (
                <button key={k} onClick={() => setLayout(k)}
                  className={`h-8 px-3.5 rounded-lg text-[12px] font-bold transition-all ${layout === k ? 'bg-slate-900 text-white shadow' : 'text-slate-500 hover:text-slate-800'}`}>{label}</button>
              ))}
            </div>
          </div>
        </div>
        {shown.length === 0 ? (
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm py-16 text-center">
            <p className="text-[15px] text-slate-400">No modules match “{q}”.</p>
          </div>
        ) : layout === 'grid' ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
            {shown.map((c) => (
              <button key={c.key} onClick={() => open(c)}
                className="text-left bg-white rounded-xl border border-slate-200 shadow-sm p-4 flex items-start gap-3 hover:border-teal-400 hover:shadow-md transition-all">
                <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: `${c.color}18`, color: c.color }}><c.icon size={18} /></div>
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-black text-slate-800 leading-tight">{c.title.replace(' Configuration', '')}</p>
                  <p className="text-[11px] text-slate-400 mt-0.5">{c.goto ? `Open ${c.goto}` : 'Configuration'}</p>
                </div>
                <ChevronRight size={15} className="text-slate-300 flex-shrink-0 mt-1" />
              </button>
            ))}
          </div>
        ) : (
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm divide-y divide-slate-100 overflow-hidden">
            {shown.map((c) => (
              <button key={c.key} onClick={() => open(c)} className="w-full flex items-center gap-4 px-5 py-3 hover:bg-slate-50 text-left transition-colors">
                <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: `${c.color}18`, color: c.color }}><c.icon size={18} /></div>
                <div className="flex-1 min-w-0"><p className="text-[14px] font-bold text-slate-800">{c.title}</p></div>
                {c.goto && <span className="text-[11px] text-slate-400 font-bold flex-shrink-0">→ {c.goto}</span>}
                <ChevronRight size={16} className="text-slate-300 flex-shrink-0" />
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  const card = CARDS.find((c) => c.key === view) || {};
  const back = <BackBtn onClick={() => setView(null)} label="Configuration Files" />;
  let body;

  if (view === 'database') {
    return <DatabaseConfigPanel id={id} isWin={isWin} data={data} navigate={navigate} onBack={() => setView(null)} />;
  }
  // These already have a full, real panel elsewhere (same one their own tab uses) —
  // show it right here instead of sending the user off to a different tab.
  if (view === 'network') {
    return <>{back}<NetworkPanel data={data} id={id} navigate={navigate} /></>;
  }
  if (view === 'service') {
    return <>{back}<ServicesPanel id={id} /></>;
  }
  if (view === 'process') {
    return <>{back}<ProcessesPanel processes={data.processes || []} id={id} /></>;
  }
  const IP_SUBVIEW = { ip: null, dns: 'dns', proxy: 'proxy', routing: 'advanced', firewall: 'firewall' };
  if (view in IP_SUBVIEW) {
    return <>{back}<IpConfigMenu data={data} id={id} navigate={navigate} isWin={isWin} initialView={IP_SUBVIEW[view]} /></>;
  }
  const modCfg = moduleConfig(view, isWin, card.title);
  if (modCfg) {
    return <ConfigModulePanel id={id} isWin={isWin} cfg={modCfg} navigate={navigate} onBack={() => setView(null)} />;
  } else if (view === 'memory') {
    body = <Section title="Memory Configuration" icon={MemoryStick} color={C.violet}><FieldGrid items={[
      ['Total', mem.total_mb != null ? fmtMB(mem.total_mb) : null], ['Used', mem.used_mb != null ? fmtMB(mem.used_mb) : null],
      ['Free', mem.free_mb != null ? fmtMB(mem.free_mb) : null], ['Available', mem.available_mb != null ? fmtMB(mem.available_mb) : null],
      ['Used %', mem.used_pct != null ? `${mem.used_pct}%` : null],
    ]} /></Section>;
  } else if (view === 'filesystem' || view === 'partition' || view === 'disk' || view === 'storage') {
    body = <Section title={card.title} icon={HardDrive} count={fss.length} color={C.green}>
      <Table headers={['Mount', 'Filesystem', 'Size', 'Used', 'Avail', 'Use %']}
        rows={fss.map((f) => [
          <span className="font-bold text-slate-800">{f.mount}</span>,
          <span className="font-mono text-[13px] text-slate-500">{f.filesystem}</span>,
          f.size, f.used, f.avail,
          <span className="font-bold" style={{ color: pctColor(pctNum(f.use_pct)) }}>{f.use_pct}%</span>,
        ])} empty="No filesystem data" />
    </Section>;
  } else {
    const hint = CFG_FILE_HINTS[view];
    const paths = hint ? (isWin ? (hint.win || hint.linux) : (hint.linux || hint.win)) || [] : [];
    body = (
      <Section title={card.title} icon={card.icon || Settings2} color={C.slate}>
        <div className="py-2">
          <p className="text-[14px] text-slate-600">Inspect and manage this host's <b>{card.title.replace(' Configuration', '').toLowerCase()}</b> settings.</p>
          {paths.length > 0 && (
            <div className="mt-4">
              <p className="text-[12px] font-bold text-slate-400 uppercase mb-1.5">Typical sources on this host</p>
              <div className="flex flex-wrap gap-1.5">
                {paths.map((p) => <span key={p} className="font-mono text-[12px] px-2.5 py-1 rounded-lg bg-slate-50 border border-slate-200 text-slate-600">{p}</span>)}
              </div>
            </div>
          )}
          <div className="mt-5 flex flex-wrap gap-2">
            <button onClick={() => navigate(`/infra/${id}/files?path=${encodeURIComponent(isWin ? 'C:' : '/etc')}`)}
              className="h-10 px-4 rounded-lg bg-slate-800 text-white text-[13px] font-bold hover:bg-slate-700 flex items-center gap-2"><Folder size={15} /> Open File Explorer</button>
            <button onClick={() => setTab('Services')} className="h-10 px-4 rounded-lg border border-slate-300 text-slate-700 text-[13px] font-bold hover:bg-slate-50">View Services</button>
          </div>
          <p className="text-[12px] text-slate-400 mt-4">Structured collection &amp; inline editing for this module is planned — the card is wired and ready to fill in. Meanwhile you can open the relevant files in the File Explorer.</p>
        </div>
      </Section>
    );
  }

  return <>{back}{body}</>;
}

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

// MySQL-dashboard KPI card: white, left accent bar, small uppercase title + big value.
function Kpi({ icon: Icon, title, value, sub, accent = 'cyan' }) {
  const acc = {
    cyan: 'border-l-cyan-500', teal: 'border-l-teal-500', green: 'border-l-green-500',
    blue: 'border-l-blue-500', orange: 'border-l-orange-500', red: 'border-l-red-500',
    purple: 'border-l-purple-500', slate: 'border-l-slate-400',
  };
  return (
    <div className={`bg-white rounded-xl border border-slate-200 border-l-4 ${acc[accent] || acc.slate} p-4 hover:shadow-md transition-all`}>
      <div className="flex justify-between items-start">
        <div className="min-w-0">
          <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wide">{title}</p>
          <p className="text-lg font-black text-slate-800 mt-1 truncate">{value ?? 'N/A'}</p>
          {sub && <p className="text-[11px] text-slate-400 mt-0.5 truncate">{sub}</p>}
        </div>
        <Icon size={20} className="text-slate-300 mt-0.5 flex-shrink-0" />
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

// Drill-menu card — click to open a sub-view.
function MenuCard({ icon: Icon, title, desc, count, color, onClick }) {
  return (
    <button onClick={onClick}
      className="text-left bg-white rounded-2xl border border-slate-200 shadow-sm p-5 flex items-start gap-4 hover:border-cyan-400 hover:shadow-md transition-all">
      <div className="w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: `${color}18`, color }}>
        <Icon size={24} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-[16px] font-black text-slate-800">{title}</p>
          {count != null && <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 text-[12px] font-bold">{count}</span>}
        </div>
        <p className="text-[14px] text-slate-500 mt-1 leading-relaxed">{desc}</p>
      </div>
      <ChevronRight size={20} className="text-slate-300 flex-shrink-0 mt-1" />
    </button>
  );
}

const BackBtn = ({ onClick, label = 'Back' }) => (
  <button onClick={onClick} className="h-9 px-4 rounded-lg border border-slate-300 bg-white text-slate-700 text-[13px] font-bold hover:bg-slate-100 flex items-center gap-1.5 mb-3">
    <ArrowLeft size={14} /> {label}
  </button>
);

/* ── Azure-Monitor-style overview building blocks ── */
// Grey section band ("Performance", "Inventory", …).
function SectionBand({ icon: Icon, title, right }) {
  return (
    <div className="flex items-center gap-2.5 mt-6 mb-3 first:mt-0">
      {Icon && <Icon size={18} className="text-slate-400" />}
      <h2 className="text-lg font-black text-slate-800 tracking-tight">{title}</h2>
      <div className="flex-1 h-px bg-slate-200" />
      {right}
    </div>
  );
}

// Well-known TCP ports → service label (for the Ports page "Service" column).
const WELL_KNOWN_PORTS = {
  20: 'FTP-data', 21: 'FTP', 22: 'SSH', 23: 'Telnet', 25: 'SMTP', 53: 'DNS', 67: 'DHCP', 68: 'DHCP',
  69: 'TFTP', 80: 'HTTP', 88: 'Kerberos', 110: 'POP3', 111: 'RPCbind', 123: 'NTP', 135: 'MS RPC',
  137: 'NetBIOS', 138: 'NetBIOS', 139: 'NetBIOS/SMB', 143: 'IMAP', 161: 'SNMP', 389: 'LDAP',
  443: 'HTTPS', 445: 'SMB', 465: 'SMTPS', 514: 'Syslog', 587: 'SMTP', 636: 'LDAPS', 873: 'rsync',
  993: 'IMAPS', 995: 'POP3S', 1080: 'SOCKS', 1194: 'OpenVPN', 1433: 'MSSQL', 1434: 'MSSQL', 1521: 'Oracle',
  1723: 'PPTP', 2049: 'NFS', 2181: 'ZooKeeper', 2375: 'Docker', 2376: 'Docker', 3000: 'Dev / Node',
  3306: 'MySQL / MariaDB', 3389: 'RDP', 4444: 'Metasploit', 5000: 'Dev / Flask', 5432: 'PostgreSQL',
  5601: 'Kibana', 5672: 'AMQP', 5900: 'VNC', 5985: 'WinRM', 5986: 'WinRM', 6379: 'Redis', 6443: 'Kubernetes',
  8000: 'HTTP-alt', 8080: 'HTTP-alt', 8443: 'HTTPS-alt', 8888: 'HTTP-alt', 9000: 'HTTP-alt',
  9092: 'Kafka', 9200: 'Elasticsearch', 9300: 'Elasticsearch', 11211: 'Memcached', 15672: 'RabbitMQ',
  27017: 'MongoDB', 27018: 'MongoDB', 5044: 'Logstash', 1883: 'MQTT', 8086: 'InfluxDB', 9090: 'Prometheus',
};
// Address exposure: all-interfaces (reachable off-box) vs loopback (local only).
const addrScope = (addr = '') => {
  const a = String(addr).trim();
  if (a === '0.0.0.0' || a === '::' || a === '*' || a === '[::]') return { label: 'All interfaces', cls: 'bg-amber-100 text-amber-700', hint: 'Reachable from the network' };
  if (a.startsWith('127.') || a === '::1' || a === '[::1]') return { label: 'Localhost', cls: 'bg-slate-100 text-slate-500', hint: 'Local only' };
  return { label: 'Bound', cls: 'bg-sky-100 text-sky-700', hint: 'Bound to a specific address' };
};

// Standardized, searchable listening-ports page (with password-gated kill).
function PortsPanel({ ports = [], id }) {
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [kill, setKill] = useState(null);   // {pid, process} pending kill
  const sorted = [...ports].sort((a, b) => (Number(a.port) || 0) - (Number(b.port) || 0));
  const t = q.trim().toLowerCase();
  const shown = !t ? sorted : sorted.filter((p) =>
    String(p.port).includes(t)
    || (p.address || '').toLowerCase().includes(t)
    || (p.process || '').toLowerCase().includes(t)
    || String(p.pid || '').includes(t)
    || (WELL_KNOWN_PORTS[p.port] || '').toLowerCase().includes(t));
  const exposed = sorted.filter((p) => addrScope(p.address).label === 'All interfaces').length;

  return (
    <Section title="Listening Ports" icon={Plug} count={ports.length} color={C.blue}
      action={
        <div className="flex items-center gap-2">
          {exposed > 0 && <span className="hidden sm:inline text-[11px] font-bold text-amber-600 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5">{exposed} network-exposed</span>}
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search port, service, process, PID…"
              className="h-8 w-64 pl-8 pr-3 rounded-lg border border-slate-300 text-[13px] outline-none focus:border-blue-400" />
          </div>
        </div>
      }>
      {ports.length === 0 ? (
        <p className="text-[15px] text-slate-400 py-2">No listening ports detected.</p>
      ) : (
        <div className="max-h-[62vh] overflow-y-auto border border-slate-200 rounded-xl">
          <table className="w-full table-fixed text-[14px]">
            <thead className="sticky top-0 z-10"><tr className="bg-slate-100 border-b border-slate-200">
              {['Port', 'Service', 'Address', 'Process', 'PID', 'Action'].map((h, hi) => (
                <th key={hi} className="px-4 py-2.5 text-left text-[11px] font-bold text-slate-500 uppercase tracking-wide whitespace-nowrap">{h}</th>))}
            </tr></thead>
            <tbody>
              {shown.map((p, i) => {
                const svc = WELL_KNOWN_PORTS[p.port];
                const sc = addrScope(p.address);
                return (
                  <tr key={`${p.port}-${p.pid}-${i}`} className={`border-b border-slate-100 hover:bg-blue-50/40 ${i % 2 ? 'bg-slate-50/40' : ''}`}>
                    <td className="px-4 py-2.5"><span className="font-mono font-black text-blue-700 text-[15px]">{p.port}</span></td>
                    <td className="px-4 py-2.5">{svc
                      ? <span className="text-[12px] font-bold px-2 py-0.5 rounded-md bg-indigo-50 text-indigo-700 border border-indigo-100">{svc}</span>
                      : <span className="text-slate-300">—</span>}</td>
                    <td className="px-4 py-2.5">
                      <span className="flex items-center gap-2">
                        <span className="font-mono text-[13px] text-slate-500 truncate max-w-[220px]">{p.address || '—'}</span>
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${sc.cls}`} title={sc.hint}>{sc.label}</span>
                      </span>
                    </td>
                    <td className="px-4 py-2.5 font-semibold text-slate-700 truncate" title={p.process || ''}>{p.process || '—'}</td>
                    <td className="px-4 py-2.5 font-mono text-slate-400 whitespace-nowrap">{p.pid || '—'}</td>
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      {p.pid ? (
                        <button onClick={() => setKill({ pid: p.pid, process: p.process })}
                          className="h-7 px-3 rounded-lg bg-red-50 text-red-700 border border-red-200 hover:bg-red-100 text-[12px] font-bold">
                          End process
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
              {shown.length === 0 && (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-slate-400 text-[14px]">No ports match “{q}”.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {kill && (
        <PasswordPrompt title={`End process ${kill.process || ''} (PID ${kill.pid})`} confirmLabel="End process" danger
          onConfirm={(pw) => killProcess(id, kill.pid, pw).then((r) => { qc.invalidateQueries({ queryKey: ['hostInfraDetail', id] }); return r; })}
          onClose={() => setKill(null)} />
      )}
    </Section>
  );
}

// Standardized, searchable processes page (with password-gated End process).
function ProcessesPanel({ processes = [], id }) {
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [end, setEnd] = useState(null);   // {pid, command} pending termination
  const sorted = [...processes].sort((a, b) => pctNum(b.cpu) - pctNum(a.cpu));
  const hasUser = sorted.some((p) => String(p.user || '').trim());   // Linux reports it; Windows doesn't
  const t = q.trim().toLowerCase();
  const shown = !t ? sorted : sorted.filter((p) =>
    String(p.pid).includes(t) || (p.user || '').toLowerCase().includes(t) || (p.command || '').toLowerCase().includes(t));

  return (
    <Section title="Top Processes" icon={Box} count={processes.length} color={C.violet}
      action={
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search PID, user, command…"
            className="h-8 w-64 pl-8 pr-3 rounded-lg border border-slate-300 text-[13px] outline-none focus:border-blue-400" />
        </div>
      }>
      {processes.length === 0 ? (
        <p className="text-[15px] text-slate-400 py-2">No process data.</p>
      ) : (
        <div className="max-h-[62vh] overflow-y-auto border border-slate-200 rounded-xl">
          <table className="w-full table-fixed text-[14px]">
            <thead className="sticky top-0 z-10"><tr className="bg-slate-100 border-b border-slate-200">
              {['PID', ...(hasUser ? ['User'] : []), 'CPU %', 'Memory %', 'Command', 'Action'].map((h) => (
                <th key={h} className="px-4 py-2.5 text-left text-[11px] font-bold text-slate-500 uppercase tracking-wide whitespace-nowrap">{h}</th>))}
            </tr></thead>
            <tbody>
              {shown.map((p, i) => {
                const cpu = pctNum(p.cpu), mem = pctNum(p.mem);
                return (
                  <tr key={`${p.pid}-${i}`} className={`border-b border-slate-100 hover:bg-blue-50/40 ${i % 2 ? 'bg-slate-50/40' : ''}`}>
                    <td className="px-4 py-2.5 font-mono text-slate-500 whitespace-nowrap">{p.pid}</td>
                    {hasUser && <td className="px-4 py-2.5 text-slate-600 whitespace-nowrap">{p.user}</td>}
                    <td className="px-4 py-2.5 font-bold whitespace-nowrap" style={{ color: pctColor(cpu) }}>{cpu}%</td>
                    <td className="px-4 py-2.5 font-bold whitespace-nowrap" style={{ color: pctColor(mem) }}>{mem}%</td>
                    <td className="px-4 py-2.5 font-mono text-[13px] text-slate-700 truncate" title={p.command}>{p.command}</td>
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      {p.pid ? (
                        <button onClick={() => setEnd({ pid: p.pid, command: p.command })}
                          className="h-7 px-3 rounded-lg bg-red-50 text-red-700 border border-red-200 hover:bg-red-100 text-[12px] font-bold">
                          End process
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
              {shown.length === 0 && (
                <tr><td colSpan={hasUser ? 6 : 5} className="px-4 py-8 text-center text-slate-400 text-[14px]">No processes match “{q}”.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {end && (
        <PasswordPrompt title={`End process ${end.command || ''} (PID ${end.pid})`} confirmLabel="End process" danger
          onConfirm={(pw) => killProcess(id, end.pid, pw).then((r) => { qc.invalidateQueries({ queryKey: ['hostInfraDetail', id] }); return r; })}
          onClose={() => setEnd(null)} />
      )}
    </Section>
  );
}

// White dashboard tile with a light title bar.
function DashTile({ title, sub, children, className = '', onClick }) {
  return (
    <div onClick={onClick}
      className={`bg-white rounded-xl border border-slate-200 shadow-sm flex flex-col ${onClick ? 'cursor-pointer hover:shadow-md hover:border-blue-300 transition-all' : ''} ${className}`}>
      <div className="px-4 pt-3.5 pb-2">
        <p className="text-[12px] font-black text-slate-600 leading-tight uppercase tracking-wide">{title}</p>
        {sub && <p className="text-[11px] text-slate-400 mt-0.5">{sub}</p>}
      </div>
      <div className="px-4 pb-4 flex-1 min-h-0">{children}</div>
    </div>
  );
}

// Horizontal ranked bar list (top processes, filesystem usage, …).
function RankBars({ items, unit = '%', empty = 'No data', onItem }) {
  if (!items.length) return <p className="text-[13px] text-slate-400 py-6 text-center">{empty}</p>;
  const top = Math.max(...items.map((i) => i.value), 1);
  return (
    <div className="space-y-2.5 pt-1">
      {items.map((it, idx) => {
        const w = unit === '%' ? Math.max(3, Math.min(100, it.value)) : Math.max(3, (it.value / top) * 100);
        const c = it.color || pctColor(it.value);
        return (
          <button key={`${it.name}${idx}`} onClick={onItem ? () => onItem(it) : undefined}
            className={`w-full text-left group ${onItem ? '' : 'cursor-default'}`}>
            <div className="flex items-center justify-between mb-1">
              <span className="text-[12px] font-semibold text-slate-600 truncate max-w-[62%] group-hover:text-blue-600">
                {it.name}{it.sub && <span className="text-slate-300 font-normal"> · {it.sub}</span>}
              </span>
              <span className="text-[12px] font-black" style={{ color: c }}>{it.right || `${it.value}${unit}`}</span>
            </div>
            <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
              <div className="h-full rounded-full" style={{ width: `${w}%`, background: c }} />
            </div>
          </button>
        );
      })}
    </div>
  );
}

function ProcTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="bg-white border border-slate-200 rounded-lg shadow-lg px-3 py-2 text-[12px]">
      <p className="font-black text-slate-800 mb-0.5">{p.name}</p>
      <p className="text-slate-500">CPU <b className="text-slate-700">{p.x}%</b> · Mem <b className="text-slate-700">{p.y}%</b></p>
    </div>
  );
}

// Per-process CPU vs Memory scatter.
function ProcScatter({ points }) {
  return (
    <ResponsiveContainer width="100%" height={230}>
      <ScatterChart margin={{ top: 10, right: 12, bottom: 22, left: -8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
        <XAxis type="number" dataKey="x" domain={[0, 100]} tick={{ fontSize: 10, fill: '#94a3b8' }}
          tickLine={false} axisLine={{ stroke: '#e2e8f0' }}
          label={{ value: 'CPU %', position: 'insideBottom', offset: -10, fontSize: 11, fill: '#94a3b8' }} />
        <YAxis type="number" dataKey="y" domain={[0, 100]} width={34} tick={{ fontSize: 10, fill: '#94a3b8' }}
          tickLine={false} axisLine={{ stroke: '#e2e8f0' }}
          label={{ value: 'Mem %', angle: -90, position: 'insideLeft', offset: 18, fontSize: 11, fill: '#94a3b8' }} />
        <ZAxis type="number" dataKey="z" range={[60, 180]} />
        <Tooltip content={<ProcTooltip />} cursor={{ strokeDasharray: '3 3' }} />
        <Scatter data={points}>
          {points.map((p, i) => <Cell key={i} fill={p.color} fillOpacity={0.75} />)}
        </Scatter>
      </ScatterChart>
    </ResponsiveContainer>
  );
}

export function InfraHostDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  // Cross-page navigation (e.g. from File Explorer's tab bar) can request a
  // starting tab via navigate(..., { state: { tab } }); default to Overview.
  const [tabRaw, setTabRaw] = useState(location.state?.tab || 'Overview');
  const [subView, setSubView] = useState(null);
  const [showRestart, setShowRestart] = useState(false);
  const [showUpdate, setShowUpdate] = useState(false);
  const tab = tabRaw;
  const setTab = (t) => { setTabRaw(t); setSubView(null); };

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['hostInfraDetail', id],
    queryFn: () => getHostInfraDetail(id),
    retry: false,
    refetchInterval: 30000,
  });

  const host = data?.host || {};
  const failed = data?.status === 'error';

  const isWin = (host.os_type || '').toLowerCase().startsWith('win');
  // IP Configuration is available for all hosts; on Windows it's read-only (from the
  // agent snapshot) since editing/firewall need the Linux job channel.
  const tabs = TABS;

  return (
    <DashboardScopeProvider tech="infra">
    <div className="-mx-6 md:-mx-8 min-h-full bg-slate-50 flex flex-col">
      {/* ─── TOP HEADER (MySQL-dashboard style) ─── */}
      <div className="bg-gradient-to-r from-slate-900 via-cyan-900 to-teal-800 text-white shadow-xl">
        <div className="px-6 py-4 flex flex-wrap justify-between items-center gap-3">
          <div className="flex items-center gap-4">
            <button onClick={() => navigate('/infra')} className="w-9 h-9 rounded-xl bg-white/10 hover:bg-white/20 border border-white/15 flex items-center justify-center text-white flex-shrink-0">
              <ArrowLeft size={17} />
            </button>
            <div className="w-12 h-12 bg-cyan-400/20 border border-cyan-400/40 rounded-2xl flex items-center justify-center text-2xl">
              {isWin ? '🪟' : '🐧'}
            </div>
            <div>
              <h1 className="text-2xl font-black tracking-tight">{host.server_name || `Host #${id}`}</h1>
              <p className="text-cyan-300 text-sm mt-0.5 font-mono">
                {host.hostname || host.ip_address || ''}{host.os_type ? ` · ${host.os_type}` : ''}
                {host.collector ? ` · via ${host.collector}` : ''}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <span className={`px-3 py-1.5 rounded-lg text-xs font-black border ${
              failed ? 'bg-red-500/20 border-red-400/40 text-red-200' : 'bg-emerald-500/20 border-emerald-400/40 text-emerald-200'}`}>
              {failed ? '● Offline' : '● Online'}
            </span>
            <button onClick={() => navigate(`/infra/${id}/files`)}
              className="px-3 py-1.5 rounded-lg border border-white/20 hover:bg-white/10 text-xs font-semibold text-white/80 hover:text-white">
              File Explorer
            </button>
            <button onClick={() => { setTab('IP Configuration'); }}
              className="px-3 py-1.5 rounded-lg border border-white/20 hover:bg-white/10 text-xs font-semibold text-white/80 hover:text-white">
              Firewall
            </button>
            {host.collector === 'agent' && isWin && (
              <button onClick={() => setShowUpdate(true)} title="Download the latest agent and upgrade in place"
                className="px-3 py-1.5 rounded-lg border border-sky-300/40 bg-sky-500/15 hover:bg-sky-500/25 text-xs font-semibold text-sky-100 flex items-center gap-1.5">
                <Download size={13} /> Update Agent
              </button>
            )}
            <button onClick={() => setShowRestart(true)}
              className="px-3 py-1.5 rounded-lg border border-amber-300/40 bg-amber-500/15 hover:bg-amber-500/25 text-xs font-semibold text-amber-100 flex items-center gap-1.5">
              <Power size={13} /> Restart
            </button>
            <button onClick={() => qc.invalidateQueries(['hostInfraDetail', id])}
              className="flex items-center gap-2 px-4 py-1.5 bg-white/10 hover:bg-white/20 border border-white/20 rounded-lg text-sm font-semibold">
              <RefreshCw size={13} className={isFetching ? 'animate-spin' : ''} /> Refresh
            </button>
          </div>
        </div>

        {/* ─── TAB BAR ─── */}
        <div className="px-4 pt-2 flex gap-0.5 overflow-x-auto border-t border-white/10">
          {tabs.map((t) => (
            <button key={t} onClick={() => setTab(t)}
              className={`flex items-center gap-2 px-4 py-2.5 text-xs font-semibold rounded-t-lg whitespace-nowrap transition-all ${
                tab === t ? 'bg-slate-50 text-cyan-700' : 'text-white/60 hover:text-white hover:bg-white/10'}`}>
              {t}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 p-5 space-y-4">
        {isLoading ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <Loader2 className="animate-spin text-cyan-600 mb-3" size={28} />
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
            {/* ── OVERVIEW (Azure-Monitor style tiled dashboard) ── */}
            {tab === 'Overview' && (() => {
              const mem = data.memory || {};
              const rootFs = (data.filesystems || []).reduce((m, f) => ((f.use_pct ?? 0) > (m?.use_pct ?? -1) ? f : m), null);
              const procs = data.processes || [];
              const topMem = procs.map((p) => ({ name: p.command, sub: `pid ${p.pid}`, value: pctNum(p.mem) }))
                .sort((a, b) => b.value - a.value).slice(0, 6);
              const topCpu = procs.map((p) => ({ name: p.command, sub: `pid ${p.pid}`, value: pctNum(p.cpu) }))
                .sort((a, b) => b.value - a.value).slice(0, 6);
              const scatter = procs.map((p) => ({ name: p.command, x: pctNum(p.cpu), y: pctNum(p.mem), z: 1, color: pctColor(pctNum(p.cpu)) }));
              const fsRank = (data.filesystems || [])
                .map((f) => ({ name: f.mount, mount: f.mount, value: pctNum(f.use_pct), color: pctColor(pctNum(f.use_pct)), right: `${f.used} / ${f.size} · ${pctNum(f.use_pct)}%` }))
                .sort((a, b) => b.value - a.value).slice(0, 8);
              const ifaces = data.interfaces || [];
              const ifUp = ifaces.filter((i) => String(i.state).toUpperCase() === 'UP').length;
              const cpu = pctNum(data.cpu_pct), memPct = pctNum(mem.used_pct), diskPct = pctNum(rootFs?.use_pct);
              const counts = [
                ['Ports', data.ports?.length ?? 0, 'Ports'],
                ['Processes', procs.length, 'Processes'],
                ['Filesystems', data.filesystems?.length ?? 0, 'Storage'],
                ['Interfaces', ifaces.length, 'Network'],
                ['Devices', data.neighbors?.length ?? 0, 'Network'],
                ['Connections', data.connections?.count ?? 0, 'Network'],
              ];
              return (
                <>
                  {/* ── PERFORMANCE ── */}
                  <SectionBand icon={Activity} title="Performance" />
                  <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-4 gap-4">
                    <DashTile title="CPU Utilization">
                      <Gauge pct={cpu} label="" colorFn={pctColor}
                        sub={data.load ? `load ${data.load.one} / ${data.load.five} / ${data.load.fifteen}` : 'processor load'} />
                    </DashTile>
                    <DashTile title="Memory Utilization">
                      <Gauge pct={memPct} label="" colorFn={pctColor}
                        sub={mem.total_mb ? `${fmtMB(mem.used_mb)} of ${fmtMB(mem.total_mb)}` : 'physical memory'} />
                    </DashTile>
                    <DashTile title="Disk — busiest mount">
                      <Gauge pct={diskPct} label="" colorFn={pctColor}
                        sub={rootFs ? `${rootFs.mount} · ${rootFs.used} / ${rootFs.size}` : 'no filesystem data'} />
                    </DashTile>
                    <DashTile title="Load & Uptime">
                      <div className="flex flex-col justify-center h-full gap-3 py-1">
                        <div>
                          <p className="text-[11px] font-bold text-slate-400 uppercase mb-1.5">Load average</p>
                          {data.load ? (
                            <div className="flex gap-2">
                              {[['1m', data.load.one], ['5m', data.load.five], ['15m', data.load.fifteen]].map(([k, v]) => (
                                <div key={k} className="flex-1 bg-slate-50 border border-slate-100 rounded-lg py-2 text-center">
                                  <p className="text-[16px] font-black text-slate-800 leading-none">{v}</p>
                                  <p className="text-[10px] text-slate-400 font-bold mt-0.5">{k}</p>
                                </div>
                              ))}
                            </div>
                          ) : <p className="text-[13px] text-slate-400">Not reported on this OS</p>}
                        </div>
                        <div>
                          <p className="text-[11px] font-bold text-slate-400 uppercase">Uptime</p>
                          <p className="text-[20px] font-black text-slate-800 leading-none mt-1">{(data.uptime || '—').replace(/^up\s*/, '')}</p>
                        </div>
                      </div>
                    </DashTile>
                  </div>

                  {/* ── INVENTORY ── */}
                  <SectionBand icon={Server} title="Inventory" />
                  <div className="grid grid-cols-3 md:grid-cols-6 gap-3">
                    {counts.map(([label, value, target]) => (
                      <button key={label} onClick={() => setTab(target)}
                        className="bg-white rounded-xl border border-slate-200 shadow-sm px-3 py-4 text-center hover:border-blue-400 hover:shadow transition-all">
                        <p className="text-[24px] font-black text-slate-800 leading-none">{value}</p>
                        <p className="text-[11px] font-bold text-slate-500 mt-1.5 uppercase tracking-wide">{label}</p>
                      </button>
                    ))}
                  </div>

                  {/* ── COMPUTE — PROCESSES ── */}
                  <SectionBand icon={Box} title="Compute — Processes" />
                  <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-4 gap-4">
                    <DashTile title="Top processes by CPU">
                      <RankBars items={topCpu} empty="No process data" onItem={() => setTab('Processes')} />
                    </DashTile>
                    <DashTile title="Top processes by Memory">
                      <RankBars items={topMem} empty="No process data" onItem={() => setTab('Processes')} />
                    </DashTile>
                    <DashTile title="Process CPU vs Memory" sub="each dot is a running process" className="xl:col-span-2">
                      {scatter.length ? <ProcScatter points={scatter} /> : <p className="text-[13px] text-slate-400 py-10 text-center">No process data</p>}
                    </DashTile>
                  </div>

                  {/* ── STORAGE & NETWORK ── */}
                  <SectionBand icon={HardDrive} title="Storage & Network" />
                  <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
                    <DashTile title="Filesystem usage" sub={isWin ? 'disk usage per mount' : 'click a mount to browse files'}>
                      <RankBars items={fsRank} empty="No filesystem data"
                        onItem={isWin ? undefined : (f) => navigate(`/infra/${id}/files?path=${encodeURIComponent(f.mount)}`)} />
                    </DashTile>
                    <DashTile title="Memory breakdown">
                      <div className="grid grid-cols-3 gap-2 h-full items-center">
                        {[['Total', mem.total_mb], ['Used', mem.used_mb], ['Free', mem.available_mb ?? mem.free_mb]].map(([k, v]) => (
                          <div key={k} className="bg-slate-50 border border-slate-100 rounded-xl p-3 text-center">
                            <p className="text-[11px] font-bold text-slate-400 uppercase">{k}</p>
                            <p className="text-[15px] font-black text-slate-800 mt-0.5">{v != null ? fmtMB(v) : '—'}</p>
                          </div>
                        ))}
                      </div>
                    </DashTile>
                    <DashTile title="Network">
                      <div className="grid grid-cols-3 gap-2 h-full items-center text-center">
                        {[['Interfaces', `${ifUp}/${ifaces.length}`, 'up'],
                          ['Connections', data.connections?.count ?? 0, 'active'],
                          ['Devices', data.neighbors?.length ?? 0, 'seen']].map(([k, v, s]) => (
                          <button key={k} onClick={() => setTab('Network')} className="hover:opacity-70">
                            <p className="text-[22px] font-black text-slate-800 leading-none">{v}</p>
                            <p className="text-[11px] font-bold text-slate-500 mt-1">{k}</p>
                            <p className="text-[10px] text-slate-400">{s}</p>
                          </button>
                        ))}
                      </div>
                    </DashTile>
                  </div>

                  {/* ── SYSTEM INFORMATION ── */}
                  <SectionBand icon={Info} title="System Information" />
                  <DashTile title="Host details">
                    <div className="divide-y divide-slate-100">
                      {[
                        ['Operating System', data.system?.os],
                        ['Kernel', data.system?.kernel],
                        ['Architecture', data.system?.architecture],
                        ['Hostname', data.system?.hostname],
                        ['IP Address', host.ip_address],
                        ['Environment', host.environment],
                        ['Collector', host.collector === 'agent' ? 'ActMon Agent (push)' : 'SSH (poll)'],
                        // Hardware / virtualization (from hostnamectl)
                        ['Virtualization', data.system?.virtualization],
                        ['Chassis', data.system?.chassis],
                        ['Hardware Vendor', data.system?.hardware_vendor],
                        ['Hardware Model', data.system?.hardware_model],
                        ['Machine ID', data.system?.machine_id],
                        ['Boot ID', data.system?.boot_id],
                        ['Firmware', data.system?.firmware_version && data.system?.firmware_date
                          ? `${data.system.firmware_version} (${data.system.firmware_date})`
                          : data.system?.firmware_version],
                      ].filter(([, v]) => v).map(([k, v]) => (
                        <div key={k} className="flex items-center gap-4 py-2.5">
                          <span className="w-48 flex-shrink-0 text-[13px] font-bold text-slate-500 uppercase tracking-wide">{k}</span>
                          <span className={`text-[15px] font-semibold text-slate-800 break-all ${['Machine ID', 'Boot ID'].includes(k) ? 'font-mono text-[13px]' : ''}`}>{v}</span>
                        </div>
                      ))}
                    </div>
                  </DashTile>
                </>
              );
            })()}

            {/* ── PORTS ── */}
            {tab === 'Ports' && <PortsPanel ports={data.ports || []} id={id} />}

            {/* ── PROCESSES ── */}
            {tab === 'Processes' && <ProcessesPanel processes={data.processes || []} id={id} />}

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
                          <tr key={i} onClick={() => navigate(`/infra/${id}/files?path=${encodeURIComponent(f.mount)}`)}
                            className={`border-b border-slate-100 cursor-pointer hover:bg-blue-50/50 ${i % 2 ? 'bg-slate-50/40' : ''}`}>
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
              </>
            )}

            {/* ── SERVICES (status + start/stop/restart) ── */}
            {tab === 'Services' && <ServicesPanel id={id} />}

            {/* ── DIAGNOSTICS (ping / port / dns) ── */}
            {tab === 'Diagnostics' && <DiagnosticsPanel id={id} />}

            {/* ── IP CONFIGURATION (card launcher) ── */}
            {tab === 'IP Configuration' && <IpConfigMenu data={data} id={id} navigate={navigate} isWin={isWin} />}

            {/* ── NETWORK (enterprise dashboard) ── */}
            {tab === 'Network' && <NetworkPanel data={data} id={id} navigate={navigate} />}

            {/* ── CONFIGURATION FILES (card launcher) ── */}
            {tab === 'Config Files' && <ConfigFilesMenu data={data} id={id} navigate={navigate} setTab={setTab} />}
          </>
        )}
      </div>

      {showUpdate && (
        <PasswordPrompt title="Update ActMon Agent" confirmLabel="Update Agent"
          onConfirm={(pw) => updateAgent(id, pw)} onClose={() => setShowUpdate(false)} />
      )}
      {showRestart && (
        <RestartModal id={id} hostName={host.server_name || `Host #${id}`} onClose={() => setShowRestart(false)} />
      )}
    </div>
    </DashboardScopeProvider>
  );
}

// Restart a service / reboot the host — requires the caller's password (re-auth).
export function RestartModal({ id, hostName, onClose, presetUnit, title }) {
  const [mode, setMode] = useState('service');   // 'service' | 'reboot'
  const [unit, setUnit] = useState(presetUnit || '');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const { data } = useQuery({ queryKey: ['services', id], queryFn: () => listServices(id), retry: false });
  const services = data?.services || [];

  const submit = async () => {
    if (!password) { setMsg({ ok: false, text: 'Enter your password to confirm.' }); return; }
    if (mode === 'service' && !unit.trim()) { setMsg({ ok: false, text: 'Choose or type a service to restart.' }); return; }
    setBusy(true); setMsg(null);
    try {
      const r = mode === 'reboot' ? await rebootHost(id, password) : await restartService(id, unit.trim(), password);
      setMsg({ ok: true, text: r.message || 'Done.' });
      setPassword('');
    } catch (e) {
      setMsg({ ok: false, text: errText(e, 'Action failed.') });
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 bg-gradient-to-r from-slate-900 to-slate-700 text-white flex items-center justify-between">
          <div className="flex items-center gap-2.5"><Power size={18} className="text-amber-300" /><h3 className="font-black text-[16px]">{title || `Restart — ${hostName}`}</h3></div>
          <button onClick={onClose} className="text-white/70 hover:text-white"><X size={18} /></button>
        </div>
        <div className="p-5">
          {/* mode toggle */}
          <div className="flex rounded-lg border border-slate-300 overflow-hidden mb-4 w-fit">
            <button onClick={() => setMode('service')} className={`px-4 h-9 text-[13px] font-bold ${mode === 'service' ? 'bg-slate-800 text-white' : 'bg-white text-slate-600'}`}>Restart a service</button>
            <button onClick={() => setMode('reboot')} className={`px-4 h-9 text-[13px] font-bold border-l border-slate-300 ${mode === 'reboot' ? 'bg-red-600 text-white' : 'bg-white text-slate-600'}`}>Reboot host</button>
          </div>

          {mode === 'service' ? (
            <div className="mb-3">
              <label className="block text-[13px] font-bold text-slate-600 mb-1.5">Service</label>
              <input list="svc-list" value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="e.g. mariadb.service"
                className="w-full h-10 px-3 rounded-lg border border-slate-300 text-[14px] font-mono outline-none focus:border-blue-400" />
              <datalist id="svc-list">{services.map((s) => <option key={s.unit} value={s.unit}>{s.description}</option>)}</datalist>
              {services.length > 0 && <p className="text-[12px] text-slate-400 mt-1">{services.length} running services detected — pick one or type a name.</p>}
            </div>
          ) : (
            <div className="mb-3 rounded-lg bg-red-50 border border-red-200 p-3 flex items-start gap-2.5">
              <AlertTriangle size={17} className="text-red-500 flex-shrink-0 mt-0.5" />
              <p className="text-[14px] text-red-700">This will <span className="font-black">reboot the entire host</span>. It will drop offline and return in a few minutes. All services on it restart.</p>
            </div>
          )}

          <label className="block text-[13px] font-bold text-slate-600 mb-1.5">Confirm your password</label>
          <div className="relative">
            <input type={showPw ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()} placeholder="Your ActMon login password"
              className="w-full h-10 px-3 pr-9 rounded-lg border border-slate-300 text-[14px] outline-none focus:border-blue-400" />
            <button onClick={() => setShowPw((v) => !v)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400">{showPw ? <EyeOff size={15} /> : <Eye size={15} />}</button>
          </div>

          {msg && <p className={`text-[13px] font-semibold mt-3 flex items-center gap-1.5 ${msg.ok ? 'text-emerald-600' : 'text-red-600'}`}>
            {msg.ok ? <Check size={14} /> : <AlertTriangle size={14} />}{msg.text}</p>}

          <div className="flex justify-end gap-2 mt-5">
            <button onClick={onClose} className="h-10 px-4 rounded-lg border border-slate-300 text-slate-600 text-[14px] font-bold hover:bg-slate-100">Cancel</button>
            <button onClick={submit} disabled={busy}
              className={`h-10 px-5 rounded-lg text-white text-[14px] font-bold disabled:opacity-50 flex items-center gap-2 ${mode === 'reboot' ? 'bg-red-600 hover:bg-red-700' : 'bg-slate-800 hover:bg-slate-700'}`}>
              {busy ? <Loader2 size={15} className="animate-spin" /> : <Power size={15} />}
              {mode === 'reboot' ? 'Reboot Host' : 'Restart Service'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
