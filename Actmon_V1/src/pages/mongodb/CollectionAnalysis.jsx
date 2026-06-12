import React, { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft, RefreshCw, Layers, Database, AlertTriangle,
  CheckCircle2, ChevronDown, ChevronRight, Search,
  BarChart2, HardDrive, Archive,
} from 'lucide-react';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip, Cell,
} from 'recharts';
import client from '../../api/client';

const fetchCollections = (id) =>
  client.get(`/connections/mongodb/${id}/mongo-collection-analysis`).then(r => r.data);

/* ── helpers ── */
function fmtNum(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(v);
}

function fmtBytes(bytes) {
  const b = Number(bytes) || 0;
  if (b >= 1073741824) return `${(b / 1073741824).toFixed(2)} GB`;
  if (b >= 1048576)    return `${(b / 1048576).toFixed(2)} MB`;
  if (b >= 1024)       return `${(b / 1024).toFixed(2)} KB`;
  return `${b} B`;
}

const CHART_COLORS = [
  '#8B5CF6', '#6366F1', '#7C3AED', '#A78BFA', '#4F46E5',
  '#818CF8', '#C4B5FD', '#7DD3FC', '#34D399', '#F472B6',
];

/* ── KPI card ── */
function KpiCard({ icon: Icon, label, value, accent = 'slate', sub }) {
  const borders = {
    violet:  'border-l-violet-500',
    indigo:  'border-l-indigo-500',
    purple:  'border-l-purple-500',
    orange:  'border-l-orange-400',
    emerald: 'border-l-emerald-500',
    red:     'border-l-red-500',
    slate:   'border-l-slate-300',
  };
  return (
    <div className={`bg-white rounded-xl border border-slate-200 border-l-4 ${borders[accent] || borders.slate} p-4`}>
      <div className="flex justify-between items-start">
        <div>
          <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wide">{label}</p>
          <p className="text-xl font-black text-slate-800 mt-1">{value ?? '—'}</p>
          {sub && <p className="text-[10px] text-slate-400 mt-0.5">{sub}</p>}
        </div>
        <Icon size={18} className="text-slate-300 mt-0.5" />
      </div>
    </div>
  );
}

/* ── Index names expanded detail ── */
function CollectionDetail({ coll }) {
  const indexes     = coll.indexes || coll.index_names || coll.indexNames || [];
  const indexArr    = Array.isArray(indexes) ? indexes : (typeof indexes === 'object' ? Object.keys(indexes) : []);
  const storageSize = coll.storage_size || coll.storageSize;
  const wiredTiger  = coll.wiredTiger || coll.wired_tiger;

  return (
    <div className="space-y-4">
      {/* Stats grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {[
          { label: 'Document Count',     value: fmtNum(coll.count)                        },
          { label: 'Data Size',          value: `${coll.size_mb ?? 0} MB`                 },
          { label: 'Avg Object Size',    value: coll.avg_obj_size != null
              ? fmtBytes(coll.avg_obj_size) : '—'                                          },
          { label: 'Total Index Size',   value: `${coll.total_index_size_mb ?? 0} MB`     },
          { label: 'Index Count',        value: coll.index_count ?? coll.nindexes ?? '—'  },
          { label: 'Capped',             value: coll.capped ? 'Yes' : 'No'                },
          { label: 'Storage Size',       value: storageSize ? fmtBytes(storageSize) : '—' },
          { label: 'Collection',         value: `${coll.db || '—'}.${coll.collection || '—'}` },
        ].map(({ label, value }) => (
          <div key={label} className="bg-white border border-slate-200 rounded-xl p-2.5">
            <p className="text-[9px] font-bold text-slate-400 uppercase tracking-wide">{label}</p>
            <p className="font-semibold text-slate-800 text-xs mt-0.5 break-all">{String(value)}</p>
          </div>
        ))}
      </div>

      {/* Index names */}
      <div>
        <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2">Index Names</p>
        {indexArr.length === 0 ? (
          <div className="flex items-center gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
            <AlertTriangle size={12} className="flex-shrink-0" />
            No index information available for this collection
          </div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {indexArr.map((idx, i) => {
              const name = typeof idx === 'string' ? idx : (idx.name || idx.indexName || JSON.stringify(idx));
              const isPrimary = name === '_id_' || name === '_id';
              return (
                <span key={i}
                  className={`px-2.5 py-1 rounded-lg text-[10px] font-mono font-semibold ${
                    isPrimary ? 'bg-violet-100 text-violet-700' : 'bg-slate-100 text-slate-600'
                  }`}>
                  {name}
                </span>
              );
            })}
          </div>
        )}
      </div>

      {/* Capped warning */}
      {coll.capped && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 text-xs text-blue-700 flex items-start gap-2">
          <Archive size={13} className="flex-shrink-0 mt-0.5" />
          <span>
            This is a <strong>capped collection</strong>. It has a fixed size and automatically removes the oldest documents when the size limit is reached.
            {coll.max ? ` Maximum documents: ${fmtNum(coll.max)}.` : ''}
          </span>
        </div>
      )}
    </div>
  );
}

