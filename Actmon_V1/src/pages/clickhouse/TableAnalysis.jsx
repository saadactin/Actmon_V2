import React, { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft, RefreshCw, Layers, GitMerge, Table,
  Search, AlertTriangle, CheckCircle2, Database,
  HardDrive, BarChart2, TrendingUp,
} from 'lucide-react';
import client from '../../api/client';

const fetchTableAnalysis = (id) =>
  client.get(`/connections/clickhouse/${id}/ch-table-analysis`).then(r => r.data);

/* ── helpers ── */
function fmtBytes(bytes) {
  const b = Number(bytes) || 0;
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

function compressionRatio(compressed, uncompressed) {
  const c = Number(compressed)   || 0;
  const u = Number(uncompressed) || 0;
  if (!c || !u || u === 0) return '—';
  return `${(u / c).toFixed(2)}x`;
}

const TABS = [
  { id: 'parts',       label: 'Parts',        icon: Layers   },
  { id: 'merges',      label: 'Merges',       icon: GitMerge },
  { id: 'table_stats', label: 'Table Stats',  icon: Table    },
];

export default function TableAnalysis() {
  const { id } = useParams();
  const [activeTab, setActiveTab] = useState('parts');
  const [search, setSearch]       = useState('');
  const [dbFilter, setDbFilter]   = useState('');

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['chTableAnalysis', id],
    queryFn: () => fetchTableAnalysis(id),
    retry: false,
    refetchInterval: 30000,
  });

  if (isLoading) return <Spinner />;
  if (error)     return <Err msg={error.message} onRetry={refetch} />;

  const parts      = data?.parts        || data?.table_parts        || [];
  const merges     = data?.merges       || data?.active_merges      || [];
  const tableStats = data?.table_stats  || data?.tables             || [];

  /* KPIs from parts */
  const totalParts      = parts.length;
  const totalRows       = parts.reduce((a, p) => a + (Number(p.rows) || 0), 0);
  const totalDiskBytes  = parts.reduce((a, p) => a + (Number(p.bytes_on_disk) || 0), 0);
  const totalUncompressed = parts.reduce((a, p) => a + (Number(p.data_uncompressed_bytes) || 0), 0);

  /* Unique databases for filter */
  const allDbs = [...new Set([
    ...parts.map(p => p.database),
    ...merges.map(m => m.database),
    ...tableStats.map(t => t.database),
  ].filter(Boolean))];

  const q = search.toLowerCase();

  const filteredParts = parts.filter(p =>
    (!dbFilter || p.database === dbFilter) &&
    (!q || (p.table || '').toLowerCase().includes(q) || (p.database || '').toLowerCase().includes(q) || (p.partition || '').toLowerCase().includes(q))
  );

  const filteredMerges = merges.filter(m =>
    (!dbFilter || m.database === dbFilter) &&
    (!q || (m.table || '').toLowerCase().includes(q) || (m.database || '').toLowerCase().includes(q))
  );

  const filteredStats = tableStats.filter(t =>
    (!dbFilter || t.database === dbFilter) &&
    (!q || (t.name || '').toLowerCase().includes(q) || (t.database || '').toLowerCase().includes(q))
  );

  return (
    <div className="min-h-screen bg-slate-50">

      {/* Header */}
      <div className="bg-gradient-to-r from-slate-900 via-indigo-950 to-violet-900 text-white px-6 py-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-4">
            <Link to={`/clickhouse-dashboard/${id}`}
              className="w-9 h-9 rounded-xl bg-white/10 hover:bg-white/20 border border-white/20 flex items-center justify-center">
              <ArrowLeft size={16} />
            </Link>
            <div>
              <h1 className="text-xl font-black tracking-tight flex items-center gap-2">
                <Layers size={18} className="text-violet-300" /> ClickHouse Table Analysis
              </h1>
              <p className="text-violet-300 text-xs mt-0.5">
                Parts · Active Merges · Table Statistics
              </p>
            </div>
          </div>
          <button onClick={() => refetch()}
            className="flex items-center gap-2 px-4 py-1.5 bg-white/10 hover:bg-white/20 border border-white/20 rounded-lg text-sm font-semibold">
            <RefreshCw size={13} /> Refresh
          </button>
        </div>
      </div>

      <div className="p-5 space-y-4">

        {/* KPI strip */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <KpiCard icon={<Layers size={18} className="text-violet-400" />}
            label="Total Parts" value={fmtNum(totalParts)}
            accent={totalParts > 2000 ? 'red' : totalParts > 500 ? 'yellow' : 'violet'} />
          <KpiCard icon={<BarChart2 size={18} className="text-slate-400" />}
            label="Total Rows" value={fmtNum(totalRows)} />
          <KpiCard icon={<HardDrive size={18} className="text-indigo-400" />}
            label="Disk Usage" value={fmtBytes(totalDiskBytes)} />
          <KpiCard icon={<TrendingUp size={18} className="text-green-400" />}
            label="Compression Ratio" value={compressionRatio(totalDiskBytes, totalUncompressed)}
            accent="green" />
        </div>

        {/* Tab bar + filters */}
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          <div className="flex flex-wrap items-center gap-2 p-3 border-b border-slate-100">
            {/* Tabs */}
            <div className="flex gap-1">
              {TABS.map(t => {
                const Icon  = t.icon;
                const count = t.id === 'parts' ? parts.length : t.id === 'merges' ? merges.length : tableStats.length;
                return (
                  <button key={t.id} onClick={() => setActiveTab(t.id)}
                    className={`flex items-center gap-1.5 px-3 h-8 rounded-lg text-xs font-bold transition-all ${
                      activeTab === t.id ? 'bg-slate-900 text-white' : 'border border-slate-200 text-slate-600 hover:bg-slate-50'
                    }`}>
                    <Icon size={12} />
                    {t.label}
                    <span className={`px-1.5 py-0.5 rounded-full text-[9px] font-black ${
                      activeTab === t.id ? 'bg-white/20 text-white' : 'bg-slate-100 text-slate-500'
                    }`}>
                      {count}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Database filter */}
            {allDbs.length > 0 && (
              <select value={dbFilter} onChange={e => setDbFilter(e.target.value)}
                className="h-8 px-3 rounded-xl border border-slate-200 text-xs outline-none bg-white ml-1">
                <option value="">All Databases</option>
                {allDbs.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            )}

            {/* Search */}
            <div className="relative ml-auto">
              <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
              <input value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Search…"
                className="pl-7 pr-3 h-8 text-xs rounded-xl border border-slate-200 outline-none focus:border-violet-500 w-44" />
            </div>
          </div>

          {/* ── Parts tab ── */}
          {activeTab === 'parts' && (
            <PartsTab parts={filteredParts} total={parts.length} />
          )}

          {/* ── Merges tab ── */}
          {activeTab === 'merges' && (
            <MergesTab merges={filteredMerges} total={merges.length} />
          )}

          {/* ── Table Stats tab ── */}
          {activeTab === 'table_stats' && (
            <TableStatsTab stats={filteredStats} total={tableStats.length} />
          )}
        </div>

      </div>
    </div>
  );
}

/* ── Parts Tab ── */
function PartsTab({ parts, total }) {
  if (parts.length === 0) {
    return (
      <Empty icon={total === 0 ? CheckCircle2 : Search}
        msg={total === 0 ? 'No part data available.' : 'No parts match the current filters.'}
        good={total === 0} />
    );
  }

  /* sort by disk size descending */
  const sorted = [...parts].sort((a, b) => (Number(b.bytes_on_disk) || 0) - (Number(a.bytes_on_disk) || 0));
  const maxDisk = Math.max(...sorted.map(p => Number(p.bytes_on_disk) || 0), 1);

  return (
    <div className="overflow-auto max-h-[580px]">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-white border-b border-slate-200 z-10">
          <tr>
            <th className="px-4 py-3 text-left font-bold text-[11px] text-slate-400 whitespace-nowrap">Database</th>
            <th className="px-3 py-3 text-left font-bold text-[11px] text-slate-400 whitespace-nowrap">Table</th>
            <th className="px-3 py-3 text-left font-bold text-[11px] text-slate-400 whitespace-nowrap">Partition</th>
            <th className="px-3 py-3 text-right font-bold text-[11px] text-slate-400 whitespace-nowrap">Rows</th>
            <th className="px-3 py-3 text-right font-bold text-[11px] text-slate-400 whitespace-nowrap">Disk Size</th>
            <th className="px-3 py-3 text-right font-bold text-[11px] text-slate-400 whitespace-nowrap">Compressed</th>
            <th className="px-3 py-3 text-right font-bold text-[11px] text-slate-400 whitespace-nowrap">Uncompressed</th>
            <th className="px-3 py-3 text-right font-bold text-[11px] text-slate-400 whitespace-nowrap">Ratio</th>
            <th className="px-3 py-3 text-left font-bold text-[11px] text-slate-400 whitespace-nowrap">Active</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((p, i) => {
            const diskPct = Math.round(((Number(p.bytes_on_disk) || 0) / maxDisk) * 100);
            const ratio   = compressionRatio(p.data_compressed_bytes || p.bytes_on_disk, p.data_uncompressed_bytes);
            return (
              <tr key={i} className="border-t border-slate-100 hover:bg-violet-50 transition-colors">
                <td className="px-4 py-2.5 text-slate-400">{p.database || '—'}</td>
                <td className="px-3 py-2.5 font-semibold text-violet-700">{p.table || '—'}</td>
                <td className="px-3 py-2.5 font-mono text-slate-600">{p.partition || p.partition_id || '—'}</td>
                <td className="px-3 py-2.5 text-right font-mono text-slate-600">{fmtNum(p.rows)}</td>
                <td className="px-3 py-2.5 text-right">
                  <div className="flex items-center justify-end gap-2">
                    <div className="w-16 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                      <div className="h-full rounded-full bg-violet-400" style={{ width: `${diskPct}%` }} />
                    </div>
                    <span className="font-mono text-slate-700">{fmtBytes(p.bytes_on_disk)}</span>
                  </div>
                </td>
                <td className="px-3 py-2.5 text-right font-mono text-slate-500">{fmtBytes(p.data_compressed_bytes || p.bytes_on_disk)}</td>
                <td className="px-3 py-2.5 text-right font-mono text-slate-500">{fmtBytes(p.data_uncompressed_bytes)}</td>
                <td className="px-3 py-2.5 text-right">
                  <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                    ratio !== '—' && parseFloat(ratio) > 5 ? 'bg-green-100 text-green-700' :
                    ratio !== '—' && parseFloat(ratio) > 2 ? 'bg-blue-100 text-blue-700' :
                    'bg-slate-100 text-slate-500'
                  }`}>
                    {ratio}
                  </span>
                </td>
                <td className="px-3 py-2.5">
                  {p.active === 1 || p.active === true || String(p.active) === '1' ? (
                    <span className="px-1.5 py-0.5 bg-green-100 text-green-700 text-[10px] font-bold rounded-full">Active</span>
                  ) : (
                    <span className="px-1.5 py-0.5 bg-slate-100 text-slate-500 text-[10px] font-bold rounded-full">Inactive</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ── Merges Tab ── */
function MergesTab({ merges, total }) {
  if (merges.length === 0) {
    return (
      <Empty icon={total === 0 ? CheckCircle2 : Search}
        msg={total === 0 ? 'No active merges running.' : 'No merges match the current filters.'}
        good={total === 0} />
    );
  }

  return (
    <>
      {total > 15 && (
        <div className="px-4 py-2 bg-orange-50 border-b border-orange-100 flex items-center gap-2 text-xs text-orange-700">
          <AlertTriangle size={12} /> High merge queue ({total} active). Consider reducing insert frequency or reviewing MergeTree settings.
        </div>
      )}
      <div className="overflow-auto max-h-[580px]">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-white border-b border-slate-200 z-10">
            <tr>
              <th className="px-4 py-3 text-left font-bold text-[11px] text-slate-400 whitespace-nowrap">Database</th>
              <th className="px-3 py-3 text-left font-bold text-[11px] text-slate-400 whitespace-nowrap">Table</th>
              <th className="px-3 py-3 text-right font-bold text-[11px] text-slate-400 whitespace-nowrap">Elapsed (s)</th>
              <th className="px-3 py-3 text-left font-bold text-[11px] text-slate-400 whitespace-nowrap">Progress</th>
              <th className="px-3 py-3 text-right font-bold text-[11px] text-slate-400 whitespace-nowrap">Rows Read</th>
              <th className="px-3 py-3 text-right font-bold text-[11px] text-slate-400 whitespace-nowrap">Rows Written</th>
              <th className="px-3 py-3 text-right font-bold text-[11px] text-slate-400 whitespace-nowrap">Parts to Merge</th>
              <th className="px-3 py-3 text-left font-bold text-[11px] text-slate-400 whitespace-nowrap">Type</th>
            </tr>
          </thead>
          <tbody>
            {merges.map((m, i) => {
              const progress = Math.round(Number(m.progress || 0) * 100);
              const elapsed  = Number(m.elapsed || 0);
              return (
                <tr key={i} className="border-t border-slate-100 hover:bg-violet-50 transition-colors">
                  <td className="px-4 py-2.5 text-slate-400">{m.database || '—'}</td>
                  <td className="px-3 py-2.5 font-semibold text-violet-700">{m.table || '—'}</td>
                  <td className={`px-3 py-2.5 text-right font-bold ${elapsed > 60 ? 'text-red-600' : elapsed > 10 ? 'text-orange-500' : 'text-slate-700'}`}>
                    {elapsed.toFixed(1)}
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <div className="w-20 h-2 bg-slate-100 rounded-full overflow-hidden">
                        <div className="h-full rounded-full transition-all"
                          style={{ width: `${progress}%`, background: progress > 80 ? '#22C55E' : '#8B5CF6' }} />
                      </div>
                      <span className="text-xs font-bold text-slate-600 whitespace-nowrap">{progress}%</span>
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono text-slate-600">{fmtNum(m.rows_read)}</td>
                  <td className="px-3 py-2.5 text-right font-mono text-slate-600">{fmtNum(m.rows_written)}</td>
                  <td className="px-3 py-2.5 text-right font-mono text-slate-600">{m.num_parts || '—'}</td>
                  <td className="px-3 py-2.5">
                    {m.merge_type ? (
                      <span className="px-2 py-0.5 bg-indigo-100 text-indigo-700 rounded-full text-[10px] font-bold">{m.merge_type}</span>
                    ) : <span className="text-slate-400">—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* ── Table Stats Tab ── */
function TableStatsTab({ stats, total }) {
  if (stats.length === 0) {
    return (
      <Empty icon={total === 0 ? Database : Search}
        msg={total === 0 ? 'No table statistics available.' : 'No tables match the current filters.'}
        good={total === 0} />
    );
  }

  const sorted = [...stats].sort((a, b) => {
    const sizeA = Number(a.total_bytes || a.bytes || 0);
    const sizeB = Number(b.total_bytes || b.bytes || 0);
    return sizeB - sizeA;
  });

  const maxSize = Math.max(...sorted.map(t => Number(t.total_bytes || t.bytes || 0)), 1);

  return (
    <div className="overflow-auto max-h-[580px]">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-white border-b border-slate-200 z-10">
          <tr>
            <th className="px-4 py-3 text-left font-bold text-[11px] text-slate-400 whitespace-nowrap">Database</th>
            <th className="px-3 py-3 text-left font-bold text-[11px] text-slate-400 whitespace-nowrap">Name</th>
            <th className="px-3 py-3 text-left font-bold text-[11px] text-slate-400 whitespace-nowrap">Engine</th>
            <th className="px-3 py-3 text-right font-bold text-[11px] text-slate-400 whitespace-nowrap">Total Rows</th>
            <th className="px-3 py-3 text-right font-bold text-[11px] text-slate-400 whitespace-nowrap">Size (pretty)</th>
            <th className="px-3 py-3 text-right font-bold text-[11px] text-slate-400 whitespace-nowrap">Size (bytes)</th>
            <th className="px-3 py-3 text-right font-bold text-[11px] text-slate-400 whitespace-nowrap">Parts</th>
            <th className="px-3 py-3 text-left font-bold text-[11px] text-slate-400 whitespace-nowrap">Last Modified</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((t, i) => {
            const sizeBytes = Number(t.total_bytes || t.bytes || 0);
            const sizePct   = Math.round((sizeBytes / maxSize) * 100);
            return (
              <tr key={i} className="border-t border-slate-100 hover:bg-violet-50 transition-colors">
                <td className="px-4 py-2.5 text-slate-400">{t.database || '—'}</td>
                <td className="px-3 py-2.5 font-semibold text-violet-700">{t.name || '—'}</td>
                <td className="px-3 py-2.5">
                  <span className="px-2 py-0.5 bg-indigo-100 text-indigo-700 rounded-full text-[10px] font-bold">
                    {t.engine || '—'}
                  </span>
                </td>
                <td className="px-3 py-2.5 text-right font-mono text-slate-700">{fmtNum(t.total_rows || t.rows)}</td>
                <td className="px-3 py-2.5 text-right">
                  <div className="flex items-center justify-end gap-2">
                    <div className="w-14 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                      <div className="h-full rounded-full bg-indigo-400" style={{ width: `${sizePct}%` }} />
                    </div>
                    <span className="font-mono font-semibold text-slate-700 whitespace-nowrap">
                      {t.size_pretty || fmtBytes(sizeBytes)}
                    </span>
                  </div>
                </td>
                <td className="px-3 py-2.5 text-right font-mono text-slate-500">{fmtBytes(sizeBytes)}</td>
                <td className="px-3 py-2.5 text-right font-mono text-slate-500">{fmtNum(t.parts || t.total_parts)}</td>
                <td className="px-3 py-2.5 text-[10px] text-slate-400 whitespace-nowrap">
                  {String(t.metadata_modification_time || t.last_modified || '—').slice(0, 16)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ── Shared atoms ── */
function KpiCard({ icon, label, value, accent = 'slate' }) {
  const border = ({
    red: 'border-l-red-500', yellow: 'border-l-yellow-400',
    green: 'border-l-green-500', violet: 'border-l-violet-500', slate: 'border-l-slate-300',
  })[accent] || 'border-l-slate-300';
  return (
    <div className={`bg-white rounded-2xl border border-slate-200 border-l-4 ${border} p-4`}>
      <div className="flex justify-between items-start">
        <div>
          <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wide">{label}</p>
          <p className="text-xl font-black text-slate-800 mt-1">{value}</p>
        </div>
        {icon}
      </div>
    </div>
  );
}

function Empty({ icon: Icon = CheckCircle2, msg, good = false }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center px-6">
      <Icon size={32} className={good ? 'text-green-400 mb-3' : 'text-slate-300 mb-3'} />
      <p className={`font-semibold ${good ? 'text-green-700' : 'text-slate-500'}`}>{msg}</p>
    </div>
  );
}

function Spinner() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50">
      <div className="text-center">
        <div className="w-10 h-10 border-4 border-violet-200 border-t-violet-500 rounded-full animate-spin mx-auto mb-3" />
        <p className="text-slate-500 text-sm">Loading table analysis…</p>
      </div>
    </div>
  );
}

function Err({ msg, onRetry }) {
  return (
    <div className="p-6">
      <div className="bg-red-50 border border-red-200 rounded-2xl p-6 max-w-lg">
        <AlertTriangle className="text-red-500 mb-2" size={20} />
        <p className="font-bold text-red-700">Failed to load table analysis</p>
        <p className="text-sm text-red-600 mt-1">{msg}</p>
        <button onClick={onRetry} className="mt-3 px-4 py-2 bg-red-600 text-white rounded-xl text-sm font-bold">Retry</button>
      </div>
    </div>
  );
}
