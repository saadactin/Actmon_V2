import React, { useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, RefreshCw, CheckCircle2, XCircle, AlertTriangle, Loader2,
  Clock, Download, RotateCcw, Trash2, FileArchive,
  ChevronRight, Copy, CheckCheck, Eye, Search, Play,
  Database, Activity, FolderOpen, HardDrive,
  ChevronDown, ChevronUp, Layers, BookOpen,
  CalendarClock, Plus, Pencil, ToggleLeft, ToggleRight,
  Shield, Target, ListTree, AlertCircle, Info,
} from 'lucide-react';
import client from '../../api/client';

/* ─── API ─────────────────────────────────────────────────────────────────── */
const api = {
  summary:        id             => client.get(`/connections/mssql/${id}/backup/summary`).then(r => r.data),
  listBackups:    id             => client.get(`/connections/mssql/${id}/backups`).then(r => r.data),
  takeBackup:     (id, b)        => client.post(`/connections/mssql/${id}/backup/take`, b).then(r => r.data),
  deleteJob:      (id, jid)      => client.delete(`/connections/mssql/${id}/backup/${jid}`).then(r => r.data),
  pitr:           (id, b)        => client.post(`/connections/mssql/${id}/pitr`, b).then(r => r.data),
  history:        (id, p)        => client.get(`/connections/mssql/${id}/backup/history`, { params: p }).then(r => r.data),
  recoveryChain:  id             => client.get(`/connections/mssql/${id}/backup/recovery-chain`).then(r => r.data),
  listSchedules:  id             => client.get(`/connections/mssql/${id}/backup/schedules`).then(r => r.data),
  createSchedule: (id, s)        => client.post(`/connections/mssql/${id}/backup/schedules`, s).then(r => r.data),
  updateSchedule: (id, sid, s)   => client.put(`/connections/mssql/${id}/backup/schedules/${sid}`, s).then(r => r.data),
  deleteSchedule: (id, sid)      => client.delete(`/connections/mssql/${id}/backup/schedules/${sid}`).then(r => r.data),
  toggleSchedule: (id, sid, e)   => client.patch(`/connections/mssql/${id}/backup/schedules/${sid}/toggle`, { enabled: e }).then(r => r.data),
  runNow:         (id, sid)      => client.post(`/connections/mssql/${id}/backup/schedules/${sid}/run-now`).then(r => r.data),
};

/* ─── helpers ────────────────────────────────────────────────────────────── */
const fmt   = ts => ts ? new Date(ts + (ts.endsWith('Z') ? '' : 'Z')).toLocaleString() : '—';
const fname = p  => p  ? p.split(/[/\\]/).pop() : '—';
const fmtMb = mb => {
  const n = Number(mb);
  if (!n) return '—';
  if (n >= 1024) return `${(n / 1024).toFixed(2)} GB`;
  return `${n.toFixed(0)} MB`;
};

const TYPE_COLORS = {
  full:          { bg: '#EFF6FF', border: '#BFDBFE', text: '#1D4ED8', dot: '#3B82F6' },
  differential:  { bg: '#F5F3FF', border: '#DDD6FE', text: '#6D28D9', dot: '#8B5CF6' },
  log:           { bg: '#F0F9FF', border: '#BAE6FD', text: '#0369A1', dot: '#0EA5E9' },
  copy_only:     { bg: '#FAF5FF', border: '#E9D5FF', text: '#7E22CE', dot: '#A855F7' },
  pitr:          { bg: '#F0FDF4', border: '#BBF7D0', text: '#065F46', dot: '#10B981' },
  restore:       { bg: '#FFF7ED', border: '#FED7AA', text: '#9A3412', dot: '#F97316' },
};
const STATUS_MAP = {
  pending:   { cls: 'bg-slate-100 text-slate-600',     dot: 'bg-slate-400',              label: 'Pending'   },
  running:   { cls: 'bg-blue-100 text-blue-700',       dot: 'bg-blue-500 animate-pulse', label: 'Running'   },
  completed: { cls: 'bg-emerald-100 text-emerald-700', dot: 'bg-emerald-500',            label: 'Completed' },
  failed:    { cls: 'bg-red-100 text-red-700',         dot: 'bg-red-500',                label: 'Failed'    },
  cancelled: { cls: 'bg-slate-100 text-slate-400',     dot: 'bg-slate-300',              label: 'Cancelled' },
};

/* ─── atoms ──────────────────────────────────────────────────────────────── */
function CopyBtn({ text }) {
  const [ok, setOk] = useState(false);
  return (
    <button title="Copy" onClick={e => { e.stopPropagation(); navigator.clipboard.writeText(text).catch(() => {}); setOk(true); setTimeout(() => setOk(false), 1800); }}
      className="flex-shrink-0 text-slate-400 hover:text-slate-700 transition-colors">
      {ok ? <CheckCheck size={12} className="text-emerald-500" /> : <Copy size={12} />}
    </button>
  );
}

function Toast({ t }) {
  if (!t) return null;
  return (
    <div className={`fixed top-5 right-5 z-[9999] flex items-center gap-3 px-5 py-3.5 rounded-2xl shadow-2xl text-sm font-bold
      ${t.type === 'error' ? 'bg-red-600 text-white' : 'bg-emerald-600 text-white'}`}>
      {t.type === 'error' ? <XCircle size={16} /> : <CheckCircle2 size={16} />}
      {t.msg}
    </div>
  );
}

function StatusBadge({ status }) {
  const s = STATUS_MAP[status] || STATUS_MAP.pending;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold ${s.cls}`}>
      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${s.dot}`} />
      {s.label}
    </span>
  );
}

function TypeBadge({ type }) {
  const c = TYPE_COLORS[type] || { bg: '#F8FAFC', border: '#E2E8F0', text: '#64748B', dot: '#94A3B8' };
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold border"
      style={{ background: c.bg, borderColor: c.border, color: c.text }}>
      <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: c.dot }} />
      {(type || '').replace('_', ' ').toUpperCase()}
    </span>
  );
}

function SectionCard({ title, subtitle, icon: Icon, iconColor = 'text-slate-400', children }) {
  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
      {(title || subtitle) && (
        <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-3">
          {Icon && (
            <div className="w-8 h-8 rounded-xl bg-slate-50 border border-slate-100 flex items-center justify-center flex-shrink-0">
              <Icon size={15} className={iconColor} />
            </div>
          )}
          <div>
            {title && <h3 className="font-bold text-slate-800 text-[13px]">{title}</h3>}
            {subtitle && <p className="text-[11px] text-slate-400 mt-0.5">{subtitle}</p>}
          </div>
        </div>
      )}
      <div className="p-5">{children}</div>
    </div>
  );
}

function InfoRow({ label, value, mono = false, copy = false }) {
  return (
    <div className="flex items-start justify-between gap-3 py-2 border-b border-slate-50 last:border-0">
      <span className="text-[11px] text-slate-400 font-medium flex-shrink-0 w-32">{label}</span>
      <div className="flex items-center gap-1.5 min-w-0">
        <span className={`text-[11px] text-slate-700 font-semibold text-right break-all ${mono ? 'font-mono' : ''}`}>{value || '—'}</span>
        {copy && value && <CopyBtn text={String(value)} />}
      </div>
    </div>
  );
}

function DangerBox({ title, msg }) {
  return (
    <div className="flex gap-3 p-4 rounded-2xl bg-red-50 border border-red-200">
      <div className="w-8 h-8 rounded-xl bg-red-100 border border-red-200 flex items-center justify-center flex-shrink-0">
        <AlertTriangle size={15} className="text-red-600" />
      </div>
      <div>
        <p className="font-bold text-red-800 text-[13px]">{title}</p>
        <p className="text-[12px] text-red-700 mt-1 leading-relaxed">{msg}</p>
      </div>
    </div>
  );
}