/* ── Main page ── */
export default function CollectionAnalysis() {
  const { id } = useParams();
  const [dbFilter,   setDbFilter]   = useState('');
  const [search,     setSearch]     = useState('');
  const [expanded,   setExpanded]   = useState(null);
  const [showChart,  setShowChart]  = useState(true);

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['mongoCollectionAnalysis', id],
    queryFn:  () => fetchCollections(id),
    retry: false,
    refetchInterval: 60000,
  });

  /* ── loading ── */
  if (isLoading) return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50">
      <div className="text-center">
        <div className="w-10 h-10 border-4 border-violet-200 border-t-violet-600 rounded-full animate-spin mx-auto mb-3" />
        <p className="text-slate-500 text-sm">Loading collection analysis...</p>
      </div>
    </div>
  );

  /* ── error ── */
  if (error) return (
    <div className="p-6">
      <div className="bg-red-50 border border-red-200 rounded-2xl p-6 max-w-lg">
        <AlertTriangle className="text-red-500 mb-2" size={20} />
        <p className="font-bold text-red-700">Failed to load collection analysis</p>
        <p className="text-sm text-red-600 mt-1">{error.message}</p>
        <button onClick={() => refetch()} className="mt-3 px-4 py-2 bg-red-600 text-white rounded-xl text-sm font-bold">Retry</button>
      </div>
    </div>
  );

  const collections = data?.collections || data || [];
  const colArr      = Array.isArray(collections) ? collections : [];

  /* unique databases */
  const databases = [...new Set(colArr.map(c => c.db).filter(Boolean))].sort();

  /* filtered set */
  const filtered = colArr.filter(c => {
    const okDb     = !dbFilter || c.db === dbFilter;
    const okSearch = !search   ||
      (c.collection || '').toLowerCase().includes(search.toLowerCase()) ||
      (c.db || '').toLowerCase().includes(search.toLowerCase());
    return okDb && okSearch;
  });

  /* aggregated KPIs */
  const totalDocs      = colArr.reduce((s, c) => s + (Number(c.count) || 0), 0);
  const totalSizeMB    = colArr.reduce((s, c) => s + (Number(c.size_mb) || 0), 0).toFixed(2);
  const totalIndexMB   = colArr.reduce((s, c) => s + (Number(c.total_index_size_mb) || 0), 0).toFixed(2);
  const cappedCount    = colArr.filter(c => c.capped).length;

  /* chart data — top 10 by size */
  const chartData = [...colArr]
    .sort((a, b) => (Number(b.size_mb) || 0) - (Number(a.size_mb) || 0))
    .slice(0, 10)
    .map(c => ({
      name: c.collection ? `${c.db}.${c.collection}` : (c.db || '—'),
      size: Number(c.size_mb) || 0,
    }));

  /* max size for bar fill width */
  const maxSizeMB = filtered.length
    ? Math.max(...filtered.map(c => Number(c.size_mb) || 0), 1)
    : 1;

  return (
    <div className="min-h-screen bg-slate-50">

      {/* ── Header ── */}
      <div className="bg-gradient-to-r from-slate-900 via-indigo-950 to-violet-900 text-white px-6 py-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-4">
            <Link to={`/mongodb-dashboard/${id}`}
              className="w-9 h-9 rounded-xl bg-white/10 hover:bg-white/20 border border-white/20 flex items-center justify-center">
              <ArrowLeft size={16} />
            </Link>
            <div>
              <h1 className="text-xl font-black tracking-tight flex items-center gap-2">
                <Layers size={18} className="text-violet-300" /> Collection Analysis
              </h1>
              <p className="text-violet-300 text-xs mt-0.5">
                Size, document counts, index details — per collection
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
          <KpiCard icon={Layers}   label="Collections"    value={colArr.length}        accent="violet" />
          <KpiCard icon={Database} label="Total Documents" value={fmtNum(totalDocs)}    accent="indigo" />
          <KpiCard icon={HardDrive} label="Total Size"    value={`${totalSizeMB} MB`}  accent="purple" />
          <KpiCard icon={BarChart2} label="Index Storage" value={`${totalIndexMB} MB`} accent="orange"
            sub={cappedCount > 0 ? `${cappedCount} capped` : undefined} />
        </div>

        {/* ── Chart ── */}
        {chartData.length > 0 && (
          <div className="bg-white rounded-2xl border border-slate-200 p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold text-slate-700 text-sm flex items-center gap-2">
                <BarChart2 size={15} className="text-violet-500" />
                Top Collections by Size (MB)
              </h3>
              <button onClick={() => setShowChart(v => !v)}
                className="text-xs text-slate-400 hover:text-slate-600 border border-slate-200 px-2 py-1 rounded-lg">
                {showChart ? 'Hide' : 'Show'}
              </button>
            </div>
            {showChart && (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart layout="vertical" data={chartData} margin={{ left: 12, right: 12 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 9 }} tickFormatter={v => `${v}MB`}
                    axisLine={false} tickLine={false} />
                  <YAxis width={150} type="category" dataKey="name" tick={{ fontSize: 9 }}
                    axisLine={false} tickLine={false} />
                  <Tooltip formatter={v => [`${v} MB`, 'Size']} cursor={{ fill: '#f8fafc' }} />
                  <Bar dataKey="size" radius={[0, 5, 5, 0]}>
                    {chartData.map((_, i) => (
                      <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        )}

        {/* ── Filter bar ── */}
        <div className="bg-white rounded-2xl border border-slate-200 p-3 flex flex-wrap gap-3 items-center">
          {/* Database dropdown */}
          <div className="flex items-center gap-2">
            <Database size={13} className="text-slate-400" />
            <select value={dbFilter} onChange={e => setDbFilter(e.target.value)}
              className="h-9 px-3 rounded-xl border border-slate-200 text-sm outline-none bg-white focus:border-violet-400 min-w-[140px]">
              <option value="">All Databases ({databases.length})</option>
              {databases.map(db => (
                <option key={db} value={db}>{db}</option>
              ))}
            </select>
          </div>

          {/* Database filter badges */}
          {databases.length > 0 && databases.length <= 8 && (
            <div className="flex gap-1 flex-wrap">
              <button onClick={() => setDbFilter('')}
                className={`px-2 h-6 rounded-md text-[10px] font-bold transition-all ${!dbFilter ? 'bg-slate-900 text-white' : 'border border-slate-200 text-slate-500 hover:bg-slate-50'}`}>
                All
              </button>
              {databases.map(db => (
                <button key={db} onClick={() => setDbFilter(dbFilter === db ? '' : db)}
                  className={`px-2 h-6 rounded-md text-[10px] font-bold transition-all ${dbFilter === db ? 'bg-violet-700 text-white' : 'border border-slate-200 text-slate-500 hover:bg-slate-50'}`}>
                  {db}
                </button>
              ))}
            </div>
          )}

          <div className="relative ml-auto">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search collections..."
              className="pl-7 pr-3 h-8 text-xs rounded-xl border border-slate-200 outline-none focus:border-violet-400 w-48" />
          </div>
          <span className="text-xs text-slate-400">{filtered.length} collections</span>
        </div>

        {/* ── Collection table ── */}
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          {colArr.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center px-6">
              <CheckCircle2 size={32} className="text-violet-300 mb-3" />
              <p className="font-semibold text-slate-700">No collection data available</p>
              <p className="text-xs text-slate-400 mt-2 max-w-md">
                The collection analysis returned no results. Ensure the connected user has listCollections and collStats privileges.
              </p>
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <p className="text-slate-400 text-sm">No collections match the current filter</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 border-b border-slate-100 sticky top-0 z-10">
                  <tr>
                    <th className="w-8 px-3 py-2.5" />
                    <th className="px-3 py-2.5 text-left text-[11px] font-bold text-slate-400">Database</th>
                    <th className="px-3 py-2.5 text-left text-[11px] font-bold text-slate-400">Collection</th>
                    <th className="px-3 py-2.5 text-right text-[11px] font-bold text-slate-400 whitespace-nowrap">Count</th>
                    <th className="px-3 py-2.5 text-right text-[11px] font-bold text-slate-400 whitespace-nowrap">Size (MB)</th>
                    <th className="px-3 py-2.5 text-right text-[11px] font-bold text-slate-400 whitespace-nowrap">Avg Obj Size</th>
                    <th className="px-3 py-2.5 text-right text-[11px] font-bold text-slate-400 whitespace-nowrap">Index Size (MB)</th>
                    <th className="px-3 py-2.5 text-right text-[11px] font-bold text-slate-400 whitespace-nowrap">Indexes</th>
                    <th className="px-3 py-2.5 text-center text-[11px] font-bold text-slate-400">Capped</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((coll, i) => {
                    const key    = `${coll.db}-${coll.collection}-${i}`;
                    const isOpen = expanded === key;
                    const sizePct= Math.min(100, ((Number(coll.size_mb) || 0) / maxSizeMB) * 100);

                    return (
                      <React.Fragment key={key}>
                        <tr
                          className={`border-t border-slate-100 cursor-pointer transition-colors ${
                            isOpen ? 'bg-violet-50' : 'hover:bg-slate-50'
                          }`}
                          onClick={() => setExpanded(isOpen ? null : key)}>
                          <td className="px-3 py-2.5 text-slate-400">
                            {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                          </td>
                          <td className="px-3 py-2.5 font-semibold text-indigo-700">
                            {coll.db || '—'}
                          </td>
                          <td className="px-3 py-2.5 font-mono font-bold text-violet-700">
                            {coll.collection || '—'}
                          </td>
                          <td className="px-3 py-2.5 text-right font-mono text-slate-700">
                            {fmtNum(coll.count)}
                          </td>
                          <td className="px-3 py-2.5 text-right">
                            <div className="flex items-center justify-end gap-2">
                              <span className="font-mono text-slate-700">{coll.size_mb ?? '—'}</span>
                              <div className="w-14 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                                <div className="h-full bg-violet-500 rounded-full transition-all"
                                  style={{ width: `${sizePct}%` }} />
                              </div>
                            </div>
                          </td>
                          <td className="px-3 py-2.5 text-right font-mono text-slate-500">
                            {coll.avg_obj_size != null ? fmtBytes(coll.avg_obj_size) : '—'}
                          </td>
                          <td className="px-3 py-2.5 text-right font-mono text-slate-500">
                            {coll.total_index_size_mb ?? '—'}
                          </td>
                          <td className="px-3 py-2.5 text-right font-mono text-slate-700 font-bold">
                            {coll.index_count ?? coll.nindexes ?? '—'}
                          </td>
                          <td className="px-3 py-2.5 text-center">
                            {coll.capped ? (
                              <span className="px-2 py-0.5 bg-blue-100 text-blue-700 text-[10px] font-bold rounded-full">Yes</span>
                            ) : (
                              <span className="px-2 py-0.5 bg-slate-100 text-slate-400 text-[10px] font-bold rounded-full">No</span>
                            )}
                          </td>
                        </tr>
                        {isOpen && (
                          <tr className="bg-violet-50 border-t border-violet-100">
                            <td colSpan={9} className="px-5 py-4">
                              <CollectionDetail coll={coll} />
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>

              {/* Footer summary */}
              <div className="border-t border-slate-100 px-4 py-2 bg-slate-50 flex items-center gap-6 text-[10px] text-slate-400 font-semibold">
                <span>Total: {filtered.length} collections</span>
                <span>Documents: {fmtNum(filtered.reduce((s, c) => s + (Number(c.count) || 0), 0))}</span>
                <span>Size: {filtered.reduce((s, c) => s + (Number(c.size_mb) || 0), 0).toFixed(2)} MB</span>
                <span>Index: {filtered.reduce((s, c) => s + (Number(c.total_index_size_mb) || 0), 0).toFixed(2)} MB</span>
              </div>
            </div>
          )}
        </div>

      </div>
    </div>
  );
}
