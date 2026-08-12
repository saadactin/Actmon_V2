import React, { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Cell, ResponsiveContainer, ScatterChart, Scatter,
  XAxis, YAxis, ZAxis, CartesianGrid, Tooltip,
} from 'recharts';
import {
  getHostInfraDetail, getNetConfig, listFirewall, addFirewallRule, deleteFirewallRule,
  listServices, restartService, rebootHost, getNetFiles, fsList, fsRead, fsWrite,
  serviceAction, netDiag, killProcess, regGet, regSet, runCommand, updateAgent,
} from '@/api/servers';
import { getMetricsHistory } from '@/api/agents';
import { DashboardScopeProvider } from '@/context/DashboardAppearanceContext';
import cn from '@/lib/cn';
import Icon from '@/components/ui/Icon';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import IconButton from '@/components/ui/IconButton';
import Input from '@/components/ui/Input';
import Select from '@/components/ui/Select';
import PageHeader from '@/components/layout/PageHeader';
import Tabs from '@/components/ui/Tabs';
import Table, { EmptyState } from '@/components/ui/Table';
import ChartCard from '@/components/charts/ChartCard';
import Meter from '@/components/charts/Meter';
import { bandFor } from '@/components/charts/status';
import { hostStatus, osLabel } from './InfraHostCard';

/** Range → minutes back; granularity → the server-side average-bucket width —
    same picker and same history_bucketed backend as the Agent monitoring page
    (HostAgentPage.jsx), so a host's own trend reads identically wherever it's
    viewed. "Per Minute" default: the raw feed is 15s-cadence, too noisy to plot
    as-is over anything longer than a few minutes. */
const PERF_RANGE_OPTIONS = [
  { id: '60', label: 'Last 1 Hour' },
  { id: '240', label: 'Last 4 Hours' },
  { id: '1440', label: 'Last 24 Hours' },
  { id: '4320', label: 'Last 3 Days' },
  { id: '10080', label: 'Last 7 Days' },
  { id: 'custom', label: 'Custom' },
];
const PERF_GRANULARITY_OPTIONS = [
  { id: '60', label: 'Per Minute' },
  { id: '900', label: 'Per 15 Minutes' },
  { id: '1800', label: 'Per 30 Minutes' },
  { id: '3600', label: 'Per Hour' },
];

// Accent palette — the module-card / section colours, resolved from design
// tokens (chart slots + status tokens) instead of the old hardcoded hex map.
// Kept as a lookup object so every `color={C.xxx}` call site below reads the
// same as the ported original, just resolving to CSS variables instead of hex.
const C = {
  blue: 'var(--chart-1)', green: 'var(--chart-3)', amber: 'var(--warning)',
  red: 'var(--danger)', violet: 'var(--chart-7)', cyan: 'var(--info)', slate: 'var(--fg-subtle)',
};
// The categorical chart palette, cycled for the big "Configuration Files" module grid.
const CFG_PALETTE = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)', 'var(--chart-6)', 'var(--chart-7)', 'var(--chart-8)'];

// A process %'s should always read 0–100 (guards against a stale agent that once
// reported memory in MB rather than %).
const pctNum = (v) => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
// Every CPU/RAM/disk percentage on this page shares the one utilisation scale.
const pctColor = (p) => bandFor(pctNum(p)).color;

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
const TAB_ICONS = {
  Overview: 'activity', Ports: 'plug', Processes: 'box', Storage: 'desktop', Network: 'network',
  Services: 'settings2', Diagnostics: 'diagnose', 'IP Configuration': 'route', 'Config Files': 'file-edit',
};

// The axios response interceptor flattens every failure to `new Error(detail)`, so
// error.response is gone — the real text lives on error.message. Support both shapes.
const errText = (e, fb = 'Something went wrong. The host may be unreachable.') =>
  e?.response?.data?.detail || e?.message || fb;

/* ── small shared building blocks, used all over this page ─────────────── */

const LoadingLine = ({ label }) => (
  <p className="flex items-center gap-2 text-[15px] text-subtle"><Icon name="spinner" size={15} className="animate-spin" /> {label}</p>
);
const ErrorLine = ({ text }) => <p className="text-[15px] text-danger-fg">{text}</p>;
const MessageLine = ({ ok, text }) => (
  <p className={cn('mt-2 flex items-center gap-1.5 text-[13px] font-semibold', ok ? 'text-success-fg' : 'text-danger-fg')}>
    <Icon name={ok ? 'check' : 'alert'} size={14} />{text}
  </p>
);
const EmptyPane = ({ text }) => (
  <div className="min-h-[440px] flex items-center justify-center text-center border-2 border-dashed border-border rounded-control">
    <p className="text-[15px] text-subtle max-w-xs">{text}</p>
  </div>
);
const SpinnerPane = () => (
  <div className="min-h-[440px] flex items-center justify-center"><Icon name="spinner" size={20} className="animate-spin text-accent-text" /></div>
);

/** Card container with a title bar — the token-styled twin of the old "Section". */
/** `onBack` puts a small "← label" affordance at the very start of the header,
    in the same row as the section's own title — not as a separate full-width
    bar floating above the card, which read as its own disconnected element. */
function Section({ title, icon, count, color = C.blue, children, action, onBack, backLabel }) {
  return (
    <div className="card overflow-hidden">
      <div className="flex items-center gap-2 border-b border-border px-5 py-3.5">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            title={backLabel || 'Back'}
            aria-label={backLabel || 'Back'}
            className="-ml-1.5 flex shrink-0 items-center gap-1 rounded-control px-1.5 py-1 text-muted transition-colors hover:bg-sunken hover:text-fg"
          >
            <Icon name="arrow-left" size={14} />
            {backLabel && <span className="text-[12px] font-semibold">{backLabel}</span>}
          </button>
        )}
        {onBack && <span className="h-4 w-px bg-border" aria-hidden="true" />}
        {icon && <Icon name={icon} size={16} style={{ color }} />}
        <h3 className="text-[15px] font-bold text-fg">{title}</h3>
        {count != null && <Badge tone="neutral" size="xs" className="ml-1">{count}</Badge>}
        {action && <div className="ml-auto">{action}</div>}
      </div>
      <div className="p-5">{children}</div>
    </div>
  );
}

