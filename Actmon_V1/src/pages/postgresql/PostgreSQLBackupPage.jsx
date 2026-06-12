import React, { useState, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, RefreshCw, CheckCircle2, XCircle, AlertTriangle, Loader2,
  Clock, Download, RotateCcw, Trash2, FileArchive, ChevronRight,
  Copy, CheckCheck, Eye, Play, Database, Activity, FolderOpen, Shield,
  HardDrive, Terminal, ChevronDown, ChevronUp, Layers, Radio,
  CalendarClock, Plus, Pencil, ToggleLeft, ToggleRight, Zap,
  Archive, GitBranch, Server, Info, AlertCircle,
} from 'lucide-react';
import client from '../../api/client';

/* ─── API ──────────────────────────────────────────────────────────────────── */
const api = {
  summary:       id            => client.get(`/connections/postgresql/${id}/backup/summary`).then(r => r.data),
  listBackups:   id            => client.get(`/connections/postgresql/${id}/backups`).then(r => r.data),
  takeBackup:    (id, b)       => client.post(`/connections/postgresql/${id}/backup/take`, b).then(r => r.data),
  getBackup:     (id, jid)     => client.get(`/connections/postgresql/${id}/backup/${jid}`).then(r => r.data),
  deleteJob:     (id, jid)     => client.delete(`/connections/postgresql/${id}/backup/${jid}`).then(r => r.data),
  restore:       (id, b)       => client.post(`/connections/postgresql/${id}/restore`, b).then(r => r.data),
  pitr:          (id, b)       => client.post(`/connections/postgresql/${id}/pitr`, b).then(r => r.data),
  pitrPreview:   id            => client.get(`/connections/postgresql/${id}/pitr/preview`).then(r => r.data),
  walStatus:     id            => client.get(`/connections/postgresql/${id}/wal/status`).then(r => r.data),
  walSegments:   id            => client.get(`/connections/postgresql/${id}/wal/segments`).then(r => r.data),
  listSchedules: id            => client.get(`/connections/postgresql/${id}/backup/schedules`).then(r => r.data),
  createSchedule:(id, s)       => client.post(`/connections/postgresql/${id}/backup/schedules`, s).then(r => r.data),
  updateSchedule:(id, sid, s)  => client.put(`/connections/postgresql/${id}/backup/schedules/${sid}`, s).then(r => r.data),
  deleteSchedule:(id, sid)     => client.delete(`/connections/postgresql/${id}/backup/schedules/${sid}`).then(r => r.data),
  toggleSchedule:(id, sid, e)  => client.patch(`/connections/postgresql/${id}/backup/schedules/${sid}/toggle`, { enabled: e }).then(r => r.data),
  runNow:        (id, sid)     => client.post(`/connections/postgresql/${id}/backup/schedules/${sid}/run-now`).then(r => r.data),
};

/* ─── helpers ──────────────────────────────────────────────────────────────── */
const fmt    = ts => ts ? new Date(ts).toLocaleString() : '—';
const fname  = p  => p  ? p.split(/[/\\]/).pop() : '—';
const fmtLSN = v  => v  ? String(v) : '—';

const TYPE_COLORS = {
  logical:     { bg: '#EFF6FF', border: '#BFDBFE', text: '#1D4ED8', dot: '#3B82F6' },
  basebackup:  { bg: '#F5F3FF', border: '#DDD6FE', text: '#6D28D9', dot: '#8B5CF6' },
  wal:         { bg: '#FFFBEB', border: '#FDE68A', text: '#92400E', dot: '#F59E0B' },
  restore:     { bg: '#FFF7ED', border: '#FED7AA', text: '#9A3412', dot: '#F97316' },
  pitr:        { bg: '#F0FDF4', border: '#BBF7D0', text: '#065F46', dot: '#10B981' },
};
const STATUS_MAP = {
  pending:   { cls: 'bg-slate-100 text-slate-600',     dot: 'bg-slate-400',              label: 'Pending'   },
  running:   { cls: 'bg-indigo-100 text-indigo-700',   dot: 'bg-indigo-500 animate-pulse',label: 'Running'   },
  completed: { cls: 'bg-emerald-100 text-emerald-700', dot: 'bg-emerald-500',            label: 'Completed' },
  failed:    { cls: 'bg-red-100 text-red-700',         dot: 'bg-red-500',                label: 'Failed'    },
};

const TABS = [
  { id: 'summary',  label: 'Summary',    icon: Activity },
  { id: 'backups',  label: 'My Backups', icon: Archive },
  { id: 'new',      label: 'New Backup', icon: Plus },
  { id: 'schedule', label: 'Schedule',   icon: CalendarClock },
  { id: 'restore',  label: 'Restore',    icon: RotateCcw },
  { id: 'pitr',     label: 'PITR',       icon: Clock },
  { id: 'wal',      label: 'WAL Monitor',icon: Radio },
];

/* ─── atoms ────────────────────────────────────────────────────────────────── */
function CopyBtn({ text }) {
  const [ok, setOk] = useState(false);
  return (
    <button title="Copy" onClick={e => { e.stopPropagation(); navigator.clipboard.writeText(text).catch(()=>{}); setOk(true); setTimeout(()=>setOk(false),1800); }}
      className="flex-shrink-0 text-slate-400 hover:text-slate-700 transition-colors">
      {ok ? <CheckCheck size={12} className="text-emerald-500" /> : <Copy size={12} />}
    </button>
  );
}

function Toast({ t }) {
  if (!t) return null;
  return (
    <div className={`fixed top-5 right-5 z-[9999] flex items-center gap-3 px-5 py-3.5 rounded-2xl shadow-2xl text-sm font-bold
      ${t.type==='error' ? 'bg-red-600 text-white' : 'bg-emerald-600 text-white'}`}>
      {t.type==='error' ? <XCircle size={16}/> : <CheckCircle2 size={16}/>} {t.msg}
    </div>
  );
}

function StatusBadge({ status }) {
  const s = STATUS_MAP[status] || STATUS_MAP.pending;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold ${s.cls}`}>
      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${s.dot}`}/>
      {s.label}
    </span>
  );
}

function TypeBadge({ type }) {
  const c = TYPE_COLORS[type] || { bg:'#F8FAFC',border:'#E2E8F0',text:'#64748B',dot:'#94A3B8' };
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold border"
      style={{ background:c.bg, borderColor:c.border, color:c.text }}>
      <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{background:c.dot}}/>
      {type}
    </span>
  );
}

