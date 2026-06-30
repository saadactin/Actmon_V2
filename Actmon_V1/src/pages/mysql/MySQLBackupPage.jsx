import React, { useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, RefreshCw, CheckCircle2, XCircle, AlertTriangle, Loader2,
  Clock, Download, RotateCcw, GitBranch, Zap, Trash2, FileArchive,
  ChevronRight, ChevronLeft, Copy, CheckCheck, Eye, Search, Play,
  Database, Activity, FolderOpen, Shield, HardDrive, Terminal,
  ChevronDown, ChevronUp, Layers, BookOpen, Radio,
  CalendarClock, Plus, Pencil, ToggleLeft, ToggleRight,
} from 'lucide-react';
import client from '../../api/client';

/* ─── API ────────────────────────────────────────────────────────────────────── */
const api = {
  summary:      id             => client.get(`/connections/mysql/${id}/backup/summary`).then(r => r.data),
  listBackups:  id             => client.get(`/connections/mysql/${id}/backups`).then(r => r.data),
  takeBackup:   (id, b)        => client.post(`/connections/mysql/${id}/backup/take`, b).then(r => r.data),
  deleteJob:    (id, jid)      => client.delete(`/connections/mysql/${id}/backup/${jid}`).then(r => r.data),
  restore:      (id, b)        => client.post(`/connections/mysql/${id}/restore`, b).then(r => r.data),
  pitr:         (id, b)        => client.post(`/connections/mysql/${id}/pitr`, b).then(r => r.data),
  pitrPreview:  (id, jid, dt)  => client.get(`/connections/mysql/${id}/pitr/preview`, { params: { base_job_id: jid, target_datetime: dt } }).then(r => r.data),
  listBinlogs:  id             => client.get(`/connections/mysql/${id}/binlogs`).then(r => r.data),
  binlogStatus: id             => client.get(`/connections/mysql/${id}/binlog/status`).then(r => r.data),
  binlogEvents: (id, log, off) => client.get(`/connections/mysql/${id}/binlogs/${log}/events`, { params: { offset: off, limit: 200 } }).then(r => r.data),
  liveEvents:    (id, lim)      => client.get(`/connections/mysql/${id}/binlog/live`, { params: { limit: lim } }).then(r => r.data),
  // Schedule
  listSchedules:  id           => client.get(`/connections/mysql/${id}/backup/schedules`).then(r => r.data),
  createSchedule: (id, s)      => client.post(`/connections/mysql/${id}/backup/schedules`, s).then(r => r.data),
  updateSchedule: (id, sid, s) => client.put(`/connections/mysql/${id}/backup/schedules/${sid}`, s).then(r => r.data),
  deleteSchedule: (id, sid)    => client.delete(`/connections/mysql/${id}/backup/schedules/${sid}`).then(r => r.data),
  toggleSchedule: (id, sid, e) => client.patch(`/connections/mysql/${id}/backup/schedules/${sid}/toggle`, { enabled: e }).then(r => r.data),
  runNow:         (id, sid)    => client.post(`/connections/mysql/${id}/backup/schedules/${sid}/run-now`).then(r => r.data),
};

/* ─── helpers ────────────────────────────────────────────────────────────────── */
const fmt   = ts => ts ? new Date(ts).toLocaleString() : '—';
const fname = p  => p  ? p.split(/[/\\]/).pop() : '—';

const TYPE_COLORS = {
  logical:  { bg: '#EFF6FF', border: '#BFDBFE', text: '#1D4ED8', dot: '#3B82F6' },
  physical: { bg: '#F5F3FF', border: '#DDD6FE', text: '#6D28D9', dot: '#8B5CF6' },
  binlog:   { bg: '#FFFBEB', border: '#FDE68A', text: '#92400E', dot: '#F59E0B' },
  pitr:     { bg: '#F0FDF4', border: '#BBF7D0', text: '#065F46', dot: '#10B981' },
  restore:  { bg: '#FFF7ED', border: '#FED7AA', text: '#9A3412', dot: '#F97316' },
};
const STATUS_MAP = {
  pending:   { cls: 'bg-slate-100 text-slate-600',     dot: 'bg-slate-400',              label: 'Pending'   },
  running:   { cls: 'bg-blue-100 text-blue-700',       dot: 'bg-blue-500 animate-pulse', label: 'Running'   },
  completed: { cls: 'bg-emerald-100 text-emerald-700', dot: 'bg-emerald-500',            label: 'Completed' },
  failed:    { cls: 'bg-red-100 text-red-700',         dot: 'bg-red-500',                label: 'Failed'    },
  cancelled: { cls: 'bg-slate-100 text-slate-400',     dot: 'bg-slate-300',              label: 'Cancelled' },
};
const EVT_COLORS = {
  Write_rows: 'bg-emerald-100 text-emerald-800', Write_rows_v1: 'bg-emerald-100 text-emerald-800',
  Update_rows: 'bg-orange-100 text-orange-800', Update_rows_v1: 'bg-orange-100 text-orange-800',
  Delete_rows: 'bg-red-100 text-red-800', Delete_rows_v1: 'bg-red-100 text-red-800',
  Query: 'bg-blue-100 text-blue-800', Gtid: 'bg-violet-100 text-violet-800',
  Anonymous_Gtid: 'bg-violet-100 text-violet-800', Xid: 'bg-teal-100 text-teal-800',
  Rotate: 'bg-slate-200 text-slate-600', Format_desc: 'bg-slate-100 text-slate-500',
};

/* ─── atoms ──────────────────────────────────────────────────────────────────── */
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
      {(type || '').toUpperCase()}
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

/* ─── TABS ────────────────────────────────────────────────────────────────────── */
const TABS = [
  { id: 'backups',  label: 'My Backups',  icon: FileArchive,  color: 'text-blue-600'   },
  { id: 'new',      label: 'New Backup',  icon: Download,     color: 'text-indigo-600' },
  { id: 'schedule', label: 'Schedule',    icon: CalendarClock,color: 'text-sky-600'    },
  { id: 'restore',  label: 'Restore',     icon: RotateCcw,    color: 'text-orange-600' },
  { id: 'pitr',     label: 'PITR',        icon: Clock,        color: 'text-teal-600'   },
  { id: 'binlogs',  label: 'Binary Logs', icon: GitBranch,    color: 'text-violet-600' },
  { id: 'live',     label: 'Live Events', icon: Zap,          color: 'text-rose-600'   },
];

