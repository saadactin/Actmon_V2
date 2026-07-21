import React, { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  listRules, createRule, updateRule, toggleRule, deleteRule, listActiveAlerts,
  analyzeAlert, drillContext, listDiagnostics, runDiagnostic, agentStep,
} from '../../api/alerts';
import { listOsServers } from '../../api/servers';
import { listAccounts } from '../../api/cloud';
import { useAgentsList } from '../../hooks/useAgents';
import { usePermissions } from '../../hooks/usePermissions';
import { useToast } from '../../components/ui/ToastProvider';
import {
  Bell, BellRing, Plus, Trash2, Pencil, X, Search, CheckCheck, Check,
  ShieldAlert, AlertTriangle, Info, Cpu, HardDrive, Network, Activity,
  Gauge, ChevronRight, ChevronDown, SlidersHorizontal, Server, Archive, AlertOctagon,
  Database, GitBranch, Cloud, RefreshCw, Layers, Clock, Sparkles, LayoutGrid, List, Loader2, Wrench,
  Play, Terminal, ChevronLeft,
} from 'lucide-react';

/* ─── SECTION-WISE CATALOG (drives the whole builder) ────────────────────────
   Pick a section → only that section's metrics/rules are shown.
   kind: 'numeric' → operator + threshold ; 'event' → fires when it happens.     */
const SECTIONS = [
  {
    id: 'infrastructure', label: 'Infrastructure', color: '#0d9488', icon: <Server size={15} />,
    desc: 'Hosts, CPU, memory, disk & availability',
    groups: [
      { group: 'Availability', metrics: [
        { id: 'host_down', label: 'Host down / unreachable', kind: 'event', desc: 'the host stops responding' },
      ]},
      { group: 'Host Resources', metrics: [
        { id: 'cpu',     label: 'CPU usage',     unit: '%', kind: 'numeric', def: 80 },
        { id: 'memory',  label: 'Memory usage',  unit: '%', kind: 'numeric', def: 85 },
        { id: 'disk',    label: 'Disk usage',    unit: '%', kind: 'numeric', def: 90 },
        { id: 'swap',    label: 'Swap usage',    unit: '%', kind: 'numeric', def: 50 },
        { id: 'load',    label: 'Load average',  unit: '',  kind: 'numeric', def: 8 },
        { id: 'disk_io', label: 'Disk I/O wait', unit: '%', kind: 'numeric', def: 40 },
      ]},
    ],
  },
  {
    id: 'database', label: 'Database', color: '#2563eb', icon: <Database size={15} />,
    desc: 'Service health, connections, queries & storage',
    groups: [
      { group: 'Availability', metrics: [
        { id: 'service_down',   label: 'Database service stopped',        kind: 'event', desc: 'the database service is not running' },
        { id: 'db_unreachable', label: 'Database not responding',         kind: 'event', desc: 'the database is not accepting connections' },
        { id: 'db_crash',       label: 'Database crash / unexpected restart', kind: 'event', desc: 'the database crashes or restarts unexpectedly' },
      ]},
      { group: 'Connections', metrics: [
        { id: 'connections',         label: 'Active connections',  unit: '',     kind: 'numeric', def: 500 },
        { id: 'connections_pct',     label: 'Connection usage',    unit: '%',    kind: 'numeric', def: 90 },
        { id: 'aborted_connections', label: 'Aborted connections', unit: '/min', kind: 'numeric', def: 20 },
      ]},
      { group: 'Performance', metrics: [
        { id: 'slow_queries',      label: 'Slow queries',             unit: '/min', kind: 'numeric', def: 50 },
        { id: 'query_latency',     label: 'Avg query latency',        unit: 'ms',   kind: 'numeric', def: 500 },
        { id: 'cache_hit',         label: 'Cache / buffer hit ratio', unit: '%',    kind: 'numeric', def: 90, dirLow: true },
        { id: 'blocking_sessions', label: 'Blocking / locked sessions', unit: '',   kind: 'numeric', def: 5 },
        { id: 'long_query',        label: 'Long-running query',       unit: 's',    kind: 'numeric', def: 300 },
        { id: 'deadlocks',         label: 'Deadlocks detected',       kind: 'event', desc: 'a deadlock is detected' },
      ]},
      { group: 'Storage', metrics: [
        { id: 'db_size',     label: 'Database size',         unit: 'GB', kind: 'numeric', def: 500 },
        { id: 'tablespace',  label: 'Tablespace usage',      unit: '%',  kind: 'numeric', def: 90 },
        { id: 'binlog_disk', label: 'Binlog / WAL disk use', unit: '%',  kind: 'numeric', def: 80 },
      ]},
      { group: 'Errors', metrics: [
        { id: 'error_spike',    label: 'Error-log spike',       unit: '/min', kind: 'numeric', def: 10 },
        { id: 'critical_error', label: 'Critical error in log', kind: 'event', desc: 'a critical error appears in the log' },
      ]},
    ],
  },
  {
    id: 'replication', label: 'Replication & HA', color: '#7c3aed', icon: <GitBranch size={15} />,
    desc: 'Lag, broken replication & cluster health',
    groups: [
      { group: 'Replication & HA', metrics: [
        { id: 'replication_lag',    label: 'Replication lag',              unit: 's', kind: 'numeric', def: 30 },
        { id: 'replication_broken', label: 'Replication stopped / broken', kind: 'event', desc: 'replication stops or breaks' },
        { id: 'replica_down',       label: 'Replica not connected',        kind: 'event', desc: 'a replica disconnects' },
        { id: 'cluster_node_down',  label: 'Cluster node down',            kind: 'event', desc: 'a cluster node goes down' },
      ]},
    ],
  },
  {
    id: 'backup', label: 'Backup', color: '#d97706', icon: <Archive size={15} />,
    desc: 'Backup jobs & point-in-time recovery',
    groups: [
      { group: 'Backup', metrics: [
        { id: 'backup_failed',  label: 'Backup failed',  kind: 'event', desc: 'a backup job fails' },
        { id: 'backup_overdue', label: 'Backup overdue', unit: 'h', kind: 'numeric', def: 26 },
        { id: 'pitr_not_ready', label: 'PITR not ready', kind: 'event', desc: 'point-in-time recovery is not ready' },
      ]},
    ],
  },
  {
    id: 'cloud', label: 'Cloud', color: '#0ea5e9', icon: <Cloud size={15} />,
    desc: 'AWS / Azure / OCI resources & cost',
    groups: [
      { group: 'Cloud Availability', metrics: [
        { id: 'cloud_instance_stopped',   label: 'Instance stopped / terminated', kind: 'event', desc: 'a cloud instance stops or is terminated' },
        { id: 'cloud_resource_unhealthy', label: 'Resource health check failing', kind: 'event', desc: 'a cloud resource health check fails' },
      ]},
      { group: 'Cloud Resources', metrics: [
        { id: 'cloud_cpu',     label: 'Instance CPU',        unit: '%', kind: 'numeric', def: 80 },
        { id: 'cloud_storage', label: 'Cloud storage usage', unit: '%', kind: 'numeric', def: 85 },
      ]},
      { group: 'Cloud Cost', metrics: [
        { id: 'cloud_cost_budget', label: 'Monthly cost vs budget', unit: '%', kind: 'numeric', def: 90 },
        { id: 'cloud_cost_spike',  label: 'Unusual cost spike',     kind: 'event', desc: 'an unusual cost spike is detected' },
      ]},
    ],
  },
];

const METRICS = SECTIONS.flatMap((s) => s.groups.flatMap((g) => g.metrics.map((m) => ({ ...m, section: s.id, group: g.group }))));
const metricOf = (id) => METRICS.find((m) => m.id === id) || METRICS[0];
const sectionMeta = (id) => SECTIONS.find((s) => s.id === id) || SECTIONS[0];
const sectionOf = (mid) => metricOf(mid).section;
const groupsForSection = (sid) => sectionMeta(sid).groups;
const firstMetricOfSection = (sid) => groupsForSection(sid)[0].metrics[0].id;

const OPERATORS = [{ id: 'gt', sym: '>' }, { id: 'gte', sym: '≥' }, { id: 'lt', sym: '<' }, { id: 'lte', sym: '≤' }, { id: 'eq', sym: '=' }];
const opSym = (id) => (OPERATORS.find((o) => o.id === id) || OPERATORS[0]).sym;
const TECHS = ['mysql', 'postgresql', 'oracle', 'mssql', 'mongodb', 'clickhouse'];
const SCOPES_DEFAULT = [
  { id: 'all', label: 'All servers' }, { id: 'technology', label: 'By technology' },
  { id: 'server', label: 'Specific server' }, { id: 'agent', label: 'Specific agent' },
];
const SCOPES_CLOUD = [{ id: 'all', label: 'All accounts' }, { id: 'account', label: 'Specific account' }];
const scopesForSection = (sid) => (sid === 'cloud' ? SCOPES_CLOUD : SCOPES_DEFAULT);

