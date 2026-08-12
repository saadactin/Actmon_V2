import React, { useState, useMemo } from 'react';
import { Paged } from '@/components/ui/Pagination';
import PageHeader from '@/components/layout/PageHeader';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft, RefreshCw, Search, AlertTriangle, Database,
  Layers, Key, TrendingUp, Download, Info,
  CheckCircle2, Inbox,
} from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell,
} from 'recharts';
import client from '@/api/client';

const C = { green: '#00ED64', dark: '#00684A', navy: '#001E2B', emerald: '#00C851', teal: '#14B8A6', blue: '#3B82F6', orange: '#F97316', red: '#EF4444', yellow: '#EAB308', purple: '#8B5CF6' };

const fetchCollections  = (id) => client.get(`/connections/mongodb/${id}/mongo-collections`).then(r => r.data);
const fetchIndexes      = (id) => client.get(`/connections/mongodb/${id}/mongo-indexes`).then(r => r.data);
const fetchCollAnalysis = (id) => client.get(`/connections/mongodb/${id}/mongo-collection-analysis`).then(r => r.data);

function fmtBytes(bytes) {
  const b = Number(bytes) || 0;
  if (b >= 1073741824) return `${(b / 1073741824).toFixed(2)} GB`;
  if (b >= 1048576)    return `${(b / 1048576).toFixed(2)} MB`;
  if (b >= 1024)       return `${(b / 1024).toFixed(2)} KB`;
  return `${b} B`;
}
function fmtNum(n) {
  const v = Number(n) || 0;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(v);
}

function TabBtn({ active, onClick, icon: Icon, label, badge }) {
  return (
    <button onClick={onClick}
      className={`relative flex items-center gap-2 px-5 py-2.5 text-sm font-semibold rounded-t-xl whitespace-nowrap border-b-2 transition-all ${
        active ? 'border-green-500 text-green-700 bg-white' : 'border-transparent text-slate-500 hover:text-slate-700 hover:bg-slate-50'
      }`}>
      <Icon size={14} />
      {label}
      {badge > 0 && (
        <span className="absolute -top-1 -right-1 h-4 min-w-4 px-0.5 flex items-center justify-center rounded-full bg-orange-500 text-white text-[9px] font-black">{badge}</span>
      )}
    </button>
  );
}

function MetricCard({ label, value, sub, accent }) {
  const cls = {
    green:  'bg-green-50 border-green-200 text-green-700',
    blue:   'bg-blue-50 border-blue-200 text-blue-700',
    orange: 'bg-orange-50 border-orange-200 text-orange-700',
    red:    'bg-red-50 border-red-200 text-red-700',
    slate:  'bg-slate-50 border-slate-200 text-slate-600',
    purple: 'bg-purple-50 border-purple-200 text-purple-700',
  };
  return (
    <div className={`rounded-2xl border p-4 ${cls[accent] || cls.slate}`}>
      <p className="text-[10px] font-bold uppercase tracking-wide opacity-70">{label}</p>
      <p className="text-2xl font-black mt-1">{value ?? '—'}</p>
      {sub && <p className="text-[10px] opacity-60 mt-0.5">{sub}</p>}
    </div>
  );
}

