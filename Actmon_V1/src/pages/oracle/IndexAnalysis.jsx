import React, { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft, RefreshCw, Layers, AlertTriangle, CheckCircle2,
  Search, Copy, Info, Database, Zap, BarChart2,
  ChevronDown, ChevronRight, TrendingDown,
} from 'lucide-react';
import client from '../../api/client';
import PageHeader from '../../components/layout/PageHeader';

const fetchIndexAnalysis = (id) =>
  client.get(`/connections/oracle/${id}/oracle-index-analysis`).then(r => r.data);

/* ── helpers ── */
function CopyBtn({ text }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-slate-100 hover:bg-slate-200 text-slate-600 text-xs transition-all flex-shrink-0"
    >
      <Copy size={11} />
      {copied ? 'Copied!' : 'Copy'}
    </button>
  );
}

function Spinner() {
  return (
    <div className="flex items-center justify-center py-20">
      <div className="w-10 h-10 border-4 border-violet-200 border-t-violet-600 rounded-full animate-spin" />
    </div>
  );
}

function Empty({ icon: Icon = CheckCircle2, msg, good = false }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <Icon size={32} className={good ? 'text-green-400 mb-3' : 'text-slate-300 mb-3'} />
      <p className={`font-semibold ${good ? 'text-green-700' : 'text-slate-500'}`}>{msg}</p>
    </div>
  );
}

function ErrBox({ msg }) {
  return (
    <div className="p-5">
      <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-700 flex items-start gap-2">
        <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
        <span>{msg}</span>
      </div>
    </div>
  );
}

function ExpandRow({ children, detail }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr className="border-t border-slate-100 hover:bg-slate-50 cursor-pointer" onClick={() => setOpen(o => !o)}>
        <td className="px-3 py-2 w-6">
          {open ? <ChevronDown size={13} className="text-slate-400" /> : <ChevronRight size={13} className="text-slate-400" />}
        </td>
        {children}
      </tr>
      {open && (
        <tr className="border-t border-slate-100 bg-slate-50">
          <td colSpan={99} className="px-5 py-3">
            {detail}
          </td>
        </tr>
      )}
    </>
  );
}

/* ── Header ── */
function Header({ id, refetch }) {
  return (
    <PageHeader
      icon={Layers}
      title="Oracle Index Analysis"
      subtitle="All Indexes · Fragmented Indexes · Rebuild Recommendations"
      accent="oracle"
      backTo={`/oracle-dashboard/${id}`}
      crumbs={[{ label: 'Databases', to: '/databases' }, { label: 'Oracle', to: `/oracle-dashboard/${id}` }, { label: 'Index Analysis' }]}
      actions={(
        <button onClick={refetch}
          className="flex items-center gap-2 px-4 py-1.5 bg-white/10 hover:bg-white/20 border border-white/20 rounded-lg text-sm font-semibold text-white">
          <RefreshCw size={13} /> Refresh
        </button>
      )}
    />
  );
}