const SEV = {
  critical: { label: 'Critical', chip: 'bg-red-100 text-red-700 border-red-200',    dot: '#ef4444', icon: <ShieldAlert size={13} /> },
  warning:  { label: 'Warning',  chip: 'bg-amber-100 text-amber-700 border-amber-200', dot: '#f59e0b', icon: <AlertTriangle size={13} /> },
  info:     { label: 'Info',     chip: 'bg-blue-100 text-blue-700 border-blue-200',   dot: '#3b82f6', icon: <Info size={13} /> },
};
const sevOf = (s) => SEV[(s || 'info').toLowerCase()] || SEV.info;

const ago = (ts) => {
  if (!ts) return '—';
  const d = Math.floor((Date.now() - new Date(ts)) / 1000);
  if (d < 60) return d + 's ago';
  if (d < 3600) return Math.floor(d / 60) + 'm ago';
  if (d < 86400) return Math.floor(d / 3600) + 'h ago';
  return Math.floor(d / 86400) + 'd ago';
};
const conditionText = (r) => {
  const m = metricOf(r.metric);
  if (m.kind === 'event') return m.label;
  return `${m.label} ${opSym(r.operator)} ${r.threshold}${m.unit || ''}`;
};
const scopeText = (r) => {
  if (r.scope_type === 'all' || !r.scope_value) return sectionOf(r.metric) === 'cloud' ? 'All accounts' : 'All servers';
  const p = { technology: 'Technology', server: 'Server', agent: 'Agent', account: 'Account' }[r.scope_type] || 'Scope';
  return `${p}: ${r.scope_value}`;
};

