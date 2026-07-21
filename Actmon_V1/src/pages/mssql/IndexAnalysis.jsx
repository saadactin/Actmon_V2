import React, { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft, RefreshCw, Layers, AlertTriangle, CheckCircle2,
  Trash2, Zap, Info, Copy, Search, ChevronDown, ChevronRight,
  TrendingUp, Database,
} from 'lucide-react';
import client from '../../api/client';
import PageHeader from '../../components/layout/PageHeader';

const fetchIndexAnalysis = (id) =>
  client.get(`/connections/mssql/${id}/mssql-index-analysis`).then(r => r.data);

/* ── Helpers ── */
function fmtNum(n) {
  const v = Number(n);
  if (!v && v !== 0) return '—';
  return v >= 1_000_000
    ? `${(v / 1_000_000).toFixed(1)}M`
    : v >= 1_000
    ? `${(v / 1_000).toFixed(1)}K`
    : v.toLocaleString();
}

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
          {open
            ? <ChevronDown size={13} className="text-slate-400" />
            : <ChevronRight size={13} className="text-slate-400" />}
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

function Spinner() {
  return (
    <div className="flex items-center justify-center py-20">
      <div className="w-10 h-10 border-4 border-violet-200 border-t-violet-600 rounded-full animate-spin" />
    </div>
  );
}

/* ── Header — standard PageHeader band (breadcrumb + gradient, flush layout) ── */
function Header({ id, refetch }) {
  return (
    <PageHeader
      icon={Layers}
      title="MSSQL Index Analysis"
      subtitle="Unused · Missing · All Indexes — sys.dm_db_index_usage_stats & sys.dm_db_missing_index_details"
      accent="mssql"
      backTo={`/mssql-dashboard/${id}`}
      crumbs={[{ label: 'Databases', to: '/databases' }, { label: 'SQL Server', to: `/mssql-dashboard/${id}` }, { label: 'Index Analysis' }]}
      actions={(
        <button onClick={refetch}
          className="flex items-center gap-2 px-4 py-1.5 bg-white/10 hover:bg-white/20 border border-white/20 rounded-lg text-sm font-semibold text-white">
          <RefreshCw size={13} /> Refresh
        </button>
      )}
    />
  );
}