/** Small headers/rows table for the many ad-hoc drill lists (routes, ARP, errors…). */
function SimpleTable({ headers, rows, empty = 'No data' }) {
  if (!rows || rows.length === 0) return <p className="text-[15px] text-subtle py-2">{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[14px]">
        <thead><tr className="bg-sunken border-b border-border">
          {headers.map((h) => <th key={h} className="px-3.5 py-2.5 text-left text-[12px] font-bold text-subtle uppercase whitespace-nowrap">{h}</th>)}
        </tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={cn('border-b border-border', i % 2 === 1 && 'bg-sunken/40')}>
              {r.map((c, j) => <td key={j} className="px-3.5 py-2.5 text-fg align-top">{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Grid/list toggle used by every module-card launcher (Network, IP Config, Config Files). */
function ViewToggle({ layout, setLayout }) {
  return (
    <div className="flex overflow-hidden rounded-control border border-border">
      {[['grid', 'boxes', 'Grid'], ['list', 'rows', 'List']].map(([id, icon, label]) => (
        <button key={id} type="button" onClick={() => setLayout(id)} aria-pressed={layout === id} title={`${label} view`}
          className={cn('flex h-control items-center gap-1.5 px-3 text-[12px] font-semibold transition-colors',
            layout === id ? 'bg-accent text-accent-fg' : 'text-muted hover:bg-sunken hover:text-fg')}>
          <Icon name={icon} size={13} /><span className="hidden sm:inline">{label}</span>
        </button>
      ))}
    </div>
  );
}

/** `cards`: [{ key, icon, color, title, desc, count? }] */
function ModuleGrid({ cards, onOpen }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-gutter">
      {cards.map((c) => (
        <button key={c.key} onClick={() => onOpen(c)}
          className="card group flex items-start gap-4 p-card text-left transition-colors hover:border-strong hover:bg-raised">
          <span className="grid h-12 w-12 shrink-0 place-items-center rounded-md"
            style={{ background: `color-mix(in srgb, ${c.color} 16%, transparent)`, color: c.color }}>
            <Icon name={c.icon} size={22} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="text-[15px] font-bold text-fg">{c.title}</span>
              {c.count != null && <Badge tone="neutral" size="xs">{c.count}</Badge>}
            </span>
            <span className="mt-1 block text-[13px] leading-relaxed text-muted">{c.desc}</span>
          </span>
          <Icon name="chevron-right" size={18} className="mt-1 shrink-0 text-subtle" />
        </button>
      ))}
    </div>
  );
}

function ModuleList({ cards, onOpen }) {
  return (
    <div className="card divide-y divide-border overflow-hidden">
      {cards.map((c) => (
        <button key={c.key} onClick={() => onOpen(c)} className="flex w-full items-center gap-4 px-5 py-3.5 text-left transition-colors hover:bg-sunken">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-md"
            style={{ background: `color-mix(in srgb, ${c.color} 16%, transparent)`, color: c.color }}>
            <Icon name={c.icon} size={20} />
          </span>
          <span className="min-w-0 flex-1">
            <p className="text-[15px] font-bold text-fg">{c.title}</p>
            <p className="truncate-safe text-[13px] text-muted">{c.desc}</p>
          </span>
          {c.count != null && <Badge tone="neutral" size="xs" className="shrink-0">{c.count}</Badge>}
          <Icon name="chevron-right" size={16} className="shrink-0 text-subtle" />
        </button>
      ))}
    </div>
  );
}

// Advanced: edit real network config files, then apply by restarting networking.
function NetConfigEditor({ id, onBack, backLabel }) {
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
    <Section title="Edit Network Config" icon="file-edit" color={C.blue} onBack={onBack} backLabel={backLabel}
      action={netUnit && (
        <button onClick={() => setRestart(netUnit)}
          className="h-8 px-3 rounded-control bg-warning-soft text-warning-fg text-[13px] font-bold flex items-center gap-1.5 hover:opacity-80">
          <Icon name="power" size={13} /> Restart Networking
        </button>
      )}>
      {isLoading ? <LoadingLine label="Reading network configuration…" />
        : err ? <ErrorLine text={err} />
          : !data ? <p className="text-[15px] text-subtle">No network configuration available.</p>
          : (
            <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-4">
              {/* file list */}
              <div className="space-y-1.5">
                <p className="text-[12px] font-bold text-subtle uppercase mb-1">Config Files</p>
                {(data.files || []).map((f) => (
                  <div key={f.path}
                    className={cn('w-full px-3 py-2.5 rounded-control border transition-all flex items-center gap-2',
                      openPath === f.path ? 'border-accent-border bg-accent-soft' : 'border-border hover:border-strong hover:bg-sunken')}>
                    <button onClick={() => openFile(f.path)} className="flex items-center gap-2.5 min-w-0 flex-1 text-left">
                      <Icon name="report" size={16} className="text-accent-text flex-shrink-0" />
                      <span className="min-w-0">
                        <span className="block text-[14px] font-bold text-fg truncate">{f.label}</span>
                        <span className="block text-[12px] font-mono text-subtle truncate">{f.path}</span>
                      </span>
                    </button>
                    <IconButton icon="file-edit" label="Edit this file" size="sm" tone="accent" onClick={() => openFile(f.path)} />
                    <IconButton icon="power" label={`Restart ${unitFor(f.path)}`} size="sm" onClick={() => setRestart(unitFor(f.path))} />
                  </div>
                ))}
                {(data.files || []).length === 0 && <p className="text-[14px] text-subtle">No known network config files found.</p>}

                {/* Add / open an arbitrary config file (created on save if missing) */}
                <div className="flex items-center gap-1.5 pt-2 mt-1 border-t border-border">
                  <Input value={newPath} onChange={(e) => setNewPath(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && newPath.trim()) { openFile(newPath.trim()); setNewPath(''); } }}
                    placeholder="/etc/…  add or open a file" className="font-mono text-[12px]" wrapperClassName="flex-1" size="sm" />
                  <Button size="sm" variant="primary" icon="plus" disabled={!newPath.trim()}
                    onClick={() => { if (newPath.trim()) { openFile(newPath.trim()); setNewPath(''); } }}>Add</Button>
                </div>
                {netUnit && <p className="text-[12px] text-subtle mt-2">Active networking service: <span className="font-mono font-bold text-fg">{netUnit}</span></p>}
              </div>

              {/* editor */}
              <div>
                {!openPath ? (
                  <EmptyPane text="Select a config file on the left to view & edit it." />
                ) : loadingFile ? (
                  <SpinnerPane />
                ) : (
                  <>
                    <div className="flex items-center gap-2 mb-2">
                      <span className="font-mono text-[13px] font-bold text-fg">{openPath}</span>
                      {draft !== orig && <Badge tone="warning" size="xs">unsaved changes</Badge>}
                      <div className="ml-auto flex gap-2">
                        <Button size="sm" variant="secondary" disabled={draft === orig} onClick={() => setDraft(orig)}>Revert</Button>
                        <Button size="sm" variant="primary" icon="save" loading={saving} disabled={saving || draft === orig} onClick={save}>Save</Button>
                      </div>
                    </div>
                    <textarea value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false}
                      className="w-full h-[calc(100vh-340px)] min-h-[440px] p-3.5 rounded-control border border-border text-[13px] leading-relaxed font-mono text-fg outline-none focus:border-accent resize-y bg-sunken" />
                    {msg && <MessageLine ok={msg.ok} text={msg.text} />}
                    {dirtyApplied && (
                      <div className="mt-3 rounded-control bg-warning-soft p-3 flex items-center gap-3">
                        <Icon name="power" size={17} className="text-warning-fg flex-shrink-0" />
                        <p className="text-[14px] text-warning-fg flex-1">Config saved. Apply it by restarting <span className="font-mono font-bold">{unitFor(openPath)}</span>.</p>
                        <Button size="sm" variant="secondary" icon="power" onClick={() => setRestart(unitFor(openPath))}>Restart {unitFor(openPath)}</Button>
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
function FirewallPanel({ id, onBack, backLabel }) {
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
    <Section title="Firewall — IP Whitelist / Blacklist" icon="shield-check" color={C.violet} onBack={onBack} backLabel={backLabel}
      action={data?.source && <span className="text-[12px] font-bold text-subtle">via {data.source}</span>}>
      {/* Add form */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <Input value={ip} onChange={(e) => setIp(e.target.value)} placeholder="IP address or CIDR (e.g. 10.0.0.5 or 192.168.1.0/24)"
          onKeyDown={(e) => e.key === 'Enter' && add()} className="font-mono" wrapperClassName="flex-1 min-w-[240px]" />
        <div className="flex rounded-control border border-border overflow-hidden">
          <button onClick={() => setAction('allow')}
            className={cn('px-4 h-10 text-[13px] font-bold flex items-center gap-1.5', action === 'allow' ? 'bg-success text-white' : 'bg-surface text-muted hover:bg-sunken')}>
            <Icon name="shield-check" size={14} /> Allow
          </button>
          <button onClick={() => setAction('block')}
            className={cn('px-4 h-10 text-[13px] font-bold flex items-center gap-1.5 border-l border-border', action === 'block' ? 'bg-danger text-white' : 'bg-surface text-muted hover:bg-sunken')}>
            <Icon name="ban" size={14} /> Block
          </button>
        </div>
        <Button variant="primary" icon="plus" loading={busy} disabled={busy || !ip.trim()} onClick={add}>Add Rule</Button>
      </div>
      {msg && <p className="text-[14px] text-danger-fg mb-3">{msg}</p>}

      {isLoading ? <LoadingLine label="Loading rules…" />
        : err ? <ErrorLine text={err} />
          : rules.length === 0 ? (
            <p className="text-[15px] text-subtle">No firewall rules yet. Allowed IPs bypass restrictions; blocked IPs are dropped at the host.</p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <p className="text-[12px] font-bold text-success-fg uppercase mb-1.5 flex items-center gap-1.5"><Icon name="shield-check" size={13} /> Whitelist ({allow.length})</p>
                {allow.length === 0 && <p className="text-[14px] text-subtle">None</p>}
                {allow.map((r) => (
                  <div key={r.handle} className="flex items-center justify-between py-2 px-3 rounded-control bg-success-soft mb-1.5">
                    <span className="font-mono font-semibold text-success-fg text-[14px]">{r.ip}</span>
                    <IconButton icon="trash" label="Remove rule" size="sm" tone="danger" disabled={busy} onClick={() => remove(r.handle)} />
                  </div>
                ))}
              </div>
              <div>
                <p className="text-[12px] font-bold text-danger-fg uppercase mb-1.5 flex items-center gap-1.5"><Icon name="ban" size={13} /> Blacklist ({block.length})</p>
                {block.length === 0 && <p className="text-[14px] text-subtle">None</p>}
                {block.map((r) => (
                  <div key={r.handle} className="flex items-center justify-between py-2 px-3 rounded-control bg-danger-soft mb-1.5">
                    <span className="font-mono font-semibold text-danger-fg text-[14px]">{r.ip}</span>
                    <IconButton icon="trash" label="Remove rule" size="sm" tone="danger" disabled={busy} onClick={() => remove(r.handle)} />
                  </div>
                ))}
              </div>
            </div>
          )}
    </Section>
  );
}

// Reusable password re-auth modal for control actions (start/stop/restart).
export function PasswordPrompt({ title, confirmLabel = 'Confirm', danger, onConfirm, onClose }) {
  const [pw, setPw] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const go = async () => {
    if (!pw) { setMsg({ ok: false, text: 'Enter your password to confirm.' }); return; }
    setBusy(true); setMsg(null);
    try {
      const r = await onConfirm(pw);
      setMsg({ ok: true, text: r?.message || 'Done.' });
      setTimeout(onClose, 900);
    } catch (e) { setMsg({ ok: false, text: errText(e, 'Action failed.') }); }
    finally { setBusy(false); }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="card shadow-2xl w-full max-w-md overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Icon name="shield-check" size={18} className={danger ? 'text-danger' : 'text-accent-text'} />
            <h3 className="font-bold text-[15px] text-fg">{title}</h3>
          </div>
          <IconButton icon="close" label="Close" size="sm" onClick={onClose} />
        </div>
        <div className="p-5">
          <label className="block text-[13px] font-bold text-muted mb-1.5">Confirm your password to run this command</label>
          <div className="relative">
            <input type={show ? 'text' : 'password'} value={pw} onChange={(e) => setPw(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && go()} placeholder="Your ActMon login password" autoFocus
              className="w-full h-10 px-3 pr-9 rounded-control border border-border bg-surface text-fg placeholder:text-subtle outline-none focus:border-accent" />
            <button type="button" onClick={() => setShow((v) => !v)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-subtle hover:text-fg">
              <Icon name={show ? 'eye-off' : 'eye'} size={15} />
            </button>
          </div>
          {msg && <MessageLine ok={msg.ok} text={msg.text} />}
          <div className="flex justify-end gap-2 mt-5">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button variant={danger ? 'danger' : 'primary'} icon="check" loading={busy} disabled={busy} onClick={go}>{confirmLabel}</Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Services inventory + control (start / stop / restart, each password-gated).
function ServicesPanel({ id, onBack, backLabel }) {
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
  const stTone = (s) => (s === 'running' ? 'success' : s === 'failed' ? 'danger' : 'neutral');
  const cap = (a) => a.charAt(0).toUpperCase() + a.slice(1);

  const columns = [
    { key: 'service', label: 'Service' },
    { key: 'status', label: 'Status', width: 110 },
    { key: 'control', label: 'Control', width: 280 },
  ];
  const rows = shown.map((s) => ({
    key: s.unit,
    cells: {
      service: (
        <div>
          <p className="font-mono font-semibold text-fg text-[13px]">{s.unit}</p>
          {s.description && <p className="text-[12px] text-subtle truncate max-w-[420px]">{s.description}</p>}
        </div>
      ),
      status: <Badge tone={stTone(s.status)} size="xs">{s.status}</Badge>,
      control: (
        <div className="flex items-center gap-1.5">
          <button onClick={() => setPrompt({ unit: s.unit, action: 'start' })} disabled={s.status === 'running'}
            className="h-8 px-2.5 rounded-control bg-success-soft text-success-fg disabled:opacity-40 flex items-center gap-1 text-[12px] font-bold hover:opacity-80">
            <Icon name="play" size={12} /> Start
          </button>
          <button onClick={() => setPrompt({ unit: s.unit, action: 'stop' })} disabled={s.status !== 'running'}
            className="h-8 px-2.5 rounded-control bg-danger-soft text-danger-fg disabled:opacity-40 flex items-center gap-1 text-[12px] font-bold hover:opacity-80">
            <Icon name="stop" size={12} /> Stop
          </button>
          <button onClick={() => setPrompt({ unit: s.unit, action: 'restart' })}
            className="h-8 px-2.5 rounded-control bg-warning-soft text-warning-fg flex items-center gap-1 text-[12px] font-bold hover:opacity-80">
            <Icon name="restart" size={12} /> Restart
          </button>
        </div>
      ),
    },
  }));

  return (
    <Section title="Services" icon="settings2" color={C.violet} count={services.length} onBack={onBack} backLabel={backLabel}
      action={<Input icon="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter services…" size="sm" wrapperClassName="w-52" />}>
      {isLoading ? <LoadingLine label="Loading services…" />
        : err ? <ErrorLine text={err} />
          : services.length === 0 ? <p className="text-[15px] text-subtle">No services reported.</p>
            : (
              <Table columns={columns} rows={rows}
                empty={<EmptyState icon="settings2" title={`No services match "${q}"`} />} />
            )}
      {prompt && <PasswordPrompt title={`${cap(prompt.action)} — ${prompt.unit}`} confirmLabel={cap(prompt.action)} danger={prompt.action === 'stop'}
        onConfirm={(pw) => serviceAction(id, prompt.unit, prompt.action, pw).then((r) => { qc.invalidateQueries({ queryKey: ['services', id] }); return r; })}
        onClose={() => setPrompt(null)} />}
    </Section>
  );
}

// One diagnostic tool card (ping / TCP port test / DNS) — read-only, live.
function DiagTool({ id, kind, icon, color, title, desc, needsPort }) {
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
    <div className="card overflow-hidden">
      <div className="px-5 py-3.5 flex items-center gap-2 border-b border-border">
        <Icon name={icon} size={16} style={{ color }} /><h3 className="font-bold text-fg text-[15px]">{title}</h3>
      </div>
      <div className="p-5">
        <p className="text-[13px] text-muted mb-3">{desc}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Input value={target} onChange={(e) => setTarget(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && run()}
            placeholder="host or IP (e.g. 192.168.0.114)" className="font-mono" wrapperClassName="flex-1 min-w-[200px]" />
          {needsPort && <Input value={port} onChange={(e) => setPort(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && run()}
            placeholder="port" className="font-mono" wrapperClassName="w-24" />}
          <Button variant="primary" icon="play" loading={busy} disabled={busy || !target.trim()} onClick={run} style={{ background: color }}>Run</Button>
        </div>
        {res && (
          <div className="mt-3">
            <div className="flex items-center gap-2 mb-1.5">
              <Badge tone={res.reachable ? 'success' : 'danger'} size="xs">{res.reachable ? 'Reachable' : 'Unreachable'}</Badge>
              {res.source && <span className="text-[11px] text-subtle font-bold">via {res.source}</span>}
            </div>
            <pre className="bg-sunken text-fg border border-border rounded-control p-3.5 text-[12.5px] font-mono whitespace-pre-wrap break-all max-h-72 overflow-y-auto">{res.output}</pre>
          </div>
        )}
      </div>
    </div>
  );
}

function DiagnosticsPanel({ id }) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <DiagTool id={id} kind="ping" icon="radio" color={C.blue} title="Ping" desc="ICMP reachability & round-trip time to a host." />
      <DiagTool id={id} kind="port" needsPort icon="plug" color={C.violet} title="TCP Port Test" desc="Is a TCP port open? (like  Test-NetConnection host -Port 22)" />
      <DiagTool id={id} kind="dns" icon="globe" color={C.cyan} title="DNS Lookup" desc="Resolve a hostname to its IP addresses." />
    </div>
  );
}

/* ── Enterprise Network dashboard ── */
const CONN_STATE_ORDER = ['ESTABLISHED', 'LISTEN', 'TIME_WAIT', 'CLOSE_WAIT', 'FIN_WAIT', 'SYN_SENT', 'SYN_RECEIVED', 'LAST_ACK', 'CLOSING', 'CLOSED'];
const netUp = (s) => String(s || '').toLowerCase() === 'up';

function NetworkPanel({ data, id, navigate, onBack, backLabel }) {
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
    { key: 'iface_details', title: 'Network Interface Details', desc: 'MAC, MTU, speed, IPs, driver & type per interface.', icon: 'network', color: C.blue, count: ifaces.length },
    { key: 'realtime', title: 'Real-Time Traffic', desc: 'Live upload/download throughput & packet rates.', icon: 'activity', color: C.cyan },
    { key: 'conn_stats', title: 'Connection Statistics', desc: 'TCP states: established, listen, time_wait, etc.', icon: 'link', color: C.violet, count: tcpTotal },
    { key: 'errors', title: 'Network Errors', desc: 'Receive/send errors & dropped packets.', icon: 'alert', color: C.red, count: totalErrors },
    { key: 'iface_table', title: 'Network Interfaces Table', desc: 'All interfaces: status, speed, traffic, errors.', icon: 'server', color: C.green, count: ifaces.length },
    { key: 'dns', title: 'DNS Monitoring', desc: 'Configured resolvers & resolution health.', icon: 'globe', color: C.cyan, count: dns.length },
    { key: 'gateway', title: 'Gateway Monitoring', desc: 'Default gateway, reachability & latency.', icon: 'route', color: C.blue },
    { key: 'tcp_udp', title: 'TCP / UDP Monitoring', desc: 'TCP & UDP connections, top peers, ports.', icon: 'plug', color: C.amber, count: tcpTotal + udp },
    { key: 'ports', title: 'Open Ports', desc: 'Listening ports with process, PID & exposure.', icon: 'plug', color: C.violet, count: ports.length },
    { key: 'bandwidth', title: 'Bandwidth Utilization', desc: 'Current vs capacity utilization per link.', icon: 'activity', color: C.green },
    { key: 'wifi', title: 'Wi-Fi Information', desc: 'SSID, signal, channel, band & security.', icon: 'wifi', color: C.amber, count: wifi ? 1 : 0 },
    { key: 'routing', title: 'Routing Information', desc: 'Routing table, default & static routes.', icon: 'route', color: C.slate, count: routes.length },
    { key: 'arp', title: 'ARP Table', desc: 'IP-to-MAC neighbor mappings.', icon: 'radio', color: C.cyan, count: arp.length },
    { key: 'processes', title: 'Network Processes', desc: 'Processes bound to listening ports.', icon: 'box', color: C.violet, count: null },
    { key: 'historical', title: 'Historical Charts', desc: 'Traffic trends over 1h / 24h / 7d.', icon: 'clock', color: C.slate },
  ];

  /* ── Card menu ── */
  if (!view) {
    return (
      <div>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2.5">
            {onBack && (
              <>
                <button
                  type="button" onClick={onBack} title={backLabel || 'Back'} aria-label={backLabel || 'Back'}
                  className="-ml-1.5 flex shrink-0 items-center gap-1 rounded-control px-1.5 py-1 text-muted transition-colors hover:bg-sunken hover:text-fg"
                >
                  <Icon name="arrow-left" size={14} />
                  {backLabel && <span className="text-[12px] font-semibold">{backLabel}</span>}
                </button>
                <span className="h-4 w-px bg-border" aria-hidden="true" />
              </>
            )}
            <Icon name="network" size={18} className="text-success-fg" />
            <h2 className="text-lg font-bold text-fg tracking-tight">Network</h2>
            <Badge tone="neutral" size="xs">{CARDS.length} modules</Badge>
          </div>
          <ViewToggle layout={layout} setLayout={setLayout} />
        </div>
        {layout === 'grid' ? <ModuleGrid cards={CARDS} onOpen={(c) => setView(c.key)} /> : <ModuleList cards={CARDS} onOpen={(c) => setView(c.key)} />}
      </div>
    );
  }

  /* ── Drill-in section for the selected card ── */
  const card = CARDS.find((c) => c.key === view) || {};
  return (
    <NetworkView view={view} title={card.title} data={data} id={id} navigate={navigate}
      net={net} ifaces={ifaces} upCount={upCount} states={states} tcpTotal={tcpTotal} udp={udp}
      arp={arp} routes={routes} gateway={gateway} dns={dns} wifi={wifi} ports={ports}
      gwMac={gwMac} primaryIp={primaryIp} hasRates={hasRates} totalErrors={totalErrors}
      onBack={() => setView(null)} backLabel="Network" />
  );
}

// Renders the content for one Network module (the "develop one by one" surface).
function NetworkView(p) {
  const { view, title, ifaces, states, tcpTotal, udp, arp, routes, gateway, dns, wifi, ports, gwMac, primaryIp, hasRates, net, data, id, navigate, onBack, backLabel } = p;
  const soon = (msg) => (
    <Section title={title} icon="clock" color={C.slate} onBack={onBack} backLabel={backLabel}>
      <div className="py-10 text-center">
        <Icon name="clock" size={30} className="mx-auto text-subtle mb-3" />
        <p className="text-[15px] font-bold text-muted">{msg}</p>
      </div>
    </Section>
  );

  if (view === 'iface_table' || view === 'iface_details') {
    return (
      <Section title={view === 'iface_details' ? 'Network Interface Details' : 'Network Interfaces Table'} icon="network" count={ifaces.length} color={C.green} onBack={onBack} backLabel={backLabel}>
        <SimpleTable headers={['Interface', 'Status', 'Type', 'Speed', 'MTU', 'MAC', 'IPv4', 'IPv6', 'Driver']}
          rows={ifaces.map((i, k) => [
            <span className="font-mono font-bold text-fg" key={`n${k}`}>{i.name}
              {i.desc && i.desc !== i.name && <span className="block text-[11px] font-normal text-subtle truncate max-w-[240px]">{i.desc}</span>}</span>,
            <Badge tone={netUp(i.status) ? 'success' : 'neutral'} size="xs">{i.status || '—'}</Badge>,
            <span className="text-[12px] text-muted whitespace-nowrap">{i.type || '—'}</span>,
            i.speed_mbps ? `${i.speed_mbps} Mbps` : '—',
            i.mtu || '—',
            <span className="font-mono text-[12px] text-muted whitespace-nowrap">{i.mac || '—'}</span>,
            <span className="font-mono text-[12px] text-fg">{(i.ipv4 || []).join(', ') || '—'}</span>,
            <span className="font-mono text-[11px] text-subtle">{(i.ipv6 || []).join(', ') || '—'}</span>,
            <span className="text-[12px] text-muted whitespace-nowrap">{i.driver || '—'}</span>,
          ])} empty="No interfaces" />
      </Section>
    );
  }

  if (view === 'realtime' || view === 'bandwidth') {
    if (!hasRates) return soon('Live throughput populates after the agent reports twice (≈ one interval).');
    return (
      <Section title={view === 'realtime' ? 'Real-Time Traffic' : 'Bandwidth Utilization'} icon="activity" color={C.cyan} onBack={onBack} backLabel={backLabel}>
        <div className="grid grid-cols-2 gap-3 mb-4">
          <div className="rounded-control bg-info-soft p-4 text-center"><p className="text-[11px] font-bold text-info-fg uppercase">Total Download</p><p className="text-[26px] font-black text-info-fg mt-1">{net.total_download_mbps} <span className="text-[14px]">Mbps</span></p></div>
          <div className="rounded-control bg-accent-soft p-4 text-center"><p className="text-[11px] font-bold text-accent-text uppercase">Total Upload</p><p className="text-[26px] font-black text-accent-text mt-1">{net.total_upload_mbps} <span className="text-[14px]">Mbps</span></p></div>
        </div>
        {ifaces.filter((i) => netUp(i.status)).map((i) => {
          const dl = i.download_mbps || 0, ul = i.upload_mbps || 0;
          const util = i.download_util_pct ?? i.upload_util_pct;
          return (
            <div key={i.name} className="py-2 border-b border-border last:border-0">
              <div className="flex items-center justify-between text-[13px] mb-1">
                <span className="font-mono font-bold text-fg">{i.name}</span>
                <span className="text-muted">↓ {dl} · ↑ {ul} Mbps{i.speed_mbps ? ` / ${i.speed_mbps} Mbps` : ''}{util != null ? ` · ${util}%` : ''}</span>
              </div>
              <div className="h-2 bg-sunken rounded-full overflow-hidden"><div className="h-full rounded-full bg-info" style={{ width: `${Math.min(100, util || 0)}%` }} /></div>
            </div>
          );
        })}
      </Section>
    );
  }

  if (view === 'conn_stats' || view === 'tcp_udp') {
    return (
      <Section title={view === 'tcp_udp' ? 'TCP / UDP Monitoring' : 'Connection Statistics'} icon="globe" color={C.slate} onBack={onBack} backLabel={backLabel}>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2.5">
          {CONN_STATE_ORDER.map((s) => (
            <div key={s} className="bg-sunken rounded-control p-2.5 text-center">
              <p className="text-[18px] font-black text-fg leading-none">{states[s] ?? 0}</p>
              <p className="text-[10px] font-bold text-subtle mt-1">{s.replace(/_/g, ' ')}</p>
            </div>
          ))}
          <div className="bg-sunken rounded-control p-2.5 text-center"><p className="text-[18px] font-black text-fg leading-none">{udp}</p><p className="text-[10px] font-bold text-subtle mt-1">UDP ENDPOINTS</p></div>
          <div className="bg-sunken rounded-control p-2.5 text-center"><p className="text-[18px] font-black text-fg leading-none">{tcpTotal}</p><p className="text-[10px] font-bold text-subtle mt-1">TCP TOTAL</p></div>
        </div>
        {(data.connections?.peers || []).length > 0 && (
          <>
            <p className="text-[12px] font-bold text-subtle uppercase mt-4 mb-1.5">Top Remote Peers</p>
            <div className="flex flex-wrap gap-1.5">{(data.connections.peers || []).slice(0, 40).map((pr, i) => <span key={i} className="font-mono text-[12px] px-2 py-0.5 rounded-control bg-sunken border border-border text-muted">{pr}</span>)}</div>
          </>
        )}
        {Object.keys(states).length === 0 && <p className="text-[13px] text-subtle mt-3">Connection-state breakdown needs the updated agent.</p>}
      </Section>
    );
  }

  if (view === 'errors') {
    return (
      <Section title="Network Errors" icon="alert" color={C.red} onBack={onBack} backLabel={backLabel}>
        <SimpleTable headers={['Interface', 'Rx Errors', 'Tx Errors', 'Rx Dropped', 'Tx Dropped', 'Total']}
          rows={ifaces.map((i) => {
            const t = (i.rx_errors || 0) + (i.tx_errors || 0) + (i.rx_dropped || 0) + (i.tx_dropped || 0);
            return [
              <span className="font-mono font-bold text-fg">{i.name}</span>,
              i.rx_errors ?? '—', i.tx_errors ?? '—', i.rx_dropped ?? '—', i.tx_dropped ?? '—',
              <span className={t ? 'font-bold text-danger-fg' : 'text-subtle'}>{t}</span>,
            ];
          })} empty="No error counters (needs updated agent)" />
      </Section>
    );
  }

  if (view === 'dns') {
    return (
      <Section title="DNS Monitoring" icon="globe" color={C.cyan} onBack={onBack} backLabel={backLabel}>
        <p className="text-[12px] font-bold text-subtle uppercase mb-2">Configured DNS Servers</p>
        {dns.length ? dns.map((s, i) => <div key={i} className="font-mono text-[14px] text-fg py-1 border-b border-border last:border-0">{s}</div>) : <p className="text-subtle">No DNS servers reported.</p>}
        <button onClick={() => navigate && navigate(`/infra/${id}`)} className="text-[12px] font-bold text-accent-text hover:underline mt-3">Run a live DNS lookup in the Diagnostics tab →</button>
      </Section>
    );
  }

  if (view === 'gateway') {
    return (
      <Section title="Gateway Monitoring" icon="route" color={C.blue} onBack={onBack} backLabel={backLabel}>
        <div className="divide-y divide-border text-[14px]">
          {[['Default Gateway', gateway], ['Gateway MAC', gwMac || '—'], ['Primary IPv4', primaryIp]].map(([k, v]) => (
            <div key={k} className="flex items-center gap-3 py-2.5"><span className="w-44 flex-shrink-0 text-[12px] font-bold text-muted uppercase">{k}</span><span className="font-mono text-fg break-all">{v}</span></div>
          ))}
        </div>
        <button onClick={() => navigate && navigate(`/infra/${id}`)} className="text-[12px] font-bold text-accent-text hover:underline mt-3">Ping the gateway (reachability / latency) in Diagnostics →</button>
      </Section>
    );
  }

  if (view === 'ports') {
    return (
      <Section title="Open Ports" icon="plug" count={ports.length} color={C.violet} onBack={onBack} backLabel={backLabel}>
        <div className="max-h-[60vh] overflow-y-auto">
          <SimpleTable headers={['Port', 'Address', 'Process', 'PID']}
            rows={[...ports].sort((a, b) => (a.port || 0) - (b.port || 0)).map((p) => [
              <span className="font-mono font-black text-accent-text">{p.port}</span>,
              <span className="font-mono text-[13px] text-muted">{p.address || '—'}</span>,
              <span className="font-semibold text-fg">{p.process || '—'}</span>,
              <span className="font-mono text-subtle">{p.pid || '—'}</span>,
            ])} empty="No listening ports" />
        </div>
      </Section>
    );
  }

  if (view === 'wifi') {
    if (!wifi) return soon('No Wi-Fi adapter detected on this host.');
    return (
      <Section title="Wi-Fi Information" icon="wifi" color={C.amber} onBack={onBack} backLabel={backLabel}>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-3 text-[14px]">
          {[['SSID', wifi.ssid], ['BSSID', wifi.bssid], ['Signal', wifi.signal], ['Channel', wifi.channel], ['Band', wifi.band], ['Radio', wifi.radio], ['Rx rate', wifi.rx_rate], ['Tx rate', wifi.tx_rate], ['Authentication', wifi.auth], ['Cipher', wifi.cipher]].filter(([, v]) => v).map(([k, v]) => (
            <div key={k}><span className="text-[11px] font-bold text-subtle uppercase block">{k}</span><span className="font-semibold text-fg">{v}</span></div>
          ))}
        </div>
      </Section>
    );
  }

  if (view === 'arp') {
    return (
      <Section title="ARP Table" icon="radio" count={arp.length} color={C.cyan} onBack={onBack} backLabel={backLabel}>
        <div className="max-h-[60vh] overflow-y-auto">
          <SimpleTable headers={['IP Address', 'MAC Address', 'Interface', 'Entry State']}
            rows={arp.map((a) => [
              <span className="font-mono font-semibold text-fg">{a.ip}</span>,
              <span className="font-mono text-[13px] text-muted">{a.mac || '—'}</span>,
              a.dev || '—',
              <span className={cn('text-[13px] font-bold', String(a.state).toUpperCase() === 'REACHABLE' ? 'text-success-fg' : 'text-subtle')}>{a.state}</span>,
            ])} empty="No ARP entries" />
        </div>
      </Section>
    );
  }

  if (view === 'routing') {
    return (
      <Section title="Routing Information" icon="route" count={routes.length} color={C.blue} onBack={onBack} backLabel={backLabel}>
        <div className="max-h-[60vh] overflow-y-auto">
          <SimpleTable headers={['Destination', 'Gateway', 'Interface', 'Metric']}
            rows={routes.map(parseRoute).map((r) => [
              <span className="font-mono font-semibold text-fg">{r.isDefault ? 'default' : r.dest}</span>,
              <span className="font-mono text-[13px] text-muted">{r.via && r.via !== '0.0.0.0' ? r.via : 'On-link'}</span>,
              <span className="text-[13px]">{r.dev || '—'}</span>,
              <span className="font-mono text-[13px] text-subtle">{r.metric ?? '—'}</span>,
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
      <Section title="Network Processes" icon="box" count={rows.length} color={C.violet} onBack={onBack} backLabel={backLabel}>
        <SimpleTable headers={['Process', 'PID', 'Listening Ports', 'Count']}
          rows={rows.map((r) => [
            <span className="font-semibold text-fg">{r.process}</span>,
            <span className="font-mono text-subtle">{r.pid || '—'}</span>,
            <span className="font-mono text-[12px] text-muted">{r.ports.sort((a, b) => a - b).join(', ')}</span>,
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
        <div key={k} className="flex flex-col border-b border-border pb-2">
          <span className="text-[11px] font-bold text-subtle uppercase tracking-wide">{k}</span>
          <span className="text-[14px] font-semibold text-fg break-all mt-0.5">
            {v == null || v === '' ? <span className="text-subtle font-normal">—</span> : v}
          </span>
        </div>
      ))}
    </div>
  );
}

function IpConfigMenu({ data, id, navigate, isWin, initialView, onBack, backLabel }) {
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
    { key: 'interface', title: 'Interface Configuration', desc: 'Name, type, status, MAC, MTU, link speed, driver.', icon: 'network', color: C.blue },
    { key: 'ipv4', title: 'IPv4 Configuration', desc: 'Address, subnet, gateway, DHCP lease details.', icon: 'globe', color: C.cyan },
    { key: 'ipv6', title: 'IPv6 Configuration', desc: 'Link-local, global address, prefix & lifetimes.', icon: 'globe', color: C.violet },
    { key: 'dns', title: 'DNS Configuration', desc: 'Primary/secondary DNS, suffixes, registration.', icon: 'globe', color: C.green },
    { key: 'proxy', title: 'Proxy Configuration', desc: 'Proxy server, port, PAC script, bypass list.', icon: 'shield-check', color: C.amber },
    { key: 'advanced', title: 'Advanced Configuration', desc: 'NetBIOS, WINS, routes, forwarding, jumbo frames.', icon: 'settings2', color: C.slate },
    { key: 'conflict', title: 'IP Conflict Detection', desc: 'Duplicate IP / MAC detection & conflict status.', icon: 'alert', color: C.red },
    { key: 'changes', title: 'Configuration Changes', desc: 'Last IP / gateway / DNS / DHCP change events.', icon: 'clock', color: C.slate },
    { key: 'validation', title: 'Validation Checks', desc: 'Gateway, DNS, internet & public-IP reachability.', icon: 'check', color: C.green },
    { key: 'export', title: 'Export Options', desc: 'Copy, JSON, CSV export of the IP configuration.', icon: 'save', color: C.blue },
    { key: 'import', title: 'Import Options', desc: 'Import configuration from JSON / CSV.', icon: 'plus', color: C.violet },
    { key: 'edit', title: 'Edit Network Config', desc: 'Edit hosts / interfaces files, restart networking.', icon: 'file-edit', color: C.cyan },
    { key: 'firewall', title: 'Firewall — Whitelist / Blacklist', desc: "Allow or block source IPs / CIDRs on this host's firewall.", icon: 'shield-check', color: C.violet },
  ];

  /* ── Card menu ── */
  if (!view) {
    return (
      <div>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2.5">
            {onBack && (
              <>
                <button
                  type="button" onClick={onBack} title={backLabel || 'Back'} aria-label={backLabel || 'Back'}
                  className="-ml-1.5 flex shrink-0 items-center gap-1 rounded-control px-1.5 py-1 text-muted transition-colors hover:bg-sunken hover:text-fg"
                >
                  <Icon name="arrow-left" size={14} />
                  {backLabel && <span className="text-[12px] font-semibold">{backLabel}</span>}
                </button>
                <span className="h-4 w-px bg-border" aria-hidden="true" />
              </>
            )}
            <Icon name="route" size={18} className="text-accent-text" />
            <h2 className="text-lg font-bold text-fg tracking-tight">IP Configuration</h2>
            <Badge tone="neutral" size="xs">{CARDS.length} modules</Badge>
          </div>
          <ViewToggle layout={layout} setLayout={setLayout} />
        </div>
        {layout === 'grid' ? <ModuleGrid cards={CARDS} onOpen={(c) => setView(c.key)} /> : <ModuleList cards={CARDS} onOpen={(c) => setView(c.key)} />}
        {isWin && <p className="text-[12px] text-subtle mt-3">Editing &amp; firewall run through the ActMon agent on Windows — keep the agent updated to enable them (viewing works now).</p>}
      </div>
    );
  }

  if (view === 'edit') return <NetConfigEditor id={id} onBack={() => setView(null)} backLabel="IP Configuration" />;
  if (view === 'firewall') return <FirewallPanel id={id} onBack={() => setView(null)} backLabel="IP Configuration" />;

  const ifaceSelect = ifaces.length > 1 ? (
    <select value={sel} onChange={(e) => setSel(+e.target.value)}
      className="mb-4 h-9 px-3 rounded-control border border-border bg-surface text-fg text-[13px] font-mono outline-none focus:border-accent">
      {ifaces.map((i, idx) => <option key={idx} value={idx}>{i.name}{i.status ? ` (${i.status})` : ''}</option>)}
    </select>
  ) : null;

  let body = null;

  if (view === 'interface') {
    body = (
      <Section title="Interface Configuration" icon="network" color={C.blue}>
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
      <Section title="IPv4 Configuration" icon="globe" color={C.cyan}>
        {ifaceSelect}
        <FieldGrid items={[
          ['IPv4 Address', ip4], ['Subnet Mask', p4 ? maskFromPrefix(p4) : null], ['CIDR Prefix Length', p4 ? `/${p4}` : null],
          ['Network Address', netAddr(ip4, p4)], ['Broadcast Address', bcastAddr(ip4, p4)], ['Default Gateway', gateway],
          ['IP Assignment', null], ['DHCP Server', null], ['DHCP Lease Obtained', null], ['DHCP Lease Expiry', null],
        ]} />
        <p className="text-[12px] text-subtle mt-3">DHCP lease &amp; assignment (static/DHCP) require the updated agent probe.</p>
      </Section>
    );
  } else if (view === 'ipv6') {
    const v6 = cur.ipv6 || [];
    const ll = v6.find((a) => /^fe80/i.test(a));
    const global = v6.find((a) => !/^fe80|^::1/i.test(a));
    body = (
      <Section title="IPv6 Configuration" icon="globe" color={C.violet}>
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
      <Section title="DNS Configuration" icon="globe" color={C.green}>
        <FieldGrid items={[
          ['Primary DNS Server', dns[0]], ['Secondary DNS Server', dns[1]],
          ['Additional DNS Servers', dns.slice(2).join(', ')], ['DNS Suffix', data.dns?.search],
          ['Connection-Specific DNS Suffix', null], ['DNS Registration Enabled', null],
          ['Dynamic DNS Enabled', null], ['DNS Resolution Status', null],
        ]} />
        <button onClick={() => setView('validation')} className="text-[12px] font-bold text-accent-text hover:underline mt-3">Run a live DNS reachability check →</button>
      </Section>
    );
  } else if (view === 'proxy') {
    body = (
      <Section title="Proxy Configuration" icon="shield-check" color={C.amber}>
        <FieldGrid items={[
          ['Proxy Enabled', null], ['Proxy Server', null], ['Proxy Port', null],
          ['Proxy Bypass List', null], ['Auto Detect Proxy', null], ['PAC Script URL', null],
        ]} />
        <p className="text-[12px] text-subtle mt-3">Proxy settings are not yet collected — planned via the agent (Windows: WinHTTP / registry, Linux: env &amp; APT/YUM proxy).</p>
      </Section>
    );
  } else if (view === 'advanced') {
    body = (
      <Section title="Advanced Configuration" icon="settings2" color={C.slate}>
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
      <Section title="IP Conflict Detection" icon="alert" color={conflict ? C.red : C.green}>
        <FieldGrid items={[
          ['Duplicate IP Detection', dupIp.length ? dupIp.map(([ip, c]) => `${ip} ×${c}`).join(', ') : 'None found'],
          ['Duplicate MAC Detection', dupMac.length ? dupMac.map(([m, c]) => `${m} ×${c}`).join(', ') : 'None found'],
          ['IP Conflict Status', conflict ? 'Conflict detected' : 'No conflict'],
          ['Last Conflict Time', null],
        ]} />
        <p className="text-[12px] text-subtle mt-3">Derived from the current ARP table. Continuous duplicate-address monitoring is planned.</p>
      </Section>
    );
  } else if (view === 'changes') {
    body = (
      <Section title="Configuration Changes" icon="clock" color={C.slate}>
        <FieldGrid items={[
          ['Last IP Address Change', null], ['Last Gateway Change', null], ['Last DNS Change', null],
          ['Last DHCP Renewal', null], ['Interface State Changes', null],
        ]} />
        <p className="text-[12px] text-subtle mt-3">Change history requires the time-series store — coming with Historical Charts.</p>
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
      <Section title="Validation Checks" icon="check" color={C.green}
        action={<Button size="sm" variant="primary" onClick={() => CHECKS.forEach(([, , , fn]) => fn())}>Run all checks</Button>}>
        <div className="divide-y divide-border">
          {CHECKS.map(([key, label, target, fn]) => {
            const r = checks[key];
            return (
              <div key={key} className="flex items-center gap-3 py-2.5">
                <span className="w-52 flex-shrink-0 text-[13px] font-bold text-fg">{label}</span>
                <span className="text-[12px] font-mono text-subtle flex-1 truncate">{target || ''}</span>
                {r?.loading ? <Icon name="spinner" size={15} className="animate-spin text-accent-text" />
                  : r ? <Badge tone={r.ok ? 'success' : 'danger'} size="xs">{r.ok ? 'PASS' : 'FAIL'}</Badge>
                    : <span className="text-[11px] text-subtle font-bold">not run</span>}
                <Button size="sm" variant="secondary" onClick={fn}>Test</Button>
              </div>
            );
          })}
        </div>
        <p className="text-[12px] text-subtle mt-3">DHCP-working &amp; IPv6-connectivity checks are planned.</p>
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
      <Section title="Export Options" icon="save" color={C.blue}>
        <div className="flex flex-wrap gap-2.5">
          <Button variant="primary" icon="copy" onClick={() => { navigator.clipboard?.writeText(JSON.stringify(cfg, null, 2)); }}>Copy IP Configuration</Button>
          <Button variant="secondary" onClick={() => dl(`${base}-ipconfig.json`, JSON.stringify(cfg, null, 2), 'application/json')}>Export as JSON</Button>
          <Button variant="secondary" onClick={() => dl(`${base}-ipconfig.csv`, csv, 'text/csv')}>Export as CSV</Button>
          <Button variant="secondary" onClick={() => window.print()}>Export as PDF (Print)</Button>
        </div>
        <pre className="mt-4 bg-sunken text-fg border border-border rounded-control p-3.5 text-[12px] font-mono max-h-72 overflow-auto">{JSON.stringify(cfg, null, 2)}</pre>
      </Section>
    );
  } else if (view === 'import') {
    body = (
      <Section title="Import Options" icon="plus" color={C.violet}>
        <p className="text-[14px] text-muted mb-3">Import a saved configuration to review or (with agent support) apply.</p>
        <div className="flex flex-wrap gap-2.5">
          <label className="h-10 px-4 rounded-control border border-border text-fg text-[13px] font-bold hover:bg-sunken flex items-center gap-2 cursor-pointer">
            Import JSON <input type="file" accept=".json" className="hidden" onChange={(e) => e.target.files?.[0] && alert(`Selected ${e.target.files[0].name}. Applying imported config will be enabled with agent write-support.`)} />
          </label>
          <label className="h-10 px-4 rounded-control border border-border text-fg text-[13px] font-bold hover:bg-sunken flex items-center gap-2 cursor-pointer">
            Import CSV <input type="file" accept=".csv" className="hidden" onChange={(e) => e.target.files?.[0] && alert(`Selected ${e.target.files[0].name}. Applying imported config will be enabled with agent write-support.`)} />
          </label>
        </div>
        <p className="text-[12px] text-subtle mt-3">Applying an imported configuration to a live host will run through the agent's network-edit channel (with a confirmation + password) — wiring in progress.</p>
      </Section>
    );
  } else {
    body = <Section title="Module" icon="info" color={C.slate}><p className="text-subtle py-6 text-center">Coming soon.</p></Section>;
  }

  // Detail views always go back to THIS component's own grid — not to whatever
  // embedded IpConfigMenu (that back button, if any, only appears on the grid
  // itself; see the `onBack` prop used above).
  return React.cloneElement(body, { onBack: () => setView(null), backLabel: 'IP Configuration' });
}

/* ── Configuration Files launcher ── */
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
  if (sub === 'files') return <OsFilesEditor id={id} isWin={isWin} files={cfg.files} note={cfg.filesNote} title={`${cfg.title} — Files`} backLabel={cfg.title} navigate={navigate} onBack={() => setSub(null)} />;
  if (sub === 'registry') return <OsRegistryPanel id={id} keys={cfg.regKeys} title={`${cfg.title} — Registry`} backLabel={cfg.title} onBack={() => setSub(null)} />;
  if (sub === 'commands') return <OsCommandsPanel id={id} isWin={isWin} commands={cfg.commands} title={`${cfg.title} — Commands`} backLabel={cfg.title} onBack={() => setSub(null)} />;

  const filesDesc = (cfg.files || []).slice(0, 3).map((f) => f.label).join(', ');
  const cards = [
    ...(cfg.regKeys && isWin ? [{ key: 'registry', title: 'Registry', icon: 'settings2', color: C.violet,
      desc: `${cfg.regKeys.length} key${cfg.regKeys.length === 1 ? '' : 's'} — view & edit values` }] : []),
    ...(cfg.files ? [{ key: 'files', title: 'Files', icon: 'file-edit', color: C.blue,
      desc: `${filesDesc}${(cfg.files || []).length > 3 ? '…' : ''} — view, edit & add` }] : []),
    ...(cfg.commands ? [{ key: 'commands', title: 'Commands', icon: 'terminal', color: C.green,
      desc: (cfg.commands || []).slice(0, 4).map((c) => c.label).join(' · ') }] : []),
  ];

  return (
    <Section title={cfg.title} icon="settings2" color={C.slate} onBack={onBack} backLabel="Configuration Files">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {cards.map((c) => (
          <button key={c.key} onClick={() => setSub(c.key)}
            className="card text-left p-5 flex items-start gap-4 hover:border-strong hover:bg-raised transition-colors">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-md" style={{ background: `color-mix(in srgb, ${c.color} 16%, transparent)`, color: c.color }}><Icon name={c.icon} size={22} /></span>
            <div className="min-w-0 flex-1">
              <p className="text-[15px] font-bold text-fg">{c.title}</p>
              <p className="text-[12px] text-subtle mt-0.5 leading-snug">{c.desc}</p>
            </div>
            <Icon name="chevron-right" size={16} className="text-subtle flex-shrink-0 mt-1" />
          </button>
        ))}
      </div>
    </Section>
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
    return <OsFilesEditor id={id} isWin={isWin} files={t.files} note={t.note} probe title={`${t.name} — Config Files`} backLabel="Database Configuration" navigate={navigate} onBack={() => setTech(null)} />;
  }

  return (
    <>
      <Section title="Database Configuration" icon="database" color={C.cyan} onBack={onBack} backLabel="Configuration Files"
        action={detected.length > 0 && (
          <button onClick={() => setShowAll((v) => !v)} className="text-[12px] font-bold text-info-fg hover:underline">
            {showAll ? 'Show detected only' : 'Show all supported'}
          </button>
        )}>
        {detected.length === 0 ? (
          <div className="mb-4 rounded-control bg-warning-soft px-3.5 py-2.5 flex items-start gap-2">
            <Icon name="info" size={15} className="text-warning-fg flex-shrink-0 mt-0.5" />
            <p className="text-[13px] text-warning-fg">No database engine detected on this host (checked listening ports &amp; processes). Showing all supported engines — open the one you installed.</p>
          </div>
        ) : (
          <p className="text-[13px] text-muted mb-3">{detected.length} database engine{detected.length === 1 ? '' : 's'} detected on this host.</p>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {list.map((t) => (
            <button key={t.key} onClick={() => setTech(t.key)}
              className={cn('text-left card p-5 flex items-start gap-4 transition-colors hover:bg-raised', t.detected ? 'border-accent-border hover:border-accent' : 'hover:border-strong')}>
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-md bg-info-soft text-info-fg"><Icon name="database" size={22} /></span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="text-[15px] font-bold text-fg">{t.name}</p>
                  {t.detected && <Badge tone="success" size="xs">Running</Badge>}
                </div>
                <p className="text-[12px] text-subtle mt-0.5">{t.files.length} config file{t.files.length === 1 ? '' : 's'} · port {t.ports.join(', ')}</p>
              </div>
              <Icon name="chevron-right" size={16} className="text-subtle flex-shrink-0 mt-1" />
            </button>
          ))}
        </div>
      </Section>
    </>
  );
}

// Files — view / edit / add real files; folder entries open in File Explorer;
// files that need a service bounce show a password-gated Restart.
function OsFilesEditor({ id, isWin, files, note, probe, title = 'Operating System — Files', backLabel = 'Operating System', navigate, onBack }) {
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
      <Section title={title} icon="file-edit" color={C.blue} onBack={onBack} backLabel={backLabel}>
        {note && (
          <div className="mb-4 rounded-control bg-info-soft px-3.5 py-2.5 flex items-start gap-2">
            <Icon name="info" size={15} className="text-info-fg flex-shrink-0 mt-0.5" />
            <p className="text-[13px] text-info-fg">{note}</p>
          </div>
        )}
        <div className="grid grid-cols-1 lg:grid-cols-[340px_1fr] gap-4">
          {/* file list */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between mb-1">
              <p className="text-[12px] font-bold text-subtle uppercase">Files</p>
              {probe && (
                probing ? <span className="text-[11px] text-subtle flex items-center gap-1"><Icon name="spinner" size={11} className="animate-spin" /> checking…</span>
                  : existCount > 0 ? <button onClick={() => setShowAllLoc((v) => !v)} className="text-[11px] font-bold text-accent-text hover:underline">{showAllLoc ? `Present only (${existCount})` : `All locations (${FILES.length})`}</button>
                    : null
              )}
            </div>
            {probe && !probing && existCount === 0 && (
              <div className="rounded-control bg-warning-soft px-3 py-2 mb-1">
                <p className="text-[12px] text-warning-fg">None of the standard config files were found on this host — this engine may not be installed here, or lives at a custom path. Use the box below to open an exact path{!showAllLoc ? ', or ' : '.'}
                  {!showAllLoc && <button onClick={() => setShowAllLoc(true)} className="font-bold underline">show all {FILES.length} candidate locations</button>}{!showAllLoc && '.'}
                </p>
              </div>
            )}
            {visibleFiles.map((f) => (
              <div key={f.path}
                className={cn('w-full px-3 py-2.5 rounded-control border transition-all flex items-center gap-2',
                  openPath === f.path ? 'border-accent-border bg-accent-soft' : 'border-border hover:border-strong hover:bg-sunken')}>
                <button onClick={() => (f.dir ? browseDir(f.path) : openFile(f.path))}
                  className={cn('flex items-center gap-2.5 min-w-0 flex-1 text-left', probe && !probing && exist[f.path] === false && 'opacity-45')}>
                  <Icon name={f.dir ? 'folder' : 'report'} size={16} className={cn('flex-shrink-0', f.dir ? 'text-warning-fg' : 'text-accent-text')} />
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5 text-[14px] font-bold text-fg truncate">{f.label}
                      {probe && !probing && exist[f.path] === false && <Badge tone="neutral" size="xs" className="flex-shrink-0">not found</Badge>}
                    </span>
                    <span className="block text-[12px] font-mono text-subtle truncate">{f.path}</span>
                  </span>
                </button>
                {f.dir ? (
                  <IconButton icon="folder" label="Open in File Explorer" size="sm" onClick={() => browseDir(f.path)} />
                ) : (
                  <IconButton icon="file-edit" label="Edit this file" size="sm" tone="accent" onClick={() => openFile(f.path)} />
                )}
                {f.restart && <IconButton icon="power" label={`Restart ${f.restart}`} size="sm" onClick={() => setRestart(f.restart)} />}
              </div>
            ))}
            {/* Add / open an arbitrary file (created on save if missing) */}
            <div className="flex items-center gap-1.5 pt-2 mt-1 border-t border-border">
              <Input value={newPath} onChange={(e) => setNewPath(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && newPath.trim()) { openFile(newPath.trim()); setNewPath(''); } }}
                placeholder={isWin ? 'C:\\path\\to\\file  add or open' : '/etc/…  add or open a file'}
                className="font-mono text-[12px]" wrapperClassName="flex-1" size="sm" />
              <Button size="sm" variant="primary" icon="plus" disabled={!newPath.trim()}
                onClick={() => { if (newPath.trim()) { openFile(newPath.trim()); setNewPath(''); } }}>Add</Button>
            </div>
          </div>

          {/* editor / inline folder browser */}
          <div>
            {browse ? (
              <div>
                {/* breadcrumb + up */}
                <div className="flex items-center gap-2 mb-2">
                  <Icon name="folder" size={15} className="text-warning-fg flex-shrink-0" />
                  <span className="font-mono text-[13px] font-bold text-fg truncate flex-1">{browse.path}</span>
                  {browse.parent && browse.parent !== browse.path && (
                    <Button size="sm" variant="secondary" icon="arrow-left" onClick={() => browseDir(browse.parent)} className="flex-shrink-0">Up</Button>
                  )}
                  <IconButton icon="close" label="Close folder" size="sm" onClick={() => setBrowse(null)} />
                </div>
                {browse.loading ? (
                  <SpinnerPane />
                ) : browse.err ? <p className="text-[15px] text-danger-fg py-4">{browse.err}</p>
                  : (
                    <div className="border border-border rounded-control overflow-hidden max-h-[calc(100vh-360px)] min-h-[440px] overflow-y-auto divide-y divide-border">
                      {browse.entries.length === 0 && <p className="text-[14px] text-subtle px-4 py-6 text-center">This folder is empty.</p>}
                      {browse.entries.map((e) => {
                        const child = joinPath(browse.path, e.name);
                        const isDir = e.type === 'dir';
                        return (
                          <button key={e.name} onClick={() => (isDir ? browseDir(child) : openFile(child))}
                            className="w-full flex items-center gap-2.5 px-3.5 py-2 hover:bg-sunken text-left transition-colors">
                            <Icon name={isDir ? 'folder' : 'report'} size={15} className={isDir ? 'text-warning-fg flex-shrink-0' : 'text-accent-text flex-shrink-0'} />
                            <span className="text-[13px] font-semibold text-fg truncate flex-1">{e.name}</span>
                            {!isDir && e.size != null && <span className="text-[11px] text-subtle flex-shrink-0">{fmtBytes(e.size)}</span>}
                            <Icon name="chevron-right" size={14} className="text-subtle flex-shrink-0" />
                          </button>
                        );
                      })}
                    </div>
                  )}
                <p className="text-[12px] text-subtle mt-2">{browse.entries.length} item{browse.entries.length === 1 ? '' : 's'} · click a folder to open it, a file to view &amp; edit — all in place.</p>
              </div>
            ) : !openPath ? (
              <EmptyPane text="Select a file or folder on the left to open it here." />
            ) : loadingFile ? (
              <SpinnerPane />
            ) : (
              <>
                <div className="flex items-center gap-2 mb-2">
                  <span className="font-mono text-[13px] font-bold text-fg truncate">{openPath}</span>
                  {draft !== orig && <Badge tone="warning" size="xs" className="flex-shrink-0">unsaved changes</Badge>}
                  <div className="ml-auto flex gap-2 flex-shrink-0">
                    <Button size="sm" variant="secondary" disabled={draft === orig} onClick={() => setDraft(orig)}>Revert</Button>
                    <Button size="sm" variant="primary" icon="save" loading={saving} disabled={saving || draft === orig} onClick={save}>Save</Button>
                  </div>
                </div>
                <textarea value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false}
                  className="w-full h-[calc(100vh-340px)] min-h-[440px] p-3.5 rounded-control border border-border text-[13px] leading-relaxed font-mono text-fg outline-none focus:border-accent resize-y bg-sunken" />
                {msg && <MessageLine ok={msg.ok} text={msg.text} />}
                {saved && restartFor(openPath) && (
                  <div className="mt-3 rounded-control bg-warning-soft p-3 flex items-center gap-3">
                    <Icon name="power" size={17} className="text-warning-fg flex-shrink-0" />
                    <p className="text-[14px] text-warning-fg flex-1">Saved. Apply it by restarting <span className="font-mono font-bold">{restartFor(openPath)}</span>.</p>
                    <Button size="sm" variant="secondary" icon="power" onClick={() => setRestart(restartFor(openPath))}>Restart</Button>
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
function OsRegistryPanel({ id, keys, title = 'Operating System — Registry', backLabel = 'Operating System', onBack }) {
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
      <Section title={title} icon="settings2" color={C.violet} onBack={onBack} backLabel={backLabel}>
        <div className="grid grid-cols-1 lg:grid-cols-[340px_1fr] gap-4">
          {/* key list */}
          <div className="space-y-1.5">
            <p className="text-[12px] font-bold text-subtle uppercase mb-1">Registry Keys</p>
            {KEYS.map((k) => (
              <button key={k.key} onClick={() => load(k)}
                className={cn('w-full text-left px-3 py-2.5 rounded-control border transition-all',
                  sel?.key === k.key ? 'border-accent-border bg-accent-soft' : 'border-border hover:border-strong hover:bg-sunken')}>
                <span className="block text-[14px] font-bold text-fg">{k.label}</span>
                <span className="block text-[11px] font-mono text-subtle truncate">{k.key}</span>
              </button>
            ))}
            <div className="flex items-center gap-1.5 pt-2 mt-1 border-t border-border">
              <Input value={customKey} onChange={(e) => setCustomKey(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && customKey.trim()) load({ label: 'Custom key', key: customKey.trim() }); }}
                placeholder="HKLM\…  open a key" className="font-mono text-[12px]" wrapperClassName="flex-1" size="sm" />
              <Button size="sm" variant="primary" icon="search" disabled={!customKey.trim()}
                onClick={() => customKey.trim() && load({ label: 'Custom key', key: customKey.trim() })}>Open</Button>
            </div>
          </div>

          {/* values */}
          <div>
            {!sel ? (
              <EmptyPane text="Select a registry key to view & edit its values." />
            ) : loading ? (
              <SpinnerPane />
            ) : err ? <ErrorLine text={err} />
              : (
                <>
                  <p className="font-mono text-[12px] text-muted mb-2 break-all">{sel.key}</p>
                  {(!values || values.length === 0) ? <p className="text-[15px] text-subtle">No values under this key.</p> : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-[14px]">
                        <thead><tr className="bg-sunken border-b border-border">
                          {['Name', 'Value', 'Action'].map((h) => <th key={h} className="px-3.5 py-2.5 text-left text-[12px] font-bold text-subtle uppercase">{h}</th>)}
                        </tr></thead>
                        <tbody>
                          {values.map((v) => (
                            <tr key={v.name} className="border-b border-border align-top">
                              <td className="px-3.5 py-2.5 font-mono font-bold text-fg">{v.name}</td>
                              <td className="px-3.5 py-2.5">
                                {editing === v.name ? (
                                  <input value={draftVal} onChange={(e) => setDraftVal(e.target.value)} autoFocus
                                    className="w-full h-9 px-2.5 rounded-control border border-accent-border bg-surface text-fg text-[13px] font-mono outline-none focus:border-accent" />
                                ) : <span className="font-mono text-muted break-all">{v.value || <span className="text-subtle">—</span>}</span>}
                              </td>
                              <td className="px-3.5 py-2.5 whitespace-nowrap">
                                {editing === v.name ? (
                                  <div className="flex gap-1.5">
                                    <Button size="sm" variant="primary" icon="save" disabled={draftVal === (v.value || '')} onClick={() => setCommit({ name: v.name, value: draftVal })}>Save</Button>
                                    <Button size="sm" variant="secondary" onClick={() => setEditing(null)}>Cancel</Button>
                                  </div>
                                ) : (
                                  <Button size="sm" variant="subtle" icon="file-edit" onClick={() => { setEditing(v.name); setDraftVal(v.value || ''); }}>Edit</Button>
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
function OsCommandsPanel({ id, isWin, commands, title = 'Operating System — Commands', backLabel = 'Operating System', onBack }) {
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
      <Section title={title} icon="terminal" color={C.green} onBack={onBack} backLabel={backLabel}>
        <div className="flex flex-wrap gap-2 mb-4">
          {CMDS.map((c) => (
            <button key={c.key} onClick={() => run(c)} disabled={busy}
              className={cn('h-9 px-3.5 rounded-control text-[13px] font-bold flex items-center gap-1.5 border transition-all disabled:opacity-50',
                sel === c.key ? 'bg-accent text-accent-fg border-accent' : 'bg-surface text-fg border-border hover:border-strong')}>
              <Icon name="terminal" size={13} /> {c.label}
            </button>
          ))}
        </div>
        {busy ? <LoadingLine label="Running…" />
          : err ? <ErrorLine text={err} />
            : out ? <pre className="w-full max-h-[520px] overflow-auto p-4 rounded-control bg-sunken text-fg text-[12.5px] font-mono whitespace-pre-wrap break-words">{out}</pre>
              : <p className="text-[15px] text-subtle">Pick a command above to run it on this host. These are read-only informational commands.</p>}
      </Section>
    </>
  );
}

function ConfigFilesMenu({ data, id, navigate, setTab }) {
  const [view, setView] = useState(null);
  const [layout, setLayout] = useState('grid');
  const [q, setQ] = useState('');
  const isWin = /win/i.test(data.host?.os_type || '');
  const mem = data.memory || {};
  const fss = data.filesystems || [];

  const RAW = [
    ['Operating System Configuration', 'os', 'info'], ['Hardware Configuration', 'hardware', 'server'],
    ['CPU Configuration', 'cpu', 'cpu'], ['Memory Configuration', 'memory', 'memory'],
    ['Disk Configuration', 'disk', 'desktop'], ['Storage Configuration', 'storage', 'desktop'],
    ['Filesystem Configuration', 'filesystem', 'desktop'], ['Partition Configuration', 'partition', 'desktop'],
    ['Boot Configuration', 'boot', 'power'], ['Kernel Configuration', 'kernel', 'settings2'],
    ['Network Configuration', 'network', 'network'], ['IP Configuration', 'ip', 'route'],
    ['DNS Configuration', 'dns', 'globe'], ['Proxy Configuration', 'proxy', 'shield-check'],
    ['Routing Configuration', 'routing', 'route'], ['Firewall Configuration', 'firewall', 'shield-check'],
    ['Security Configuration', 'security', 'shield-check'], ['Authentication Configuration', 'auth', 'shield-check'],
    ['User Configuration', 'user', 'server'], ['Group Configuration', 'group', 'server'],
    ['SSH Configuration', 'ssh', 'settings2'], ['Service Configuration', 'service', 'settings2'],
    ['Process Configuration', 'process', 'box'], ['Environment Configuration', 'env', 'settings2'],
    ['System Variables Configuration', 'sysvars', 'settings2'], ['Time & NTP Configuration', 'ntp', 'clock'],
    ['Logging Configuration', 'logging', 'report'], ['Audit Configuration', 'audit', 'report'],
    ['Package Management Configuration', 'package', 'box'], ['Software Configuration', 'software', 'box'],
    ['Driver Configuration', 'driver', 'settings2'], ['Device Configuration', 'device', 'plug'],
    ['Printer Configuration', 'printer', 'plug'], ['USB Device Configuration', 'usb', 'plug'],
    ['Power Management Configuration', 'power', 'power'], ['Scheduled Tasks Configuration', 'tasks', 'clock'],
    ['Cron Configuration', 'cron', 'clock'], ['Certificate Configuration', 'cert', 'shield-check'],
    ['Virtualization Configuration', 'virt', 'box'], ['Container Configuration', 'container', 'box'],
    ['Docker Configuration', 'docker', 'box'], ['Kubernetes Configuration', 'k8s', 'box'],
    ['Cloud Configuration', 'cloud', 'globe'], ['Database Configuration', 'database', 'server'],
    ['Web Server Configuration', 'web', 'globe'], ['Application Server Configuration', 'appserver', 'server'],
    ['Mail Server Configuration', 'mail', 'globe'], ['File Sharing Configuration', 'fileshare', 'folder'],
    ['Remote Access Configuration', 'remote', 'plug'], ['Monitoring Configuration', 'monitoring', 'activity'],
    ['Backup Configuration', 'backup', 'save'], ['High Availability Configuration', 'ha', 'network'],
    ['Cluster Configuration', 'cluster', 'network'], ['Load Balancer Configuration', 'lb', 'network'],
    ['Storage Network Configuration', 'san', 'desktop'], ['VPN Configuration', 'vpn', 'shield-check'],
    ['Wireless Configuration', 'wireless', 'wifi'], ['Domain Configuration', 'domain', 'globe'],
    ['LDAP/Active Directory Configuration', 'ldap', 'server'], ['SELinux/AppArmor Configuration', 'selinux', 'shield-check'],
    ['Sysctl Configuration', 'sysctl', 'settings2'], ['Systemd Configuration', 'systemd', 'settings2'],
    ['Locale & Language Configuration', 'locale', 'globe'], ['Regional Settings Configuration', 'regional', 'globe'],
    ['License Configuration', 'license', 'report'],
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
            <Icon name="file-edit" size={18} className="text-info-fg" />
            <h2 className="text-lg font-bold text-fg tracking-tight">Configuration Files</h2>
            <Badge tone="neutral" size="xs">{term ? `${shown.length} of ${CARDS.length}` : `${CARDS.length} modules`}</Badge>
          </div>
          <div className="flex items-center gap-2">
            <Input icon="search" value={q} onChange={(e) => setQ(e.target.value)} onClear={() => setQ('')} placeholder="Search modules…" size="sm" wrapperClassName="w-56" />
            <ViewToggle layout={layout} setLayout={setLayout} />
          </div>
        </div>
        {shown.length === 0 ? (
          <div className="card py-16 text-center">
            <p className="text-[15px] text-subtle">No modules match “{q}”.</p>
          </div>
        ) : layout === 'grid' ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
            {shown.map((c) => (
              <button key={c.key} onClick={() => open(c)}
                className="text-left card p-4 flex items-start gap-3 hover:border-strong hover:bg-raised transition-colors">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md" style={{ background: `color-mix(in srgb, ${c.color} 16%, transparent)`, color: c.color }}><Icon name={c.icon} size={18} /></span>
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-bold text-fg leading-tight">{c.title.replace(' Configuration', '')}</p>
                  <p className="text-[11px] text-subtle mt-0.5">{c.goto ? `Open ${c.goto}` : 'Configuration'}</p>
                </div>
                <Icon name="chevron-right" size={15} className="text-subtle flex-shrink-0 mt-1" />
              </button>
            ))}
          </div>
        ) : (
          <div className="card divide-y divide-border overflow-hidden">
            {shown.map((c) => (
              <button key={c.key} onClick={() => open(c)} className="w-full flex items-center gap-4 px-5 py-3 hover:bg-sunken text-left transition-colors">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md" style={{ background: `color-mix(in srgb, ${c.color} 16%, transparent)`, color: c.color }}><Icon name={c.icon} size={18} /></span>
                <div className="flex-1 min-w-0"><p className="text-[14px] font-bold text-fg">{c.title}</p></div>
                {c.goto && <span className="text-[11px] text-subtle font-bold flex-shrink-0">→ {c.goto}</span>}
                <Icon name="chevron-right" size={16} className="text-subtle flex-shrink-0" />
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  const card = CARDS.find((c) => c.key === view) || {};
  const onBack = () => setView(null);
  const backLabel = 'Configuration Files';
  let body;

  if (view === 'database') {
    return <DatabaseConfigPanel id={id} isWin={isWin} data={data} navigate={navigate} onBack={onBack} />;
  }
  // These already have a full, real panel elsewhere (same one their own tab uses) —
  // show it right here instead of sending the user off to a different tab.
  if (view === 'network') {
    return <NetworkPanel data={data} id={id} navigate={navigate} onBack={onBack} backLabel={backLabel} />;
  }
  if (view === 'service') {
    return <ServicesPanel id={id} onBack={onBack} backLabel={backLabel} />;
  }
  if (view === 'process') {
    return <ProcessesPanel processes={data.processes || []} id={id} onBack={onBack} backLabel={backLabel} />;
  }
  const IP_SUBVIEW = { ip: null, dns: 'dns', proxy: 'proxy', routing: 'advanced', firewall: 'firewall' };
  if (view in IP_SUBVIEW) {
    return <IpConfigMenu data={data} id={id} navigate={navigate} isWin={isWin} initialView={IP_SUBVIEW[view]} onBack={onBack} backLabel={backLabel} />;
  }
  const modCfg = moduleConfig(view, isWin, card.title);
  if (modCfg) {
    return <ConfigModulePanel id={id} isWin={isWin} cfg={modCfg} navigate={navigate} onBack={() => setView(null)} />;
  } else if (view === 'memory') {
    body = <Section title="Memory Configuration" icon="memory" color={C.violet}><FieldGrid items={[
      ['Total', mem.total_mb != null ? fmtMB(mem.total_mb) : null], ['Used', mem.used_mb != null ? fmtMB(mem.used_mb) : null],
      ['Free', mem.free_mb != null ? fmtMB(mem.free_mb) : null], ['Available', mem.available_mb != null ? fmtMB(mem.available_mb) : null],
      ['Used %', mem.used_pct != null ? `${mem.used_pct}%` : null],
    ]} /></Section>;
  } else if (view === 'filesystem' || view === 'partition' || view === 'disk' || view === 'storage') {
    body = <Section title={card.title} icon="desktop" count={fss.length} color={C.green}>
      <SimpleTable headers={['Mount', 'Filesystem', 'Size', 'Used', 'Avail', 'Use %']}
        rows={fss.map((f) => [
          <span className="font-bold text-fg">{f.mount}</span>,
          <span className="font-mono text-[13px] text-muted">{f.filesystem}</span>,
          f.size, f.used, f.avail,
          <span className="font-bold" style={{ color: pctColor(f.use_pct) }}>{f.use_pct}%</span>,
        ])} empty="No filesystem data" />
    </Section>;
  } else {
    const hint = CFG_FILE_HINTS[view];
    const paths = hint ? (isWin ? (hint.win || hint.linux) : (hint.linux || hint.win)) || [] : [];
    body = (
      <Section title={card.title} icon={card.icon || 'settings2'} color={C.slate}>
        <div className="py-2">
          <p className="text-[14px] text-muted">Inspect and manage this host's <b className="text-fg">{card.title.replace(' Configuration', '').toLowerCase()}</b> settings.</p>
          {paths.length > 0 && (
            <div className="mt-4">
              <p className="text-[12px] font-bold text-subtle uppercase mb-1.5">Typical sources on this host</p>
              <div className="flex flex-wrap gap-1.5">
                {paths.map((p) => <span key={p} className="font-mono text-[12px] px-2.5 py-1 rounded-control bg-sunken border border-border text-muted">{p}</span>)}
              </div>
            </div>
          )}
          <div className="mt-5 flex flex-wrap gap-2">
            <Button variant="primary" icon="folder" onClick={() => navigate(`/infra/${id}/files?path=${encodeURIComponent(isWin ? 'C:' : '/etc')}`)}>Open File Explorer</Button>
            <Button variant="secondary" onClick={() => setTab('Services')}>View Services</Button>
          </div>
          <p className="text-[12px] text-subtle mt-4">Structured collection &amp; inline editing for this module is planned — the card is wired and ready to fill in. Meanwhile you can open the relevant files in the File Explorer.</p>
        </div>
      </Section>
    );
  }

  return React.cloneElement(body, { onBack, backLabel });
}

/* ── Overview building blocks ── */
// Grey section band ("Performance", "Inventory", …).
function SectionBand({ icon, title, right }) {
  return (
    <div className="flex items-center gap-2.5 mt-6 mb-3 first:mt-0">
      {icon && <Icon name={icon} size={18} className="text-subtle" />}
      <h2 className="text-lg font-bold text-fg tracking-tight">{title}</h2>
      <div className="flex-1 h-px bg-border" />
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
  if (a === '0.0.0.0' || a === '::' || a === '*' || a === '[::]') return { label: 'All interfaces', tone: 'warning', hint: 'Reachable from the network' };
  if (a.startsWith('127.') || a === '::1' || a === '[::1]') return { label: 'Localhost', tone: 'neutral', hint: 'Local only' };
  return { label: 'Bound', tone: 'info', hint: 'Bound to a specific address' };
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

  const columns = [
    { key: 'port', label: 'Port', width: 90 },
    { key: 'service', label: 'Service', width: 140 },
    { key: 'address', label: 'Address' },
    { key: 'process', label: 'Process' },
    { key: 'pid', label: 'PID', width: 90, align: 'right' },
    { key: 'action', label: 'Action', width: 130 },
  ];
  const rows = shown.map((p, i) => {
    const svc = WELL_KNOWN_PORTS[p.port];
    const sc = addrScope(p.address);
    return {
      key: `${p.port}-${p.pid}-${i}`,
      cells: {
        port: <span className="font-mono font-black text-accent-text text-[15px]">{p.port}</span>,
        service: svc ? <Badge tone="accent" size="xs">{svc}</Badge> : <span className="text-subtle">—</span>,
        address: (
          <span className="flex items-center gap-2">
            <span className="font-mono text-[13px] text-muted truncate max-w-[220px]">{p.address || '—'}</span>
            <Badge tone={sc.tone} size="xs" title={sc.hint}>{sc.label}</Badge>
          </span>
        ),
        process: <span className="font-semibold text-fg truncate" title={p.process || ''}>{p.process || '—'}</span>,
        pid: <span className="font-mono text-subtle">{p.pid || '—'}</span>,
        action: p.pid ? (
          <button onClick={() => setKill({ pid: p.pid, process: p.process })}
            className="h-7 px-3 rounded-control bg-danger-soft text-danger-fg text-[12px] font-bold hover:opacity-80">
            End process
          </button>
        ) : null,
      },
    };
  });

  return (
    <Section title="Listening Ports" icon="plug" count={ports.length} color={C.blue}
      action={
        <div className="flex items-center gap-2">
          {exposed > 0 && <Badge tone="warning" size="xs" className="hidden sm:inline-flex">{exposed} network-exposed</Badge>}
          <Input icon="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search port, service, process, PID…" size="sm" wrapperClassName="w-64" />
        </div>
      }>
      {ports.length === 0 ? (
        <p className="text-[15px] text-subtle py-2">No listening ports detected.</p>
      ) : (
        <div className="max-h-[62vh] overflow-y-auto">
          <Table columns={columns} rows={rows} empty={<EmptyState icon="plug" title={`No ports match "${q}"`} />} />
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
function ProcessesPanel({ processes = [], id, onBack, backLabel }) {
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [end, setEnd] = useState(null);   // {pid, command} pending termination
  const sorted = [...processes].sort((a, b) => pctNum(b.cpu) - pctNum(a.cpu));
  const hasUser = sorted.some((p) => String(p.user || '').trim());   // Linux reports it; Windows doesn't
  const t = q.trim().toLowerCase();
  const shown = !t ? sorted : sorted.filter((p) =>
    String(p.pid).includes(t) || (p.user || '').toLowerCase().includes(t) || (p.command || '').toLowerCase().includes(t));

  const columns = [
    { key: 'pid', label: 'PID', width: 80, align: 'right' },
    ...(hasUser ? [{ key: 'user', label: 'User', width: 110 }] : []),
    { key: 'cpu', label: 'CPU %', width: 90, align: 'right' },
    { key: 'mem', label: 'Memory %', width: 100, align: 'right' },
    { key: 'command', label: 'Command' },
    { key: 'action', label: 'Action', width: 130 },
  ];
  const rows = shown.map((p, i) => {
    const cpu = pctNum(p.cpu), mem = pctNum(p.mem);
    return {
      key: `${p.pid}-${i}`,
      cells: {
        pid: <span className="font-mono text-muted whitespace-nowrap">{p.pid}</span>,
        ...(hasUser ? { user: <span className="text-fg whitespace-nowrap">{p.user}</span> } : {}),
        cpu: <span className="font-bold whitespace-nowrap" style={{ color: pctColor(cpu) }}>{cpu}%</span>,
        mem: <span className="font-bold whitespace-nowrap" style={{ color: pctColor(mem) }}>{mem}%</span>,
        command: <span className="font-mono text-[13px] text-fg truncate" title={p.command}>{p.command}</span>,
        action: p.pid ? (
          <button onClick={() => setEnd({ pid: p.pid, command: p.command })}
            className="h-7 px-3 rounded-control bg-danger-soft text-danger-fg text-[12px] font-bold hover:opacity-80">
            End process
          </button>
        ) : null,
      },
    };
  });

  return (
    <Section title="Top Processes" icon="box" count={processes.length} color={C.violet} onBack={onBack} backLabel={backLabel}
      action={<Input icon="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search PID, user, command…" size="sm" wrapperClassName="w-64" />}>
      {processes.length === 0 ? (
        <p className="text-[15px] text-subtle py-2">No process data.</p>
      ) : (
        <div className="max-h-[62vh] overflow-y-auto">
          <Table columns={columns} rows={rows} empty={<EmptyState icon="box" title={`No processes match "${q}"`} />} />
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

/**
 * One live trend chart in the Performance row — same `trend` family/⋮ picker
 * (area/line/column/step/sparkline) every agent telemetry chart offers, fed by
 * this host's own ClickHouse history instead of a single point-in-time reading.
 */
function TrendTile({ cardId, title, data, hasData, subtitle, loading, color, emptyHint }) {
  return (
    <ChartCard
      cardId={cardId} family="trend" defaultKind="area" items={data}
      chartProps={{
        color, unit: '%', domain: [0, 100], thresholds: true,
        emptyLabel: 'Waiting for samples', emptyHint,
      }}
      title={title} icon="activity"
      subtitle={hasData ? subtitle : undefined}
      loading={loading && hasData}
      tableColumns={hasData ? [{ key: 'time', label: 'Time' }, { key: 'value', label: title, align: 'right' }] : undefined}
      tableRows={hasData ? data.slice(-40).reverse().map((p, i) => ({
        key: `${p.label}-${i}`,
        cells: { time: p.label, value: `${Math.round(p.value * 10) / 10}%` },
      })) : undefined}
    />
  );
}

// A compact label/value line — the Network tile's gateway/DNS detail, read
// from the same collector data the full Network tab already shows.
function NetDetailRow({ label, value }) {
  return (
    <div className="flex items-center justify-between gap-2 py-1.5 text-[11px]">
      <span className="font-bold text-subtle uppercase tracking-wide">{label}</span>
      <span className="truncate font-mono text-fg" title={value || undefined}>{value || '—'}</span>
    </div>
  );
}

// White dashboard tile with a light title bar.
function DashTile({ title, sub, children, className = '', onClick }) {
  return (
    <div onClick={onClick}
      className={cn('card flex flex-col', onClick && 'cursor-pointer hover:border-strong hover:bg-raised transition-colors', className)}>
      <div className="px-4 pt-3.5 pb-2">
        <p className="text-[12px] font-bold text-muted leading-tight uppercase tracking-wide">{title}</p>
        {sub && <p className="text-[11px] text-subtle mt-0.5">{sub}</p>}
      </div>
      <div className="px-4 pb-4 flex-1 min-h-0">{children}</div>
    </div>
  );
}

// Horizontal ranked bar list (top processes, filesystem usage, …).
function RankBars({ items, unit = '%', empty = 'No data', onItem }) {
  if (!items.length) return <p className="text-[13px] text-subtle py-6 text-center">{empty}</p>;
  const top = Math.max(...items.map((i) => i.value), 1);
  return (
    <div className="space-y-2.5 pt-1">
      {items.map((it, idx) => {
        const w = unit === '%' ? Math.max(3, Math.min(100, it.value)) : Math.max(3, (it.value / top) * 100);
        const c = it.color || pctColor(it.value);
        return (
          <button key={`${it.name}${idx}`} onClick={onItem ? () => onItem(it) : undefined}
            className={cn('w-full text-left group', !onItem && 'cursor-default')}>
            <div className="flex items-center justify-between mb-1">
              <span className="text-[12px] font-semibold text-muted truncate max-w-[62%] group-hover:text-accent-text">
                {it.name}{it.sub && <span className="text-subtle font-normal"> · {it.sub}</span>}
              </span>
              <span className="text-[12px] font-black" style={{ color: c }}>{it.right || `${it.value}${unit}`}</span>
            </div>
            <div className="h-2 bg-sunken rounded-full overflow-hidden">
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
    <div className="card px-3 py-2 text-[12px]">
      <p className="font-bold text-fg mb-0.5">{p.name}</p>
      <p className="text-muted">CPU <b className="text-fg">{p.x}%</b> · Mem <b className="text-fg">{p.y}%</b></p>
    </div>
  );
}

// Per-process CPU vs Memory scatter.
function ProcScatter({ points }) {
  return (
    <ResponsiveContainer width="100%" height={230}>
      <ScatterChart margin={{ top: 10, right: 12, bottom: 22, left: -8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" />
        <XAxis type="number" dataKey="x" domain={[0, 100]} tick={{ fontSize: 10, fill: 'var(--chart-axis)' }}
          tickLine={false} axisLine={{ stroke: 'var(--border)' }}
          label={{ value: 'CPU %', position: 'insideBottom', offset: -10, fontSize: 11, fill: 'var(--chart-axis)' }} />
        <YAxis type="number" dataKey="y" domain={[0, 100]} width={34} tick={{ fontSize: 10, fill: 'var(--chart-axis)' }}
          tickLine={false} axisLine={{ stroke: 'var(--border)' }}
          label={{ value: 'Mem %', angle: -90, position: 'insideLeft', offset: 18, fontSize: 11, fill: 'var(--chart-axis)' }} />
        <ZAxis type="number" dataKey="z" range={[60, 180]} />
        <Tooltip content={<ProcTooltip />} cursor={{ strokeDasharray: '3 3' }} />
        <Scatter data={points}>
          {points.map((p, i) => <Cell key={i} fill={p.color} fillOpacity={0.75} />)}
        </Scatter>
      </ScatterChart>
    </ResponsiveContainer>
  );
}

export default function InfraHostDetail() {
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

  // ── live CPU/Memory trend for the Performance row ──────────────────────────
  // Agent-collected hosts get the real thing: the same range/granularity picker
  // and persisted ClickHouse history the Agent monitoring page uses (keyed by
  // `host.server_name`, which IS the agent_name these metrics are stored under).
  //
  // SSH-polled hosts have no such pipeline — nothing pushes them into ClickHouse
  // — but the whole Infra module should still show a live trend, not a dead
  // single reading. So for those, this page builds its OWN trend client-side:
  // every 30s refetch of getHostInfraDetail already carries a fresh cpu/memory
  // snapshot, so each one is appended to a rolling in-browser buffer and charted
  // exactly like the ClickHouse-backed series. It's session-local (resets on
  // reload, caps at 120 points ≈ 1 hour) rather than persisted history, which is
  // why the range/granularity picker only appears for agent hosts — there's no
  // server-side range to pick from client-buffered samples.
  const [showSystemInfo, setShowSystemInfo] = useState(false);
  const [perfRange, setPerfRange] = useState('60');
  const [perfCustomMinutes, setPerfCustomMinutes] = useState('1440');
  const [perfGranularity, setPerfGranularity] = useState('60');
  const perfMinutes = perfRange === 'custom' ? (Number(perfCustomMinutes) || 1440) : Number(perfRange);
  const perfBucketSeconds = Number(perfGranularity);
  const isAgentHost = host.collector === 'agent';

  const perfHistoryQ = useQuery({
    queryKey: ['agents', 'metrics-history', host.server_name, perfMinutes, perfBucketSeconds],
    // kind/tech pin this to the host's OWN table — see getMetricsHistory's own
    // note on why omitting them silently dilutes the result with this same
    // agent's database-engine rows (their host_cpu/host_memory are always 0).
    queryFn: () => getMetricsHistory(host.server_name, { minutes: perfMinutes, bucketSeconds: perfBucketSeconds, kind: 'infra', tech: 'host' }),
    refetchInterval: Math.max(15_000, Math.min(60_000, perfBucketSeconds * 250)),
    enabled: Boolean(host.server_name) && isAgentHost,
    retry: false,
  });

  const agentSeries = useMemo(() => {
    const rows = perfHistoryQ.data?.samples || [];
    return rows.slice().reverse().map((s) => {
      // ClickHouse's history endpoint always pins its output to UTC (see
      // metrics_history_service.py) regardless of that server's own display
      // timezone — parse with an explicit 'Z', never as a naive local string.
      const at = new Date(`${String(s.ts).replace(' ', 'T')}Z`);
      const label = Number.isNaN(at.getTime())
        ? String(s.ts)
        : perfMinutes > 1440
          ? at.toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' })
          : at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return { label, cpu: Number(s.host_cpu || 0), mem: Number(s.host_memory || 0), disk: Number(s.host_disk || 0) };
    });
  }, [perfHistoryQ.data, perfMinutes]);

  const [sshBuffer, setSshBuffer] = useState([]);
  useEffect(() => {
    if (isAgentHost || !data || failed) return;
    const cpuVal = pctNum(data.cpu_pct);
    const memVal = pctNum((data.memory || {}).used_pct);
    // Same "busiest mount" reduction the Overview tab uses below for its own
    // static Disk reading — kept in sync so the trend and the point-in-time
    // number never disagree about which filesystem "the" disk % refers to.
    const diskVal = pctNum(Math.max(0, ...(data.filesystems || []).map((f) => f.use_pct ?? 0), 0));
    setSshBuffer((buf) => [...buf, { ts: Date.now(), cpu: cpuVal, mem: memVal, disk: diskVal }].slice(-120));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, isAgentHost, failed]);
  const sshSeries = useMemo(() => sshBuffer.map((s) => ({
    label: new Date(s.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    cpu: s.cpu, mem: s.mem, disk: s.disk,
  })), [sshBuffer]);

  const liveSeries = isAgentHost ? agentSeries : sshSeries;
  const cpuSeries = liveSeries.map((s) => ({ label: s.label, value: s.cpu }));
  const memSeries = liveSeries.map((s) => ({ label: s.label, value: s.mem }));
  const diskSeries = liveSeries.map((s) => ({ label: s.label, value: s.disk }));
  const hasPerfSeries = liveSeries.length > 0;
  const perfRangeLabel = PERF_RANGE_OPTIONS.find((o) => o.id === perfRange)?.label || '';
  const perfGranularityLabel = PERF_GRANULARITY_OPTIONS.find((o) => o.id === perfGranularity)?.label || '';
  const perfSubtitle = isAgentHost
    ? `${perfRangeLabel} · ${perfGranularityLabel}`
    : `Live session trend · updates every ${Math.round((data?.poll_interval_s || 30))}s`;
  const perfEmptyHint = isAgentHost
    ? 'This agent has not reported host telemetry yet — check back shortly.'
    : 'Building the trend from live polls — keep this page open, the chart fills in as new readings arrive.';

  const isWin = (host.os_type || '').toLowerCase().startsWith('win');
  // IP Configuration is available for all hosts; on Windows it's read-only (from the
  // agent snapshot) since editing/firewall need the Linux job channel.
  const tabs = TABS;
  const tabDefs = tabs.map((t) => ({
    id: t, label: t, icon: TAB_ICONS[t],
    count: t === 'Ports' ? data?.ports?.length : t === 'Processes' ? data?.processes?.length : t === 'Storage' ? data?.filesystems?.length : undefined,
  }));
  const headerStatus = hostStatus({ status: failed ? 'offline' : 'online' });

  return (
    <DashboardScopeProvider tech="infra">
      <PageHeader
        backTo="/infra"
        title={host.server_name || `Host #${id}`}
        description={[host.hostname || host.ip_address, host.os_type && osLabel(host.os_type), host.collector && `via ${host.collector}`].filter(Boolean).join(' · ')}
        leading={
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-sunken text-muted">
            <Icon name="desktop" size={20} />
          </div>
        }
        tabs={<Tabs value={tab} onChange={setTab} tabs={tabDefs} />}
        actions={
          <>
            <Badge tone={headerStatus.tone} size="sm">
              <Icon name={headerStatus.icon} size={10} strokeWidth={3} />
              {headerStatus.label}
            </Badge>
            <Button variant="secondary" size="sm" icon="folder" onClick={() => navigate(`/infra/${id}/files`)}>File Explorer</Button>
            <Button variant="secondary" size="sm" icon="shield-check" onClick={() => setTab('IP Configuration')}>Firewall</Button>
            {host.collector === 'agent' && isWin && (
              <Button variant="secondary" size="sm" icon="download" title="Download the latest agent and upgrade in place" onClick={() => setShowUpdate(true)}>Update Agent</Button>
            )}
            <Button variant="secondary" size="sm" icon="power" onClick={() => setShowRestart(true)}>Restart</Button>
            <button
              type="button"
              onClick={() => qc.invalidateQueries(['hostInfraDetail', id])}
              title="Refresh now"
              className="flex h-control shrink-0 items-center gap-1.5 rounded-control border border-border px-2.5 text-[12px] font-semibold text-muted transition-colors hover:bg-sunken hover:text-fg"
            >
              <Icon name="refresh" size={13} className={isFetching ? 'animate-spin' : undefined} />
              Refresh
            </button>
          </>
        }
      />

      {isLoading ? (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <Icon name="spinner" size={28} className="animate-spin text-accent-text mb-3" />
          <p className="text-muted font-semibold text-[15px]">Gathering host details…</p>
        </div>
      ) : failed ? (
        <div className="card px-card py-8 text-center">
          <Icon name="alert" size={32} className="mx-auto text-danger mb-3" />
          <p className="font-bold text-danger-fg text-[16px]">Could not reach this host</p>
          <p className="text-[14px] text-muted mt-1 font-mono break-all">{data?.message}</p>
        </div>
      ) : (
        <div className="flex flex-col gap-gutter-lg">
          {/* ── OVERVIEW (tiled dashboard) ── */}
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
            const memPct = pctNum(mem.used_pct);
            return (
              <>
                {/* ── PERFORMANCE ──
                    CPU/Memory get the same half-width prominence as the Agent
                    monitoring page's own trend charts — a quarter-width slot
                    alongside Disk/Load made them cramped. Those two move to
                    their own smaller row below. */}
                <SectionBand
                  icon="activity" title="Performance"
                  right={
                    isAgentHost ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <Select value={perfRange} onChange={setPerfRange} options={PERF_RANGE_OPTIONS} size="sm" width="auto" aria-label="Time range" />
                        {perfRange === 'custom' && (
                          <Input
                            type="number" min={1} value={perfCustomMinutes}
                            onChange={(e) => setPerfCustomMinutes(e.target.value)}
                            wrapperClassName="w-20" size="sm" aria-label="Custom minutes"
                          />
                        )}
                        <Select value={perfGranularity} onChange={setPerfGranularity} options={PERF_GRANULARITY_OPTIONS} size="sm" width="auto" aria-label="Granularity" />
                      </div>
                    ) : (
                      <span className="text-[11px] text-subtle">SSH-polled — trend builds from live snapshots, no range to pick</span>
                    )
                  }
                />
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-gutter">
                  <TrendTile
                    cardId="infra-host-cpu-trend" title="CPU Utilization"
                    data={cpuSeries} hasData={hasPerfSeries} loading={isAgentHost && perfHistoryQ.isFetching}
                    color="var(--chart-2)" emptyHint={perfEmptyHint}
                    subtitle={perfSubtitle}
                  />
                  <TrendTile
                    cardId="infra-host-memory-trend" title="Memory Utilization"
                    data={memSeries} hasData={hasPerfSeries} loading={isAgentHost && perfHistoryQ.isFetching}
                    color="var(--chart-5)" emptyHint={perfEmptyHint}
                    subtitle={perfSubtitle}
                  />
                </div>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-gutter">
                  <TrendTile
                    cardId="infra-host-disk-trend" title="Disk Utilization"
                    data={diskSeries} hasData={hasPerfSeries} loading={isAgentHost && perfHistoryQ.isFetching}
                    color="var(--chart-1)" emptyHint={perfEmptyHint}
                    subtitle={rootFs ? `${perfSubtitle} · busiest: ${rootFs.mount}` : perfSubtitle}
                  />
                  <DashTile title="Process CPU vs Memory" sub="each dot is a running process">
                    {scatter.length ? <ProcScatter points={scatter} /> : <p className="text-[13px] text-subtle py-10 text-center">No process data</p>}
                  </DashTile>
                </div>

                {/* ── COMPUTE — PROCESSES ── */}
                <SectionBand icon="box" title="Compute — Processes" />
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-gutter">
                  <DashTile title="Top processes by CPU">
                    <RankBars items={topCpu} empty="No process data" onItem={() => setTab('Processes')} />
                  </DashTile>
                  <DashTile title="Top processes by Memory">
                    <RankBars items={topMem} empty="No process data" onItem={() => setTab('Processes')} />
                  </DashTile>
                </div>

                {/* ── STORAGE & NETWORK ── */}
                <SectionBand icon="desktop" title="Storage & Network" />
                <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-gutter">
                  <DashTile title="Filesystem usage" sub={isWin ? 'disk usage per mount' : 'click a mount to browse files'}>
                    <RankBars items={fsRank} empty="No filesystem data"
                      onItem={isWin ? undefined : (f) => navigate(`/infra/${id}/files?path=${encodeURIComponent(f.mount)}`)} />
                  </DashTile>
                  <DashTile title="Memory breakdown">
                    <div className="flex h-full flex-col justify-center gap-3">
                      <Meter label="Used" value={memPct} hint={mem.total_mb ? `${fmtMB(mem.used_mb)} of ${fmtMB(mem.total_mb)}` : 'physical memory'} />
                      <div className="grid grid-cols-3 gap-2">
                        {[['Total', mem.total_mb], ['Used', mem.used_mb], ['Free', mem.available_mb ?? mem.free_mb]].map(([k, v]) => (
                          <div key={k} className="bg-sunken rounded-control p-2.5 text-center">
                            <p className="text-[10px] font-bold text-subtle uppercase">{k}</p>
                            <p className="text-[14px] font-black text-fg mt-0.5">{v != null ? fmtMB(v) : '—'}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  </DashTile>
                  <DashTile title="Network">
                    <div className="flex h-full flex-col justify-center gap-3">
                      <div className="grid grid-cols-3 gap-2 text-center">
                        {[['Interfaces', `${ifUp}/${ifaces.length}`, 'up'],
                          ['Connections', data.connections?.count ?? 0, 'active'],
                          ['Devices', data.neighbors?.length ?? 0, 'seen']].map(([k, v, s]) => (
                          <button key={k} onClick={() => setTab('Network')} className="hover:opacity-70">
                            <p className="text-[20px] font-black text-fg leading-none">{v}</p>
                            <p className="text-[10px] font-bold text-muted mt-1">{k}</p>
                            <p className="text-[9px] text-subtle">{s}</p>
                          </button>
                        ))}
                      </div>
                      <div className="divide-y divide-border border-t border-border pt-1.5">
                        <NetDetailRow label="Gateway" value={data.network?.gateway} />
                        <NetDetailRow label="DNS" value={(data.network?.dns || []).join(', ')} />
                      </div>
                    </div>
                  </DashTile>
                </div>

                {/* ── SYSTEM INFORMATION ──
                    Collapsed by default — a wall of OS/hardware facts nobody
                    reads on every visit doesn't need to be open by default;
                    "View details" is one click away when someone actually
                    wants it. */}
                <SectionBand icon="info" title="System Information" />
                <div className="card">
                  <button
                    type="button"
                    onClick={() => setShowSystemInfo((v) => !v)}
                    className="flex w-full items-center gap-3 px-4 py-3.5 text-left"
                  >
                    <Icon name="desktop" size={16} className="shrink-0 text-subtle" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate-safe text-[13px] font-bold text-fg">
                        {data.system?.os || host.os_type || 'Host details'}
                      </span>
                      <span className="mt-0.5 block truncate-safe text-[11px] text-subtle">
                        {[data.system?.hostname, host.ip_address, data.system?.hardware_vendor && data.system?.hardware_model
                          ? `${data.system.hardware_vendor} ${data.system.hardware_model}` : null]
                          .filter(Boolean).join(' · ')}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5 text-[12px] font-semibold text-accent-text">
                      {showSystemInfo ? 'Hide details' : 'View details'}
                      <Icon name="chevron-right" size={13} className={cn('transition-transform', showSystemInfo && 'rotate-90')} />
                    </span>
                  </button>

                  {showSystemInfo && (
                    <div className="divide-y divide-border border-t border-border px-4">
                      {[
                        ['Operating System', data.system?.os],
                        ['Kernel', data.system?.kernel],
                        ['Architecture', data.system?.architecture],
                        ['Hostname', data.system?.hostname],
                        ['IP Address', host.ip_address],
                        ['Environment', host.environment],
                        ['Collector', host.collector === 'agent' ? 'ActMon Agent (push)' : 'SSH (poll)'],
                        // Hardware / virtualization (from hostnamectl on Linux, CIM on Windows)
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
                          <span className="w-48 flex-shrink-0 text-[13px] font-bold text-muted uppercase tracking-wide">{k}</span>
                          <span className={cn('text-[15px] font-semibold text-fg break-all', ['Machine ID', 'Boot ID'].includes(k) && 'font-mono text-[13px]')}>{v}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            );
          })()}

          {/* ── PORTS ── */}
          {tab === 'Ports' && <PortsPanel ports={data.ports || []} id={id} />}

          {/* ── PROCESSES ── */}
          {tab === 'Processes' && <ProcessesPanel processes={data.processes || []} id={id} />}

          {/* ── STORAGE: filesystems → click → file explorer ── */}
          {tab === 'Storage' && (
            <Section title="Filesystems" icon="desktop" count={data.filesystems?.length} color={C.green}
              action={<span className="text-[12px] text-subtle font-semibold">Click a mount to browse its folders & files</span>}>
              <div className="overflow-x-auto">
                <table className="w-full text-[14px]">
                  <thead><tr className="bg-sunken border-b border-border">
                    {['Mount', 'Filesystem', 'Size', 'Used', 'Avail', 'Use %', ''].map((h) => (
                      <th key={h} className="px-3.5 py-2.5 text-left text-[12px] font-bold text-subtle uppercase whitespace-nowrap">{h}</th>))}
                  </tr></thead>
                  <tbody>
                    {(data.filesystems || []).map((f, i) => (
                      <tr key={i} onClick={() => navigate(`/infra/${id}/files?path=${encodeURIComponent(f.mount)}`)}
                        className={cn('border-b border-border cursor-pointer hover:bg-sunken', i % 2 === 1 && 'bg-sunken/40')}>
                        <td className="px-3.5 py-2.5"><span className="flex items-center gap-2 font-bold text-fg"><Icon name="folder" size={15} className="text-warning-fg" />{f.mount}</span></td>
                        <td className="px-3.5 py-2.5 font-mono text-[13px] text-muted">{f.filesystem}</td>
                        <td className="px-3.5 py-2.5 text-fg">{f.size}</td>
                        <td className="px-3.5 py-2.5 text-fg">{f.used}</td>
                        <td className="px-3.5 py-2.5 text-fg">{f.avail}</td>
                        <td className="px-3.5 py-2.5">
                          <div className="flex items-center gap-2 min-w-[130px]">
                            <div className="flex-1 h-2 bg-sunken rounded-full overflow-hidden"><div className="h-full rounded-full" style={{ width: `${f.use_pct}%`, background: pctColor(f.use_pct) }} /></div>
                            <span className="font-bold text-[13px]" style={{ color: pctColor(f.use_pct) }}>{f.use_pct}%</span>
                          </div>
                        </td>
                        <td className="px-3.5 py-2.5 text-accent-text font-bold text-[13px] whitespace-nowrap">Browse →</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
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
        </div>
      )}

      {showUpdate && (
        <PasswordPrompt title="Update ActMon Agent" confirmLabel="Update Agent"
          onConfirm={(pw) => updateAgent(id, pw)} onClose={() => setShowUpdate(false)} />
      )}
      {showRestart && (
        <RestartModal id={id} hostName={host.server_name || `Host #${id}`} onClose={() => setShowRestart(false)} />
      )}
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="card shadow-2xl w-full max-w-lg overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <div className="flex items-center gap-2.5"><Icon name="power" size={18} className="text-warning-fg" /><h3 className="font-bold text-[16px] text-fg">{title || `Restart — ${hostName}`}</h3></div>
          <IconButton icon="close" label="Close" size="sm" onClick={onClose} />
        </div>
        <div className="p-5">
          {/* mode toggle */}
          <div className="flex rounded-control border border-border overflow-hidden mb-4 w-fit">
            <button onClick={() => setMode('service')} className={cn('px-4 h-9 text-[13px] font-bold', mode === 'service' ? 'bg-accent text-accent-fg' : 'bg-surface text-muted')}>Restart a service</button>
            <button onClick={() => setMode('reboot')} className={cn('px-4 h-9 text-[13px] font-bold border-l border-border', mode === 'reboot' ? 'bg-danger text-white' : 'bg-surface text-muted')}>Reboot host</button>
          </div>

          {mode === 'service' ? (
            <div className="mb-3">
              <label className="block text-[13px] font-bold text-muted mb-1.5">Service</label>
              <input list="svc-list" value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="e.g. mariadb.service"
                className="w-full h-10 px-3 rounded-control border border-border bg-surface text-fg text-[14px] font-mono outline-none focus:border-accent" />
              <datalist id="svc-list">{services.map((s) => <option key={s.unit} value={s.unit}>{s.description}</option>)}</datalist>
              {services.length > 0 && <p className="text-[12px] text-subtle mt-1">{services.length} running services detected — pick one or type a name.</p>}
            </div>
          ) : (
            <div className="mb-3 rounded-control bg-danger-soft p-3 flex items-start gap-2.5">
              <Icon name="alert" size={17} className="text-danger-fg flex-shrink-0 mt-0.5" />
              <p className="text-[14px] text-danger-fg">This will <span className="font-black">reboot the entire host</span>. It will drop offline and return in a few minutes. All services on it restart.</p>
            </div>
          )}

          <label className="block text-[13px] font-bold text-muted mb-1.5">Confirm your password</label>
          <div className="relative">
            <input type={showPw ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()} placeholder="Your ActMon login password"
              className="w-full h-10 px-3 pr-9 rounded-control border border-border bg-surface text-fg text-[14px] outline-none focus:border-accent" />
            <button type="button" onClick={() => setShowPw((v) => !v)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-subtle hover:text-fg">
              <Icon name={showPw ? 'eye-off' : 'eye'} size={15} />
            </button>
          </div>

          {msg && <MessageLine ok={msg.ok} text={msg.text} />}

          <div className="flex justify-end gap-2 mt-5">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button variant={mode === 'reboot' ? 'danger' : 'primary'} icon="power" loading={busy} disabled={busy} onClick={submit}>
              {mode === 'reboot' ? 'Reboot Host' : 'Restart Service'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