export default function CollectionAnalysis() {
  const { id } = useParams();
  const [tab,        setTab]        = useState('collections');
  const [search,     setSearch]     = useState('');
  const [dbFilter,   setDbFilter]   = useState('');
  const [idxSearch,  setIdxSearch]  = useState('');
  const [showUnused, setShowUnused] = useState(false);

  const { data: collData, isLoading: collLoading, refetch: refetchColl, isFetching } = useQuery({
    queryKey: ['mongoCollData', id],
    queryFn:  () => fetchCollections(id),
    retry: false,
    refetchInterval: 30000,
  });

  const { data: idxData, isLoading: idxLoading, refetch: refetchIdx } = useQuery({
    queryKey: ['mongoIdxData', id],
    queryFn:  () => fetchIndexes(id),
    retry: false,
    refetchInterval: 30000,
  });

  const { data: analysisData } = useQuery({
    queryKey: ['mongoCollAnalysis', id],
    queryFn:  () => fetchCollAnalysis(id),
    retry: false,
    refetchInterval: 60000,
  });

  // ── derived ───────────────────────────────────────────────────────────────
  const dbsData  = useMemo(() => collData?.databases || [], [collData]);
  const allDbs   = useMemo(() => dbsData.map(d => d.name), [dbsData]);
  const allColls = useMemo(() =>
    dbsData.flatMap(d => (d.collections || []).map(c => ({ ...c, dbName: d.name }))),
    [dbsData]
  );

  const filteredColls = useMemo(() => {
    let list = allColls;
    if (dbFilter) list = list.filter(c => c.dbName === dbFilter);
    if (search)   list = list.filter(c => (c.name || '').toLowerCase().includes(search.toLowerCase()));
    return list;
  }, [allColls, dbFilter, search]);

  const allIndexes    = useMemo(() => idxData?.indexes        || [], [idxData]);
  const unusedIndexes = useMemo(() => idxData?.unused_indexes || [], [idxData]);

  const filteredIdxs = useMemo(() => {
    let list = showUnused ? unusedIndexes : allIndexes;
    if (idxSearch) list = list.filter(ix =>
      (ix.ns || '').toLowerCase().includes(idxSearch.toLowerCase()) ||
      (ix.name || '').toLowerCase().includes(idxSearch.toLowerCase())
    );
    return list;
  }, [allIndexes, unusedIndexes, showUnused, idxSearch]);

  const topBySize = useMemo(() =>
    [...filteredColls].sort((a, b) => (b.size_mb || 0) - (a.size_mb || 0)).slice(0, 10),
    [filteredColls]
  );
  const topByDocs = useMemo(() =>
    [...filteredColls].sort((a, b) => (b.count || 0) - (a.count || 0)).slice(0, 10),
    [filteredColls]
  );
  const totals = useMemo(() => ({
    collections: filteredColls.length,
    docs:   filteredColls.reduce((a, c) => a + (c.count || 0), 0),
    sizeMB: filteredColls.reduce((a, c) => a + (c.size_mb || 0), 0).toFixed(2),
    idxMB:  filteredColls.reduce((a, c) => a + (c.total_index_size_mb || 0), 0).toFixed(2),
  }), [filteredColls]);

  const exportCSV = () => {
    const h = ['Database', 'Collection', 'Documents', 'Size (MB)', 'Avg Obj (B)', 'Indexes', 'Index MB', 'Capped'];
    const rows = filteredColls.map(c => [c.dbName, c.name, c.count || 0, (c.size_mb || 0).toFixed(4), c.avgObjSize || 0, c.nindexes || 0, (c.total_index_size_mb || 0).toFixed(4), c.capped ? 'Yes' : 'No']);
    const csv = [h, ...rows].map(r => r.map(v => `"${v}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `mongodb-collections-${id}.csv`;
    a.click();
  };

  if (collLoading) return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <div className="text-center">
        <div className="w-10 h-10 border-4 border-green-200 border-t-green-600 rounded-full animate-spin mx-auto mb-3" />
        <p className="text-slate-500 font-semibold text-sm">Loading collection data…</p>
      </div>
    </div>
  );

  const PALETTE = [C.green, C.blue, C.orange, C.red, C.purple, C.teal, C.yellow, C.emerald, '#ec4899', '#64748b'];

  return (
    <div className="min-h-screen bg-slate-50">

      {/* ── Hero header ── */}
      <PageHeader
        title="Collection & Index Analysis"
        subtitle={`MongoDB · Connection #${id}`}
        backTo={`/mongodb-dashboard/${id}`}
        leading={<span className="grid h-10 w-10 place-items-center rounded-md bg-accent-soft text-[20px]">📊</span>}
        actions={(
          <>
            <button onClick={exportCSV}
              className="flex items-center gap-1.5 h-9 px-3 rounded-control border border-border text-[12px] font-semibold text-muted hover:bg-sunken hover:text-fg">
              <Download size={12} /> Export CSV
            </button>
            <button onClick={() => { refetchColl(); refetchIdx(); }}
              className="flex items-center gap-1.5 h-9 px-3 rounded-control border border-border text-[12px] font-semibold text-muted hover:bg-sunken hover:text-fg">
              <RefreshCw size={12} className={isFetching ? 'animate-spin' : undefined} /> Refresh
            </button>
          </>
        )}
      />

      {/* ── Tabs ── */}
      <div className="bg-white border-b border-slate-200 px-6 flex gap-1 overflow-x-auto">
        <TabBtn active={tab === 'collections'} onClick={() => setTab('collections')} icon={Layers}     label="Collections" />
        <TabBtn active={tab === 'indexes'}     onClick={() => setTab('indexes')}     icon={Key}        label="Indexes" badge={unusedIndexes.length} />
        <TabBtn active={tab === 'insights'}    onClick={() => setTab('insights')}    icon={TrendingUp} label="Insights" />
      </div>

      <div className="p-5">

        {/* ════ COLLECTIONS ════ */}
        {tab === 'collections' && (
          <div className="space-y-4">
            {/* Filter bar */}
            <div className="bg-white rounded-2xl border border-slate-200 p-4 flex flex-wrap items-center gap-3">
              <select value={dbFilter} onChange={e => setDbFilter(e.target.value)}
                className="h-9 px-3 rounded-xl border border-slate-200 text-sm outline-none focus:border-green-400 bg-white">
                <option value="">All Databases</option>
                {allDbs.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
              <div className="relative">
                <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input value={search} onChange={e => setSearch(e.target.value)}
                  placeholder="Search collections…"
                  className="h-9 pl-8 pr-4 w-52 rounded-xl border border-slate-200 text-sm outline-none focus:border-green-400" />
              </div>
              <span className="text-xs text-slate-400 ml-auto">{filteredColls.length} collections</span>
            </div>

            {/* Size charts */}
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              <div className="bg-white rounded-2xl border border-slate-200 p-5">
                <h3 className="font-bold text-slate-800 text-sm mb-4">Top 10 by Size (MB)</h3>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart layout="vertical"
                    data={topBySize.map(c => ({ name: `${c.dbName}.${c.name}`, size: c.size_mb || 0 }))}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" horizontal={false} />
                    <XAxis type="number" tick={{ fontSize: 9 }} tickFormatter={v => `${v}MB`} axisLine={false} tickLine={false} />
                    <YAxis width={140} type="category" dataKey="name" tick={{ fontSize: 9 }} axisLine={false} tickLine={false} />
                    <Tooltip formatter={v => `${v} MB`} cursor={{ fill: '#f8fafc' }} />
                    <Bar dataKey="size" radius={[0, 5, 5, 0]}>
                      {topBySize.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className="bg-white rounded-2xl border border-slate-200 p-5">
                <h3 className="font-bold text-slate-800 text-sm mb-4">Top 10 by Document Count</h3>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart layout="vertical"
                    data={topByDocs.map(c => ({ name: `${c.dbName}.${c.name}`, docs: c.count || 0 }))}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" horizontal={false} />
                    <XAxis type="number" tick={{ fontSize: 9 }} tickFormatter={fmtNum} axisLine={false} tickLine={false} />
                    <YAxis width={140} type="category" dataKey="name" tick={{ fontSize: 9 }} axisLine={false} tickLine={false} />
                    <Tooltip formatter={v => fmtNum(v)} cursor={{ fill: '#f8fafc' }} />
                    <Bar dataKey="docs" radius={[0, 5, 5, 0]}>
                      {topByDocs.map((_, i) => <Cell key={i} fill={PALETTE[(i + 4) % PALETTE.length]} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Collection table */}
            <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
              <div className="overflow-x-auto">
                <Paged rows={filteredColls} unit="collections">{(pageRows, pager) => (<>
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 border-b border-slate-200">
                    <tr>
                      {['Database', 'Collection', 'Documents', 'Size MB', 'Avg Obj (B)', 'Indexes', 'Index MB', 'Capped'].map(h => (
                        <th key={h} className="px-3 py-3 text-left text-[10px] font-bold text-slate-400 uppercase whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.map((c, i) => {
                      const maxSize = Math.max(...filteredColls.map(x => x.size_mb || 0), 0.001);
                      return (
                        <tr key={i} className="border-t border-slate-100 hover:bg-slate-50">
                          <td className="px-3 py-2.5 text-slate-500 font-mono text-[10px]">{c.dbName}</td>
                          <td className="px-3 py-2.5 font-bold" style={{ color: C.dark }}>{c.name}</td>
                          <td className="px-3 py-2.5 font-mono">{fmtNum(c.count || 0)}</td>
                          <td className="px-3 py-2.5">
                            <div className="flex items-center gap-2">
                              <span className="font-mono">{(c.size_mb || 0).toFixed(4)}</span>
                              <div className="h-1.5 w-12 bg-slate-100 rounded-full overflow-hidden">
                                <div className="h-full rounded-full"
                                  style={{ width: `${Math.min(100, ((c.size_mb || 0) / maxSize) * 100)}%`, background: C.green }} />
                              </div>
                            </div>
                          </td>
                          <td className="px-3 py-2.5 font-mono">{fmtNum(c.avgObjSize || 0)}</td>
                          <td className="px-3 py-2.5 font-mono">{c.nindexes ?? '—'}</td>
                          <td className="px-3 py-2.5 font-mono">{(c.total_index_size_mb || 0).toFixed(4)}</td>
                          <td className="px-3 py-2.5">
                            {c.capped
                              ? <span className="px-2 py-0.5 bg-amber-100 text-amber-700 text-[10px] font-bold rounded-full">Yes</span>
                              : <span className="text-[10px] text-slate-300">—</span>}
                          </td>
                        </tr>
                      );
                    })}
                    {filteredColls.length === 0 && (
                      <tr><td colSpan={8}>
                        <div className="py-16 flex flex-col items-center">
                          <Inbox size={40} className="text-slate-200 mb-3" />
                          <p className="font-semibold text-slate-500">No collections found</p>
                        </div>
                      </td></tr>
                    )}
                  </tbody>
                </table>
                {pager}
                </>)}</Paged>
              </div>
            </div>
          </div>
        )}

        {/* ════ INDEXES ════ */}
        {tab === 'indexes' && (
          idxLoading ? (
            <div className="flex items-center justify-center py-20">
              <div className="w-8 h-8 border-4 border-green-200 border-t-green-600 rounded-full animate-spin" />
            </div>
          ) : (
            <div className="space-y-5">
              <div className="grid grid-cols-3 gap-3">
                <MetricCard label="Total Indexes"  value={allIndexes.length}    accent="green" />
                <MetricCard label="Unused Indexes" value={unusedIndexes.length} accent={unusedIndexes.length > 0 ? 'orange' : 'green'} sub="0 accesses since restart" />
                <MetricCard label="Namespaces"     value={[...new Set(allIndexes.map(i => i.ns))].length} accent="blue" />
              </div>

              {unusedIndexes.length > 0 && (
                <div className="bg-amber-50 border border-amber-200 rounded-2xl p-5">
                  <div className="flex items-center gap-2 mb-3">
                    <AlertTriangle className="text-amber-600" size={16} />
                    <span className="font-bold text-amber-800 text-sm">
                      {unusedIndexes.length} unused index{unusedIndexes.length > 1 ? 'es' : ''} detected
                    </span>
                  </div>
                  <p className="text-xs text-amber-700 mb-3">These indexes consume space and slow writes without benefiting reads.</p>
                  <div className="space-y-1.5">
                    {unusedIndexes.slice(0, 8).map((idx, i) => (
                      <div key={i} className="text-xs font-mono bg-white rounded-xl px-3 py-2 border border-amber-100 flex items-center gap-3 flex-wrap">
                        <span className="font-bold" style={{ color: C.dark }}>{idx.ns}</span>
                        <span className="text-slate-600">{idx.name}</span>
                        <span className="text-slate-400 max-w-[200px] truncate">{JSON.stringify(idx.key || {})}</span>
                        <span className="ml-auto text-[10px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-bold">0 accesses</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex items-center gap-3">
                <div className="relative">
                  <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input value={idxSearch} onChange={e => setIdxSearch(e.target.value)}
                    placeholder="Filter namespace or name…"
                    className="h-9 pl-8 pr-4 w-60 rounded-xl border border-slate-200 text-sm outline-none focus:border-green-400 bg-white" />
                </div>
                <button onClick={() => setShowUnused(v => !v)}
                  className={`h-9 px-4 rounded-xl border text-sm font-semibold transition-all ${
                    showUnused ? 'bg-amber-50 border-amber-300 text-amber-700' : 'bg-white border-slate-200 text-slate-600 hover:border-slate-300'
                  }`}>
                  {showUnused ? `Showing ${unusedIndexes.length} unused` : 'Show unused only'}
                </button>
                <span className="text-xs text-slate-400">{filteredIdxs.length} indexes</span>
              </div>

              <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
                <div className="overflow-x-auto">
                  <Paged rows={filteredIdxs} unit="indexes">{(pageRows, pager) => (<>
                  <table className="w-full text-xs">
                    <thead className="bg-slate-50 border-b border-slate-200">
                      <tr>
                        {['Namespace', 'Index Name', 'Keys', 'Unique', 'Sparse', 'TTL (s)', 'Size', 'Accesses', 'Last Used'].map(h => (
                          <th key={h} className="px-3 py-3 text-left text-[10px] font-bold text-slate-400 uppercase whitespace-nowrap">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {pageRows.map((idx, i) => (
                        <tr key={i} className={`border-t border-slate-100 hover:bg-slate-50 ${idx.unused ? 'bg-amber-50/40' : ''}`}>
                          <td className="px-3 py-2.5 font-bold" style={{ color: idx.unused ? C.orange : C.dark }}>
                            {idx.ns || `${idx.db}.${idx.collection}` || '—'}
                          </td>
                          <td className="px-3 py-2.5 font-mono text-xs">{idx.name}</td>
                          <td className="px-3 py-2.5 font-mono text-[10px] text-slate-500 max-w-[150px] truncate">
                            {JSON.stringify(idx.key || {})}
                          </td>
                          <td className="px-3 py-2.5">
                            {idx.unique
                              ? <span className="px-2 py-0.5 rounded-full text-[10px] font-bold" style={{ background: 'rgba(0,237,100,0.12)', color: C.dark }}>Yes</span>
                              : <span className="text-[10px] text-slate-300">—</span>}
                          </td>
                          <td className="px-3 py-2.5">
                            {idx.sparse
                              ? <span className="px-2 py-0.5 bg-blue-100 text-blue-700 text-[10px] font-bold rounded-full">Yes</span>
                              : <span className="text-[10px] text-slate-300">—</span>}
                          </td>
                          <td className="px-3 py-2.5 font-mono text-[10px]">{idx.expireAfterSeconds != null ? idx.expireAfterSeconds : '—'}</td>
                          <td className="px-3 py-2.5 font-mono">{idx.size ? fmtBytes(idx.size) : '—'}</td>
                          <td className={`px-3 py-2.5 font-bold font-mono ${idx.unused ? 'text-orange-500' : 'text-slate-700'}`}>{fmtNum(idx.accesses ?? 0)}</td>
                          <td className="px-3 py-2.5 text-[10px] text-slate-400 whitespace-nowrap">
                            {idx.last_access ? new Date(idx.last_access).toLocaleDateString() : '—'}
                          </td>
                        </tr>
                      ))}
                      {filteredIdxs.length === 0 && (
                        <tr><td colSpan={9}>
                          <div className="py-16 flex flex-col items-center">
                            <Key size={40} className="text-slate-200 mb-3" />
                            <p className="font-semibold text-slate-500">No indexes found</p>
                          </div>
                        </td></tr>
                      )}
                    </tbody>
                  </table>
                  {pager}
                  </>)}</Paged>
                </div>
              </div>
            </div>
          )
        )}

        {/* ════ INSIGHTS ════ */}
        {tab === 'insights' && (
          <div className="space-y-5 max-w-4xl">
            {analysisData && (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <MetricCard label="Collections"   value={analysisData.collections_count ?? allColls.length} accent="green" />
                <MetricCard label="Total Docs"    value={fmtNum(analysisData.total_documents ?? 0)} accent="blue" />
                <MetricCard label="Total Data"    value={`${(analysisData.total_data_mb ?? 0).toFixed(1)} MB`} accent="orange" />
                <MetricCard label="Index Space"   value={`${(analysisData.total_index_mb ?? 0).toFixed(1)} MB`} accent="purple" />
              </div>
            )}

            {(analysisData?.top_by_scan_ratio || []).length > 0 && (
              <div className="bg-white rounded-2xl border border-slate-200 p-5">
                <div className="flex items-center gap-2 mb-4">
                  <TrendingUp size={16} className="text-orange-500" />
                  <h3 className="font-bold text-slate-800 text-sm">Collections with High Scan Ratio</h3>
                  <span className="text-xs text-slate-400 ml-auto">Higher = more docs scanned per returned doc</span>
                </div>
                <div className="space-y-2">
                  {(analysisData.top_by_scan_ratio || []).slice(0, 8).map((c, i) => (
                    <div key={i}
                      className={`flex items-center gap-3 p-3 rounded-xl border ${
                        c.scan_ratio > 10 ? 'bg-red-50 border-red-100'
                        : c.scan_ratio > 3  ? 'bg-orange-50 border-orange-100'
                        : 'bg-slate-50 border-slate-100'
                      }`}>
                      <Database size={14} className={c.scan_ratio > 10 ? 'text-red-500' : c.scan_ratio > 3 ? 'text-orange-500' : 'text-slate-400'} />
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-bold text-slate-700 truncate">{c.namespace || c.ns}</p>
                        <p className="text-[10px] text-slate-400">Docs: {fmtNum(c.count || 0)}</p>
                      </div>
                      <div className="text-right">
                        <p className={`text-sm font-black ${c.scan_ratio > 10 ? 'text-red-600' : c.scan_ratio > 3 ? 'text-orange-600' : 'text-slate-600'}`}>
                          {(c.scan_ratio || 0).toFixed(1)}×
                        </p>
                        <p className="text-[10px] text-slate-400">scan ratio</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="bg-white rounded-2xl border border-slate-200 p-6">
              <h3 className="font-bold text-slate-800 mb-4">Recommendations</h3>
              <div className="space-y-3">
                {unusedIndexes.length > 0 && (
                  <div className="flex items-start gap-3 p-3 bg-amber-50 border border-amber-200 rounded-xl">
                    <AlertTriangle size={16} className="text-amber-500 flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="font-semibold text-amber-800 text-sm">{unusedIndexes.length} unused index{unusedIndexes.length > 1 ? 'es' : ''} waste space</p>
                      <p className="text-xs text-amber-600 mt-0.5">Drop with: <code className="font-mono bg-white px-1 rounded">db.collection.dropIndex("indexName")</code></p>
                    </div>
                  </div>
                )}
                {allColls.filter(c => (c.nindexes || 0) <= 1 && !c.capped && (c.count || 0) > 1000).length > 0 && (
                  <div className="flex items-start gap-3 p-3 bg-blue-50 border border-blue-200 rounded-xl">
                    <Info size={16} className="text-blue-500 flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="font-semibold text-blue-800 text-sm">
                        {allColls.filter(c => (c.nindexes || 0) <= 1 && !c.capped && (c.count || 0) > 1000).length} large collections with only _id index
                      </p>
                      <p className="text-xs text-blue-600 mt-0.5">Add compound indexes on frequently queried fields to avoid full collection scans.</p>
                    </div>
                  </div>
                )}
                <div className="flex items-start gap-3 p-3 bg-green-50 border border-green-200 rounded-xl">
                  <CheckCircle2 size={16} className="text-green-500 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="font-semibold text-green-800 text-sm">Use explain() to verify index usage</p>
                    <p className="text-xs text-green-600 mt-0.5">
                      Run <code className="font-mono bg-white px-1 rounded">db.collection.find(query).explain("executionStats")</code> — look for IXSCAN vs COLLSCAN.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
