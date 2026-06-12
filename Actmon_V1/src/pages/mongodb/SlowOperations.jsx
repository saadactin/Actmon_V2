import React, { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft, RefreshCw, Clock, AlertTriangle, CheckCircle2,
  ChevronDown, ChevronRight, Search, Activity, Zap, Database,
  BarChart2, Filter,
} from 'lucide-react';
import client from '../../api/client';

const fetchSlowOps = (id) =>
  client.get(`/connections/mongodb/${id}/mongo-slow-operations`).then(r => r.data);

/* ── helpers ── */
function fmtNum(n) {
  const v = Number(n) || 0;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(v);
}

function opColor(secs) {
  const s = Number(secs) || 0;
  if (s >= 30) return 'text-red-600';
  if (s >= 5)  return 'text-orange-500';
  if (s >= 1)  return 'text-yellow-600';
  return 'text-slate-600';
}

function opBg(secs) {
  const s = Number(secs) || 0;
  if (s >= 30) return 'bg-red-50';
  if (s >= 5)  return 'bg-orange-50/50';
  if (s >= 1)  return 'bg-yellow-50/40';
  return '';
}

function millisColor(ms) {
  const m = Number(ms) || 0;
  if (m >= 30000) return 'text-red-600';
  if (m >= 5000)  return 'text-orange-500';
  if (m >= 1000)  return 'text-yellow-600';
  return 'text-slate-600';
}

/* ── sub-components ── */
function KpiCard({ icon: Icon, label, value, accent = 'slate' }) {
  const borders = {
    emerald: 'border-l-emerald-500',
    green:   'border-l-green-500',
    red:     'border-l-red-500',
    orange:  'border-l-orange-500',
    blue:    'border-l-blue-500',
    slate:   'border-l-slate-300',
    yellow:  'border-l-yellow-400',
  };
  return (
    <div className={`bg-white rounded-xl border border-slate-200 border-l-4 ${borders[accent] || borders.slate} p-4`}>
      <div className="flex justify-between items-start">
        <div>
          <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wide">{label}</p>
          <p className="text-xl font-black text-slate-800 mt-1">{value ?? '—'}</p>
        </div>
        <Icon size={18} className="text-slate-300 mt-0.5" />
      </div>
    </div>
  );
}