function ResultAlert({ r }) {
  if (!r) return null;
  return (
    <div className={`flex items-start gap-3 px-4 py-3.5 rounded-2xl border text-sm
      ${r.ok ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-red-50 border-red-200 text-red-700'}`}>
      {r.ok ? <CheckCircle2 size={16} className="flex-shrink-0 mt-0.5" /> : <XCircle size={16} className="flex-shrink-0 mt-0.5" />}
      <div>
        <p className="font-bold">{r.msg}</p>
        {r.jobId && <p className="text-[11px] mt-1 opacity-70">Job #{r.jobId} queued — check My Backups for live progress</p>}
      </div>
    </div>
  );
}

/* ─── TABS ───────────────────────────────────────────────────────────────── */
const TABS = [
  { id: 'backups',  label: 'My Backups',         icon: FileArchive,   color: 'text-blue-600'   },
  { id: 'new',      label: 'New Backup',          icon: Download,      color: 'text-indigo-600' },
  { id: 'schedule', label: 'Schedule',            icon: CalendarClock, color: 'text-sky-600'    },
  { id: 'history',  label: 'SQL Server History',  icon: ListTree,      color: 'text-violet-600' },
  { id: 'pitr',     label: 'PITR / Restore',      icon: Target,        color: 'text-teal-600'   },
];

/* ═══════════════════════ ROOT PAGE ══════════════════════════════════════════ */
export default function MSSQLBackupPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [tab, setTab]     = useState('backups');
  const [toast, setToast] = useState(null);

  const showToast = useCallback((msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 4000);
  }, []);

  const { data: sumData, isLoading: sumLoading } = useQuery({
    queryKey: ['mssqlBkSum2', id],
    queryFn:  () => api.summary(id),
    refetchInterval: 20000,
  });
  const { data: bkpData, refetch: refetchBkps } = useQuery({
    queryKey: ['mssqlBkList2', id],
    queryFn:  () => api.listBackups(id),
    refetchInterval: 6000,
  });

  const backups    = bkpData?.jobs || [];
  const runCount   = backups.filter(b => b.status === 'running').length;
  const sumStats   = sumData?.stats || {};
  const defaultDir = sumData?.default_backup_dir || '';

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['mssqlBkSum2',  id] });
    qc.invalidateQueries({ queryKey: ['mssqlBkList2', id] });
  };

  return (
    <div className="-m-6 md:-m-8 h-[calc(100%+3rem)] md:h-[calc(100%+4rem)] flex flex-col overflow-hidden bg-[#f0f2ff]">
      <Toast t={toast} />

      {/* ══ HEADER ══ */}
      <div className="flex-shrink-0 bg-white border-b border-slate-200 shadow-sm z-50">
        <div className="px-5 pt-4 pb-0">

          {/* top row */}
          <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
            <div className="flex items-center gap-3">
              <button onClick={() => navigate(`/mssql-dashboard/${id}`)}
                className="w-9 h-9 rounded-xl bg-slate-100 hover:bg-slate-200 flex items-center justify-center transition-all border border-slate-200 flex-shrink-0">
                <ArrowLeft size={15} className="text-slate-600" />
              </button>
              <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
                style={{ background: 'linear-gradient(135deg,#0f172a,#0078D4)' }}>
                <Database size={18} className="text-white" />
              </div>
              <div>
                <h1 className="text-[17px] font-black text-slate-900 leading-tight">SQL Server Backup &amp; PITR</h1>
                <p className="text-[11px] text-slate-400">Connection #{id} · Advanced backup, restore &amp; point-in-time recovery</p>
              </div>
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              {sumLoading
                ? <span className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-100 text-[11px] font-bold text-slate-500">
                    <Loader2 size={11} className="animate-spin" /> Loading…
                  </span>
                : sumData?.last_backups?.length > 0
                  ? <span className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-700 text-[11px] font-bold">
                      <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                      {sumData.last_backups.length} DB{sumData.last_backups.length !== 1 ? 's' : ''} Protected
                    </span>
                  : <span className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-amber-50 border border-amber-200 text-amber-700 text-[11px] font-bold">
                      <span className="w-2 h-2 rounded-full bg-amber-500" /> No recent backups
                    </span>
              }
              {sumStats.total_backups > 0 && (
                <span className="hidden lg:flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-blue-50 border border-blue-100 text-[11px] text-blue-700 font-semibold">
                  <Clock size={11} /> {sumStats.total_backups} backups (30d)
                </span>
              )}
              <button onClick={refresh}
                className="flex items-center gap-1.5 h-9 px-3 rounded-xl bg-slate-100 hover:bg-slate-200 text-xs font-semibold text-slate-600 border border-slate-200 transition-all">
                <RefreshCw size={12} className={sumLoading ? 'animate-spin' : ''} /> Refresh
              </button>
            </div>
          </div>

          {/* TAB BAR */}
          <div className="flex overflow-x-auto">
            {TABS.map(t => {
              const Icon   = t.icon;
              const active = tab === t.id;
              return (
                <button key={t.id} onClick={() => setTab(t.id)}
                  className={`flex items-center gap-2 px-5 py-3 text-[13px] font-semibold border-b-2 whitespace-nowrap transition-all flex-shrink-0
                    ${active ? 'border-blue-600 text-blue-700 bg-blue-50/40' : 'border-transparent text-slate-500 hover:text-slate-800 hover:bg-slate-50'}`}>
                  <Icon size={13} className={active ? t.color : ''} />
                  {t.label}
                  {t.id === 'backups' && runCount > 0 && (
                    <span className="w-4 h-4 rounded-full bg-blue-600 text-white text-[9px] font-black flex items-center justify-center">{runCount}</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* ══ CONTENT ══ */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden">
        <div className="p-5 max-w-[1600px] mx-auto">
          {tab === 'backups'  && <BackupsTab   connId={id} backups={backups} stats={sumStats} defaultDir={defaultDir} refetch={refetchBkps} showToast={showToast} setTab={setTab} />}
          {tab === 'new'      && <NewBackupTab connId={id} sumData={sumData} refresh={refresh} showToast={showToast} />}
          {tab === 'schedule' && <ScheduleTab  connId={id} showToast={showToast} />}
          {tab === 'history'  && <HistoryTab   connId={id} />}
          {tab === 'pitr'     && <PITRTab      connId={id} showToast={showToast} refresh={refresh} />}
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   MY BACKUPS
═══════════════════════════════════════════════════════════════════════════ */
function BackupsTab({ connId, backups, stats, defaultDir, refetch, showToast, setTab }) {
  const qc = useQueryClient();
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [exp, setExp]       = useState(null);

  const delMut = useMutation({
    mutationFn: jid => api.deleteJob(connId, jid),
    onSuccess: () => { showToast('Job deleted'); qc.invalidateQueries({ queryKey: ['mssqlBkList2', connId] }); },
    onError:   e  => showToast(e?.response?.data?.detail || e.message || 'Delete failed', 'error'),
  });

  const shown = backups.filter(b => {
    const matchType   = filter === 'all' || b.backup_type === filter || b.status === filter;
    const matchSearch = !search || [b.backup_type, b.db_name, b.status, b.file_path]
      .some(v => (v || '').toLowerCase().includes(search.toLowerCase()));
    return matchType && matchSearch;
  });

  const totalSize = backups.reduce((s, b) => s + (b.size_bytes || 0), 0);
  const fmtB = b => { if (b >= 1e9) return `${(b/1e9).toFixed(2)} GB`; if (b >= 1e6) return `${(b/1e6).toFixed(1)} MB`; return `${b} B`; };

  return (
    <div className="space-y-4">

      {/* STAT CARDS */}
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3">
        {[
          { label: 'Total Jobs',   val: backups.length,                                              icon: FileArchive,  g: 'from-blue-500 to-indigo-600'   },
          { label: 'Completed',    val: backups.filter(b => b.status === 'completed').length,         icon: CheckCircle2, g: 'from-emerald-500 to-teal-600'  },
          { label: 'Running',      val: backups.filter(b => b.status === 'running').length,           icon: Loader2,      g: 'from-sky-400 to-blue-500'      },
          { label: 'Failed',       val: backups.filter(b => b.status === 'failed').length,            icon: XCircle,      g: 'from-red-500 to-rose-600'      },
          { label: 'Total Size',   val: totalSize > 0 ? fmtB(totalSize) : '—',                       icon: HardDrive,    g: 'from-orange-500 to-amber-600'  },
          { label: 'Backup Types', val: [...new Set(backups.map(b => b.backup_type))].join(', ')||'—', icon: Layers, g: 'from-violet-500 to-purple-600' },
        ].map(({ label, val, icon: Icon, g }) => (
          <div key={label} className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
            <div className={`h-[3px] bg-gradient-to-r ${g}`} />
            <div className="px-4 py-3 flex items-center gap-3">
              <div className={`w-8 h-8 rounded-xl flex-shrink-0 flex items-center justify-center bg-gradient-to-br ${g}`}>
                <Icon size={14} className="text-white" />
              </div>
              <div className="min-w-0">
                <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest truncate">{label}</p>
                <p className="text-sm font-black text-slate-900 truncate">{val}</p>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* DEFAULT BACKUP PATH */}
      {defaultDir && (
        <div className="bg-white rounded-2xl border border-blue-100 shadow-sm overflow-hidden">
          <div className="h-[3px] bg-gradient-to-r from-blue-400 to-indigo-500" />
          <div className="px-5 py-3 flex items-center gap-4">
            <div className="w-9 h-9 rounded-xl bg-blue-50 border border-blue-100 flex items-center justify-center flex-shrink-0">
              <FolderOpen size={16} className="text-blue-600" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wide">Default SQL Server backup directory (on DB host)</p>
              <div className="flex items-center gap-2 mt-0.5">
                <code className="text-[12px] text-slate-800 font-mono bg-slate-50 px-2.5 py-0.5 rounded-lg border border-slate-200 truncate">{defaultDir}</code>
                <CopyBtn text={defaultDir} />
              </div>
            </div>
            <span className="hidden sm:block text-[10px] font-bold text-blue-600 bg-blue-50 border border-blue-200 px-2.5 py-1 rounded-full flex-shrink-0">
              Customizable in New Backup →
            </span>
          </div>
        </div>
      )}

      {/* FILTER BAR */}
      <div className="flex items-center gap-2 flex-wrap bg-white rounded-2xl border border-slate-200 shadow-sm px-4 py-3">
        <div className="relative">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search…"
            className="h-8 pl-8 pr-3 text-[12px] rounded-xl border border-slate-200 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 w-36 transition-all bg-slate-50" />
        </div>
        <div className="flex items-center gap-0.5 bg-slate-100 rounded-xl p-1">
          {['all', 'full', 'differential', 'log', 'copy_only', 'pitr'].map(f => (
            <button key={f} onClick={() => setFilter(f)}
              className={`h-7 px-3 rounded-lg text-[11px] font-semibold transition-all ${filter === f ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500 hover:text-slate-700'}`}>
              {f === 'all' ? 'All' : f.replace('_', ' ')[0].toUpperCase() + f.replace('_', ' ').slice(1)}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-0.5 bg-slate-100 rounded-xl p-1">
          {['completed', 'running', 'failed'].map(s => (
            <button key={s} onClick={() => setFilter(s)}
              className={`h-7 px-3 rounded-lg text-[11px] font-semibold transition-all ${filter === s ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500 hover:text-slate-700'}`}>
              {s[0].toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>
        <span className="ml-auto text-[12px] text-slate-400">{shown.length} records</span>
        <button onClick={refetch} className="w-8 h-8 rounded-xl border border-slate-200 flex items-center justify-center hover:bg-slate-100 text-slate-500 transition-all">
          <RefreshCw size={13} />
        </button>
      </div>

      {/* TABLE */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        {shown.length === 0 ? (
          <div className="py-20 text-center">
            <div className="w-16 h-16 rounded-2xl bg-slate-100 flex items-center justify-center mx-auto mb-4">
              <FileArchive size={28} className="text-slate-300" />
            </div>
            <p className="text-slate-500 font-semibold">No backup jobs found</p>
            <p className="text-slate-400 text-sm mt-1">Try a different filter or take your first backup</p>
            <button onClick={() => setTab('new')}
              className="mt-4 px-5 h-9 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm font-bold transition-all inline-flex items-center gap-2 shadow-md">
              <Download size={13} /> New Backup
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200">
                  {['#', 'Type', 'Database', 'Status', 'Size', 'Backup File (on SQL Server)', 'Duration', 'Started', ''].map((h, i) => (
                    <th key={i} className="px-4 py-3 text-left text-[10px] font-bold text-slate-400 uppercase tracking-widest whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map(job => {
                  const isExp = exp === job.id;
                  return (
                    <React.Fragment key={job.id}>
                      <tr onClick={() => setExp(isExp ? null : job.id)}
                        className={`border-t border-slate-100 cursor-pointer transition-all hover:bg-blue-50/30 ${isExp ? 'bg-blue-50/40' : ''}`}>
                        <td className="px-4 py-3 font-mono text-[11px] text-slate-400 font-bold">#{job.id}</td>
                        <td className="px-4 py-3"><TypeBadge type={job.backup_type} /></td>
                        <td className="px-4 py-3 text-[12px] font-semibold text-slate-700">{job.db_name || '—'}</td>
                        <td className="px-4 py-3"><StatusBadge status={job.status} /></td>
                        <td className="px-4 py-3 font-mono text-[12px] text-slate-600">{job.size_human || '—'}</td>
                        <td className="px-4 py-3 max-w-[220px]" onClick={e => e.stopPropagation()}>
                          {job.file_path ? (
                            <div className="flex items-center gap-1.5">
                              <span className="font-mono text-[11px] text-slate-700 truncate" title={job.file_path}>{fname(job.file_path)}</span>
                              <CopyBtn text={job.file_path} />
                            </div>
                          ) : <span className="text-slate-300 text-[11px]">—</span>}
                        </td>
                        <td className="px-4 py-3 text-[12px] text-slate-500">{job.duration_sec != null ? `${job.duration_sec}s` : '—'}</td>
                        <td className="px-4 py-3 whitespace-nowrap text-[11px] text-slate-500">{fmt(job.backup_start)}</td>
                        <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                          <div className="flex items-center gap-1">
                            <button onClick={() => setExp(isExp ? null : job.id)}
                              className="w-7 h-7 rounded-lg flex items-center justify-center text-slate-400 hover:text-blue-600 hover:bg-blue-50 transition-all" title="Details">
                              {isExp ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                            </button>
                            <button onClick={() => delMut.mutate(job.id)} disabled={job.status === 'running'}
                              className="w-7 h-7 rounded-lg flex items-center justify-center text-slate-400 hover:text-red-600 hover:bg-red-50 disabled:opacity-30 transition-all" title="Delete">
                              <Trash2 size={12} />
                            </button>
                          </div>
                        </td>
                      </tr>
                      {isExp && (
                        <tr className="bg-slate-50/60 border-t border-blue-100">
                          <td colSpan={9} className="px-5 py-4">
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                              <div className="bg-white rounded-xl border border-slate-200 p-4">
                                <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-3 flex items-center gap-1.5"><Database size={11} /> Job Details</p>
                                <InfoRow label="Job #"    value={job.id} />
                                <InfoRow label="UUID"     value={job.uuid} mono copy />
                                <InfoRow label="Type"     value={job.backup_type} />
                                <InfoRow label="Database" value={job.db_name} />
                                <InfoRow label="Host:Port" value={`${job.db_host}:${job.db_port}`} mono />
                              </div>
                              <div className="bg-white rounded-xl border border-slate-200 p-4">
                                <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-3 flex items-center gap-1.5"><Clock size={11} /> Timing</p>
                                <InfoRow label="Started"  value={fmt(job.backup_start)} />
                                <InfoRow label="Finished" value={fmt(job.backup_end)} />
                                <InfoRow label="Duration" value={job.duration_sec != null ? `${job.duration_sec}s` : '—'} />
                                <InfoRow label="File Size" value={job.size_human} />
                              </div>
                              <div className="bg-white rounded-xl border border-slate-200 p-4">
                                <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-3 flex items-center gap-1.5"><FolderOpen size={11} /> Backup File Location</p>
                                <p className="text-[10px] text-slate-400 mb-2">Path on SQL Server host:</p>
                                {job.file_path ? (
                                  <div className="flex items-start gap-2 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2">
                                    <code className="font-mono text-[10px] text-slate-700 break-all leading-relaxed flex-1">{job.file_path}</code>
                                    <CopyBtn text={job.file_path} />
                                  </div>
                                ) : <span className="text-slate-400 text-xs">No file path recorded yet</span>}
                              </div>
                            </div>
                            {job.notes && <p className="mt-3 text-[12px] bg-amber-50 border border-amber-100 rounded-xl px-3 py-2 text-amber-800">📝 {job.notes}</p>}
                            {job.error_msg && (
                              <div className="mt-3 bg-red-50 border border-red-200 rounded-xl px-4 py-3">
                                <p className="text-[10px] font-bold text-red-700 uppercase tracking-wide mb-1">Error</p>
                                <pre className="font-mono text-[11px] text-red-800 whitespace-pre-wrap">{job.error_msg}</pre>
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   NEW BACKUP
═══════════════════════════════════════════════════════════════════════════ */
const BK_TYPES = {
  full: {
    icon: Shield, label: 'Full Backup', sub: 'BACKUP DATABASE',
    g: 'from-blue-500 to-indigo-600', active: 'border-blue-500 bg-blue-50/80',
    desc: 'Complete copy of the entire database. Required as the base for all restore chains. Breaks and restarts the differential base.',
    cmd: 'BACKUP DATABASE [db] TO DISK = N\'path\' WITH FORMAT, INIT, STATS=10',
    pitr: true,
  },
  differential: {
    icon: Layers, label: 'Differential Backup', sub: 'BACKUP DATABASE ... WITH DIFFERENTIAL',
    g: 'from-violet-500 to-purple-600', active: 'border-violet-500 bg-violet-50/80',
    desc: 'Backs up all changes since the last full backup. Faster than full, smaller file. Requires a preceding full backup to restore.',
    cmd: 'BACKUP DATABASE [db] TO DISK = N\'path\' WITH DIFFERENTIAL, FORMAT, STATS=10',
    pitr: false,
  },
  log: {
    icon: Clock, label: 'Transaction Log', sub: 'BACKUP LOG',
    g: 'from-sky-500 to-cyan-600', active: 'border-sky-500 bg-sky-50/80',
    desc: 'Backs up the transaction log. Required for PITR. Database must be in FULL or BULK-LOGGED recovery model. Truncates the log after backup.',
    cmd: 'BACKUP LOG [db] TO DISK = N\'path\' WITH FORMAT, INIT, STATS=10',
    pitr: true,
  },
  copy_only: {
    icon: BookOpen, label: 'Copy-Only Full', sub: 'WITH COPY_ONLY',
    g: 'from-purple-500 to-fuchsia-600', active: 'border-purple-500 bg-purple-50/80',
    desc: 'Ad-hoc full backup that does NOT break the differential chain or affect the LSN sequence. Safe for out-of-band backups.',
    cmd: 'BACKUP DATABASE [db] TO DISK = N\'path\' WITH COPY_ONLY, FORMAT, STATS=10',
    pitr: false,
  },
};

function NewBackupTab({ connId, sumData, refresh, showToast }) {
  const [btype, setBtype]     = useState('full');
  const [dbName, setDbName]   = useState('');
  const [notes, setNotes]     = useState('');
  const [customPath, setCustom] = useState('');
  const [compress, setCompress] = useState(true);
  const [loading, setLoading]  = useState(false);
  const [result, setResult]    = useState(null);

  const bt        = BK_TYPES[btype];
  const userDbs   = (sumData?.recovery_models || []).map(d => d.name);
  const defaultDir = sumData?.default_backup_dir || '';

  const go = async () => {
    if (!dbName.trim()) return setResult({ ok: false, msg: 'Select a database first.' });
    setLoading(true); setResult(null);
    try {
      const res = await api.takeBackup(connId, {
        backup_type:  btype,
        database:     dbName.trim(),
        backup_path:  customPath.trim() || null,
        compress,
        notes:        notes.trim() || null,
      });
      setResult({ ok: true, msg: `${btype.replace('_',' ').toUpperCase()} backup started for "${dbName}"`, jobId: res.job_id });
      refresh();
    } catch (e) {
      setResult({ ok: false, msg: e?.response?.data?.detail || e.message || 'Failed to start backup' });
    } finally { setLoading(false); }
  };

  return (
    <div className="max-w-3xl space-y-4">

      {/* Step 1 — Backup Type */}
      <SectionCard title="Step 1 — Choose Backup Type" subtitle="Select the method that suits your recovery requirements" icon={Layers} iconColor="text-indigo-600">
        <div className="space-y-3">
          {Object.entries(BK_TYPES).map(([k, v]) => {
            const Icon = v.icon;
            return (
              <label key={k}
                className={`flex gap-4 p-4 rounded-2xl border-2 cursor-pointer transition-all ${btype === k ? v.active + ' shadow-sm' : 'border-slate-200 bg-white hover:border-slate-300'}`}>
                <input type="radio" name="btype" value={k} checked={btype === k} onChange={() => setBtype(k)} className="sr-only" />
                <div className={`w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0 bg-gradient-to-br ${v.g} shadow-sm`}>
                  <Icon size={19} className="text-white" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-black text-slate-900 text-[14px]">{v.label}</span>
                    <span className="text-[11px] text-slate-400">{v.sub}</span>
                    {v.pitr && <span className="text-[10px] font-black bg-teal-100 text-teal-700 px-2 py-0.5 rounded-full border border-teal-200">✓ Supports PITR</span>}
                    {btype === k && <span className="ml-auto text-[10px] font-black text-white px-2 py-0.5 rounded-full bg-gradient-to-r from-emerald-500 to-teal-600">✓ Selected</span>}
                  </div>
                  <p className="text-[12px] text-slate-500 mt-1">{v.desc}</p>
                  <div className="mt-2 bg-slate-900 rounded-lg px-3 py-1.5 inline-flex items-center gap-2 max-w-full overflow-x-auto">
                    <code className="text-[10px] text-green-400 font-mono whitespace-nowrap">{v.cmd}</code>
                  </div>
                </div>
              </label>
            );
          })}
        </div>
      </SectionCard>

      {/* Step 2 — Database */}
      <SectionCard title="Step 2 — Target Database" subtitle="Select the database to back up" icon={Database} iconColor="text-blue-600">
        {userDbs.length > 0 ? (
          <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
            {userDbs.map(d => (
              <label key={d}
                className={`flex gap-3 items-center p-3 rounded-xl border-2 cursor-pointer transition-all ${dbName === d ? 'border-blue-400 bg-blue-50' : 'border-slate-200 bg-white hover:border-slate-300'}`}>
                <input type="radio" name="dbsel" value={d} checked={dbName === d} onChange={() => setDbName(d)} className="flex-shrink-0" />
                <div className="flex items-center gap-2 min-w-0">
                  <Database size={13} className="text-slate-400 flex-shrink-0" />
                  <span className="font-semibold text-slate-800 text-[13px]">{d}</span>
                  {(() => {
                    const rm = (sumData?.recovery_models || []).find(r => r.name === d);
                    return rm?.recovery_model_desc ? (
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${rm.recovery_model_desc === 'FULL' ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'}`}>
                        {rm.recovery_model_desc}
                      </span>
                    ) : null;
                  })()}
                </div>
              </label>
            ))}
          </div>
        ) : (
          <input value={dbName} onChange={e => setDbName(e.target.value)}
            placeholder="e.g.  MyDatabase"
            className="w-full h-11 rounded-xl border-2 border-slate-200 px-4 text-[13px] outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 transition-all bg-white" />
        )}
        {btype === 'log' && dbName && (
          <div className="mt-3 flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-xl px-4 py-2.5">
            <AlertCircle size={13} className="text-amber-600 flex-shrink-0 mt-0.5" />
            <p className="text-[11px] text-amber-700">Transaction log backups require the database to be in <strong>FULL</strong> recovery model. Simple recovery mode does not support log backups.</p>
          </div>
        )}
      </SectionCard>

      {/* Step 3 — Backup Path */}
      <SectionCard title="Step 3 — Backup File Location" subtitle="Path on the SQL Server host. Leave blank for SQL Server's configured default directory." icon={FolderOpen} iconColor="text-orange-600">
        <div className="relative mb-3">
          <FolderOpen size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input value={customPath} onChange={e => setCustom(e.target.value)}
            placeholder={`Leave blank = SQL Server default, or: C:\\Backups\\MyDB\\`}
            className="w-full h-11 pl-10 pr-4 rounded-xl border-2 border-slate-200 text-[12px] font-mono outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100 transition-all bg-white" />
        </div>
        {defaultDir && (
          <div className="flex items-start gap-3 bg-slate-50 border border-slate-200 rounded-xl px-4 py-3">
            <FolderOpen size={14} className="text-slate-400 flex-shrink-0 mt-0.5" />
            <div className="min-w-0 flex-1">
              <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wide">
                {customPath.trim() ? '📂 Custom path — file will be:' : '📂 Default — file will be in:'}
              </p>
              <div className="flex items-center gap-2 mt-1">
                <code className="text-[12px] text-slate-800 font-mono truncate">{customPath.trim() || defaultDir}</code>
                <CopyBtn text={customPath.trim() || defaultDir} />
              </div>
              <p className="text-[10px] text-slate-400 mt-1">
                Filename: <code className="font-mono">{dbName || 'DB'}_{btype.toUpperCase()}_{'{YYYYMMDD_HHMMSS}'}.bak</code>
              </p>
            </div>
          </div>
        )}
        <div className="mt-3 flex items-center gap-3">
          <button onClick={() => setCompress(!compress)}
            className={`w-11 h-6 rounded-full transition-all flex items-center px-0.5 flex-shrink-0 ${compress ? 'bg-emerald-500' : 'bg-slate-300'}`}>
            <div className={`w-5 h-5 rounded-full bg-white shadow transition-transform ${compress ? 'translate-x-5' : ''}`} />
          </button>
          <span className="text-[12px] font-semibold text-slate-600">Backup Compression</span>
          <span className="text-[11px] text-slate-400">(SQL Server 2008 Enterprise+ / 2008 R2 Standard+)</span>
        </div>
      </SectionCard>

      {/* Step 4 — Notes */}
      <SectionCard title="Step 4 — Notes (Optional)" subtitle="Tag this backup for easy identification" icon={BookOpen} iconColor="text-slate-400">
        <input value={notes} onChange={e => setNotes(e.target.value)}
          placeholder="e.g.  Pre-deployment snapshot,  Before migration,  Weekly schedule…"
          className="w-full h-11 rounded-xl border-2 border-slate-200 px-4 text-[13px] outline-none focus:border-slate-400 transition-all bg-white" />
      </SectionCard>

      <ResultAlert r={result} />

      <div className="flex items-center gap-3">
        <button onClick={go} disabled={loading || !dbName.trim()}
          className={`flex items-center gap-2 h-12 px-8 rounded-xl font-black text-[14px] text-white shadow-lg disabled:opacity-60 transition-all bg-gradient-to-r ${bt.g} hover:shadow-xl hover:-translate-y-0.5 disabled:hover:translate-y-0`}>
          {loading ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
          {loading ? 'Starting backup…' : `Start ${bt.label}`}
        </button>
        <p className="text-[11px] text-slate-400">Runs via T-SQL on SQL Server — you can leave this page</p>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   SQL SERVER HISTORY (native msdb)
═══════════════════════════════════════════════════════════════════════════ */
function HistoryTab({ connId }) {
  const [dbFilter,   setDbFilter]   = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [days,       setDays]       = useState(30);
  const [search,     setSearch]     = useState('');

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['mssqlBkHist2', connId, dbFilter, typeFilter, days],
    queryFn:  () => api.history(connId, {
      db_name:     dbFilter   || undefined,
      backup_type: typeFilter || undefined,
      days,
      limit: 200,
    }),
    staleTime: 30000,
  });

  const history = (data?.history || []).filter(h => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (h.database_name || '').toLowerCase().includes(q)
      || (h.file_path || '').toLowerCase().includes(q)
      || (h.server_name || '').toLowerCase().includes(q);
  });

  const allDbs = [...new Set((data?.history || []).map(h => h.database_name))].sort();

  const bkTypeBadge = t => {
    const m = {
      full:          'bg-blue-100 text-blue-700',
      differential:  'bg-violet-100 text-violet-700',
      log:           'bg-sky-100 text-sky-700',
      copy_only:     'bg-purple-100 text-purple-700',
    };
    return <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${m[t] || 'bg-slate-100 text-slate-500'}`}>{t?.replace('_',' ') || '—'}</span>;
  };

  return (
    <div className="space-y-3">
      {/* Filters */}
      <div className="bg-white border border-slate-200 rounded-2xl shadow-sm px-5 py-4 flex flex-wrap gap-3 items-end">
        <div>
          <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">Search</label>
          <div className="relative">
            <Search size={12} className="absolute left-2.5 top-2.5 text-slate-400" />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="DB, server, path…"
              className="pl-7 pr-3 py-2 text-[12px] border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400 w-48 bg-slate-50" />
          </div>
        </div>
        <div>
          <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">Database</label>
          <select value={dbFilter} onChange={e => setDbFilter(e.target.value)}
            className="px-3 py-2 text-[12px] border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400 bg-white">
            <option value="">All Databases</option>
            {allDbs.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
        </div>
        <div>
          <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">Type</label>
          <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)}
            className="px-3 py-2 text-[12px] border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400 bg-white">
            <option value="">All Types</option>
            <option value="full">Full</option>
            <option value="differential">Differential</option>
            <option value="log">Transaction Log</option>
            <option value="copy_only">Copy-Only</option>
          </select>
        </div>
        <div>
          <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">Period</label>
          <select value={days} onChange={e => setDays(Number(e.target.value))}
            className="px-3 py-2 text-[12px] border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400 bg-white">
            {[7, 14, 30, 60, 90].map(d => <option key={d} value={d}>Last {d} days</option>)}
          </select>
        </div>
        <button onClick={refetch}
          className="flex items-center gap-1.5 px-3 py-2 bg-blue-600 text-white rounded-lg text-[12px] font-bold hover:bg-blue-700 transition-all">
          <RefreshCw size={11} className={isLoading ? 'animate-spin' : ''} /> Refresh
        </button>
        <span className="text-[12px] text-slate-400 self-center">{history.length} records from <code className="font-mono">msdb.dbo.backupset</code></span>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        {isLoading ? (
          <div className="py-20 flex justify-center"><Loader2 size={28} className="animate-spin text-slate-300" /></div>
        ) : history.length === 0 ? (
          <div className="py-20 text-center">
            <ListTree size={32} className="mx-auto mb-3 text-slate-200" />
            <p className="text-slate-500 font-semibold">No native backup history found</p>
            <p className="text-slate-400 text-sm mt-1">Run a backup first or adjust filters. Data sourced from msdb.dbo.backupset.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>{['Database', 'Type', 'Recovery Model', 'Started', 'Finished', 'Duration', 'Size', 'Compressed', 'Server', 'File Path'].map(h => (
                  <th key={h} className="px-3 py-3 text-left text-[10px] font-bold text-slate-400 uppercase tracking-widest whitespace-nowrap">{h}</th>
                ))}</tr>
              </thead>
              <tbody>
                {history.map((b, i) => (
                  <tr key={i} className="border-t border-slate-100 hover:bg-blue-50/20 transition-colors">
                    <td className="px-3 py-2.5 font-semibold text-blue-700">{b.database_name}</td>
                    <td className="px-3 py-2.5">{bkTypeBadge(b.backup_type)}</td>
                    <td className="px-3 py-2.5">
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${b.recovery_model === 'FULL' ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-500'}`}>
                        {b.recovery_model || '—'}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 font-mono text-slate-500 text-[11px]">{(b.backup_start || '').slice(0,16)}</td>
                    <td className="px-3 py-2.5 font-mono text-slate-500 text-[11px]">{(b.backup_finish || '').slice(0,16)}</td>
                    <td className="px-3 py-2.5 font-mono">{b.duration_sec != null ? `${b.duration_sec}s` : '—'}</td>
                    <td className="px-3 py-2.5 font-mono">{fmtMb(b.size_mb)}</td>
                    <td className="px-3 py-2.5 font-mono text-slate-400">{fmtMb(b.compressed_mb)}</td>
                    <td className="px-3 py-2.5 text-slate-500">{b.server_name || '—'}</td>
                    <td className="px-3 py-2.5 max-w-[200px]">
                      <div className="flex items-center gap-1.5" title={b.file_path}>
                        <span className="font-mono text-[10px] text-slate-500 truncate">{b.file_path ? fname(b.file_path) : '—'}</span>
                        {b.file_path && <CopyBtn text={b.file_path} />}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   PITR / RESTORE
═══════════════════════════════════════════════════════════════════════════ */
function PITRTab({ connId, showToast, refresh }) {
  const [selDb,      setSelDb]      = useState('');
  const [dt,         setDt]         = useState('');
  const [restoreAs,  setRestoreAs]  = useState('');
  const [confirm,    setConfirm]    = useState(false);
  const [loading,    setLoading]    = useState(false);
  const [result,     setResult]     = useState(null);
  const [expChain,   setExpChain]   = useState({});

  const { data: chainData, isLoading: chainLoading } = useQuery({
    queryKey: ['mssqlChain2', connId],
    queryFn:  () => api.recoveryChain(connId),
    staleTime: 30000,
  });

  const chains = chainData?.chains || [];
  const sel    = chains.find(c => c.database === selDb);
  const dtFmt  = dt.replace('T', ' ');

  const go = async () => {
    if (!selDb || !dt) return setResult({ ok: false, msg: 'Select a database and target datetime.' });
    if (!confirm)      return setResult({ ok: false, msg: 'Check the confirmation box to proceed.' });
    setLoading(true); setResult(null);
    try {
      const res = await api.pitr(connId, {
        database:         selDb,
        target_datetime:  dtFmt,
        restore_as:       restoreAs.trim() || null,
        confirm:          true,
      });
      setResult({ ok: true, msg: `PITR started — restoring "${selDb}" to ${dtFmt}`, jobId: res.job_id });
      setConfirm(false);
      refresh();
    } catch (e) {
      setResult({ ok: false, msg: e?.response?.data?.detail || e.message || 'PITR failed to start' });
    } finally { setLoading(false); }
  };

  return (
    <div className="space-y-4">

      {/* PITR Explainer */}
      <div className="bg-white rounded-2xl border border-teal-200 shadow-sm overflow-hidden">
        <div className="h-[3px] bg-gradient-to-r from-teal-400 to-emerald-500" />
        <div className="px-5 py-4">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-teal-500 to-emerald-600 flex items-center justify-center flex-shrink-0">
              <Target size={17} className="text-white" />
            </div>
            <div>
              <h3 className="font-black text-slate-900 text-[14px]">Point-in-Time Recovery (PITR)</h3>
              <p className="text-[11px] text-slate-400">Recover any database to any second in history using SQL Server's native RESTORE chain</p>
            </div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              { n: 1, t: 'Full Backup Restored',    d: 'RESTORE DATABASE ... WITH NORECOVERY',             c: 'from-blue-500 to-indigo-600'   },
              { n: 2, t: 'Differential Applied',    d: 'RESTORE DATABASE ... WITH NORECOVERY (optional)',  c: 'from-violet-500 to-purple-600'  },
              { n: 3, t: 'Log Backups Replayed',    d: 'RESTORE LOG ... WITH NORECOVERY (repeat)',         c: 'from-sky-500 to-cyan-600'       },
              { n: 4, t: 'Database Online at PITR', d: 'RESTORE DATABASE ... WITH RECOVERY, STOPAT=\'…\'', c: 'from-teal-500 to-emerald-600'   },
            ].map(s => (
              <div key={s.n} className="bg-slate-50 rounded-xl p-3 border border-slate-200">
                <div className={`w-7 h-7 rounded-full bg-gradient-to-br ${s.c} flex items-center justify-center text-[12px] font-black text-white mb-2`}>{s.n}</div>
                <p className="font-bold text-slate-800 text-[12px]">{s.t}</p>
                <p className="text-[10px] text-slate-400 mt-1 font-mono leading-relaxed">{s.d}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Recovery Chain Per Database */}
      <SectionCard title="Recovery Chains" subtitle="Available recovery windows per database — click to expand" icon={ListTree} iconColor="text-teal-600">
        {chainLoading ? (
          <div className="py-10 flex justify-center"><Loader2 size={24} className="animate-spin text-slate-300" /></div>
        ) : chains.length === 0 ? (
          <div className="py-8 text-center text-slate-400">
            <Shield size={28} className="mx-auto mb-2 text-slate-200" />
            <p className="font-semibold">No recovery chains found</p>
            <p className="text-sm mt-1">Take a full backup first, then log backups to enable PITR.</p>
          </div>
        ) : chains.map(chain => (
          <div key={chain.database} className="mb-2 border border-slate-200 rounded-2xl overflow-hidden">
            <button
              onClick={() => setExpChain(ec => ({ ...ec, [chain.database]: !ec[chain.database] }))}
              className="w-full flex items-center gap-3 px-4 py-3 bg-slate-50 hover:bg-slate-100 text-left transition-all">
              <Database size={14} className="text-blue-500 shrink-0" />
              <span className="font-bold text-sm text-slate-800 flex-1">{chain.database}</span>
              <div className="flex items-center gap-2 text-xs flex-wrap">
                {chain.has_full ? (
                  <>
                    <span className="px-2 py-0.5 bg-blue-100 text-blue-700 rounded-full font-bold text-[10px]">✓ FULL</span>
                    {chain.differentials?.length > 0 && <span className="px-2 py-0.5 bg-violet-100 text-violet-700 rounded-full font-bold text-[10px]">{chain.differentials.length} DIFF</span>}
                    {chain.log_count > 0
                      ? <>
                          <span className="px-2 py-0.5 bg-teal-100 text-teal-700 rounded-full font-bold text-[10px]">{chain.log_count} LOG</span>
                          <span className="text-[10px] text-slate-500 hidden md:inline">
                            PITR: {chain.earliest_pitr?.slice(0,16)} → <strong className="text-teal-600">{chain.latest_pitr?.slice(0,16)}</strong>
                          </span>
                        </>
                      : <span className="px-2 py-0.5 bg-amber-100 text-amber-700 rounded-full font-bold text-[10px]">No Logs — PITR unavailable</span>
                    }
                  </>
                ) : (
                  <span className="px-2 py-0.5 bg-red-100 text-red-600 rounded-full font-bold text-[10px]">NO FULL BACKUP</span>
                )}
              </div>
              {expChain[chain.database] ? <ChevronUp size={14} className="text-slate-400 shrink-0" /> : <ChevronDown size={14} className="text-slate-400 shrink-0" />}
            </button>

            {expChain[chain.database] && chain.has_full && (
              <div className="p-4 space-y-3 bg-white border-t border-slate-100">
                {/* Full */}
                <div>
                  <p className="text-[10px] font-bold text-slate-400 uppercase mb-1.5 flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-blue-500" /> Full Backup (latest)</p>
                  <div className="flex items-center gap-3 p-2.5 bg-blue-50 border border-blue-100 rounded-xl text-[12px]">
                    <span className="font-mono text-slate-600">{chain.full_backup?.backup_finish?.slice(0,16)}</span>
                    <span className="text-slate-400">{chain.full_backup?.size_mb ? `${Number(chain.full_backup.size_mb).toFixed(0)} MB` : ''}</span>
                    <span className="text-[10px] text-slate-400 font-mono truncate flex-1" title={chain.full_backup?.file_path}>{chain.full_backup?.file_path ? fname(chain.full_backup.file_path) : ''}</span>
                    {chain.full_backup?.file_path && <CopyBtn text={chain.full_backup.file_path} />}
                  </div>
                </div>

                {/* Differentials */}
                {chain.differentials?.length > 0 && (
                  <div>
                    <p className="text-[10px] font-bold text-slate-400 uppercase mb-1.5 flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-violet-500" /> Differential Backups ({chain.differentials.length})</p>
                    {chain.differentials.slice(0, 3).map((d, i) => (
                      <div key={i} className="flex items-center gap-3 p-2 bg-violet-50 border border-violet-100 rounded-xl text-[11px] mb-1">
                        <span className="font-mono text-slate-600">{d.backup_finish?.slice(0,16)}</span>
                        <span className="text-slate-400">{d.size_mb ? `${Number(d.size_mb).toFixed(0)} MB` : ''}</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Log timeline */}
                {chain.log_count > 0 && (
                  <div>
                    <p className="text-[10px] font-bold text-slate-400 uppercase mb-1.5 flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full bg-teal-500" />
                      Log Chain ({chain.log_count} backups — PITR available {chain.earliest_pitr?.slice(0,16)} → {chain.latest_pitr?.slice(0,16)})
                    </p>
                    <div className="flex items-end gap-0.5 overflow-x-auto pb-1">
                      {(chain.log_backups || []).slice(0, 40).map((lg, i) => (
                        <div key={i}
                          title={`${lg.backup_start?.slice(0,16)} — ${lg.size_mb ? Number(lg.size_mb).toFixed(0) + 'MB' : ''}`}
                          className="w-3 h-7 rounded-sm bg-teal-300 hover:bg-teal-500 cursor-pointer shrink-0 transition-colors" />
                      ))}
                      {chain.log_count > 40 && <span className="text-[10px] text-slate-400 whitespace-nowrap ml-1">+{chain.log_count - 40} more</span>}
                    </div>
                  </div>
                )}

                {chain.log_count === 0 && (
                  <div className="flex items-center gap-2 p-2.5 bg-amber-50 border border-amber-200 rounded-xl text-[11px] text-amber-700">
                    <AlertTriangle size={12} /> No transaction log backups. Set database to FULL recovery model and schedule log backups to enable PITR.
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </SectionCard>

      {/* PITR Form */}
      <div className="max-w-2xl space-y-4">
        <DangerBox title="⚠ Destructive — Read Before Proceeding"
          msg="This will RESTORE the database to the specified point in time. All data after that timestamp will be permanently lost. Use 'Restore As' to recover into a new database name for safety." />

        <SectionCard title="Step 1 — Select Database to Recover" subtitle="Only databases with full + log backups support PITR" icon={Database} iconColor="text-teal-600">
          {chains.filter(c => c.has_full && c.log_count > 0).length === 0 ? (
            <div className="py-8 text-center">
              <Shield size={28} className="mx-auto mb-3 text-slate-200" />
              <p className="text-slate-500 font-semibold">No databases eligible for PITR</p>
              <p className="text-slate-400 text-sm mt-1">A full backup + at least one transaction log backup is required.</p>
            </div>
          ) : (
            <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
              {chains.filter(c => c.has_full && c.log_count > 0).map(c => (
                <label key={c.database}
                  className={`flex gap-4 p-3.5 rounded-xl border-2 cursor-pointer transition-all ${selDb === c.database ? 'border-teal-400 bg-teal-50' : 'border-slate-200 bg-white hover:border-slate-300'}`}>
                  <input type="radio" name="pitrdb" value={c.database} checked={selDb === c.database}
                    onChange={() => { setSelDb(c.database); setDt(''); }} className="mt-0.5 flex-shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-black text-slate-900">{c.database}</span>
                      <span className="text-[11px] font-bold text-teal-700 bg-teal-50 border border-teal-200 rounded-full px-2 py-0.5">{c.log_count} log backups</span>
                      {c.recovery_model && <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${c.recovery_model === 'FULL' ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'}`}>{c.recovery_model}</span>}
                    </div>
                    <p className="text-[11px] text-slate-400 mt-0.5">
                      Recovery window: <strong className="text-teal-600">{c.earliest_pitr?.slice(0,16)}</strong> → <strong className="text-teal-600">{c.latest_pitr?.slice(0,16)}</strong>
                    </p>
                  </div>
                </label>
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard title="Step 2 — Target Recovery Time" subtitle="Set to 1 second BEFORE the incident to exclude the crash event" icon={Clock} iconColor="text-teal-600">
          <input type="datetime-local" step="1" value={dt.replace(' ', 'T')}
            onChange={e => setDt(e.target.value)}
            min={sel?.earliest_pitr ? sel.earliest_pitr.slice(0,16).replace(' ','T') : undefined}
            max={sel?.latest_pitr   ? sel.latest_pitr.slice(0,16).replace(' ','T')   : undefined}
            className="w-full h-11 rounded-xl border-2 border-slate-200 px-4 text-[13px] outline-none focus:border-teal-400 focus:ring-2 focus:ring-teal-100 transition-all bg-white" />
          {dt && (
            <div className="mt-3 flex items-center gap-2 bg-teal-50 border border-teal-200 rounded-xl px-4 py-2.5">
              <CheckCircle2 size={14} className="text-teal-600 flex-shrink-0" />
              <p className="text-[12px] font-bold text-teal-700">Will recover to: <code className="font-mono text-[13px]">{dtFmt}</code></p>
            </div>
          )}
          {sel && !dt && (
            <p className="mt-2 text-[12px] text-slate-400">
              Available: <code className="font-mono text-xs bg-slate-100 px-1 rounded">{sel.earliest_pitr?.slice(0,16)}</code> → <code className="font-mono text-xs bg-teal-100 text-teal-700 px-1 rounded">{sel.latest_pitr?.slice(0,16)}</code>
            </p>
          )}
        </SectionCard>

        <SectionCard title="Step 3 — Restore As (Recommended)" subtitle="Restore into a new database name to avoid overwriting production data" icon={Database} iconColor="text-blue-600">
          <input value={restoreAs} onChange={e => setRestoreAs(e.target.value)}
            placeholder={selDb ? `e.g. ${selDb}_recovered_${new Date().toLocaleDateString('en', {month:'short',day:'2-digit'}).replace(' ','').toLowerCase()}` : 'New database name (leave empty to overwrite original)'}
            className="w-full h-11 rounded-xl border-2 border-slate-200 px-4 text-[13px] outline-none focus:border-blue-400 transition-all bg-white" />
          {!restoreAs && selDb && (
            <p className="mt-2 text-[12px] text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 flex items-center gap-2">
              <AlertTriangle size={12} /> Leaving blank will overwrite the live <strong>{selDb}</strong> database.
            </p>
          )}
        </SectionCard>

        <label className="flex items-start gap-3 p-4 bg-red-50 border-2 border-red-200 rounded-2xl cursor-pointer hover:bg-red-100/60 transition-all">
          <div className={`w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 mt-0.5 transition-all ${confirm ? 'bg-red-600 border-red-600' : 'border-slate-400 bg-white'}`}>
            {confirm && <CheckCheck size={11} className="text-white" />}
          </div>
          <input type="checkbox" checked={confirm} onChange={e => setConfirm(e.target.checked)} className="sr-only" />
          <span className="text-[13px] text-red-700">
            I confirm: restore <strong>{selDb || '(no DB selected)'}</strong> to <strong>{dtFmt || '(no time set)'}</strong>
            {restoreAs ? <> as new database <strong>{restoreAs}</strong></> : <> — this will <strong>permanently overwrite</strong> the current database</>}.
          </span>
        </label>

        <ResultAlert r={result} />

        <button onClick={go} disabled={loading || !confirm || !selDb || !dt}
          className="flex items-center gap-2 h-12 px-8 rounded-xl font-black text-[14px] text-white shadow-lg disabled:opacity-50 transition-all bg-gradient-to-r from-teal-600 to-emerald-600 hover:shadow-xl hover:-translate-y-0.5 disabled:hover:translate-y-0">
          {loading ? <Loader2 size={16} className="animate-spin" /> : <RotateCcw size={16} />}
          {loading ? 'Running PITR…' : 'Start Point-in-Time Recovery'}
        </button>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   SCHEDULE TAB
═══════════════════════════════════════════════════════════════════════════ */
const SCHED_TYPES = [
  { id: 'every_x_minutes', label: 'Every X Min',  icon: '⚡', desc: 'Repeat every N minutes' },
  { id: 'hourly',          label: 'Hourly',        icon: '🕐', desc: 'Once per hour at :MM' },
  { id: 'daily',           label: 'Daily',         icon: '📅', desc: 'Once a day at a chosen time' },
  { id: 'weekly',          label: 'Weekly',        icon: '📆', desc: 'Specific day(s) of week + time' },
  { id: 'monthly',         label: 'Monthly',       icon: '🗓', desc: 'A specific date each month' },
];
const DOW_LABELS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
const EMPTY_FORM = {
  name: '', backup_type: 'full', schedule_type: 'daily',
  interval_minutes: 30, minute: 0, hour: 2,
  day_of_week: '0,1,2,3,4', day_of_month: 1,
  databases: '', compress: true,
  backup_path: '', retain_days: 7, enabled: true,
};

function TimePicker12h({ hour24 = 2, minute = 0, onChange, label }) {
  const isPM = hour24 >= 12;
  const h12  = hour24 === 0 ? 12 : hour24 > 12 ? hour24 - 12 : hour24;
  const applyH12 = h => { const h24 = isPM ? (h === 12 ? 12 : h + 12) : (h === 12 ? 0 : h); onChange(h24, minute); };
  const applyMin = m => onChange(hour24, m);
  const flip     = () => { const h24 = isPM ? (h12 === 12 ? 0 : h12) : (h12 === 12 ? 12 : h12 + 12); onChange(h24, minute); };
  const sel = "h-10 rounded-xl border-2 border-slate-200 text-[13px] font-bold text-center outline-none focus:border-sky-400 bg-white cursor-pointer";
  return (
    <div>
      {label && <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-1.5">{label}</label>}
      <div className="flex items-center gap-1.5">
        <select value={h12} onChange={e => applyH12(Number(e.target.value))} className={`${sel} w-16 pl-2`}>
          {[12,1,2,3,4,5,6,7,8,9,10,11].map(h => <option key={h} value={h}>{h}</option>)}
        </select>
        <span className="font-black text-slate-600 text-[18px] leading-none">:</span>
        <select value={minute} onChange={e => applyMin(Number(e.target.value))} className={`${sel} w-16 pl-2`}>
          {Array.from({length:60},(_,i)=>i).map(m => <option key={m} value={m}>{String(m).padStart(2,'0')}</option>)}
        </select>
        <button type="button" onClick={flip}
          className={`h-10 px-4 rounded-xl border-2 text-[13px] font-black tracking-wide transition-all select-none
            ${isPM ? 'border-violet-400 bg-violet-50 text-violet-700 hover:bg-violet-100' : 'border-sky-400 bg-sky-50 text-sky-700 hover:bg-sky-100'}`}>
          {isPM ? 'PM' : 'AM'}
        </button>
      </div>
    </div>
  );
}

function ScheduleTab({ connId, showToast }) {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [editing,  setEditing]  = useState(null);
  const [form,     setForm]     = useState(EMPTY_FORM);
  const [saving,   setSaving]   = useState(false);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['mssqlScheds2', connId],
    queryFn:  () => api.listSchedules(connId),
    refetchInterval: 10000,
    retry: 1,
  });
  const schedules  = data?.schedules || [];
  const apiErr     = data?.status === 'error' ? data.error : null;
  const queryFailed = isError || !!apiErr;

  const setF = patch => setForm(f => ({ ...f, ...patch }));
  const openNew  = () => { setForm(EMPTY_FORM); setEditing(null); setShowForm(true); };
  const openEdit = s => {
    setForm({
      name:             s.name,
      backup_type:      s.backup_type,
      schedule_type:    s.schedule_type,
      interval_minutes: s.interval_minutes || 30,
      minute:           s.minute ?? 0,
      hour:             s.hour ?? 2,
      day_of_week:      s.day_of_week || '0,1,2,3,4',
      day_of_month:     s.day_of_month || 1,
      databases:        Array.isArray(s.databases) ? s.databases.join(', ') : '',
      compress:         !!s.compress,
      backup_path:      s.backup_path || '',
      retain_days:      s.retain_days || 7,
      enabled:          s.enabled,
    });
    setEditing(s.id);
    setShowForm(true);
  };
  const invalidate = () => { qc.invalidateQueries({ queryKey: ['mssqlScheds2', connId] }); refetch(); };

  const save = async () => {
    if (!form.name.trim()) return showToast('Schedule name is required', 'error');
    setSaving(true);
    try {
      const payload = {
        ...form,
        hour:             Number(form.hour),
        minute:           Number(form.minute),
        interval_minutes: Number(form.interval_minutes),
        day_of_month:     Number(form.day_of_month),
        retain_days:      Number(form.retain_days),
        databases:        form.databases.trim()
          ? form.databases.split(',').map(d => d.trim()).filter(Boolean)
          : null,
        backup_path: form.backup_path.trim() || null,
      };
      if (editing) {
        await api.updateSchedule(connId, editing, payload);
        showToast('Schedule updated');
      } else {
        await api.createSchedule(connId, payload);
        showToast('Schedule created');
      }
      invalidate();
      setShowForm(false);
    } catch (e) {
      showToast(e?.response?.data?.detail || e.message || 'Save failed', 'error');
    } finally { setSaving(false); }
  };

  const deleteSched = async sid => {
    if (!window.confirm('Delete this schedule?')) return;
    try { await api.deleteSchedule(connId, sid); showToast('Schedule deleted'); invalidate(); }
    catch (e) { showToast(e.message || 'Delete failed', 'error'); }
  };

  const toggle = async (sid, enabled) => {
    try { await api.toggleSchedule(connId, sid, enabled); showToast(enabled ? 'Schedule enabled' : 'Schedule paused'); invalidate(); }
    catch (e) { showToast(e.message || 'Toggle failed', 'error'); }
  };

  const runNow = async sid => {
    try { await api.runNow(connId, sid); showToast('Backup triggered — check My Backups'); invalidate(); }
    catch (e) { showToast(e?.response?.data?.detail || e.message || 'Run failed', 'error'); }
  };

  const toggleDow = idx => {
    const set = new Set((form.day_of_week || '').split(',').map(s => s.trim()).filter(Boolean).map(Number));
    if (set.has(idx)) set.delete(idx); else set.add(idx);
    setF({ day_of_week: [...set].sort((a,b)=>a-b).join(',') || '0' });
  };
  const selDow = new Set((form.day_of_week || '0').split(',').map(s => Number(s.trim())));
  const onTime = (h24, m) => setF({ hour: h24, minute: m });

  const preview = (() => {
    const st = form.schedule_type;
    const h  = Number(form.hour ?? 2), m = Number(form.minute ?? 0);
    const per = h < 12 ? 'AM' : 'PM';
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    const t   = `${h12}:${String(m).padStart(2,'0')} ${per}`;
    if (st === 'every_x_minutes') { const n = Number(form.interval_minutes) || 30; return `Every ${n < 60 ? n + ' min' : n/60 + ' hr'}`; }
    if (st === 'hourly')  return `Every hour at :${String(m).padStart(2,'0')}`;
    if (st === 'daily')   return `Daily at ${t}`;
    if (st === 'weekly')  { const days = (form.day_of_week||'0').split(',').map(d=>DOW_LABELS[Number(d.trim())]).filter(Boolean).join(', '); return `${days||'Mon'} at ${t}`; }
    if (st === 'monthly') { const dom = Number(form.day_of_month)||1; const sfx=dom===1?'st':dom===2?'nd':dom===3?'rd':'th'; return `${dom}${sfx} of every month at ${t}`; }
    return '';
  })();

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap bg-white rounded-2xl border border-slate-200 shadow-sm px-5 py-4">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-sky-500 to-blue-600 flex items-center justify-center flex-shrink-0">
            <CalendarClock size={17} className="text-white" />
          </div>
          <div>
            <h2 className="font-black text-slate-900 text-[15px]">Backup Schedules</h2>
            <p className="text-[11px] text-slate-400">{schedules.length} schedule{schedules.length!==1?'s':''} · auto-checks every 60 s on backend</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={refetch} className="w-8 h-8 rounded-xl border border-slate-200 flex items-center justify-center hover:bg-slate-50 text-slate-500 transition-all">
            <RefreshCw size={13} className={isLoading ? 'animate-spin' : ''} />
          </button>
          <button onClick={openNew} className="flex items-center gap-2 h-9 px-4 rounded-xl bg-gradient-to-r from-sky-500 to-blue-600 text-white text-[13px] font-bold shadow-md hover:shadow-lg hover:-translate-y-0.5 transition-all">
            <Plus size={14} /> New Schedule
          </button>
        </div>
      </div>

      {/* Form */}
      {showForm && (
        <div className="bg-white rounded-2xl border-2 border-sky-200 shadow-lg overflow-hidden">
          <div className="bg-gradient-to-r from-sky-50 to-blue-50 border-b border-sky-200 px-5 py-3 flex items-center justify-between">
            <h3 className="font-black text-sky-800 text-[14px] flex items-center gap-2"><CalendarClock size={15} className="text-sky-600" />{editing ? 'Edit Schedule' : 'New Schedule'}</h3>
            <button onClick={() => setShowForm(false)} className="w-7 h-7 rounded-lg hover:bg-sky-200/60 flex items-center justify-center text-sky-600"><XCircle size={14} /></button>
          </div>

          {(form.name || preview) && (
            <div className="bg-sky-50 border-b border-sky-100 px-5 py-2 flex items-center gap-2">
              <Clock size={11} className="text-sky-400 flex-shrink-0" />
              {form.name && <span className="text-[12px] font-bold text-sky-700">{form.name} —</span>}
              <span className="text-[12px] text-sky-600">{preview || '…'}</span>
            </div>
          )}

          <div className="p-5 grid grid-cols-1 md:grid-cols-2 gap-5">
            {/* Name */}
            <div className="md:col-span-2">
              <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-1.5">Schedule Name *</label>
              <input value={form.name} onChange={e => setF({ name: e.target.value })} placeholder="e.g. Nightly Full Backup, Hourly Log…"
                className="w-full h-10 rounded-xl border-2 border-slate-200 px-4 text-[13px] outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-100 transition-all bg-white" />
            </div>

            {/* Backup type */}
            <div>
              <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-1.5">Backup Type</label>
              <div className="flex gap-2 flex-wrap">
                {[{ id:'full',label:'Full' },{ id:'differential',label:'Differential' },{ id:'log',label:'Log' },{ id:'copy_only',label:'Copy-Only' }].map(bt => (
                  <button key={bt.id} onClick={() => setF({ backup_type: bt.id })}
                    className={`flex-1 min-w-[80px] h-12 rounded-xl text-[12px] font-bold border-2 transition-all
                      ${form.backup_type===bt.id ? 'border-sky-500 bg-sky-50 text-sky-700' : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300'}`}>
                    {bt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Frequency */}
            <div>
              <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-1.5">Frequency</label>
              <div className="grid grid-cols-5 gap-1">
                {SCHED_TYPES.map(st => (
                  <button key={st.id} onClick={() => setF({ schedule_type: st.id })} title={st.desc}
                    className={`flex flex-col items-center justify-center h-[58px] rounded-xl text-[9px] font-bold border-2 transition-all gap-0.5 px-1
                      ${form.schedule_type===st.id ? 'border-sky-500 bg-sky-50 text-sky-700' : 'border-slate-200 bg-slate-50/60 text-slate-500 hover:border-slate-300 hover:bg-white'}`}>
                    <span className="text-[17px]">{st.icon}</span>
                    <span className="text-center leading-tight">{st.label}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Every X minutes */}
            {form.schedule_type === 'every_x_minutes' && (
              <div className="md:col-span-2">
                <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-1.5">Run every…</label>
                <div className="flex flex-wrap gap-2 mb-2">
                  {[5,10,15,20,30,45,60,120,240,360,720].map(v => (
                    <button key={v} onClick={() => setF({ interval_minutes: v })}
                      className={`h-9 px-3 rounded-xl text-[12px] font-bold border-2 transition-all ${form.interval_minutes===v ? 'border-sky-500 bg-sky-50 text-sky-700' : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300'}`}>
                      {v<60 ? `${v} min` : `${v/60} hr`}
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <input type="number" min={1} max={1440} value={form.interval_minutes} onChange={e => setF({ interval_minutes: Math.max(1, Number(e.target.value)) })}
                    className="w-28 h-9 rounded-xl border-2 border-slate-200 px-3 text-[13px] font-mono font-bold outline-none focus:border-sky-400 bg-white" />
                  <span className="text-[12px] text-slate-500">minutes (custom)</span>
                </div>
              </div>
            )}

            {/* Hourly minute */}
            {form.schedule_type === 'hourly' && (
              <div>
                <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-1.5">At minute past each hour</label>
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {[0,5,10,15,20,25,30,35,40,45,50,55].map(m => (
                    <button key={m} onClick={() => setF({ minute: m })}
                      className={`h-8 w-11 rounded-lg text-[12px] font-bold border-2 transition-all ${form.minute===m ? 'border-sky-500 bg-sky-50 text-sky-700' : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300'}`}>
                      :{String(m).padStart(2,'0')}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Daily / Weekly / Monthly time */}
            {(form.schedule_type==='daily'||form.schedule_type==='weekly'||form.schedule_type==='monthly') && (
              <TimePicker12h hour24={form.hour} minute={form.minute} onChange={onTime} label="Time (UTC)" />
            )}

            {/* Weekly DOW */}
            {form.schedule_type === 'weekly' && (
              <div>
                <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-1.5">Day(s) of Week</label>
                <div className="flex gap-1.5 flex-wrap mb-2">
                  {DOW_LABELS.map((d,i) => (
                    <button key={i} onClick={() => toggleDow(i)}
                      className={`w-12 h-9 rounded-xl text-[12px] font-bold border-2 transition-all ${selDow.has(i) ? 'border-sky-500 bg-sky-100 text-sky-700' : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300'}`}>
                      {d}
                    </button>
                  ))}
                </div>
                <div className="flex gap-3">
                  <button onClick={() => setF({ day_of_week:'0,1,2,3,4' })} className="text-[11px] text-sky-600 font-bold hover:underline">Weekdays</button>
                  <button onClick={() => setF({ day_of_week:'5,6' })}       className="text-[11px] text-sky-600 font-bold hover:underline">Weekend</button>
                  <button onClick={() => setF({ day_of_week:'0,1,2,3,4,5,6' })} className="text-[11px] text-sky-600 font-bold hover:underline">Every day</button>
                </div>
              </div>
            )}

            {/* Monthly DOM */}
            {form.schedule_type === 'monthly' && (
              <div>
                <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-1.5">Day of Month</label>
                <div className="grid grid-cols-7 gap-1 mb-1">
                  {Array.from({length:28},(_,i)=>i+1).map(d => (
                    <button key={d} onClick={() => setF({ day_of_month: d })}
                      className={`h-8 rounded-lg text-[12px] font-bold border-2 transition-all ${form.day_of_month===d ? 'border-sky-500 bg-sky-100 text-sky-700' : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300'}`}>
                      {d}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="md:col-span-2 border-t border-dashed border-slate-200" />

            {/* Databases */}
            <div>
              <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-1.5">Database(s)</label>
              <input value={form.databases} onChange={e => setF({ databases: e.target.value })} placeholder="Empty = all user DBs, or: db1, db2"
                className="w-full h-10 rounded-xl border-2 border-slate-200 px-4 text-[12px] outline-none focus:border-sky-400 bg-white" />
            </div>

            {/* Retain days */}
            <div>
              <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-1.5">Keep jobs for</label>
              <div className="flex gap-1.5">
                {[3,7,14,30,60,90].map(v => (
                  <button key={v} onClick={() => setF({ retain_days: v })}
                    className={`flex-1 h-10 rounded-xl text-[12px] font-bold border-2 transition-all ${form.retain_days===v ? 'border-sky-500 bg-sky-50 text-sky-700' : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300'}`}>
                    {v}d
                  </button>
                ))}
              </div>
            </div>

            {/* Compress */}
            <div className="flex items-center gap-3">
              <button onClick={() => setF({ compress: !form.compress })}
                className={`w-11 h-6 rounded-full transition-all flex items-center px-0.5 flex-shrink-0 ${form.compress ? 'bg-emerald-500' : 'bg-slate-300'}`}>
                <div className={`w-5 h-5 rounded-full bg-white shadow transition-transform ${form.compress ? 'translate-x-5' : ''}`} />
              </button>
              <span className="text-[12px] font-semibold text-slate-600">Backup Compression</span>
            </div>

            {/* Enabled */}
            <div className="flex items-center gap-3">
              <button onClick={() => setF({ enabled: !form.enabled })}
                className={`w-11 h-6 rounded-full transition-all flex items-center px-0.5 flex-shrink-0 ${form.enabled ? 'bg-sky-500' : 'bg-slate-300'}`}>
                <div className={`w-5 h-5 rounded-full bg-white shadow transition-transform ${form.enabled ? 'translate-x-5' : ''}`} />
              </button>
              <span className="text-[12px] font-semibold text-slate-600">{form.enabled ? 'Active immediately' : 'Save as disabled'}</span>
            </div>

            {/* Backup path */}
            <div className="md:col-span-2">
              <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-1.5">Custom Backup Path <span className="font-normal text-slate-400 normal-case">(on SQL Server host — optional)</span></label>
              <div className="relative">
                <FolderOpen size={13} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
                <input value={form.backup_path} onChange={e => setF({ backup_path: e.target.value })} placeholder="e.g. C:\Backups\Scheduled\ or leave blank for SQL Server default"
                  className="w-full h-10 pl-9 pr-4 rounded-xl border-2 border-slate-200 text-[12px] font-mono outline-none focus:border-sky-400 bg-white" />
              </div>
            </div>
          </div>

          <div className="px-5 pb-5 pt-3 border-t border-slate-100 flex items-center gap-3 flex-wrap">
            <button onClick={save} disabled={saving}
              className="flex items-center gap-2 h-10 px-6 rounded-xl bg-gradient-to-r from-sky-500 to-blue-600 text-white text-[13px] font-bold disabled:opacity-60 shadow-md hover:shadow-lg transition-all">
              {saving ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
              {saving ? 'Saving…' : editing ? 'Update Schedule' : 'Create Schedule'}
            </button>
            <button onClick={() => setShowForm(false)} className="h-10 px-5 rounded-xl border border-slate-200 text-[13px] font-semibold text-slate-600 hover:bg-slate-50 transition-all">Cancel</button>
            {preview && <span className="ml-auto text-[11px] font-semibold text-sky-600 hidden md:block">⏱ {preview}</span>}
          </div>
        </div>
      )}

      {/* Schedule list */}
      {isLoading ? (
        <div className="bg-white rounded-2xl border border-slate-200 p-16 flex items-center justify-center"><Loader2 size={28} className="animate-spin text-slate-300" /></div>
      ) : queryFailed ? (
        <div className="bg-white rounded-2xl border border-red-200 shadow-sm p-6 flex items-start gap-3">
          <AlertTriangle size={16} className="text-red-500 flex-shrink-0 mt-0.5" />
          <div>
            <p className="font-bold text-red-700 text-[13px]">Could not load schedules</p>
            <p className="text-[12px] text-red-600 mt-1 font-mono break-all">{apiErr || error?.response?.data?.detail || error?.message || 'Unknown error'}</p>
            <button onClick={() => refetch()} className="mt-3 flex items-center gap-2 h-8 px-4 rounded-lg border border-red-200 text-[12px] font-bold text-red-600 hover:bg-red-50 transition-all"><RefreshCw size={12} /> Retry</button>
          </div>
        </div>
      ) : schedules.length === 0 ? (
        <div className="bg-white rounded-2xl border border-slate-200 py-20 text-center">
          <div className="w-16 h-16 rounded-2xl bg-sky-50 border border-sky-100 flex items-center justify-center mx-auto mb-4"><CalendarClock size={28} className="text-sky-300" /></div>
          <p className="font-bold text-slate-600 text-[15px]">No schedules yet</p>
          <p className="text-slate-400 text-[13px] mt-1 max-w-sm mx-auto">Automate backups — nightly full at 2:00 AM, every 15 min log backups, weekly differentials…</p>
          <button onClick={openNew} className="mt-5 inline-flex items-center gap-2 h-10 px-6 rounded-xl bg-gradient-to-r from-sky-500 to-blue-600 text-white text-[13px] font-bold shadow-md">
            <Plus size={14} /> Create First Schedule
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {schedules.map(s => {
            const typeIcon = SCHED_TYPES.find(t => t.id === s.schedule_type)?.icon || '📅';
            const btColors = { full:'bg-blue-100 text-blue-700', differential:'bg-violet-100 text-violet-700', log:'bg-sky-100 text-sky-700', copy_only:'bg-purple-100 text-purple-700' };
            return (
              <div key={s.id} className={`bg-white rounded-2xl border shadow-sm overflow-hidden transition-all ${s.enabled ? 'border-slate-200' : 'border-slate-200 opacity-60'}`}>
                <div className="h-[3px] bg-gradient-to-r from-sky-400 to-blue-500" />
                <div className="px-5 py-4">
                  <div className="flex items-start gap-4 flex-wrap">
                    <div className="w-10 h-10 rounded-xl bg-sky-50 border border-sky-100 flex items-center justify-center flex-shrink-0 text-[20px]">{typeIcon}</div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap mb-1">
                        <h3 className="font-black text-slate-900 text-[14px]">{s.name}</h3>
                        {s.human_schedule && (
                          <span className="text-[11px] font-bold bg-sky-100 text-sky-700 px-2.5 py-0.5 rounded-full border border-sky-200">{s.human_schedule}</span>
                        )}
                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${btColors[s.backup_type] || 'bg-slate-100 text-slate-600'}`}>{s.backup_type?.replace('_',' ')}</span>
                        {s.last_status && <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-slate-100 text-slate-500">Last: {s.last_status}</span>}
                        {!s.enabled && <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-slate-100 text-slate-400">PAUSED</span>}
                      </div>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-400">
                        {s.next_run_at && s.enabled && (
                          <span className="flex items-center gap-1"><Clock size={10} className="text-sky-400" />Next: <strong className="text-sky-600">{new Date(s.next_run_at+'Z').toLocaleString()}</strong></span>
                        )}
                        {s.last_run_at && <span>Last ran: {new Date(s.last_run_at+'Z').toLocaleString()}</span>}
                        {(s.databases||[]).length > 0 && <span className="flex items-center gap-1"><Database size={10} />{s.databases.join(', ')}</span>}
                        {s.retain_days && <span>Retain {s.retain_days}d</span>}
                        {s.compress && <span>Compressed</span>}
                        {s.backup_path && <span className="flex items-center gap-1"><FolderOpen size={10} /><code className="font-mono text-[10px]">{s.backup_path}</code></span>}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <button onClick={() => toggle(s.id, !s.enabled)} title={s.enabled ? 'Pause' : 'Enable'}
                        className={`w-10 h-6 rounded-full transition-all flex items-center px-0.5 flex-shrink-0 ${s.enabled ? 'bg-emerald-500' : 'bg-slate-300'}`}>
                        <div className={`w-5 h-5 rounded-full bg-white shadow transition-transform ${s.enabled ? 'translate-x-4' : ''}`} />
                      </button>
                      <button onClick={() => runNow(s.id)} title="Run Now"
                        className="flex items-center gap-1.5 h-8 px-3 rounded-xl bg-sky-50 border border-sky-200 text-sky-700 text-[11px] font-bold hover:bg-sky-100 transition-all">
                        <Play size={11} /> Run Now
                      </button>
                      <button onClick={() => openEdit(s)} className="w-8 h-8 rounded-xl bg-slate-50 border border-slate-200 flex items-center justify-center text-slate-500 hover:text-blue-600 hover:bg-blue-50 hover:border-blue-200 transition-all">
                        <Pencil size={13} />
                      </button>
                      <button onClick={() => deleteSched(s.id)} className="w-8 h-8 rounded-xl bg-slate-50 border border-slate-200 flex items-center justify-center text-slate-500 hover:text-red-600 hover:bg-red-50 hover:border-red-200 transition-all">
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