function KV({ label, value, mono, badge }) {
  return (
    <div>
      <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wide mb-0.5">{label}</p>
      {badge
        ? <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-bold ${badge}`}>{value || '—'}</span>
        : <p className={`text-[13px] font-semibold text-slate-800 ${mono?'font-mono text-[11px]':''} truncate`}>{value || '—'}</p>
      }
    </div>
  );
}

function Section({ title, icon: Icon, children, className = '' }) {
  return (
    <div className={`bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden ${className}`}>
      <div className="bg-gradient-to-r from-slate-50 to-indigo-50/30 border-b border-slate-100 px-5 py-3 flex items-center gap-2">
        {Icon && <Icon size={14} className="text-indigo-500" />}
        <h3 className="font-black text-slate-700 text-[13px] uppercase tracking-wide">{title}</h3>
      </div>
      <div className="p-5">{children}</div>
    </div>
  );
}

/* ─── Schedule helpers ─────────────────────────────────────────────────────── */
const SCHED_TYPES = [
  { id:'every_x_minutes', label:'Every X Min', icon:'⚡', desc:'Repeat every N minutes' },
  { id:'hourly',          label:'Hourly',       icon:'🕐', desc:'Once per hour at :MM' },
  { id:'daily',           label:'Daily',        icon:'📅', desc:'Once a day' },
  { id:'weekly',          label:'Weekly',       icon:'📆', desc:'Day(s) of week + time' },
  { id:'monthly',         label:'Monthly',      icon:'🗓', desc:'A date each month' },
];
const DOW_LABELS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
const PG_BK_TYPES = [
  { id:'logical',    label:'Logical',    sub:'pg_dump',       icon:'📄' },
  { id:'basebackup', label:'Base Backup',sub:'pg_basebackup', icon:'💾' },
  { id:'wal',        label:'WAL Archive',sub:'pg_wal',        icon:'📜' },
];
const EMPTY_FORM = {
  name:'', backup_type:'logical', schedule_type:'daily',
  interval_minutes:30, minute:0, hour:2, day_of_week:'0,1,2,3,4', day_of_month:1,
  databases:'', compress:true, custom_storage_path:'', retain_days:7, notes:'', enabled:true,
};

function TimePicker12h({ hour24=2, minute=0, onChange, label }) {
  const isPM = hour24 >= 12;
  const h12  = hour24===0 ? 12 : hour24>12 ? hour24-12 : hour24;
  const applyH12 = h => { const h24 = isPM?(h===12?12:h+12):(h===12?0:h); onChange(h24,minute); };
  const applyMin = m => onChange(hour24, m);
  const flipAP   = () => { const h24=isPM?(h12===12?0:h12):(h12===12?12:h12+12); onChange(h24,minute); };
  const sel = "h-10 rounded-xl border-2 border-slate-200 text-[13px] font-bold text-center outline-none focus:border-indigo-400 bg-white cursor-pointer";
  return (
    <div>
      {label && <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-1.5">{label}</label>}
      <div className="flex items-center gap-1.5">
        <select value={h12} onChange={e=>applyH12(Number(e.target.value))} className={`${sel} w-16 pl-2`}>
          {[12,1,2,3,4,5,6,7,8,9,10,11].map(h=><option key={h} value={h}>{h}</option>)}
        </select>
        <span className="font-black text-slate-600 text-[18px] leading-none">:</span>
        <select value={minute} onChange={e=>applyMin(Number(e.target.value))} className={`${sel} w-16 pl-2`}>
          {Array.from({length:60},(_,i)=>i).map(m=><option key={m} value={m}>{String(m).padStart(2,'0')}</option>)}
        </select>
        <button type="button" onClick={flipAP}
          className={`h-10 px-4 rounded-xl border-2 text-[13px] font-black tracking-wide transition-all select-none
            ${isPM?'border-violet-400 bg-violet-50 text-violet-700':'border-sky-400 bg-sky-50 text-sky-700'}`}>
          {isPM?'PM':'AM'}
        </button>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════════
   MAIN PAGE
══════════════════════════════════════════════════════════════════════════════ */
export default function PostgreSQLBackupPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [tab,       setTab]      = useState('summary');
  const [toast,     setToast]    = useState(null);

  const showToast = useCallback((msg, type='success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  }, []);

  const { data: sumData, isLoading: sumLoading, refetch: refetchSum } = useQuery({
    queryKey: ['pgBkpSum', id],
    queryFn:  () => api.summary(id),
    refetchInterval: 20000,
  });

  const sum   = sumData || {};
  const stats = sum.backup_stats || {};
  const wal   = sum.wal || {};

  const walLevel   = wal.wal_level || '—';
  const archMode   = wal.archive_mode || 'off';
  const walOk      = walLevel !== 'minimal' && walLevel !== '—';
  const archOk     = archMode === 'on' || archMode === 'always';

  return (
    <div className="min-h-screen bg-slate-50">
      <Toast t={toast} />

      {/* ── Top bar ── */}
      <div className="bg-white border-b border-slate-200 px-6 py-4 flex items-center gap-4 shadow-sm">
        <button onClick={() => navigate(`/postgresql-dashboard/${id}`)}
          className="w-9 h-9 rounded-xl border border-slate-200 flex items-center justify-center hover:bg-slate-50 text-slate-500 transition-all">
          <ArrowLeft size={16} />
        </button>
        <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center flex-shrink-0">
          <Shield size={17} className="text-white" />
        </div>
        <div>
          <h1 className="font-black text-slate-900 text-[16px]">PostgreSQL Backup & PITR</h1>
          <p className="text-[12px] text-slate-400">
            pg_dump · pg_basebackup · WAL archiving · Point-in-Time Recovery
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {walOk
            ? <span className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-700 text-[12px] font-bold"><span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"/> WAL {walLevel}</span>
            : <span className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-amber-50 border border-amber-200 text-amber-700 text-[12px] font-bold"><AlertTriangle size={11}/> WAL minimal</span>
          }
          {archOk
            ? <span className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-indigo-50 border border-indigo-200 text-indigo-700 text-[12px] font-bold"><Radio size={11}/> Archive ON</span>
            : <span className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-slate-100 border border-slate-200 text-slate-500 text-[12px] font-bold">Archive {archMode}</span>
          }
          <button onClick={refetchSum}
            className="w-8 h-8 rounded-xl border border-slate-200 flex items-center justify-center hover:bg-slate-50 text-slate-500">
            <RefreshCw size={13} className={sumLoading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* ── Tab bar ── */}
      <div className="bg-white border-b border-slate-200 px-6">
        <div className="flex gap-1 overflow-x-auto no-scrollbar">
          {TABS.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`flex items-center gap-2 px-4 py-3.5 text-[13px] font-bold border-b-2 transition-all whitespace-nowrap
                ${tab===t.id ? 'border-indigo-500 text-indigo-600' : 'border-transparent text-slate-500 hover:text-slate-700'}`}>
              <t.icon size={14} /> {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Content ── */}
      <div className="p-6 max-w-7xl mx-auto">
        {tab === 'summary'  && <SummaryTab  connId={id} data={sumData} isLoading={sumLoading} refetch={refetchSum} showToast={showToast} setTab={setTab} />}
        {tab === 'backups'  && <BackupsTab  connId={id} showToast={showToast} setTab={setTab} />}
        {tab === 'new'      && <NewBackupTab connId={id} showToast={showToast} setTab={setTab} />}
        {tab === 'schedule' && <ScheduleTab connId={id} showToast={showToast} />}
        {tab === 'restore'  && <RestoreTab  connId={id} showToast={showToast} />}
        {tab === 'pitr'     && <PITRTab     connId={id} showToast={showToast} />}
        {tab === 'wal'      && <WALTab      connId={id} showToast={showToast} />}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════════
   SUMMARY TAB
══════════════════════════════════════════════════════════════════════════════ */
function SummaryTab({ connId, data, isLoading, refetch, showToast, setTab }) {
  if (isLoading) return <div className="flex items-center justify-center py-32"><Loader2 size={32} className="animate-spin text-indigo-300"/></div>;
  if (!data) return <div className="text-center py-20 text-slate-400">No data — check backend connection.</div>;

  const stats    = data.backup_stats || {};
  const wal      = data.wal || {};
  const archiver = data.archiver || {};
  const slots    = data.repl_slots || [];

  const walLevel = wal.wal_level || 'minimal';
  const archMode = wal.archive_mode || 'off';
  const walOk    = walLevel !== 'minimal';
  const archOk   = archMode === 'on' || archMode === 'always';

  return (
    <div className="space-y-5">
      {/* KPI row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label:'Total Backups',  value: stats.total_jobs    || 0,         icon: Archive,      color:'indigo' },
          { label:'Completed',      value: stats.completed     || 0,         icon: CheckCircle2, color:'emerald' },
          { label:'Total Size',     value: stats.size_human    || '0 B',     icon: HardDrive,    color:'violet' },
          { label:'Storage Dir',    value: fname(data.storage_dir || ''),    icon: FolderOpen,   color:'slate' },
        ].map(k => (
          <div key={k.label} className={`bg-white rounded-2xl border border-slate-200 shadow-sm p-5 flex items-center gap-4`}>
            <div className={`w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0
              ${k.color==='indigo'?'bg-indigo-50 border border-indigo-100':''}
              ${k.color==='emerald'?'bg-emerald-50 border border-emerald-100':''}
              ${k.color==='violet'?'bg-violet-50 border border-violet-100':''}
              ${k.color==='slate'?'bg-slate-50 border border-slate-100':''}`}>
              <k.icon size={18} className={
                k.color==='indigo'?'text-indigo-500':
                k.color==='emerald'?'text-emerald-500':
                k.color==='violet'?'text-violet-500':'text-slate-400'} />
            </div>
            <div>
              <p className="text-[22px] font-black text-slate-900 leading-tight truncate max-w-[120px]">{k.value}</p>
              <p className="text-[11px] text-slate-400 font-medium">{k.label}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* WAL Status */}
        <Section title="WAL Configuration" icon={Radio}>
          <div className="grid grid-cols-2 gap-4">
            <KV label="WAL Level"       value={walLevel}          badge={walOk?'bg-emerald-100 text-emerald-700':'bg-amber-100 text-amber-700'} />
            <KV label="Archive Mode"    value={archMode}          badge={archOk?'bg-indigo-100 text-indigo-700':'bg-slate-100 text-slate-500'} />
            <KV label="Current WAL File" value={wal.current_wal_file} mono />
            <KV label="Current LSN"     value={wal.current_lsn}   mono />
            <KV label="Max WAL Size"    value={wal.max_wal_size} />
            <KV label="Archive Command" value={wal.archive_command || 'not set'} mono />
          </div>
          {!walOk && (
            <div className="mt-4 p-3 rounded-xl bg-amber-50 border border-amber-200 flex gap-2">
              <AlertTriangle size={14} className="text-amber-500 flex-shrink-0 mt-0.5" />
              <p className="text-[12px] text-amber-700">
                <strong>WAL level is minimal</strong> — PITR requires <code className="bg-amber-100 px-1 rounded">wal_level = replica</code> or higher.
                Set in <code className="bg-amber-100 px-1 rounded">postgresql.conf</code> and restart.
              </p>
            </div>
          )}
        </Section>

        {/* Archiver stats */}
        <Section title="WAL Archiver" icon={Archive}>
          <div className="grid grid-cols-2 gap-4">
            <KV label="Archived Count"  value={archiver.archived_count} />
            <KV label="Failed Count"    value={archiver.failed_count}
              badge={Number(archiver.failed_count)>0?'bg-red-100 text-red-700':'bg-emerald-100 text-emerald-700'} />
            <KV label="Last Archived WAL"  value={archiver.last_archived_wal}   mono />
            <KV label="Last Archived Time" value={archiver.last_archived_time ? new Date(archiver.last_archived_time).toLocaleString() : '—'} />
            {Number(archiver.failed_count) > 0 && <>
              <KV label="Last Failed WAL"   value={archiver.last_failed_wal}   mono />
              <KV label="Last Failed Time"  value={archiver.last_failed_time ? new Date(archiver.last_failed_time).toLocaleString() : '—'} />
            </>}
          </div>
        </Section>

        {/* Last backup */}
        {stats.last_backup && (
          <Section title="Last Backup" icon={Archive}>
            <div className="grid grid-cols-2 gap-4">
              <KV label="Type"      value={stats.last_backup.backup_type} badge="bg-indigo-100 text-indigo-700" />
              <KV label="Status"    value={stats.last_backup.status}      badge="bg-emerald-100 text-emerald-700" />
              <KV label="Size"      value={stats.last_backup.size_human} />
              <KV label="Database"  value={stats.last_backup.db_name} />
              <KV label="Started"   value={fmt(stats.last_backup.backup_start)} />
              <KV label="Duration"  value={stats.last_backup.duration_sec != null ? `${stats.last_backup.duration_sec}s` : '—'} />
              <KV label="WAL File"  value={stats.last_backup.wal_file}  mono />
            </div>
          </Section>
        )}

        {/* Replication slots */}
        <Section title={`Replication Slots (${slots.length})`} icon={GitBranch}>
          {slots.length === 0
            ? <p className="text-[12px] text-slate-400 text-center py-4">No replication slots.</p>
            : (
              <div className="space-y-3">
                {slots.map((s, i) => (
                  <div key={i} className="p-3 rounded-xl bg-slate-50 border border-slate-100 grid grid-cols-2 gap-2">
                    <KV label="Slot"        value={s.slot_name} />
                    <KV label="Active"      value={s.active?'Yes':'No'} badge={s.active?'bg-emerald-100 text-emerald-700':'bg-slate-100 text-slate-500'} />
                    <KV label="Type"        value={s.slot_type} />
                    <KV label="Retained"    value={s.retained_bytes != null ? _fmt(s.retained_bytes) : '—'} />
                    <KV label="Restart LSN" value={s.restart_lsn} mono />
                  </div>
                ))}
              </div>
            )
          }
        </Section>
      </div>

      {/* By-type chart */}
      {stats.by_type && Object.keys(stats.by_type).length > 0 && (
        <Section title="Backups by Type" icon={Layers}>
          <div className="flex gap-4 flex-wrap">
            {Object.entries(stats.by_type).map(([type, count]) => {
              const c = TYPE_COLORS[type] || { bg:'#F8FAFC',border:'#E2E8F0',text:'#64748B' };
              return (
                <div key={type} className="flex flex-col items-center gap-1 px-5 py-4 rounded-2xl border-2"
                  style={{ background:c.bg, borderColor:c.border, color:c.text }}>
                  <span className="text-[28px] font-black">{count}</span>
                  <span className="text-[11px] font-bold uppercase tracking-wide">{type}</span>
                </div>
              );
            })}
          </div>
        </Section>
      )}

      {/* Quick actions */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
        <h3 className="font-black text-slate-700 text-[13px] uppercase tracking-wide mb-4">Quick Actions</h3>
        <div className="flex flex-wrap gap-3">
          {[
            { label:'pg_dump Now',       type:'logical',    icon: '📄', tab:'new' },
            { label:'pg_basebackup Now', type:'basebackup', icon: '💾', tab:'new' },
            { label:'WAL Archive Now',   type:'wal',        icon: '📜', tab:'new' },
            { label:'Create Schedule',   type:null,         icon: '📅', tab:'schedule' },
            { label:'View WAL Monitor',  type:null,         icon: '📊', tab:'wal' },
          ].map(q => (
            <button key={q.label} onClick={() => setTab(q.tab)}
              className="flex items-center gap-2 h-10 px-4 rounded-xl border-2 border-slate-200 bg-white text-slate-600 text-[13px] font-bold hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700 transition-all">
              <span>{q.icon}</span> {q.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function _fmt(b) {
  if (b >= 1_073_741_824) return `${(b/1_073_741_824).toFixed(2)} GB`;
  if (b >= 1_048_576)     return `${(b/1_048_576).toFixed(2)} MB`;
  if (b >= 1_024)         return `${(b/1_024).toFixed(2)} KB`;
  return `${b} B`;
}

/* ══════════════════════════════════════════════════════════════════════════════
   MY BACKUPS TAB
══════════════════════════════════════════════════════════════════════════════ */
function BackupsTab({ connId, showToast, setTab }) {
  const qc = useQueryClient();
  const [expand, setExpand] = useState(null);
  const { data, isLoading, refetch } = useQuery({
    queryKey: ['pgBkpList', connId],
    queryFn:  () => api.listBackups(connId),
    refetchInterval: 8000,
  });
  const jobs = data?.data || [];

  const del = async (jid) => {
    if (!window.confirm('Delete this backup job and its file?')) return;
    try {
      await api.deleteJob(connId, jid);
      showToast('Backup deleted');
      qc.invalidateQueries({ queryKey: ['pgBkpList', connId] });
      qc.invalidateQueries({ queryKey: ['pgBkpSum', connId] });
    } catch (e) { showToast(e.message || 'Delete failed', 'error'); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between bg-white rounded-2xl border border-slate-200 shadow-sm px-5 py-4">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center">
            <Archive size={17} className="text-white" />
          </div>
          <div>
            <h2 className="font-black text-slate-900 text-[15px]">My Backups</h2>
            <p className="text-[11px] text-slate-400">{jobs.length} job{jobs.length!==1?'s':''} · auto-refresh 8s</p>
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={() => refetch()}
            className="w-8 h-8 rounded-xl border border-slate-200 flex items-center justify-center hover:bg-slate-50 text-slate-500">
            <RefreshCw size={13} className={isLoading?'animate-spin':''} />
          </button>
          <button onClick={() => setTab('new')}
            className="flex items-center gap-2 h-9 px-4 rounded-xl bg-gradient-to-r from-indigo-500 to-violet-600 text-white text-[13px] font-bold shadow-md hover:shadow-lg transition-all">
            <Plus size={14} /> New Backup
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="bg-white rounded-2xl border border-slate-200 p-16 flex items-center justify-center">
          <Loader2 size={28} className="animate-spin text-slate-300" />
        </div>
      ) : jobs.length === 0 ? (
        <div className="bg-white rounded-2xl border border-slate-200 py-20 text-center">
          <div className="w-16 h-16 rounded-2xl bg-indigo-50 border border-indigo-100 flex items-center justify-center mx-auto mb-4">
            <Archive size={28} className="text-indigo-300" />
          </div>
          <p className="font-bold text-slate-600 text-[15px]">No backups yet</p>
          <p className="text-slate-400 text-[13px] mt-1">Create your first pg_dump or pg_basebackup.</p>
          <button onClick={() => setTab('new')}
            className="mt-5 inline-flex items-center gap-2 h-10 px-6 rounded-xl bg-gradient-to-r from-indigo-500 to-violet-600 text-white text-[13px] font-bold shadow-md">
            <Plus size={14} /> Create Backup
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {jobs.map(j => (
            <div key={j.id} className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="h-[3px] bg-gradient-to-r from-indigo-400 to-violet-500" />
              <div className="px-5 py-4">
                <div className="flex items-start gap-4">
                  <div className="w-10 h-10 rounded-xl bg-indigo-50 border border-indigo-100 flex items-center justify-center flex-shrink-0 text-[20px]">
                    {j.backup_type==='logical'?'📄':j.backup_type==='basebackup'?'💾':j.backup_type==='wal'?'📜':j.backup_type==='restore'?'🔄':'⏱'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <span className="font-black text-slate-900 text-[14px]">{j.db_name}</span>
                      <TypeBadge type={j.backup_type} />
                      <StatusBadge status={j.status} />
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-slate-400">
                      <span className="flex items-center gap-1"><Clock size={10}/>{fmt(j.backup_start)}</span>
                      {j.duration_sec != null && <span>{j.duration_sec}s</span>}
                      {j.size_bytes > 0 && <span className="flex items-center gap-1"><HardDrive size={10}/>{j.size_human}</span>}
                      {j.wal_file && <span className="flex items-center gap-1 font-mono"><Radio size={10}/>{j.wal_file}</span>}
                    </div>
                    {j.status==='running' && j.notes && (
                      <p className="mt-1 text-[11px] text-indigo-600 font-semibold">{j.notes}</p>
                    )}
                    {j.status==='failed' && j.error_msg && (
                      <p className="mt-1 text-[11px] text-red-600 font-mono bg-red-50 px-2 py-1 rounded-lg">{j.error_msg.slice(0,200)}</p>
                    )}
                    {expand===j.id && (
                      <div className="mt-3 p-3 bg-slate-50 rounded-xl grid grid-cols-2 gap-2 text-[11px]">
                        <KV label="UUID"       value={j.uuid}      mono />
                        <KV label="File"       value={fname(j.file_path)} mono />
                        <KV label="WAL File"   value={j.wal_file}  mono />
                        <KV label="Start LSN"  value={j.start_lsn} mono />
                        <KV label="Completed"  value={fmt(j.backup_end)} />
                        <KV label="Notes"      value={j.notes} />
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <button onClick={() => setExpand(expand===j.id?null:j.id)}
                      className="w-8 h-8 rounded-xl bg-slate-50 border border-slate-200 flex items-center justify-center text-slate-400 hover:text-indigo-600 hover:border-indigo-200 transition-all">
                      {expand===j.id ? <ChevronUp size={13}/> : <ChevronDown size={13}/>}
                    </button>
                    <button onClick={() => del(j.id)}
                      className="w-8 h-8 rounded-xl bg-slate-50 border border-slate-200 flex items-center justify-center text-slate-400 hover:text-red-600 hover:border-red-200 transition-all">
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════════
   NEW BACKUP TAB
══════════════════════════════════════════════════════════════════════════════ */
function NewBackupTab({ connId, showToast, setTab }) {
  const qc = useQueryClient();
  const [btype,   setBtype]   = useState('logical');
  const [dbs,     setDbs]     = useState('');
  const [compress,setCompress]= useState(true);
  const [notes,   setNotes]   = useState('');
  const [cpath,   setCpath]   = useState('');
  const [saving,  setSaving]  = useState(false);

  const bkTypes = [
    { id:'logical',    name:'pg_dump',        icon:'📄',
      desc:'Logical dump using pg_dump (custom format). Best for per-database backup & granular restore.',
      reqs:'Requires SELECT on all tables. Produces a .dump file restorable with pg_restore.' },
    { id:'basebackup', name:'pg_basebackup',  icon:'💾',
      desc:'Physical base backup of the entire data directory. Required for WAL-based PITR.',
      reqs:'Requires REPLICATION privilege. Produces a .tar.gz with base.tar.gz + pg_wal.tar.gz.' },
    { id:'wal',        name:'WAL Archive',    icon:'📜',
      desc:'Archives current WAL segments from pg_wal/. Use with a base backup for PITR gaps.',
      reqs:'Requires SSH access to the server. Archives all 24-char WAL segment files.' },
  ];

  const start = async () => {
    setSaving(true);
    try {
      const payload = {
        backup_type: btype,
        databases:   dbs.trim() ? dbs.split(',').map(d=>d.trim()).filter(Boolean) : null,
        compress,
        notes: notes.trim() || null,
        custom_storage_path: cpath.trim() || null,
      };
      const res = await api.takeBackup(connId, payload);
      showToast(`${btype} backup started (job #${res.job?.id})`);
      qc.invalidateQueries({ queryKey: ['pgBkpList', connId] });
      qc.invalidateQueries({ queryKey: ['pgBkpSum', connId] });
      setTimeout(() => setTab('backups'), 400);
    } catch (e) { showToast(e.message || 'Backup start failed', 'error'); }
    finally { setSaving(false); }
  };

  const sel = bkTypes.find(b=>b.id===btype);

  return (
    <div className="max-w-2xl space-y-5">
      {/* Type selector */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="bg-gradient-to-r from-indigo-50 to-violet-50/50 border-b border-indigo-100 px-5 py-3">
          <h2 className="font-black text-indigo-800 text-[14px] flex items-center gap-2">
            <Plus size={14} className="text-indigo-500"/> Choose Backup Type
          </h2>
        </div>
        <div className="p-5 space-y-3">
          {bkTypes.map(bt => (
            <button key={bt.id} onClick={() => setBtype(bt.id)}
              className={`w-full text-left p-4 rounded-xl border-2 transition-all
                ${btype===bt.id ? 'border-indigo-500 bg-indigo-50/50' : 'border-slate-200 bg-white hover:border-slate-300'}`}>
              <div className="flex items-center gap-3">
                <span className="text-[22px]">{bt.icon}</span>
                <div>
                  <p className={`font-black text-[14px] ${btype===bt.id?'text-indigo-800':'text-slate-700'}`}>{bt.name}</p>
                  <p className="text-[12px] text-slate-500">{bt.desc}</p>
                </div>
                {btype===bt.id && <CheckCircle2 size={18} className="ml-auto text-indigo-500 flex-shrink-0"/>}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Options */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="bg-gradient-to-r from-indigo-50 to-violet-50/50 border-b border-indigo-100 px-5 py-3">
          <h2 className="font-black text-indigo-800 text-[14px]">Options</h2>
        </div>
        <div className="p-5 space-y-4">
          {/* Requirements notice */}
          <div className="flex items-start gap-3 p-3 rounded-xl bg-indigo-50 border border-indigo-200">
            <Info size={14} className="text-indigo-500 flex-shrink-0 mt-0.5"/>
            <p className="text-[12px] text-indigo-700">{sel?.reqs}</p>
          </div>

          {/* Database filter (logical only) */}
          {btype === 'logical' && (
            <div>
              <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-1.5">
                Databases <span className="font-normal text-slate-400 normal-case">(leave blank for all — uses pg_dumpall)</span>
              </label>
              <input value={dbs} onChange={e=>setDbs(e.target.value)} placeholder="e.g. mydb or mydb, analytics"
                className="w-full h-10 rounded-xl border-2 border-slate-200 px-4 text-[13px] outline-none focus:border-indigo-400 bg-white"/>
            </div>
          )}

          {/* Compress */}
          <div className="flex items-center gap-3">
            <button onClick={()=>setCompress(!compress)}
              className={`w-11 h-6 rounded-full transition-all flex items-center px-0.5 flex-shrink-0
                ${compress?'bg-indigo-500':'bg-slate-300'}`}>
              <div className={`w-5 h-5 rounded-full bg-white shadow transition-transform ${compress?'translate-x-5':''}`}/>
            </button>
            <span className="text-[13px] font-semibold text-slate-600">
              {btype==='logical' && !dbs.trim() ? 'Compress (gzip output)' : 'Compress output'}
            </span>
          </div>

          {/* Storage path */}
          <div>
            <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-1.5">
              Custom Storage Path <span className="font-normal text-slate-400 normal-case">(optional)</span>
            </label>
            <div className="relative">
              <FolderOpen size={13} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400"/>
              <input value={cpath} onChange={e=>setCpath(e.target.value)} placeholder="/mnt/pgbackups or leave blank"
                className="w-full h-10 pl-9 pr-4 rounded-xl border-2 border-slate-200 text-[12px] font-mono outline-none focus:border-indigo-400 bg-white"/>
            </div>
          </div>

          {/* Notes */}
          <div>
            <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-1.5">Notes</label>
            <input value={notes} onChange={e=>setNotes(e.target.value)} placeholder="Optional description"
              className="w-full h-10 rounded-xl border-2 border-slate-200 px-4 text-[13px] outline-none focus:border-indigo-400 bg-white"/>
          </div>
        </div>
        <div className="px-5 pb-5 pt-3 border-t border-slate-100 flex gap-3">
          <button onClick={start} disabled={saving}
            className="flex items-center gap-2 h-10 px-6 rounded-xl bg-gradient-to-r from-indigo-500 to-violet-600 text-white text-[13px] font-bold disabled:opacity-60 shadow-md hover:shadow-lg transition-all">
            {saving ? <Loader2 size={14} className="animate-spin"/> : <Play size={14}/>}
            {saving ? 'Starting…' : `Start ${btype==='logical'?'pg_dump':btype==='basebackup'?'pg_basebackup':'WAL Archive'}`}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════════
   SCHEDULE TAB
══════════════════════════════════════════════════════════════════════════════ */
function ScheduleTab({ connId, showToast }) {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [editing,  setEditing]  = useState(null);
  const [form,     setForm]     = useState(EMPTY_FORM);
  const [saving,   setSaving]   = useState(false);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['pgScheds', connId],
    queryFn:  () => api.listSchedules(connId),
    refetchInterval: 8000,
    retry: 1,
  });
  const schedules   = data?.data    || [];
  const apiErr      = data?.status === 'error' ? data.error : null;
  const queryFailed = isError || !!apiErr;

  const setF = p => setForm(f => ({ ...f, ...p }));
  const invalidate = () => { qc.invalidateQueries({ queryKey: ['pgScheds', connId] }); refetch(); };

  const openNew  = () => { setForm(EMPTY_FORM); setEditing(null); setShowForm(true); };
  const openEdit = s => {
    setForm({
      name: s.name, backup_type: s.backup_type, schedule_type: s.schedule_type,
      interval_minutes: s.interval_minutes||30, minute: s.minute??0, hour: s.hour??2,
      day_of_week: s.day_of_week||'0,1,2,3,4', day_of_month: s.day_of_month||1,
      databases: Array.isArray(s.databases)?s.databases.join(', '):'',
      compress: !!s.compress, custom_storage_path: s.custom_storage_path||'',
      retain_days: s.retain_days||7, notes: s.notes||'', enabled: s.enabled,
    });
    setEditing(s.id); setShowForm(true);
  };

  const save = async () => {
    if (!form.name.trim()) return showToast('Name required', 'error');
    setSaving(true);
    try {
      const payload = {
        ...form,
        hour: Number(form.hour), minute: Number(form.minute),
        interval_minutes: Number(form.interval_minutes),
        day_of_month: Number(form.day_of_month),
        retain_days: Number(form.retain_days),
        databases: form.databases.trim() ? form.databases.split(',').map(d=>d.trim()).filter(Boolean) : null,
        custom_storage_path: form.custom_storage_path.trim() || null,
        notes: form.notes.trim() || null,
      };
      const res = editing ? await api.updateSchedule(connId, editing, payload)
                          : await api.createSchedule(connId, payload);
      if (res?.status === 'error') throw new Error(res.error || 'Failed');
      showToast(editing ? 'Schedule updated' : 'Schedule created');
      invalidate(); setShowForm(false);
    } catch (e) { showToast(e?.response?.data?.detail || e.message || 'Save failed', 'error'); }
    finally { setSaving(false); }
  };

  const del = async sid => {
    if (!window.confirm('Delete schedule?')) return;
    try { await api.deleteSchedule(connId, sid); showToast('Deleted'); invalidate(); }
    catch (e) { showToast(e.message||'Delete failed','error'); }
  };
  const toggle = async (sid, en) => {
    try { await api.toggleSchedule(connId, sid, en); showToast(en?'Enabled':'Paused'); invalidate(); }
    catch (e) { showToast(e.message||'Toggle failed','error'); }
  };
  const run = async sid => {
    try { await api.runNow(connId, sid); showToast('Backup triggered'); invalidate(); }
    catch (e) { showToast(e.message||'Failed','error'); }
  };

  const toggleDow = idx => {
    const s = new Set((form.day_of_week||'').split(',').map(x=>x.trim()).filter(Boolean).map(Number));
    s.has(idx) ? s.delete(idx) : s.add(idx);
    setF({ day_of_week: [...s].sort((a,b)=>a-b).join(',') || '0' });
  };
  const selDow = new Set((form.day_of_week||'0').split(',').map(x=>Number(x.trim())));
  const onTime = (h24,m) => setF({ hour:h24, minute:m });

  const preview = (() => {
    const st=form.schedule_type, h=Number(form.hour??2), m=Number(form.minute??0);
    const per=h<12?'AM':'PM', h12=h===0?12:h>12?h-12:h;
    const t=`${h12}:${String(m).padStart(2,'0')} ${per}`;
    if (st==='every_x_minutes') { const n=Number(form.interval_minutes)||30; return `Every ${n<60?n+' min':n/60+' hr'}`; }
    if (st==='hourly')   return `Every hour at :${String(m).padStart(2,'0')}`;
    if (st==='daily')    return `Daily at ${t}`;
    if (st==='weekly')   return `Weekly ${(form.day_of_week||'0').split(',').map(d=>DOW_LABELS[Number(d.trim())]).filter(Boolean).join(', ')} at ${t}`;
    if (st==='monthly')  { const d=form.day_of_month; const sfx=d==1?'st':d==2?'nd':d==3?'rd':'th'; return `Monthly ${d}${sfx} at ${t}`; }
    return '';
  })();

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between bg-white rounded-2xl border border-slate-200 shadow-sm px-5 py-4 flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center">
            <CalendarClock size={17} className="text-white"/>
          </div>
          <div>
            <h2 className="font-black text-slate-900 text-[15px]">Backup Schedules</h2>
            <p className="text-[11px] text-slate-400">{schedules.length} schedule{schedules.length!==1?'s':''} · auto-refresh 8s</p>
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={() => refetch()} className="w-8 h-8 rounded-xl border border-slate-200 flex items-center justify-center hover:bg-slate-50 text-slate-500">
            <RefreshCw size={13} className={isLoading?'animate-spin':''}/>
          </button>
          <button onClick={openNew}
            className="flex items-center gap-2 h-9 px-4 rounded-xl bg-gradient-to-r from-indigo-500 to-violet-600 text-white text-[13px] font-bold shadow-md hover:shadow-lg transition-all">
            <Plus size={14}/> New Schedule
          </button>
        </div>
      </div>

      {/* Form */}
      {showForm && (
        <div className="bg-white rounded-2xl border-2 border-indigo-200 shadow-lg overflow-hidden">
          <div className="bg-gradient-to-r from-indigo-50 to-violet-50 border-b border-indigo-200 px-5 py-3 flex items-center justify-between">
            <h3 className="font-black text-indigo-800 text-[14px] flex items-center gap-2">
              <CalendarClock size={15} className="text-indigo-600"/>
              {editing ? 'Edit Schedule' : 'New Schedule'}
            </h3>
            <button onClick={()=>setShowForm(false)} className="w-7 h-7 rounded-lg hover:bg-indigo-200/60 flex items-center justify-center text-indigo-600">
              <XCircle size={14}/>
            </button>
          </div>
          {(form.name||preview) && (
            <div className="bg-indigo-50 border-b border-indigo-100 px-5 py-2 flex items-center gap-2">
              <Clock size={11} className="text-indigo-400 flex-shrink-0"/>
              {form.name && <span className="text-[12px] font-bold text-indigo-700">{form.name} —</span>}
              <span className="text-[12px] text-indigo-600">{preview||'…'}</span>
            </div>
          )}
          <div className="p-5 grid grid-cols-1 md:grid-cols-2 gap-5">
            {/* Name */}
            <div className="md:col-span-2">
              <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-1.5">Schedule Name *</label>
              <input value={form.name} onChange={e=>setF({name:e.target.value})} placeholder="e.g. Nightly pg_dump, Weekly Basebackup…"
                className="w-full h-10 rounded-xl border-2 border-slate-200 px-4 text-[13px] outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 transition-all bg-white"/>
            </div>

            {/* Backup type */}
            <div>
              <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-1.5">Backup Type</label>
              <div className="flex gap-2">
                {PG_BK_TYPES.map(bt=>(
                  <button key={bt.id} onClick={()=>setF({backup_type:bt.id})}
                    className={`flex-1 h-12 rounded-xl text-[11px] font-bold border-2 transition-all flex flex-col items-center justify-center gap-0.5
                      ${form.backup_type===bt.id?'border-indigo-500 bg-indigo-50 text-indigo-700':'border-slate-200 bg-white text-slate-500 hover:border-slate-300'}`}>
                    <span>{bt.icon}</span><span>{bt.label}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Frequency */}
            <div>
              <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-1.5">Frequency</label>
              <div className="grid grid-cols-5 gap-1">
                {SCHED_TYPES.map(st=>(
                  <button key={st.id} onClick={()=>setF({schedule_type:st.id})} title={st.desc}
                    className={`flex flex-col items-center justify-center h-[58px] rounded-xl text-[9px] font-bold border-2 transition-all gap-0.5 px-1
                      ${form.schedule_type===st.id?'border-indigo-500 bg-indigo-50 text-indigo-700':'border-slate-200 bg-slate-50/60 text-slate-500 hover:border-slate-300'}`}>
                    <span className="text-[17px]">{st.icon}</span>
                    <span className="text-center leading-tight">{st.label}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Every X min */}
            {form.schedule_type==='every_x_minutes' && (
              <div className="md:col-span-2">
                <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-1.5">Run every…</label>
                <div className="flex flex-wrap gap-2 mb-2">
                  {[5,10,15,20,30,45,60,90,120,240,480,720].map(v=>(
                    <button key={v} onClick={()=>setF({interval_minutes:v})}
                      className={`h-9 px-3 rounded-xl text-[12px] font-bold border-2 transition-all
                        ${form.interval_minutes===v?'border-indigo-500 bg-indigo-50 text-indigo-700':'border-slate-200 bg-white text-slate-500 hover:border-slate-300'}`}>
                      {v<60?`${v} min`:`${v/60} hr`}
                    </button>
                  ))}
                </div>
                <input type="number" min={1} max={1440} value={form.interval_minutes}
                  onChange={e=>setF({interval_minutes:Math.max(1,Number(e.target.value))})}
                  className="w-28 h-9 rounded-xl border-2 border-slate-200 px-3 text-[13px] font-mono font-bold outline-none focus:border-indigo-400 bg-white"/>
              </div>
            )}

            {/* Hourly minute */}
            {form.schedule_type==='hourly' && (
              <div>
                <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-1.5">At minute</label>
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {[0,5,10,15,20,25,30,35,40,45,50,55].map(m=>(
                    <button key={m} onClick={()=>setF({minute:m})}
                      className={`h-8 w-11 rounded-lg text-[12px] font-bold border-2 transition-all
                        ${form.minute===m?'border-indigo-500 bg-indigo-50 text-indigo-700':'border-slate-200 bg-white text-slate-500'}`}>
                      :{String(m).padStart(2,'0')}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Time picker for daily/weekly/monthly */}
            {(form.schedule_type==='daily'||form.schedule_type==='weekly'||form.schedule_type==='monthly') && (
              <TimePicker12h hour24={form.hour} minute={form.minute} onChange={onTime} label="Time (server local)"/>
            )}

            {/* DOW picker */}
            {form.schedule_type==='weekly' && (
              <div>
                <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-1.5">Day(s) of Week</label>
                <div className="flex gap-1.5 flex-wrap mb-2">
                  {DOW_LABELS.map((d,i)=>(
                    <button key={i} onClick={()=>toggleDow(i)}
                      className={`w-12 h-9 rounded-xl text-[12px] font-bold border-2 transition-all
                        ${selDow.has(i)?'border-indigo-500 bg-indigo-100 text-indigo-700':'border-slate-200 bg-white text-slate-500'}`}>
                      {d}
                    </button>
                  ))}
                </div>
                <div className="flex gap-3">
                  <button onClick={()=>setF({day_of_week:'0,1,2,3,4'})} className="text-[11px] text-indigo-600 font-bold hover:underline">Weekdays</button>
                  <button onClick={()=>setF({day_of_week:'5,6'})} className="text-[11px] text-indigo-600 font-bold hover:underline">Weekend</button>
                  <button onClick={()=>setF({day_of_week:'0,1,2,3,4,5,6'})} className="text-[11px] text-indigo-600 font-bold hover:underline">Every day</button>
                </div>
              </div>
            )}

            {/* Monthly DOM */}
            {form.schedule_type==='monthly' && (
              <div>
                <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-1.5">Day of Month</label>
                <div className="grid grid-cols-7 gap-1 mb-1">
                  {Array.from({length:28},(_,i)=>i+1).map(d=>(
                    <button key={d} onClick={()=>setF({day_of_month:d})}
                      className={`h-8 rounded-lg text-[12px] font-bold border-2 transition-all
                        ${form.day_of_month===d?'border-indigo-500 bg-indigo-100 text-indigo-700':'border-slate-200 bg-white text-slate-500'}`}>
                      {d}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="md:col-span-2 border-t border-dashed border-slate-200"/>

            {/* Databases */}
            <div>
              <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-1.5">Database(s)</label>
              <input value={form.databases} onChange={e=>setF({databases:e.target.value})} placeholder="Empty = all, or: db1, db2"
                className="w-full h-10 rounded-xl border-2 border-slate-200 px-4 text-[12px] outline-none focus:border-indigo-400 bg-white"/>
            </div>

            {/* Retain */}
            <div>
              <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-1.5">Keep for</label>
              <div className="flex gap-1.5">
                {[3,7,14,30,60,90].map(v=>(
                  <button key={v} onClick={()=>setF({retain_days:v})}
                    className={`flex-1 h-10 rounded-xl text-[12px] font-bold border-2 transition-all
                      ${form.retain_days===v?'border-indigo-500 bg-indigo-50 text-indigo-700':'border-slate-200 bg-white text-slate-500'}`}>
                    {v}d
                  </button>
                ))}
              </div>
            </div>

            {/* Compress + enabled */}
            <div className="flex items-center gap-3">
              <button onClick={()=>setF({compress:!form.compress})}
                className={`w-11 h-6 rounded-full transition-all flex items-center px-0.5 ${form.compress?'bg-emerald-500':'bg-slate-300'}`}>
                <div className={`w-5 h-5 rounded-full bg-white shadow transition-transform ${form.compress?'translate-x-5':''}`}/>
              </button>
              <span className="text-[12px] font-semibold text-slate-600">Compress</span>
            </div>
            <div className="flex items-center gap-3">
              <button onClick={()=>setF({enabled:!form.enabled})}
                className={`w-11 h-6 rounded-full transition-all flex items-center px-0.5 ${form.enabled?'bg-indigo-500':'bg-slate-300'}`}>
                <div className={`w-5 h-5 rounded-full bg-white shadow transition-transform ${form.enabled?'translate-x-5':''}`}/>
              </button>
              <span className="text-[12px] font-semibold text-slate-600">{form.enabled?'Active immediately':'Save disabled'}</span>
            </div>

            {/* Storage path + Notes */}
            <div className="md:col-span-2">
              <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-1.5">Storage Path <span className="font-normal text-slate-400 normal-case">(optional)</span></label>
              <div className="relative">
                <FolderOpen size={13} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400"/>
                <input value={form.custom_storage_path} onChange={e=>setF({custom_storage_path:e.target.value})} placeholder="/mnt/pgbackups"
                  className="w-full h-10 pl-9 pr-4 rounded-xl border-2 border-slate-200 text-[12px] font-mono outline-none focus:border-indigo-400 bg-white"/>
              </div>
            </div>
            <div className="md:col-span-2">
              <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-1.5">Notes</label>
              <input value={form.notes} onChange={e=>setF({notes:e.target.value})} placeholder="Optional"
                className="w-full h-10 rounded-xl border-2 border-slate-200 px-4 text-[13px] outline-none focus:border-indigo-400 bg-white"/>
            </div>
          </div>
          <div className="px-5 pb-5 pt-3 border-t border-slate-100 flex items-center gap-3 flex-wrap">
            <button onClick={save} disabled={saving}
              className="flex items-center gap-2 h-10 px-6 rounded-xl bg-gradient-to-r from-indigo-500 to-violet-600 text-white text-[13px] font-bold disabled:opacity-60 shadow-md hover:shadow-lg transition-all">
              {saving?<Loader2 size={14} className="animate-spin"/>:<CheckCircle2 size={14}/>}
              {saving?'Saving…':editing?'Update Schedule':'Create Schedule'}
            </button>
            <button onClick={()=>setShowForm(false)} className="h-10 px-5 rounded-xl border border-slate-200 text-[13px] font-semibold text-slate-600 hover:bg-slate-50">Cancel</button>
            {preview && <span className="ml-auto text-[11px] font-semibold text-indigo-600 hidden md:block">⏱ {preview}</span>}
          </div>
        </div>
      )}

      {/* Schedule list */}
      {isLoading ? (
        <div className="bg-white rounded-2xl border border-slate-200 p-16 flex items-center justify-center">
          <Loader2 size={28} className="animate-spin text-slate-300"/>
        </div>
      ) : queryFailed ? (
        <div className="bg-white rounded-2xl border border-red-200 shadow-sm p-6">
          <div className="flex items-start gap-3">
            <AlertTriangle size={16} className="text-red-500 mt-0.5"/>
            <div>
              <p className="font-bold text-red-700 text-[13px]">Could not load schedules</p>
              <p className="text-[12px] text-red-600 font-mono mt-1 break-all">{apiErr || error?.message || 'Unknown error'}</p>
              <button onClick={()=>refetch()} className="mt-3 flex items-center gap-2 h-8 px-4 rounded-lg border border-red-200 text-[12px] font-bold text-red-600 hover:bg-red-50">
                <RefreshCw size={12}/> Retry
              </button>
            </div>
          </div>
        </div>
      ) : schedules.length === 0 ? (
        <div className="bg-white rounded-2xl border border-slate-200 py-20 text-center">
          <div className="w-16 h-16 rounded-2xl bg-indigo-50 border border-indigo-100 flex items-center justify-center mx-auto mb-4">
            <CalendarClock size={28} className="text-indigo-300"/>
          </div>
          <p className="font-bold text-slate-600 text-[15px]">No schedules yet</p>
          <p className="text-slate-400 text-[13px] mt-1 max-w-sm mx-auto">Automate pg_dump nightly, pg_basebackup weekly, WAL hourly…</p>
          <button onClick={openNew}
            className="mt-5 inline-flex items-center gap-2 h-10 px-6 rounded-xl bg-gradient-to-r from-indigo-500 to-violet-600 text-white text-[13px] font-bold shadow-md">
            <Plus size={14}/> Create First Schedule
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {schedules.map(s => (
            <div key={s.id} className={`bg-white rounded-2xl border shadow-sm overflow-hidden transition-all ${s.enabled?'border-slate-200':'border-slate-200 opacity-60'}`}>
              <div className="h-[3px] bg-gradient-to-r from-indigo-400 to-violet-500"/>
              <div className="px-5 py-4">
                <div className="flex items-start gap-4 flex-wrap">
                  <div className="w-10 h-10 rounded-xl bg-indigo-50 border border-indigo-100 flex items-center justify-center flex-shrink-0 text-[20px]">
                    {SCHED_TYPES.find(t=>t.id===s.schedule_type)?.icon||'📅'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <h3 className="font-black text-slate-900 text-[14px]">{s.name}</h3>
                      <span className="text-[11px] font-bold bg-indigo-100 text-indigo-700 px-2.5 py-0.5 rounded-full border border-indigo-200">{s.human_schedule}</span>
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${s.backup_type==='logical'?'bg-blue-100 text-blue-700':s.backup_type==='basebackup'?'bg-violet-100 text-violet-700':'bg-amber-100 text-amber-700'}`}>{s.backup_type}</span>
                      {s.last_status && <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${s.last_status==='completed'?'bg-emerald-100 text-emerald-700':s.last_status==='failed'?'bg-red-100 text-red-700':'bg-blue-100 text-blue-700'}`}>Last: {s.last_status}</span>}
                      {!s.enabled && <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-slate-100 text-slate-400">PAUSED</span>}
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-400">
                      {s.next_run_at && s.enabled && (
                        <span className="flex items-center gap-1"><Clock size={10} className="text-indigo-400"/>Next: <strong className="text-indigo-600">{new Date(s.next_run_at+'Z').toLocaleString()}</strong></span>
                      )}
                      {s.databases?.length>0 && <span className="flex items-center gap-1"><Database size={10}/>{s.databases.join(', ')}</span>}
                      {s.retain_days && <span>Retain {s.retain_days}d</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <button onClick={()=>toggle(s.id,!s.enabled)} title={s.enabled?'Pause':'Enable'}
                      className={`w-10 h-6 rounded-full flex items-center px-0.5 transition-all ${s.enabled?'bg-emerald-500':'bg-slate-300'}`}>
                      <div className={`w-5 h-5 rounded-full bg-white shadow transition-transform ${s.enabled?'translate-x-4':''}`}/>
                    </button>
                    <button onClick={()=>run(s.id)} title="Run Now"
                      className="flex items-center gap-1.5 h-8 px-3 rounded-xl bg-indigo-50 border border-indigo-200 text-indigo-700 text-[11px] font-bold hover:bg-indigo-100 transition-all">
                      <Play size={11}/> Run Now
                    </button>
                    <button onClick={()=>openEdit(s)} title="Edit"
                      className="w-8 h-8 rounded-xl bg-slate-50 border border-slate-200 flex items-center justify-center text-slate-500 hover:text-indigo-600 hover:border-indigo-200 transition-all">
                      <Pencil size={13}/>
                    </button>
                    <button onClick={()=>del(s.id)} title="Delete"
                      className="w-8 h-8 rounded-xl bg-slate-50 border border-slate-200 flex items-center justify-center text-slate-500 hover:text-red-600 hover:border-red-200 transition-all">
                      <Trash2 size={13}/>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════════
   RESTORE TAB
══════════════════════════════════════════════════════════════════════════════ */
function RestoreTab({ connId, showToast }) {
  const qc = useQueryClient();
  const [jobId,    setJobId]    = useState('');
  const [targetDb, setTargetDb] = useState('');
  const [createDb, setCreateDb] = useState(true);
  const [clean,    setClean]    = useState(true);
  const [noOwner,  setNoOwner]  = useState(true);
  const [saving,   setSaving]   = useState(false);
  const [result,   setResult]   = useState(null);

  const { data } = useQuery({
    queryKey: ['pgBkpList', connId],
    queryFn:  () => api.listBackups(connId),
    staleTime: 10000,
  });
  const logicals = (data?.data || []).filter(j => j.backup_type === 'logical' && j.status === 'completed');

  const doRestore = async () => {
    if (!jobId) return showToast('Select a backup to restore', 'error');
    setSaving(true); setResult(null);
    try {
      const res = await api.restore(connId, {
        job_id: Number(jobId), target_db: targetDb.trim()||null,
        create_db: createDb, clean, no_owner: noOwner, confirm: true,
      });
      if (res?.status === 'error') throw new Error(res.error);
      showToast(`Restore started — job #${res.job?.id}`);
      setResult(res.job);
      qc.invalidateQueries({ queryKey: ['pgBkpList', connId] });
    } catch (e) { showToast(e.message||'Restore failed','error'); }
    finally { setSaving(false); }
  };

  return (
    <div className="max-w-2xl space-y-5">
      <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 flex items-start gap-3">
        <AlertTriangle size={16} className="text-amber-500 flex-shrink-0 mt-0.5"/>
        <div>
          <p className="font-bold text-amber-800 text-[13px]">Restore Warning</p>
          <p className="text-[12px] text-amber-700 mt-0.5">
            pg_restore will overwrite data in the target database. Use a different <strong>Target Database</strong> to avoid overwriting production.
            Ensure the PostgreSQL user has CREATE DATABASE and superuser privileges.
          </p>
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="bg-gradient-to-r from-indigo-50 to-violet-50/50 border-b border-indigo-100 px-5 py-3">
          <h2 className="font-black text-indigo-800 text-[14px] flex items-center gap-2">
            <RotateCcw size={14} className="text-indigo-500"/> Restore from pg_dump
          </h2>
        </div>
        <div className="p-5 space-y-4">
          {/* Backup selector */}
          <div>
            <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-1.5">Source Backup</label>
            {logicals.length === 0 ? (
              <p className="text-[13px] text-slate-400 italic">No completed logical (pg_dump) backups found. Create one first.</p>
            ) : (
              <select value={jobId} onChange={e=>setJobId(e.target.value)}
                className="w-full h-10 rounded-xl border-2 border-slate-200 px-3 text-[13px] outline-none focus:border-indigo-400 bg-white">
                <option value="">— Select a pg_dump backup —</option>
                {logicals.map(j => (
                  <option key={j.id} value={j.id}>
                    #{j.id} — {j.db_name} — {new Date(j.backup_start).toLocaleString()} — {j.size_human}
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Target DB */}
          <div>
            <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-1.5">
              Target Database <span className="font-normal text-slate-400 normal-case">(leave blank to use original database name)</span>
            </label>
            <input value={targetDb} onChange={e=>setTargetDb(e.target.value)} placeholder="e.g. my_restored_db"
              className="w-full h-10 rounded-xl border-2 border-slate-200 px-4 text-[13px] outline-none focus:border-indigo-400 bg-white"/>
          </div>

          {/* Options */}
          <div className="grid grid-cols-3 gap-4">
            {[
              { key:'createDb', val:createDb, set:setCreateDb, label:'Create DB', desc:'CREATE DATABASE if it does not exist' },
              { key:'clean',    val:clean,    set:setClean,    label:'--clean', desc:'DROP objects before recreating' },
              { key:'noOwner',  val:noOwner,  set:setNoOwner,  label:'--no-owner', desc:'Skip ownership reassignment' },
            ].map(opt => (
              <div key={opt.key} className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2">
                  <button onClick={()=>opt.set(!opt.val)}
                    className={`w-11 h-6 rounded-full flex items-center px-0.5 transition-all ${opt.val?'bg-indigo-500':'bg-slate-300'}`}>
                    <div className={`w-5 h-5 rounded-full bg-white shadow transition-transform ${opt.val?'translate-x-5':''}`}/>
                  </button>
                  <span className="text-[12px] font-bold text-slate-700">{opt.label}</span>
                </div>
                <p className="text-[10px] text-slate-400">{opt.desc}</p>
              </div>
            ))}
          </div>
        </div>
        <div className="px-5 pb-5 pt-3 border-t border-slate-100">
          <button onClick={doRestore} disabled={saving||!jobId}
            className="flex items-center gap-2 h-10 px-6 rounded-xl bg-gradient-to-r from-indigo-500 to-violet-600 text-white text-[13px] font-bold disabled:opacity-60 shadow-md hover:shadow-lg transition-all">
            {saving ? <Loader2 size={14} className="animate-spin"/> : <RotateCcw size={14}/>}
            {saving ? 'Starting restore…' : 'Run pg_restore'}
          </button>
        </div>
      </div>

      {result && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-2xl p-4">
          <p className="font-bold text-emerald-800 text-[13px] flex items-center gap-2"><CheckCircle2 size={14}/> Restore job #{result.id} started</p>
          <p className="text-[12px] text-emerald-700 mt-1">Check <strong>My Backups</strong> for progress. Status: <span className="font-mono">{result.status}</span></p>
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════════
   PITR TAB
══════════════════════════════════════════════════════════════════════════════ */
function PITRTab({ connId, showToast }) {
  const qc = useQueryClient();
  const [baseJobId, setBaseJobId]   = useState('');
  const [targetDt,  setTargetDt]    = useState('');
  const [action,    setAction]      = useState('pause');
  const [rPort,     setRPort]       = useState('');
  const [walPath,   setWalPath]     = useState('');
  const [saving,    setSaving]      = useState(false);
  const [result,    setResult]      = useState(null);

  const { data: preview, isLoading: previewLoading, refetch: refetchPreview } = useQuery({
    queryKey: ['pgPITRPreview', connId],
    queryFn:  () => api.pitrPreview(connId),
    staleTime: 30000,
  });

  const pv    = preview || {};
  const bases = pv.base_backups || [];
  const pWal  = pv.wal_info || {};

  const doPITR = async () => {
    if (!baseJobId) return showToast('Select a base backup', 'error');
    if (!targetDt)  return showToast('Enter target datetime', 'error');
    setSaving(true); setResult(null);
    try {
      const res = await api.pitr(connId, {
        base_job_id:    Number(baseJobId),
        target_datetime: targetDt,
        target_action:  action,
        recovery_port:  rPort ? Number(rPort) : null,
        wal_archive_path: walPath.trim() || null,
        confirm: true,
      });
      if (res?.status === 'error') throw new Error(res.error);
      showToast(`PITR started — job #${res.job?.id}`);
      setResult(res.job);
      qc.invalidateQueries({ queryKey: ['pgBkpList', connId] });
    } catch (e) { showToast(e.message||'PITR failed','error'); }
    finally { setSaving(false); }
  };

  const walCapable  = pv.pitr_capable;
  const walLevel    = pWal.wal_level || 'unknown';

  return (
    <div className="max-w-2xl space-y-5">
      {/* Info banner */}
      <div className="bg-indigo-50 border border-indigo-200 rounded-2xl p-4 space-y-2">
        <p className="font-bold text-indigo-800 text-[13px] flex items-center gap-2"><Info size={14}/> How PostgreSQL PITR Works</p>
        <ol className="text-[12px] text-indigo-700 list-decimal pl-4 space-y-1">
          <li>A <strong>pg_basebackup</strong> provides the base image (physical cluster copy)</li>
          <li>WAL segments archive changes from the backup point to target time</li>
          <li>Recovery starts on an <strong>alternate port</strong> — it does NOT overwrite production</li>
          <li>After recovery completes at the target time, the instance pauses/promotes based on target action</li>
          <li>Connect to the recovery instance, verify data, then promote when ready</li>
        </ol>
        <p className="text-[11px] text-indigo-600 font-medium">
          Requires: <code className="bg-indigo-100 px-1 rounded">wal_level ≥ replica</code> · WAL segments present on server
        </p>
      </div>

      {/* WAL status */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-black text-slate-700 text-[13px] uppercase tracking-wide">WAL / Archive Status</h3>
          <button onClick={() => refetchPreview()} className="w-7 h-7 rounded-lg border border-slate-200 flex items-center justify-center hover:bg-slate-50 text-slate-400">
            <RefreshCw size={12} className={previewLoading?'animate-spin':''}/>
          </button>
        </div>
        {previewLoading ? <div className="flex items-center gap-2 text-slate-400 text-[13px]"><Loader2 size={14} className="animate-spin"/> Checking…</div> : (
          <div className="grid grid-cols-2 gap-3">
            <KV label="WAL Level" value={walLevel}
              badge={walLevel==='minimal'?'bg-amber-100 text-amber-700':walLevel!=='unknown'?'bg-emerald-100 text-emerald-700':'bg-slate-100 text-slate-500'}/>
            <KV label="Archive Mode" value={pWal.archive_mode||'—'}
              badge={(pWal.archive_mode==='on'||pWal.archive_mode==='always')?'bg-indigo-100 text-indigo-700':'bg-slate-100 text-slate-500'}/>
            <KV label="Current WAL" value={pWal.current_wal} mono/>
            <KV label="Last Archived WAL" value={pWal.last_archived_wal} mono/>
            <KV label="Base Backups Available" value={`${bases.length} completed`}
              badge={bases.length>0?'bg-emerald-100 text-emerald-700':'bg-slate-100 text-slate-500'}/>
            <KV label="PITR Capable" value={walCapable?'Yes':'No'}
              badge={walCapable?'bg-emerald-100 text-emerald-700':'bg-red-100 text-red-700'}/>
          </div>
        )}
        {!walCapable && !previewLoading && (
          <div className="mt-3 p-3 rounded-xl bg-amber-50 border border-amber-200 text-[12px] text-amber-700">
            <strong>PITR requires:</strong> <code className="bg-amber-100 px-1 rounded">wal_level = replica</code> in postgresql.conf + at least one completed <strong>pg_basebackup</strong> job.
          </div>
        )}
      </div>

      {/* PITR form */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="bg-gradient-to-r from-indigo-50 to-violet-50/50 border-b border-indigo-100 px-5 py-3">
          <h2 className="font-black text-indigo-800 text-[14px] flex items-center gap-2">
            <Clock size={14} className="text-indigo-500"/> Configure PITR
          </h2>
        </div>
        <div className="p-5 space-y-4">
          {/* Base backup */}
          <div>
            <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-1.5">Base Backup (pg_basebackup)</label>
            {bases.length === 0 ? (
              <p className="text-[13px] text-slate-400 italic">No completed basebackup jobs. Run a <strong>pg_basebackup</strong> first from the New Backup tab.</p>
            ) : (
              <select value={baseJobId} onChange={e=>setBaseJobId(e.target.value)}
                className="w-full h-10 rounded-xl border-2 border-slate-200 px-3 text-[13px] outline-none focus:border-indigo-400 bg-white">
                <option value="">— Select base backup —</option>
                {bases.map(j => (
                  <option key={j.id} value={j.id}>
                    #{j.id} — {new Date(j.backup_start).toLocaleString()} — {j.size_human} — WAL: {j.wal_file||'?'}
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Target datetime */}
          <div>
            <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-1.5">Recovery Target Time</label>
            <input type="datetime-local" value={targetDt} onChange={e=>setTargetDt(e.target.value.replace('T',' '))}
              className="w-full h-10 rounded-xl border-2 border-slate-200 px-4 text-[13px] outline-none focus:border-indigo-400 bg-white"/>
            <p className="text-[11px] text-slate-400 mt-1">PostgreSQL will replay WAL up to this exact timestamp (server timezone).</p>
          </div>

          {/* Target action */}
          <div>
            <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-1.5">Action When Target Reached</label>
            <div className="flex gap-3">
              {[
                { id:'pause',    label:'Pause',    desc:'Stop, wait for manual promote' },
                { id:'promote',  label:'Promote',  desc:'Auto-promote to read-write' },
                { id:'shutdown', label:'Shutdown', desc:'Shut down after recovery' },
              ].map(a => (
                <button key={a.id} onClick={()=>setAction(a.id)}
                  className={`flex-1 py-3 rounded-xl text-center border-2 transition-all
                    ${action===a.id?'border-indigo-500 bg-indigo-50':'border-slate-200 bg-white hover:border-slate-300'}`}>
                  <p className={`text-[12px] font-bold ${action===a.id?'text-indigo-700':'text-slate-600'}`}>{a.label}</p>
                  <p className="text-[10px] text-slate-400 mt-0.5">{a.desc}</p>
                </button>
              ))}
            </div>
          </div>

          {/* Advanced */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-1.5">
                Recovery Port <span className="font-normal text-slate-400 normal-case">(default: primary+1)</span>
              </label>
              <input type="number" value={rPort} onChange={e=>setRPort(e.target.value)} placeholder="e.g. 5433"
                className="w-full h-10 rounded-xl border-2 border-slate-200 px-4 text-[13px] outline-none focus:border-indigo-400 bg-white"/>
            </div>
            <div>
              <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-1.5">
                WAL Archive Path <span className="font-normal text-slate-400 normal-case">(on server, optional)</span>
              </label>
              <input value={walPath} onChange={e=>setWalPath(e.target.value)} placeholder="/mnt/wal_archive"
                className="w-full h-10 rounded-xl border-2 border-slate-200 px-4 text-[12px] font-mono outline-none focus:border-indigo-400 bg-white"/>
            </div>
          </div>
        </div>
        <div className="px-5 pb-5 pt-3 border-t border-slate-100">
          <button onClick={doPITR} disabled={saving||!baseJobId||!targetDt}
            className="flex items-center gap-2 h-10 px-6 rounded-xl bg-gradient-to-r from-indigo-500 to-violet-600 text-white text-[13px] font-bold disabled:opacity-60 shadow-md hover:shadow-lg transition-all">
            {saving ? <Loader2 size={14} className="animate-spin"/> : <Clock size={14}/>}
            {saving ? 'Starting PITR…' : 'Start Point-in-Time Recovery'}
          </button>
        </div>
      </div>

      {result && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-2xl p-4 space-y-2">
          <p className="font-bold text-emerald-800 text-[13px] flex items-center gap-2"><CheckCircle2 size={14}/> PITR job #{result.id} started</p>
          <p className="text-[12px] text-emerald-700 font-mono bg-emerald-100 p-2 rounded-lg whitespace-pre-wrap">{result.notes}</p>
          <p className="text-[11px] text-emerald-600">Watch progress in <strong>My Backups</strong> tab (job type: pitr).</p>
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════════
   WAL MONITOR TAB
══════════════════════════════════════════════════════════════════════════════ */
function WALTab({ connId, showToast }) {
  const [showSegs, setShowSegs] = useState(false);

  const { data: ws, isLoading: wsLoading, refetch: refetchWs } = useQuery({
    queryKey: ['pgWalStatus', connId],
    queryFn:  () => api.walStatus(connId),
    refetchInterval: 15000,
  });

  const { data: segs, isLoading: segsLoading, refetch: refetchSegs } = useQuery({
    queryKey: ['pgWalSegs', connId],
    queryFn:  () => api.walSegments(connId),
    enabled:  showSegs,
    staleTime: 30000,
  });

  const w  = ws?.wal       || {};
  const ar = ws?.archiver  || {};
  const cp = ws?.checkpoints || {};
  const rp = ws?.replication || [];
  const sl = ws?.slots     || [];

  if (!ws?.status && wsLoading) return (
    <div className="flex items-center justify-center py-32"><Loader2 size={32} className="animate-spin text-indigo-300"/></div>
  );

  const walColor = w.wal_level==='minimal'?'text-amber-600 bg-amber-50 border-amber-200':
                   w.wal_level?'text-emerald-600 bg-emerald-50 border-emerald-200':'text-slate-500 bg-slate-50 border-slate-200';

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between bg-white rounded-2xl border border-slate-200 shadow-sm px-5 py-4">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center">
            <Radio size={17} className="text-white"/>
          </div>
          <div>
            <h2 className="font-black text-slate-900 text-[15px]">WAL Monitor</h2>
            <p className="text-[11px] text-slate-400">Real-time WAL, archiver, checkpoints, replication · auto-refresh 15s</p>
          </div>
        </div>
        <button onClick={() => refetchWs()} className="w-8 h-8 rounded-xl border border-slate-200 flex items-center justify-center hover:bg-slate-50 text-slate-500">
          <RefreshCw size={13} className={wsLoading?'animate-spin':''}/>
        </button>
      </div>

      {ws?.status === 'error' && (
        <div className="bg-red-50 border border-red-200 rounded-2xl p-4 flex items-start gap-3">
          <XCircle size={15} className="text-red-500 mt-0.5"/>
          <p className="text-[13px] text-red-700 font-mono">{ws.error}</p>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* WAL configuration */}
        <Section title="WAL Configuration" icon={Radio}>
          <div className="grid grid-cols-2 gap-3">
            <KV label="WAL Level"        value={w.wal_level}     badge={walColor}/>
            <KV label="Compression"      value={w.wal_compression||'off'} badge={w.wal_compression==='on'?'bg-emerald-100 text-emerald-700':'bg-slate-100 text-slate-500'}/>
            <KV label="Full Page Writes" value={w.full_page_writes} badge={w.full_page_writes==='on'?'bg-emerald-100 text-emerald-700':'bg-amber-100 text-amber-700'}/>
            <KV label="Sync Commit"      value={w.synchronous_commit} badge="bg-indigo-100 text-indigo-700"/>
            <KV label="WAL Buffers"      value={w.wal_buffers}/>
            <KV label="Min WAL Size"     value={w.min_wal_size}/>
            <KV label="Max WAL Size"     value={w.max_wal_size}/>
            <KV label="Current WAL"      value={w.current_wal_file} mono/>
            <KV label="Current LSN"      value={w.current_lsn}  mono/>
            <KV label="Insert LSN"       value={w.insert_lsn}   mono/>
          </div>
        </Section>

        {/* Archiver */}
        <Section title="WAL Archiver" icon={Archive}>
          <div className="grid grid-cols-2 gap-3">
            <KV label="Archive Mode"     value={w.archive_mode||'off'} badge={(w.archive_mode==='on'||w.archive_mode==='always')?'bg-indigo-100 text-indigo-700':'bg-slate-100 text-slate-500'}/>
            <KV label="Archive Timeout" value={w.archive_timeout}/>
            <KV label="Archived Files"  value={ar.archived_count}/>
            <KV label="Failed"          value={ar.failed_count} badge={Number(ar.failed_count)>0?'bg-red-100 text-red-700':'bg-emerald-100 text-emerald-700'}/>
            <KV label="Last Archived WAL"  value={ar.last_archived_wal} mono/>
            <KV label="Last Archived Time" value={ar.last_archived_time ? new Date(ar.last_archived_time).toLocaleString() : '—'}/>
            {Number(ar.failed_count)>0 && <>
              <KV label="Last Failed WAL"  value={ar.last_failed_wal} mono/>
              <KV label="Last Failed Time" value={ar.last_failed_time ? new Date(ar.last_failed_time).toLocaleString() : '—'}/>
            </>}
          </div>
          {w.archive_command && (
            <div className="mt-3 p-3 rounded-xl bg-slate-900 flex items-center gap-2">
              <code className="text-[11px] text-green-400 flex-1 font-mono break-all">{w.archive_command}</code>
              <CopyBtn text={w.archive_command}/>
            </div>
          )}
        </Section>

        {/* Checkpoint stats */}
        <Section title="Checkpoint Activity" icon={Activity}>
          <div className="grid grid-cols-2 gap-3">
            <KV label="Timed Checkpoints"    value={cp.checkpoints_timed}/>
            <KV label="Requested Checkpoints" value={cp.checkpoints_req}/>
            <KV label="Write Time (ms)"       value={cp.checkpoint_write_time}/>
            <KV label="Sync Time (ms)"        value={cp.checkpoint_sync_time}/>
            <KV label="Timeout"               value={w.checkpoint_timeout}/>
            <KV label="Completion Target"     value={w.checkpoint_completion_target}/>
          </div>
        </Section>

        {/* Replication */}
        <Section title={`Streaming Replication (${rp.length} standbys)`} icon={GitBranch}>
          {rp.length === 0 ? (
            <p className="text-[12px] text-slate-400 text-center py-4">No standby servers connected.</p>
          ) : (
            <div className="space-y-3">
              {rp.map((r,i) => (
                <div key={i} className="p-3 rounded-xl bg-slate-50 border border-slate-100 grid grid-cols-2 gap-2">
                  <KV label="Client"    value={r.client_addr||'socket'}/>
                  <KV label="App"       value={r.application_name}/>
                  <KV label="State"     value={r.state} badge="bg-indigo-100 text-indigo-700"/>
                  <KV label="Sync"      value={r.sync_state} badge={r.sync_state==='sync'?'bg-emerald-100 text-emerald-700':'bg-slate-100 text-slate-500'}/>
                  <KV label="Sent LSN"  value={r.sent_lsn}   mono/>
                  <KV label="Replay LSN"value={r.replay_lsn} mono/>
                </div>
              ))}
            </div>
          )}
        </Section>
      </div>

      {/* Replication Slots */}
      {sl.length > 0 && (
        <Section title={`Replication Slots (${sl.length})`} icon={Layers}>
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-slate-200">
                  {['Slot Name','Type','Active','Restart LSN','Retained'].map(h => (
                    <th key={h} className="text-left py-2 px-3 font-bold text-slate-500 text-[10px] uppercase tracking-wide">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sl.map((s,i) => (
                  <tr key={i} className="border-t border-slate-50 hover:bg-slate-50/50">
                    <td className="py-2 px-3 font-mono font-bold text-slate-700">{s.slot_name}</td>
                    <td className="py-2 px-3"><span className="px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 font-bold">{s.slot_type}</span></td>
                    <td className="py-2 px-3"><span className={`px-2 py-0.5 rounded-full font-bold ${s.active?'bg-emerald-100 text-emerald-700':'bg-slate-100 text-slate-500'}`}>{s.active?'Yes':'No'}</span></td>
                    <td className="py-2 px-3 font-mono text-slate-500">{s.restart_lsn||'—'}</td>
                    <td className="py-2 px-3 text-slate-500">{s.retained_bytes != null ? _fmt(s.retained_bytes) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {/* WAL Segments */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="bg-gradient-to-r from-slate-50 to-indigo-50/30 border-b border-slate-100 px-5 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Layers size={14} className="text-indigo-500"/>
            <h3 className="font-black text-slate-700 text-[13px] uppercase tracking-wide">WAL Segments on Server</h3>
          </div>
          <button onClick={() => { setShowSegs(true); refetchSegs(); }}
            className="flex items-center gap-2 h-8 px-4 rounded-xl border border-slate-200 bg-white text-slate-600 text-[12px] font-bold hover:bg-slate-50 transition-all">
            {segsLoading ? <Loader2 size={12} className="animate-spin"/> : <Eye size={12}/>}
            {showSegs ? 'Refresh' : 'List Segments'}
          </button>
        </div>
        {showSegs && (
          <div className="p-5">
            {segsLoading ? <div className="flex items-center gap-2 text-slate-400"><Loader2 size={14} className="animate-spin"/> Loading WAL segments…</div> : !segs ? null : (
              <>
                <p className="text-[12px] text-slate-500 mb-3 font-mono">
                  <span className="font-bold text-slate-700">{segs.count}</span> WAL segments in <code className="bg-slate-100 px-1 rounded">{segs.wal_dir}</code>
                </p>
                <div className="max-h-64 overflow-y-auto space-y-1">
                  {(segs.segments||[]).map((s,i) => (
                    <div key={i} className="flex items-center gap-3 px-3 py-1.5 rounded-lg hover:bg-slate-50 transition-colors">
                      <span className="font-mono text-[11px] text-slate-700 flex-1">{s.name}</span>
                      <span className="text-[10px] text-slate-400 font-mono">{s.size}</span>
                      <CopyBtn text={s.name}/>
                    </div>
                  ))}
                  {(segs.segments||[]).length === 0 && (
                    <p className="text-[12px] text-slate-400 text-center py-4">No WAL segments found — check SSH access and pg_wal path.</p>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