function OpTypeBadge({ op }) {
  const map = {
    query:    'bg-blue-100 text-blue-700',
    update:   'bg-yellow-100 text-yellow-700',
    insert:   'bg-green-100 text-green-700',
    remove:   'bg-red-100 text-red-700',
    delete:   'bg-red-100 text-red-700',
    getmore:  'bg-purple-100 text-purple-700',
    command:  'bg-slate-100 text-slate-600',
  };
  const cls = map[(op || '').toLowerCase()] || 'bg-slate-100 text-slate-600';
  return (
    <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${cls}`}>
      {op || '—'}
    </span>
  );
}

/* ── Active Slow Op expanded detail ── */
function ActiveOpDetail({ op }) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {[
          { label: 'Op ID',       value: op.opid ?? '—' },
          { label: 'Type',        value: op.type || op.op || '—' },
          { label: 'Namespace',   value: op.ns || '—' },
          { label: 'Secs Running', value: `${op.secs_running ?? 0}s` },
          { label: 'Client',      value: op.client || '—' },
          { label: 'Description', value: op.desc || '—' },
        ].map(({ label, value }) => (
          <div key={label} className="bg-white border border-slate-200 rounded-xl p-2.5">
            <p className="text-[9px] font-bold text-slate-400 uppercase tracking-wide">{label}</p>
            <p className="font-semibold text-slate-800 text-xs mt-0.5 break-all">{String(value)}</p>
          </div>
        ))}
      </div>
      {(op.query || op.filter || op.command) && (
        <div>
          <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1.5">Query / Filter</p>
          <pre className="bg-white border border-slate-200 rounded-xl p-3 text-xs font-mono text-slate-700 overflow-auto max-h-48 whitespace-pre-wrap break-all">
            {JSON.stringify(op.query || op.filter || op.command || {}, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

/* ── Profile Op expanded detail ── */
function ProfileOpDetail({ op }) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {[
          { label: 'Timestamp',      value: op.ts || '—' },
          { label: 'Namespace',      value: op.ns || '—' },
          { label: 'Operation',      value: op.op || '—' },
          { label: 'Duration (ms)',  value: op.millis ?? '—' },
          { label: 'nReturned',      value: op.nreturned ?? op.nReturned ?? '—' },
          { label: 'Keys Examined',  value: fmtNum(op.keysExamined ?? op.keys_examined ?? 0) },
          { label: 'Docs Examined',  value: fmtNum(op.docsExamined ?? op.docs_examined ?? 0) },
          { label: 'Plan Summary',   value: op.planSummary || op.plan_summary || '—' },
        ].map(({ label, value }) => (
          <div key={label} className="bg-white border border-slate-200 rounded-xl p-2.5">
            <p className="text-[9px] font-bold text-slate-400 uppercase tracking-wide">{label}</p>
            <p className="font-semibold text-slate-800 text-xs mt-0.5 break-all">{String(value)}</p>
          </div>
        ))}
      </div>
      {(op.query || op.filter || op.command || op.originatingCommand) && (
        <div>
          <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1.5">Command / Filter</p>
          <pre className="bg-white border border-slate-200 rounded-xl p-3 text-xs font-mono text-slate-700 overflow-auto max-h-48 whitespace-pre-wrap break-all">
            {JSON.stringify(op.query || op.filter || op.command || op.originatingCommand || {}, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

/* ── Main page ── */
export default function SlowOperations() {
  const { id } = useParams();
  const [expandedActive,  setExpandedActive]  = useState(null);
  const [expandedProfile, setExpandedProfile] = useState(null);
  const [searchActive,    setSearchActive]    = useState('');
  const [searchProfile,   setSearchProfile]   = useState('');
  const [opTypeFilter,    setOpTypeFilter]    = useState('');

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['mongoSlowOps', id],
    queryFn:  () => fetchSlowOps(id),
    retry: false,
    refetchInterval: 30000,
  });

  /* ── loading ── */
  if (isLoading) return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50">
      <div className="text-center">
        <div className="w-10 h-10 border-4 border-emerald-200 border-t-emerald-600 rounded-full animate-spin mx-auto mb-3" />
        <p className="text-slate-500 text-sm">Loading slow operations...</p>
      </div>
    </div>
  );

  /* ── error ── */
  if (error) return (
    <div className="p-6">
      <div className="bg-red-50 border border-red-200 rounded-2xl p-6 max-w-lg">
        <AlertTriangle className="text-red-500 mb-2" size={20} />
        <p className="font-bold text-red-700">Failed to load slow operations</p>
        <p className="text-sm text-red-600 mt-1">{error.message}</p>
        <button onClick={() => refetch()} className="mt-3 px-4 py-2 bg-red-600 text-white rounded-xl text-sm font-bold">Retry</button>
      </div>
    </div>
  );

  const currentOps  = data?.current_ops  || data?.active_ops  || [];
  const profileOps  = data?.profile_ops  || data?.profile      || [];

  /* KPI derivations */
  const maxDuration = currentOps.length
    ? Math.max(...currentOps.map(o => Number(o.secs_running) || 0))
    : 0;
  const noIndexNs = new Set([
    ...currentOps.filter(o => !o.ns || o.ns === '').map(o => o.ns),
    ...profileOps.filter(p => (p.keysExamined ?? p.keys_examined ?? 0) === 0 && (p.docsExamined ?? p.docs_examined ?? 0) > 0).map(p => p.ns),
  ]).size;

  /* unique op types for filter */
  const opTypes = [...new Set(currentOps.map(o => o.op || o.type).filter(Boolean))];

  /* filtered lists */
  const filteredActive = currentOps.filter(op => {
    const okSearch = !searchActive || (op.ns || '').toLowerCase().includes(searchActive.toLowerCase()) ||
      (op.client || '').toLowerCase().includes(searchActive.toLowerCase());
    const okType   = !opTypeFilter || (op.op || op.type) === opTypeFilter;
    return okSearch && okType;
  });

  const filteredProfile = profileOps.filter(op =>
    !searchProfile ||
    (op.ns  || '').toLowerCase().includes(searchProfile.toLowerCase()) ||
    (op.op  || '').toLowerCase().includes(searchProfile.toLowerCase())
  );

  return (
    <div className="min-h-screen bg-slate-50">

      {/* ── Header ── */}
      <div className="bg-gradient-to-r from-slate-900 via-green-900 to-emerald-800 text-white px-6 py-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-4">
            <Link to={`/mongodb-dashboard/${id}`}
              className="w-9 h-9 rounded-xl bg-white/10 hover:bg-white/20 border border-white/20 flex items-center justify-center">
              <ArrowLeft size={16} />
            </Link>
            <div>
              <h1 className="text-xl font-black tracking-tight flex items-center gap-2">
                <Clock size={18} className="text-emerald-300" /> Slow Operations
              </h1>
              <p className="text-emerald-300 text-xs mt-0.5">
                Active operations exceeding threshold + system.profile history
              </p>
            </div>
          </div>
          <button onClick={() => refetch()}
            className="flex items-center gap-2 px-4 py-1.5 bg-white/10 hover:bg-white/20 border border-white/20 rounded-lg text-sm font-semibold">
            <RefreshCw size={13} className={isFetching ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>
      </div>

      <div className="p-5 space-y-5">

        {/* ── KPI strip ── */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <KpiCard icon={Activity}  label="Active Slow Ops"   value={currentOps.length}   accent={currentOps.length > 0 ? 'red' : 'emerald'} />
          <KpiCard icon={Clock}     label="Max Duration (s)"  value={`${maxDuration}s`}   accent={maxDuration >= 30 ? 'red' : maxDuration >= 5 ? 'orange' : 'slate'} />
          <KpiCard icon={BarChart2} label="Profile Ops"       value={profileOps.length}   accent="blue" />
          <KpiCard icon={Database}  label="Without Index Hit" value={noIndexNs}            accent={noIndexNs > 0 ? 'yellow' : 'emerald'} />
        </div>

        {/* ── Alert banner ── */}
        {currentOps.length > 0 && (
          <div className="bg-red-50 border border-red-200 rounded-2xl p-3 flex items-center gap-3">
            <AlertTriangle className="text-red-500 flex-shrink-0" size={16} />
            <span className="text-red-700 text-sm font-semibold">
              {currentOps.length} active slow operation{currentOps.length !== 1 ? 's' : ''} running right now
            </span>
            <span className="ml-auto text-xs text-red-500 font-mono">Max: {maxDuration}s</span>
          </div>
        )}

        {/* ══ SECTION 1: Active Slow Ops ══ */}
        <div className="bg-white rounded-2xl border border-slate-200">
          <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
            <div className="flex items-center gap-2">
              <Zap size={16} className="text-yellow-500" />
              <h2 className="font-bold text-slate-800">Active Slow Operations</h2>
              <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                currentOps.length > 0 ? 'bg-red-100 text-red-700' : 'bg-emerald-100 text-emerald-700'
              }`}>{currentOps.length}</span>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {/* Op type filter */}
              {opTypes.length > 0 && (
                <div className="flex gap-1">
                  <button onClick={() => setOpTypeFilter('')}
                    className={`px-2 h-6 rounded-md text-[10px] font-bold ${!opTypeFilter ? 'bg-slate-900 text-white' : 'border border-slate-200 text-slate-500 hover:bg-slate-50'}`}>
                    All
                  </button>
                  {opTypes.map(t => (
                    <button key={t} onClick={() => setOpTypeFilter(opTypeFilter === t ? '' : t)}
                      className={`px-2 h-6 rounded-md text-[10px] font-bold ${opTypeFilter === t ? 'bg-slate-900 text-white' : 'border border-slate-200 text-slate-500 hover:bg-slate-50'}`}>
                      {t}
                    </button>
                  ))}
                </div>
              )}
              <div className="relative">
                <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
                <input value={searchActive} onChange={e => setSearchActive(e.target.value)}
                  placeholder="Filter namespace / client..."
                  className="pl-7 pr-3 h-8 text-xs rounded-xl border border-slate-200 outline-none focus:border-emerald-400 w-48" />
              </div>
            </div>
          </div>

          {filteredActive.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-14 text-center">
              <CheckCircle2 size={32} className="text-emerald-400 mb-3" />
              <p className="font-semibold text-slate-600">
                {currentOps.length > 0 ? 'No operations match the current filter' : 'No active slow operations'}
              </p>
              <p className="text-xs text-slate-400 mt-1">MongoDB is running smoothly</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 border-b border-slate-100">
                  <tr>
                    <th className="w-8 px-3 py-2.5" />
                    <th className="px-3 py-2.5 text-left text-[11px] font-bold text-slate-400 whitespace-nowrap">Op ID</th>
                    <th className="px-3 py-2.5 text-left text-[11px] font-bold text-slate-400">Type</th>
                    <th className="px-3 py-2.5 text-left text-[11px] font-bold text-slate-400">Namespace</th>
                    <th className="px-3 py-2.5 text-right text-[11px] font-bold text-slate-400 whitespace-nowrap">Secs Running</th>
                    <th className="px-3 py-2.5 text-left text-[11px] font-bold text-slate-400">Op</th>
                    <th className="px-3 py-2.5 text-left text-[11px] font-bold text-slate-400">Client</th>
                    <th className="px-3 py-2.5 text-left text-[11px] font-bold text-slate-400">Description</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredActive.map((op, i) => {
                    const key    = `active-${i}-${op.opid}`;
                    const isOpen = expandedActive === key;
                    return (
                      <React.Fragment key={key}>
                        <tr className={`border-t border-slate-100 cursor-pointer transition-colors ${opBg(op.secs_running)} ${isOpen ? 'bg-emerald-50' : 'hover:bg-slate-50'}`}
                          onClick={() => setExpandedActive(isOpen ? null : key)}>
                          <td className="px-3 py-2.5 text-slate-400">
                            {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                          </td>
                          <td className="px-3 py-2.5 font-mono text-slate-500">{op.opid ?? '—'}</td>
                          <td className="px-3 py-2.5"><OpTypeBadge op={op.type || op.op} /></td>
                          <td className="px-3 py-2.5 font-mono text-slate-700 max-w-[200px] truncate" title={op.ns}>{op.ns || '—'}</td>
                          <td className={`px-3 py-2.5 text-right font-black ${opColor(op.secs_running)}`}>
                            {op.secs_running ?? 0}s
                          </td>
                          <td className="px-3 py-2.5"><OpTypeBadge op={op.op} /></td>
                          <td className="px-3 py-2.5 text-slate-400 whitespace-nowrap">{op.client || '—'}</td>
                          <td className="px-3 py-2.5 font-mono text-slate-500 max-w-[180px] truncate">{op.desc || '—'}</td>
                        </tr>
                        {isOpen && (
                          <tr className="bg-emerald-50 border-t border-emerald-100">
                            <td colSpan={8} className="px-5 py-4">
                              <ActiveOpDetail op={op} />
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

        {/* ══ SECTION 2: Profile History ══ */}
        <div className="bg-white rounded-2xl border border-slate-200">
          <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
            <div className="flex items-center gap-2">
              <BarChart2 size={16} className="text-blue-500" />
              <h2 className="font-bold text-slate-800">Profile History</h2>
              <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-blue-100 text-blue-700">
                {profileOps.length}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <div className="relative">
                <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
                <input value={searchProfile} onChange={e => setSearchProfile(e.target.value)}
                  placeholder="Filter namespace / op..."
                  className="pl-7 pr-3 h-8 text-xs rounded-xl border border-slate-200 outline-none focus:border-emerald-400 w-48" />
              </div>
              <span className="text-xs text-slate-400">
                {filteredProfile.length} / {profileOps.length}
              </span>
            </div>
          </div>

          {profileOps.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-14 text-center">
              <Filter size={28} className="text-slate-200 mb-3" />
              <p className="font-semibold text-slate-500">No profile history available</p>
              <p className="text-xs text-slate-400 mt-1 max-w-sm">
                Enable the system profiler with db.setProfilingLevel(1, {"{ slowms: 100 }"}) to capture slow operations.
              </p>
            </div>
          ) : filteredProfile.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 text-center">
              <p className="text-slate-400 text-sm">No profile entries match the current filter</p>
            </div>
          ) : (
            <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-white border-b border-slate-100 z-10">
                  <tr>
                    <th className="w-8 px-3 py-2.5" />
                    <th className="px-3 py-2.5 text-left text-[11px] font-bold text-slate-400 whitespace-nowrap">Timestamp</th>
                    <th className="px-3 py-2.5 text-left text-[11px] font-bold text-slate-400">Namespace</th>
                    <th className="px-3 py-2.5 text-left text-[11px] font-bold text-slate-400">Op</th>
                    <th className="px-3 py-2.5 text-right text-[11px] font-bold text-slate-400 whitespace-nowrap">Millis</th>
                    <th className="px-3 py-2.5 text-right text-[11px] font-bold text-slate-400 whitespace-nowrap">nReturned</th>
                    <th className="px-3 py-2.5 text-right text-[11px] font-bold text-slate-400 whitespace-nowrap">Keys Examined</th>
                    <th className="px-3 py-2.5 text-right text-[11px] font-bold text-slate-400 whitespace-nowrap">Docs Examined</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredProfile.map((op, i) => {
                    const key    = `profile-${i}-${op.ts}`;
                    const isOpen = expandedProfile === key;
                    const millis = op.millis ?? 0;
                    const keys   = op.keysExamined ?? op.keys_examined ?? 0;
                    const docs   = op.docsExamined ?? op.docs_examined ?? 0;
                    const ret    = op.nreturned ?? op.nReturned ?? 0;
                    return (
                      <React.Fragment key={key}>
                        <tr className={`border-t border-slate-100 cursor-pointer transition-colors ${isOpen ? 'bg-blue-50' : 'hover:bg-slate-50'}`}
                          onClick={() => setExpandedProfile(isOpen ? null : key)}>
                          <td className="px-3 py-2.5 text-slate-400">
                            {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                          </td>
                          <td className="px-3 py-2.5 font-mono text-slate-400 whitespace-nowrap">
                            {op.ts || '—'}
                          </td>
                          <td className="px-3 py-2.5 font-mono text-slate-700 max-w-[200px] truncate" title={op.ns}>
                            {op.ns || '—'}
                          </td>
                          <td className="px-3 py-2.5"><OpTypeBadge op={op.op} /></td>
                          <td className={`px-3 py-2.5 text-right font-black ${millisColor(millis)}`}>
                            {fmtNum(millis)}ms
                          </td>
                          <td className="px-3 py-2.5 text-right font-mono text-slate-600">{fmtNum(ret)}</td>
                          <td className={`px-3 py-2.5 text-right font-mono ${keys === 0 ? 'text-orange-500 font-bold' : 'text-slate-600'}`}>
                            {fmtNum(keys)}
                          </td>
                          <td className={`px-3 py-2.5 text-right font-mono ${docs > 10000 ? 'text-red-600 font-bold' : 'text-slate-600'}`}>
                            {fmtNum(docs)}
                          </td>
                        </tr>
                        {isOpen && (
                          <tr className="bg-blue-50 border-t border-blue-100">
                            <td colSpan={8} className="px-5 py-4">
                              <ProfileOpDetail op={op} />
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
    </div>
  );
}