/* ── Main page ── */
export default function IndexAnalysis() {
  const { id } = useParams();
  const [tab, setTab]       = useState('all');
  const [search, setSearch] = useState('');

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['oracleIndexAnalysis', id],
    queryFn: () => fetchIndexAnalysis(id),
    retry: false,
    refetchInterval: 60000,
  });

  if (isLoading) return (
    <div className="min-h-full bg-brand-bg">
      <Header id={id} refetch={() => {}} />
      <Spinner />
    </div>
  );

  if (error) return (
    <div className="min-h-full bg-brand-bg">
      <Header id={id} refetch={refetch} />
      <div className="py-6">
        <div className="bg-red-50 border border-red-200 rounded-2xl p-5 max-w-lg">
          <AlertTriangle className="text-red-500 mb-2" size={18} />
          <p className="font-bold text-red-700">Failed to load index analysis</p>
          <p className="text-sm text-red-600 mt-1">{error.message}</p>
          <button onClick={refetch} className="mt-3 px-4 py-2 bg-red-600 text-white rounded-xl text-sm font-bold">Retry</button>
        </div>
      </div>
    </div>
  );

  const allIndexes       = data?.all_indexes        || data?.indexes        || [];
  const fragIndexes      = data?.fragmented_indexes || data?.fragmented     || [];
  const rebuildRecs      = data?.rebuild_recommendations || data?.rebuilds  || [];

  const TABS = [
    {
      id: 'all',
      label: 'All Indexes',
      count: allIndexes.length,
      color: 'bg-slate-100 text-slate-600',
      icon: Database,
    },
    {
      id: 'fragmented',
      label: 'Fragmented Indexes',
      count: fragIndexes.length,
      color: fragIndexes.length ? 'bg-orange-100 text-orange-700' : 'bg-green-100 text-green-700',
      icon: TrendingDown,
    },
    {
      id: 'rebuild',
      label: 'Index Rebuild Recommendations',
      count: rebuildRecs.length,
      color: rebuildRecs.length ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700',
      icon: Zap,
    },
  ];

  const q = search.toLowerCase();

  return (
    <div className="min-h-full bg-brand-bg">
      <Header id={id} refetch={refetch} />

      <div className="py-5 space-y-5">

        {/* Summary strip */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="bg-white rounded-2xl border border-slate-200 p-4">
            <p className="text-[10px] font-bold text-slate-400 uppercase">Total Indexes</p>
            <p className="text-2xl font-black text-slate-700 mt-1">{allIndexes.length.toLocaleString()}</p>
          </div>
          <div className="bg-white rounded-2xl border border-slate-200 p-4">
            <p className="text-[10px] font-bold text-slate-400 uppercase">Fragmented</p>
            <p className={`text-2xl font-black mt-1 ${fragIndexes.length ? 'text-orange-600' : 'text-green-600'}`}>
              {fragIndexes.length.toLocaleString()}
            </p>
          </div>
          <div className="bg-white rounded-2xl border border-slate-200 p-4">
            <p className="text-[10px] font-bold text-slate-400 uppercase">Rebuild Candidates</p>
            <p className={`text-2xl font-black mt-1 ${rebuildRecs.length ? 'text-red-600' : 'text-green-600'}`}>
              {rebuildRecs.length.toLocaleString()}
            </p>
          </div>
        </div>

        {/* Tabs */}
        <div className="bg-white rounded-2xl border border-slate-200">
          <div className="flex gap-1 p-3 border-b border-slate-100 flex-wrap items-center">
            {TABS.map(t => (
              <button key={t.id} onClick={() => setTab(t.id)}
                className={`flex items-center gap-1.5 px-3 h-8 rounded-lg text-xs font-bold transition-all ${
                  tab === t.id ? 'bg-slate-900 text-white' : 'border border-slate-200 text-slate-600 hover:bg-slate-50'
                }`}>
                <t.icon size={12} />
                {t.label}
                <span className={`px-1.5 py-0.5 rounded-full text-[9px] font-black ${tab === t.id ? 'bg-white/20 text-white' : t.color}`}>
                  {t.count}
                </span>
              </button>
            ))}
            <div className="relative ml-auto">
              <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Filter…"
                className="pl-7 pr-3 h-8 text-xs rounded-xl border border-slate-200 outline-none focus:border-violet-500 w-44"
              />
            </div>
          </div>

          {tab === 'all'        && <AllIndexesTab    indexes={allIndexes}   q={q} />}
          {tab === 'fragmented' && <FragmentedTab    indexes={fragIndexes}  q={q} />}
          {tab === 'rebuild'    && <RebuildTab       indexes={rebuildRecs}  q={q} />}
        </div>

      </div>
    </div>
  );
}

