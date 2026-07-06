import React, { useState, useEffect, useRef } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Database, Server, Activity, HardDrive, RefreshCw, Clock,
  Layers, Network, ShieldCheck, AlertTriangle, Cpu, MemoryStick,
  FileText, Zap, Terminal, GitBranch, Archive, RotateCcw,
  CheckCircle2, XCircle, ChevronRight, Heart, Users, Lock,
  TrendingUp, BarChart2, Table, Settings, Bell, ArrowUp,
  ArrowDown, Minus, Search, Filter, Brain, Lightbulb, Star,
  ChevronDown, ChevronUp, Code2, FolderOpen, Key, Link as LinkIcon,
  Copy, Wifi, WifiOff, Loader2, Package, List, Inbox,
  Eye, X, Hash, Type, ToggleLeft, Calendar, Braces, Info,
} from 'lucide-react';
import {
  ResponsiveContainer, PieChart, Pie, Cell, Tooltip, Legend,
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  LineChart, Line, AreaChart, Area,
} from 'recharts';
import client from '../../api/client';
import HostResources from '../postgresql/PgHostResources';

/* ─── MongoDB palette ─── */
const C = {
  green:    '#00ED64',   // MongoDB brand green
  darkGreen:'#00684A',
  navy:     '#001E2B',   // MongoDB dark navy
  emerald:  '#00C851',
  teal:     '#14B8A6',
  blue:     '#3B82F6',
  orange:   '#F97316',
  red:      '#EF4444',
  yellow:   '#EAB308',
  purple:   '#8B5CF6',
  slate:    '#64748B',
  cyan:     '#06B6D4',
};

/* ─── fetchers ─── */
const fetchDashboard    = (id) => client.get(`/connections/mongodb/${id}/mongo-dashboard`).then(r => r.data);
const fetchOps          = (id) => client.get(`/connections/mongodb/${id}/mongo-ops`).then(r => r.data);
const fetchProfiler     = (id) => client.get(`/connections/mongodb/${id}/mongo-profiler`).then(r => r.data);
const fetchSlowOps      = (id) => client.get(`/connections/mongodb/${id}/mongo-slow-operations`).then(r => r.data);
const fetchCollections  = (id) => client.get(`/connections/mongodb/${id}/mongo-collections`).then(r => r.data);
const fetchIndexes      = (id) => client.get(`/connections/mongodb/${id}/mongo-indexes`).then(r => r.data);
const fetchReplication  = (id) => client.get(`/connections/mongodb/${id}/mongo-replication`).then(r => r.data);
const fetchOplog        = (id) => client.get(`/connections/mongodb/${id}/mongo-oplog`).then(r => r.data);
const fetchSharding     = (id) => client.get(`/connections/mongodb/${id}/mongo-sharding`).then(r => r.data);
const fetchTransactions = (id) => client.get(`/connections/mongodb/${id}/mongo-transactions`).then(r => r.data);
const fetchWiredTiger   = (id) => client.get(`/connections/mongodb/${id}/mongo-wiredtiger`).then(r => r.data);
const fetchUsers        = (id) => client.get(`/connections/mongodb/${id}/mongo-users`).then(r => r.data);
const fetchErrorLogs    = (id) => client.get(`/connections/mongodb/${id}/mongo-error-logs`).then(r => r.data);
const fetchCollAnalysis = (id) => client.get(`/connections/mongodb/${id}/mongo-collection-analysis`).then(r => r.data);

const TABS = [
  { id: 'overview',     label: 'Overview',       icon: Activity },
  { id: 'operations',   label: 'Operations',      icon: Zap },
  { id: 'profiler',     label: 'Profiler',        icon: Terminal },
  { id: 'collections',  label: 'Collections',     icon: Layers },
  { id: 'indexes',      label: 'Indexes',         icon: Key },
  { id: 'replication',  label: 'Replication',     icon: GitBranch },
  { id: 'oplog',        label: 'Oplog',           icon: Archive },
  { id: 'sharding',     label: 'Sharding',        icon: Network },
  { id: 'transactions', label: 'Transactions',    icon: RotateCcw },
  { id: 'wiredtiger',   label: 'WiredTiger',      icon: Cpu },
  { id: 'users',        label: 'Users',           icon: Users },
  { id: 'slowqueries',  label: 'Slow Queries',    icon: Clock },
  { id: 'errorlogs',    label: 'Error Logs',      icon: FileText },
];

const REFRESH_INTERVAL = 15;

/* ─── helpers ─── */
function fmtBytes(bytes) {
  if (!bytes) return '0 B';
  const b = Number(bytes);
  if (b >= 1073741824) return `${(b / 1073741824).toFixed(2)} GB`;
  if (b >= 1048576)    return `${(b / 1048576).toFixed(2)} MB`;
  if (b >= 1024)       return `${(b / 1024).toFixed(2)} KB`;
  return `${b} B`;
}
function fmtNum(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(v);
}
function fmtUptime(seconds) {
  if (!seconds) return '—';
  const s = Number(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(' ');
}
function computeHealthScore(connPct, cacheHitPct, slowOpsCount, replState) {
  let score = 100;
  if (connPct > 90)   score -= 30;
  else if (connPct > 70) score -= 15;
  if (cacheHitPct < 70 && cacheHitPct > 0) score -= 20;
  else if (cacheHitPct < 85 && cacheHitPct > 0) score -= 10;
  if (slowOpsCount > 5)  score -= 15;
  else if (slowOpsCount > 0) score -= 5;
  if (replState === 'STANDALONE') { /* no penalty */ }
  else if (replState !== 'PRIMARY' && replState !== 'SECONDARY') score -= 20;
  return Math.max(0, score);
}

/* ─── sub-components ─── */
function KpiCard({ icon: Icon, title, value, accent }) {
  const accMap = {
    green:   'border-l-green-500',
    emerald: 'border-l-emerald-500',
    teal:    'border-l-teal-500',
    blue:    'border-l-blue-500',
    orange:  'border-l-orange-500',
    red:     'border-l-red-500',
    purple:  'border-l-purple-500',
    cyan:    'border-l-cyan-500',
    yellow:  'border-l-yellow-500',
    slate:   'border-l-slate-400',
  };
  return (
    <div className={`bg-white rounded-xl border border-slate-200 border-l-4 ${accMap[accent] || accMap.slate} p-4 hover:shadow-md transition-all`}>
      <div className="flex justify-between items-start">
        <div>
          <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wide">{title}</p>
          <p className="text-lg font-black text-slate-800 mt-1 truncate max-w-[120px]">{value ?? 'N/A'}</p>
        </div>
        <Icon size={20} className="text-slate-300 mt-0.5 flex-shrink-0" />
      </div>
    </div>
  );
}

function GaugeCard({ title, pct, sub, centerLabel, centerUnit = '%', colorFn }) {
  const safePct = Math.max(0, Math.min(100, Number(pct) || 0));
  const fill = colorFn ? colorFn(safePct) : (safePct > 80 ? C.red : safePct > 60 ? C.orange : C.green);
  const displayCenter = centerLabel !== undefined ? centerLabel : safePct;
  const displayUnit   = centerLabel !== undefined ? centerUnit : '%';
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-4 flex flex-col items-center">
      <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1 text-center">{title}</p>
      <div className="relative flex flex-col items-center">
        <PieChart width={150} height={90}>
          <Pie
            data={[{ v: safePct }, { v: 100 - safePct }]}
            cx={75} cy={86}
            startAngle={180} endAngle={0}
            innerRadius={50} outerRadius={68}
            dataKey="v" stroke="none"
          >
            <Cell fill={fill} />
            <Cell fill="#e2e8f0" />
          </Pie>
        </PieChart>
        <div style={{ marginTop: '-38px' }} className="text-center pointer-events-none">
          <p className="text-xl font-black text-slate-900 leading-none">{displayCenter}</p>
          <p className="text-[10px] text-slate-400 mt-0.5">{displayUnit}</p>
        </div>
      </div>
      <p className="text-[10px] text-slate-400 mt-2 text-center leading-tight">{sub}</p>
    </div>
  );
}

function TrendCard({ title, data, color, unit = '', fmtVal }) {
  const fmt    = fmtVal || (v => `${v}${unit}`);
  const latest = data[data.length - 1]?.v;
  const gradId = `tg-${title.replace(/\s+/g, '')}`;
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-4">
      <div className="flex justify-between items-center mb-2">
        <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">{title}</p>
        <span className="text-base font-black" style={{ color }}>{fmt(latest ?? 0)}</span>
      </div>
      <ResponsiveContainer width="100%" height={68}>
        <AreaChart data={data}>
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor={color} stopOpacity={0.3} />
              <stop offset="95%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis dataKey="t" hide />
          <YAxis hide domain={['auto', 'auto']} />
          <Tooltip contentStyle={{ fontSize: 9, padding: '2px 8px' }}
            formatter={v => fmt(v)} labelFormatter={() => ''} />
          <Area type="monotone" dataKey="v" stroke={color} fill={`url(#${gradId})`}
            strokeWidth={2} dot={false} />
        </AreaChart>
      </ResponsiveContainer>
      <div className="flex justify-between text-[9px] text-slate-300 mt-1">
        <span>{fmt(data[0]?.v ?? 0)}</span>
        <span className="text-slate-400">{data.length} samples · 15s interval</span>
      </div>
    </div>
  );
}

function Panel({ title, children, action }) {
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5">
      {title && (
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-bold text-slate-800 text-sm">{title}</h3>
          {action}
        </div>
      )}
      {children}
    </div>
  );
}

function ChartCard({ title, children }) {
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5">
      <h3 className="font-bold text-slate-700 text-sm mb-4">{title}</h3>
      {children}
    </div>
  );
}

function Row({ label, value, mono }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5 border-b border-slate-100 last:border-0">
      <span className="text-slate-500 text-xs flex-shrink-0">{label}</span>
      <span className={`text-right font-semibold text-slate-800 text-xs ${mono ? 'font-mono' : ''} break-all`}>{value ?? '—'}</span>
    </div>
  );
}

function MetricKpi({ title, value, accent }) {
  const accMap = {
    green:   'bg-green-50 border-green-200 text-green-700',
    emerald: 'bg-emerald-50 border-emerald-200 text-emerald-700',
    red:     'bg-red-50 border-red-200 text-red-700',
    orange:  'bg-orange-50 border-orange-200 text-orange-700',
    blue:    'bg-blue-50 border-blue-200 text-blue-700',
    purple:  'bg-purple-50 border-purple-200 text-purple-700',
    yellow:  'bg-yellow-50 border-yellow-200 text-yellow-700',
    slate:   'bg-slate-50 border-slate-200 text-slate-700',
    teal:    'bg-teal-50 border-teal-200 text-teal-700',
  };
  return (
    <div className={`rounded-xl border p-4 ${accMap[accent] || accMap.slate}`}>
      <p className="text-[10px] font-bold uppercase tracking-wide opacity-70">{title}</p>
      <p className="text-2xl font-black mt-1">{value ?? '—'}</p>
    </div>
  );
}

function HealthBadge({ score }) {
  const color = score >= 80 ? 'bg-green-500' : score >= 60 ? 'bg-yellow-400' : 'bg-red-500';
  return (
    <div className={`flex items-center gap-2 px-3 py-1.5 rounded-xl ${color} text-white text-xs font-black shadow`}>
      <Heart size={12} className="animate-pulse" />
      Health {score}
    </div>
  );
}

function ReplicaStateBadge({ state }) {
  const map = {
    PRIMARY:   'bg-green-100 text-green-700 border-green-200',
    SECONDARY: 'bg-blue-100 text-blue-700 border-blue-200',
    ARBITER:   'bg-yellow-100 text-yellow-700 border-yellow-200',
    DOWN:      'bg-red-100 text-red-700 border-red-200',
    RECOVERING:'bg-orange-100 text-orange-700 border-orange-200',
    UNKNOWN:   'bg-slate-100 text-slate-600 border-slate-200',
    STANDALONE:'bg-slate-100 text-slate-600 border-slate-200',
  };
  const cls = map[state] || map.UNKNOWN;
  return (
    <span className={`px-2 py-0.5 rounded-full border text-[10px] font-bold ${cls}`}>{state || '—'}</span>
  );
}

function TabLoader() {
  return (
    <div className="flex items-center justify-center py-20">
      <div className="w-8 h-8 border-4 border-green-200 border-t-green-600 rounded-full animate-spin" />
    </div>
  );
}

function EmptyState({ icon: Icon = Inbox, message = 'No data available', sub = '' }) {
  return (
    <div className="py-16 flex flex-col items-center text-center">
      <Icon size={40} className="text-slate-200 mb-3" />
      <p className="font-semibold text-slate-500">{message}</p>
      {sub && <p className="text-xs text-slate-400 mt-1">{sub}</p>}
    </div>
  );
}

/* ─── Copy-to-clipboard helper ─── */
function CopyBtn({ text, size = 11 }) {
  const [copied, setCopied] = React.useState(false);
  return (
    <button
      onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
      className="flex-shrink-0 p-1 rounded hover:bg-white/20 transition-colors"
      title="Copy">
      {copied ? <CheckCircle2 size={size} className="text-green-400" /> : <Copy size={size} className="text-slate-400" />}
    </button>
  );
}