/* ── Unused Indexes Tab ── */
function UnusedTab({ unused, q }) {
  const filtered = unused.filter(u =>
    !q || (u.table_name || '').toLowerCase().includes(q) || (u.index_name || '').toLowerCase().includes(q)
  );
  if (!filtered.length)
    return <Empty icon={CheckCircle2} msg={unused.length ? 'No matches' : 'No unused indexes detected'} good={!unused.length} />;

  return (
    <div className="overflow-auto">
      <div className="px-4 py-2 bg-red-50 border-b border-red-100 flex items-center gap-2 text-xs text-red-700">
        <AlertTriangle size={12} /> Unused indexes waste write performance and storage. Verify before dropping.
      </div>
      <table className="w-full text-xs">
        <thead className="bg-white border-b border-slate-100">
          <tr>
            <th className="w-8 px-3 py-2" />
            <th className="px-3 py-2 text-left text-[11px] font-bold text-slate-400">Table</th>
            <th className="px-3 py-2 text-left text-[11px] font-bold text-slate-400">Index Name</th>
            <th className="px-3 py-2 text-left text-[11px] font-bold text-slate-400">Type</th>
            <th className="px-3 py-2 text-center text-[11px] font-bold text-slate-400">Unique</th>
            <th className="px-3 py-2 text-right text-[11px] font-bold text-slate-400">Total Reads</th>
            <th className="px-3 py-2 text-right text-[11px] font-bold text-slate-400">Total Writes</th>
            <th className="px-3 py-2 text-left text-[11px] font-bold text-slate-400">Action</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((u, i) => {
            const dropStmt = `DROP INDEX ${u.table_name}.${u.index_name}`;
            return (
              <ExpandRow key={i}
                detail={
                  <div className="space-y-2">
                    <p className="text-xs font-bold text-slate-600">Drop Statement</p>
                    <div className="flex items-start gap-2">
                      <pre className="flex-1 bg-white border border-slate-200 rounded-lg px-3 py-2 text-xs font-mono text-red-700 whitespace-pre-wrap">
                        {dropStmt}
                      </pre>
                      <CopyBtn text={dropStmt} />
                    </div>
                    <div className="bg-amber-50 border border-amber-200 rounded-lg p-2 text-xs text-amber-700 flex gap-2">
                      <Info size={12} className="flex-shrink-0 mt-0.5" />
                      <span>
                        Note: sys.dm_db_index_usage_stats counters reset on SQL Server restart.
                        Confirm usage over a representative time window before dropping.
                      </span>
                    </div>
                  </div>
                }>
                <td className="px-3 py-2 font-mono text-slate-700">{u.table_name || '—'}</td>
                <td className="px-3 py-2 font-mono text-red-700 font-bold">{u.index_name || '—'}</td>
                <td className="px-3 py-2 text-slate-500">
                  <span className="px-2 py-0.5 rounded-full text-[9px] font-bold bg-slate-100 text-slate-600">
                    {u.type_desc || '—'}
                  </span>
                </td>
                <td className="px-3 py-2 text-center">
                  {u.is_unique
                    ? <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-cyan-50 text-cyan-700">UNIQUE</span>
                    : <span className="text-slate-300">—</span>
                  }
                </td>
                <td className="px-3 py-2 text-right font-mono text-slate-500">{fmtNum(u.total_reads)}</td>
                <td className="px-3 py-2 text-right font-mono text-slate-500">{fmtNum(u.total_writes)}</td>
                <td className="px-3 py-2">
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-red-50 text-red-600 border border-red-100 inline-flex items-center gap-1">
                    <Trash2 size={9} /> Drop
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

/* ── Missing Indexes Tab ── */
function MissingTab({ missing, q }) {
  const filtered = missing.filter(m =>
    !q || (m.table_name || '').toLowerCase().includes(q) || (m.suggested_columns || '').toLowerCase().includes(q)
  );
  if (!filtered.length)
    return <Empty icon={CheckCircle2} msg={missing.length ? 'No matches' : 'No missing index candidates detected'} good={!missing.length} />;

  return (
    <div className="overflow-auto">
      <div className="px-4 py-2 bg-amber-50 border-b border-amber-100 flex items-center gap-2 text-xs text-amber-700">
        <Zap size={12} /> Missing indexes recommended by SQL Server query optimizer. Adding these can significantly improve performance.
      </div>
      <table className="w-full text-xs">
        <thead className="bg-white border-b border-slate-100">
          <tr>
            <th className="w-8 px-3 py-2" />
            <th className="px-3 py-2 text-left text-[11px] font-bold text-slate-400">Table</th>
            <th className="px-3 py-2 text-left text-[11px] font-bold text-slate-400">Suggested Columns</th>
            <th className="px-3 py-2 text-right text-[11px] font-bold text-slate-400">Improvement %</th>
            <th className="px-3 py-2 text-right text-[11px] font-bold text-slate-400">User Seeks</th>
            <th className="px-3 py-2 text-right text-[11px] font-bold text-slate-400">User Scans</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((m, i) => {
            const tableName   = m.table_name || 'table_name';
            const suggestedCol = m.suggested_columns || 'col1';
            const createStmt  = `CREATE INDEX IX_${tableName.replace(/[\[\].\s]/g, '_')}_${suggestedCol.replace(/[\[\],\s]/g, '_').slice(0, 20)}\nON ${tableName} (${suggestedCol})`;
            const improvement = m.improvement_measure != null ? Number(m.improvement_measure).toFixed(1) : null;
            return (
              <ExpandRow key={i}
                detail={
                  <div className="space-y-3">
                    <div>
                      <p className="text-xs font-bold text-slate-600 mb-1">Suggested CREATE INDEX Statement</p>
                      <div className="flex items-start gap-2">
                        <pre className="flex-1 bg-white border border-slate-200 rounded-lg px-3 py-2 text-xs font-mono text-indigo-700 whitespace-pre-wrap">
                          {createStmt}
                        </pre>
                        <CopyBtn text={createStmt} />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                      {[
                        { label: 'Improvement Measure', value: improvement != null ? `${improvement}%` : '—' },
                        { label: 'User Seeks',          value: fmtNum(m.user_seeks) },
                        { label: 'User Scans',          value: fmtNum(m.user_scans) },
                        { label: 'Avg Total User Cost', value: m.avg_total_user_cost != null ? Number(m.avg_total_user_cost).toFixed(2) : '—' },
                      ].map(({ label, value }) => (
                        <div key={label} className="bg-white border border-slate-200 rounded-xl p-2.5">
                          <p className="text-[9px] font-bold text-slate-400 uppercase tracking-wide">{label}</p>
                          <p className="font-bold text-sm mt-0.5 text-slate-800">{value}</p>
                        </div>
                      ))}
                    </div>
                    <div className="bg-blue-50 border border-blue-100 rounded-lg p-2 text-xs text-blue-700 flex gap-2">
                      <Info size={12} className="flex-shrink-0 mt-0.5" />
                      <span>
                        Review the suggested columns and include columns before creating. Adjust index name to match your naming convention.
                      </span>
                    </div>
                  </div>
                }>
                <td className="px-3 py-2 font-mono font-bold text-amber-700">{m.table_name || '—'}</td>
                <td className="px-3 py-2 font-mono text-slate-600 max-w-xs truncate" title={m.suggested_columns}>
                  {m.suggested_columns || '—'}
                </td>
                <td className="px-3 py-2 text-right">
                  {improvement != null ? (
                    <span className={`font-bold ${Number(improvement) > 50 ? 'text-green-700' : 'text-blue-600'}`}>
                      {improvement}%
                    </span>
                  ) : '—'}
                </td>
                <td className="px-3 py-2 text-right font-mono text-slate-600">{fmtNum(m.user_seeks)}</td>
                <td className="px-3 py-2 text-right font-mono text-slate-600">{fmtNum(m.user_scans)}</td>
              </ExpandRow>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ── All Indexes Tab ── */
function AllIndexesTab({ indexes, q }) {
  const filtered = indexes.filter(idx =>
    !q
    || (idx.table_name || '').toLowerCase().includes(q)
    || (idx.index_name || '').toLowerCase().includes(q)
  );

  if (!filtered.length)
    return <Empty icon={Database} msg={indexes.length ? 'No matches' : 'No index data found'} />;

  return (
    <div className="overflow-auto max-h-[600px]">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-white border-b border-slate-100 z-10">
          <tr>
            <th className="px-3 py-2 text-left text-[11px] font-bold text-slate-400">Table</th>
            <th className="px-3 py-2 text-left text-[11px] font-bold text-slate-400">Index Name</th>
            <th className="px-3 py-2 text-left text-[11px] font-bold text-slate-400">Type</th>
            <th className="px-3 py-2 text-center text-[11px] font-bold text-slate-400">Unique</th>
            <th className="px-3 py-2 text-right text-[11px] font-bold text-slate-400">Total Reads</th>
            <th className="px-3 py-2 text-right text-[11px] font-bold text-slate-400">Total Writes</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((idx, i) => (
            <tr key={i} className="border-t border-slate-50 hover:bg-slate-50">
              <td className="px-3 py-1.5 font-mono text-slate-700">{idx.table_name || '—'}</td>
              <td className="px-3 py-1.5 font-mono font-bold text-slate-800">
                {(idx.index_name || '').includes('PK_') || idx.index_name === 'PRIMARY'
                  ? <span className="text-cyan-700">{idx.index_name}</span>
                  : idx.index_name || '—'}
              </td>
              <td className="px-3 py-1.5">
                <span className="px-2 py-0.5 rounded-full text-[9px] font-bold bg-slate-100 text-slate-600">
                  {idx.type_desc || '—'}
                </span>
              </td>
              <td className="px-3 py-1.5 text-center">
                {idx.is_unique
                  ? <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-cyan-50 text-cyan-700">UNIQUE</span>
                  : <span className="text-slate-300">—</span>
                }
              </td>
              <td className="px-3 py-1.5 text-right font-mono text-slate-500">{fmtNum(idx.total_reads)}</td>
              <td className="px-3 py-1.5 text-right font-mono text-slate-500">{fmtNum(idx.total_writes)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ── Main Page ── */
export default function MSSQLIndexAnalysis() {
  const { id } = useParams();
  const [tab, setTab]       = useState('unused');
  const [search, setSearch] = useState('');

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['mssqlIndexAnalysis', id],
    queryFn:  () => fetchIndexAnalysis(id),
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
      <div className="p-6">
        <div className="bg-red-50 border border-red-200 rounded-2xl p-5 max-w-lg">
          <AlertTriangle className="text-red-500 mb-2" size={18} />
          <p className="font-bold text-red-700">Failed to load index analysis</p>
          <p className="text-sm text-red-600 mt-1">{error.message}</p>
          <button onClick={refetch} className="mt-3 px-4 py-2 bg-red-600 text-white rounded-xl text-sm font-bold hover:bg-red-700">Retry</button>
        </div>
      </div>
    </div>
  );

  const unused  = Array.isArray(data?.unused_indexes)  ? data.unused_indexes  : [];
  const missing = Array.isArray(data?.missing_indexes) ? data.missing_indexes : [];
  const allIdx  = Array.isArray(data?.all_indexes)     ? data.all_indexes
                : Array.isArray(data?.indexes)          ? data.indexes
                : [];

  const TABS = [
    {
      id: 'unused',
      label: 'Unused Indexes',
      count: unused.length,
      color: unused.length ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700',
    },
    {
      id: 'missing',
      label: 'Missing Indexes',
      count: missing.length,
      color: missing.length ? 'bg-amber-100 text-amber-700' : 'bg-green-100 text-green-700',
    },
    {
      id: 'all',
      label: 'All Indexes',
      count: allIdx.length,
      color: 'bg-slate-100 text-slate-600',
    },
  ];

  const q = search.toLowerCase();

  return (
    <div className="min-h-full bg-brand-bg">
      <Header id={id} refetch={refetch} />

      <div className="py-5 space-y-5">

        {/* Summary strip */}
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {[
            {
              label: 'Total Indexes',
              val: allIdx.length || (unused.length + missing.length) || '—',
              color: 'text-slate-700',
              icon: <Layers size={18} className="text-slate-400" />,
            },
            {
              label: 'Unused Indexes',
              val: unused.length,
              color: unused.length ? 'text-red-600' : 'text-green-600',
              icon: <Trash2 size={18} className={unused.length ? 'text-red-400' : 'text-green-400'} />,
            },
            {
              label: 'Missing Index Hints',
              val: missing.length,
              color: missing.length ? 'text-amber-600' : 'text-green-600',
              icon: <TrendingUp size={18} className={missing.length ? 'text-amber-400' : 'text-green-400'} />,
            },
          ].map(({ label, val, color, icon }) => (
            <div key={label} className="bg-white rounded-2xl border border-slate-200 p-4 flex items-center gap-4">
              {icon}
              <div>
                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wide">{label}</p>
                <p className={`text-2xl font-black mt-0.5 ${color}`}>{val}</p>
              </div>
            </div>
          ))}
        </div>

        {/* Tabs + Search */}
        <div className="bg-white rounded-2xl border border-slate-200">
          <div className="flex gap-1 p-3 border-b border-slate-100 flex-wrap items-center">
            {TABS.map(t => (
              <button key={t.id} onClick={() => setTab(t.id)}
                className={`flex items-center gap-1.5 px-3 h-8 rounded-lg text-xs font-bold transition-all ${
                  tab === t.id ? 'bg-slate-900 text-white' : 'border border-slate-200 text-slate-600 hover:bg-slate-50'
                }`}>
                {t.label}
                <span className={`px-1.5 py-0.5 rounded-full text-[9px] font-black ${
                  tab === t.id ? 'bg-white/20 text-white' : t.color
                }`}>
                  {t.count}
                </span>
              </button>
            ))}
            <div className="relative ml-auto">
              <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
              <input value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Filter table / index…"
                className="pl-7 pr-3 h-8 text-xs rounded-xl border border-slate-200 outline-none focus:border-violet-400 w-44" />
            </div>
          </div>

          {tab === 'unused'  && <UnusedTab  unused={unused}  q={q} />}
          {tab === 'missing' && <MissingTab missing={missing} q={q} />}
          {tab === 'all'     && <AllIndexesTab indexes={allIdx} q={q} />}
        </div>

      </div>
    </div>
  );
}
