import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAgentsList } from '../../hooks/useAgents';
import { syncConnections, registerAgent } from '../../api/agents';
import { DBTypeBadge } from '../../components/ui/DBTypeBadge';
import { StatusPill } from '../../components/ui/StatusPill';
import { Spinner } from '@fluentui/react-components';
import {
  Server, CheckCircle, ShieldAlert, AlertTriangle, WifiOff,
  RefreshCw, Search, Globe, Activity, Timer,
  Database, ChevronRight, Plus, X, Info,
} from 'lucide-react';

// ─── helpers ─────────────────────────────────────────────────────────────────

const statusLevel = (s) => {
  const v = s?.toLowerCase();
  if (v === 'online' || v === 'healthy') return 'online';
  if (v === 'warning' || v === 'degraded') return 'warning';
  if (v === 'offline') return 'offline';
  if (v === 'error') return 'critical';
  return 'critical';
};

// Returns a human-readable status label + tooltip explanation
const statusInfo = (agent) => {
  const s = agent.status?.toLowerCase();
  if (s === 'online') return { label: 'Online', tip: 'Agent is collecting metrics', color: '#22c55e', bg: '#f0fdf4', border: '#bbf7d0' };
  if (s === 'error')  return { label: 'DB Error', tip: 'Collector cannot connect to the monitored database. Check credentials and network.', color: '#ef4444', bg: '#fef2f2', border: '#fecaca' };
  if (s === 'warning') return { label: 'Warning', tip: 'Metrics are collecting but thresholds exceeded', color: '#f59e0b', bg: '#fffbeb', border: '#fde68a' };
  // offline
  if (!agent.has_connection) return { label: 'Push Mode', tip: 'No DB connection linked. Agent starts collecting when an external script pushes data via POST /api/v1/agents/data.', color: '#8b5cf6', bg: '#f5f3ff', border: '#ddd6fe' };
  return { label: 'Waiting…', tip: `Linked to a DB connection — collector will attempt every ${agent.collection_interval_sec || 60}s. If it stays here, the database may be unreachable.`, color: '#0ea5e9', bg: '#f0f9ff', border: '#bae6fd' };
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

const getDbColor = (type) => DB_COLORS[type?.toLowerCase()] ?? '#64748b';

const cpuColor = (v) => {
  if (v == null || isNaN(v)) return '#22c55e';
  if (v >= 80) return '#ef4444';
  if (v >= 60) return '#f59e0b';
  return '#22c55e';
};

const VIEW_KEY = 'actmon_agents_view';

const getClusterBadge = (agent) => {
  const desc = (agent.description || '').toLowerCase();
  if (desc.includes('galera'))   return { label: 'GALERA',   cls: 'bg-violet-100 text-violet-700' };
  if (desc.includes('replica'))  return { label: 'REPLICA',  cls: 'bg-blue-100 text-blue-700' };
  if (desc.includes('cluster'))  return { label: 'CLUSTER',  cls: 'bg-teal-100 text-teal-700' };
  if (desc.includes('primary') || desc.includes('master'))
                                  return { label: 'PRIMARY',  cls: 'bg-amber-100 text-amber-700' };
  const t = agent.db_type?.toUpperCase() || 'DB';
  return { label: t, cls: 'bg-slate-100 text-slate-600' };
};

const computeUptime = (ts) => {
  if (!ts) return null;
  const secs = Math.max(0, Math.floor((Date.now() - new Date(ts)) / 1000));
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `up ${d} day${d !== 1 ? 's' : ''}, ${h} hour${h !== 1 ? 's' : ''}`;
  if (h > 0) return `up ${h} hour${h !== 1 ? 's' : ''}, ${m} minute${m !== 1 ? 's' : ''}`;
  return `up ${m} minute${m !== 1 ? 's' : ''}`;
};

// ─── RegisterAgentModal ──────────────────────────────────────────────────────

const DB_TYPES = ['MySQL', 'PostgreSQL', 'Oracle', 'MSSQL', 'MongoDB', 'ClickHouse'];
const OS_TYPES = ['Linux', 'Windows', 'macOS', 'Other'];
const ENVIRONMENTS = ['Production', 'Staging', 'Development', 'Testing'];

const FIELD_CLS = 'w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-indigo-400 placeholder-slate-400';
const LABEL_CLS = 'block text-xs font-bold text-slate-600 mb-1';

const RegisterAgentModal = ({ onClose, onSuccess }) => {
  const [form, setForm] = useState({
    agent_name: '',
    db_type: 'MySQL',
    hostname: '',
    ip_address: '',
    os_type: 'Linux',
    environment: 'Production',
    description: '',
    collection_interval_sec: 60,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const set = (field, value) => setForm(f => ({ ...f, [field]: value }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.agent_name.trim()) { setError('Agent name is required.'); return; }
    setSaving(true);
    setError(null);
    try {
      await registerAgent({
        ...form,
        agent_name: form.agent_name.trim(),
        hostname: form.hostname.trim() || undefined,
        ip_address: form.ip_address.trim() || undefined,
        description: form.description.trim() || undefined,
        collection_interval_sec: parseInt(form.collection_interval_sec, 10) || 60,
      });
      onSuccess();
      onClose();
    } catch (err) {
      const detail = err?.response?.data?.detail;
      setError(typeof detail === 'string' ? detail : (err?.message || 'Registration failed.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" />
      <div
        className="relative bg-white rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="px-6 py-5 flex items-center justify-between"
          style={{ background: 'linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%)' }}
        >
          <div>
            <h2 className="text-lg font-extrabold text-white tracking-tight">Register Agent</h2>
            <p className="text-indigo-200 text-xs mt-0.5">Add a new database agent to monitoring</p>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg bg-white/10 hover:bg-white/20 flex items-center justify-center text-white transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4 max-h-[70vh] overflow-y-auto">

          {/* Error banner */}
          {error && (
            <div className="px-3 py-2.5 rounded-xl bg-red-50 border border-red-200 text-red-700 text-xs flex items-start gap-2">
              <ShieldAlert size={13} className="mt-0.5 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Agent Name */}
          <div>
            <label className={LABEL_CLS}>
              Agent Name <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              required
              value={form.agent_name}
              onChange={e => set('agent_name', e.target.value)}
              placeholder="e.g. prod-mysql-01"
              className={FIELD_CLS}
              autoFocus
            />
            <p className="text-[11px] text-slate-400 mt-1">Unique identifier for this agent</p>
          </div>

          {/* DB Type + Environment */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={LABEL_CLS}>Database Engine</label>
              <select
                value={form.db_type}
                onChange={e => set('db_type', e.target.value)}
                className={FIELD_CLS}
              >
                {DB_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label className={LABEL_CLS}>Environment</label>
              <select
                value={form.environment}
                onChange={e => set('environment', e.target.value)}
                className={FIELD_CLS}
              >
                {ENVIRONMENTS.map(e => <option key={e} value={e}>{e}</option>)}
              </select>
            </div>
          </div>

          {/* Hostname + IP */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={LABEL_CLS}>Hostname</label>
              <input
                type="text"
                value={form.hostname}
                onChange={e => set('hostname', e.target.value)}
                placeholder="db.example.com"
                className={FIELD_CLS}
              />
            </div>
            <div>
              <label className={LABEL_CLS}>IP Address</label>
              <input
                type="text"
                value={form.ip_address}
                onChange={e => set('ip_address', e.target.value)}
                placeholder="192.168.1.10"
                className={FIELD_CLS}
              />
            </div>
          </div>

          {/* OS Type + Interval */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={LABEL_CLS}>Operating System</label>
              <select
                value={form.os_type}
                onChange={e => set('os_type', e.target.value)}
                className={FIELD_CLS}
              >
                {OS_TYPES.map(o => <option key={o} value={o}>{o}</option>)}
              </select>
            </div>
            <div>
              <label className={LABEL_CLS}>Collection Interval (sec)</label>
              <input
                type="number"
                min={10}
                max={3600}
                value={form.collection_interval_sec}
                onChange={e => set('collection_interval_sec', e.target.value)}
                className={FIELD_CLS}
              />
            </div>
          </div>

          {/* Description */}
          <div>
            <label className={LABEL_CLS}>Description</label>
            <input
              type="text"
              value={form.description}
              onChange={e => set('description', e.target.value)}
              placeholder="e.g. Primary MySQL replica cluster node"
              className={FIELD_CLS}
            />
          </div>

          {/* Info note */}
          <div className="flex items-start gap-2 px-3 py-2.5 rounded-xl bg-indigo-50 border border-indigo-100 text-[11px] text-indigo-700">
            <Info size={12} className="mt-0.5 flex-shrink-0" />
            <span>
              The agent will be registered as <strong>offline</strong> until it starts sending heartbeats via the collector script.
            </span>
          </div>
        </form>

        {/* Footer */}
        <div className="px-6 py-4 bg-slate-50 border-t border-slate-100 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm font-semibold text-slate-600 bg-white border border-slate-200 hover:bg-slate-100 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={saving || !form.agent_name.trim()}
            className="flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-bold text-white transition-all disabled:opacity-60 disabled:cursor-not-allowed hover:opacity-90 active:scale-95"
            style={{ background: 'linear-gradient(135deg, #4f46e5, #7c3aed)' }}
          >
            {saving ? <Spinner size="tiny" /> : <Plus size={15} />}
            {saving ? 'Registering…' : 'Register Agent'}
          </button>
        </div>
      </div>
    </div>
  );
};

// ─── AgentCard ───────────────────────────────────────────────────────────────

const AgentCard = ({ agent, onClick }) => {
  const navigate = useNavigate();

  const sl       = statusLevel(agent.status);
  const dbType   = agent.db_type?.toLowerCase() || '';
  const dbColor  = DB_COLORS[dbType] ?? '#64748b';
  const { label: clusterLabel, cls: clusterCls } = getClusterBadge(agent);

  const osOnline = sl !== 'offline';
  const dbRunning = sl === 'online';
  const dbWarn    = sl === 'warning';

  const topBorderColor =
    sl === 'online'   ? '#22c55e' :
    sl === 'warning'  ? '#f59e0b' :
    sl === 'offline'  ? '#94a3b8' : '#ef4444';

  const uptime = computeUptime(agent.created_at);
  const dbLabel = agent.db_type
    ? agent.db_type.charAt(0).toUpperCase() + agent.db_type.slice(1)
    : 'Unknown';

  return (
    <div
      className="bg-white rounded-2xl border border-slate-100 overflow-hidden cursor-pointer
                 hover:shadow-lg hover:-translate-y-1 transition-all duration-200 flex flex-col"
      style={{ borderTop: `4px solid ${topBorderColor}`, boxShadow: '0 2px 8px rgba(0,0,0,0.05)' }}
      onClick={() => onClick(agent)}
    >
      {/* ── Header row ─────────────────────────────────────────────────── */}
      <div className="px-5 pt-5 pb-3 flex items-center gap-2">
        {/* Cluster badge */}
        <span className={`px-2.5 py-1 rounded-lg text-xs font-extrabold tracking-widest ${clusterCls}`}>
          {clusterLabel}
        </span>

        <div className="flex-1" />

        {/* OS dot */}
        <div className="flex flex-col items-center gap-0.5">
          <div className={`w-2.5 h-2.5 rounded-full ${osOnline ? 'bg-green-500' : 'bg-slate-300'}`} />
          <span className="text-[9px] text-slate-400 font-semibold leading-none">OS</span>
        </div>

        {/* DB dot */}
        <div className="flex flex-col items-center gap-0.5">
          <div className={`w-2.5 h-2.5 rounded-full ${
            dbRunning ? 'bg-green-500' : dbWarn ? 'bg-amber-400' : 'bg-slate-300'
          }`} />
          <span className="text-[9px] text-slate-400 font-semibold leading-none">DB</span>
        </div>

        {/* SSH button */}
        <button
          className="ml-1 px-3 py-1.5 rounded-lg bg-slate-900 text-white text-xs font-mono
                     font-semibold hover:bg-slate-700 transition-colors select-none"
          onClick={(e) => e.stopPropagation()}
          title="SSH Terminal"
        >
          &gt;_ SSH
        </button>
      </div>

      {/* ── Agent name + IP ────────────────────────────────────────────── */}
      <div className="px-5 pb-3">
        <h3 className="text-2xl font-black text-slate-900 leading-tight truncate">
          {agent.name}
        </h3>
        <div className="flex items-center gap-2 mt-1 flex-wrap">
          <span className="text-sm text-slate-400">
            {agent.ip_address || agent.hostname || '—'}
          </span>
          {agent.os_type && (
            <span className="px-2 py-0.5 rounded text-xs bg-slate-100 text-slate-500 font-semibold">
              {agent.os_type}
            </span>
          )}
        </div>
      </div>

      {/* ── DB type pill ───────────────────────────────────────────────── */}
      <div className="px-5 pb-3">
        <span
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-bold"
          style={{
            backgroundColor: `${dbColor}14`,
            color: dbColor,
            border: `1.5px solid ${dbColor}35`,
          }}
        >
          <span
            className="w-2 h-2 rounded-full flex-shrink-0"
            style={{ backgroundColor: dbColor }}
          />
          {dbLabel}
        </span>
      </div>

      {/* ── Status pills ───────────────────────────────────────────────── */}
      <div className="px-5 pb-3 flex gap-2 flex-wrap">
        {/* Smart status badge */}
        {(() => {
          const si = statusInfo(agent);
          return (
            <span
              title={si.tip}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border cursor-help"
              style={{ borderColor: si.border, backgroundColor: si.bg, color: si.color }}
            >
              <Database className="h-3 w-3 flex-shrink-0" />
              {si.label}
            </span>
          );
        })()}

        {/* OS status */}
        <span
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border"
          style={
            osOnline
              ? { borderColor: '#bbf7d0', backgroundColor: '#f0fdf4', color: '#16a34a' }
              : { borderColor: '#e2e8f0', backgroundColor: '#f8fafc', color: '#94a3b8' }
          }
        >
          <Server className="h-3 w-3" />
          {osOnline ? 'OS Online' : 'OS Offline'}
        </span>
      </div>

      {/* ── Uptime / last seen ─────────────────────────────────────────── */}
      <div className="px-5 pb-4 flex-1 flex flex-col gap-1">
        <span className="inline-flex items-center gap-1.5 text-xs text-slate-400">
          <Timer className="h-3.5 w-3.5 flex-shrink-0" />
          {agent.last_heartbeat ? ago(agent.last_heartbeat) : 'Never collected'}
        </span>
        {!agent.has_connection && (
          <span className="text-[10px] text-violet-500 font-semibold flex items-center gap-1">
            <Info className="h-3 w-3 flex-shrink-0" />
            Push-only — needs collector script
          </span>
        )}
        {agent.has_connection && agent.status === 'offline' && (
          <span className="text-[10px] text-sky-500 font-semibold flex items-center gap-1">
            <Info className="h-3 w-3 flex-shrink-0" />
            Collection every {agent.collection_interval_sec || 60}s
          </span>
        )}
        {agent.status === 'error' && (
          <span className="text-[10px] text-red-500 font-semibold flex items-center gap-1">
            <Info className="h-3 w-3 flex-shrink-0" />
            Cannot reach database
          </span>
        )}
      </div>

      {/* ── Footer actions ─────────────────────────────────────────────── */}
      <div className="px-5 pb-5 flex items-center gap-2">
        <button
          onClick={(e) => { e.stopPropagation(); navigate(`/agents/${agent.name}`); }}
          className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl
                     bg-slate-900 text-white text-sm font-bold hover:bg-slate-800 transition-colors"
        >
          <Activity className="h-4 w-4" />
          Dashboard
        </button>
        <button
          onClick={(e) => e.stopPropagation()}
          className="p-2.5 rounded-xl border border-slate-200 text-slate-400
                     hover:text-slate-600 hover:border-slate-300 hover:bg-slate-50 transition-colors"
          title="Refresh"
        >
          <RefreshCw className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
};

// ─── AgentsList ───────────────────────────────────────────────────────────────

export const AgentsList = () => {
  const navigate = useNavigate();

  const {
    data: agents = [],
    isLoading,
    isError,
    refetch,
  } = useAgentsList(true);

  // Persist view preference
  const [view, setView] = useState(() => {
    try { return localStorage.getItem(VIEW_KEY) || 'grid'; } catch { return 'grid'; }
  });
  useEffect(() => {
    try { localStorage.setItem(VIEW_KEY, view); } catch {}
  }, [view]);

  // Search / sort / filters
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState('name');
  const [sortDir, setSortDir] = useState('asc');
  const [dbFilter, setDbFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [envFilter, setEnvFilter] = useState('all');
  const [statFilterCtrl, setStatFilterCtrl] = useState('all');

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

  // Register modal
  const [showRegisterModal, setShowRegisterModal] = useState(false);

  // Sync connections state
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState(null); // { type: 'success'|'error', text }

  const handleSync = async () => {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const res = await syncConnections();
      const c = res?.created?.length ?? 0;
      const s = res?.skipped?.length ?? 0;
      const text = c > 0
        ? `${c} agent${c !== 1 ? 's' : ''} created${s > 0 ? `, ${s} already existed` : ''}.`
        : s > 0
        ? `All ${s} connection${s !== 1 ? 's' : ''} already registered — nothing new to add.`
        : 'No connections found to sync.';
      setSyncMsg({ type: 'success', text });
      refetch();
    } catch (err) {
      const raw = err?.message || '';
      // Truncate raw DB errors — show a clean message instead
      const text = raw.length > 120 ? 'Sync failed. Check backend logs for details.' : (raw || 'Sync failed. Please try again.');
      setSyncMsg({ type: 'error', text });
    } finally {
      setSyncing(false);
      setTimeout(() => setSyncMsg(null), 6000);
    }
  };

  // Dynamic filter options from data
  const dbTypes = useMemo(() => {
    const s = new Set(agents.map((a) => a.db_type).filter(Boolean));
    return ['all', ...Array.from(s).sort()];
  }, [agents]);

  const envTypes = useMemo(() => {
    const s = new Set(agents.map((a) => a.environment).filter(Boolean));
    return ['all', ...Array.from(s).sort()];
  }, [agents]);

  // KPI counts
  const counts = useMemo(() => {
    const total = agents.length;
    const online = agents.filter((a) => statusLevel(a.status) === 'online').length;
    const offline = agents.filter((a) => statusLevel(a.status) === 'offline').length;
    const issues = agents.filter((a) => {
      const l = statusLevel(a.status);
      return l === 'warning' || l === 'critical';
    }).length;
    return { total, online, offline, issues };
  }, [agents]);

  // Handle stat-card click → set status filter
  const handleStatClick = (key) => {
    setStatFilterCtrl(key);
    if (key === 'all') { setStatusFilter('all'); return; }
    if (key === 'online') { setStatusFilter('online'); return; }
    if (key === 'offline') { setStatusFilter('offline'); return; }
    if (key === 'issues') { setStatusFilter('issues'); return; }
  };

  // Sort handler
  const handleSort = useCallback((key) => {
    setSortKey((k) => {
      if (k === key) { setSortDir((d) => (d === 'asc' ? 'desc' : 'asc')); return key; }
      setSortDir('asc'); return key;
    });
  }, []);

  // Filtered + sorted agents
  const filtered = useMemo(() => {
    let list = agents;

    // Search
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (a) =>
          a.name?.toLowerCase().includes(q) ||
          a.hostname?.toLowerCase().includes(q) ||
          a.ip_address?.includes(q) ||
          a.description?.toLowerCase().includes(q)
      );
    }

    // DB filter
    if (dbFilter !== 'all') {
      list = list.filter((a) => a.db_type?.toLowerCase() === dbFilter.toLowerCase());
    }

    // Status filter
    if (statusFilter === 'issues') {
      list = list.filter((a) => {
        const l = statusLevel(a.status);
        return l === 'warning' || l === 'critical';
      });
    } else if (statusFilter !== 'all') {
      list = list.filter((a) => statusLevel(a.status) === statusFilter);
    }

    // Env filter
    if (envFilter !== 'all') {
      list = list.filter((a) => a.environment?.toLowerCase() === envFilter.toLowerCase());
    }

    // Sort
    list = [...list].sort((a, b) => {
      let va = a[sortKey] ?? '';
      let vb = b[sortKey] ?? '';
      if (typeof va === 'number' && typeof vb === 'number') {
        return sortDir === 'asc' ? va - vb : vb - va;
      }
      va = String(va).toLowerCase();
      vb = String(vb).toLowerCase();
      if (va < vb) return sortDir === 'asc' ? -1 : 1;
      if (va > vb) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });

    return list;
  }, [agents, search, dbFilter, statusFilter, envFilter, sortKey, sortDir]);

  const handleNavigate = (agent) => navigate(`/agents/${agent.name}`);

  const SortIcon = ({ col }) => (
    <span className="ml-1 inline-block w-3 text-slate-400 text-xs">
      {sortKey === col ? (sortDir === 'asc' ? '↑' : '↓') : <span className="opacity-40">↕</span>}
    </span>
  );

  // ── Loading skeleton ──────────────────────────────────────────────────────
  if (isLoading && agents.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4">
        <Spinner size="large" />
        <p className="text-slate-500 text-sm font-medium">Loading monitored systems...</p>
      </div>
    );
  }

  return (
    <div className="space-y-5 pb-8">

      {/* ── REGISTER MODAL ──────────────────────────────────────────────────── */}
      {showRegisterModal && (
        <RegisterAgentModal
          onClose={() => setShowRegisterModal(false)}
          onSuccess={() => { refetch(); setCountdown(30); }}
        />
      )}

      {/* ── PAGE TITLE ──────────────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold text-slate-800 tracking-tight">Monitored Systems</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            All registered database agents &middot; {agents.length} total
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {/* Sync toast */}
          {syncMsg && (
            <span
              className="text-xs font-semibold px-3 py-1.5 rounded-lg animate-in fade-in duration-200"
              style={{
                backgroundColor: syncMsg.type === 'success' ? '#dcfce7' : '#fee2e2',
                color: syncMsg.type === 'success' ? '#166534' : '#991b1b',
                border: `1px solid ${syncMsg.type === 'success' ? '#bbf7d0' : '#fecaca'}`,
              }}
            >
              {syncMsg.text}
            </span>
          )}

          {/* Register Agent button */}
          <button
            onClick={() => setShowRegisterModal(true)}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold text-white transition-all hover:opacity-90 active:scale-95"
            style={{ background: 'linear-gradient(135deg, #0ea5e9, #2563eb)' }}
          >
            <Plus className="h-3.5 w-3.5" />
            Register Agent
          </button>

          {/* Sync button */}
          <button
            onClick={handleSync}
            disabled={syncing}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold text-white transition-all disabled:opacity-60 disabled:cursor-not-allowed hover:opacity-90 active:scale-95"
            style={{ background: 'linear-gradient(135deg, #6366f1, #4f46e5)' }}
          >
            {syncing ? (
              <Spinner size="tiny" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Sync Connections
          </button>

          {/* Refresh */}
          <button
            onClick={() => { refetch(); setCountdown(30); }}
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold text-slate-600 bg-white border border-slate-200 hover:bg-slate-50 transition-all"
            title="Refresh now"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            <span className="tabular-nums text-slate-400">{countdown}s</span>
          </button>
        </div>
      </div>

      {isError && (
        <div className="px-4 py-3 rounded-xl bg-red-50 border border-red-200 text-red-700 text-xs font-medium flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 flex-shrink-0" />
          Unable to reach the monitoring API. Check your backend connection.
        </div>
      )}

      {/* ── STAT SUMMARY CARDS ──────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          {
            key: 'all',
            label: 'Total Agents',
            value: counts.total,
            icon: <Server className="h-5 w-5 text-blue-600" />,
            iconBg: '#dbeafe',
            color: '#3b82f6',
          },
          {
            key: 'online',
            label: 'Online',
            value: counts.online,
            icon: <CheckCircle className="h-5 w-5 text-green-600" />,
            iconBg: '#dcfce7',
            color: '#22c55e',
          },
          {
            key: 'issues',
            label: 'Issues',
            value: counts.issues,
            icon: <AlertTriangle className="h-5 w-5 text-amber-600" />,
            iconBg: '#fef3c7',
            color: '#f59e0b',
          },
          {
            key: 'offline',
            label: 'Offline',
            value: counts.offline,
            icon: <WifiOff className="h-5 w-5 text-slate-500" />,
            iconBg: '#f1f5f9',
            color: '#94a3b8',
          },
        ].map(({ key, label, value, icon, iconBg, color }) => {
          const isActive = statFilterCtrl === key;
          return (
            <button
              key={key}
              onClick={() => handleStatClick(key)}
              className="bg-white rounded-xl border p-4 flex flex-col gap-3 text-left hover:shadow-md transition-all active:scale-[0.98]"
              style={{
                borderColor: isActive ? color : '#e2e8f0',
                boxShadow: isActive ? `0 0 0 2px ${color}30` : undefined,
              }}
            >
              <div
                className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
                style={{ backgroundColor: iconBg }}
              >
                {icon}
              </div>
              <div>
                <div className="text-2xl font-extrabold" style={{ color: isActive ? color : '#0f172a' }}>
                  {value}
                </div>
                <div className="text-xs font-semibold text-slate-500 mt-0.5">{label}</div>
              </div>
            </button>
          );
        })}
      </div>

      {/* ── CONTROLS BAR ──────────────────────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4 space-y-3">
        {/* Row 1: search + sort + view toggle */}
        <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-center">
          {/* Search */}
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400 pointer-events-none" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name, hostname, IP..."
              className="w-full pl-9 pr-4 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400 bg-slate-50 placeholder-slate-400"
            />
          </div>

          {/* Sort (only for list view) */}
          {view === 'list' && (
            <select
              value={`${sortKey}:${sortDir}`}
              onChange={(e) => {
                const [k, d] = e.target.value.split(':');
                setSortKey(k);
                setSortDir(d);
              }}
              className="text-xs border border-slate-200 rounded-lg px-3 py-2 bg-slate-50 focus:outline-none focus:ring-2 focus:ring-blue-400 text-slate-600 font-medium"
            >
              <option value="name:asc">Name A→Z</option>
              <option value="name:desc">Name Z→A</option>
              <option value="db_cpu:desc">CPU High→Low</option>
              <option value="db_cpu:asc">CPU Low→High</option>
              <option value="active_sessions:desc">Sessions High→Low</option>
              <option value="last_heartbeat:desc">Last Seen</option>
            </select>
          )}

          {/* View toggle */}
          <div className="flex border border-slate-200 rounded-lg overflow-hidden flex-shrink-0">
            <button
              onClick={() => setView('grid')}
              className="px-4 py-2 text-xs font-semibold transition-all flex items-center gap-1.5"
              style={
                view === 'grid'
                  ? { backgroundColor: '#1e293b', color: '#fff' }
                  : { backgroundColor: '#fff', color: '#64748b' }
              }
            >
              <svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 16 16">
                <rect x="0" y="0" width="7" height="7" rx="1" />
                <rect x="9" y="0" width="7" height="7" rx="1" />
                <rect x="0" y="9" width="7" height="7" rx="1" />
                <rect x="9" y="9" width="7" height="7" rx="1" />
              </svg>
              Grid
            </button>
            <button
              onClick={() => setView('list')}
              className="px-4 py-2 text-xs font-semibold transition-all flex items-center gap-1.5"
              style={
                view === 'list'
                  ? { backgroundColor: '#1e293b', color: '#fff' }
                  : { backgroundColor: '#fff', color: '#64748b' }
              }
            >
              <svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 16 16">
                <rect x="0" y="1" width="16" height="2" rx="1" />
                <rect x="0" y="7" width="16" height="2" rx="1" />
                <rect x="0" y="13" width="16" height="2" rx="1" />
              </svg>
              List
            </button>
          </div>
        </div>

        {/* Row 2: filter pills */}
        <div className="flex flex-wrap gap-2 items-center">
          {/* DB type pills */}
          <div className="flex flex-wrap gap-1.5 items-center">
            <span className="text-xs text-slate-400 font-semibold mr-0.5">Engine:</span>
            {dbTypes.map((t) => {
              const color = t === 'all' ? '#64748b' : getDbColor(t);
              const isActive = dbFilter === t;
              return (
                <button
                  key={t}
                  onClick={() => setDbFilter(t)}
                  className="px-2.5 py-0.5 rounded-full text-xs font-semibold transition-all capitalize"
                  style={
                    isActive
                      ? { backgroundColor: color, color: '#fff', border: `1px solid ${color}` }
                      : { backgroundColor: `${color}12`, color: '#475569', border: `1px solid ${color}30` }
                  }
                >
                  {t === 'all' ? 'All' : t}
                </button>
              );
            })}
          </div>

          <div className="w-px h-4 bg-slate-200 mx-1" />

          {/* Status pills */}
          <div className="flex flex-wrap gap-1.5 items-center">
            <span className="text-xs text-slate-400 font-semibold mr-0.5">Status:</span>
            {[
              { key: 'all', label: 'All', color: '#64748b' },
              { key: 'online', label: 'Online', color: '#22c55e' },
              { key: 'warning', label: 'Warning', color: '#f59e0b' },
              { key: 'critical', label: 'Critical', color: '#ef4444' },
              { key: 'offline', label: 'Offline', color: '#94a3b8' },
            ].map(({ key, label, color }) => {
              const isActive = statusFilter === key;
              return (
                <button
                  key={key}
                  onClick={() => setStatusFilter(key)}
                  className="px-2.5 py-0.5 rounded-full text-xs font-semibold transition-all"
                  style={
                    isActive
                      ? { backgroundColor: color, color: '#fff', border: `1px solid ${color}` }
                      : { backgroundColor: `${color}12`, color: '#475569', border: `1px solid ${color}30` }
                  }
                >
                  {label}
                </button>
              );
            })}
          </div>

          <div className="w-px h-4 bg-slate-200 mx-1" />

          {/* Env pills */}
          <div className="flex flex-wrap gap-1.5 items-center">
            <span className="text-xs text-slate-400 font-semibold mr-0.5">Env:</span>
            {envTypes.map((e) => {
              const isActive = envFilter === e;
              return (
                <button
                  key={e}
                  onClick={() => setEnvFilter(e)}
                  className="px-2.5 py-0.5 rounded-full text-xs font-semibold transition-all capitalize"
                  style={
                    isActive
                      ? { backgroundColor: '#1e293b', color: '#fff', border: '1px solid #1e293b' }
                      : { backgroundColor: '#f8fafc', color: '#475569', border: '1px solid #e2e8f0' }
                  }
                >
                  {e === 'all' ? 'All' : e}
                </button>
              );
            })}
          </div>

          {/* Result count */}
          <span className="ml-auto text-xs text-slate-400 font-medium">
            {filtered.length} of {agents.length} agents
          </span>
        </div>
      </div>

      {/* ── GRID VIEW ─────────────────────────────────────────────────────────── */}
      {view === 'grid' && (
        <>
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <div className="w-16 h-16 rounded-2xl bg-slate-100 flex items-center justify-center mb-4">
                <Server className="h-8 w-8 text-slate-300" />
              </div>
              <p className="text-lg font-bold text-slate-600">
                {agents.length === 0 ? 'No agents registered' : 'No agents match filters'}
              </p>
              <p className="text-sm text-slate-400 mt-1 max-w-sm">
                {agents.length === 0
                  ? 'Register a database agent to start monitoring.'
                  : 'Try adjusting your search or filter criteria.'}
              </p>
              {agents.length === 0 && (
                <button
                  onClick={() => setShowRegisterModal(true)}
                  className="mt-5 flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-bold text-white transition-all hover:opacity-90 active:scale-95"
                  style={{ background: 'linear-gradient(135deg, #0ea5e9, #2563eb)' }}
                >
                  <Plus className="h-4 w-4" />
                  Register Your First Agent
                </button>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-5">
              {filtered.map((agent) => (
                <AgentCard key={agent.name} agent={agent} onClick={handleNavigate} />
              ))}
            </div>
          )}
        </>
      )}

      {/* ── LIST VIEW ─────────────────────────────────────────────────────────── */}
      {view === 'list' && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200">
                  {[
                    { key: 'name', label: 'Agent / Host', w: '' },
                    { key: 'db_type', label: 'Engine', w: 'w-28' },
                    { key: 'environment', label: 'Environment', w: 'w-28' },
                    { key: 'status', label: 'Status', w: 'w-24' },
                    { key: 'db_cpu', label: 'DB CPU', w: 'w-32' },
                    { key: 'memory_usage', label: 'RAM', w: 'w-32' },
                    { key: 'active_sessions', label: 'Sessions', w: 'w-20' },
                    { key: 'last_heartbeat', label: 'Last Seen', w: 'w-28' },
                  ].map(({ key, label, w }) => (
                    <th
                      key={key}
                      onClick={() => handleSort(key)}
                      className={`text-left px-4 py-3 font-bold text-slate-500 cursor-pointer hover:text-slate-700 select-none whitespace-nowrap ${w}`}
                    >
                      {label}
                      <SortIcon col={key} />
                    </th>
                  ))}
                  <th className="w-8 px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="text-center py-16 text-slate-400">
                      <Server className="h-10 w-10 mx-auto mb-3 text-slate-200" />
                      <p className="font-semibold">No agents match your filters.</p>
                    </td>
                  </tr>
                ) : (
                  filtered.map((agent) => {
                    const level = statusLevel(agent.status);
                    const statusColor = STATUS_COLORS[level];
                    const cpu = Number(agent.db_cpu) || 0;
                    const mem = Number(agent.memory_usage) || 0;

                    return (
                      <tr
                        key={agent.name}
                        onClick={() => handleNavigate(agent)}
                        className="border-b border-slate-50 hover:bg-blue-50/30 cursor-pointer transition-colors group"
                        style={{ borderLeft: `4px solid ${statusColor}` }}
                      >
                        {/* Agent + Host */}
                        <td className="px-4 py-3">
                          <div className="font-bold text-slate-800 group-hover:text-blue-600 transition-colors leading-tight">
                            {agent.name}
                          </div>
                          <div className="text-slate-400 flex items-center gap-1 mt-0.5">
                            <Globe className="h-3 w-3 flex-shrink-0" />
                            <span className="truncate max-w-[180px]">
                              {agent.hostname || agent.ip_address || '—'}
                            </span>
                          </div>
                        </td>

                        {/* Engine */}
                        <td className="px-4 py-3">
                          <DBTypeBadge type={agent.db_type} />
                        </td>

                        {/* Environment */}
                        <td className="px-4 py-3">
                          <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 font-semibold text-xs">
                            {agent.environment || '—'}
                          </span>
                        </td>

                        {/* Status */}
                        <td className="px-4 py-3">
                          {(() => {
                            const si = statusInfo(agent);
                            return (
                              <span
                                title={si.tip}
                                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold border cursor-help whitespace-nowrap"
                                style={{ borderColor: si.border, backgroundColor: si.bg, color: si.color }}
                              >
                                <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: si.color }} />
                                {si.label}
                              </span>
                            );
                          })()}
                        </td>

                        {/* DB CPU bar */}
                        <td className="px-4 py-3">
                          <div className="flex flex-col gap-1">
                            <div className="h-1.5 w-full bg-slate-100 rounded-full overflow-hidden">
                              <div
                                className="h-full rounded-full transition-all"
                                style={{
                                  width: `${Math.min(cpu, 100)}%`,
                                  backgroundColor: cpuColor(cpu),
                                }}
                              />
                            </div>
                            <span className="text-xs font-bold" style={{ color: cpuColor(cpu) }}>
                              {cpu.toFixed(1)}%
                            </span>
                          </div>
                        </td>

                        {/* RAM bar */}
                        <td className="px-4 py-3">
                          <div className="flex flex-col gap-1">
                            <div className="h-1.5 w-full bg-slate-100 rounded-full overflow-hidden">
                              <div
                                className="h-full rounded-full transition-all"
                                style={{
                                  width: `${Math.min(mem, 100)}%`,
                                  backgroundColor: cpuColor(mem),
                                }}
                              />
                            </div>
                            <span className="text-xs font-bold" style={{ color: cpuColor(mem) }}>
                              {mem.toFixed(1)}%
                            </span>
                          </div>
                        </td>

                        {/* Sessions */}
                        <td className="px-4 py-3 font-bold text-slate-700">
                          {(agent.active_sessions ?? 0).toLocaleString()}
                        </td>

                        {/* Last seen */}
                        <td className="px-4 py-3 text-slate-400 whitespace-nowrap">
                          {ago(agent.last_heartbeat)}
                        </td>

                        {/* Arrow */}
                        <td className="px-4 py-3">
                          <ChevronRight className="h-4 w-4 text-slate-300 group-hover:text-blue-500 transition-colors" />
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* Table footer */}
          <div className="px-4 py-3 bg-slate-50 border-t border-slate-100 flex flex-wrap items-center gap-3 text-xs text-slate-500">
            <span className="font-semibold text-slate-700">{filtered.length} agents</span>
            <span>&middot;</span>
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-green-500 inline-block" />
              {counts.online} online
            </span>
            <span>&middot;</span>
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-amber-500 inline-block" />
              {counts.issues} issues
            </span>
            <span>&middot;</span>
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-slate-400 inline-block" />
              {counts.offline} offline
            </span>
          </div>
        </div>
      )}
    </div>
  );
};