/* ═══════════════════════════ ROOT PAGE ══════════════════════════════════════════
   Layout strategy:
   • AppShell <main> = overflow-y-auto  p-6 md:p-8
   • We cancel that padding with -m-6 md:-m-8 and extend height by 2× padding
   • Our outer div is overflow-hidden (no scroll)
   • Only the content zone below the header scrolls (overflow-y-auto)
   This means: header is always visible, zero background-scroll, full-screen feel
═════════════════════════════════════════════════════════════════════════════════*/
export default function MySQLBackupPage({ embedded = false }) {
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
    queryKey: ['bkpSum', id], queryFn: () => api.summary(id), refetchInterval: 12000,
  });
  const { data: bkpData, refetch: refetchBkps } = useQuery({
    queryKey: ['bkpList', id], queryFn: () => api.listBackups(id), refetchInterval: 8000,
  });

  const backups    = bkpData?.data || [];
  const stats      = sumData?.backup_stats || {};
  const storageDir = sumData?.storage_dir || '';
  const binlogOn   = !!sumData?.binlog_enabled;
  const binlogBase = sumData?.binlog_basename || '';
  const masterSt   = sumData?.master_status || {};
  const masterErr  = sumData?.master_error || null;

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['bkpSum', id] });
    qc.invalidateQueries({ queryKey: ['bkpList', id] });
  };

  const runCount = backups.filter(b => b.status === 'running').length;

  return (
    /*
      -m-6 md:-m-8 cancels AppShell's p-6 / p-8 padding so we fill edge-to-edge.
      h-[calc(100%+3rem)] md:h-[calc(100%+4rem)] restores the height lost to padding removal.
      overflow-hidden ensures THIS div never scrolls — only the inner content zone does.
    */
    <div className={embedded
      ? 'flex flex-col'
      : '-m-6 md:-m-8 h-[calc(100%+3rem)] md:h-[calc(100%+4rem)] flex flex-col overflow-hidden bg-[#f0f4ff]'}>
      <Toast t={toast} />

      {/* ══════ HEADER — never scrolls ══════ */}
      <div className={embedded
        ? 'flex-shrink-0 bg-white border border-slate-200 rounded-2xl shadow-sm mb-4'
        : 'flex-shrink-0 bg-white border-b border-slate-200 shadow-sm z-50'}>
        <div className={embedded ? 'px-5 pt-4 pb-0' : 'px-5 pt-4 pb-0'}>

          {/* top row */}
          <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
            <div className="flex items-center gap-3">
              {!embedded && (
                <button onClick={() => navigate(`/mysql-dashboard/${id}`)}
                  className="w-9 h-9 rounded-xl bg-slate-100 hover:bg-slate-200 flex items-center justify-center transition-all border border-slate-200 flex-shrink-0">
                  <ArrowLeft size={15} className="text-slate-600" />
                </button>
              )}
              <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
                style={{ background: 'linear-gradient(135deg,#1e40af,#3b82f6)' }}>
                <Database size={18} className="text-white" />
              </div>
              <div>
                <h1 className="text-[17px] font-black text-slate-900 leading-tight">{embedded ? 'Backup & Restore' : 'MySQL Backup & Restore'}</h1>
                <p className="text-[11px] text-slate-400">Connection #{id} · Advanced backup, restore &amp; PITR console</p>
              </div>
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              {sumLoading
                ? <span className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-100 text-[11px] font-bold text-slate-500">
                    <Loader2 size={11} className="animate-spin" /> Loading…
                  </span>
                : binlogOn
                  ? <span className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-700 text-[11px] font-bold">
                      <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" /> Binary Logging ON
                    </span>
                  : <span className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-red-50 border border-red-200 text-red-700 text-[11px] font-bold">
                      <span className="w-2 h-2 rounded-full bg-red-500" /> Binary Logging OFF
                    </span>
              }
              {masterSt.File && (
                <span className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-50 border border-slate-200 text-[11px] font-mono text-slate-600">
                  <GitBranch size={11} className="text-slate-400" />
                  {masterSt.File} <span className="text-slate-400 mx-1">@</span> pos {masterSt.Position}
                </span>
              )}
              {stats.last_backup && (
                <span className="hidden lg:flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-blue-50 border border-blue-100 text-[11px] text-blue-700 font-semibold">
                  <Clock size={11} /> Last: {fmt(stats.last_backup.backup_start)}
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
              const Icon = t.icon;
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

      {/* ══════ CONTENT — only this zone scrolls ══════ */}
      <div className={embedded ? '' : 'flex-1 overflow-y-auto overflow-x-hidden'}>
        <div className={embedded ? 'max-w-[1600px] mx-auto' : 'p-5 max-w-[1600px] mx-auto'}>
          {tab === 'backups'  && <BackupsTab   connId={id} backups={backups} stats={stats} storageDir={storageDir} refetch={refetchBkps} showToast={showToast} setTab={setTab} />}
          {tab === 'new'      && <NewBackupTab connId={id} storageDir={storageDir} refresh={refresh} showToast={showToast} />}
          {tab === 'schedule' && <ScheduleTab  connId={id} showToast={showToast} />}
          {tab === 'restore'  && <RestoreTab   connId={id} backups={backups} refresh={refresh} showToast={showToast} />}
          {tab === 'pitr'     && <PITRTab      connId={id} backups={backups} refresh={refresh} showToast={showToast} />}
          {tab === 'binlogs'  && <BinlogsTab   connId={id} binlogOn={binlogOn} binlogBase={binlogBase} masterSt={masterSt} masterErr={masterErr} />}
          {tab === 'live'     && <LiveTab      connId={id} binlogOn={binlogOn} binlogBase={binlogBase} />}
        </div>
      </div>
    </div>
  );
}

/* ═════════════════════════════════════════════════════════════════════════════
   MY BACKUPS
═════════════════════════════════════════════════════════════════════════════ */
function BackupsTab({ connId, backups, stats, storageDir, refetch, showToast, setTab }) {
  const qc = useQueryClient();
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [exp, setExp]       = useState(null);

  const delMut = useMutation({
    mutationFn: jid => api.deleteJob(connId, jid),
    onSuccess: () => { showToast('Backup deleted'); qc.invalidateQueries({ queryKey: ['bkpList', connId] }); },
    onError:   e  => showToast(e.message || 'Delete failed', 'error'),
  });

  const shown = backups.filter(b => {
    const matchType   = filter === 'all' || b.backup_type === filter || b.status === filter;
    const matchSearch = !search || [b.backup_type, b.db_name, b.status, b.file_path]
      .some(v => (v || '').toLowerCase().includes(search.toLowerCase()));
    return matchType && matchSearch;
  });

  return (
    <div className="space-y-4">

      {/* STAT CARDS */}
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3">
        {[
          { label: 'Total Jobs',    val: stats.total_jobs || 0,           icon: FileArchive,  g: 'from-blue-500 to-indigo-600'   },
          { label: 'Completed',     val: stats.completed_backups || 0,    icon: CheckCircle2, g: 'from-emerald-500 to-teal-600'  },
          { label: 'Running',       val: backups.filter(b => b.status === 'running').length, icon: Loader2, g: 'from-sky-400 to-blue-500' },
          { label: 'Failed',        val: backups.filter(b => b.status === 'failed').length,  icon: XCircle, g: 'from-red-500 to-rose-600'  },
          { label: 'Total Size',    val: stats.total_size_human || '0 B', icon: HardDrive,    g: 'from-orange-500 to-amber-600'  },
          { label: 'Backup Types',  val: Object.keys(stats.by_type || {}).join(', ') || '—', icon: Layers, g: 'from-violet-500 to-purple-600' },
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

      {/* STORAGE PATH */}
      {storageDir && (
        <div className="bg-white rounded-2xl border border-blue-100 shadow-sm overflow-hidden">
          <div className="h-[3px] bg-gradient-to-r from-blue-400 to-indigo-500" />
          <div className="px-5 py-3 flex items-center gap-4">
            <div className="w-9 h-9 rounded-xl bg-blue-50 border border-blue-100 flex items-center justify-center flex-shrink-0">
              <FolderOpen size={16} className="text-blue-600" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wide">Default storage path on ACTMON server</p>
              <div className="flex items-center gap-2 mt-0.5">
                <code className="text-[12px] text-slate-800 font-mono bg-slate-50 px-2.5 py-0.5 rounded-lg border border-slate-200 truncate">{storageDir}</code>
                <CopyBtn text={storageDir} />
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
          {['all', 'logical', 'physical', 'binlog', 'restore'].map(f => (
            <button key={f} onClick={() => setFilter(f)}
              className={`h-7 px-3 rounded-lg text-[11px] font-semibold transition-all ${filter === f ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500 hover:text-slate-700'}`}>
              {f[0].toUpperCase() + f.slice(1)}
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
            <p className="text-slate-500 font-semibold">No backups found</p>
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
                  {['#', 'Type', 'Database', 'Status', 'Size', 'Saved File', 'Binlog Position', 'Duration', 'Started', ''].map((h, i) => (
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
                        <td className="px-4 py-3 max-w-[180px]" onClick={e => e.stopPropagation()}>
                          {job.file_path ? (
                            <div className="flex items-center gap-1.5">
                              <span className="font-mono text-[11px] text-slate-700 truncate" title={job.file_path}>{fname(job.file_path)}</span>
                              <CopyBtn text={job.file_path} />
                            </div>
                          ) : <span className="text-slate-300 text-[11px]">—</span>}
                        </td>
                        <td className="px-4 py-3">
                          {job.binlog_file ? (
                            <div className="font-mono text-[10px]">
                              <span className="text-violet-700 font-bold">{job.binlog_file}</span><br />
                              <span className="text-slate-400">pos {job.binlog_pos}</span>
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
                          <td colSpan={10} className="px-5 py-4">
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                              <div className="bg-white rounded-xl border border-slate-200 p-4">
                                <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-3 flex items-center gap-1.5"><Database size={11} /> Job Details</p>
                                <InfoRow label="Job #" value={job.id} />
                                <InfoRow label="UUID" value={job.uuid} mono copy />
                                <InfoRow label="Type" value={job.backup_type} />
                                <InfoRow label="Database" value={job.db_name} />
                                <InfoRow label="Host:Port" value={`${job.db_host}:${job.db_port}`} mono />
                              </div>
                              <div className="bg-white rounded-xl border border-slate-200 p-4">
                                <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-3 flex items-center gap-1.5"><Clock size={11} /> Timing</p>
                                <InfoRow label="Started" value={fmt(job.backup_start)} />
                                <InfoRow label="Finished" value={fmt(job.backup_end)} />
                                <InfoRow label="Duration" value={job.duration_sec != null ? `${job.duration_sec}s` : '—'} />
                                <InfoRow label="File Size" value={job.size_human} />
                              </div>
                              <div className="bg-white rounded-xl border border-slate-200 p-4">
                                <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-3 flex items-center gap-1.5"><FolderOpen size={11} /> File Location</p>
                                <p className="text-[10px] text-slate-400 mb-2">Full path on ACTMON server:</p>
                                {job.file_path ? (
                                  <div className="flex items-start gap-2 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2">
                                    <code className="font-mono text-[10px] text-slate-700 break-all leading-relaxed flex-1">{job.file_path}</code>
                                    <CopyBtn text={job.file_path} />
                                  </div>
                                ) : <span className="text-slate-400 text-xs">No file saved yet</span>}
                                <InfoRow label="Binlog File" value={job.binlog_file} mono />
                                <InfoRow label="Binlog Pos" value={job.binlog_pos} />
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

/* ═════════════════════════════════════════════════════════════════════════════
   NEW BACKUP
═════════════════════════════════════════════════════════════════════════════ */
const BK_TYPES = {
  logical: {
    icon: BookOpen, label: 'Logical Backup', sub: 'mysqldump — SQL export',
    g: 'from-blue-500 to-indigo-600', active: 'border-blue-500 bg-blue-50/80',
    desc: 'Generates a compressed .sql.gz dump via mysqldump over SSH. Captures exact binary log position for PITR. Best for cross-version compatibility.',
    cmd: 'mysqldump --single-transaction --flush-logs --master-data=2 --routines --triggers | gzip',
    pitr: true, ext: '.sql.gz',
  },
  physical: {
    icon: HardDrive, label: 'Physical Backup', sub: 'mariabackup / xtrabackup',
    g: 'from-violet-500 to-purple-600', active: 'border-violet-500 bg-violet-50/80',
    desc: 'Copies raw InnoDB data files over SSH. Fastest for large databases. Requires mariadb-backup installed on the DB server.',
    cmd: 'mariabackup --backup --stream=xbstream | gzip',
    pitr: false, ext: '.xbstream.gz',
  },
  binlog: {
    icon: Radio, label: 'Binlog Archive', sub: 'Binary log file download',
    g: 'from-amber-500 to-orange-600', active: 'border-amber-500 bg-amber-50/80',
    desc: 'Flushes and downloads all binary log files from the DB server via SFTP. Use for extended PITR coverage beyond the base backup.',
    cmd: 'FLUSH BINARY LOGS → SFTP download → tar.gz archive',
    pitr: false, ext: '.tar.gz',
  },
};

function NewBackupTab({ connId, storageDir, refresh, showToast }) {
  const [btype, setBtype]       = useState('logical');
  const [dbName, setDbName]     = useState('');
  const [notes, setNotes]       = useState('');
  const [customPath, setCustom] = useState('');
  const [loading, setLoading]   = useState(false);
  const [result, setResult]     = useState(null);

  const bt = BK_TYPES[btype];
  const effectivePath = customPath.trim() || storageDir;

  const go = async () => {
    setLoading(true); setResult(null);
    try {
      const res = await api.takeBackup(connId, {
        backup_type: btype,
        databases:   dbName.trim() ? [dbName.trim()] : null,
        compress:    true,
        notes:       notes.trim() || null,
        custom_storage_path: customPath.trim() || null,
      });
      setResult({ ok: true, msg: res.message, jobId: res.job?.id });
      refresh();
    } catch (e) {
      setResult({ ok: false, msg: e.message || 'Failed to start backup' });
    } finally { setLoading(false); }
  };

  return (
    <div className="max-w-3xl space-y-4">

      {/* Step 1 */}
      <SectionCard title="Step 1 — Choose Backup Type" subtitle="Select the method that suits your database size and recovery needs" icon={Layers} iconColor="text-indigo-600">
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
                  <div className="mt-2 bg-slate-900 rounded-lg px-3 py-1.5 inline-flex items-center gap-2">
                    <Terminal size={10} className="text-slate-400 flex-shrink-0" />
                    <code className="text-[10px] text-green-400 font-mono">{v.cmd}</code>
                  </div>
                </div>
              </label>
            );
          })}
        </div>
      </SectionCard>

      {/* Step 2 */}
      <SectionCard title="Step 2 — Target Database" subtitle="Leave empty to back up ALL databases on the server" icon={Database} iconColor="text-blue-600">
        <input value={dbName} onChange={e => setDbName(e.target.value)}
          placeholder="e.g.  myapp_production    (leave empty = ALL databases)"
          className="w-full h-11 rounded-xl border-2 border-slate-200 px-4 text-[13px] outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 transition-all bg-white" />
        <p className="mt-2 text-[11px] text-slate-400">
          {dbName.trim() ? `Will back up: "${dbName.trim()}"` : 'Will back up ALL databases (--all-databases)'}
        </p>
      </SectionCard>

      {/* Step 3 — Save Location (custom path) */}
      <SectionCard title="Step 3 — Save Location" subtitle="Backup file saved on this ACTMON server. Enter any custom path or leave blank for default." icon={FolderOpen} iconColor="text-orange-600">
        <div className="relative mb-3">
          <FolderOpen size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input value={customPath} onChange={e => setCustom(e.target.value)}
            placeholder="Leave blank = default, or enter any path like  /mnt/backups/mysql  or  D:\Backups\MySQL"
            className="w-full h-11 pl-10 pr-4 rounded-xl border-2 border-slate-200 text-[12px] font-mono outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100 transition-all bg-white" />
        </div>
        <div className="flex items-start gap-3 bg-slate-50 border border-slate-200 rounded-xl px-4 py-3">
          <FolderOpen size={14} className="text-slate-400 flex-shrink-0 mt-0.5" />
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wide">
              {customPath.trim() ? '📂 Custom — backup will be saved to:' : '📂 Default — backup will be saved to:'}
            </p>
            <div className="flex items-center gap-2 mt-1">
              <code className="text-[12px] text-slate-800 font-mono truncate">{effectivePath || '(loading…)'}</code>
              {effectivePath && <CopyBtn text={effectivePath} />}
            </div>
            <p className="text-[10px] text-slate-400 mt-1">
              Filename: <code className="font-mono">[uuid]_{btype}_{'{timestamp}'}{bt.ext}</code>
            </p>
          </div>
        </div>
      </SectionCard>

      {/* Step 4 */}
      <SectionCard title="Step 4 — Notes (Optional)" subtitle="Tag this backup for easy identification later" icon={BookOpen} iconColor="text-slate-400">
        <input value={notes} onChange={e => setNotes(e.target.value)}
          placeholder="e.g.  Pre-deployment snapshot,  Weekly backup,  Before migration…"
          className="w-full h-11 rounded-xl border-2 border-slate-200 px-4 text-[13px] outline-none focus:border-slate-400 transition-all bg-white" />
      </SectionCard>

      <ResultAlert r={result} />

      <div className="flex items-center gap-3">
        <button onClick={go} disabled={loading}
          className={`flex items-center gap-2 h-12 px-8 rounded-xl font-black text-[14px] text-white shadow-lg disabled:opacity-60 transition-all bg-gradient-to-r ${bt.g} hover:shadow-xl hover:-translate-y-0.5 disabled:hover:translate-y-0`}>
          {loading ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
          {loading ? 'Starting backup…' : `Start ${bt.label}`}
        </button>
        <p className="text-[11px] text-slate-400">Runs over SSH — you can leave this page</p>
      </div>
    </div>
  );
}

/* ═════════════════════════════════════════════════════════════════════════════
   RESTORE
═════════════════════════════════════════════════════════════════════════════ */
function RestoreTab({ connId, backups, refresh, showToast }) {
  const logicalOk = backups.filter(b => b.backup_type === 'logical' && b.status === 'completed');
  const [jobId, setJobId]     = useState('');
  const [target, setTarget]   = useState('');
  const [confirm, setConfirm] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult]   = useState(null);

  const go = async () => {
    if (!jobId) return showToast('Select a backup first', 'error');
    setLoading(true); setResult(null);
    try {
      const res = await api.restore(connId, { job_id: Number(jobId), target_db: target || null, confirm: true });
      setResult({ ok: true, msg: res.message, jobId: res.job?.id });
      refresh();
    } catch (e) {
      setResult({ ok: false, msg: e.message });
    } finally { setLoading(false); }
  };

  return (
    <div className="max-w-2xl space-y-4">
      <DangerBox title="⚠ Destructive — Read Before Proceeding"
        msg="This will OVERWRITE your target database with the selected backup. All changes after the backup timestamp will be permanently erased. Use PITR instead if you need minimal data loss." />

      <SectionCard title="Select Backup to Restore" subtitle="Only completed logical backups can be directly restored" icon={FileArchive} iconColor="text-orange-600">
        {logicalOk.length === 0 ? (
          <div className="py-10 text-center">
            <FileArchive size={32} className="mx-auto mb-3 text-slate-200" />
            <p className="text-slate-500 font-semibold">No completed logical backups</p>
            <p className="text-slate-400 text-sm mt-1">Take a logical backup first.</p>
          </div>
        ) : (
          <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
            {logicalOk.map(b => (
              <label key={b.id}
                className={`flex gap-4 p-3.5 rounded-xl border-2 cursor-pointer transition-all ${Number(jobId) === b.id ? 'border-orange-400 bg-orange-50' : 'border-slate-200 bg-white hover:border-slate-300'}`}>
                <input type="radio" name="rjob" value={b.id} checked={Number(jobId) === b.id} onChange={e => setJobId(e.target.value)} className="mt-0.5 flex-shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-black text-slate-900">#{b.id}</span>
                    {b.db_name && <span className="font-mono text-xs bg-slate-100 text-slate-700 px-2 py-0.5 rounded-lg">{b.db_name}</span>}
                    <span className="text-[11px] text-slate-400">{b.size_human}</span>
                  </div>
                  <p className="text-[11px] text-slate-400 mt-0.5">{fmt(b.backup_start)}</p>
                  {b.binlog_file && <p className="text-[11px] font-mono text-violet-700 mt-1">📍 {b.binlog_file} @ pos {b.binlog_pos}</p>}
                  <p className="text-[10px] font-mono text-slate-400 mt-0.5 truncate">{b.file_path}</p>
                </div>
              </label>
            ))}
          </div>
        )}
      </SectionCard>

      <SectionCard title="Target Database (Optional)" subtitle="Specify to restore into a single database only" icon={Database} iconColor="text-blue-600">
        <input value={target} onChange={e => setTarget(e.target.value)} placeholder="Leave empty = restore as originally dumped"
          className="w-full h-11 rounded-xl border-2 border-slate-200 px-4 text-[13px] outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100 transition-all bg-white" />
      </SectionCard>

      <label className="flex items-start gap-3 p-4 bg-red-50 border-2 border-red-200 rounded-2xl cursor-pointer hover:bg-red-100/60 transition-all">
        <div className={`w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 mt-0.5 transition-all ${confirm ? 'bg-red-600 border-red-600' : 'border-slate-400 bg-white'}`}>
          {confirm && <CheckCheck size={11} className="text-white" />}
        </div>
        <input type="checkbox" checked={confirm} onChange={e => setConfirm(e.target.checked)} className="sr-only" />
        <span className="text-[13px] text-red-700">I understand this will <strong>permanently overwrite existing data</strong> and cannot be undone.</span>
      </label>

      <ResultAlert r={result} />

      <button onClick={go} disabled={loading || !confirm || !jobId}
        className="flex items-center gap-2 h-12 px-8 rounded-xl font-black text-[14px] text-white shadow-lg disabled:opacity-50 transition-all bg-gradient-to-r from-orange-600 to-red-600 hover:shadow-xl hover:-translate-y-0.5 disabled:hover:translate-y-0">
        {loading ? <Loader2 size={16} className="animate-spin" /> : <RotateCcw size={16} />}
        {loading ? 'Restoring…' : 'Start Restore'}
      </button>
    </div>
  );
}

/* ═════════════════════════════════════════════════════════════════════════════
   PITR
═════════════════════════════════════════════════════════════════════════════ */
function PITRTab({ connId, backups, refresh, showToast }) {
  const pitrBkps = backups.filter(b => b.backup_type === 'logical' && b.status === 'completed' && b.binlog_file);
  const [baseId, setBaseId]   = useState('');
  const [dt, setDt]           = useState('');
  const [targetDb, setTDb]    = useState('');
  const [confirm, setConfirm] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult]   = useState(null);
  const [preview, setPreview] = useState(null);
  const [prevLoad, setPL]     = useState(false);

  const dtFmt = dt.replace('T', ' ');

  const doPreview = async () => {
    if (!baseId || !dt) return;
    setPL(true);
    try { setPreview(await api.pitrPreview(connId, Number(baseId), dtFmt)); }
    catch (e) { setPreview({ status: 'error', error: e.message }); }
    finally { setPL(false); }
  };

  const go = async () => {
    if (!baseId || !dt) return showToast('Select a backup and target time', 'error');
    setLoading(true); setResult(null);
    try {
      const res = await api.pitr(connId, { base_job_id: Number(baseId), target_datetime: dtFmt, target_db: targetDb || null, confirm: true });
      setResult({ ok: true, msg: res.message, jobId: res.job?.id });
      refresh();
    } catch (e) {
      setResult({ ok: false, msg: e.message });
    } finally { setLoading(false); }
  };

  return (
    <div className="max-w-2xl space-y-4">

      {/* explainer */}
      <div className="bg-white rounded-2xl border border-teal-200 shadow-sm overflow-hidden">
        <div className="h-[3px] bg-gradient-to-r from-teal-400 to-emerald-500" />
        <div className="px-5 py-4">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-teal-500 to-emerald-600 flex items-center justify-center flex-shrink-0">
              <Clock size={17} className="text-white" />
            </div>
            <div>
              <h3 className="font-black text-slate-900 text-[14px]">Point-in-Time Recovery (PITR)</h3>
              <p className="text-[11px] text-slate-400">Recover your database to any exact second in history</p>
            </div>
          </div>
          <div className="space-y-3 pl-2">
            {[
              { n: 1, t: 'Choose a logical backup', d: 'Select any backup taken before the incident (e.g. 11:00 AM snapshot)' },
              { n: 2, t: 'Set target recovery time', d: 'Enter 1 second before the crash — e.g. crash at 11:15:00, set 11:14:59' },
              { n: 3, t: 'ACTMON restores + replays', d: 'Restores the base dump via SSH, then replays binary logs to your exact timestamp' },
              { n: 4, t: 'Database recovered',       d: 'Your database is back at that precise moment with minimal data loss' },
            ].map(s => (
              <div key={s.n} className="flex gap-3 items-start">
                <div className="w-6 h-6 rounded-full bg-gradient-to-br from-teal-500 to-emerald-600 flex items-center justify-center flex-shrink-0 text-[11px] font-black text-white shadow-sm mt-0.5">{s.n}</div>
                <div>
                  <p className="font-bold text-slate-800 text-[13px]">{s.t}</p>
                  <p className="text-[11px] text-slate-500">{s.d}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <DangerBox title="Destructive — Overwrites Current Database"
        msg="Step 1 restores the base dump (current data is erased). Step 2 replays binary logs to your target time. Irreversible — confirm the timestamp carefully." />

      <SectionCard title="Step 1 — Select Base Backup" subtitle="Must be a logical backup with a captured binlog position" icon={FileArchive} iconColor="text-teal-600">
        {pitrBkps.length === 0 ? (
          <div className="py-8 text-center">
            <Shield size={28} className="mx-auto mb-3 text-slate-200" />
            <p className="text-slate-500 font-semibold">No eligible backups</p>
            <p className="text-slate-400 text-sm mt-1">Take a logical backup first — it captures the binlog position via <code className="font-mono text-xs">--master-data=2</code>.</p>
          </div>
        ) : (
          <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
            {pitrBkps.map(b => (
              <label key={b.id}
                className={`flex gap-4 p-3.5 rounded-xl border-2 cursor-pointer transition-all ${Number(baseId) === b.id ? 'border-teal-400 bg-teal-50' : 'border-slate-200 bg-white hover:border-slate-300'}`}>
                <input type="radio" name="pitrb" value={b.id} checked={Number(baseId) === b.id}
                  onChange={e => { setBaseId(e.target.value); setPreview(null); }} className="mt-0.5 flex-shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-black text-slate-900">#{b.id}</span>
                    {b.db_name && <span className="font-mono text-xs bg-slate-100 text-slate-700 px-2 py-0.5 rounded-lg">{b.db_name}</span>}
                    <span className="text-[11px] text-slate-400">{b.size_human}</span>
                  </div>
                  <p className="text-[11px] text-slate-400 mt-0.5">{fmt(b.backup_start)}</p>
                  <div className="mt-1 inline-flex items-center gap-2 text-[11px] font-mono font-bold text-teal-700 bg-teal-50 border border-teal-200 rounded-lg px-2.5 py-1">
                    📍 {b.binlog_file} @ pos {b.binlog_pos}
                  </div>
                </div>
              </label>
            ))}
          </div>
        )}
      </SectionCard>

      <SectionCard title="Step 2 — Target Recovery Time" subtitle="Set to 1 second BEFORE the incident to exclude the crash event" icon={Clock} iconColor="text-teal-600">
        <input type="datetime-local" step="1" value={dt.replace(' ', 'T')}
          onChange={e => { setDt(e.target.value.replace('T', ' ')); setPreview(null); }}
          className="w-full h-11 rounded-xl border-2 border-slate-200 px-4 text-[13px] outline-none focus:border-teal-400 focus:ring-2 focus:ring-teal-100 transition-all bg-white" />
        {dt ? (
          <div className="mt-3 flex items-center gap-2 bg-teal-50 border border-teal-200 rounded-xl px-4 py-2.5">
            <CheckCircle2 size={14} className="text-teal-600 flex-shrink-0" />
            <p className="text-[12px] font-bold text-teal-700">Will recover to: <code className="font-mono text-[13px]">{dtFmt}</code></p>
          </div>
        ) : (
          <p className="mt-2 text-[12px] text-slate-400">
            Example: crash at <code className="font-mono text-xs bg-slate-100 px-1 rounded">11:15:00</code> → enter <code className="font-mono text-xs bg-teal-100 text-teal-700 px-1 rounded">11:14:59</code>
          </p>
        )}
      </SectionCard>

      <SectionCard title="Step 3 — Target Database (Optional)" subtitle="Leave empty to recover all databases" icon={Database} iconColor="text-blue-600">
        <input value={targetDb} onChange={e => setTDb(e.target.value)} placeholder="Leave empty = recover all databases"
          className="w-full h-11 rounded-xl border-2 border-slate-200 px-4 text-[13px] outline-none focus:border-teal-400 transition-all bg-white" />
      </SectionCard>

      <button onClick={doPreview} disabled={!baseId || !dt || prevLoad}
        className="flex items-center gap-2 h-10 px-5 rounded-xl border-2 border-teal-300 text-teal-700 text-[13px] font-bold bg-white hover:bg-teal-50 disabled:opacity-40 transition-all">
        {prevLoad ? <Loader2 size={14} className="animate-spin" /> : <Eye size={14} />}
        Preview Binlog Files to Apply (Safe — no changes made)
      </button>

      {preview && (
        <div className={`rounded-2xl border p-4 ${preview.status === 'error' ? 'bg-red-50 border-red-200' : 'bg-white border-slate-200'}`}>
          {preview.status === 'error' ? (
            <p className="text-red-700 text-sm">{preview.error}</p>
          ) : (
            <>
              <p className="font-bold text-slate-700 mb-3 flex items-center gap-2">
                <CheckCircle2 size={15} className="text-teal-600" />
                {preview.log_count} binlog file{preview.log_count !== 1 ? 's' : ''} will be replayed after restoring backup #{baseId}
              </p>
              <div className="space-y-2">
                {(preview.logs_to_apply || []).map((l, i) => (
                  <div key={i} className="flex items-center justify-between bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <span className="w-5 h-5 rounded-full bg-teal-100 text-teal-700 text-[10px] font-black flex items-center justify-center">{i + 1}</span>
                      <span className="font-mono font-bold text-slate-700 text-[12px]">{l.log_name}</span>
                    </div>
                    <span className="text-[11px] text-slate-400">{l.size_human}</span>
                  </div>
                ))}
              </div>
              {preview.warning && <p className="mt-3 text-[12px] text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">{preview.warning}</p>}
            </>
          )}
        </div>
      )}

      <label className="flex items-start gap-3 p-4 bg-red-50 border-2 border-red-200 rounded-2xl cursor-pointer hover:bg-red-100/60 transition-all">
        <div className={`w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 mt-0.5 transition-all ${confirm ? 'bg-red-600 border-red-600' : 'border-slate-400 bg-white'}`}>
          {confirm && <CheckCheck size={11} className="text-white" />}
        </div>
        <input type="checkbox" checked={confirm} onChange={e => setConfirm(e.target.checked)} className="sr-only" />
        <span className="text-[13px] text-red-700">
          I confirm: restore backup #{baseId || '?'} then replay binlogs to <strong>{dtFmt || '(no time set)'}</strong>. Current data will be overwritten.
        </span>
      </label>

      <ResultAlert r={result} />

      <button onClick={go} disabled={loading || !confirm || !baseId || !dt}
        className="flex items-center gap-2 h-12 px-8 rounded-xl font-black text-[14px] text-white shadow-lg disabled:opacity-50 transition-all bg-gradient-to-r from-teal-600 to-emerald-600 hover:shadow-xl hover:-translate-y-0.5 disabled:hover:translate-y-0">
        {loading ? <Loader2 size={16} className="animate-spin" /> : <Clock size={16} />}
        {loading ? 'Running PITR…' : 'Start Point-in-Time Recovery'}
      </button>
    </div>
  );
}

/* ═════════════════════════════════════════════════════════════════════════════
   BINARY LOG FILES
═════════════════════════════════════════════════════════════════════════════ */
function BinlogsTab({ connId, binlogOn, binlogBase, masterSt, masterErr }) {
  const [sel, setSel]    = useState(null);
  const [offset, setOff] = useState(0);
  const [filt, setFilt]  = useState('');
  const PAGE = 200;

  const { data: logsData, isLoading: logsLoading, refetch: refetchLogs } = useQuery({
    queryKey: ['binlogList', connId], queryFn: () => api.listBinlogs(connId), refetchInterval: 20000,
  });
  const { data: evData, isLoading: evLoad } = useQuery({
    queryKey: ['binlogEvts', connId, sel, offset],
    queryFn:  () => api.binlogEvents(connId, sel, offset),
    enabled:  !!sel,
  });
  const { data: stData } = useQuery({
    queryKey: ['binlogSt', connId], queryFn: () => api.binlogStatus(connId), refetchInterval: 15000,
  });

  const logs    = logsData?.data || [];
  const logErr  = (logsData?.status === 'error' || logsData?.status === 'disabled') ? logsData.error : null;
  const logBase = logsData?.binlog_basename || binlogBase || '';
  const vars    = stData?.variables || {};
  const curFile = masterSt.File || stData?.master_status?.File || '';
  const curPos  = masterSt.Position || stData?.master_status?.Position || '';
  const evts    = (evData?.data || []).filter(e => !filt ||
    (e.event_type || '').toLowerCase().includes(filt.toLowerCase()) ||
    (e.info || '').toLowerCase().includes(filt.toLowerCase()));

  return (
    <div className="space-y-4">

      {/* var cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { k: 'log_bin',          v: vars.log_bin || '—',          g: vars.log_bin === 'ON' ? 'from-emerald-500 to-teal-600' : 'from-red-500 to-rose-600' },
          { k: 'binlog_format',    v: vars.binlog_format || '—',    g: 'from-indigo-500 to-violet-600' },
          { k: 'binlog_row_image', v: vars.binlog_row_image || '—', g: 'from-orange-500 to-amber-600'  },
          { k: 'max_binlog_size',  v: vars.max_binlog_size || '—',  g: 'from-blue-500 to-cyan-600'     },
        ].map(({ k, v, g }) => (
          <div key={k} className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
            <div className={`h-[3px] bg-gradient-to-r ${g}`} />
            <div className="px-4 py-3">
              <code className="text-[10px] font-mono text-slate-400">{k}</code>
              <p className="font-black text-slate-900 text-[15px] mt-1">{v}</p>
            </div>
          </div>
        ))}
      </div>

      {/* active position */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm px-5 py-4 flex flex-wrap items-center gap-6">
        {curFile ? (
          <>
            <div>
              <p className="text-[9px] font-black uppercase tracking-widest text-slate-400 mb-1">Active Log File</p>
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                <code className="font-mono font-black text-slate-900 text-[14px]">{curFile}</code>
              </div>
            </div>
            <div>
              <p className="text-[9px] font-black uppercase tracking-widest text-slate-400 mb-1">Current Write Position</p>
              <code className="font-mono font-black text-violet-700 text-[14px]">{curPos?.toLocaleString()}</code>
            </div>
          </>
        ) : binlogOn && masterErr ? (
          <div className="flex items-center gap-3 text-[12px] text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-4 py-2.5">
            <AlertTriangle size={14} />
            <span>SHOW MASTER STATUS needs <strong>REPLICATION CLIENT</strong> privilege.
              Grant: <code className="font-mono bg-amber-100 px-1 rounded text-[11px]">GRANT REPLICATION CLIENT ON *.* TO 'user'@'%';</code>
            </span>
          </div>
        ) : null}
        {logBase && (
          <div className="ml-auto">
            <p className="text-[9px] font-black uppercase tracking-widest text-slate-400 mb-1">Binlog Files on DB Server</p>
            <div className="flex items-center gap-2">
              <code className="font-mono text-[12px] text-slate-700 bg-slate-50 border border-slate-200 px-2.5 py-1 rounded-lg">{logBase}.*</code>
              <CopyBtn text={logBase} />
            </div>
          </div>
        )}
      </div>

      {!binlogOn && (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-5 flex gap-4">
          <div className="w-10 h-10 rounded-xl bg-amber-100 border border-amber-200 flex items-center justify-center flex-shrink-0">
            <AlertTriangle size={18} className="text-amber-600" />
          </div>
          <div>
            <p className="font-bold text-amber-800 text-[14px] mb-2">Binary Logging is Disabled</p>
            <div className="bg-amber-900/10 rounded-xl p-4 font-mono text-[11px] text-amber-900 space-y-0.5 border border-amber-200">
              <p><span className="text-amber-600"># /etc/mysql/mariadb.conf.d/50-server.cnf</span></p>
              <p>server_id = 1</p>
              <p>log_bin = mysql-bin</p>
              <p>binlog_format = ROW</p>
              <p>expire_logs_days = 7</p>
              <p>max_binlog_size = 100M</p>
            </div>
            <p className="text-[12px] text-amber-700 mt-2">Then restart: <code className="bg-amber-200 px-2 py-0.5 rounded font-mono">sudo systemctl restart mariadb</code></p>
          </div>
        </div>
      )}

      {binlogOn && logErr && (
        <div className="bg-red-50 border border-red-200 rounded-2xl p-4 flex gap-3">
          <XCircle size={18} className="text-red-500 flex-shrink-0 mt-0.5" />
          <div>
            <p className="font-bold text-red-800">Cannot list binary log files</p>
            <pre className="text-[11px] text-red-700 font-mono whitespace-pre-wrap mt-1">{logErr}</pre>
          </div>
        </div>
      )}

      {binlogOn && !logErr && (
        <div className="flex gap-4 items-start">
          {/* file list */}
          <div className="w-56 flex-shrink-0 bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-100 bg-slate-50/60 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <GitBranch size={13} className="text-slate-400" />
                <span className="font-bold text-slate-700 text-[13px]">Log Files</span>
                {logs.length > 0 && <span className="text-[10px] font-black bg-slate-200 text-slate-600 px-1.5 py-0.5 rounded-full">{logs.length}</span>}
              </div>
              <button onClick={refetchLogs} className="w-6 h-6 rounded-lg hover:bg-slate-200 flex items-center justify-center text-slate-400 transition-all">
                <RefreshCw size={11} />
              </button>
            </div>
            <div className="overflow-y-auto max-h-[500px]">
              {logsLoading ? (
                <p className="py-10 text-center text-slate-400 text-xs"><Loader2 size={16} className="animate-spin mx-auto mb-2" /></p>
              ) : logs.length === 0 ? (
                <p className="py-10 text-center text-slate-400 text-xs">No log files</p>
              ) : logs.map((l, i) => (
                <button key={i} onClick={() => { setSel(l.log_name); setOff(0); }}
                  className={`w-full flex items-center justify-between px-4 py-3 border-b border-slate-50 last:border-0 text-left transition-all ${sel === l.log_name ? 'bg-violet-50 border-l-2 border-l-violet-500' : 'hover:bg-slate-50'}`}>
                  <div>
                    <p className={`font-mono text-[11px] font-bold ${sel === l.log_name ? 'text-violet-700' : 'text-slate-700'}`}>{l.log_name}</p>
                    <p className="text-[10px] text-slate-400">{l.size_human}</p>
                  </div>
                  {curFile === l.log_name && <span className="text-[9px] font-black bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded-full border border-emerald-200 flex-shrink-0">LIVE</span>}
                </button>
              ))}
            </div>
          </div>

          {/* event viewer */}
          <div className="flex-1 min-w-0 bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
            {!sel ? (
              <div className="py-24 text-center">
                <div className="w-14 h-14 rounded-2xl bg-slate-100 flex items-center justify-center mx-auto mb-4">
                  <GitBranch size={24} className="text-slate-300" />
                </div>
                <p className="font-semibold text-slate-500">Select a log file</p>
                <p className="text-[12px] text-slate-400 mt-1">Click any file from the left panel to read its events</p>
              </div>
            ) : (
              <>
                <div className="px-4 py-3 border-b border-slate-100 bg-slate-50/60 flex items-center gap-3 flex-wrap">
                  <GitBranch size={13} className="text-violet-500 flex-shrink-0" />
                  <code className="font-mono font-bold text-slate-800 text-[13px]">{sel}</code>
                  <div className="relative ml-auto">
                    <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
                    <input value={filt} onChange={e => setFilt(e.target.value)} placeholder="Filter events…"
                      className="h-7 pl-7 pr-3 rounded-lg border border-slate-200 text-[12px] outline-none focus:border-violet-400 w-40 bg-white" />
                  </div>
                  <div className="flex gap-1">
                    <button disabled={offset === 0} onClick={() => setOff(Math.max(0, offset - PAGE))}
                      className="h-7 px-2 rounded-lg border border-slate-200 text-[11px] hover:bg-slate-100 disabled:opacity-40 flex items-center gap-1 bg-white">
                      <ChevronLeft size={11} /> Prev
                    </button>
                    <button onClick={() => setOff(offset + PAGE)}
                      className="h-7 px-2 rounded-lg border border-slate-200 text-[11px] hover:bg-slate-100 flex items-center gap-1 bg-white">
                      Next <ChevronRight size={11} />
                    </button>
                  </div>
                </div>
                <div className="overflow-auto max-h-[460px]">
                  {evLoad ? <p className="py-14 text-center"><Loader2 size={24} className="animate-spin mx-auto text-slate-400" /></p>
                    : <EventTable evts={evts} />}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ═════════════════════════════════════════════════════════════════════════════
   LIVE EVENTS
═════════════════════════════════════════════════════════════════════════════ */
function LiveTab({ connId, binlogOn, binlogBase }) {
  const [limit, setLimit] = useState(200);
  const [auto, setAuto]   = useState(true);
  const [filt, setFilt]   = useState('');
  const [typeF, setTypeF] = useState('all');

  const { data, isLoading, error, dataUpdatedAt, refetch } = useQuery({
    queryKey: ['binlogLive', connId, limit],
    queryFn:  () => api.liveEvents(connId, limit),
    refetchInterval: auto ? 3000 : false,
  });

  const raw     = data?.data || [];
  const liveErr = error?.message || (data?.status === 'error' ? data.error : null);
  const writes  = raw.filter(e => e.is_write).length;
  const queries = raw.filter(e => e.event_type === 'Query').length;
  const xids    = raw.filter(e => e.event_type === 'Xid').length;

  const shown = raw.filter(e => {
    if (typeF === 'dml'   && !e.is_write)              return false;
    if (typeF === 'query' && e.event_type !== 'Query') return false;
    if (typeF === 'gtid'  && !e.is_gtid)               return false;
    if (filt) {
      const s = filt.toLowerCase();
      return (e.event_type || '').toLowerCase().includes(s) || (e.info || '').toLowerCase().includes(s);
    }
    return true;
  });

  if (!binlogOn) return (
    <div className="max-w-xl">
      <div className="bg-amber-50 border-2 border-amber-200 rounded-2xl p-6 flex gap-4">
        <div className="w-12 h-12 rounded-2xl bg-amber-100 border border-amber-200 flex items-center justify-center flex-shrink-0">
          <AlertTriangle size={22} className="text-amber-600" />
        </div>
        <div>
          <p className="font-black text-amber-800 text-base">Binary Logging is Disabled</p>
          <p className="text-[13px] text-amber-700 mt-1">Live event monitoring requires binary logging. See the <strong>Binary Logs</strong> tab for setup.</p>
        </div>
      </div>
    </div>
  );

  return (
    <div className="space-y-4">

      {/* KPI */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {[
          { label: 'Active Log',    val: data?.current_log || '—',                 g: 'from-indigo-500 to-violet-600', icon: GitBranch },
          { label: 'Write Pos',     val: data?.current_pos?.toLocaleString()||'—', g: 'from-emerald-500 to-teal-600',  icon: Activity  },
          { label: 'DML Events',    val: writes,                                   g: 'from-green-500 to-emerald-600', icon: Database  },
          { label: 'Query Events',  val: queries,                                  g: 'from-blue-500 to-indigo-600',   icon: Terminal  },
          { label: 'Transactions',  val: xids,                                     g: 'from-violet-500 to-purple-600', icon: Layers    },
        ].map(({ label, val, g, icon: Icon }) => (
          <div key={label} className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
            <div className={`h-[3px] bg-gradient-to-r ${g}`} />
            <div className="px-4 py-3 flex items-center gap-3">
              <div className={`w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0 bg-gradient-to-br ${g}`}>
                <Icon size={14} className="text-white" />
              </div>
              <div className="min-w-0">
                <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">{label}</p>
                <p className="font-mono font-black text-slate-900 text-[13px] truncate">{val}</p>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* binlog path */}
      {(binlogBase || data?.current_log) && (
        <div className="bg-white rounded-xl border border-slate-200 px-4 py-2.5 flex items-center gap-3 shadow-sm">
          <FolderOpen size={13} className="text-slate-400 flex-shrink-0" />
          <span className="text-[11px] text-slate-400">Binlog on DB server:</span>
          <code className="font-mono text-[12px] text-slate-700 bg-slate-50 px-2 py-0.5 rounded-lg border border-slate-200">
            {binlogBase ? `${binlogBase}/` : ''}{data?.current_log || ''}
          </code>
        </div>
      )}

      {/* controls */}
      <div className="flex items-center gap-2 flex-wrap bg-white rounded-2xl border border-slate-200 shadow-sm px-4 py-3">
        <div className="relative">
          <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input value={filt} onChange={e => setFilt(e.target.value)} placeholder="Filter events…"
            className="h-8 pl-7 pr-3 rounded-xl border border-slate-200 text-[12px] outline-none focus:border-blue-400 w-48 bg-slate-50" />
        </div>
        <div className="flex items-center gap-0.5 bg-slate-100 rounded-xl p-1">
          {[{ id: 'all', l: 'All' }, { id: 'dml', l: 'DML' }, { id: 'query', l: 'Query' }, { id: 'gtid', l: 'GTID' }].map(f => (
            <button key={f.id} onClick={() => setTypeF(f.id)}
              className={`h-6 px-3 rounded-lg text-[11px] font-semibold transition-all ${typeF === f.id ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500 hover:text-slate-700'}`}>
              {f.l}
            </button>
          ))}
        </div>
        <select value={limit} onChange={e => setLimit(Number(e.target.value))}
          className="h-8 px-2 rounded-xl border border-slate-200 text-[12px] bg-white outline-none">
          <option value={100}>Last 100</option>
          <option value={200}>Last 200</option>
          <option value={500}>Last 500</option>
        </select>

        {/* toggle switch */}
        <label className="flex items-center gap-2 cursor-pointer ml-auto">
          <button onClick={() => setAuto(a => !a)}
            className={`w-10 h-5 rounded-full transition-all flex items-center px-0.5 flex-shrink-0 ${auto ? 'bg-emerald-500' : 'bg-slate-300'}`}>
            <div className={`w-4 h-4 rounded-full bg-white shadow transition-transform ${auto ? 'translate-x-5' : ''}`} />
          </button>
          <span className="text-[12px] font-semibold text-slate-600">Auto (3s)</span>
        </label>

        <button onClick={refetch}
          className="h-8 px-3 rounded-xl border border-slate-200 bg-white text-[12px] flex items-center gap-1.5 hover:bg-slate-50 text-slate-600 transition-all">
          <RefreshCw size={12} className={isLoading ? 'animate-spin' : ''} />
        </button>

        <div className="flex items-center gap-2 text-[11px]">
          {auto && <span className="flex items-center gap-1.5 font-bold text-emerald-600"><span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" /> LIVE</span>}
          <span className="text-slate-400">{shown.length} events</span>
          {dataUpdatedAt && <span className="text-slate-300">· {new Date(dataUpdatedAt).toLocaleTimeString()}</span>}
        </div>
      </div>

      {liveErr && (
        <div className="bg-red-50 border border-red-200 rounded-2xl p-4 flex gap-3">
          <XCircle size={16} className="text-red-500 flex-shrink-0" />
          <p className="text-[12px] text-red-700">{liveErr}</p>
        </div>
      )}

      {!liveErr && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="overflow-auto max-h-[520px]">
            {isLoading && !shown.length
              ? <p className="py-16 text-center"><Loader2 size={24} className="animate-spin mx-auto text-slate-400" /></p>
              : <EventTable evts={shown} showLog />}
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Event table ─────────────────────────────────────────────────────────── */
function EventTable({ evts, showLog = false }) {
  if (!evts.length) return (
    <div className="py-14 text-center">
      <Activity size={28} className="mx-auto mb-3 text-slate-200" />
      <p className="text-slate-400 font-semibold">No events to display</p>
    </div>
  );
  return (
    <table className="w-full text-[12px]">
      <thead className="sticky top-0 z-10 bg-slate-50 border-b border-slate-200">
        <tr>
          {showLog && <th className="px-3 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase tracking-wide">Log</th>}
          <th className="px-3 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase tracking-wide">Pos</th>
          <th className="px-3 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase tracking-wide">End Pos</th>
          <th className="px-3 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase tracking-wide">Event Type</th>
          <th className="px-3 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase tracking-wide">Server</th>
          <th className="px-3 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase tracking-wide">Info / SQL</th>
        </tr>
      </thead>
      <tbody>
        {evts.map((e, i) => (
          <tr key={i} className={`border-t border-slate-50 hover:bg-blue-50/20 transition-colors ${e.is_write ? 'bg-emerald-50/30' : ''}`}>
            {showLog && <td className="px-3 py-2 font-mono text-[10px] text-slate-500">{e.log_name}</td>}
            <td className="px-3 py-2 font-mono text-slate-700 font-bold">{e.pos}</td>
            <td className="px-3 py-2 font-mono text-slate-400">{e.end_log_pos}</td>
            <td className="px-3 py-2">
              <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${EVT_COLORS[e.event_type] || 'bg-slate-100 text-slate-600'}`}>
                {e.event_type}
              </span>
            </td>
            <td className="px-3 py-2 font-mono text-slate-400 text-[11px]">{e.server_id}</td>
            <td className="px-3 py-2 text-slate-600 font-mono max-w-sm truncate" title={e.info}>{e.info}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* ═════════════════════════════════════════════════════════════════════════════
   BACKUP SCHEDULE TAB
═════════════════════════════════════════════════════════════════════════════ */
const SCHED_TYPES = [
  { id: 'every_x_minutes', label: 'Every X Min',  icon: '⚡', desc: 'Repeat every N minutes' },
  { id: 'hourly',          label: 'Hourly',        icon: '🕐', desc: 'Once per hour at :MM' },
  { id: 'daily',           label: 'Daily',         icon: '📅', desc: 'Once a day at a chosen time' },
  { id: 'weekly',          label: 'Weekly',        icon: '📆', desc: 'Specific day(s) of week + time' },
  { id: 'monthly',         label: 'Monthly',       icon: '🗓', desc: 'A specific date each month + time' },
];
const DOW_LABELS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
const STATUS_SCHED = {
  completed: 'bg-emerald-100 text-emerald-700',
  failed:    'bg-red-100 text-red-700',
  running:   'bg-blue-100 text-blue-700',
};
const EMPTY_FORM = {
  name: '', backup_type: 'logical', schedule_type: 'daily',
  interval_minutes: 30, minute: 0, hour: 2,
  day_of_week: '0,1,2,3,4', day_of_month: 1,
  databases: '', compress: true,
  custom_storage_path: '', retain_days: 7, notes: '', enabled: true,
};

/* ── 12-hour time picker ── */
function TimePicker12h({ hour24 = 2, minute = 0, onChange, label }) {
  const isPM = hour24 >= 12;
  const h12  = hour24 === 0 ? 12 : hour24 > 12 ? hour24 - 12 : hour24;

  const applyH12 = (h) => {
    const h24 = isPM ? (h === 12 ? 12 : h + 12) : (h === 12 ? 0 : h);
    onChange(h24, minute);
  };
  const applyMin = (m) => onChange(hour24, m);
  const flipAmPm = () => {
    const h24 = isPM ? (h12 === 12 ? 0 : h12) : (h12 === 12 ? 12 : h12 + 12);
    onChange(h24, minute);
  };

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
          {Array.from({length:60},(_,i)=>i).map(m =>
            <option key={m} value={m}>{String(m).padStart(2,'0')}</option>
          )}
        </select>
        <button type="button" onClick={flipAmPm}
          className={`h-10 px-4 rounded-xl border-2 text-[13px] font-black tracking-wide transition-all select-none
            ${isPM ? 'border-violet-400 bg-violet-50 text-violet-700 hover:bg-violet-100'
                   : 'border-sky-400   bg-sky-50   text-sky-700   hover:bg-sky-100'}`}>
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
    queryKey: ['schedules', connId],
    queryFn:  () => api.listSchedules(connId),
    refetchInterval: 8000,
    retry: 1,
  });
  const schedules  = data?.data    || [];
  const apiErr     = data?.status === 'error' ? data.error : null;
  const queryFailed = isError || !!apiErr;

  const setF = patch => setForm(f => ({ ...f, ...patch }));

  const openNew  = () => { setForm(EMPTY_FORM); setEditing(null); setShowForm(true); };
  const openEdit = (s) => {
    setForm({
      name:                s.name,
      backup_type:         s.backup_type,
      schedule_type:       s.schedule_type,
      interval_minutes:    s.interval_minutes || 30,
      minute:              s.minute ?? 0,
      hour:                s.hour ?? 2,
      day_of_week:         s.day_of_week || '0,1,2,3,4',
      day_of_month:        s.day_of_month || 1,
      databases:           Array.isArray(s.databases) ? s.databases.join(', ') : '',
      compress:            !!s.compress,
      custom_storage_path: s.custom_storage_path || '',
      retain_days:         s.retain_days || 7,
      notes:               s.notes || '',
      enabled:             s.enabled,
    });
    setEditing(s.id);
    setShowForm(true);
  };

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['schedules', connId] });
    refetch();
  };

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
        custom_storage_path: form.custom_storage_path.trim() || null,
        notes:               form.notes.trim() || null,
      };
      let res;
      if (editing) {
        res = await api.updateSchedule(connId, editing, payload);
        if (res?.status === 'error') throw new Error(res.error || 'Update failed');
        showToast('Schedule updated');
      } else {
        res = await api.createSchedule(connId, payload);
        if (res?.status === 'error') throw new Error(res.error || 'Create failed');
        showToast('Schedule created');
      }
      invalidate();
      setShowForm(false);
    } catch (e) {
      showToast(e?.response?.data?.detail || e.message || 'Save failed', 'error');
    } finally { setSaving(false); }
  };

  const deleteSched = async (sid) => {
    if (!window.confirm('Delete this schedule?')) return;
    try {
      await api.deleteSchedule(connId, sid);
      showToast('Schedule deleted');
      invalidate();
    } catch (e) { showToast(e.message || 'Delete failed', 'error'); }
  };

  const toggle = async (sid, enabled) => {
    try {
      await api.toggleSchedule(connId, sid, enabled);
      showToast(enabled ? 'Schedule enabled' : 'Schedule paused');
      invalidate();
    } catch (e) { showToast(e.message || 'Toggle failed', 'error'); }
  };

  const runNow = async (sid) => {
    try {
      await api.runNow(connId, sid);
      showToast('Backup triggered — check My Backups');
      invalidate();
    } catch (e) { showToast(e.message || 'Run failed', 'error'); }
  };

  const toggleDow = (idx) => {
    const set = new Set((form.day_of_week || '').split(',').map(s => s.trim()).filter(Boolean).map(Number));
    if (set.has(idx)) set.delete(idx); else set.add(idx);
    setF({ day_of_week: [...set].sort((a,b)=>a-b).join(',') || '0' });
  };
  const selDow = new Set((form.day_of_week || '0').split(',').map(s => Number(s.trim())));
  const onTime = (h24, m) => setF({ hour: h24, minute: m });

  /* live preview text */
  const preview = (() => {
    const st  = form.schedule_type;
    const h   = Number(form.hour   ?? 2);
    const m   = Number(form.minute ?? 0);
    const per = h < 12 ? 'AM' : 'PM';
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    const t   = `${h12}:${String(m).padStart(2,'0')} ${per}`;
    if (st === 'every_x_minutes') {
      const n = Number(form.interval_minutes) || 30;
      return `Every ${n < 60 ? n + ' min' : n / 60 + ' hr'}`;
    }
    if (st === 'hourly')  return `Every hour at :${String(m).padStart(2,'0')}`;
    if (st === 'daily')   return `Daily at ${t}`;
    if (st === 'weekly') {
      const days = (form.day_of_week || '0').split(',')
        .map(d => DOW_LABELS[Number(d.trim())]).filter(Boolean).join(', ');
      return `${days || 'Mon'} at ${t}`;
    }
    if (st === 'monthly') {
      const dom = Number(form.day_of_month) || 1;
      const sfx = dom===1?'st':dom===2?'nd':dom===3?'rd':'th';
      return `${dom}${sfx} of every month at ${t}`;
    }
    return '';
  })();

  return (
    <div className="space-y-4">

      {/* ── Header ── */}
      <div className="flex items-center justify-between gap-3 flex-wrap bg-white rounded-2xl border border-slate-200 shadow-sm px-5 py-4">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-sky-500 to-blue-600 flex items-center justify-center flex-shrink-0">
            <CalendarClock size={17} className="text-white" />
          </div>
          <div>
            <h2 className="font-black text-slate-900 text-[15px]">Backup Schedules</h2>
            <p className="text-[11px] text-slate-400">{schedules.length} schedule{schedules.length!==1?'s':''} · auto-refresh every 8 s</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={refetch}
            className="w-8 h-8 rounded-xl border border-slate-200 flex items-center justify-center hover:bg-slate-50 text-slate-500 transition-all">
            <RefreshCw size={13} className={isLoading ? 'animate-spin' : ''} />
          </button>
          <button onClick={openNew}
            className="flex items-center gap-2 h-9 px-4 rounded-xl bg-gradient-to-r from-sky-500 to-blue-600 text-white text-[13px] font-bold shadow-md hover:shadow-lg hover:-translate-y-0.5 transition-all">
            <Plus size={14} /> New Schedule
          </button>
        </div>
      </div>

      {/* ── Form ── */}
      {showForm && (
        <div className="bg-white rounded-2xl border-2 border-sky-200 shadow-lg overflow-hidden">
          {/* form title */}
          <div className="bg-gradient-to-r from-sky-50 to-blue-50 border-b border-sky-200 px-5 py-3 flex items-center justify-between">
            <h3 className="font-black text-sky-800 text-[14px] flex items-center gap-2">
              <CalendarClock size={15} className="text-sky-600" />
              {editing ? 'Edit Schedule' : 'New Schedule'}
            </h3>
            <button onClick={() => setShowForm(false)}
              className="w-7 h-7 rounded-lg hover:bg-sky-200/60 flex items-center justify-center text-sky-600">
              <XCircle size={14} />
            </button>
          </div>

          {/* live preview banner */}
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
              <input value={form.name} onChange={e => setF({ name: e.target.value })}
                placeholder="e.g. Nightly Full Backup, Hourly Binlog…"
                className="w-full h-10 rounded-xl border-2 border-slate-200 px-4 text-[13px] outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-100 transition-all bg-white" />
            </div>

            {/* Backup type */}
            <div>
              <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-1.5">Backup Type</label>
              <div className="flex gap-2">
                {[
                  { id:'logical',  label:'Logical',  sub:'mysqldump' },
                  { id:'physical', label:'Physical',  sub:'file copy' },
                  { id:'binlog',   label:'Binlog',    sub:'log only'  },
                ].map(bt => (
                  <button key={bt.id} onClick={() => setF({ backup_type: bt.id })}
                    className={`flex-1 h-12 rounded-xl text-[12px] font-bold border-2 transition-all flex flex-col items-center justify-center gap-0.5
                      ${form.backup_type===bt.id ? 'border-sky-500 bg-sky-50 text-sky-700' : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300'}`}>
                    <span>{bt.label}</span>
                    <span className="text-[9px] font-medium opacity-60">{bt.sub}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Frequency selector */}
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

            {/* ── Every X minutes ── */}
            {form.schedule_type === 'every_x_minutes' && (
              <div className="md:col-span-2">
                <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-1.5">Run every…</label>
                <div className="flex flex-wrap gap-2 mb-2">
                  {[5,10,15,20,30,45,60,90,120,180,240,360,480,720].map(v => (
                    <button key={v} onClick={() => setF({ interval_minutes: v })}
                      className={`h-9 px-3 rounded-xl text-[12px] font-bold border-2 transition-all
                        ${form.interval_minutes===v ? 'border-sky-500 bg-sky-50 text-sky-700' : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300'}`}>
                      {v<60 ? `${v} min` : `${v/60} hr`}
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <input type="number" min={1} max={1440}
                    value={form.interval_minutes}
                    onChange={e => setF({ interval_minutes: Math.max(1, Number(e.target.value)) })}
                    className="w-28 h-9 rounded-xl border-2 border-slate-200 px-3 text-[13px] font-mono font-bold outline-none focus:border-sky-400 bg-white" />
                  <span className="text-[12px] text-slate-500">minutes (type custom)</span>
                </div>
              </div>
            )}

            {/* ── Hourly: minute picker ── */}
            {form.schedule_type === 'hourly' && (
              <div>
                <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-1.5">At minute past each hour</label>
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {[0,5,10,15,20,25,30,35,40,45,50,55].map(m => (
                    <button key={m} onClick={() => setF({ minute: m })}
                      className={`h-8 w-11 rounded-lg text-[12px] font-bold border-2 transition-all
                        ${form.minute===m ? 'border-sky-500 bg-sky-50 text-sky-700' : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300'}`}>
                      :{String(m).padStart(2,'0')}
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <input type="number" min={0} max={59}
                    value={form.minute}
                    onChange={e => setF({ minute: Math.min(59, Math.max(0, Number(e.target.value))) })}
                    className="w-20 h-9 rounded-xl border-2 border-slate-200 px-3 text-[13px] font-mono font-bold outline-none focus:border-sky-400 bg-white" />
                  <span className="text-[11px] text-slate-400">custom minute (0–59)</span>
                </div>
              </div>
            )}

            {/* ── Daily / Weekly / Monthly: AM-PM time picker ── */}
            {(form.schedule_type==='daily'||form.schedule_type==='weekly'||form.schedule_type==='monthly') && (
              <TimePicker12h hour24={form.hour} minute={form.minute} onChange={onTime} label="Time (local server)" />
            )}

            {/* ── Weekly: day-of-week selector ── */}
            {form.schedule_type === 'weekly' && (
              <div>
                <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-1.5">Day(s) of Week</label>
                <div className="flex gap-1.5 flex-wrap mb-2">
                  {DOW_LABELS.map((d, i) => (
                    <button key={i} onClick={() => toggleDow(i)}
                      className={`w-12 h-9 rounded-xl text-[12px] font-bold border-2 transition-all
                        ${selDow.has(i) ? 'border-sky-500 bg-sky-100 text-sky-700' : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300'}`}>
                      {d}
                    </button>
                  ))}
                </div>
                <div className="flex gap-3">
                  <button onClick={() => setF({ day_of_week:'0,1,2,3,4' })} className="text-[11px] text-sky-600 font-bold hover:underline">Weekdays</button>
                  <button onClick={() => setF({ day_of_week:'5,6'       })} className="text-[11px] text-sky-600 font-bold hover:underline">Weekend</button>
                  <button onClick={() => setF({ day_of_week:'0,1,2,3,4,5,6' })} className="text-[11px] text-sky-600 font-bold hover:underline">Every day</button>
                </div>
              </div>
            )}

            {/* ── Monthly: day-of-month grid ── */}
            {form.schedule_type === 'monthly' && (
              <div>
                <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-1.5">Day of Month</label>
                <div className="grid grid-cols-7 gap-1 mb-1">
                  {Array.from({length:28},(_,i)=>i+1).map(d => (
                    <button key={d} onClick={() => setF({ day_of_month: d })}
                      className={`h-8 rounded-lg text-[12px] font-bold border-2 transition-all
                        ${form.day_of_month===d ? 'border-sky-500 bg-sky-100 text-sky-700' : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300'}`}>
                      {d}
                    </button>
                  ))}
                </div>
                <p className="text-[10px] text-slate-400">Capped at 28 to work every month. Use 28 for end-of-month.</p>
              </div>
            )}

            {/* ── Divider ── */}
            <div className="md:col-span-2 border-t border-dashed border-slate-200" />

            {/* Databases */}
            <div>
              <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-1.5">Database(s)</label>
              <input value={form.databases} onChange={e => setF({ databases: e.target.value })}
                placeholder="Empty = all, or: db1, db2"
                className="w-full h-10 rounded-xl border-2 border-slate-200 px-4 text-[12px] outline-none focus:border-sky-400 bg-white" />
            </div>

            {/* Retain days */}
            <div>
              <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-1.5">Keep for</label>
              <div className="flex gap-1.5">
                {[3,7,14,30,60,90].map(v => (
                  <button key={v} onClick={() => setF({ retain_days: v })}
                    className={`flex-1 h-10 rounded-xl text-[12px] font-bold border-2 transition-all
                      ${form.retain_days===v ? 'border-sky-500 bg-sky-50 text-sky-700' : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300'}`}>
                    {v}d
                  </button>
                ))}
              </div>
            </div>

            {/* Compress toggle */}
            <div className="flex items-center gap-3">
              <button onClick={() => setF({ compress: !form.compress })}
                className={`w-11 h-6 rounded-full transition-all flex items-center px-0.5 flex-shrink-0
                  ${form.compress ? 'bg-emerald-500' : 'bg-slate-300'}`}>
                <div className={`w-5 h-5 rounded-full bg-white shadow transition-transform ${form.compress ? 'translate-x-5' : ''}`} />
              </button>
              <span className="text-[12px] font-semibold text-slate-600">Compress (.gz)</span>
            </div>

            {/* Enabled toggle */}
            <div className="flex items-center gap-3">
              <button onClick={() => setF({ enabled: !form.enabled })}
                className={`w-11 h-6 rounded-full transition-all flex items-center px-0.5 flex-shrink-0
                  ${form.enabled ? 'bg-sky-500' : 'bg-slate-300'}`}>
                <div className={`w-5 h-5 rounded-full bg-white shadow transition-transform ${form.enabled ? 'translate-x-5' : ''}`} />
              </button>
              <span className="text-[12px] font-semibold text-slate-600">{form.enabled ? 'Active immediately' : 'Save as disabled'}</span>
            </div>

            {/* Storage path */}
            <div className="md:col-span-2">
              <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-1.5">
                Custom Storage Path <span className="font-normal text-slate-400 normal-case">(optional)</span>
              </label>
              <div className="relative">
                <FolderOpen size={13} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
                <input value={form.custom_storage_path} onChange={e => setF({ custom_storage_path: e.target.value })}
                  placeholder="/mnt/backups/mysql  or leave blank for default"
                  className="w-full h-10 pl-9 pr-4 rounded-xl border-2 border-slate-200 text-[12px] font-mono outline-none focus:border-sky-400 bg-white" />
              </div>
            </div>

            {/* Notes */}
            <div className="md:col-span-2">
              <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-1.5">Notes</label>
              <input value={form.notes} onChange={e => setF({ notes: e.target.value })}
                placeholder="Optional description"
                className="w-full h-10 rounded-xl border-2 border-slate-200 px-4 text-[13px] outline-none focus:border-sky-400 bg-white" />
            </div>
          </div>

          {/* Footer */}
          <div className="px-5 pb-5 pt-3 border-t border-slate-100 flex items-center gap-3 flex-wrap">
            <button onClick={save} disabled={saving}
              className="flex items-center gap-2 h-10 px-6 rounded-xl bg-gradient-to-r from-sky-500 to-blue-600 text-white text-[13px] font-bold disabled:opacity-60 shadow-md hover:shadow-lg transition-all">
              {saving ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
              {saving ? 'Saving…' : editing ? 'Update Schedule' : 'Create Schedule'}
            </button>
            <button onClick={() => setShowForm(false)}
              className="h-10 px-5 rounded-xl border border-slate-200 text-[13px] font-semibold text-slate-600 hover:bg-slate-50 transition-all">
              Cancel
            </button>
            {preview && <span className="ml-auto text-[11px] font-semibold text-sky-600 hidden md:block">⏱ {preview}</span>}
          </div>
        </div>
      )}

      {/* ── Schedule list ── */}
      {isLoading ? (
        <div className="bg-white rounded-2xl border border-slate-200 p-16 flex items-center justify-center">
          <Loader2 size={28} className="animate-spin text-slate-300" />
        </div>
      ) : queryFailed ? (
        <div className="bg-white rounded-2xl border border-red-200 shadow-sm p-6">
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-xl bg-red-50 border border-red-100 flex items-center justify-center flex-shrink-0">
              <AlertTriangle size={16} className="text-red-500" />
            </div>
            <div className="flex-1">
              <p className="font-bold text-red-700 text-[13px]">Could not load schedules</p>
              <p className="text-[12px] text-red-600 mt-1 font-mono break-all">
                {apiErr || error?.response?.data?.detail || error?.message || 'Unknown error — check backend logs'}
              </p>
              <p className="text-[11px] text-slate-500 mt-2">
                The backend may need to be restarted so it can create the <code className="font-mono bg-slate-100 px-1 rounded">backup_schedules</code> table. Try restarting the server and refreshing.
              </p>
              <button onClick={() => refetch()}
                className="mt-3 flex items-center gap-2 h-8 px-4 rounded-lg border border-red-200 text-[12px] font-bold text-red-600 hover:bg-red-50 transition-all">
                <RefreshCw size={12} /> Retry
              </button>
            </div>
          </div>
        </div>
      ) : schedules.length === 0 ? (
        <div className="bg-white rounded-2xl border border-slate-200 py-20 text-center">
          <div className="w-16 h-16 rounded-2xl bg-sky-50 border border-sky-100 flex items-center justify-center mx-auto mb-4">
            <CalendarClock size={28} className="text-sky-300" />
          </div>
          <p className="font-bold text-slate-600 text-[15px]">No schedules yet</p>
          <p className="text-slate-400 text-[13px] mt-1 max-w-sm mx-auto">
            Automate backups — daily at 2:00 AM, every 30 min, every weekday at 11:00 PM…
          </p>
          <button onClick={openNew}
            className="mt-5 inline-flex items-center gap-2 h-10 px-6 rounded-xl bg-gradient-to-r from-sky-500 to-blue-600 text-white text-[13px] font-bold shadow-md">
            <Plus size={14} /> Create First Schedule
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {schedules.map(s => {
            const typeIcon = SCHED_TYPES.find(t => t.id === s.schedule_type)?.icon || '📅';
            return (
              <div key={s.id} className={`bg-white rounded-2xl border shadow-sm overflow-hidden transition-all
                ${s.enabled ? 'border-slate-200' : 'border-slate-200 opacity-60'}`}>
                <div className="h-[3px] bg-gradient-to-r from-sky-400 to-blue-500" />
                <div className="px-5 py-4">
                  <div className="flex items-start gap-4 flex-wrap">
                    {/* icon */}
                    <div className="w-10 h-10 rounded-xl bg-sky-50 border border-sky-100 flex items-center justify-center flex-shrink-0 text-[20px]">
                      {typeIcon}
                    </div>

                    {/* info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap mb-1">
                        <h3 className="font-black text-slate-900 text-[14px]">{s.name}</h3>
                        <span className="text-[11px] font-bold bg-sky-100 text-sky-700 px-2.5 py-0.5 rounded-full border border-sky-200">
                          {s.human_schedule}
                        </span>
                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full
                          ${s.backup_type==='logical'  ? 'bg-blue-100 text-blue-700'
                          : s.backup_type==='physical' ? 'bg-violet-100 text-violet-700'
                          :                              'bg-amber-100 text-amber-700'}`}>
                          {s.backup_type}
                        </span>
                        {s.last_status && (
                          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${STATUS_SCHED[s.last_status] || 'bg-slate-100 text-slate-600'}`}>
                            Last: {s.last_status}
                          </span>
                        )}
                        {!s.enabled && (
                          <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-slate-100 text-slate-400">PAUSED</span>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-400">
                        {s.next_run_at && s.enabled && (
                          <span className="flex items-center gap-1">
                            <Clock size={10} className="text-sky-400" />
                            Next: <strong className="text-sky-600">{new Date(s.next_run_at+'Z').toLocaleString()}</strong>
                          </span>
                        )}
                        {s.last_run_at && (
                          <span className="flex items-center gap-1">
                            <CheckCircle2 size={10} />
                            Last ran: {new Date(s.last_run_at+'Z').toLocaleString()}
                          </span>
                        )}
                        {s.databases?.length > 0 && (
                          <span className="flex items-center gap-1"><Database size={10} />{s.databases.join(', ')}</span>
                        )}
                        {s.retain_days && <span>Retain {s.retain_days}d</span>}
                        {s.compress && <span>Compressed</span>}
                        {s.custom_storage_path && (
                          <span className="flex items-center gap-1"><FolderOpen size={10} /><code className="font-mono text-[10px]">{s.custom_storage_path}</code></span>
                        )}
                        {s.last_job_id && <span>Last job: #{s.last_job_id}</span>}
                      </div>
                      {s.notes && <p className="mt-1 text-[11px] text-slate-500 italic">{s.notes}</p>}
                    </div>

                    {/* actions */}
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <button onClick={() => toggle(s.id, !s.enabled)}
                        title={s.enabled ? 'Pause' : 'Enable'}
                        className={`w-10 h-6 rounded-full transition-all flex items-center px-0.5 flex-shrink-0
                          ${s.enabled ? 'bg-emerald-500' : 'bg-slate-300'}`}>
                        <div className={`w-5 h-5 rounded-full bg-white shadow transition-transform ${s.enabled ? 'translate-x-4' : ''}`} />
                      </button>
                      <button onClick={() => runNow(s.id)} title="Run Now"
                        className="flex items-center gap-1.5 h-8 px-3 rounded-xl bg-sky-50 border border-sky-200 text-sky-700 text-[11px] font-bold hover:bg-sky-100 transition-all">
                        <Play size={11} /> Run Now
                      </button>
                      <button onClick={() => openEdit(s)} title="Edit"
                        className="w-8 h-8 rounded-xl bg-slate-50 border border-slate-200 flex items-center justify-center text-slate-500 hover:text-blue-600 hover:bg-blue-50 hover:border-blue-200 transition-all">
                        <Pencil size={13} />
                      </button>
                      <button onClick={() => deleteSched(s.id)} title="Delete"
                        className="w-8 h-8 rounded-xl bg-slate-50 border border-slate-200 flex items-center justify-center text-slate-500 hover:text-red-600 hover:bg-red-50 hover:border-red-200 transition-all">
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