/* ── All Indexes Tab ── */
function AllIndexesTab({ indexes, q }) {
  const [ownerFilter, setOwnerFilter] = useState('ALL');
  const owners = ['ALL', ...new Set(indexes.map(i => i.owner).filter(Boolean))];

  const filtered = indexes.filter(idx => {
    const okOwner = ownerFilter === 'ALL' || idx.owner === ownerFilter;
    const okQ     = !q
      || (idx.index_name  || '').toLowerCase().includes(q)
      || (idx.table_name  || '').toLowerCase().includes(q)
      || (idx.owner       || '').toLowerCase().includes(q)
      || (idx.index_type  || '').toLowerCase().includes(q);
    return okOwner && okQ;
  });

  if (!filtered.length) return <Empty icon={Database} msg={indexes.length ? 'No matches' : 'No indexes found'} />;

  return (
    <div>
      <div className="px-4 py-2 flex gap-2 flex-wrap border-b border-slate-100 items-center">
        {owners.map(o => (
          <button key={o} onClick={() => setOwnerFilter(o)}
            className={`px-2 h-6 rounded-md text-[10px] font-bold transition-all ${
              ownerFilter === o ? 'bg-slate-900 text-white' : 'border border-slate-200 text-slate-500 hover:bg-slate-50'
            }`}>{o}</button>
        ))}
        <span className="ml-auto text-xs text-slate-400 self-center">{filtered.length} indexes</span>
      </div>
      <div className="overflow-auto max-h-[540px]">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-white border-b border-slate-100 z-10">
            <tr>
              <th className="px-3 py-2 text-left text-[11px] font-bold text-slate-400">Owner</th>
              <th className="px-3 py-2 text-left text-[11px] font-bold text-slate-400">Table</th>
              <th className="px-3 py-2 text-left text-[11px] font-bold text-slate-400">Index Name</th>
              <th className="px-3 py-2 text-left text-[11px] font-bold text-slate-400">Type</th>
              <th className="px-3 py-2 text-left text-[11px] font-bold text-slate-400">Unique</th>
              <th className="px-3 py-2 text-left text-[11px] font-bold text-slate-400">Status</th>
              <th className="px-3 py-2 text-right text-[11px] font-bold text-slate-400">Num Rows</th>
              <th className="px-3 py-2 text-right text-[11px] font-bold text-slate-400">Leaf Blocks</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((idx, i) => (
              <tr key={i} className="border-t border-slate-50 hover:bg-slate-50">
                <td className="px-3 py-2 text-slate-500 font-mono">{idx.owner || '—'}</td>
                <td className="px-3 py-2 font-mono text-slate-700">{idx.table_name || '—'}</td>
                <td className="px-3 py-2 font-mono font-bold text-slate-700">{idx.index_name || '—'}</td>
                <td className="px-3 py-2">
                  <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold ${
                    idx.index_type === 'BITMAP'   ? 'bg-purple-100 text-purple-700' :
                    idx.index_type === 'FUNCTION-BASED NORMAL' ? 'bg-blue-100 text-blue-700' :
                    'bg-slate-100 text-slate-500'
                  }`}>{idx.index_type || 'NORMAL'}</span>
                </td>
                <td className="px-3 py-2">
                  {idx.uniqueness === 'UNIQUE'
                    ? <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-cyan-50 text-cyan-700">UNIQUE</span>
                    : <span className="text-slate-400 text-[10px]">—</span>}
                </td>
                <td className="px-3 py-2">
                  <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold ${
                    idx.status === 'VALID'   ? 'bg-green-100 text-green-700' :
                    idx.status === 'UNUSABLE'? 'bg-red-100 text-red-700' :
                    idx.status === 'N/A'     ? 'bg-slate-100 text-slate-400' :
                    'bg-amber-100 text-amber-700'
                  }`}>{idx.status || '—'}</span>
                </td>
                <td className="px-3 py-2 text-right font-mono text-slate-500">
                  {idx.num_rows !== null && idx.num_rows !== undefined ? Number(idx.num_rows).toLocaleString() : '—'}
                </td>
                <td className="px-3 py-2 text-right font-mono text-slate-500">
                  {idx.leaf_blocks !== null && idx.leaf_blocks !== undefined ? Number(idx.leaf_blocks).toLocaleString() : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ── Fragmented Indexes Tab ── */
function FragmentedTab({ indexes, q }) {
  const filtered = indexes.filter(idx =>
    !q
    || (idx.index_name  || '').toLowerCase().includes(q)
    || (idx.owner       || '').toLowerCase().includes(q)
    || (idx.table_name  || '').toLowerCase().includes(q)
  );

  if (!filtered.length) return (
    <Empty
      icon={CheckCircle2}
      msg={indexes.length ? 'No matches' : 'No fragmented indexes detected'}
      good={!indexes.length}
    />
  );

  return (
    <div className="overflow-auto">
      <div className="px-4 py-2 bg-orange-50 border-b border-orange-100 flex items-center gap-2 text-xs text-orange-700">
        <TrendingDown size={12} />
        Fragmented indexes degrade query performance. Rebuild indexes with high fragmentation.
      </div>
      <table className="w-full text-xs">
        <thead className="bg-white border-b border-slate-100">
          <tr>
            <th className="w-8 px-3 py-2" />
            <th className="px-3 py-2 text-left text-[11px] font-bold text-slate-400">Owner</th>
            <th className="px-3 py-2 text-left text-[11px] font-bold text-slate-400">Table</th>
            <th className="px-3 py-2 text-left text-[11px] font-bold text-slate-400">Index Name</th>
            <th className="px-3 py-2 text-right text-[11px] font-bold text-slate-400">B-Level (Height)</th>
            <th className="px-3 py-2 text-right text-[11px] font-bold text-slate-400">Leaf Blocks</th>
            <th className="px-3 py-2 text-right text-[11px] font-bold text-slate-400">Fragmentation %</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((idx, i) => {
            const fragPct = parseFloat(idx.fragmentation_pct) || 0;
            const rebuildSql = `ALTER INDEX ${idx.owner || 'OWNER'}.${idx.index_name} REBUILD ONLINE;`;
            return (
              <ExpandRow key={i}
                detail={
                  <div className="space-y-3">
                    <div>
                      <p className="text-xs font-bold text-slate-600 mb-2">Rebuild Statement</p>
                      <div className="flex items-start gap-2">
                        <pre className="flex-1 bg-white border border-slate-200 rounded-xl p-3 text-xs font-mono text-violet-700 whitespace-pre-wrap">
                          {rebuildSql}
                        </pre>
                        <CopyBtn text={rebuildSql} />
                      </div>
                    </div>
                    <div className="bg-amber-50 border border-amber-200 rounded-lg p-2 text-xs text-amber-700 flex gap-2">
                      <Info size={12} className="flex-shrink-0 mt-0.5" />
                      <span>
                        REBUILD ONLINE keeps the index accessible during the rebuild. For very large indexes,
                        schedule during low-traffic periods. Ensure sufficient TEMP tablespace.
                      </span>
                    </div>
                  </div>
                }>
                <td className="px-3 py-2 font-mono text-slate-500">{idx.owner || '—'}</td>
                <td className="px-3 py-2 font-mono text-slate-600">{idx.table_name || '—'}</td>
                <td className="px-3 py-2 font-mono font-bold text-orange-700">{idx.index_name || '—'}</td>
                <td className="px-3 py-2 text-right font-mono text-slate-600">{idx.blevel ?? '—'}</td>
                <td className="px-3 py-2 text-right font-mono text-slate-600">
                  {idx.leaf_blocks !== null && idx.leaf_blocks !== undefined ? Number(idx.leaf_blocks).toLocaleString() : '—'}
                </td>
                <td className="px-3 py-2 text-right">
                  <span className={`font-black text-xs ${fragPct >= 30 ? 'text-red-600' : fragPct >= 15 ? 'text-orange-500' : 'text-amber-600'}`}>
                    {fragPct.toFixed(1)}%
                  </span>
                </td>
              </ExpandRow>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ── Rebuild Recommendations Tab ── */
function RebuildTab({ indexes, q }) {
  const filtered = indexes.filter(idx =>
    !q
    || (idx.index_name  || '').toLowerCase().includes(q)
    || (idx.owner       || '').toLowerCase().includes(q)
    || (idx.table_name  || '').toLowerCase().includes(q)
  );

  if (!filtered.length) return (
    <Empty
      icon={CheckCircle2}
      msg={indexes.length ? 'No matches' : 'No index rebuild recommendations'}
      good={!indexes.length}
    />
  );

  return (
    <div className="overflow-auto">
      <div className="px-4 py-2 bg-red-50 border-b border-red-100 flex items-center gap-2 text-xs text-red-700">
        <Zap size={12} />
        These indexes are recommended for rebuild based on fragmentation level, B-tree height, or UNUSABLE status.
      </div>
      <table className="w-full text-xs">
        <thead className="bg-white border-b border-slate-100">
          <tr>
            <th className="w-8 px-3 py-2" />
            <th className="px-3 py-2 text-left text-[11px] font-bold text-slate-400">Owner</th>
            <th className="px-3 py-2 text-left text-[11px] font-bold text-slate-400">Table</th>
            <th className="px-3 py-2 text-left text-[11px] font-bold text-slate-400">Index Name</th>
            <th className="px-3 py-2 text-left text-[11px] font-bold text-slate-400">Type</th>
            <th className="px-3 py-2 text-left text-[11px] font-bold text-slate-400">Status</th>
            <th className="px-3 py-2 text-right text-[11px] font-bold text-slate-400">Leaf Blocks</th>
            <th className="px-3 py-2 text-right text-[11px] font-bold text-slate-400">Num Rows</th>
            <th className="px-3 py-2 text-right text-[11px] font-bold text-slate-400">Fragmentation %</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((idx, i) => {
            const fragPct    = parseFloat(idx.fragmentation_pct) || 0;
            const rebuildSql = `ALTER INDEX ${idx.owner || 'OWNER'}.${idx.index_name} REBUILD ONLINE;`;
            return (
              <ExpandRow key={i}
                detail={
                  <div className="space-y-3">
                    <div>
                      <p className="text-xs font-bold text-slate-600 mb-2">Rebuild Statement</p>
                      <div className="flex items-start gap-2">
                        <pre className="flex-1 bg-white border border-slate-200 rounded-xl p-3 text-xs font-mono text-violet-700 whitespace-pre-wrap">
                          {rebuildSql}
                        </pre>
                        <CopyBtn text={rebuildSql} />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                      {[
                        { label: 'Owner',        value: idx.owner         || '—' },
                        { label: 'Table',        value: idx.table_name    || '—' },
                        { label: 'Index Type',   value: idx.index_type    || 'NORMAL' },
                        { label: 'Uniqueness',   value: idx.uniqueness    || '—' },
                        { label: 'Status',       value: idx.status        || '—' },
                        { label: 'B-Level',      value: idx.blevel        ?? '—' },
                        { label: 'Leaf Blocks',  value: idx.leaf_blocks !== null && idx.leaf_blocks !== undefined ? Number(idx.leaf_blocks).toLocaleString() : '—' },
                        { label: 'Num Rows',     value: idx.num_rows !== null && idx.num_rows !== undefined ? Number(idx.num_rows).toLocaleString() : '—' },
                      ].map(({ label, value }) => (
                        <div key={label} className="bg-white border border-slate-200 rounded-lg p-2">
                          <p className="text-[9px] font-bold text-slate-400 uppercase">{label}</p>
                          <p className="font-semibold text-slate-700 mt-0.5 break-all text-xs">{value}</p>
                        </div>
                      ))}
                    </div>
                    <div className="bg-amber-50 border border-amber-200 rounded-lg p-2 text-xs text-amber-700 flex gap-2">
                      <Info size={12} className="flex-shrink-0 mt-0.5" />
                      <span>
                        Run <code className="font-mono">ANALYZE INDEX {idx.owner || 'OWNER'}.{idx.index_name} VALIDATE STRUCTURE;</code> first
                        to get accurate fragmentation statistics before rebuilding.
                      </span>
                    </div>
                  </div>
                }>
                <td className="px-3 py-2 font-mono text-slate-500">{idx.owner || '—'}</td>
                <td className="px-3 py-2 font-mono text-slate-600">{idx.table_name || '—'}</td>
                <td className="px-3 py-2 font-mono font-bold text-red-700">{idx.index_name || '—'}</td>
                <td className="px-3 py-2">
                  <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold ${
                    idx.index_type === 'BITMAP' ? 'bg-purple-100 text-purple-700' : 'bg-slate-100 text-slate-500'
                  }`}>{idx.index_type || 'NORMAL'}</span>
                </td>
                <td className="px-3 py-2">
                  <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold ${
                    idx.status === 'UNUSABLE' ? 'bg-red-100 text-red-700' :
                    idx.status === 'VALID'    ? 'bg-green-100 text-green-700' :
                    'bg-amber-100 text-amber-700'
                  }`}>{idx.status || '—'}</span>
                </td>
                <td className="px-3 py-2 text-right font-mono text-slate-500">
                  {idx.leaf_blocks !== null && idx.leaf_blocks !== undefined ? Number(idx.leaf_blocks).toLocaleString() : '—'}
                </td>
                <td className="px-3 py-2 text-right font-mono text-slate-500">
                  {idx.num_rows !== null && idx.num_rows !== undefined ? Number(idx.num_rows).toLocaleString() : '—'}
                </td>
                <td className="px-3 py-2 text-right">
                  {fragPct > 0
                    ? <span className={`font-black text-xs ${fragPct >= 30 ? 'text-red-600' : fragPct >= 15 ? 'text-orange-500' : 'text-amber-600'}`}>
                        {fragPct.toFixed(1)}%
                      </span>
                    : <span className="text-slate-400 text-xs">—</span>
                  }
                </td>
              </ExpandRow>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