/* ─── Slide-over detail modal ─── */
function DetailModal({ title, subtitle, onClose, children }) {
  React.useEffect(() => {
    const h = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex" style={{ backdropFilter: 'blur(2px)', background: 'rgba(0,0,0,0.45)' }}
      onClick={onClose}>
      <div className="ml-auto h-full flex flex-col bg-white shadow-2xl overflow-hidden"
        style={{ width: 'min(720px, 96vw)' }}
        onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div style={{ background: `linear-gradient(135deg, #001E2B 0%, #0a2d1f 100%)` }}
          className="px-6 py-4 text-white flex items-start justify-between flex-shrink-0">
          <div className="min-w-0">
            <h2 className="text-lg font-black truncate">{title}</h2>
            {subtitle && <p className="text-xs mt-0.5" style={{ color: '#00ED64' }}>{subtitle}</p>}
          </div>
          <button onClick={onClose} className="ml-4 p-1.5 rounded-lg hover:bg-white/10 flex-shrink-0">
            <X size={18} />
          </button>
        </div>
        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 bg-slate-50">
          {children}
        </div>
      </div>
    </div>
  );
}

/* ─── BSON type icon ─── */
function TypeBadge({ type }) {
  const map = {
    string:  { label: 'str',    cls: 'bg-blue-50 text-blue-700 border-blue-200' },
    int:     { label: 'int',    cls: 'bg-green-50 text-green-700 border-green-200' },
    double:  { label: 'dbl',    cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
    boolean: { label: 'bool',   cls: 'bg-yellow-50 text-yellow-700 border-yellow-200' },
    date:    { label: 'date',   cls: 'bg-purple-50 text-purple-700 border-purple-200' },
    array:   { label: '[ ]',    cls: 'bg-orange-50 text-orange-700 border-orange-200' },
    object:  { label: '{ }',    cls: 'bg-teal-50 text-teal-700 border-teal-200' },
    null:    { label: 'null',   cls: 'bg-slate-50 text-slate-400 border-slate-200' },
    binData: { label: 'bin',    cls: 'bg-red-50 text-red-600 border-red-200' },
  };
  const cfg = map[type] || { label: type, cls: 'bg-slate-50 text-slate-500 border-slate-200' };
  return (
    <span className={`px-1.5 py-0.5 text-[9px] font-bold rounded border font-mono ${cfg.cls}`}>{cfg.label}</span>
  );
}

/* ─── Collection Detail Modal content ─── */
function CollectionDetailPanel({ connId, dbName, collName, onViewSlowOps }) {
  const [activeSection, setActiveSection] = React.useState('schema');
  const { data, isLoading, isError } = useQuery({
    queryKey: ['mongoCollDetail', connId, dbName, collName],
    queryFn: () => client.get(`/connections/mongodb/${connId}/mongo-collection-detail/${dbName}/${collName}`).then(r => r.data),
    staleTime: 30000,
  });

  if (isLoading) return (
    <div className="flex items-center justify-center py-20">
      <div className="w-8 h-8 border-4 border-green-200 border-t-green-600 rounded-full animate-spin" />
    </div>
  );
  if (isError || !data) return (
    <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-red-700 text-sm">Failed to load collection details.</div>
  );

  const { stats = {}, indexes = [], schema_fields = {}, sample_count = 0 } = data;
  const sections = [
    { id: 'schema',  label: `Schema (${Object.keys(schema_fields).length} fields)` },
    { id: 'indexes', label: `Indexes (${indexes.length})` },
    { id: 'stats',   label: 'Stats' },
  ];

  return (
    <div className="space-y-4">
      {/* Quick stats strip */}
      <div className="grid grid-cols-4 gap-3">
        {[
          { label: 'Documents',   value: fmtNum(stats.count || 0),                color: 'text-green-700',   bg: 'bg-green-50 border-green-200' },
          { label: 'Data Size',   value: `${stats.size_mb ?? 0} MB`,              color: 'text-blue-700',    bg: 'bg-blue-50 border-blue-200' },
          { label: 'Storage',     value: `${stats.storage_size_mb ?? 0} MB`,      color: 'text-purple-700',  bg: 'bg-purple-50 border-purple-200' },
          { label: 'Avg Doc Size',value: `${fmtNum(stats.avgObjSize || 0)} B`,    color: 'text-orange-700',  bg: 'bg-orange-50 border-orange-200' },
        ].map(s => (
          <div key={s.label} className={`rounded-xl border p-3 ${s.bg}`}>
            <p className="text-[9px] font-bold uppercase tracking-wide opacity-60">{s.label}</p>
            <p className={`text-lg font-black mt-0.5 ${s.color}`}>{s.value}</p>
          </div>
        ))}
      </div>

      {/* Action strip */}
      <div className="flex items-center gap-2">
        <button onClick={onViewSlowOps}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-50 border border-amber-200 text-amber-700 rounded-xl text-xs font-bold hover:bg-amber-100">
          <Clock size={12} /> View Slow Ops
        </button>
        {stats.capped && (
          <span className="px-2 py-1 bg-yellow-100 border border-yellow-200 text-yellow-700 rounded-xl text-xs font-bold">Capped Collection</span>
        )}
        <span className="ml-auto text-[10px] text-slate-400">Sampled {sample_count} docs</span>
      </div>

      {/* Section tabs */}
      <div className="flex border-b border-slate-200">
        {sections.map(s => (
          <button key={s.id} onClick={() => setActiveSection(s.id)}
            className={`px-4 py-2 text-xs font-bold border-b-2 transition-all ${
              activeSection === s.id
                ? 'border-green-500 text-green-700'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}>
            {s.label}
          </button>
        ))}
      </div>

      {/* ── SCHEMA ── */}
      {activeSection === 'schema' && (
        <div className="space-y-1">
          {Object.keys(schema_fields).length === 0 ? (
            <p className="text-sm text-slate-400 text-center py-8">No schema data (collection might be empty)</p>
          ) : (
            <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
              <div className="bg-slate-50 px-4 py-2 grid grid-cols-12 gap-2 border-b border-slate-200">
                <span className="col-span-5 text-[10px] font-bold text-slate-400 uppercase">Field Path</span>
                <span className="col-span-2 text-[10px] font-bold text-slate-400 uppercase">Type</span>
                <span className="col-span-3 text-[10px] font-bold text-slate-400 uppercase">Presence</span>
                <span className="col-span-2 text-[10px] font-bold text-slate-400 uppercase">Nullable</span>
              </div>
              <div className="divide-y divide-slate-100 max-h-96 overflow-y-auto">
                {Object.entries(schema_fields).map(([field, info]) => {
                  const pct = Math.round((info.count / Math.max(sample_count, 1)) * 100);
                  const dominantType = Object.entries(info.types || {}).sort((a, b) => b[1] - a[1])[0]?.[0] || info.type;
                  return (
                    <div key={field} className="px-4 py-2 grid grid-cols-12 gap-2 items-center hover:bg-slate-50 text-xs">
                      <span className="col-span-5 font-mono text-slate-700 truncate" title={field}>
                        {field.startsWith('_') ? <span className="text-purple-500">{field}</span> : field}
                      </span>
                      <span className="col-span-2"><TypeBadge type={dominantType} /></span>
                      <div className="col-span-3 flex items-center gap-2">
                        <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                          <div className="h-full rounded-full bg-green-400" style={{ width: `${pct}%` }} />
                        </div>
                        <span className="text-[10px] text-slate-400 w-7 text-right">{pct}%</span>
                      </div>
                      <span className="col-span-2">
                        {pct < 100
                          ? <span className="text-[9px] font-bold text-orange-500 bg-orange-50 border border-orange-200 px-1.5 py-0.5 rounded">nullable</span>
                          : <span className="text-[9px] text-slate-300">—</span>}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── INDEXES ── */}
      {activeSection === 'indexes' && (
        <div className="space-y-3">
          {indexes.length === 0 ? (
            <p className="text-sm text-slate-400 text-center py-8">No indexes found</p>
          ) : indexes.map((idx, i) => (
            <div key={i} className={`bg-white rounded-xl border p-4 ${idx.unique ? 'border-green-200' : 'border-slate-200'}`}>
              <div className="flex items-start justify-between gap-3 mb-2">
                <div>
                  <span className="font-bold text-sm text-slate-800">{idx.name}</span>
                  <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                    {idx.unique && <span className="px-1.5 py-0.5 bg-green-100 text-green-700 border border-green-200 text-[9px] font-bold rounded">UNIQUE</span>}
                    {idx.sparse && <span className="px-1.5 py-0.5 bg-blue-100 text-blue-700 border border-blue-200 text-[9px] font-bold rounded">SPARSE</span>}
                    {idx.expireAfterSeconds != null && <span className="px-1.5 py-0.5 bg-purple-100 text-purple-700 border border-purple-200 text-[9px] font-bold rounded">TTL {idx.expireAfterSeconds}s</span>}
                    {idx.partialFilterExpression && <span className="px-1.5 py-0.5 bg-teal-100 text-teal-700 border border-teal-200 text-[9px] font-bold rounded">PARTIAL</span>}
                  </div>
                </div>
              </div>
              <div className="font-mono text-[11px] bg-slate-50 rounded-lg px-3 py-2 text-slate-600 flex items-center gap-2">
                <span className="flex-1">{JSON.stringify(idx.key)}</span>
              </div>
              {idx.create_cmd && (
                <div className="mt-2 bg-slate-900 rounded-lg px-3 py-2 flex items-center gap-2">
                  <code className="font-mono text-[10px] text-green-300 flex-1 overflow-x-auto whitespace-nowrap">{idx.create_cmd}</code>
                  <CopyBtn text={idx.create_cmd} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── STATS ── */}
      {activeSection === 'stats' && (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <div className="divide-y divide-slate-100">
            {[
              ['Documents',           fmtNum(stats.count || 0)],
              ['Data Size',           `${stats.size_mb ?? 0} MB (${fmtBytes(stats.size || 0)})`],
              ['Storage Size',        `${stats.storage_size_mb ?? 0} MB (${fmtBytes(stats.storageSize || 0)})`],
              ['Avg Document Size',   `${fmtNum(stats.avgObjSize || 0)} bytes`],
              ['Number of Indexes',   stats.nindexes ?? '—'],
              ['Total Index Size',    `${stats.total_index_size_mb ?? 0} MB`],
              ['Capped',              stats.capped ? 'Yes' : 'No'],
              ['Capped Max Docs',     stats.max ? fmtNum(stats.max) : '—'],
            ].map(([label, value]) => (
              <div key={label} className="flex justify-between items-center px-4 py-2.5 text-sm">
                <span className="text-slate-500">{label}</span>
                <span className="font-semibold text-slate-800 text-right">{value}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Operation detail inline panel ─── */
function OperationDetailPanel({ op, connId, onAnalyze }) {
  return (
    <div className="bg-slate-50 border-t border-slate-200 px-4 py-4 space-y-3">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          ['Op ID',        op.opid || '—',          'font-mono text-xs'],
          ['Type',         op.op || op.type || '—', ''],
          ['Running',      op.secs_running != null ? `${op.secs_running}s` : '—', op.secs_running > 5 ? 'text-red-600 font-black' : op.secs_running > 1 ? 'text-orange-600 font-bold' : ''],
          ['Waiting Lock', op.waitingForLock ? 'Yes' : 'No', op.waitingForLock ? 'text-orange-600 font-bold' : ''],
          ['Namespace',    op.ns || '—',             'font-mono text-xs'],
          ['Client',       op.client || '—',         'font-mono text-xs'],
          ['App Name',     op.appName || '—',        ''],
          ['Plan',         op.planSummary || '—',    'font-mono text-xs'],
        ].map(([label, val, cls]) => (
          <div key={label} className="bg-white rounded-xl border border-slate-200 p-3">
            <p className="text-[9px] font-bold text-slate-400 uppercase">{label}</p>
            <p className={`text-xs mt-1 text-slate-700 truncate ${cls}`}>{val}</p>
          </div>
        ))}
      </div>
      {(op.query || op.filter) && (
        <div>
          <p className="text-[10px] font-bold text-slate-400 uppercase mb-1">Filter / Query</p>
          <div className="bg-slate-900 rounded-xl px-4 py-3 flex items-start gap-2">
            <pre className="font-mono text-[11px] text-green-300 flex-1 overflow-x-auto whitespace-pre-wrap">
              {typeof (op.query || op.filter) === 'string'
                ? (op.query || op.filter)
                : JSON.stringify(op.query || op.filter, null, 2)}
            </pre>
            <CopyBtn text={JSON.stringify(op.query || op.filter, null, 2)} />
          </div>
        </div>
      )}
      {op.locks && Object.keys(op.locks).length > 0 && (
        <div>
          <p className="text-[10px] font-bold text-slate-400 uppercase mb-1">Lock Info</p>
          <div className="font-mono text-[11px] bg-yellow-50 border border-yellow-200 rounded-xl px-3 py-2 text-yellow-800">
            {JSON.stringify(op.locks)}
          </div>
        </div>
      )}
      {onAnalyze && (
        <div className="flex justify-end">
          <button onClick={onAnalyze}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold text-white transition-all"
            style={{ background: 'linear-gradient(135deg, #00684A 0%, #00ED64 100%)' }}>
            <Brain size={13} /> Analyze with ActMon AI
          </button>
        </div>
      )}
    </div>
  );
}

/* ─── Index detail inline panel ─── */
function IndexDetailPanel({ idx }) {
  const dropCmd = `db.${(idx.ns || '').split('.').slice(1).join('.')}.dropIndex("${idx.name}")`;
  return (
    <div className="bg-slate-50 border-t border-slate-200 px-4 py-4 space-y-3">
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        {[
          ['Name',    idx.name || '—'],
          ['Unique',  idx.unique ? 'Yes' : 'No'],
          ['Sparse',  idx.sparse ? 'Yes' : 'No'],
          ['TTL',     idx.expireAfterSeconds != null ? `${idx.expireAfterSeconds}s` : '—'],
          ['Size',    idx.size ? fmtBytes(idx.size) : '—'],
          ['Accesses',fmtNum(idx.accesses ?? 0)],
        ].map(([label, val]) => (
          <div key={label} className="bg-white rounded-xl border border-slate-200 p-3">
            <p className="text-[9px] font-bold text-slate-400 uppercase">{label}</p>
            <p className="text-xs mt-1 text-slate-700 font-semibold">{val}</p>
          </div>
        ))}
      </div>
      <div>
        <p className="text-[10px] font-bold text-slate-400 uppercase mb-1">Key Definition</p>
        <div className="bg-slate-900 rounded-xl px-4 py-3 flex items-center gap-2">
          <code className="font-mono text-[11px] text-green-300 flex-1">{JSON.stringify(idx.key || {})}</code>
          <CopyBtn text={JSON.stringify(idx.key || {})} />
        </div>
      </div>
      {idx.unused && (
        <div className="bg-orange-50 border border-orange-200 rounded-xl p-3">
          <p className="text-xs font-bold text-orange-700 mb-2">⚠ Unused index — consider dropping to save space:</p>
          <div className="bg-slate-900 rounded-lg px-3 py-2 flex items-center gap-2">
            <code className="font-mono text-[10px] text-red-300 flex-1">{dropCmd}</code>
            <CopyBtn text={dropCmd} />
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Clickable KPI metric card ─── */
function ClickableKpi({ title, value, accent, onClick, hint }) {
  const accMap = {
    green:   'bg-green-50 border-green-200 text-green-700',
    emerald: 'bg-emerald-50 border-emerald-200 text-emerald-700',
    red:     'bg-red-50 border-red-200 text-red-700',
    orange:  'bg-orange-50 border-orange-200 text-orange-700',
    blue:    'bg-blue-50 border-blue-200 text-blue-700',
    purple:  'bg-purple-50 border-purple-200 text-purple-700',
    yellow:  'bg-yellow-50 border-yellow-200 text-yellow-700',
    slate:   'bg-slate-50 border-slate-200 text-slate-700',
    teal:    'bg-teal-50 border-teal-200 text-teal-700',
  };
  return (
    <button
      onClick={onClick}
      className={`rounded-xl border p-4 text-left transition-all hover:shadow-md hover:scale-[1.02] active:scale-[0.98] cursor-pointer w-full group ${accMap[accent] || accMap.slate}`}>
      <p className="text-[10px] font-bold uppercase tracking-wide opacity-70">{title}</p>
      <div className="flex items-center justify-between mt-1">
        <p className="text-2xl font-black">{value ?? '—'}</p>
        <ChevronRight size={14} className="opacity-0 group-hover:opacity-60 transition-opacity" />
      </div>
      {hint && <p className="text-[9px] opacity-50 mt-0.5">{hint}</p>}
    </button>
  );
}

/* ─── main component ─── */
export default function MongoDBDashboard() {
  const { id, tab } = useParams();
  const navigate = useNavigate();
  // Tab is URL-driven: /mongodb-dashboard/:id/:tab → every tab has its own route.
  const activeTab = tab || 'overview';
  const setActiveTab = (t) =>
    navigate(`/mongodb-dashboard/${id}${t && t !== 'overview' ? `/${t}` : ''}`);
  const [countdown, setCountdown]   = useState(REFRESH_INTERVAL);
  const [sparklines, setSparklines] = useState({ conn: [], cache: [], ops: [] });
  const [collSearch, setCollSearch] = useState('');
  const [selDb, setSelDb]           = useState('');
  const [nsFilter, setNsFilter]     = useState('');
  const [msThreshold, setMsThreshold] = useState(100);
  const [elSev, setElSev]           = useState('ALL');
  const [elSearch, setElSearch]     = useState('');
  const countRef = useRef(null);

  // Drill-down / detail state
  const [selectedColl, setSelectedColl] = useState(null); // {dbName, name}
  const [expandedOpId, setExpandedOpId] = useState(null);
  const [expandedIdxId, setExpandedIdxId] = useState(null);

  /* ── Main dashboard query ── */
  const { data, isLoading, error, refetch, isFetching, dataUpdatedAt } = useQuery({
    queryKey: ['mongodbDashboard', id],
    queryFn:  () => fetchDashboard(id),
    retry: false,
    refetchInterval: REFRESH_INTERVAL * 1000,
  });

  /* ── Per-tab queries ── */
  const { data: opsData, isLoading: opsLoading, refetch: refetchOps } = useQuery({
    queryKey: ['mongoOps', id],
    queryFn:  () => fetchOps(id),
    retry: false,
    refetchInterval: 5000,
    enabled: activeTab === 'operations',
  });

  const { data: profilerData, isLoading: profilerLoading } = useQuery({
    queryKey: ['mongoProfiler', id],
    queryFn:  () => fetchProfiler(id),
    retry: false,
    refetchInterval: 15000,
    enabled: activeTab === 'profiler',
  });

  const { data: slowData, isLoading: slowLoading } = useQuery({
    queryKey: ['mongoSlowOps', id],
    queryFn:  () => fetchSlowOps(id),
    retry: false,
    refetchInterval: 10000,
    enabled: activeTab === 'slowqueries',
  });

  const { data: collData, isLoading: collLoading } = useQuery({
    queryKey: ['mongoCollections', id],
    queryFn:  () => fetchCollections(id),
    retry: false,
    refetchInterval: 30000,
    enabled: activeTab === 'collections',
  });

  const { data: idxData, isLoading: idxLoading } = useQuery({
    queryKey: ['mongoIndexes', id],
    queryFn:  () => fetchIndexes(id),
    retry: false,
    refetchInterval: 30000,
    enabled: activeTab === 'indexes',
  });

  const { data: replData, isLoading: replLoading } = useQuery({
    queryKey: ['mongoReplication', id],
    queryFn:  () => fetchReplication(id),
    retry: false,
    refetchInterval: 8000,
    enabled: activeTab === 'replication',
  });

  const { data: oplogData, isLoading: oplogLoading } = useQuery({
    queryKey: ['mongoOplog', id],
    queryFn:  () => fetchOplog(id),
    retry: false,
    refetchInterval: 30000,
    enabled: activeTab === 'oplog',
  });

  const { data: shardData, isLoading: shardLoading } = useQuery({
    queryKey: ['mongoSharding', id],
    queryFn:  () => fetchSharding(id),
    retry: false,
    refetchInterval: 60000,
    enabled: activeTab === 'sharding',
  });

  const { data: txnData, isLoading: txnLoading } = useQuery({
    queryKey: ['mongoTransactions', id],
    queryFn:  () => fetchTransactions(id),
    retry: false,
    refetchInterval: 10000,
    enabled: activeTab === 'transactions',
  });

  const { data: wtData, isLoading: wtLoading } = useQuery({
    queryKey: ['mongoWiredTiger', id],
    queryFn:  () => fetchWiredTiger(id),
    retry: false,
    refetchInterval: 15000,
    enabled: activeTab === 'wiredtiger',
  });

  const { data: usersData, isLoading: usersLoading, refetch: refetchUsers } = useQuery({
    queryKey: ['mongoUsers', id],
    queryFn:  () => fetchUsers(id),
    retry: false,
    refetchInterval: 60000,
    enabled: activeTab === 'users',
  });

  const { data: errorLogsData, isLoading: errorLogsLoading, refetch: refetchErrorLogs } = useQuery({
    queryKey: ['mongoErrorLogs', id],
    queryFn:  () => fetchErrorLogs(id),
    retry: false,
    refetchInterval: 20000,
    enabled: activeTab === 'errorlogs',
  });

  /* ── Countdown timer ── */
  useEffect(() => {
    setCountdown(REFRESH_INTERVAL);
    if (countRef.current) clearInterval(countRef.current);
    countRef.current = setInterval(() => {
      setCountdown(c => (c <= 1 ? REFRESH_INTERVAL : c - 1));
    }, 1000);
    return () => clearInterval(countRef.current);
  }, [dataUpdatedAt]);

  /* ── Sparkline collection ── */
  useEffect(() => {
    if (!data) return;
    const connPct   = Number(data?.gauges?.connection_pct) || 0;
    const cacheHit  = Number(data?.gauges?.wired_tiger_cache_hit_pct) || 0;
    const opRate    = Number(data?.gauges?.op_rate) || 0;
    setSparklines(prev => ({
      conn:  [...prev.conn.slice(-20),  { t: new Date().toLocaleTimeString(), v: connPct  }],
      cache: [...prev.cache.slice(-20), { t: new Date().toLocaleTimeString(), v: cacheHit }],
      ops:   [...prev.ops.slice(-20),   { t: new Date().toLocaleTimeString(), v: opRate   }],
    }));
  }, [data]);

  /* ── Loading / error states ── */
  if (isLoading) return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50">
      <div className="text-center">
        <div className="w-12 h-12 border-4 border-green-200 border-t-green-600 rounded-full animate-spin mx-auto mb-4" />
        <p className="text-slate-600 font-semibold">Connecting to MongoDB...</p>
      </div>
    </div>
  );

  if (error || data?.status === 'error') return (
    <div className="p-8">
      <div className="bg-red-50 border border-red-200 text-red-700 p-6 rounded-2xl max-w-2xl">
        <AlertTriangle className="mb-2" size={24} />
        <p className="font-bold text-lg">Connection Error</p>
        <p className="text-sm mt-2">{data?.error || error?.message}</p>
        <button onClick={() => refetch()}
          className="mt-4 px-4 py-2 bg-red-600 text-white rounded-xl text-sm font-semibold hover:bg-red-700">
          Retry
        </button>
      </div>
    </div>
  );

  /* ── Destructure main data ── */
  const {
    connection       = {},
    health_summary   = {},
    connections      = {},
    memory           = {},
    opcounters       = {},
    gauges           = {},
    databases        = [],
    wired_tiger      = {},
    network          = {},
    global_lock      = {},
    repl_status      = {},
  } = data || {};

  const connPct    = Number(gauges.connection_pct)             || 0;
  const cacheHitPct= Number(gauges.wired_tiger_cache_hit_pct) || 0;
  const wtCachePct = Number(gauges.wt_cache_pct)              || 0;
  const opRate     = Number(gauges.op_rate)                   || 0;
  const healthScore = computeHealthScore(
    connPct, cacheHitPct,
    0,
    health_summary.replication_state || 'STANDALONE'
  );

  const alerts = {
    operations:   (opsData?.slow_count || 0),
    slowqueries:  (slowData?.total || 0),
  };

  /* ─────────────────────────────────────────────────────────────── */
  return (
    <div className="-mx-6 md:-mx-8 min-h-full bg-slate-50 flex flex-col">

      {/* ─── Collection Detail Modal ─── */}
      {selectedColl && (
        <DetailModal
          title={`${selectedColl.dbName}.${selectedColl.name}`}
          subtitle="Collection detail — schema, indexes &amp; statistics"
          onClose={() => setSelectedColl(null)}>
          <CollectionDetailPanel
            connId={id}
            dbName={selectedColl.dbName}
            collName={selectedColl.name}
            onViewSlowOps={() => { setSelectedColl(null); setActiveTab('slowqueries'); setNsFilter(`${selectedColl.dbName}.${selectedColl.name}`); }}
          />
        </DetailModal>
      )}

      {/* ─── HERO HEADER ─── */}
      <div style={{ background: `linear-gradient(135deg, ${C.navy} 0%, #0a2d1f 50%, #003d2a 100%)` }}
        className="text-white shadow-2xl">
        <div className="px-6 py-4 flex flex-wrap justify-between items-center gap-3">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-2xl flex items-center justify-center text-2xl"
              style={{ background: 'rgba(0,237,100,0.15)', border: '1px solid rgba(0,237,100,0.35)' }}>
              🍃
            </div>
            <div>
              <h1 className="text-2xl font-black tracking-tight">MongoDB Dashboard</h1>
              <p className="text-sm mt-0.5" style={{ color: C.green }}>
                {connection?.name || 'MongoDB'} — {connection?.host}:{connection?.port || 27017}
                {connection?.database ? ` / ${connection.database}` : ''}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <HealthBadge score={healthScore} />

            <button onClick={() => refetch()}
              className="flex items-center gap-2 px-4 py-1.5 rounded-lg text-sm font-semibold border transition-all"
              style={{ background: 'rgba(0,237,100,0.1)', borderColor: 'rgba(0,237,100,0.3)' }}>
              <RefreshCw size={13} className={isFetching ? 'animate-spin' : ''} />
              <span>Refresh</span>
              <span className="ml-1 w-5 h-5 rounded-full text-[10px] font-black flex items-center justify-center"
                style={{ background: 'rgba(0,237,100,0.2)', color: C.green }}>
                {countdown}
              </span>
            </button>
          </div>
        </div>

        {/* TAB BAR */}
        <div className="px-4 pt-2 flex gap-0.5 overflow-x-auto border-t border-white/10">
          {TABS.map(tab => {
            const Icon  = tab.icon;
            const alert = alerts[tab.id] || 0;
            return (
              <button key={tab.id} onClick={() => setActiveTab(tab.id)}
                className={`relative flex items-center gap-2 px-4 py-2.5 text-xs font-semibold rounded-t-lg whitespace-nowrap transition-all ${
                  activeTab === tab.id
                    ? 'bg-slate-50 text-green-700'
                    : 'text-white/60 hover:text-white hover:bg-white/10'
                }`}>
                <Icon size={13} />
                {tab.label}
                {alert > 0 && (
                  <span className="absolute -top-1 -right-1 w-4 h-4 bg-red-500 text-white text-[9px] font-black rounded-full flex items-center justify-center">
                    {alert}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* ─── TAB CONTENT ─── */}
      <div className="flex-1 p-5 overflow-auto">

        {/* ══ OVERVIEW ══════════════════════════════════════════════════ */}
        {activeTab === 'overview' && (() => {
          const opcData = [
            { name: 'Insert',   v: Number(opcounters.insert  || 0) },
            { name: 'Query',    v: Number(opcounters.query   || 0) },
            { name: 'Update',   v: Number(opcounters.update  || 0) },
            { name: 'Delete',   v: Number(opcounters.delete  || 0) },
            { name: 'Getmore',  v: Number(opcounters.getmore || 0) },
            { name: 'Command',  v: Number(opcounters.command || 0) },
          ];
          const networkBytesIn  = Number(network.bytesIn  || 0);
          const networkBytesOut = Number(network.bytesOut || 0);
          const glQueue = global_lock?.currentQueue || {};
          const glActive = global_lock?.activeClients || {};
          const glTotal = glQueue.total || 0;
          const glRatio = glActive.total > 0
            ? Math.min(100, Math.round((glQueue.total / glActive.total) * 100))
            : 0;

          const topCollsBySize = databases
            .flatMap(db => (db.collections || []).map(c => ({ ...c, db: db.name })))
            .sort((a, b) => (b.size_mb || 0) - (a.size_mb || 0))
            .slice(0, 8);

          return (
            <div className="space-y-4">

              {/* KPI strip - all clickable */}
              <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-8 gap-3">
                <KpiCard icon={Server}    title="Version"     value={(health_summary.version || '—').split('-')[0]} accent="green" />
                <KpiCard icon={Clock}     title="Uptime"      value={health_summary.uptime_str || fmtUptime(health_summary.uptime_seconds)} accent="teal" />
                <button onClick={() => setActiveTab('collections')} className="text-left hover:shadow-md transition-all rounded-xl">
                  <KpiCard icon={Database}  title="Databases"   value={health_summary.total_databases ?? '—'} accent="blue" />
                </button>
                <button onClick={() => setActiveTab('collections')} className="text-left hover:shadow-md transition-all rounded-xl">
                  <KpiCard icon={Layers}    title="Collections" value={health_summary.total_collections ?? '—'} accent="purple" />
                </button>
                <button onClick={() => setActiveTab('operations')} className="text-left hover:shadow-md transition-all rounded-xl">
                  <KpiCard icon={Network}   title="Connections" value={`${connections.current ?? 0}/${(connections.current || 0) + (connections.available || 0)}`} accent={connPct > 80 ? 'red' : 'emerald'} />
                </button>
                <KpiCard icon={HardDrive} title="Mem (MB)"    value={memory.resident ?? '—'} accent="orange" />
                <button onClick={() => setActiveTab('replication')} className="text-left hover:shadow-md transition-all rounded-xl">
                  <KpiCard icon={Cpu}       title="Repl State"  value={health_summary.replication_state || 'STANDALONE'} accent={health_summary.replication_state === 'PRIMARY' ? 'green' : 'slate'} />
                </button>
                <button onClick={() => setActiveTab('operations')} className="text-left hover:shadow-md transition-all rounded-xl">
                  <KpiCard icon={Activity}  title="Total Ops"   value={fmtNum(opRate)} accent="cyan" />
                </button>
              </div>

              {/* Host Resources drill-down */}
              <HostResources connId={id} tech="mongodb" />

              {/* 4 Gauges */}
              <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
                <GaugeCard
                  title="Connection %"
                  pct={connPct}
                  sub={`${connections.current ?? 0} current / ${connections.available ?? 0} available`}
                  colorFn={v => v > 80 ? C.red : v > 60 ? C.orange : C.green}
                />
                <GaugeCard
                  title="WT Cache Used %"
                  pct={wtCachePct}
                  sub={`${wired_tiger.cache_used_mb ?? 0} MB / ${wired_tiger.cache_max_mb ?? 0} MB configured`}
                  colorFn={v => v > 85 ? C.red : v > 70 ? C.orange : C.green}
                />
                <GaugeCard
                  title="Op Rate"
                  pct={Math.min(100, opRate > 0 ? Math.min(opRate / 10, 100) : 0)}
                  centerLabel={fmtNum(opRate)}
                  centerUnit=" ops"
                  sub="Cumulative opcounters total"
                  colorFn={() => C.green}
                />
                <GaugeCard
                  title="WT Cache Hit %"
                  pct={cacheHitPct}
                  sub="WiredTiger cache read efficiency"
                  colorFn={v => v < 70 ? C.red : v < 85 ? C.orange : C.green}
                />
              </div>

              {/* Live sparklines */}
              {sparklines.conn.length > 2 ? (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <TrendCard title="Connection %"   data={sparklines.conn}  color={C.green}   unit="%" />
                  <TrendCard title="WT Cache Hit %"  data={sparklines.cache} color={C.emerald} unit="%" />
                  <TrendCard title="Op Rate"         data={sparklines.ops}   color={C.cyan}    fmtVal={v => `${fmtNum(v)} ops`} />
                </div>
              ) : (
                <div className="bg-white rounded-2xl border border-slate-200 p-4 text-center text-slate-400 text-xs">
                  Live trend charts appear after the first 15-second auto-refresh
                </div>
              )}

              {/* Opcounters + DB list */}
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                <ChartCard title="Opcounters (cumulative)">
                  <ResponsiveContainer width="100%" height={210}>
                    <BarChart data={opcData} barCategoryGap="25%">
                      <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                      <XAxis dataKey="name" tick={{ fontSize: 10, fontWeight: 600 }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fontSize: 9 }} tickFormatter={fmtNum} axisLine={false} tickLine={false} />
                      <Tooltip formatter={v => fmtNum(v)} cursor={{ fill: '#f8fafc' }} />
                      <Bar dataKey="v" radius={[5, 5, 0, 0]}>
                        {[C.green, C.emerald, C.teal, C.red, C.orange, C.purple].map((fill, i) => (
                          <Cell key={i} fill={fill} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                  <div className="grid grid-cols-3 gap-x-4 mt-2">
                    <Row label="Insert"  value={fmtNum(opcounters.insert  || 0)} />
                    <Row label="Query"   value={fmtNum(opcounters.query   || 0)} />
                    <Row label="Update"  value={fmtNum(opcounters.update  || 0)} />
                    <Row label="Delete"  value={fmtNum(opcounters.delete  || 0)} />
                    <Row label="Getmore" value={fmtNum(opcounters.getmore || 0)} />
                    <Row label="Command" value={fmtNum(opcounters.command || 0)} />
                  </div>
                </ChartCard>

                <Panel title={`Databases (${databases.length})`}>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead className="bg-slate-50">
                        <tr>{['Name', 'Collections', 'Objects', 'Size MB', 'Index MB'].map(h => (
                          <th key={h} className="px-3 py-2 text-left text-[10px] font-bold text-slate-400 uppercase whitespace-nowrap">{h}</th>
                        ))}</tr>
                      </thead>
                      <tbody>
                        {databases.map((dbRow, i) => (
                          <tr key={i} className="border-t border-slate-100 hover:bg-slate-50">
                            <td className="px-3 py-2.5 font-bold" style={{ color: C.darkGreen }}>{dbRow.name}</td>
                            <td className="px-3 py-2.5 font-mono">{dbRow.collections_count ?? '—'}</td>
                            <td className="px-3 py-2.5 font-mono">{fmtNum(dbRow.objects || 0)}</td>
                            <td className="px-3 py-2.5 font-mono">{dbRow.data_size_mb ?? '—'}</td>
                            <td className="px-3 py-2.5 font-mono">{dbRow.index_size_mb ?? '—'}</td>
                          </tr>
                        ))}
                        {databases.length === 0 && (
                          <tr><td colSpan={5} className="text-center py-8 text-slate-400">No databases found</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </Panel>
              </div>

              {/* Server info + Memory + Network / GlobalLock */}
              <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
                <Panel title="Server Information">
                  <Row label="Version"        value={health_summary.version || '—'} mono />
                  <Row label="Uptime"         value={health_summary.uptime_str || fmtUptime(health_summary.uptime_seconds)} />
                  <Row label="Host"           value={health_summary.host || connection?.host || '—'} mono />
                  <Row label="PID"            value={health_summary.pid || '—'} mono />
                  <Row label="Process"        value={health_summary.process || 'mongod'} />
                  <Row label="Storage Engine" value={health_summary.storage_engine || 'WiredTiger'} />
                  <Row label="Replica Set"    value={health_summary.replica_set || 'Standalone'} />
                  <Row label="State"          value={health_summary.replication_state || 'STANDALONE'} />
                </Panel>

                <Panel title="Memory & WiredTiger Cache">
                  <div className="mb-4">
                    <div className="flex justify-between text-xs text-slate-500 mb-1">
                      <span>Cache Used</span>
                      <span className="font-black">{wtCachePct}%</span>
                    </div>
                    <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                      <div className="h-full rounded-full transition-all duration-500"
                        style={{ width: `${wtCachePct}%`, background: wtCachePct > 85 ? C.red : wtCachePct > 70 ? C.orange : C.green }} />
                    </div>
                  </div>
                  <div className="mb-4">
                    <div className="flex justify-between text-xs text-slate-500 mb-1">
                      <span>Cache Hit Rate</span>
                      <span className="font-black">{cacheHitPct}%</span>
                    </div>
                    <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                      <div className="h-full rounded-full transition-all duration-500"
                        style={{ width: `${cacheHitPct}%`, background: cacheHitPct < 70 ? C.red : cacheHitPct < 85 ? C.orange : C.green }} />
                    </div>
                  </div>
                  <Row label="Resident MB"    value={`${memory.resident ?? 0} MB`} />
                  <Row label="Virtual MB"     value={`${memory.virtual  ?? 0} MB`} />
                  <Row label="WT Cache Used"  value={wired_tiger.cache_used_mb  ? `${wired_tiger.cache_used_mb} MB` : '—'} />
                  <Row label="WT Cache Max"   value={wired_tiger.cache_max_mb   ? `${wired_tiger.cache_max_mb} MB` : '—'} />
                  <Row label="WT Dirty"       value={wired_tiger.dirty_bytes_mb ? `${wired_tiger.dirty_bytes_mb} MB` : '—'} />
                </Panel>

                <Panel title="Network & Global Lock">
                  <div className="mb-4">
                    <div className="flex justify-between text-xs text-slate-500 mb-1">
                      <span>Connection Usage</span>
                      <span className="font-black">{connPct}%</span>
                    </div>
                    <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                      <div className="h-full rounded-full transition-all duration-500"
                        style={{ width: `${connPct}%`, background: connPct > 80 ? C.red : connPct > 60 ? C.orange : C.green }} />
                    </div>
                  </div>
                  <Row label="Bytes In"         value={fmtBytes(network.bytesIn    || 0)} />
                  <Row label="Bytes Out"        value={fmtBytes(network.bytesOut   || 0)} />
                  <Row label="Requests"         value={fmtNum(network.numRequests  || 0)} />
                  <Row label="Total Created"    value={fmtNum(connections.totalCreated || 0)} />
                  <Row label="GL Queue Total"   value={glQueue.total ?? 0} />
                  <Row label="GL Queue Readers" value={glQueue.readers ?? 0} />
                  <Row label="GL Queue Writers" value={glQueue.writers ?? 0} />
                  <Row label="GL Active"        value={glActive.total ?? 0} />
                </Panel>
              </div>

              {/* ── Quick Access to dedicated sub-pages ── */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {[
                  { label: 'Slow Operations',     icon: Clock,    path: `/mongodb-dashboard/${id}/slow-operations`,     desc: 'Advanced slow op explorer', color: 'from-orange-500 to-red-500' },
                  { label: 'Collection Analysis', icon: BarChart2, path: `/mongodb-dashboard/${id}/collection-analysis`, desc: 'Indexes & scan insights',     color: 'from-blue-500 to-indigo-600' },
                  { label: 'Error Logs',          icon: FileText,  path: `/mongodb-dashboard/${id}/error-logs`,          desc: 'Severity-filtered log view', color: 'from-red-500 to-rose-600' },
                  { label: 'Backup & Restore',    icon: Archive,   path: `/mongodb-dashboard/${id}/backup`,              desc: 'mongodump command builder', color: 'from-green-600 to-emerald-700' },
                ].map(p => (
                  <button key={p.label} onClick={() => navigate(p.path)}
                    className="text-left bg-white border border-slate-200 rounded-2xl p-4 hover:shadow-md hover:-translate-y-0.5 transition-all group flex items-center gap-3">
                    <div className={`w-10 h-10 rounded-xl bg-gradient-to-br ${p.color} flex items-center justify-center flex-shrink-0`}>
                      <p.icon size={16} className="text-white" />
                    </div>
                    <div className="min-w-0">
                      <p className="font-bold text-slate-800 text-sm truncate">{p.label}</p>
                      <p className="text-[10px] text-slate-400 mt-0.5 truncate">{p.desc}</p>
                    </div>
                    <ChevronRight size={14} className="text-slate-300 group-hover:text-slate-500 flex-shrink-0 ml-auto transition-colors" />
                  </button>
                ))}
              </div>

              {/* Top collections by size — click any to open detail */}
              {topCollsBySize.length > 0 && (
                <div className="bg-white rounded-2xl border border-slate-200 p-5">
                  <h3 className="font-bold text-slate-700 text-sm mb-4">Top Collections by Size — click to inspect</h3>
                  <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
                    <ResponsiveContainer width="100%" height={220}>
                      <BarChart layout="vertical"
                        data={topCollsBySize.map(c => ({ name: `${c.db || ''}.${c.name || c.collection || ''}`, size_mb: c.size_mb || 0, _c: c }))}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" horizontal={false} />
                        <XAxis type="number" tick={{ fontSize: 9 }} tickFormatter={v => `${v}MB`} axisLine={false} tickLine={false} />
                        <YAxis width={160} type="category" dataKey="name" tick={{ fontSize: 9 }} axisLine={false} tickLine={false} />
                        <Tooltip formatter={v => `${v} MB`} cursor={{ fill: '#f8fafc' }} />
                        <Bar dataKey="size_mb" radius={[0, 5, 5, 0]}>
                          {topCollsBySize.map((_, i) => (
                            <Cell key={i} fill={[C.green, C.emerald, C.teal, C.blue, C.purple, C.orange, C.cyan, C.yellow][i % 8]} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                    <div className="space-y-1">
                      {topCollsBySize.map((c, i) => {
                        const dbName = c.db || c.dbName || '';
                        const collName = c.name || c.collection || '';
                        const COLORS = [C.green, C.emerald, C.teal, C.blue, C.purple, C.orange, C.cyan, C.yellow];
                        return (
                          <button key={i}
                            onClick={() => setSelectedColl({ dbName, name: collName })}
                            className="w-full flex items-center gap-3 px-3 py-2 rounded-xl hover:bg-slate-50 border border-transparent hover:border-slate-200 transition-all text-left group">
                            <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: COLORS[i % 8] }} />
                            <span className="font-mono text-xs text-slate-700 flex-1 truncate">{dbName}.{collName}</span>
                            <span className="text-xs font-bold text-slate-500">{(c.size_mb || 0).toFixed(3)} MB</span>
                            <Eye size={11} className="text-green-500 opacity-0 group-hover:opacity-100 flex-shrink-0" />
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}

            </div>
          );
        })()}

        {/* ══ OPERATIONS ════════════════════════════════════════════════ */}
        {activeTab === 'operations' && (() => {
          if (opsLoading) return <TabLoader />;
          const ops = opsData?.ops || [];
          const activeOps  = ops.filter(o => o.active);
          const waitingOps = ops.filter(o => o.waitingForLock);
          const slowOps    = ops.filter(o => (o.secs_running || 0) > 1);
          return (
            <div className="space-y-5">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <ClickableKpi title="Total Ops"    value={ops.length}        accent="blue"   hint="All current operations" onClick={() => {}} />
                <ClickableKpi title="Active"       value={activeOps.length}  accent="green"  hint="Click to highlight active" onClick={() => setExpandedOpId(activeOps[0]?.opid || null)} />
                <ClickableKpi title="Waiting Lock" value={waitingOps.length} accent={waitingOps.length > 0 ? 'orange' : 'slate'} hint="Click to see lock-waiters" onClick={() => setExpandedOpId(waitingOps[0]?.opid || null)} />
                <ClickableKpi title="Slow (>1s)"   value={slowOps.length}    accent={slowOps.length > 0 ? 'red' : 'green'} hint="Click to see slowest" onClick={() => setExpandedOpId(slowOps[0]?.opid || null)} />
              </div>

              {slowOps.length > 0 && (
                <div className="bg-red-50 border border-red-200 rounded-2xl p-4">
                  <div className="flex items-center gap-2 mb-3">
                    <AlertTriangle className="text-red-500" size={16} />
                    <span className="font-bold text-red-700 text-sm">{slowOps.length} Slow Operation{slowOps.length > 1 ? 's' : ''} (running &gt; 1s)</span>
                  </div>
                  {slowOps.slice(0, 3).map((op, i) => (
                    <div key={i} className="bg-white rounded-xl border border-red-100 px-3 py-2 text-xs mb-2">
                      <span className="font-bold" style={{ color: C.darkGreen }}>{op.ns || '?'}</span>
                      <span className="ml-2 font-black text-orange-600">{op.secs_running}s</span>
                      <span className="ml-2 text-slate-400">{op.op || op.type}</span>
                      {op.waitingForLock && <span className="ml-2 px-1.5 py-0.5 bg-orange-100 text-orange-700 rounded text-[9px] font-bold">WAITING LOCK</span>}
                      <div className="mt-1 font-mono text-slate-500 truncate">{op.query?.slice(0, 120)}</div>
                    </div>
                  ))}
                </div>
              )}

              <Panel title={`Current Operations (${ops.length})`}
                action={
                  <button onClick={() => refetchOps()}
                    className="text-xs text-green-600 font-semibold hover:text-green-800 flex items-center gap-1">
                    <RefreshCw size={11} className={opsLoading ? 'animate-spin' : ''} /> Refresh
                  </button>
                }>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50">
                      <tr>{['Op ID', 'Op Type', 'Namespace', 'Secs Running', 'Waiting Lock', 'Client', 'Plan', 'App'].map(h => (
                        <th key={h} className="px-3 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase whitespace-nowrap">{h}</th>
                      ))}</tr>
                    </thead>
                    <tbody>
                      {ops.map((op, i) => {
                        const isExpanded = expandedOpId === op.opid;
                        return (
                          <React.Fragment key={i}>
                            <tr
                              className={`border-t border-slate-100 cursor-pointer transition-colors ${isExpanded ? 'bg-green-50' : (op.secs_running || 0) > 5 ? 'bg-red-50/40 hover:bg-red-50' : (op.secs_running || 0) > 1 ? 'bg-yellow-50/40 hover:bg-yellow-50' : 'hover:bg-slate-50'}`}
                              onClick={() => setExpandedOpId(isExpanded ? null : op.opid)}>
                              <td className="px-3 py-2.5 font-mono text-[10px] text-slate-500">
                                <div className="flex items-center gap-1">
                                  {isExpanded ? <ChevronUp size={10} className="text-green-600" /> : <ChevronDown size={10} className="text-slate-300" />}
                                  {op.opid}
                                </div>
                              </td>
                              <td className="px-3 py-2.5">
                                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold"
                                  style={{ background: 'rgba(0,237,100,0.1)', color: C.darkGreen }}>
                                  {op.op || op.type || '—'}
                                </span>
                              </td>
                              <td className="px-3 py-2.5 font-mono text-xs text-slate-600 max-w-[180px] truncate">{op.ns || '—'}</td>
                              <td className={`px-3 py-2.5 font-bold text-sm ${(op.secs_running || 0) > 5 ? 'text-red-600' : (op.secs_running || 0) > 1 ? 'text-orange-600' : 'text-slate-600'}`}>
                                {op.secs_running ?? 0}s
                              </td>
                              <td className="px-3 py-2.5">
                                {op.waitingForLock
                                  ? <span className="px-2 py-0.5 bg-orange-100 text-orange-700 text-[10px] font-bold rounded-full">Yes</span>
                                  : <span className="text-[10px] text-slate-300">No</span>
                                }
                              </td>
                              <td className="px-3 py-2.5 text-xs text-slate-400 max-w-[120px] truncate">{op.client || '—'}</td>
                              <td className="px-3 py-2.5 text-[10px] text-slate-400 max-w-[120px] truncate">{op.planSummary || '—'}</td>
                              <td className="px-3 py-2.5 text-[10px] text-slate-400 max-w-[100px] truncate">{op.appName || '—'}</td>
                            </tr>
                            {isExpanded && (
                              <tr className="bg-slate-50">
                                <td colSpan={8} className="p-0">
                                  <OperationDetailPanel
                                    op={op}
                                    connId={id}
                                    onAnalyze={() => { navigate(`/mongodb-dashboard/${id}/slow-operations`); }}
                                  />
                                </td>
                              </tr>
                            )}
                          </React.Fragment>
                        );
                      })}
                      {ops.length === 0 && (
                        <tr><td colSpan={8} className="text-center py-10 text-slate-400">No active operations</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </Panel>

              <ChartCard title="Opcounters Breakdown">
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={[
                    { name: 'Insert',  v: Number(opcounters.insert  || 0) },
                    { name: 'Query',   v: Number(opcounters.query   || 0) },
                    { name: 'Update',  v: Number(opcounters.update  || 0) },
                    { name: 'Delete',  v: Number(opcounters.delete  || 0) },
                    { name: 'Getmore', v: Number(opcounters.getmore || 0) },
                    { name: 'Command', v: Number(opcounters.command || 0) },
                  ]}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                    <XAxis dataKey="name" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 10 }} tickFormatter={fmtNum} axisLine={false} tickLine={false} />
                    <Tooltip formatter={v => fmtNum(v)} cursor={{ fill: '#f8fafc' }} />
                    <Bar dataKey="v" radius={[6, 6, 0, 0]}>
                      {[C.green, C.emerald, C.teal, C.red, C.orange, C.purple].map((fill, i) => (
                        <Cell key={i} fill={fill} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </ChartCard>
            </div>
          );
        })()}

        {/* ══ PROFILER ══════════════════════════════════════════════════ */}
        {activeTab === 'profiler' && (() => {
          if (profilerLoading) return <TabLoader />;
          const profilerOps = profilerData?.ops || [];
          const levels      = profilerData?.profiler_levels || {};
          const errors      = profilerData?.errors || [];
          const anyEnabled  = Object.values(levels).some(l => l >= 1);
          return (
            <div className="space-y-5">
              {/* Profiler status per DB */}
              <Panel title="Profiler Status per Database">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                  {Object.entries(levels).map(([dbName, level]) => (
                    <div key={dbName} className={`rounded-xl border p-3 ${level >= 1 ? 'bg-green-50 border-green-200' : 'bg-slate-50 border-slate-200'}`}>
                      <p className="text-[10px] font-bold text-slate-500 uppercase">{dbName}</p>
                      <p className={`font-black text-lg mt-1 ${level >= 1 ? 'text-green-700' : 'text-slate-400'}`}>
                        Level {level} {level === 0 ? '(Off)' : level === 1 ? '(Slow)' : '(All)'}
                      </p>
                    </div>
                  ))}
                  {Object.keys(levels).length === 0 && (
                    <p className="text-xs text-slate-400 col-span-4">No databases accessible</p>
                  )}
                </div>
                {!anyEnabled && (
                  <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-4 text-sm text-yellow-800">
                    <AlertTriangle size={16} className="inline mr-2" />
                    Profiler is off on all databases. Enable with: <code className="font-mono text-xs bg-white px-1 rounded">db.setProfilingLevel(1, 100)</code>
                  </div>
                )}
                {errors.length > 0 && (
                  <div className="mt-3 text-xs text-slate-500">
                    <p className="font-bold mb-1">Warnings:</p>
                    {errors.map((e, i) => <p key={i} className="font-mono text-[10px]">{e}</p>)}
                  </div>
                )}
              </Panel>

              <Panel title={`Profiled Operations (${profilerOps.length})`}>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-slate-50">
                      <tr>{['DB', 'Op', 'Namespace', 'Millis', 'Docs Exam.', 'Keys Exam.', 'Returned', 'Plan', 'Client', 'Timestamp'].map(h => (
                        <th key={h} className="px-3 py-2 text-left text-[10px] font-bold text-slate-400 uppercase whitespace-nowrap">{h}</th>
                      ))}</tr>
                    </thead>
                    <tbody>
                      {profilerOps.slice(0, 100).map((op, i) => (
                        <tr key={i} className={`border-t border-slate-100 hover:bg-slate-50 ${op.millis > 1000 ? 'bg-red-50/30' : op.millis > 200 ? 'bg-yellow-50/30' : ''}`}>
                          <td className="px-3 py-2 font-bold" style={{ color: C.darkGreen }}>{op.db}</td>
                          <td className="px-3 py-2">
                            <span className="px-2 py-0.5 rounded-full text-[9px] font-bold"
                              style={{ background: 'rgba(0,237,100,0.1)', color: C.darkGreen }}>
                              {op.op || '—'}
                            </span>
                          </td>
                          <td className="px-3 py-2 font-mono text-slate-500 max-w-[160px] truncate">{op.ns}</td>
                          <td className={`px-3 py-2 font-bold ${op.millis > 1000 ? 'text-red-600' : op.millis > 200 ? 'text-orange-600' : 'text-slate-700'}`}>
                            {op.millis}ms
                          </td>
                          <td className="px-3 py-2 font-mono">{fmtNum(op.docsExamined || 0)}</td>
                          <td className="px-3 py-2 font-mono">{fmtNum(op.keysExamined || 0)}</td>
                          <td className="px-3 py-2 font-mono">{fmtNum(op.nreturned || 0)}</td>
                          <td className="px-3 py-2 text-[10px] text-slate-400 max-w-[120px] truncate">{op.planSummary || '—'}</td>
                          <td className="px-3 py-2 text-[10px] text-slate-400 max-w-[100px] truncate">{op.client || '—'}</td>
                          <td className="px-3 py-2 font-mono text-[9px] text-slate-400 whitespace-nowrap">{op.ts || '—'}</td>
                        </tr>
                      ))}
                      {profilerOps.length === 0 && (
                        <tr><td colSpan={10}>
                          <EmptyState icon={Terminal} message="No profiler data" sub="Enable profiling with db.setProfilingLevel(1, 100)" />
                        </td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </Panel>
            </div>
          );
        })()}

        {/* ══ COLLECTIONS ═══════════════════════════════════════════════ */}
        {activeTab === 'collections' && (() => {
          if (collLoading) return <TabLoader />;
          const dbsData = collData?.databases || [];
          const allColls = dbsData.flatMap(d =>
            (d.collections || []).map(c => ({ ...c, dbName: d.name }))
          );
          const dbs = dbsData.map(d => d.name);
          const filtered = allColls.filter(c => {
            const matchDb   = !selDb   || c.dbName === selDb;
            const matchName = !collSearch || (c.name || '').toLowerCase().includes(collSearch.toLowerCase());
            return matchDb && matchName;
          });
          const totalDocs    = filtered.reduce((a, c) => a + (c.count || 0), 0);
          const totalSizeMB  = filtered.reduce((a, c) => a + (c.size_mb || 0), 0).toFixed(2);
          const topBySize    = [...filtered].sort((a, b) => (b.size_mb || 0) - (a.size_mb || 0)).slice(0, 10);

          return (
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-3">
                <MetricKpi title="Collections"  value={filtered.length}        accent="green" />
                <MetricKpi title="Total Docs"   value={fmtNum(totalDocs)}      accent="emerald" />
                <MetricKpi title="Total Size"   value={`${totalSizeMB} MB`}   accent="orange" />
              </div>
              <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-2 flex items-center gap-2 text-emerald-700 text-xs font-semibold">
                <Eye size={13} /> Click any collection row to explore its schema, indexes &amp; statistics
              </div>

              <div className="flex items-center gap-3 flex-wrap">
                {/* DB selector */}
                <select value={selDb} onChange={e => setSelDb(e.target.value)}
                  className="h-9 px-3 rounded-xl border border-slate-200 text-sm outline-none focus:border-green-400 bg-white">
                  <option value="">All Databases</option>
                  {dbs.map(d => <option key={d} value={d}>{d}</option>)}
                </select>
                <div className="relative flex-1 max-w-sm">
                  <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input value={collSearch} onChange={e => setCollSearch(e.target.value)}
                    placeholder="Search collections..."
                    className="h-9 w-full pl-8 pr-4 rounded-xl border border-slate-200 text-sm outline-none focus:border-green-400" />
                </div>
                <span className="text-xs text-slate-400">{filtered.length} collections</span>
              </div>

              <Panel title="Collection Statistics">
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-slate-50">
                      <tr>{['Database', 'Collection', 'Documents', 'Size MB', 'Avg Obj (B)', 'Indexes', 'Total Idx MB', 'Capped'].map(h => (
                        <th key={h} className="px-3 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase whitespace-nowrap">{h}</th>
                      ))}</tr>
                    </thead>
                    <tbody>
                      {filtered.slice(0, 100).map((c, i) => (
                        <tr key={i}
                          className="border-t border-slate-100 hover:bg-green-50 cursor-pointer transition-colors group"
                          onClick={() => setSelectedColl({ dbName: c.dbName, name: c.name })}>
                          <td className="px-3 py-2.5 text-slate-500 font-mono text-[10px]">{c.dbName}</td>
                          <td className="px-3 py-2.5 font-bold flex items-center gap-1.5" style={{ color: C.darkGreen }}>
                            {c.name}
                            <Eye size={11} className="opacity-0 group-hover:opacity-60 text-green-600 transition-opacity flex-shrink-0" />
                          </td>
                          <td className="px-3 py-2.5 font-mono">{fmtNum(c.count || 0)}</td>
                          <td className="px-3 py-2.5">
                            <div className="flex items-center gap-2">
                              <span className="font-mono">{(c.size_mb || 0).toFixed(4)}</span>
                              <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden max-w-[50px]">
                                <div className="h-full rounded-full" style={{
                                  width: `${Math.min(100, ((c.size_mb || 0) / Math.max(...filtered.map(x => x.size_mb || 0), 0.001)) * 100)}%`,
                                  background: C.green
                                }} />
                              </div>
                            </div>
                          </td>
                          <td className="px-3 py-2.5 font-mono">{fmtNum(c.avgObjSize || 0)}</td>
                          <td className="px-3 py-2.5 font-mono">{c.nindexes ?? '—'}</td>
                          <td className="px-3 py-2.5 font-mono">{(c.total_index_size_mb || 0).toFixed(4)}</td>
                          <td className="px-3 py-2.5">
                            {c.capped
                              ? <span className="px-2 py-0.5 bg-yellow-100 text-yellow-700 text-[10px] font-bold rounded-full">Yes</span>
                              : <span className="text-[10px] text-slate-300">No</span>
                            }
                          </td>
                        </tr>
                      ))}
                      {filtered.length === 0 && (
                        <tr><td colSpan={8}><EmptyState message="No collections found" /></td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </Panel>

              {topBySize.length > 0 && (
                <ChartCard title="Top 10 Collections by Size (MB)">
                  <ResponsiveContainer width="100%" height={260}>
                    <BarChart layout="vertical"
                      data={topBySize.map(c => ({ name: `${c.dbName}.${c.name}`, size_mb: c.size_mb || 0 }))}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" horizontal={false} />
                      <XAxis type="number" tick={{ fontSize: 9 }} tickFormatter={v => `${v}MB`} axisLine={false} tickLine={false} />
                      <YAxis width={150} type="category" dataKey="name" tick={{ fontSize: 9 }} axisLine={false} tickLine={false} />
                      <Tooltip formatter={v => `${v} MB`} cursor={{ fill: '#f8fafc' }} />
                      <Bar dataKey="size_mb" radius={[0, 5, 5, 0]}>
                        {topBySize.map((_, i) => (
                          <Cell key={i} fill={[C.green, C.emerald, C.teal, C.blue, C.purple, C.orange, C.cyan, C.yellow, C.red, C.slate][i % 10]} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </ChartCard>
              )}
            </div>
          );
        })()}

        {/* ══ INDEXES ═══════════════════════════════════════════════════ */}
        {activeTab === 'indexes' && (() => {
          if (idxLoading) return <TabLoader />;
          const indexes      = idxData?.indexes       || [];
          const unusedIdxs   = idxData?.unused_indexes || [];
          const [idxSearch, setIdxSearch] = [collSearch, setCollSearch];
          const filtered = indexes.filter(ix =>
            !idxSearch || (ix.ns || '').toLowerCase().includes(idxSearch.toLowerCase()) ||
            (ix.name || '').toLowerCase().includes(idxSearch.toLowerCase())
          );
          return (
            <div className="space-y-5">
              <div className="grid grid-cols-3 gap-3">
                <MetricKpi title="Total Indexes"  value={indexes.length}       accent="green" />
                <MetricKpi title="Unused Indexes" value={unusedIdxs.length}    accent={unusedIdxs.length > 0 ? 'orange' : 'emerald'} />
                <MetricKpi title="Collections"    value={[...new Set(indexes.map(i => i.ns))].length} accent="blue" />
              </div>

              {unusedIdxs.length > 0 && (
                <div className="bg-yellow-50 border border-yellow-200 rounded-2xl p-4">
                  <div className="flex items-center gap-2 mb-3">
                    <AlertTriangle className="text-yellow-600" size={16} />
                    <span className="font-bold text-yellow-800 text-sm">
                      {unusedIdxs.length} Unused Index{unusedIdxs.length > 1 ? 'es' : ''} detected (0 accesses since last restart)
                    </span>
                  </div>
                  <div className="space-y-1">
                    {unusedIdxs.slice(0, 8).map((idx, i) => (
                      <div key={i} className="text-xs font-mono bg-white rounded-lg px-3 py-2 border border-yellow-100 flex items-center gap-3">
                        <span className="font-bold" style={{ color: C.darkGreen }}>{idx.ns}</span>
                        <span className="text-slate-600">{idx.name}</span>
                        <span className="text-slate-400">{JSON.stringify(idx.key || {})}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="relative max-w-sm">
                <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input value={idxSearch} onChange={e => setIdxSearch(e.target.value)}
                  placeholder="Filter by namespace or name..."
                  className="h-9 w-full pl-8 pr-4 rounded-xl border border-slate-200 text-sm outline-none focus:border-green-400" />
              </div>

              <Panel title={`All Indexes (${filtered.length})`}>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-slate-50">
                      <tr>{['Namespace', 'Index Name', 'Keys', 'Unique', 'Sparse', 'TTL (s)', 'Size', 'Accesses', 'Last Used'].map(h => (
                        <th key={h} className="px-3 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase whitespace-nowrap">{h}</th>
                      ))}</tr>
                    </thead>
                    <tbody>
                      {filtered.slice(0, 150).map((idx, i) => {
                        const idxKey = `${idx.ns}-${idx.name}`;
                        const isExpandedIdx = expandedIdxId === idxKey;
                        return (
                          <React.Fragment key={i}>
                            <tr
                              className={`border-t border-slate-100 cursor-pointer transition-colors ${isExpandedIdx ? 'bg-green-50' : idx.unused ? 'bg-yellow-50/40 hover:bg-yellow-50' : 'hover:bg-slate-50'}`}
                              onClick={() => setExpandedIdxId(isExpandedIdx ? null : idxKey)}>
                              <td className="px-3 py-2.5 font-bold" style={{ color: idx.unused ? C.orange : C.darkGreen }}>
                                <div className="flex items-center gap-1">
                                  {isExpandedIdx ? <ChevronUp size={10} className="text-green-600" /> : <ChevronDown size={10} className="text-slate-300" />}
                                  {idx.ns || `${idx.db}.${idx.collection}` || '—'}
                                </div>
                              </td>
                              <td className="px-3 py-2.5 font-mono text-xs">{idx.name}</td>
                              <td className="px-3 py-2.5 font-mono text-[10px] text-slate-500 max-w-[150px] truncate">
                                {JSON.stringify(idx.key || {})}
                              </td>
                              <td className="px-3 py-2.5">
                                {idx.unique
                                  ? <span className="px-2 py-0.5 rounded-full text-[10px] font-bold" style={{ background: 'rgba(0,237,100,0.12)', color: C.darkGreen }}>Yes</span>
                                  : <span className="text-[10px] text-slate-300">No</span>
                                }
                              </td>
                              <td className="px-3 py-2.5">
                                {idx.sparse
                                  ? <span className="px-2 py-0.5 bg-blue-100 text-blue-700 text-[10px] font-bold rounded-full">Yes</span>
                                  : <span className="text-[10px] text-slate-300">No</span>
                                }
                              </td>
                              <td className="px-3 py-2.5 font-mono text-[10px]">
                                {idx.expireAfterSeconds != null ? idx.expireAfterSeconds : '—'}
                              </td>
                              <td className="px-3 py-2.5 font-mono">{idx.size ? fmtBytes(idx.size) : '—'}</td>
                              <td className={`px-3 py-2.5 font-bold font-mono ${idx.unused ? 'text-orange-500' : 'text-slate-700'}`}>
                                {fmtNum(idx.accesses ?? 0)}
                              </td>
                              <td className="px-3 py-2.5 text-[10px] text-slate-400 whitespace-nowrap">
                                {idx.last_access ? new Date(idx.last_access).toLocaleDateString() : '—'}
                              </td>
                            </tr>
                            {isExpandedIdx && (
                              <tr>
                                <td colSpan={9} className="p-0">
                                  <IndexDetailPanel idx={idx} />
                                </td>
                              </tr>
                            )}
                          </React.Fragment>
                        );
                      })}
                      {filtered.length === 0 && (
                        <tr><td colSpan={9}><EmptyState icon={Key} message="No index data available" /></td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </Panel>
            </div>
          );
        })()}

        {/* ══ REPLICATION ═══════════════════════════════════════════════ */}
        {activeTab === 'replication' && (() => {
          if (replLoading) return <TabLoader />;
          const rep      = replData || {};
          const members  = rep.members || [];
          const oplogInfo = rep.oplog || {};
          const lagData  = rep.replication_lag || [];
          const isRS     = rep.is_replica_set;

          return (
            <div className="space-y-5">
              {/* Status header */}
              <Panel>
                <div className="flex items-center gap-3 mb-5">
                  <GitBranch style={{ color: C.green }} size={22} />
                  <h2 className="text-lg font-bold text-slate-800">Replication Status</h2>
                  <span className={`px-3 py-1 rounded-full text-xs font-bold border ${
                    isRS ? 'bg-green-50 border-green-200 text-green-700' : 'bg-slate-100 border-slate-200 text-slate-600'}`}>
                    {rep.set_name ? `Replica Set: ${rep.set_name}` : 'Standalone Instance'}
                  </span>
                  <ReplicaStateBadge state={rep.state || (isRS ? 'UNKNOWN' : 'STANDALONE')} />
                </div>

                {!isRS ? (
                  <EmptyState icon={GitBranch} message="Standalone instance — no replica set detected"
                    sub="Initiate a replica set with rs.initiate() to enable replication." />
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-slate-50">
                        <tr>{['Host', 'State', 'Health', 'Uptime', 'Optime Date', 'Lag (s)', 'Priority', 'Votes', 'Syncing To'].map(h => (
                          <th key={h} className="px-4 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase whitespace-nowrap">{h}</th>
                        ))}</tr>
                      </thead>
                      <tbody>
                        {members.map((m, i) => (
                          <tr key={i} className={`border-t border-slate-100 hover:bg-slate-50 ${m.health !== 1 ? 'bg-red-50/30' : ''}`}>
                            <td className="px-4 py-3 font-mono text-xs font-bold" style={{ color: C.darkGreen }}>
                              {m.name}{m.self ? ' (me)' : ''}
                            </td>
                            <td className="px-4 py-3">
                              <ReplicaStateBadge state={m.stateStr} />
                            </td>
                            <td className="px-4 py-3">
                              {m.health === 1
                                ? <CheckCircle2 className="text-green-500" size={15} />
                                : <XCircle className="text-red-500" size={15} />
                              }
                            </td>
                            <td className="px-4 py-3 text-xs text-slate-500">{m.uptime ? fmtUptime(m.uptime) : '—'}</td>
                            <td className="px-4 py-3 font-mono text-[10px] text-slate-400 max-w-[160px] truncate">
                              {m.optimeDate || m.optime || '—'}
                            </td>
                            <td className={`px-4 py-3 font-bold text-sm ${(m.lag || 0) > 30 ? 'text-red-600' : (m.lag || 0) > 10 ? 'text-orange-500' : 'text-slate-600'}`}>
                              {m.stateStr === 'PRIMARY' ? '—' : (m.lag ?? 0) + 's'}
                            </td>
                            <td className="px-4 py-3 text-xs text-slate-500">{m.priority ?? 1}</td>
                            <td className="px-4 py-3 text-xs text-slate-500">{m.votes ?? 1}</td>
                            <td className="px-4 py-3 text-xs text-slate-400">{m.syncSourceHost || m.syncingTo || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Panel>

              {isRS && (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <div className="rounded-xl border bg-green-50 border-green-200 p-4">
                    <p className="text-[10px] font-bold text-slate-400 uppercase mb-1">Set Name</p>
                    <p className="font-black text-lg text-green-700">{rep.set_name || '—'}</p>
                  </div>
                  <div className="rounded-xl border bg-slate-50 border-slate-200 p-4">
                    <p className="text-[10px] font-bold text-slate-400 uppercase mb-1">Members</p>
                    <p className="font-black text-lg text-slate-700">{members.length}</p>
                  </div>
                  <div className={`rounded-xl border p-4 ${members.every(m => m.health === 1) ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}`}>
                    <p className="text-[10px] font-bold text-slate-400 uppercase mb-1">Healthy</p>
                    <p className={`font-black text-lg ${members.every(m => m.health === 1) ? 'text-green-700' : 'text-red-700'}`}>
                      {members.filter(m => m.health === 1).length}/{members.length}
                    </p>
                  </div>
                  <div className={`rounded-xl border p-4 ${!oplogInfo.error ? 'bg-green-50 border-green-200' : 'bg-slate-50 border-slate-200'}`}>
                    <p className="text-[10px] font-bold text-slate-400 uppercase mb-1">Oplog Window</p>
                    <p className={`font-black text-lg ${!oplogInfo.error ? 'text-green-700' : 'text-slate-400'}`}>
                      {oplogInfo.oplog_window_hours ? `${oplogInfo.oplog_window_hours}h` : '—'}
                    </p>
                  </div>
                </div>
              )}

              {isRS && oplogInfo && !oplogInfo.error && (
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                  <Panel title="Oplog Stats">
                    <Row label="Size"          value={`${oplogInfo.size_mb || 0} MB`} />
                    <Row label="Used"          value={`${oplogInfo.used_mb || 0} MB`} />
                    <Row label="Window (hrs)"  value={oplogInfo.oplog_window_hours ? `${oplogInfo.oplog_window_hours}h` : '—'} />
                    <Row label="Entry Count"   value={fmtNum(oplogInfo.count || 0)} />
                    <Row label="First TS"      value={oplogInfo.first_ts ? new Date(oplogInfo.first_ts * 1000).toLocaleString() : '—'} />
                    <Row label="Last TS"       value={oplogInfo.last_ts  ? new Date(oplogInfo.last_ts  * 1000).toLocaleString() : '—'} />
                  </Panel>

                  {lagData.length > 0 && (
                    <ChartCard title="Replication Lag per Secondary (seconds)">
                      <ResponsiveContainer width="100%" height={180}>
                        <BarChart data={lagData.map(l => ({ name: l.member, lag: l.lag_seconds }))}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                          <XAxis dataKey="name" tick={{ fontSize: 10 }} axisLine={false} tickLine={false} />
                          <YAxis tick={{ fontSize: 9 }} axisLine={false} tickLine={false} />
                          <Tooltip formatter={v => `${v}s`} cursor={{ fill: '#f8fafc' }} />
                          <Bar dataKey="lag" radius={[5, 5, 0, 0]}>
                            {lagData.map((l, i) => (
                              <Cell key={i} fill={l.lag_seconds > 30 ? C.red : l.lag_seconds > 10 ? C.orange : C.green} />
                            ))}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </ChartCard>
                  )}
                </div>
              )}
            </div>
          );
        })()}

        {/* ══ OPLOG ═════════════════════════════════════════════════════ */}
        {activeTab === 'oplog' && (() => {
          if (oplogLoading) return <TabLoader />;
          const og = oplogData || {};
          // Standalone server (no replica set) → there is no oplog. Explain clearly.
          if (og.status === 'standalone' || og.is_replica_set === false) return (
            <div className="bg-blue-50 border border-blue-200 rounded-2xl p-10 text-center max-w-2xl mx-auto">
              <Archive className="mx-auto text-blue-400 mb-3" size={40} />
              <p className="font-black text-blue-800 text-lg">No oplog — standalone MongoDB</p>
              <p className="text-sm text-blue-700 mt-2">
                {og.note || 'This MongoDB is running as a standalone server (not a replica set), so it has no oplog.'}
              </p>
              <p className="text-xs text-slate-500 mt-3">
                The oplog (operations log) is created only when MongoDB runs as part of a replica set.
                Convert this server to a replica set to enable replication, the oplog and point-in-time features.
              </p>
            </div>
          );
          if (og.error && og.status === 'error') return (
            <div className="bg-yellow-50 border border-yellow-200 rounded-2xl p-8 text-center">
              <Archive className="mx-auto text-yellow-400 mb-3" size={36} />
              <p className="font-bold text-yellow-700">Oplog Unavailable</p>
              <p className="text-sm text-yellow-600 mt-1">{og.error || og.note}</p>
              <p className="text-xs text-slate-400 mt-2">Oplog requires a replica set (oplog.rs collection in local db)</p>
            </div>
          );
          const opTypeData = Object.entries(og.op_types || {}).map(([k, v]) => ({ name: k, count: v }));
          const usedPct = og.used_pct || 0;

          return (
            <div className="space-y-5">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <MetricKpi title="Size"          value={`${og.size_mb || 0} MB`}      accent="blue" />
                <MetricKpi title="Used"          value={`${og.used_mb || 0} MB`}      accent={usedPct > 80 ? 'orange' : 'green'} />
                <MetricKpi title="Used %"        value={`${usedPct}%`}                 accent={usedPct > 80 ? 'red' : 'emerald'} />
                <MetricKpi title="Window"        value={og.oplog_window_hours ? `${og.oplog_window_hours}h` : '—'} accent="teal" />
              </div>

              <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                <Panel title="Oplog Details">
                  <div className="mb-4">
                    <div className="flex justify-between text-xs text-slate-500 mb-1">
                      <span>Oplog Used</span>
                      <span className="font-black">{usedPct}%</span>
                    </div>
                    <div className="h-3 bg-slate-100 rounded-full overflow-hidden">
                      <div className="h-full rounded-full transition-all duration-500"
                        style={{ width: `${usedPct}%`, background: usedPct > 80 ? C.red : usedPct > 60 ? C.orange : C.green }} />
                    </div>
                  </div>
                  <Row label="Total Size"     value={fmtBytes(og.size_bytes || 0)} />
                  <Row label="Used Size"      value={fmtBytes(og.used_bytes || 0)} />
                  <Row label="Oplog Window"   value={og.oplog_window_hours ? `${og.oplog_window_hours} hours` : '—'} />
                  <Row label="Entry Count"    value={fmtNum(og.count || 0)} />
                  <Row label="First Entry"    value={og.first_ts ? new Date(og.first_ts * 1000).toLocaleString() : '—'} />
                  <Row label="Last Entry"     value={og.last_ts  ? new Date(og.last_ts  * 1000).toLocaleString() : '—'} />
                </Panel>

                {opTypeData.length > 0 && (
                  <ChartCard title="Oplog Operation Breakdown">
                    <ResponsiveContainer width="100%" height={220}>
                      <PieChart>
                        <Pie data={opTypeData} dataKey="count" nameKey="name" cx="50%" cy="50%" outerRadius={80} label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}>
                          {opTypeData.map((_, i) => (
                            <Cell key={i} fill={[C.green, C.blue, C.red, C.orange, C.purple, C.teal][i % 6]} />
                          ))}
                        </Pie>
                        <Tooltip formatter={v => fmtNum(v)} />
                      </PieChart>
                    </ResponsiveContainer>
                  </ChartCard>
                )}
              </div>

              {(og.recent_entries || []).length > 0 && (
                <Panel title={`Recent Oplog Entries (last ${og.recent_entries.length})`}>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead className="bg-slate-50">
                        <tr>{['Timestamp', 'Op', 'Namespace', 'Wall', 'Object (truncated)'].map(h => (
                          <th key={h} className="px-3 py-2 text-left text-[10px] font-bold text-slate-400 uppercase">{h}</th>
                        ))}</tr>
                      </thead>
                      <tbody>
                        {og.recent_entries.slice(0, 50).map((e, i) => (
                          <tr key={i} className="border-t border-slate-100 hover:bg-slate-50">
                            <td className="px-3 py-2 font-mono text-slate-400 whitespace-nowrap">
                              {e.ts ? new Date(e.ts * 1000).toLocaleString() : '—'}
                            </td>
                            <td className="px-3 py-2">
                              <span className="px-2 py-0.5 rounded text-[9px] font-bold"
                                style={{ background: 'rgba(0,237,100,0.1)', color: C.darkGreen }}>
                                {({ i: 'insert', u: 'update', d: 'delete', c: 'command', n: 'noop' })[e.op] || e.op || '—'}
                              </span>
                            </td>
                            <td className="px-3 py-2 font-mono text-slate-500">{e.ns || '—'}</td>
                            <td className="px-3 py-2 text-slate-400 whitespace-nowrap text-[10px]">{e.wall || '—'}</td>
                            <td className="px-3 py-2 font-mono text-[10px] text-slate-400 max-w-[260px] truncate">{e.o}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Panel>
              )}
            </div>
          );
        })()}

        {/* ══ SHARDING ══════════════════════════════════════════════════ */}
        {activeTab === 'sharding' && (() => {
          if (shardLoading) return <TabLoader />;
          const sh = shardData || {};

          if (!sh.enabled) return (
            <div className="space-y-4">
              <div className="bg-white rounded-2xl border border-slate-200 p-10 text-center">
                <Network size={48} className="mx-auto text-slate-200 mb-4" />
                <p className="font-bold text-slate-600 text-lg">Standalone / Replica Set</p>
                <p className="text-slate-400 text-sm mt-2">This MongoDB instance is not running as a sharded cluster.</p>
                <p className="text-slate-400 text-xs mt-1">Sharding requires a mongos router process.</p>
                <div className="mt-6 inline-block px-4 py-2 rounded-xl border border-slate-200 text-xs text-slate-500">
                  Process: <span className="font-mono font-bold">{sh.process || 'mongod'}</span>
                </div>
              </div>
            </div>
          );

          const chunks = sh.chunks_per_shard || {};
          const chunkData = Object.entries(chunks).map(([shard, count]) => ({ shard, count }));
          const balancer = sh.balancer_status || {};

          return (
            <div className="space-y-5">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <MetricKpi title="Shards"           value={sh.shards_count || 0}          accent="green" />
                <MetricKpi title="Sharded DBs"      value={(sh.databases || []).filter(d => d.partitioned).length} accent="blue" />
                <MetricKpi title="Balancer"         value={balancer.mode || (balancer.inBalancerRound ? 'Running' : 'Idle')} accent={balancer.inBalancerRound ? 'orange' : 'emerald'} />
                <MetricKpi title="Config Servers"   value={(sh.config_servers || []).length} accent="purple" />
              </div>

              <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                <Panel title={`Shards (${(sh.shards || []).length})`}>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead className="bg-slate-50">
                        <tr>{['Shard ID', 'Host', 'State', 'Tags', 'Chunks'].map(h => (
                          <th key={h} className="px-3 py-2 text-left text-[10px] font-bold text-slate-400 uppercase">{h}</th>
                        ))}</tr>
                      </thead>
                      <tbody>
                        {(sh.shards || []).map((s, i) => (
                          <tr key={i} className="border-t border-slate-100 hover:bg-slate-50">
                            <td className="px-3 py-2.5 font-bold" style={{ color: C.darkGreen }}>{s.id}</td>
                            <td className="px-3 py-2.5 font-mono text-[10px]">{s.host}</td>
                            <td className="px-3 py-2.5">
                              <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold ${s.state === 1 ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                                {s.state === 1 ? 'Active' : 'Inactive'}
                              </span>
                            </td>
                            <td className="px-3 py-2.5 text-slate-400">{(s.tags || []).join(', ') || '—'}</td>
                            <td className="px-3 py-2.5 font-mono font-bold">{chunks[s.id] || 0}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Panel>

                {chunkData.length > 0 && (
                  <ChartCard title="Chunk Distribution per Shard">
                    <ResponsiveContainer width="100%" height={200}>
                      <BarChart data={chunkData}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                        <XAxis dataKey="shard" tick={{ fontSize: 10 }} axisLine={false} tickLine={false} />
                        <YAxis tick={{ fontSize: 9 }} axisLine={false} tickLine={false} />
                        <Tooltip cursor={{ fill: '#f8fafc' }} />
                        <Bar dataKey="count" radius={[5, 5, 0, 0]} fill={C.green} />
                      </BarChart>
                    </ResponsiveContainer>
                  </ChartCard>
                )}
              </div>

              <Panel title="Balancer Status">
                <Row label="Mode"            value={balancer.mode || '—'} />
                <Row label="In Balancer Round" value={String(balancer.inBalancerRound || false)} />
                <Row label="Num Migrations Since Last Round" value={balancer.numMigrationsAtLastRound ?? '—'} />
                {balancer.error && <Row label="Error" value={balancer.error} />}
              </Panel>
            </div>
          );
        })()}

        {/* ══ TRANSACTIONS ══════════════════════════════════════════════ */}
        {activeTab === 'transactions' && (() => {
          if (txnLoading) return <TabLoader />;
          const txn = txnData || {};

          if (!txn.available) return (
            <div className="bg-white rounded-2xl border border-slate-200 p-10 text-center">
              <RotateCcw size={48} className="mx-auto text-slate-200 mb-4" />
              <p className="font-bold text-slate-600 text-lg">MongoDB 4.0+ Required</p>
              <p className="text-slate-400 text-sm mt-2">Multi-document transaction metrics require MongoDB 4.0 or higher.</p>
              <p className="text-xs text-slate-400 mt-1">{txn.note}</p>
            </div>
          );

          const t = txn.transactions || {};
          return (
            <div className="space-y-5">
              {txn.note && (
                <div className={`rounded-2xl border p-4 flex items-start gap-3 ${txn.is_replica_set === false ? 'bg-blue-50 border-blue-200' : 'bg-slate-50 border-slate-200'}`}>
                  <RotateCcw size={18} className={`mt-0.5 flex-shrink-0 ${txn.is_replica_set === false ? 'text-blue-500' : 'text-slate-400'}`} />
                  <div>
                    <p className={`font-bold text-sm ${txn.is_replica_set === false ? 'text-blue-800' : 'text-slate-600'}`}>
                      {txn.is_replica_set === false ? 'Standalone MongoDB — transactions need a replica set' : 'No transactions recorded yet'}
                    </p>
                    <p className={`text-xs mt-0.5 ${txn.is_replica_set === false ? 'text-blue-700' : 'text-slate-500'}`}>{txn.note}</p>
                  </div>
                </div>
              )}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <MetricKpi title="Current Active"   value={t.currentActive   ?? 0} accent={t.currentActive > 0 ? 'blue' : 'slate'} />
                <MetricKpi title="Current Open"     value={t.currentOpen     ?? 0} accent={t.currentOpen > 5 ? 'orange' : 'green'} />
                <MetricKpi title="Current Prepared" value={t.currentPrepared ?? 0} accent={t.currentPrepared > 0 ? 'purple' : 'slate'} />
                <MetricKpi title="Current Inactive" value={t.currentInactive ?? 0} accent="slate" />
              </div>

              <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                <Panel title="Transaction Counters">
                  <Row label="Total Started"                value={fmtNum(t.totalStarted || 0)} />
                  <Row label="Total Committed"              value={fmtNum(t.totalCommitted || 0)} />
                  <Row label="Total Aborted"                value={fmtNum(t.totalAborted || 0)} />
                  <Row label="Total Contacted Participants" value={fmtNum(t.totalContactedParticipants || 0)} />
                  <Row label="Total Participants at Commit" value={fmtNum(t.totalParticipantsAtCommit || 0)} />
                  <Row label="Total Requests Targeted"      value={fmtNum(t.totalRequestsTargeted || 0)} />
                </Panel>

                <div className="space-y-4">
                  <GaugeCard
                    title="Commit Rate"
                    pct={txn.commit_rate || 0}
                    sub={`${fmtNum(t.totalCommitted || 0)} committed / ${fmtNum(t.totalStarted || 0)} started`}
                    colorFn={v => v < 50 ? C.red : v < 80 ? C.orange : C.green}
                  />
                  <GaugeCard
                    title="Abort Rate"
                    pct={txn.abort_rate || 0}
                    sub={`${fmtNum(t.totalAborted || 0)} aborted / ${fmtNum(t.totalStarted || 0)} started`}
                    colorFn={v => v > 20 ? C.red : v > 10 ? C.orange : C.green}
                  />
                </div>
              </div>

              {/* Active / prepared trend */}
              <ChartCard title="Transaction State Distribution">
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={[
                    { name: 'Active',   count: t.currentActive   || 0 },
                    { name: 'Open',     count: t.currentOpen     || 0 },
                    { name: 'Inactive', count: t.currentInactive || 0 },
                    { name: 'Prepared', count: t.currentPrepared || 0 },
                  ]}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                    <XAxis dataKey="name" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 10 }} axisLine={false} tickLine={false} />
                    <Tooltip cursor={{ fill: '#f8fafc' }} />
                    <Bar dataKey="count" radius={[6, 6, 0, 0]}>
                      <Cell fill={C.blue} />
                      <Cell fill={C.green} />
                      <Cell fill={C.slate} />
                      <Cell fill={C.purple} />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </ChartCard>
            </div>
          );
        })()}

        {/* ══ WIREDTIGER ════════════════════════════════════════════════ */}
        {activeTab === 'wiredtiger' && (() => {
          if (wtLoading) return <TabLoader />;
          const wt = wtData || {};

          if (!wt.available) return (
            <div className="bg-white rounded-2xl border border-slate-200 p-10 text-center">
              <Cpu size={48} className="mx-auto text-slate-200 mb-4" />
              <p className="font-bold text-slate-600">WiredTiger Not Available</p>
              <p className="text-slate-400 text-sm mt-2">{wt.note || 'WiredTiger is not the active storage engine.'}</p>
            </div>
          );

          const cache   = wt.cache   || {};
          const ct      = wt.concurrent_transactions || {};
          const bm      = wt.block_manager || {};
          const log     = wt.log    || {};
          const sess    = wt.session || {};
          const wtTxn   = wt.transactions || {};

          const cacheUsedPct  = cache.cache_used_pct  || 0;
          const readAvail     = ct.read?.available  || 0;
          const readOut       = ct.read?.out        || 0;
          const readTotal     = ct.read?.totalTickets || 128;
          const readUsedPct   = Math.min(100, Math.round((readOut / Math.max(readTotal, 1)) * 100));
          const writeAvail    = ct.write?.available || 0;
          const writeOut      = ct.write?.out       || 0;
          const writeTotal    = ct.write?.totalTickets || 128;
          const writeUsedPct  = Math.min(100, Math.round((writeOut / Math.max(writeTotal, 1)) * 100));

          return (
            <div className="space-y-5">
              {/* Gauges row */}
              <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
                <GaugeCard
                  title="Cache Used %"
                  pct={cacheUsedPct}
                  sub={`${cache.cache_used_mb || 0} MB / ${cache.cache_max_mb || 0} MB`}
                  colorFn={v => v > 85 ? C.red : v > 70 ? C.orange : C.green}
                />
                <GaugeCard
                  title="Read Tickets Used %"
                  pct={readUsedPct}
                  sub={`${readOut} out / ${readTotal} total (${readAvail} available)`}
                  colorFn={v => v > 80 ? C.red : v > 60 ? C.orange : C.green}
                />
                <GaugeCard
                  title="Write Tickets Used %"
                  pct={writeUsedPct}
                  sub={`${writeOut} out / ${writeTotal} total (${writeAvail} available)`}
                  colorFn={v => v > 80 ? C.red : v > 60 ? C.orange : C.orange}
                />
                <GaugeCard
                  title="WT Cache Dirty %"
                  pct={cache.maximum_bytes_configured > 0 ? Math.round(((cache.tracked_dirty_bytes_in_cache || 0) / cache.maximum_bytes_configured) * 100) : 0}
                  sub={`${((cache.tracked_dirty_bytes_in_cache || 0) / 1024 / 1024).toFixed(2)} MB dirty`}
                  colorFn={v => v > 20 ? C.red : v > 10 ? C.orange : C.green}
                />
              </div>

              <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
                <Panel title="Cache Statistics">
                  <Row label="Bytes in Cache"     value={fmtBytes(cache.bytes_currently_in_cache || 0)} />
                  <Row label="Max Cache"          value={fmtBytes(cache.maximum_bytes_configured  || 0)} />
                  <Row label="Cache Used"         value={`${cacheUsedPct}%`} />
                  <Row label="Dirty Bytes"        value={fmtBytes(cache.tracked_dirty_bytes_in_cache || 0)} />
                  <Row label="Pages Read"         value={fmtNum(cache.pages_read_into_cache      || 0)} />
                  <Row label="Pages Written"      value={fmtNum(cache.pages_written_from_cache   || 0)} />
                  <Row label="Pages Requested"    value={fmtNum(cache.pages_requested_from_cache || 0)} />
                  <Row label="Bytes Read to Cache" value={fmtBytes(cache.bytes_read_into_cache    || 0)} />
                  <Row label="Bytes Written"      value={fmtBytes(cache.bytes_written_from_cache || 0)} />
                  <Row label="Unmod Pages Evicted" value={fmtNum(cache.unmodified_pages_evicted  || 0)} />
                </Panel>

                <Panel title="Block Manager">
                  <Row label="Blocks Read"     value={fmtNum(bm.blocks_read    || 0)} />
                  <Row label="Blocks Written"  value={fmtNum(bm.blocks_written || 0)} />
                  <Row label="Bytes Read"      value={fmtBytes(bm.bytes_read   || 0)} />
                  <Row label="Bytes Written"   value={fmtBytes(bm.bytes_written || 0)} />
                  <Row label="Bytes for Ckpt"  value={fmtBytes(bm.bytes_written_for_checkpoint || 0)} />
                  <Row label="Mapped Bytes Read"  value={fmtBytes(bm.mapped_bytes_read || 0)} />
                  <Row label="Mapped Blocks Read" value={fmtNum(bm.mapped_blocks_read || 0)} />
                </Panel>

                <Panel title="Log & Session">
                  <p className="text-[10px] font-bold text-slate-400 uppercase mb-2">Log</p>
                  <Row label="Records Processed" value={fmtNum(log.log_records_processed || 0)} />
                  <Row label="Payload Bytes"     value={fmtBytes(log.log_bytes_of_payload_data || 0)} />
                  <Row label="Bytes Written"     value={fmtBytes(log.log_bytes_written || 0)} />
                  <Row label="Log Flushes"       value={fmtNum(log.log_flushes || 0)} />
                  <Row label="Log Writes"        value={fmtNum(log.log_writes  || 0)} />
                  <Row label="Scan Operations"   value={fmtNum(log.log_scan_operations || 0)} />
                  <p className="text-[10px] font-bold text-slate-400 uppercase mt-4 mb-2">Session</p>
                  <Row label="Open Cursors"      value={fmtNum(sess.open_cursor_count  || 0)} />
                  <Row label="Open Sessions"     value={fmtNum(sess.open_session_count || 0)} />
                </Panel>
              </div>

              {/* Concurrent transactions table */}
              <Panel title="Concurrent Transaction Tickets">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50">
                      <tr>{['Type', 'Available', 'In Use', 'Total Tickets', 'Used %'].map(h => (
                        <th key={h} className="px-4 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase">{h}</th>
                      ))}</tr>
                    </thead>
                    <tbody>
                      {[
                        { type: 'Read',  avail: readAvail,  out: readOut,  total: readTotal,  pct: readUsedPct  },
                        { type: 'Write', avail: writeAvail, out: writeOut, total: writeTotal, pct: writeUsedPct },
                      ].map((row, i) => (
                        <tr key={i} className="border-t border-slate-100">
                          <td className="px-4 py-3 font-bold" style={{ color: C.darkGreen }}>{row.type}</td>
                          <td className="px-4 py-3 font-mono text-green-600 font-bold">{row.avail}</td>
                          <td className={`px-4 py-3 font-mono font-bold ${row.pct > 80 ? 'text-red-600' : row.pct > 60 ? 'text-orange-600' : 'text-slate-700'}`}>{row.out}</td>
                          <td className="px-4 py-3 font-mono">{row.total}</td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2">
                              <div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden max-w-[80px]">
                                <div className="h-full rounded-full"
                                  style={{ width: `${row.pct}%`, background: row.pct > 80 ? C.red : row.pct > 60 ? C.orange : C.green }} />
                              </div>
                              <span className="text-xs font-bold">{row.pct}%</span>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Panel>

              <Panel title="WiredTiger Transactions (engine-level)">
                <Row label="Transaction Begins"       value={fmtNum(wtTxn.transaction_begins       || 0)} />
                <Row label="Transactions Committed"   value={fmtNum(wtTxn.transactions_committed   || 0)} />
                <Row label="Transactions Rolled Back" value={fmtNum(wtTxn.transactions_rolled_back || 0)} />
                <Row label="Transaction Checkpoints"  value={fmtNum(wtTxn.transaction_checkpoints  || 0)} />
              </Panel>
            </div>
          );
        })()}

        {/* ══ USERS ════════════════════════════════════════════════════ */}
        {activeTab === 'users' && (() => {
          if (usersLoading) return <TabLoader />;
          const users = usersData?.users || [];
          const errors = usersData?.errors || [];
          const dbGroups = {};
          users.forEach(u => {
            if (!dbGroups[u.db]) dbGroups[u.db] = [];
            dbGroups[u.db].push(u);
          });
          const roleColor = role => {
            if (role.includes('root') || role.includes('Admin')) return 'bg-red-100 text-red-700 border-red-200';
            if (role.includes('readWrite') || role.includes('dbOwner')) return 'bg-blue-100 text-blue-700 border-blue-200';
            if (role.includes('read')) return 'bg-slate-100 text-slate-600 border-slate-200';
            if (role.includes('cluster')) return 'bg-purple-100 text-purple-700 border-purple-200';
            return 'bg-slate-100 text-slate-600 border-slate-200';
          };
          return (
            <div className="space-y-4">
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                <MetricKpi title="Total Users"     value={users.length}              accent="green" />
                <MetricKpi title="Databases"       value={Object.keys(dbGroups).length} accent="blue" />
                <MetricKpi title="Root/Admin"      value={users.filter(u => u.roles.some(r => r.role.includes('root') || r.role.includes('Admin'))).length} accent={users.filter(u => u.roles.some(r => r.role.includes('root') || r.role.includes('Admin'))).length > 2 ? 'red' : 'teal'} />
              </div>

              {errors.length > 0 && (
                <Panel>
                  <div className="flex items-start gap-3">
                    <AlertTriangle size={16} className="text-orange-500 flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="font-bold text-slate-800 text-sm">Partial data — some databases inaccessible</p>
                      {errors.map((e, i) => <p key={i} className="text-xs text-slate-500 mt-1 font-mono">{e}</p>)}
                    </div>
                  </div>
                </Panel>
              )}

              {Object.entries(dbGroups).sort(([a],[b]) => a.localeCompare(b)).map(([dbName, dbUsers]) => (
                <Panel key={dbName} title={`${dbName} (${dbUsers.length} user${dbUsers.length !== 1 ? 's' : ''})`}
                  action={
                    <span className="text-[10px] font-bold bg-green-50 text-green-700 border border-green-200 px-2 py-0.5 rounded-full">{dbName}</span>
                  }>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead className="bg-slate-50">
                        <tr>
                          {['Username', 'Roles', 'User ID'].map(h => (
                            <th key={h} className="px-3 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase whitespace-nowrap">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {dbUsers.map((u, i) => (
                          <tr key={i} className="border-t border-slate-100 hover:bg-slate-50">
                            <td className="px-3 py-2.5 font-bold text-slate-800">{u.username || '—'}</td>
                            <td className="px-3 py-2.5">
                              <div className="flex flex-wrap gap-1">
                                {(u.roles || []).length === 0 ? (
                                  <span className="text-slate-400 text-[10px]">No roles</span>
                                ) : (u.roles || []).map((r, ri) => (
                                  <span key={ri}
                                    className={`px-2 py-0.5 rounded border text-[9px] font-bold ${roleColor(r.role)}`}>
                                    {r.role}{r.db && r.db !== u.db ? `@${r.db}` : ''}
                                  </span>
                                ))}
                              </div>
                            </td>
                            <td className="px-3 py-2.5 font-mono text-[10px] text-slate-400 truncate max-w-[180px]">{u.userId || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Panel>
              ))}

              {users.length === 0 && !usersLoading && (
                <EmptyState icon={Users} message="No users found"
                  sub="Ensure the connection has admin privileges to list users" />
              )}

              <div className="flex justify-end">
                <button onClick={refetchUsers}
                  className="flex items-center gap-2 px-4 py-2 bg-white border border-slate-200 rounded-xl text-xs font-semibold text-slate-600 hover:bg-slate-50 transition-all">
                  <RefreshCw size={12} className={usersLoading ? 'animate-spin' : ''} /> Refresh Users
                </button>
              </div>
            </div>
          );
        })()}

        {/* ══ SLOW QUERIES ══════════════════════════════════════════════ */}
        {activeTab === 'slowqueries' && (() => {
          if (slowLoading) return <TabLoader />;
          const allOps = slowData?.all_ops || [];
          const filtered = allOps.filter(op => {
            const ms      = op.millis || (op.secs_running || 0) * 1000;
            const matchMs = ms >= msThreshold;
            const matchNs = !nsFilter || (op.ns || '').toLowerCase().includes(nsFilter.toLowerCase());
            return matchMs && matchNs;
          });
          return (
            <div className="space-y-5">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <MetricKpi title="Slow Ops Total"    value={allOps.length}            accent={allOps.length > 0 ? 'red' : 'green'} />
                <MetricKpi title="From CurrentOp"   value={(slowData?.current_ops || []).length} accent="orange" />
                <MetricKpi title="From Profiler"     value={(slowData?.profile_ops  || []).length} accent="blue" />
                <MetricKpi title="After Filter"      value={filtered.length}          accent="slate" />
              </div>

              {/* Filter controls */}
              <div className="flex items-center gap-3 flex-wrap bg-white rounded-2xl border border-slate-200 p-4">
                <div className="relative">
                  <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input value={nsFilter} onChange={e => setNsFilter(e.target.value)}
                    placeholder="Filter by namespace..."
                    className="h-9 pl-8 pr-4 w-48 rounded-xl border border-slate-200 text-sm outline-none focus:border-green-400" />
                </div>
                <div className="flex items-center gap-2">
                  <Clock size={13} className="text-slate-400" />
                  <span className="text-xs text-slate-500 font-semibold">Min ms:</span>
                  <input type="number" value={msThreshold} onChange={e => setMsThreshold(Number(e.target.value) || 0)}
                    className="h-9 w-20 px-3 rounded-xl border border-slate-200 text-sm outline-none focus:border-green-400" />
                </div>
                <span className="text-xs text-slate-400">{filtered.length} results</span>
              </div>

              <Panel title={`Slow Operations (>${msThreshold}ms)`}>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-slate-50">
                      <tr>{['Source', 'Op', 'Namespace', 'Duration', 'Docs Exam.', 'Keys Exam.', 'Plan', 'Client', 'Timestamp'].map(h => (
                        <th key={h} className="px-3 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase whitespace-nowrap">{h}</th>
                      ))}</tr>
                    </thead>
                    <tbody>
                      {filtered.slice(0, 100).map((op, i) => {
                        const ms = op.millis || (op.secs_running || 0) * 1000;
                        return (
                          <tr key={i} className={`border-t border-slate-100 hover:bg-slate-50 ${ms > 5000 ? 'bg-red-50/40' : ms > 1000 ? 'bg-yellow-50/40' : ''}`}>
                            <td className="px-3 py-2.5">
                              <span className={`px-2 py-0.5 rounded text-[9px] font-bold ${op.source === 'currentOp' ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-600'}`}>
                                {op.source || '—'}
                              </span>
                            </td>
                            <td className="px-3 py-2.5">
                              <span className="px-2 py-0.5 rounded-full text-[9px] font-bold"
                                style={{ background: 'rgba(0,237,100,0.1)', color: C.darkGreen }}>
                                {op.op || op.type || '—'}
                              </span>
                            </td>
                            <td className="px-3 py-2.5 font-mono text-slate-500 max-w-[180px] truncate">{op.ns || '—'}</td>
                            <td className={`px-3 py-2.5 font-bold ${ms > 5000 ? 'text-red-600' : ms > 1000 ? 'text-orange-600' : 'text-slate-700'}`}>
                              {ms > 0 ? `${ms}ms` : `${op.secs_running || 0}s`}
                            </td>
                            <td className="px-3 py-2.5 font-mono">{fmtNum(op.docsExamined || 0)}</td>
                            <td className="px-3 py-2.5 font-mono">{fmtNum(op.keysExamined || 0)}</td>
                            <td className="px-3 py-2.5 text-[10px] text-slate-400 max-w-[120px] truncate">{op.planSummary || '—'}</td>
                            <td className="px-3 py-2.5 text-[10px] text-slate-400 max-w-[100px] truncate">{op.client || '—'}</td>
                            <td className="px-3 py-2.5 font-mono text-[9px] text-slate-400 whitespace-nowrap">{op.ts || '—'}</td>
                          </tr>
                        );
                      })}
                      {filtered.length === 0 && (
                        <tr><td colSpan={9}>
                          <EmptyState icon={Clock} message={`No slow operations above ${msThreshold}ms`}
                            sub="Reduce threshold or enable profiling to capture more data" />
                        </td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </Panel>
            </div>
          );
        })()}

        {/* ══ ERROR LOGS ════════════════════════════════════════════════ */}
        {activeTab === 'errorlogs' && (() => {
          if (errorLogsLoading) return <TabLoader />;
          const el     = errorLogsData || {};
          const logs   = el.all_logs    || [];
          const sevCounts = el.severity_counts || {};

          const SEV_CFG = {
            F: { label: 'Fatal',   color: 'text-red-700',   bg: 'bg-red-100',   border: 'border-red-300',   strip: 'bg-red-600'  },
            E: { label: 'Error',   color: 'text-red-600',   bg: 'bg-red-50',    border: 'border-red-200',   strip: 'bg-red-400'  },
            W: { label: 'Warning', color: 'text-amber-600', bg: 'bg-amber-50',  border: 'border-amber-200', strip: 'bg-amber-400'},
            I: { label: 'Info',    color: 'text-blue-600',  bg: 'bg-blue-50',   border: 'border-blue-200',  strip: 'bg-blue-400' },
            D: { label: 'Debug',   color: 'text-slate-500', bg: 'bg-slate-50',  border: 'border-slate-200', strip: 'bg-slate-300'},
          };
          const filtered = logs.filter(l => {
            const matchSev = elSev === 'ALL' || l.severity === elSev;
            const q = elSearch.toLowerCase();
            const matchQ = !q || (l.message || '').toLowerCase().includes(q)
              || (l.component || '').toLowerCase().includes(q)
              || (l.context || '').toLowerCase().includes(q);
            return matchSev && matchQ;
          });

          const errorsCount = (sevCounts.E || 0) + (sevCounts.F || 0);
          const warnCount   = sevCounts.W || 0;

          return (
            <div className="space-y-4">
              {/* Severity KPI cards */}
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                {[
                  { key: 'F', val: sevCounts.F || 0, label: 'Fatal'   },
                  { key: 'E', val: sevCounts.E || 0, label: 'Errors'  },
                  { key: 'W', val: sevCounts.W || 0, label: 'Warnings'},
                  { key: 'I', val: sevCounts.I || 0, label: 'Info'    },
                  { key: 'D', val: sevCounts.D || 0, label: 'Debug'   },
                ].map(s => {
                  const cfg = SEV_CFG[s.key] || SEV_CFG.I;
                  const isActive = elSev === s.key;
                  return (
                    <button key={s.key} onClick={() => setElSev(isActive ? 'ALL' : s.key)}
                      className={`text-left p-4 rounded-2xl border transition-all ${isActive ? `${cfg.bg} ${cfg.border} ring-2 ring-offset-1` : 'bg-white border-slate-200 hover:shadow-sm'}`}>
                      <p className="text-[10px] font-bold text-slate-400 uppercase">{s.label}</p>
                      <p className={`text-2xl font-black mt-1 ${s.val > 0 && (s.key === 'E' || s.key === 'F') ? 'text-red-600' : s.val > 0 && s.key === 'W' ? 'text-amber-600' : 'text-slate-700'}`}>{s.val}</p>
                    </button>
                  );
                })}
              </div>

              {errorsCount > 0 && (
                <div className="bg-red-50 border border-red-200 rounded-2xl p-4 flex items-start gap-3">
                  <AlertTriangle size={16} className="text-red-500 flex-shrink-0 mt-0.5" />
                  <p className="text-sm font-semibold text-red-800">
                    {errorsCount} error{errorsCount > 1 ? 's' : ''} detected
                    {warnCount > 0 ? ` · ${warnCount} warnings` : ''}
                    {' '}in the last {logs.length} log lines.
                  </p>
                </div>
              )}

              {/* Filter bar */}
              <div className="bg-white border border-slate-200 rounded-2xl p-4 flex flex-wrap items-center gap-3">
                <div className="relative flex-1 min-w-[200px] max-w-sm">
                  <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input value={elSearch} onChange={e => setElSearch(e.target.value)}
                    placeholder="Search message, component, context..."
                    className="h-9 w-full pl-8 pr-4 rounded-xl border border-slate-200 text-sm outline-none focus:border-green-400" />
                </div>
                <div className="flex gap-1">
                  {['ALL', 'F', 'E', 'W', 'I', 'D'].map(s => {
                    const lbl = s === 'ALL' ? 'All' : (SEV_CFG[s]?.label || s);
                    return (
                      <button key={s} onClick={() => setElSev(s)}
                        className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all ${elSev === s ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}>
                        {lbl}
                      </button>
                    );
                  })}
                </div>
                <button onClick={() => refetchErrorLogs()}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold text-slate-600 bg-slate-100 hover:bg-slate-200 transition-colors ml-auto">
                  <RefreshCw size={11} className={errorLogsLoading ? 'animate-spin' : ''} /> Refresh
                </button>
                <span className="text-xs text-slate-400">{filtered.length}/{logs.length}</span>
              </div>

              {/* Log table */}
              <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-slate-50 border-b border-slate-200">
                      <tr>{['', 'Sev', 'Timestamp', 'Component', 'Context', 'Message', 'Attributes'].map(h => (
                        <th key={h} className="px-3 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase whitespace-nowrap">{h}</th>
                      ))}</tr>
                    </thead>
                    <tbody>
                      {filtered.slice(0, 200).map((log, i) => {
                        const cfg = SEV_CFG[log.severity] || SEV_CFG.I;
                        return (
                          <tr key={i} className={`border-t border-slate-100 hover:bg-slate-50 ${log.severity === 'E' || log.severity === 'F' ? 'bg-red-50/30' : log.severity === 'W' ? 'bg-amber-50/20' : ''}`}>
                            <td className="pl-3 py-2 w-2">
                              <div className={`w-1 h-6 rounded-full ${cfg.strip}`} />
                            </td>
                            <td className="px-3 py-2">
                              <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold border ${cfg.bg} ${cfg.color} ${cfg.border}`}>{log.severity}</span>
                            </td>
                            <td className="px-3 py-2 font-mono text-[9px] text-slate-400 whitespace-nowrap">
                              {log.timestamp ? new Date(log.timestamp).toLocaleString() : '—'}
                            </td>
                            <td className="px-3 py-2 font-mono text-[10px] text-slate-600 font-semibold">{log.component || '—'}</td>
                            <td className="px-3 py-2 font-mono text-[10px] text-slate-400 max-w-[100px] truncate">{log.context || '—'}</td>
                            <td className="px-3 py-2 text-xs text-slate-700 max-w-[340px]">
                              <p className="truncate">{log.message || '—'}</p>
                              {log.tags && log.tags.length > 0 && (
                                <div className="flex gap-1 mt-0.5">
                                  {log.tags.slice(0, 3).map((t, ti) => (
                                    <span key={ti} className="px-1.5 py-0.5 bg-slate-100 text-slate-500 rounded text-[9px] font-semibold">{t}</span>
                                  ))}
                                </div>
                              )}
                            </td>
                            <td className="px-3 py-2 font-mono text-[9px] text-slate-400 max-w-[200px] truncate">{log.attr || '—'}</td>
                          </tr>
                        );
                      })}
                      {filtered.length === 0 && (
                        <tr><td colSpan={7}>
                          <EmptyState icon={FileText} message="No log entries"
                            sub={el.note || 'Adjust filter or click Refresh'} />
                        </td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
                {filtered.length > 200 && (
                  <div className="text-center py-3 text-xs text-slate-400 border-t border-slate-100">
                    Showing 200 of {filtered.length} — use the dedicated Error Logs page for full view
                  </div>
                )}
              </div>

              <button onClick={() => navigate(`/mongodb-dashboard/${id}/error-logs`)}
                className="w-full py-3 rounded-2xl border border-dashed border-slate-300 text-sm text-slate-500 font-semibold hover:bg-slate-50 hover:border-slate-400 transition-all flex items-center justify-center gap-2">
                <FileText size={14} /> Open Dedicated Error Logs Page
                <ChevronRight size={14} />
              </button>
            </div>
          );
        })()}

        {/* AI Analysis is embedded in the Slow Operations dedicated page */}
        {activeTab === 'aianalysis_removed' && (() => {
          const slowOpsCount   = (slowData?.all_ops || []).length;
          const replState      = health_summary.replication_state || 'STANDALONE';
          const replLag        = (replData?.members || [])
            .filter(m => m.stateStr !== 'PRIMARY')
            .reduce((max, m) => Math.max(max, m.lag || 0), 0);
          const usersWithRoot  = (usersData?.users || [])
            .filter(u => (u.roles || []).some(r => r.role.includes('root') || r.role.includes('__system')));
          const oplogWindowHrs = oplogData?.oplog_window_hours || 0;
          const glQueue        = global_lock?.currentQueue || {};

          const recs = [];

          if (connPct >= 90) recs.push({
            sev: 'critical', icon: Network, title: 'Connection pool at capacity',
            msg: `Connection usage is ${connPct}% (${connections.current ?? 0} active). Risk of connection refusal.`,
            fix: 'Increase maxIncomingConnections or deploy a connection pooler. Review driver pool sizing.',
          });
          else if (connPct >= 70) recs.push({
            sev: 'warning', icon: Network, title: 'High connection usage',
            msg: `Connection usage is ${connPct}%. Saturating the pool causes timeouts under burst load.`,
            fix: 'Review application connection pool sizing and idle timeout settings.',
          });

          if (cacheHitPct > 0 && cacheHitPct < 70) recs.push({
            sev: 'critical', icon: Cpu, title: 'Poor WiredTiger cache hit rate',
            msg: `Cache hit rate is ${cacheHitPct}%. Most reads are hitting disk — severe performance impact.`,
            fix: 'Increase cacheSizeGB in mongod.conf. Aim for 50–60% of system RAM.',
          });
          else if (cacheHitPct > 0 && cacheHitPct < 85) recs.push({
            sev: 'warning', icon: Cpu, title: 'Suboptimal WiredTiger cache hit rate',
            msg: `Cache hit rate is ${cacheHitPct}%. Optimal is >95%.`,
            fix: 'Grow the WiredTiger cache or review working set size vs available RAM.',
          });

          if (wtCachePct >= 90) recs.push({
            sev: 'critical', icon: HardDrive, title: 'WiredTiger cache near full',
            msg: `Cache is ${wtCachePct}% full. Eviction pressure will slow all operations.`,
            fix: 'Increase cacheSizeGB in mongod.conf, or archive stale data to reduce working set.',
          });

          if (slowOpsCount >= 10) recs.push({
            sev: 'critical', icon: Clock, title: `${slowOpsCount} slow operations detected`,
            msg: 'High number of slow ops increases lock contention and degrades throughput.',
            fix: 'Review the Slow Queries tab and Profiler. Add indexes on frequently scanned fields.',
          });
          else if (slowOpsCount > 0) recs.push({
            sev: 'warning', icon: Clock, title: `${slowOpsCount} slow operation${slowOpsCount > 1 ? 's' : ''} detected`,
            msg: 'Some operations are running slower than expected.',
            fix: 'Use the Profiler tab to identify full collection scans and add appropriate indexes.',
          });

          if (replState !== 'STANDALONE' && replState !== 'PRIMARY' && replState !== 'SECONDARY') recs.push({
            sev: 'critical', icon: GitBranch, title: `Replication state: ${replState}`,
            msg: 'Node is not in a healthy PRIMARY or SECONDARY state. Data availability at risk.',
            fix: 'Check rs.status() and mongod logs. Investigate network connectivity between replica members.',
          });
          else if (replLag > 30) recs.push({
            sev: 'critical', icon: GitBranch, title: `Replication lag: ${replLag}s`,
            msg: `Secondary is ${replLag}s behind primary. Risk of data loss on failover.`,
            fix: 'Investigate secondary load, network bandwidth, disk I/O. Reduce write rate on primary.',
          });
          else if (replLag > 10) recs.push({
            sev: 'warning', icon: GitBranch, title: `Replication lag: ${replLag}s`,
            msg: `Secondary is slightly behind primary (${replLag}s lag).`,
            fix: 'Monitor for trends. If lag grows consistently, check secondary hardware resources.',
          });

          if (oplogWindowHrs > 0 && oplogWindowHrs < 24) recs.push({
            sev: 'warning', icon: Archive, title: `Short oplog window: ${oplogWindowHrs.toFixed(1)}h`,
            msg: 'Short window reduces point-in-time recovery options and secondary re-sync window.',
            fix: 'Increase storage.oplogSizeMB in mongod.conf or reduce write volume.',
          });

          if (usersWithRoot.length > 1) recs.push({
            sev: 'warning', icon: Lock, title: `${usersWithRoot.length} root-privileged users`,
            msg: `Multiple root users: ${usersWithRoot.slice(0, 3).map(u => u.username).join(', ')}`,
            fix: 'Apply least-privilege — grant dbAdmin or readWrite. Reserve root for emergencies.',
          });

          if ((glQueue.total || 0) > 5) recs.push({
            sev: 'warning', icon: Lock, title: 'Global lock queue building up',
            msg: `${glQueue.total} operations waiting (${glQueue.writers} writers queued).`,
            fix: 'Investigate long-running writes. Break large writes into smaller batches.',
          });

          if ((memory.resident || 0) > 0 && (memory.virtual || 0) > 0) {
            const vmRatio = memory.virtual / Math.max(memory.resident, 1);
            if (vmRatio > 4) recs.push({
              sev: 'warning', icon: MemoryStick, title: 'High virtual/resident memory ratio',
              msg: `Virtual memory is ${vmRatio.toFixed(1)}× resident. May indicate swap usage.`,
              fix: 'Ensure mongod has dedicated RAM. Swap degrades performance severely.',
            });
          }

          const criticals = recs.filter(r => r.sev === 'critical');
          const warnings  = recs.filter(r => r.sev === 'warning');

          const S = {
            critical: {
              wrap: 'border-l-4 border-red-500 bg-red-50', badge: 'bg-red-500 text-white',
              iconBg: 'bg-red-100', iconCls: 'text-red-500', border: 'border-red-100', label: 'CRITICAL',
            },
            warning: {
              wrap: 'border-l-4 border-amber-400 bg-amber-50', badge: 'bg-amber-400 text-white',
              iconBg: 'bg-amber-100', iconCls: 'text-amber-500', border: 'border-amber-100', label: 'WARNING',
            },
          };

          const RecCard = ({ rec }) => {
            const s = S[rec.sev];
            const Icon = rec.icon;
            return (
              <div className={`rounded-2xl p-5 ${s.wrap}`}>
                <div className="flex items-start gap-4">
                  <div className={`w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 ${s.iconBg}`}>
                    <Icon size={16} className={s.iconCls} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <span className={`text-[10px] font-black px-2 py-0.5 rounded-full ${s.badge}`}>{s.label}</span>
                      <p className="font-bold text-slate-800 text-sm">{rec.title}</p>
                    </div>
                    <p className="text-xs text-slate-600 mt-1 leading-relaxed">{rec.msg}</p>
                    <div className={`mt-3 bg-white/70 rounded-xl px-4 py-3 border ${s.border}`}>
                      <p className="text-[10px] font-bold text-slate-400 uppercase mb-1">Recommended Action</p>
                      <p className="text-xs text-slate-700">{rec.fix}</p>
                    </div>
                  </div>
                </div>
              </div>
            );
          };

          return (
            <div className="space-y-5">

              {/* Hero */}
              <div style={{ background: `linear-gradient(135deg, ${C.navy} 0%, #0a2d1f 100%)` }}
                className="rounded-2xl p-6 text-white">
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-10 h-10 rounded-xl flex items-center justify-center"
                    style={{ background: 'rgba(0,237,100,0.15)', border: '1px solid rgba(0,237,100,0.3)' }}>
                    <Brain size={20} style={{ color: C.green }} />
                  </div>
                  <div>
                    <h2 className="font-black text-lg">AI Health Analysis</h2>
                    <p className="text-xs mt-0.5" style={{ color: C.green }}>
                      Computed from live metrics · {recs.length} recommendation{recs.length !== 1 ? 's' : ''} generated
                    </p>
                  </div>
                  <div className="ml-auto"><HealthBadge score={healthScore} /></div>
                </div>
                <div className="flex gap-3 flex-wrap">
                  {[
                    { count: criticals.length, label: 'Critical', icon: XCircle, active: criticals.length > 0, cls: 'bg-red-500/20 border-red-400/30 text-red-400' },
                    { count: warnings.length,  label: 'Warning',  icon: AlertTriangle, active: warnings.length > 0, cls: 'bg-amber-400/20 border-amber-400/30 text-amber-400' },
                    { count: Math.max(0, 10 - recs.length), label: 'Checks OK', icon: CheckCircle2, active: false, cls: 'bg-green-500/20 border-green-400/30 text-green-400' },
                  ].map(chip => {
                    const Icon = chip.icon;
                    return (
                      <div key={chip.label}
                        className={`flex items-center gap-2 px-4 py-2 rounded-xl border ${chip.active ? chip.cls : 'bg-white/5 border-white/10'}`}>
                        <Icon size={14} className={chip.active ? '' : 'text-slate-400'} />
                        <span className="text-sm font-bold">{chip.count} {chip.label}</span>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Metric snapshot */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {[
                  { label: 'Connection %',  value: `${connPct}%`,     bad: connPct > 90, warn: connPct > 70, icon: Network },
                  { label: 'Cache Hit %',   value: `${cacheHitPct}%`, bad: cacheHitPct > 0 && cacheHitPct < 70, warn: cacheHitPct > 0 && cacheHitPct < 85, icon: Cpu },
                  { label: 'WT Cache Used', value: `${wtCachePct}%`,  bad: wtCachePct > 90, warn: wtCachePct > 70, icon: HardDrive },
                  { label: 'Repl Lag',      value: replLag > 0 ? `${replLag}s` : replState === 'STANDALONE' ? 'Standalone' : 'OK', bad: replLag > 30, warn: replLag > 10, icon: GitBranch },
                ].map(m => {
                  const bg = m.bad ? 'bg-red-50 border-red-200' : m.warn ? 'bg-amber-50 border-amber-200' : 'bg-green-50 border-green-200';
                  const tc = m.bad ? 'text-red-700' : m.warn ? 'text-amber-700' : 'text-green-700';
                  const Icon = m.icon;
                  return (
                    <div key={m.label} className={`rounded-2xl border p-4 ${bg}`}>
                      <div className="flex justify-between items-start">
                        <div>
                          <p className="text-[10px] font-bold uppercase text-slate-400 tracking-wide">{m.label}</p>
                          <p className={`text-2xl font-black mt-1 ${tc}`}>{m.value}</p>
                        </div>
                        <Icon size={18} className={tc} />
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* All good */}
              {recs.length === 0 && (
                <div className="bg-white rounded-2xl border border-slate-200 p-12 text-center">
                  <CheckCircle2 size={48} className="text-green-400 mx-auto mb-4" />
                  <p className="font-black text-xl text-slate-800">All Systems Healthy</p>
                  <p className="text-slate-400 text-sm mt-2 max-w-md mx-auto">
                    No anomalies detected. Connection usage, cache performance, and replication are all within optimal ranges.
                  </p>
                </div>
              )}

              {/* Criticals */}
              {criticals.length > 0 && (
                <div className="space-y-3">
                  <h3 className="font-bold text-sm text-red-700 flex items-center gap-2">
                    <XCircle size={14} /> Critical Issues ({criticals.length})
                  </h3>
                  {criticals.map((rec, i) => <RecCard key={i} rec={rec} />)}
                </div>
              )}

              {/* Warnings */}
              {warnings.length > 0 && (
                <div className="space-y-3">
                  <h3 className="font-bold text-sm text-amber-700 flex items-center gap-2">
                    <AlertTriangle size={14} /> Warnings ({warnings.length})
                  </h3>
                  {warnings.map((rec, i) => <RecCard key={i} rec={rec} />)}
                </div>
              )}

              {/* Performance insights */}
              <div className="bg-white rounded-2xl border border-slate-200 p-5">
                <h3 className="font-bold text-slate-800 text-sm mb-4 flex items-center gap-2">
                  <Lightbulb size={14} style={{ color: C.green }} /> Performance Insights
                </h3>
                <div className="space-y-0">
                  {[
                    {
                      label: 'Query Performance',
                      insight: slowOpsCount === 0
                        ? 'No slow operations detected — query patterns appear healthy.'
                        : `${slowOpsCount} slow ops found. Enable profiling (db.setProfilingLevel(1, 100)) to capture detailed traces.`,
                      good: slowOpsCount === 0,
                    },
                    {
                      label: 'Storage Engine (WiredTiger)',
                      insight: `Cache ${wtCachePct}% full · Hit rate ${cacheHitPct}%. ${cacheHitPct >= 90 ? 'Excellent cache efficiency.' : cacheHitPct >= 70 ? 'Acceptable — monitor under load.' : 'High cache miss rate — increase cacheSizeGB.'}`,
                      good: cacheHitPct >= 85,
                    },
                    {
                      label: 'Replication',
                      insight: replState === 'STANDALONE'
                        ? 'Single-node. Consider a replica set for HA and read scaling.'
                        : `${replState} · ${replLag > 0 ? `Lag: ${replLag}s — monitor trend.` : 'Secondaries in sync.'}`,
                      good: (replState === 'PRIMARY' || replState === 'STANDALONE') && replLag <= 5,
                    },
                    {
                      label: 'Connection Management',
                      insight: connPct <= 50
                        ? `Healthy — ${connPct}% of pool in use.`
                        : `${connPct}% pool usage. Ensure maxPoolSize is set per driver configuration and idle connections are reclaimed.`,
                      good: connPct <= 50,
                    },
                    {
                      label: 'Operational Baseline',
                      insight: `Op rate ${fmtNum(opRate)}/s · ${health_summary.total_databases || 0} DBs · ${health_summary.total_collections || 0} collections · MongoDB ${(health_summary.version || '—').split('-')[0]}`,
                      good: true,
                    },
                  ].map((item, i) => (
                    <div key={i} className="flex items-start gap-3 py-3 border-b border-slate-100 last:border-0">
                      <div className={`w-2 h-2 rounded-full mt-1.5 flex-shrink-0 ${item.good ? 'bg-green-400' : 'bg-amber-400'}`} />
                      <div>
                        <p className="text-xs font-bold text-slate-700">{item.label}</p>
                        <p className="text-xs text-slate-500 mt-0.5 leading-relaxed">{item.insight}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Quick links */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {[
                  { label: 'Slow Operations',     icon: Clock,     path: `/mongodb-dashboard/${id}/slow-operations`, color: 'from-orange-500 to-red-500' },
                  { label: 'Collection Analysis', icon: BarChart2, path: `/mongodb-dashboard/${id}/collection-analysis`, color: 'from-blue-500 to-indigo-600' },
                  { label: 'Error Logs',          icon: FileText,  path: `/mongodb-dashboard/${id}/error-logs`, color: 'from-red-500 to-rose-600' },
                  { label: 'Backup & Restore',    icon: Archive,   path: `/mongodb-dashboard/${id}/backup`, color: 'from-green-600 to-emerald-700' },
                ].map(p => (
                  <button key={p.label} onClick={() => navigate(p.path)}
                    className="text-left bg-white border border-slate-200 rounded-2xl p-4 hover:shadow-md hover:-translate-y-0.5 transition-all group flex items-center gap-3">
                    <div className={`w-10 h-10 rounded-xl bg-gradient-to-br ${p.color} flex items-center justify-center flex-shrink-0`}>
                      <p.icon size={16} className="text-white" />
                    </div>
                    <p className="font-bold text-slate-800 text-sm truncate flex-1">{p.label}</p>
                    <ChevronRight size={14} className="text-slate-300 group-hover:text-slate-500 flex-shrink-0" />
                  </button>
                ))}
              </div>

            </div>
          );
        })()}

      </div>
    </div>
  );
}