// ─── small UI ───────────────────────────────────────────────────────────────
const Toggle = ({ checked, onChange, disabled }) => (
  <button type="button" disabled={disabled} onClick={() => onChange(!checked)}
    className={`relative w-11 h-6 rounded-full transition-colors flex-shrink-0 ${checked ? 'bg-emerald-500' : 'bg-slate-300'} ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}>
    <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-5' : ''}`} />
  </button>
);
const Kpi = ({ icon, value, label, color, bg, active, onClick }) => (
  <button onClick={onClick}
    className={`text-left bg-white rounded-2xl border shadow-sm px-4 py-3 flex items-center gap-3 transition-all hover:shadow-md ${active ? 'ring-2 ring-blue-400 border-transparent' : 'border-slate-200'}`}>
    <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${bg}`} style={{ color }}>{icon}</div>
    <div>
      <div className="text-2xl font-black leading-none" style={{ color: value ? color : '#0f172a' }}>{value}</div>
      <div className="text-[11px] font-bold text-slate-500 mt-0.5">{label}</div>
    </div>
  </button>
);
const Labeled = ({ label, children, className = '' }) => (
  <label className={`block ${className}`}>
    <span className="block text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-1">{label}</span>
    {children}
  </label>
);
const inputCls = 'w-full h-9 px-3 rounded-lg border border-slate-200 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-50 bg-white';

// Custom grouped metric dropdown — replaces the ugly native <select> optgroup list.
const MetricPicker = ({ section, value, onChange }) => {
  const [open, setOpen] = useState(false);
  const cur = metricOf(value);
  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} onBlur={() => setTimeout(() => setOpen(false), 150)}
        className={`${inputCls} flex items-center justify-between text-left`}>
        <span className="truncate">{cur.label}</span>
        <ChevronDown size={15} className={`text-slate-400 transition-transform flex-shrink-0 ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute z-20 left-0 right-0 mt-1 rounded-xl border border-slate-200 bg-white shadow-xl max-h-60 overflow-y-auto">
          {groupsForSection(section).map((g) => (
            <div key={g.group}>
              <div className="px-3 py-1.5 text-[10px] font-black uppercase tracking-wide text-slate-400 bg-slate-50 sticky top-0">{g.group}</div>
              {g.metrics.map((mm) => (
                <button key={mm.id} type="button" onMouseDown={(e) => { e.preventDefault(); onChange(mm.id); setOpen(false); }}
                  className={`w-full text-left px-3 py-2 text-sm flex items-center justify-between hover:bg-blue-50 ${mm.id === value ? 'bg-blue-50 text-blue-700 font-bold' : 'text-slate-700'}`}>
                  <span className="truncate">{mm.label}</span>
                  {mm.id === value && <Check size={14} className="flex-shrink-0" />}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ─── Rule editor modal (section-driven) ─────────────────────────────────────
const emptyRule = { name: '', description: '', metric: 'cpu', operator: 'gt', threshold: 80, scope_type: 'all', scope_value: '', severity: 'warning', duration_seconds: 60, cooldown_seconds: 600, enabled: true };

const RuleModal = ({ open, initial, defaultSection, servers, agents, cloudAccounts, onClose, onSave, saving }) => {
  const [f, setF] = useState(emptyRule);
  const [section, setSection] = useState('infrastructure');

  React.useEffect(() => {
    if (!open) return;
    if (initial?.id) {
      const base = { ...emptyRule, ...initial };
      setF(base); setSection(sectionOf(base.metric));
    } else {
      const sec = defaultSection || 'infrastructure';
      const mid = firstMetricOfSection(sec); const mm = metricOf(mid);
      setSection(sec);
      setF({ ...emptyRule, metric: mid, threshold: mm.kind === 'event' ? 1 : (mm.def ?? 0), operator: mm.kind === 'event' ? 'eq' : (mm.dirLow ? 'lt' : 'gt'), scope_type: 'all', scope_value: '' });
    }
  }, [open, initial, defaultSection]);

  if (!open) return null;
  const m = metricOf(f.metric);
  const sm = sectionMeta(section);
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const onMetric = (id) => {
    const mm = metricOf(id);
    setF((p) => ({ ...p, metric: id, threshold: mm.kind === 'event' ? 1 : (mm.def ?? 0), operator: mm.kind === 'event' ? 'eq' : (mm.dirLow ? 'lt' : 'gt') }));
  };
  const scopeTypes = scopesForSection(section);
  const scopeValues = f.scope_type === 'technology' ? TECHS
    : f.scope_type === 'server' ? servers.map((s) => s.server_name).filter(Boolean)
    : f.scope_type === 'agent' ? agents.map((a) => a.name).filter(Boolean)
    : f.scope_type === 'account' ? cloudAccounts.map((a) => a.account_name || a.name || a.provider || a.cloud_provider).filter(Boolean)
    : [];
  const valid = f.name.trim().length > 0 && (f.scope_type === 'all' || !!f.scope_value);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 bg-gradient-to-r from-slate-900 via-blue-800 to-sky-700 px-5 py-4 flex items-center justify-between z-10">
          <h3 className="text-white font-black text-base flex items-center gap-2">
            <SlidersHorizontal size={17} />{initial?.id ? 'Edit' : 'New'} {sm.label} Rule
          </h3>
          <button onClick={onClose} className="w-8 h-8 rounded-lg bg-white/10 hover:bg-white/20 text-white flex items-center justify-center"><X size={16} /></button>
        </div>

        <div className="p-5 space-y-4">
          <Labeled label="Rule name">
            <input className={inputCls} value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Production CPU critical" autoFocus />
          </Labeled>
          <Labeled label="Description (optional)">
            <input className={inputCls} value={f.description} onChange={(e) => set('description', e.target.value)} placeholder="What this rule watches for" />
          </Labeled>

          {/* condition builder — only this section's metrics */}
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-[11px] font-black text-slate-500 uppercase tracking-wide flex items-center gap-1.5"><Gauge size={13} /> Condition</div>
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-bold border"
                style={{ color: sm.color, borderColor: `${sm.color}55`, background: `${sm.color}12` }}>
                {sm.icon}{sm.label}
              </span>
            </div>
            <Labeled label="Metric">
              <MetricPicker section={section} value={f.metric} onChange={onMetric} />
            </Labeled>
            {m.kind === 'numeric' ? (
              <div className="grid grid-cols-3 gap-3">
                <Labeled label="Operator">
                  <select className={inputCls} value={f.operator} onChange={(e) => set('operator', e.target.value)}>
                    {OPERATORS.filter((o) => o.id !== 'eq').map((o) => <option key={o.id} value={o.id}>{o.sym}</option>)}
                  </select>
                </Labeled>
                <Labeled label={`Threshold ${m.unit ? `(${m.unit})` : ''}`} className="col-span-2">
                  <input type="number" className={inputCls} value={f.threshold} onChange={(e) => set('threshold', Number(e.target.value))} />
                </Labeled>
              </div>
            ) : (
              <div className="text-sm text-slate-600 bg-white border border-slate-200 rounded-lg px-3 py-2 flex items-center gap-1.5">
                <AlertOctagon size={14} className="text-amber-500 flex-shrink-0" /> Fires when <b>{m.desc}</b>
              </div>
            )}
            <div className="text-xs text-slate-500">Preview: <span className="font-bold text-slate-700">{conditionText(f)}</span></div>
          </div>

          {/* scope + severity */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Labeled label="Applies to">
              <select className={inputCls} value={f.scope_type} onChange={(e) => { set('scope_type', e.target.value); set('scope_value', ''); }}>
                {scopeTypes.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            </Labeled>
            {f.scope_type !== 'all' && (
              <Labeled label={{ technology: 'Technology', server: 'Server', agent: 'Agent', account: 'Account' }[f.scope_type] || 'Target'}>
                <select className={inputCls} value={f.scope_value || ''} onChange={(e) => set('scope_value', e.target.value)}>
                  <option value="">Select…</option>
                  {scopeValues.map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
              </Labeled>
            )}
            <Labeled label="Severity">
              <select className={inputCls} value={f.severity} onChange={(e) => set('severity', e.target.value)}>
                <option value="warning">Warning</option>
                <option value="critical">Critical</option>
              </select>
            </Labeled>
            <Labeled label="Sustained for (seconds)">
              <input type="number" className={inputCls} value={f.duration_seconds} onChange={(e) => set('duration_seconds', Number(e.target.value))} />
            </Labeled>
            <Labeled label="Re-notify cooldown (seconds)">
              <input type="number" className={inputCls} value={f.cooldown_seconds} onChange={(e) => set('cooldown_seconds', Number(e.target.value))} />
            </Labeled>
            <div className="flex items-center gap-3 pt-6">
              <Toggle checked={f.enabled} onChange={(v) => set('enabled', v)} />
              <span className="text-sm font-semibold text-slate-600">{f.enabled ? 'Enabled' : 'Disabled'}</span>
            </div>
          </div>
        </div>

        <div className="sticky bottom-0 bg-white border-t border-slate-100 px-5 py-3 flex justify-end gap-2">
          <button onClick={onClose} className="h-9 px-4 rounded-lg text-slate-600 font-bold text-sm hover:bg-slate-100">Cancel</button>
          <button disabled={!valid || saving} onClick={() => onSave(f)}
            className="h-9 px-5 rounded-lg bg-blue-600 text-white font-bold text-sm hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1.5">
            <Check size={15} />{saving ? 'Saving…' : initial?.id ? 'Save changes' : 'Create rule'}
          </button>
        </div>
      </div>
    </div>
  );
};

// ─── AI Analyse & Fix modal — step-by-step drill-down (ActMon AI / Groq) ────
function AnalyzeModal({ alert, onClose }) {
  const [loading, setLoading] = useState(true);
  const [res, setRes] = useState(null);
  const [err, setErr] = useState(null);
  const [revealed, setRevealed] = useState(1);      // how many drill steps are shown
  const [showSolution, setShowSolution] = useState(false);

  React.useEffect(() => {
    let alive = true;
    setLoading(true); setErr(null); setRes(null); setRevealed(1); setShowSolution(false);
    analyzeAlert({ message: alert.message, metric: alert.metric, source: alert.source, severity: alert.severity })
      .then((d) => { if (!alive) return; d.ok ? setRes(d) : setErr(d.error || 'Analysis failed'); })
      .catch((e) => { if (alive) setErr(e?.response?.data?.detail || e.message || 'Analysis failed'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [alert]);

  const sev = sevOf(alert.severity);
  const steps = res?.steps || [];
  const allRevealed = revealed >= steps.length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 bg-gradient-to-r from-indigo-700 via-violet-700 to-fuchsia-700 px-5 py-4 flex items-center justify-between z-10">
          <h3 className="text-white font-black text-base flex items-center gap-2"><Sparkles size={17} /> ActMon AI — Investigation</h3>
          <button onClick={onClose} className="w-8 h-8 rounded-lg bg-white/10 hover:bg-white/20 text-white flex items-center justify-center"><X size={16} /></button>
        </div>
        <div className="p-5 space-y-4">
          {/* the alert */}
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
            <div className="flex items-center gap-2 mb-1">
              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-black uppercase border ${sev.chip}`}>{sev.icon}{sev.label}</span>
              {alert.source && <span className="text-[11px] font-bold text-slate-500 flex items-center gap-1"><Server size={11} />{alert.source}</span>}
            </div>
            <p className="text-sm font-semibold text-slate-800">{alert.message}</p>
          </div>

          {loading ? (
            <div className="flex flex-col items-center justify-center py-12 text-slate-400">
              <Loader2 size={26} className="animate-spin mb-3 text-indigo-500" />
              <p className="text-sm font-semibold">ActMon AI is investigating…</p>
            </div>
          ) : err ? (
            <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-700">{err}</div>
          ) : res && (
            <>
              {res.summary && <p className="text-sm font-bold text-slate-800">{res.summary}</p>}

              {/* drill-down timeline */}
              <div className="pl-1">
                {steps.slice(0, revealed).map((s, i) => (
                  <div key={i} className="relative pl-8 pb-4 last:pb-0 border-l-2 border-slate-200 last:border-transparent">
                    <span className="absolute -left-[11px] top-0 w-5 h-5 rounded-full bg-indigo-600 text-white text-[11px] font-black flex items-center justify-center">{i + 1}</span>
                    <p className="text-sm font-black text-slate-800 leading-tight">{s.title}</p>
                    <ul className="mt-1.5 space-y-1">
                      {(s.points || []).map((p, j) => (
                        <li key={j} className="text-[13px] text-slate-600 flex gap-2">
                          <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-indigo-400 flex-shrink-0" />
                          <span>{p}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>

              {/* progressive controls */}
              {!allRevealed ? (
                <button onClick={() => setRevealed((r) => r + 1)}
                  className="w-full h-9 rounded-lg bg-indigo-50 text-indigo-700 border border-indigo-200 text-sm font-bold flex items-center justify-center gap-1.5 hover:bg-indigo-100 transition-colors">
                  Drill deeper — step {revealed + 1} of {steps.length} <ChevronDown size={15} />
                </button>
              ) : !showSolution ? (
                <button onClick={() => setShowSolution(true)}
                  className="w-full h-9 rounded-lg bg-gradient-to-r from-emerald-600 to-teal-600 text-white text-sm font-bold flex items-center justify-center gap-1.5 hover:shadow-md transition-all">
                  <Wrench size={15} /> Show root cause &amp; solution
                </button>
              ) : (
                <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 space-y-3">
                  {res.root_cause && (
                    <div>
                      <p className="text-[11px] font-black text-emerald-700 uppercase tracking-wide mb-1 flex items-center gap-1"><AlertOctagon size={12} /> Root cause</p>
                      <p className="text-sm text-slate-800 font-semibold">{res.root_cause}</p>
                    </div>
                  )}
                  {res.solution?.length > 0 && (
                    <div>
                      <p className="text-[11px] font-black text-emerald-700 uppercase tracking-wide mb-1.5 flex items-center gap-1"><Wrench size={12} /> Solution</p>
                      <ol className="space-y-2">
                        {res.solution.map((f, i) => (
                          <li key={i} className="flex gap-2.5 text-sm text-slate-700">
                            <span className="flex-shrink-0 w-5 h-5 rounded-full bg-emerald-600 text-white text-[11px] font-black flex items-center justify-center">{i + 1}</span>
                            <span>{f}</span>
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Result grid for one executed diagnostic command ───────────────────────
function ResultTable({ columns, rows }) {
  if (!rows?.length) return <p className="text-center text-slate-400 text-xs py-3">Query ran — no rows returned.</p>;
  return (
    <div className="mt-2 border border-slate-200 rounded-lg overflow-auto max-h-64">
      <table className="w-full text-xs">
        <thead className="bg-slate-50 sticky top-0"><tr>{columns.map((c) => <th key={c} className="text-left px-2.5 py-1.5 font-bold text-slate-500 whitespace-nowrap">{c}</th>)}</tr></thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri} className="border-t border-slate-100">
              {row.map((cell, ci) => <td key={ci} className="px-2.5 py-1.5 text-slate-700 whitespace-nowrap max-w-[300px] truncate" title={cell === null ? '' : String(cell)}>{cell === null ? '—' : String(cell)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Diagnose: show the warning, then EXECUTE real DB commands step-wise ────
function DiagnoseModal({ alert, ctx, onClose }) {
  const sev = sevOf(alert.severity);
  const [steps, setSteps] = useState([]);
  const [loadingSteps, setLoadingSteps] = useState(true);
  const [results, setResults] = useState({});         // step_id → { loading, ok, columns, rows, error }
  const [ai, setAi] = useState(null);                  // AI recommendation
  const [aiLoading, setAiLoading] = useState(false);

  React.useEffect(() => {
    let alive = true;
    setLoadingSteps(true);
    listDiagnostics(ctx.tech, alert.metric)
      .then((d) => { if (alive) setSteps(d.steps || []); })
      .finally(() => { if (alive) setLoadingSteps(false); });
    return () => { alive = false; };
  }, [ctx, alert]);

  const run = (id) => {
    setResults((p) => ({ ...p, [id]: { loading: true } }));
    runDiagnostic({ conn_id: ctx.conn_id, tech: ctx.tech, step_id: id })
      .then((r) => setResults((p) => ({ ...p, [id]: r })))
      .catch((e) => setResults((p) => ({ ...p, [id]: { ok: false, error: e?.response?.data?.detail || e.message } })));
  };

  const getFix = () => {
    setAiLoading(true); setAi(null);
    analyzeAlert({ message: alert.message, metric: alert.metric, source: alert.source, severity: alert.severity })
      .then((d) => d.ok && setAi(d))
      .finally(() => setAiLoading(false));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm sm:p-6" onClick={onClose}>
      <div className="bg-white w-full h-full sm:h-[90vh] sm:max-w-3xl sm:rounded-2xl shadow-2xl flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        {/* header */}
        <div className="flex-shrink-0 bg-gradient-to-r from-indigo-700 via-violet-700 to-fuchsia-700 px-5 py-4 flex items-center justify-between">
          <h3 className="text-white font-black text-base flex items-center gap-2"><Terminal size={17} /> Investigate — {ctx.label}</h3>
          <button onClick={onClose} className="w-8 h-8 rounded-lg bg-white/10 hover:bg-white/20 text-white flex items-center justify-center"><X size={16} /></button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {/* the warning */}
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-black uppercase border ${sev.chip}`}>{sev.icon}{sev.label}</span>
              {alert.source && <span className="text-[11px] font-bold text-slate-500 flex items-center gap-1"><Server size={11} />{alert.source}</span>}
              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 uppercase">{ctx.tech}</span>
            </div>
            <p className="text-sm font-semibold text-slate-800">{alert.message}</p>
          </div>

          <p className="text-sm font-bold text-slate-600">Run these checks to see why it's happening:</p>

          {loadingSteps ? (
            <div className="flex items-center justify-center py-10 text-slate-400"><Loader2 size={22} className="animate-spin mr-2" /> Loading checks…</div>
          ) : steps.length === 0 ? (
            <p className="text-sm text-slate-400">No live diagnostics available for this engine yet.</p>
          ) : steps.map((s, i) => {
            const r = results[s.id];
            return (
              <div key={s.id} className="rounded-xl border border-slate-200 bg-white p-3.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-black text-slate-800">{i + 1}. {s.title}</p>
                    <p className="text-xs text-slate-500 mt-0.5">{s.desc}</p>
                  </div>
                  <button onClick={() => run(s.id)} disabled={r?.loading}
                    className="flex-shrink-0 h-8 px-3 rounded-lg bg-slate-900 text-white text-xs font-bold flex items-center gap-1.5 hover:bg-slate-700 disabled:opacity-50">
                    {r?.loading ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />} Execute
                  </button>
                </div>
                {r && !r.loading && (r.ok
                  ? <ResultTable columns={r.columns} rows={r.rows} />
                  : <div className="mt-2 bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-xs text-red-700 font-mono">{r.error || 'Query failed'}</div>)}
              </div>
            );
          })}

          {/* AI recommendation after checks */}
          <div className="pt-2">
            {!ai && (
              <button onClick={getFix} disabled={aiLoading}
                className="w-full h-9 rounded-lg bg-gradient-to-r from-emerald-600 to-teal-600 text-white text-sm font-bold flex items-center justify-center gap-1.5 hover:shadow-md disabled:opacity-60">
                {aiLoading ? <Loader2 size={15} className="animate-spin" /> : <Wrench size={15} />} Recommend a fix (ActMon AI)
              </button>
            )}
            {ai && (
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 space-y-3">
                {ai.root_cause && <div><p className="text-[11px] font-black text-emerald-700 uppercase tracking-wide mb-1 flex items-center gap-1"><AlertOctagon size={12} /> Root cause</p><p className="text-sm text-slate-800 font-semibold">{ai.root_cause}</p></div>}
                {ai.solution?.length > 0 && (
                  <div>
                    <p className="text-[11px] font-black text-emerald-700 uppercase tracking-wide mb-1.5 flex items-center gap-1"><Wrench size={12} /> Solution</p>
                    <ol className="space-y-2">
                      {ai.solution.map((f, i) => (
                        <li key={i} className="flex gap-2.5 text-sm text-slate-700"><span className="flex-shrink-0 w-5 h-5 rounded-full bg-emerald-600 text-white text-[11px] font-black flex items-center justify-center">{i + 1}</span><span>{f}</span></li>
                      ))}
                    </ol>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Windowed AGENTIC investigation: runs one check, explains it, decides next ──
function ResultTableLite({ columns, rows }) {
  if (!rows?.length) return <div className="text-slate-400 text-xs py-2">Ran successfully — no rows returned.</div>;
  return (
    <div className="mt-2 border border-slate-200 rounded-lg overflow-auto max-h-56">
      <table className="w-full text-[12px]">
        <thead className="bg-slate-50 sticky top-0"><tr>{columns.map((c) => <th key={c} className="text-left px-2.5 py-1.5 font-bold text-slate-500 whitespace-nowrap">{c}</th>)}</tr></thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri} className="border-t border-slate-100">
              {row.map((cell, ci) => <td key={ci} className="px-2.5 py-1 text-slate-700 whitespace-nowrap max-w-[300px] truncate font-mono" title={cell === null ? '' : String(cell)}>{cell === null ? '—' : String(cell)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function InvestigateTerminal({ alert, ctx, onClose }) {
  const sev = sevOf(alert.severity);
  const [steps, setSteps] = useState([]);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [conclusion, setConclusion] = useState(null);
  const [fatal, setFatal] = useState(null);
  const started = React.useRef(false);
  const MAX_STEPS = 10;

  const preview = (s) => {
    if (s.error) return `ERROR: ${s.error}`;
    if (!s.columns) return '(no output)';
    const head = s.columns.join(' | ');
    const body = (s.rows || []).slice(0, 3).map((r) => r.map((c) => (c === null ? 'NULL' : String(c))).join(' | ')).join('\n');
    const more = (s.rows || []).length > 3 ? `\n… ${s.rows.length} rows` : '';
    return `${head}\n${body}${more}`;
  };

  const runNext = React.useCallback(async () => {
    setRunning(true); setFatal(null);
    const history = steps.filter((s) => s.sql).map((s) => ({ title: s.title, sql: s.sql, preview: preview(s) }));
    try {
      const d = await agentStep({
        conn_id: ctx.conn_id, tech: ctx.tech,
        alert: { message: alert.message, metric: alert.metric, source: alert.source, severity: alert.severity },
        history,
      });
      if (!d.ok) setFatal(d.error || 'AI unavailable');
      else if (d.done) { setConclusion({ root_cause: d.root_cause, solution: d.solution, reasoning: d.reasoning }); setDone(true); }
      else setSteps((p) => [...p, { title: d.title, reasoning: d.reasoning, sql: d.sql, columns: d.columns, rows: d.rows, error: d.error }]);
    } catch (e) { setFatal(e?.response?.data?.detail || e.message); }
    finally { setRunning(false); }
  }, [steps, ctx, alert]);

  React.useEffect(() => { if (!started.current) { started.current = true; runNext(); } }, [runNext]);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="bg-white w-full max-w-3xl max-h-[90vh] rounded-2xl shadow-2xl flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        {/* header */}
        <div className="flex-shrink-0 bg-gradient-to-r from-indigo-700 via-violet-700 to-fuchsia-700 px-5 py-4 flex items-center justify-between">
          <h3 className="text-white font-black text-base flex items-center gap-2"><Terminal size={17} /> Guided Investigation — {ctx.label}</h3>
          <button onClick={onClose} className="w-8 h-8 rounded-lg bg-white/10 hover:bg-white/20 text-white flex items-center justify-center"><X size={16} /></button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          {/* the alert */}
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-black uppercase border ${sev.chip}`}>{sev.icon}{sev.label}</span>
              {alert.source && <span className="text-[11px] font-bold text-slate-500 flex items-center gap-1"><Server size={11} />{alert.source}</span>}
              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 uppercase">{ctx.tech}</span>
            </div>
            <p className="text-sm font-semibold text-slate-800">{alert.message}</p>
          </div>
          <p className="text-[13px] text-slate-500">ActMon AI checks one thing at a time. Read each result, then press <b>Next check</b> — the next step is chosen from what the last one showed.</p>

          {/* steps */}
          {steps.map((s, i) => (
            <div key={i} className="rounded-xl border border-slate-200 p-3.5">
              <div className="flex items-center gap-2">
                <span className="w-5 h-5 rounded-full bg-indigo-600 text-white text-[11px] font-black flex items-center justify-center flex-shrink-0">{i + 1}</span>
                <p className="text-sm font-black text-slate-800">{s.title}</p>
              </div>
              {s.reasoning && (
                <p className="mt-1.5 text-[13px] text-slate-600 flex gap-1.5">
                  <Search size={13} className="text-indigo-500 flex-shrink-0 mt-0.5" />
                  <span><b className="text-slate-700">What we check:</b> {s.reasoning}</span>
                </p>
              )}
              {s.sql && <pre className="mt-2 bg-slate-900 text-emerald-300 rounded-lg px-3 py-2 text-[12px] font-mono overflow-x-auto whitespace-pre-wrap">{s.sql}</pre>}
              {s.error
                ? <div className="mt-2 bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-xs text-red-700 font-mono">{s.error}</div>
                : <ResultTableLite columns={s.columns} rows={s.rows} />}
            </div>
          ))}

          {running && <div className="text-indigo-600 text-sm flex items-center gap-2 py-2"><Loader2 size={15} className="animate-spin" /> ActMon AI is reading the result and choosing the next check…</div>}
          {fatal && <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">{fatal}</div>}

          {/* conclusion */}
          {conclusion && (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 space-y-3">
              {conclusion.reasoning && <p className="text-[13px] text-emerald-800/80">{conclusion.reasoning}</p>}
              {conclusion.root_cause && <div><p className="text-[11px] font-black text-emerald-700 uppercase tracking-wide mb-1 flex items-center gap-1"><AlertOctagon size={12} /> Root cause</p><p className="text-sm text-slate-800 font-semibold">{conclusion.root_cause}</p></div>}
              {conclusion.solution?.length > 0 && (
                <div>
                  <p className="text-[11px] font-black text-emerald-700 uppercase tracking-wide mb-1.5 flex items-center gap-1"><Wrench size={12} /> Solution</p>
                  <ol className="space-y-2">
                    {conclusion.solution.map((f, i) => (
                      <li key={i} className="flex gap-2.5 text-sm text-slate-700"><span className="flex-shrink-0 w-5 h-5 rounded-full bg-emerald-600 text-white text-[11px] font-black flex items-center justify-center">{i + 1}</span><span>{f}</span></li>
                    ))}
                  </ol>
                </div>
              )}
            </div>
          )}
        </div>

        {/* footer */}
        <div className="flex-shrink-0 border-t border-slate-100 px-5 py-3 flex items-center justify-between">
          <span className="text-[12px] text-slate-400">Step {steps.length}{done ? ' · complete' : ` / ~${MAX_STEPS}`}</span>
          {done ? (
            <span className="text-emerald-600 text-sm font-bold flex items-center gap-1.5"><CheckCheck size={16} /> Investigation complete</span>
          ) : (
            <button onClick={runNext} disabled={running || steps.length >= MAX_STEPS}
              className="h-9 px-4 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-bold flex items-center gap-1.5 disabled:opacity-50">
              {running ? <Loader2 size={15} className="animate-spin" /> : <Play size={15} />}
              {steps.length >= MAX_STEPS ? 'Max steps' : 'Next check'}
              {!running && steps.length < MAX_STEPS && <ChevronRight size={15} />}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Investigate: resolve to a live connection → REAL diagnostics, else AI ──
// dark compact table for the terminal column
function DarkTable({ columns, rows }) {
  if (!rows?.length) return <div className="text-slate-500 py-1">— no rows —</div>;
  return (
    <div className="my-1.5 border border-slate-800 rounded-md overflow-auto max-h-56">
      <table className="w-full text-[11.5px]">
        <thead className="bg-slate-800/70"><tr>{columns.map((c) => <th key={c} className="text-left px-2 py-1 text-sky-300 font-bold whitespace-nowrap">{c}</th>)}</tr></thead>
        <tbody>{rows.map((r, ri) => <tr key={ri} className="border-t border-slate-800">{r.map((c, ci) => <td key={ci} className="px-2 py-1 text-slate-300 whitespace-nowrap max-w-[240px] truncate" title={c === null ? '' : String(c)}>{c === null ? 'NULL' : String(c)}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

// ─── Inline INVESTIGATION PANEL: guidance (left) + live terminal (right) ────
function InvestigatePanel({ alert, onBack }) {
  const sev = sevOf(alert.severity);
  const [ctx, setCtx] = useState(undefined);   // undefined=resolving, null=no conn, obj=found
  const [steps, setSteps] = useState([]);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [conclusion, setConclusion] = useState(null);
  const [fatal, setFatal] = useState(null);
  const [ai, setAi] = useState(null);
  const started = React.useRef(false);

  React.useEffect(() => {
    let alive = true; setCtx(undefined);
    drillContext(alert.source, alert.metric)
      .then((d) => { if (alive) setCtx(d && d.found ? d : null); })
      .catch(() => { if (alive) setCtx(null); });
    return () => { alive = false; };
  }, [alert]);

  const preview = (s) => {
    if (s.error) return `ERROR: ${s.error}`;
    if (!s.columns) return '(no output)';
    const head = s.columns.join(' | ');
    const body = (s.rows || []).slice(0, 3).map((r) => r.map((c) => (c === null ? 'NULL' : String(c))).join(' | ')).join('\n');
    return `${head}\n${body}${(s.rows || []).length > 3 ? `\n… ${s.rows.length} rows` : ''}`;
  };

  const runNext = React.useCallback(async () => {
    if (!ctx) return;
    setRunning(true); setFatal(null);
    const history = steps.filter((s) => s.sql).map((s) => ({ title: s.title, sql: s.sql, preview: preview(s) }));
    try {
      const d = await agentStep({ conn_id: ctx.conn_id, tech: ctx.tech,
        alert: { message: alert.message, metric: alert.metric, source: alert.source, severity: alert.severity }, history });
      if (!d.ok) setFatal(d.error || 'AI unavailable');
      else if (d.done) { setConclusion({ root_cause: d.root_cause, solution: d.solution, reasoning: d.reasoning }); setDone(true); }
      else setSteps((p) => [...p, { title: d.title, reasoning: d.reasoning, sql: d.sql, columns: d.columns, rows: d.rows, error: d.error }]);
    } catch (e) { setFatal(e?.response?.data?.detail || e.message); }
    finally { setRunning(false); }
  }, [steps, ctx, alert]);

  React.useEffect(() => { if (ctx && !started.current) { started.current = true; runNext(); } }, [ctx]); // eslint-disable-line
  React.useEffect(() => { if (ctx === null && !ai) { analyzeAlert({ message: alert.message, metric: alert.metric, source: alert.source, severity: alert.severity }).then((d) => d.ok && setAi(d)); } }, [ctx]); // eslint-disable-line

  const Conclusion = () => (
    <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 space-y-3">
      {conclusion.reasoning && <p className="text-[13px] text-emerald-800/80">{conclusion.reasoning}</p>}
      {conclusion.root_cause && <div><p className="text-[11px] font-black text-emerald-700 uppercase tracking-wide mb-1 flex items-center gap-1"><AlertOctagon size={12} /> Root cause</p><p className="text-sm text-slate-800 font-semibold">{conclusion.root_cause}</p></div>}
      {conclusion.solution?.length > 0 && (
        <div><p className="text-[11px] font-black text-emerald-700 uppercase tracking-wide mb-1.5 flex items-center gap-1"><Wrench size={12} /> Solution</p>
          <ol className="space-y-2">{conclusion.solution.map((f, i) => <li key={i} className="flex gap-2.5 text-sm text-slate-700"><span className="flex-shrink-0 w-5 h-5 rounded-full bg-emerald-600 text-white text-[11px] font-black flex items-center justify-center">{i + 1}</span><span>{f}</span></li>)}</ol>
        </div>
      )}
    </div>
  );

  return (
    <div className="space-y-3">
      {/* top bar */}
      <div className="flex items-center justify-between gap-3">
        <button onClick={onBack} className="h-8 px-3 rounded-lg border border-slate-200 bg-white text-slate-600 text-sm font-bold flex items-center gap-1.5 hover:bg-slate-50"><ChevronLeft size={15} /> Back to alerts</button>
        {ctx && (done
          ? <span className="text-emerald-600 text-sm font-bold flex items-center gap-1.5"><CheckCheck size={16} /> Investigation complete</span>
          : <button onClick={runNext} disabled={running} className="h-9 px-4 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-bold flex items-center gap-1.5 disabled:opacity-50">{running ? <Loader2 size={15} className="animate-spin" /> : <Play size={15} />} Next check <ChevronRight size={15} /></button>)}
      </div>

      {/* alert banner */}
      <div className="rounded-xl border bg-white p-3" style={{ borderLeftWidth: 4, borderLeftColor: sev.dot }}>
        <div className="flex items-center gap-2 mb-1 flex-wrap">
          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-black uppercase border ${sev.chip}`}>{sev.icon}{sev.label}</span>
          {alert.source && <span className="text-[11px] font-bold text-slate-500 flex items-center gap-1"><Server size={11} />{alert.source}</span>}
          {ctx && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 uppercase">{ctx.tech}</span>}
        </div>
        <p className="text-sm font-semibold text-slate-800">{alert.message}</p>
      </div>

      {ctx === undefined && <div className="flex items-center justify-center py-16 text-slate-400 text-sm"><Loader2 size={20} className="animate-spin mr-2" /> Locating live connection…</div>}

      {ctx === null && (
        <div className="rounded-2xl border border-slate-200 bg-white p-5">
          <p className="text-sm text-slate-600 mb-3">No live database connection is linked to this source — ActMon AI gives guided steps and a fix:</p>
          {!ai ? <div className="flex items-center gap-2 text-slate-400 text-sm"><Loader2 size={16} className="animate-spin" /> analysing…</div> : (
            <div className="space-y-3">
              {ai.summary && <p className="text-sm font-bold text-slate-800">{ai.summary}</p>}
              {(ai.steps || []).map((s, i) => (
                <div key={i}><p className="text-sm font-black text-slate-800">{i + 1}. {s.title}</p>
                  <ul className="mt-1 space-y-1">{(s.points || []).map((p, j) => <li key={j} className="text-[13px] text-slate-600 flex gap-2"><span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-indigo-400 flex-shrink-0" />{p}</li>)}</ul>
                </div>
              ))}
              {(ai.root_cause || ai.solution?.length) && (
                <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 space-y-3">
                  {ai.root_cause && <div><p className="text-[11px] font-black text-emerald-700 uppercase mb-1">Root cause</p><p className="text-sm text-slate-800 font-semibold">{ai.root_cause}</p></div>}
                  {ai.solution?.length > 0 && <div><p className="text-[11px] font-black text-emerald-700 uppercase mb-1.5">Solution</p><ol className="space-y-2">{ai.solution.map((f, i) => <li key={i} className="flex gap-2.5 text-sm text-slate-700"><span className="flex-shrink-0 w-5 h-5 rounded-full bg-emerald-600 text-white text-[11px] font-black flex items-center justify-center">{i + 1}</span><span>{f}</span></li>)}</ol></div>}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {ctx && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* GUIDANCE (left) */}
          <div className="rounded-2xl border border-slate-200 bg-white flex flex-col overflow-hidden">
            <div className="px-4 py-2.5 border-b border-slate-100 flex items-center gap-2 bg-slate-50"><Search size={15} className="text-indigo-500" /><span className="text-sm font-black text-slate-700">Guided analysis</span></div>
            <div className="p-4 space-y-4 overflow-y-auto" style={{ maxHeight: '62vh' }}>
              {steps.map((s, i) => (
                <div key={i} className="flex gap-2.5">
                  <span className="flex-shrink-0 w-6 h-6 rounded-full bg-indigo-600 text-white text-xs font-black flex items-center justify-center">{i + 1}</span>
                  <div className="min-w-0">
                    <p className="text-sm font-black text-slate-800">{s.title}</p>
                    {s.reasoning && <p className="text-[13px] text-slate-600 mt-0.5"><b className="text-slate-700">What we check:</b> {s.reasoning}</p>}
                  </div>
                </div>
              ))}
              {running && <div className="text-indigo-600 text-sm flex items-center gap-2"><Loader2 size={15} className="animate-spin" /> Reading the result & choosing the next check…</div>}
              {conclusion && <Conclusion />}
              {!steps.length && !running && <p className="text-slate-400 text-sm">Starting investigation…</p>}
            </div>
          </div>

          {/* TERMINAL (right) */}
          <div className="rounded-2xl border border-slate-800 bg-[#0b0f17] flex flex-col overflow-hidden">
            <div className="px-4 py-2.5 border-b border-slate-800 flex items-center gap-2"><Terminal size={15} className="text-emerald-400" /><span className="text-sm font-black text-slate-200">Terminal · {ctx.label}</span></div>
            <div className="p-4 space-y-3 overflow-y-auto font-mono text-[12px] leading-relaxed" style={{ maxHeight: '62vh' }}>
              {steps.map((s, i) => (
                <div key={i}>
                  <div className="text-emerald-400 break-all"><span className="text-slate-500">{ctx.tech}=#</span> {s.sql}</div>
                  {s.error ? <div className="text-red-400 mt-1 whitespace-pre-wrap">{s.error}</div> : <DarkTable columns={s.columns} rows={s.rows} />}
                </div>
              ))}
              {running && <div className="text-sky-300 flex items-center gap-2"><Loader2 size={13} className="animate-spin" /> running…</div>}
              {!steps.length && !running && <div className="text-slate-500">Starting investigation…</div>}
            </div>
          </div>
        </div>
      )}
      {fatal && <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">{fatal}</div>}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────
export const AlertsPage = () => {
  const qc = useQueryClient();
  const { addToast } = useToast();
  const { canHere } = usePermissions();
  const [tab, setTab] = useState('active');

  const activeQ = useQuery({ queryKey: ['activeAlerts'], queryFn: () => listActiveAlerts(false), refetchInterval: 15000 });
  const alerts = activeQ.data || [];
  const [sevFilter, setSevFilter] = useState('all');
  const [showAllAlerts, setShowAllAlerts] = useState(false);
  const [view, setView] = useState('grid');            // grid | list
  const [investigate, setInvestigate] = useState(null);
  const [seen, setSeen] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem('actmon_seen_alerts') || '[]')); }
    catch { return new Set(); }
  });
  const markSeen = (id) => setSeen((prev) => {
    if (prev.has(id)) return prev;
    const n = new Set(prev); n.add(id);
    try { localStorage.setItem('actmon_seen_alerts', JSON.stringify([...n])); } catch (_) {}
    return n;
  });
  const [aSearch, setASearch] = useState('');

  const rulesQ = useQuery({ queryKey: ['alertRules'], queryFn: listRules });
  const rules = rulesQ.data || [];
  const [activeSection, setActiveSection] = useState('infrastructure');
  const [rSearch, setRSearch] = useState('');
  const [rSev, setRSev] = useState('all');

  const { data: serversData } = useQuery({ queryKey: ['osServers'], queryFn: () => listOsServers() });
  const servers = serversData?.data || [];
  const { data: agents = [] } = useAgentsList();
  const { data: cloudAccounts } = useQuery({ queryKey: ['dashCloudAccounts'], queryFn: listAccounts, retry: false });
  const cloudList = Array.isArray(cloudAccounts) ? cloudAccounts : [];

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [modalSection, setModalSection] = useState('infrastructure');

  const saveMut = useMutation({
    mutationFn: (r) => (r.id ? updateRule(r.id, r) : createRule(r)),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['alertRules'] }); setModalOpen(false); addToast('Alert rule saved.', 'success'); },
    onError: () => addToast('Failed to save rule.', 'error'),
  });
  const toggleMut = useMutation({
    mutationFn: ({ id, enabled }) => toggleRule(id, enabled),
    // Optimistic: flip the switch instantly and keep the card in place (no reorder / flicker).
    onMutate: async ({ id, enabled }) => {
      await qc.cancelQueries({ queryKey: ['alertRules'] });
      const prev = qc.getQueryData(['alertRules']);
      qc.setQueryData(['alertRules'], (old = []) => old.map((r) => (r.id === id ? { ...r, enabled } : r)));
      return { prev };
    },
    onError: (_e, _v, ctx) => { if (ctx?.prev) qc.setQueryData(['alertRules'], ctx.prev); },
    onSettled: () => qc.invalidateQueries({ queryKey: ['alertRules'] }),
  });
  const delMut = useMutation({ mutationFn: (id) => deleteRule(id), onSuccess: () => { qc.invalidateQueries({ queryKey: ['alertRules'] }); addToast('Rule deleted.', 'success'); } });

  const counts = useMemo(() => ({
    total: alerts.length,
    critical: alerts.filter((a) => a.severity === 'critical').length,
    warning: alerts.filter((a) => a.severity === 'warning').length,
    info: alerts.filter((a) => !['critical', 'warning'].includes(a.severity)).length,
  }), [alerts]);

  const shownAlerts = alerts
    .filter((a) => sevFilter === 'all' || (sevFilter === 'info' ? !['critical', 'warning'].includes(a.severity) : a.severity === sevFilter))
    .filter((a) => !aSearch || (a.message || '').toLowerCase().includes(aSearch.toLowerCase()) || (a.source || '').toLowerCase().includes(aSearch.toLowerCase()));
  const ALERT_PREVIEW = 6;
  const visibleAlerts = showAllAlerts ? shownAlerts : shownAlerts.slice(0, ALERT_PREVIEW);

  const sectionRules = rules.filter((r) => sectionOf(r.metric) === activeSection);
  const shownRules = sectionRules
    .filter((r) => rSev === 'all' || r.severity === rSev)
    .filter((r) => !rSearch || r.name.toLowerCase().includes(rSearch.toLowerCase()) || conditionText(r).toLowerCase().includes(rSearch.toLowerCase()))
    // stable order by id → toggling on/off never moves a card
    .sort((a, b) => a.id - b.id);

  const openNew = () => { setEditing(null); setModalSection(activeSection); setModalOpen(true); };
  const openEdit = (r) => { setEditing(r); setModalSection(sectionOf(r.metric)); setModalOpen(true); };

  const canAdd = canHere('add'), canEdit = canHere('edit'), canDelete = canHere('delete');
  const secMeta = sectionMeta(activeSection);

  return (
    <div className="-mx-6 md:-mx-8 min-h-full bg-[#f1f4f9]">

      {/* HERO */}
      <div className="bg-gradient-to-r from-slate-900 via-blue-800 to-sky-700 px-6 md:px-8 pt-3 pb-0 relative overflow-hidden">
        <div className="absolute inset-0 opacity-[0.04]" style={{ backgroundImage: 'linear-gradient(#fff 1px,transparent 1px),linear-gradient(90deg,#fff 1px,transparent 1px)', backgroundSize: '28px 28px' }} />
        <div className="relative flex items-center gap-2 text-xs text-slate-300/70 mb-2.5">
          <span>ActMon</span><ChevronRight size={11} /><span className="text-white font-semibold">Alerts</span>
        </div>
        <div className="relative flex items-center justify-between gap-3 mb-3">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-sky-400/20 border border-sky-400/40 flex items-center justify-center flex-shrink-0">
              <BellRing size={18} className="text-sky-200" />
            </div>
            <div>
              <h1 className="text-lg font-black text-white tracking-tight leading-none">Alerts &amp; Thresholds</h1>
              <p className="text-sky-200/70 text-[11px] mt-0.5">Real-time alerts and section-wise threshold rules</p>
            </div>
          </div>
          <div className="hidden sm:flex items-center gap-2 bg-white/10 border border-white/15 rounded-lg px-3 py-1.5">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-[11px] text-sky-100 font-semibold">Live · auto-refresh 15s</span>
          </div>
        </div>
        <div className="relative flex items-center gap-1">
          {[
            { id: 'active', label: 'Active Alerts', icon: <Bell size={14} />, badge: counts.total },
            { id: 'rules',  label: 'Alert Rules',   icon: <SlidersHorizontal size={14} />, badge: rules.length },
          ].map((t) => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`px-4 py-2.5 text-sm font-bold flex items-center gap-2 border-b-2 transition-colors ${tab === t.id ? 'border-white text-white' : 'border-transparent text-sky-200/70 hover:text-white'}`}>
              {t.icon}{t.label}
              {t.badge > 0 && <span className={`text-[10px] font-black px-1.5 py-0.5 rounded-full ${tab === t.id ? 'bg-white text-blue-700' : 'bg-white/15 text-white'}`}>{t.badge}</span>}
            </button>
          ))}
        </div>
      </div>

      <div className="px-6 md:px-8 py-6 max-w-[1600px] mx-auto">

        {/* ═══════════ ACTIVE ALERTS ═══════════ */}
        {tab === 'active' && investigate && (
          <InvestigatePanel alert={investigate} onBack={() => setInvestigate(null)} />
        )}
        {tab === 'active' && !investigate && (
          <div className="space-y-5">
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <Kpi icon={<Bell size={18} />} value={counts.total} label="Active alerts" color="#0f172a" bg="bg-slate-100" active={sevFilter === 'all'} onClick={() => setSevFilter('all')} />
              <Kpi icon={<ShieldAlert size={18} />} value={counts.critical} label="Critical" color="#dc2626" bg="bg-red-50" active={sevFilter === 'critical'} onClick={() => setSevFilter('critical')} />
              <Kpi icon={<AlertTriangle size={18} />} value={counts.warning} label="Warning" color="#d97706" bg="bg-amber-50" active={sevFilter === 'warning'} onClick={() => setSevFilter('warning')} />
              <Kpi icon={<Info size={18} />} value={counts.info} label="Info" color="#2563eb" bg="bg-blue-50" active={sevFilter === 'info'} onClick={() => setSevFilter('info')} />
            </div>
            {/* toolbar */}
            <div className="flex flex-wrap items-center gap-2 justify-between">
              <div className="flex items-center gap-2">
                <div className="relative">
                  <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input value={aSearch} onChange={(e) => setASearch(e.target.value)} placeholder="Search alerts…" className="h-9 pl-8 pr-3 rounded-lg border border-slate-200 text-sm outline-none focus:border-blue-400 w-60 bg-white" />
                </div>
                {sevFilter !== 'all' && <button onClick={() => setSevFilter('all')} className="text-xs font-bold text-blue-600">Clear filter</button>}
              </div>
              <div className="flex items-center gap-2">
                <span className="hidden sm:flex items-center gap-1.5 text-[11px] font-semibold text-slate-400">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" /> Live · auto every 15s
                </span>
                <div className="flex items-center gap-0.5 bg-white border border-slate-200 rounded-lg p-0.5">
                  <button onClick={() => setView('grid')} title="Grid view"
                    className={`w-7 h-7 rounded-md flex items-center justify-center transition-colors ${view === 'grid' ? 'bg-slate-900 text-white' : 'text-slate-500 hover:bg-slate-100'}`}><LayoutGrid size={14} /></button>
                  <button onClick={() => setView('list')} title="List view"
                    className={`w-7 h-7 rounded-md flex items-center justify-center transition-colors ${view === 'list' ? 'bg-slate-900 text-white' : 'text-slate-500 hover:bg-slate-100'}`}><List size={14} /></button>
                </div>
                <button onClick={() => activeQ.refetch()} className="h-9 px-3 rounded-lg border border-slate-200 bg-white text-slate-600 text-xs font-bold flex items-center gap-1.5 hover:bg-slate-50">
                  <RefreshCw size={14} className={activeQ.isFetching ? 'animate-spin' : ''} /> Refresh
                </button>
              </div>
            </div>

            {activeQ.isLoading ? (
              <div className="py-16 text-center text-slate-400 text-sm">Evaluating rules…</div>
            ) : shownAlerts.length === 0 ? (
              <div className="bg-white rounded-2xl border border-slate-200 shadow-sm py-16 flex flex-col items-center justify-center text-center">
                <div className="w-16 h-16 rounded-2xl bg-emerald-50 flex items-center justify-center mb-3"><CheckCheck className="text-emerald-500" size={30} /></div>
                <p className="text-lg font-black text-slate-700">All clear</p>
                <p className="text-sm text-slate-400">{alerts.length ? 'No alerts match your filter.' : 'No rules are firing right now.'}</p>
              </div>
            ) : (
              <>
              <div className={view === 'grid' ? 'grid grid-cols-1 xl:grid-cols-2 gap-3' : 'flex flex-col gap-2.5'}>
                {visibleAlerts.map((a) => {
                  const sev = sevOf(a.severity);
                  const sm = sectionMeta(sectionOf(a.metric));
                  return (
                    <div key={a.id} className="flex rounded-2xl border bg-white shadow-sm overflow-hidden hover:shadow-md transition-shadow" style={{ borderColor: `${sev.dot}33` }}>
                      <div className="w-1.5 flex-shrink-0" style={{ background: sev.dot }} />
                      <div className="p-4 flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1.5">
                          <span className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: `${sm.color}18`, color: sm.color }}>{sm.icon}</span>
                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-black uppercase border ${sev.chip}`}>{sev.icon}{sev.label}</span>
                          <span className="text-[11px] font-bold text-slate-400">{sm.label}</span>
                          <span className="ml-auto flex items-center gap-2 text-[10px]">
                            <span className="flex items-center gap-1 text-slate-400 font-semibold"><Clock size={10} />{ago(a.created_at)}</span>
                            {seen.has(a.id)
                              ? <span className="px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-500 font-bold">SEEN</span>
                              : <span className="px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-700 font-black animate-pulse">NEW</span>}
                          </span>
                        </div>
                        <p className="text-sm font-black text-slate-800 truncate">{a.rule_name}</p>
                        <p className="text-[13px] text-slate-600 mt-0.5 leading-snug">{a.message}</p>
                        <div className="flex flex-wrap items-center gap-1.5 mt-2.5">
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold bg-slate-100 text-slate-700"><Server size={11} />{a.source}</span>
                          {a.technology && <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold bg-blue-50 text-blue-700"><Database size={11} />{a.technology}</span>}
                          {a.environment && <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold bg-slate-100 text-slate-500"><Layers size={11} />{a.environment}</span>}
                          {a.value && (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-black" style={{ background: `${sev.dot}18`, color: sev.dot }}>
                              {a.value}{a.threshold ? <span className="opacity-60 font-semibold">/ {a.threshold}</span> : null}
                            </span>
                          )}
                        </div>
                        <div className="mt-2.5 flex justify-end">
                          <button onClick={() => { setInvestigate(a); markSeen(a.id); }}
                            className="h-7 px-2.5 rounded-lg bg-indigo-50 text-indigo-700 border border-indigo-200 text-[11px] font-bold flex items-center gap-1 hover:bg-indigo-100 transition-colors">
                            <Sparkles size={12} /> Analyse
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
              {shownAlerts.length > ALERT_PREVIEW && (
                <div className="flex justify-center mt-4">
                  <button onClick={() => setShowAllAlerts((v) => !v)}
                    className="h-9 px-4 rounded-lg bg-white border border-slate-200 text-slate-600 text-sm font-bold flex items-center gap-1.5 hover:bg-slate-50 hover:border-slate-300 shadow-sm transition-all">
                    {showAllAlerts ? 'Show less' : `Show all ${shownAlerts.length} alerts`}
                    <ChevronDown size={15} className={`transition-transform ${showAllAlerts ? 'rotate-180' : ''}`} />
                  </button>
                </div>
              )}
              </>
            )}
          </div>
        )}

        {/* ═══════════ ALERT RULES (section-wise) ═══════════ */}
        {tab === 'rules' && (
          <div className="space-y-4">
            {/* SECTION SELECTOR */}
            <div className="flex flex-wrap gap-2">
              {SECTIONS.map((s) => {
                const count = rules.filter((r) => sectionOf(r.metric) === s.id).length;
                const active = activeSection === s.id;
                return (
                  <button key={s.id} onClick={() => setActiveSection(s.id)}
                    className={`flex items-center gap-2 h-11 px-4 rounded-xl border text-sm font-bold transition-all ${active ? 'text-white border-transparent shadow-md' : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300 hover:-translate-y-0.5'}`}
                    style={active ? { background: s.color } : undefined}>
                    <span style={active ? undefined : { color: s.color }}>{s.icon}</span>
                    {s.label}
                    <span className={`text-[10px] font-black px-1.5 py-0.5 rounded-full ${active ? 'bg-white/25' : 'bg-slate-100 text-slate-500'}`}>{count}</span>
                  </button>
                );
              })}
            </div>

            {/* section description + toolbar */}
            <div className="flex flex-wrap items-center gap-2 justify-between">
              <div className="flex items-center gap-2 text-slate-500">
                <span style={{ color: secMeta.color }}>{secMeta.icon}</span>
                <span className="text-sm font-semibold text-slate-600">{secMeta.desc}</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="relative">
                  <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input value={rSearch} onChange={(e) => setRSearch(e.target.value)} placeholder={`Search ${secMeta.label} rules…`} className="h-9 pl-8 pr-3 rounded-lg border border-slate-200 text-sm outline-none focus:border-blue-400 w-56 bg-white" />
                </div>
                <div className="flex items-center gap-1 bg-white border border-slate-200 rounded-lg p-0.5">
                  {['all', 'critical', 'warning'].map((s) => (
                    <button key={s} onClick={() => setRSev(s)} className={`h-8 px-3 rounded-md text-xs font-bold capitalize transition-colors ${rSev === s ? 'bg-slate-900 text-white' : 'text-slate-500 hover:bg-slate-100'}`}>{s}</button>
                  ))}
                </div>
                {canAdd && (
                  <button onClick={openNew} className="h-9 px-4 rounded-lg bg-blue-600 text-white font-bold text-sm flex items-center gap-1.5 hover:bg-blue-700 shadow-sm">
                    <Plus size={16} /> New {secMeta.label} Rule
                  </button>
                )}
              </div>
            </div>

            {rulesQ.isLoading ? (
              <div className="py-16 text-center text-slate-400 text-sm">Loading rules…</div>
            ) : shownRules.length === 0 ? (
              <div className="bg-white rounded-2xl border border-dashed border-slate-300 py-16 text-center">
                <div className="w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-3" style={{ background: `${secMeta.color}18`, color: secMeta.color }}>{secMeta.icon}</div>
                <p className="text-base font-black text-slate-700">No {secMeta.label} rules {sectionRules.length ? 'match' : 'yet'}</p>
                <p className="text-sm text-slate-400 mb-4">Create a {secMeta.label.toLowerCase()} threshold rule to start monitoring.</p>
                {canAdd && sectionRules.length === 0 && <button onClick={openNew} className="h-9 px-5 rounded-lg bg-blue-600 text-white font-bold text-sm inline-flex items-center gap-1.5"><Plus size={15} /> New {secMeta.label} Rule</button>}
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                {shownRules.map((r) => {
                  const s = sevOf(r.severity);
                  const sm = sectionMeta(sectionOf(r.metric));
                  return (
                    <div key={r.id} className={`bg-white rounded-2xl border shadow-sm p-4 flex flex-col gap-3 transition-all ${r.enabled ? 'border-slate-200' : 'border-slate-200 opacity-70'}`}>
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: `${sm.color}18`, color: sm.color }}>{sm.icon}</div>
                          <div className="min-w-0">
                            <h3 className="text-sm font-black text-slate-800 truncate">{r.name}</h3>
                            <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-black uppercase border mt-0.5 ${s.chip}`}>{s.icon}{s.label}</span>
                          </div>
                        </div>
                        <Toggle checked={r.enabled} disabled={!canEdit} onChange={(v) => toggleMut.mutate({ id: r.id, enabled: v })} />
                      </div>
                      <div className="rounded-xl bg-slate-50 border border-slate-100 px-3 py-2">
                        <div className="text-[10px] font-bold text-slate-400 uppercase">Condition</div>
                        <div className="text-sm font-black text-slate-800">{conditionText(r)}</div>
                      </div>
                      {r.description && <p className="text-xs text-slate-500 line-clamp-2">{r.description}</p>}
                      <div className="flex items-center flex-wrap gap-2 text-[11px] text-slate-500">
                        <span className="px-2 py-0.5 rounded-full bg-slate-100 font-semibold">{scopeText(r)}</span>
                        <span className="px-2 py-0.5 rounded-full bg-slate-100 font-semibold">for {r.duration_seconds}s</span>
                        <span className="px-2 py-0.5 rounded-full bg-slate-100 font-semibold">cooldown {r.cooldown_seconds}s</span>
                      </div>
                      {(canEdit || canDelete) && (
                        <div className="flex items-center gap-2 pt-1 border-t border-slate-100 mt-auto">
                          {canEdit && <button onClick={() => openEdit(r)} className="flex-1 h-8 rounded-lg border border-slate-200 text-slate-600 text-xs font-bold hover:bg-slate-50 flex items-center justify-center gap-1.5"><Pencil size={13} /> Edit</button>}
                          {canDelete && <button onClick={() => { if (confirm(`Delete rule "${r.name}"?`)) delMut.mutate(r.id); }} className="h-8 px-3 rounded-lg border border-red-200 text-red-600 text-xs font-bold hover:bg-red-50 flex items-center justify-center"><Trash2 size={13} /></button>}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      <RuleModal
        open={modalOpen}
        initial={editing}
        defaultSection={modalSection}
        servers={servers}
        agents={agents}
        cloudAccounts={cloudList}
        saving={saveMut.isPending}
        onClose={() => setModalOpen(false)}
        onSave={(r) => saveMut.mutate(r)}
      />

    </div>
  );
};
