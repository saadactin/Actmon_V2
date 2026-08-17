import React, { useState } from 'react';
import { Paged } from '@/components/ui/Pagination';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft, RefreshCw, Database, AlertTriangle, CheckCircle2,
  TrendingDown, Copy, ChevronDown, ChevronRight, Info,
  Layers, Trash2, Zap, BarChart2, Search, XCircle,
} from 'lucide-react';
import client from '@/api/client';
import EngineDashboardHeader from '@/components/layout/EngineDashboardHeader';
import { PageLoading } from '@/components/ui/Loading';
import { MYSQL_DASHBOARD_TABS, mysqlTabRoute } from '@/config/mysqlDashboardNav';

const fetchIndexAnalysis = (id) =>
  client.get(`/connections/mysql/${id}/index-analysis`).then(r => r.data);

/* ── small helpers ── */
function Spinner() {
  return (
    <PageLoading title="Loading index analysis…" />
  );
}

function CopyBtn({ text }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-slate-100 hover:bg-slate-200 text-slate-600 text-xs transition-all"
    >
      <Copy size={11} />
      {copied ? 'Copied!' : 'Copy'}
    </button>
  );
}

function ScoreRing({ score }) {
  const color = score >= 80 ? '#22C55E' : score >= 60 ? '#F97316' : '#EF4444';
  const r = 34, circ = 2 * Math.PI * r;
  const dash = (score / 100) * circ;
  return (
    <div className="relative w-20 h-20 flex items-center justify-center">
      <svg width="80" height="80" className="-rotate-90">
        <circle cx="40" cy="40" r={r} fill="none" stroke="#E2E8F0" strokeWidth="8" />
        <circle cx="40" cy="40" r={r} fill="none" stroke={color} strokeWidth="8"
          strokeDasharray={`${dash} ${circ}`} strokeLinecap="round" />
      </svg>
      <span className="absolute text-lg font-black" style={{ color }}>{score}</span>
    </div>
  );
}

function SectionHeader({ icon: Icon, title, count, color = 'text-slate-700', badge }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <Icon size={16} className={color} />
      <h2 className="font-bold text-slate-800">{title}</h2>
      {count !== undefined && (
        <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${badge || 'bg-slate-100 text-slate-500'}`}>
          {count}
        </span>
      )}
    </div>
  );
}

/* ── Expandable row ── */
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

/* ── Main page ── */
export default function IndexAnalysis() {
  const { id } = useParams();
  const [tab, setTab] = useState('unused');
  const [search, setSearch] = useState('');

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['mysqlIndexAnalysis', id],
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

  const summary          = data?.summary        || {};
  const unused           = data?.unused_indexes || [];
  const dupes            = data?.duplicate_indexes || [];
  const missing          = data?.missing_index_candidates || [];
  const noIdxQ           = data?.no_index_queries || [];
  const existing         = data?.existing_indexes || [];
  const errors           = data?.errors || {};
  const perfSchemaOff    = data?.perf_schema_enabled === false;

  const TABS = [
    { id: 'unused',    label: 'Unused Indexes',       count: unused.length,  color: unused.length   ? 'bg-red-100 text-red-700'    : 'bg-green-100 text-green-700' },
    { id: 'duplicate', label: 'Duplicate Indexes',    count: dupes.length,   color: dupes.length    ? 'bg-orange-100 text-orange-700' : 'bg-green-100 text-green-700' },
    { id: 'missing',   label: 'Missing Index Hints',  count: missing.length, color: missing.length  ? 'bg-amber-100 text-amber-700'  : 'bg-green-100 text-green-700' },
    { id: 'queries',   label: 'Full-Scan Queries',    count: noIdxQ.length,  color: noIdxQ.length   ? 'bg-yellow-100 text-yellow-700' : 'bg-green-100 text-green-700' },
    { id: 'all',       label: 'All Indexes',          count: existing.length,color: 'bg-slate-100 text-slate-600' },
  ];

  const q = search.toLowerCase();

  return (
    <div className="min-h-full bg-brand-bg">
      <Header id={id} refetch={refetch} />

      <div className="py-5 space-y-5">

        {/* ── Performance Schema OFF banner ──
             Only "Unused Indexes" genuinely needs performance_schema (real
             per-index read/write counters — there is no other way to know
             whether an index has ever been used). Full-Scan Queries and
             Missing Index Hints are sourced from the Slow Query Log + live
             EXPLAIN + information_schema instead, so they work regardless. */}
        {perfSchemaOff && (
          <div className="bg-orange-50 border border-orange-300 rounded-2xl p-4 space-y-2">
            <div className="flex items-center gap-2 font-bold text-orange-800">
              <AlertTriangle size={16} /> Performance Schema is DISABLED — "Unused Indexes" needs it
            </div>
            <p className="text-xs text-orange-700">
              Only unused-index tracking requires <code className="mx-1">performance_schema = ON</code> in
              MariaDB/MySQL config (it's the only way to know whether an index has ever been read/written).
              Full-Scan Queries and Missing Index Hints are sourced from the Slow Query Log and EXPLAIN
              instead, and All Indexes / Duplicate Indexes come from Information Schema — none of those
              three need this setting.
            </p>
            <div className="bg-white border border-orange-200 rounded-xl p-3 text-xs font-mono text-slate-700 space-y-1">
              <p className="text-slate-400 font-sans font-bold mb-1">Add to <code>/etc/mysql/mariadb.conf.d/50-server.cnf</code>:</p>
              <p>performance_schema = ON</p>
              <p className="text-slate-400 font-sans mt-2">Then restart MariaDB:</p>
              <p>sudo systemctl restart mariadb</p>
            </div>
          </div>
        )}

        {/* ── Summary strip ── */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <div className="bg-white rounded-2xl border border-slate-200 p-4 col-span-2 md:col-span-1 lg:col-span-1 flex items-center gap-4">
            <ScoreRing score={summary.health_score ?? 100} />
            <div>
              <p className="text-[10px] font-bold text-slate-400 uppercase">Index Health</p>
              <p className="text-sm font-semibold text-slate-600 mt-0.5">
                {summary.health_score >= 80 ? 'Good' : summary.health_score >= 60 ? 'Needs Attention' : 'Critical'}
              </p>
            </div>
          </div>
          {[
            { label: 'Total Indexes',    val: summary.total_indexes,       color: 'text-slate-700' },
            { label: 'Unused',           val: summary.unused_count,        color: summary.unused_count    ? 'text-red-600'    : 'text-green-600' },
            { label: 'Duplicate',        val: summary.duplicate_count,     color: summary.duplicate_count ? 'text-orange-600' : 'text-green-600' },
            { label: 'Missing Hints',    val: summary.missing_candidates,  color: summary.missing_candidates ? 'text-amber-600' : 'text-green-600' },
            { label: 'Full-Scan Queries',val: summary.no_index_queries,    color: summary.no_index_queries   ? 'text-yellow-600': 'text-green-600' },
          ].map(({ label, val, color }) => (
            <div key={label} className="bg-white rounded-2xl border border-slate-200 p-4">
              <p className="text-[10px] font-bold text-slate-400 uppercase">{label}</p>
              <p className={`text-2xl font-black mt-1 ${color}`}>{val ?? '—'}</p>
            </div>
          ))}
        </div>

        {/* ── Tabs ── */}
        <div className="bg-white rounded-2xl border border-slate-200">
          <div className="flex gap-1 p-3 border-b border-slate-100 flex-wrap">
            {TABS.map(t => (
              <button key={t.id} onClick={() => setTab(t.id)}
                className={`flex items-center gap-1.5 px-3 h-8 rounded-lg text-xs font-bold transition-all ${
                  tab === t.id ? 'bg-slate-900 text-white' : 'border border-slate-200 text-slate-600 hover:bg-slate-50'
                }`}>
                {t.label}
                <span className={`px-1.5 py-0.5 rounded-full text-[9px] font-black ${tab === t.id ? 'bg-white/20 text-white' : t.color}`}>
                  {t.count}
                </span>
              </button>
            ))}
            <div className="relative ml-auto">
              <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
              <input value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Filter…"
                className="pl-7 pr-3 h-8 text-xs rounded-xl border border-slate-200 outline-none focus:border-cyan-500 w-40" />
            </div>
          </div>

          {/* ── Unused Indexes ── */}
          {tab === 'unused' && (
            <UnusedTab unused={unused} q={q} err={errors.unused_indexes} />
          )}

          {/* ── Duplicate Indexes ── */}
          {tab === 'duplicate' && (
            <DuplicateTab dupes={dupes} q={q} err={errors.duplicate_indexes} />
          )}

          {/* ── Missing Index Hints ── */}
          {tab === 'missing' && (
            <MissingTab missing={missing} q={q} err={errors.missing_index_candidates} />
          )}

          {/* ── Full-Scan Queries ── */}
          {tab === 'queries' && (
            <NoIndexQueriesTab queries={noIdxQ} q={q} err={errors.no_index_queries} />
          )}

          {/* ── All Indexes ── */}
          {tab === 'all' && (
            <AllIndexesTab indexes={existing} q={q} err={errors.existing_indexes} />
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Header ── */
function Header({ id, refetch }) {
  const navigate = useNavigate();
  return (
    <>
      <EngineDashboardHeader
        tech="mysql"
        connectionId={id}
        tabs={MYSQL_DASHBOARD_TABS}
        activeTab="indexes"
        onTabChange={(t) => navigate(mysqlTabRoute(id, t))}
        onRefresh={refetch}
      />
      <div className="mb-2">
        <h1 className="text-lg font-black text-slate-800">Index Recommendation Engine</h1>
        <p className="text-xs text-slate-500">Unused · Duplicate · Missing · Full-Scan Query Detection</p>
      </div>
    </>
  );
}

/* ── Unused Indexes Tab ── */
function UnusedTab({ unused, q, err }) {
  const filtered = unused.filter(u =>
    !q || u.table_name?.toLowerCase().includes(q) || u.index_name?.toLowerCase().includes(q) || u.db_name?.toLowerCase().includes(q)
  );
  if (err) return <ErrBox msg={err} />;
  if (!filtered.length) return <Empty icon={CheckCircle2} msg={unused.length ? 'No matches' : 'No unused indexes detected'} good={!unused.length} />;

  return (
    <div className="overflow-auto">
      <div className="px-4 py-2 bg-red-50 border-b border-red-100 flex items-center gap-2 text-xs text-red-700">
        <AlertTriangle size={12} /> Unused indexes waste write performance and storage. Verify before dropping.
      </div>
      <Paged rows={filtered} unit="indexes">{(pageRows, pager) => (<>
      <table className="w-full text-xs">
        <thead className="bg-white border-b border-slate-100">
          <tr>
            <th className="w-8 px-3 py-2" />
            <th className="px-3 py-2 text-left text-[11px] font-bold text-slate-400">Database</th>
            <th className="px-3 py-2 text-left text-[11px] font-bold text-slate-400">Table</th>
            <th className="px-3 py-2 text-left text-[11px] font-bold text-slate-400">Index</th>
            <th className="px-3 py-2 text-left text-[11px] font-bold text-slate-400">Columns</th>
            <th className="px-3 py-2 text-right text-[11px] font-bold text-slate-400">Reads</th>
            <th className="px-3 py-2 text-right text-[11px] font-bold text-slate-400">Writes</th>
            <th className="px-3 py-2 text-left text-[11px] font-bold text-slate-400">Action</th>
          </tr>
        </thead>
        <tbody>
          {pageRows.map((u, i) => (
            <ExpandRow key={i}
              detail={
                <div className="space-y-2">
                  <p className="text-xs font-bold text-slate-600">Drop Statement</p>
                  <div className="flex items-start gap-2">
                    <pre className="flex-1 bg-white border border-slate-200 rounded-lg px-3 py-2 text-xs font-mono text-red-700 whitespace-pre-wrap">
                      {u.drop_statement}
                    </pre>
                    <CopyBtn text={u.drop_statement} />
                  </div>
                  <div className="bg-amber-50 border border-amber-200 rounded-lg p-2 text-xs text-amber-700 flex gap-2">
                    <Info size={12} className="flex-shrink-0 mt-0.5" />
                    <span>Note: performance_schema counters reset on server restart. Confirm this index is unused over a representative time window before dropping.</span>
                  </div>
                </div>
              }>
              <td className="px-3 py-2 text-slate-500">{u.db_name}</td>
              <td className="px-3 py-2 font-mono text-slate-700">{u.table_name}</td>
              <td className="px-3 py-2 font-mono text-red-700 font-bold">{u.index_name}</td>
              <td className="px-3 py-2 text-slate-500 font-mono">{(u.columns || []).join(', ')}</td>
              <td className="px-3 py-2 text-right font-mono text-slate-500">{u.count_read}</td>
              <td className="px-3 py-2 text-right font-mono text-slate-500">{u.count_write}</td>
              <td className="px-3 py-2">
                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-red-50 text-red-600 border border-red-100">
                  <Trash2 size={9} className="inline mr-1" />Drop
                </span>
              </td>
            </ExpandRow>
          ))}
        </tbody>
      </table>
      {pager}
      </>)}</Paged>
    </div>
  );
}

/* ── Duplicate Indexes Tab ── */
function DuplicateTab({ dupes, q, err }) {
  const filtered = dupes.filter(d =>
    !q || d.table_name?.toLowerCase().includes(q) || d.redundant_index?.toLowerCase().includes(q) || d.db_name?.toLowerCase().includes(q)
  );
  if (err) return <ErrBox msg={err} />;
  if (!filtered.length) return <Empty icon={CheckCircle2} msg={dupes.length ? 'No matches' : 'No duplicate/redundant indexes detected'} good={!dupes.length} />;

  return (
    <div className="overflow-auto">
      <div className="px-4 py-2 bg-orange-50 border-b border-orange-100 flex items-center gap-2 text-xs text-orange-700">
        <Info size={12} /> Redundant indexes exist when one index columns are a prefix of another. The shorter one adds overhead with no benefit.
      </div>
      <Paged rows={filtered} unit="indexes">{(pageRows, pager) => (<>
      <table className="w-full text-xs">
        <thead className="bg-white border-b border-slate-100">
          <tr>
            <th className="w-8 px-3 py-2" />
            <th className="px-3 py-2 text-left text-[11px] font-bold text-slate-400">Database</th>
            <th className="px-3 py-2 text-left text-[11px] font-bold text-slate-400">Table</th>
            <th className="px-3 py-2 text-left text-[11px] font-bold text-slate-400 text-orange-600">Redundant Index</th>
            <th className="px-3 py-2 text-left text-[11px] font-bold text-slate-400">Covered By</th>
            <th className="px-3 py-2 text-left text-[11px] font-bold text-slate-400">Columns</th>
          </tr>
        </thead>
        <tbody>
          {pageRows.map((d, i) => (
            <ExpandRow key={i}
              detail={
                <div className="space-y-2">
                  <div className="grid grid-cols-2 gap-4 text-xs">
                    <div>
                      <p className="font-bold text-orange-600 mb-1">Redundant: <code>{d.redundant_index}</code></p>
                      <div className="flex flex-wrap gap-1">
                        {d.columns.map(c => <span key={c} className="px-2 py-0.5 bg-orange-100 text-orange-700 rounded text-[10px] font-mono">{c}</span>)}
                      </div>
                    </div>
                    <div>
                      <p className="font-bold text-green-600 mb-1">Superset: <code>{d.covered_by}</code></p>
                      <div className="flex flex-wrap gap-1">
                        {d.covered_columns.map(c => <span key={c} className="px-2 py-0.5 bg-green-100 text-green-700 rounded text-[10px] font-mono">{c}</span>)}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-start gap-2">
                    <pre className="flex-1 bg-white border border-slate-200 rounded-lg px-3 py-2 text-xs font-mono text-red-700">
                      {d.drop_statement}
                    </pre>
                    <CopyBtn text={d.drop_statement} />
                  </div>
                </div>
              }>
              <td className="px-3 py-2 text-slate-500">{d.db_name}</td>
              <td className="px-3 py-2 font-mono text-slate-700">{d.table_name}</td>
              <td className="px-3 py-2 font-mono font-bold text-orange-700">{d.redundant_index}</td>
              <td className="px-3 py-2 font-mono text-green-700">{d.covered_by}</td>
              <td className="px-3 py-2 text-slate-500 font-mono">
                <span className="line-through text-slate-400 mr-1">[{d.columns.join(', ')}]</span>
                <span className="text-green-600">⊂ [{d.covered_columns.join(', ')}]</span>
              </td>
            </ExpandRow>
          ))}
        </tbody>
      </table>
      {pager}
      </>)}</Paged>
    </div>
  );
}

/* ── Missing Index Hints Tab ── */
function MissingTab({ missing, q, err }) {
  const filtered = missing.filter(m =>
    !q || m.table_name?.toLowerCase().includes(q) || m.db_name?.toLowerCase().includes(q)
  );
  if (err) return <ErrBox msg={err} />;
  if (!filtered.length) return <Empty icon={CheckCircle2} msg={missing.length ? 'No matches' : 'No missing-index candidates detected.'} good={!missing.length} />;

  return (
    <div className="overflow-auto">
      <div className="px-4 py-2 bg-amber-50 border-b border-amber-100 flex items-center gap-2 text-xs text-amber-700">
        <Zap size={12} /> Tables accessed by full-scan queries. Add indexes on frequently filtered/joined columns for significant speedup.
      </div>
      <Paged rows={filtered} unit="indexes">{(pageRows, pager) => (<>
      <table className="w-full text-xs">
        <thead className="bg-white border-b border-slate-100">
          <tr>
            <th className="w-8 px-3 py-2" />
            <th className="px-3 py-2 text-left text-[11px] font-bold text-slate-400">Database</th>
            <th className="px-3 py-2 text-left text-[11px] font-bold text-slate-400">Table</th>
            <th className="px-3 py-2 text-right text-[11px] font-bold text-slate-400">Full-Scan Hits</th>
            <th className="px-3 py-2 text-right text-[11px] font-bold text-slate-400">Rows Examined</th>
            <th className="px-3 py-2 text-right text-[11px] font-bold text-slate-400">Worst Avg (s)</th>
            <th className="px-3 py-2 text-right text-[11px] font-bold text-slate-400">Table Rows</th>
            <th className="px-3 py-2 text-right text-[11px] font-bold text-slate-400">Size (MB)</th>
          </tr>
        </thead>
        <tbody>
          {pageRows.map((m, i) => (
            <ExpandRow key={i}
              detail={
                <div className="space-y-3">
                  <div>
                    <p className="text-xs font-bold text-slate-600 mb-1">Existing Indexes on this Table</p>
                    <div className="flex flex-wrap gap-1">
                      {m.existing_indexes.length
                        ? m.existing_indexes.map(idx => (
                            <span key={idx} className="px-2 py-0.5 bg-slate-100 text-slate-600 rounded text-[10px] font-mono">{idx}</span>
                          ))
                        : <span className="text-slate-400 text-xs">None</span>
                      }
                    </div>
                  </div>
                  <div>
                    <p className="text-xs font-bold text-slate-600 mb-1">Suggested SQL Template</p>
                    <div className="flex items-start gap-2">
                      <pre className="flex-1 bg-white border border-slate-200 rounded-lg px-3 py-2 text-xs font-mono text-indigo-700 whitespace-pre-wrap">
                        {m.suggested_sql}
                      </pre>
                      <CopyBtn text={m.suggested_sql} />
                    </div>
                  </div>
                  <div>
                    <p className="text-xs font-bold text-slate-600 mb-2">CRUD Impact Analysis</p>
                    <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
                      {Object.entries(m.crud_impact || {}).map(([op, desc]) => (
                        <div key={op} className={`rounded-lg border p-2 text-[10px] ${
                          op === 'select' ? 'bg-green-50 border-green-200 text-green-700' :
                          op === 'storage' ? 'bg-slate-50 border-slate-200 text-slate-600' :
                          'bg-amber-50 border-amber-200 text-amber-700'
                        }`}>
                          <p className="font-bold uppercase mb-0.5">{op}</p>
                          <p>{desc}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              }>
              <td className="px-3 py-2 text-slate-500">{m.db_name || <span className="italic text-slate-300">No Database</span>}</td>
              <td className="px-3 py-2 font-mono font-bold text-amber-700">{m.table_name}</td>
              <td className="px-3 py-2 text-right font-mono text-red-600 font-bold">{m.no_index_count?.toLocaleString()}</td>
              <td className="px-3 py-2 text-right font-mono text-slate-500">{m.rows_examined?.toLocaleString()}</td>
              <td className="px-3 py-2 text-right font-mono text-orange-600">{m.worst_avg_sec}</td>
              <td className="px-3 py-2 text-right font-mono text-slate-500">{m.table_rows?.toLocaleString() ?? '—'}</td>
              <td className="px-3 py-2 text-right font-mono text-slate-500">{m.data_mb ?? '—'}</td>
            </ExpandRow>
          ))}
        </tbody>
      </table>
      {pager}
      </>)}</Paged>
    </div>
  );
}

/* ── No-Index Queries Tab ── */
function NoIndexQueriesTab({ queries, q, err }) {
  const filtered = queries.filter(qr =>
    !q || (qr.sql_text || '').toLowerCase().includes(q) || (qr.db_name || '').toLowerCase().includes(q)
  );
  if (err) return <ErrBox msg={err} />;
  if (!filtered.length) return (
    <Empty icon={CheckCircle2}
      msg={queries.length ? 'No matches' : 'No application full-scan queries detected.'}
      good={!queries.length} />
  );

  return (
    <div className="overflow-auto">
      <div className="px-4 py-2 bg-yellow-50 border-b border-yellow-100 flex items-center gap-2 text-xs text-yellow-700">
        <TrendingDown size={12} /> Queries that executed without using any index. These are candidates for index creation.
      </div>
      <Paged rows={filtered} unit="indexes">{(pageRows, pager) => (<>
      <table className="w-full text-xs">
        <thead className="bg-white border-b border-slate-100">
          <tr>
            <th className="w-8 px-3 py-2" />
            <th className="px-3 py-2 text-left text-[11px] font-bold text-slate-400">DB</th>
            <th className="px-3 py-2 text-left text-[11px] font-bold text-slate-400">Query (truncated)</th>
            <th className="px-3 py-2 text-right text-[11px] font-bold text-slate-400">Calls</th>
            <th className="px-3 py-2 text-right text-[11px] font-bold text-slate-400">Avg (s)</th>
            <th className="px-3 py-2 text-right text-[11px] font-bold text-slate-400">No-Index</th>
            <th className="px-3 py-2 text-right text-[11px] font-bold text-slate-400">Rows Exam.</th>
            <th className="px-3 py-2 text-left text-[11px] font-bold text-slate-400">Last Seen</th>
          </tr>
        </thead>
        <tbody>
          {pageRows.map((qr, i) => (
            <ExpandRow key={i}
              detail={
                <div className="space-y-2">
                  <p className="text-xs font-bold text-slate-600">Full Query Digest</p>
                  <div className="flex items-start gap-2">
                    <pre className="flex-1 bg-white border border-slate-200 rounded-lg px-3 py-2 text-xs font-mono text-slate-700 whitespace-pre-wrap break-words max-h-40 overflow-auto">
                      {qr.sql_text}
                    </pre>
                    <CopyBtn text={qr.sql_text || ''} />
                  </div>
                  <div className="grid grid-cols-3 gap-3 text-xs">
                    <div className="bg-slate-50 rounded-lg p-2">
                      <p className="text-slate-400 text-[10px] uppercase font-bold">No Index Used</p>
                      <p className="font-bold text-red-600">{qr.no_index_used?.toLocaleString()}</p>
                    </div>
                    <div className="bg-slate-50 rounded-lg p-2">
                      <p className="text-slate-400 text-[10px] uppercase font-bold">No Good Index</p>
                      <p className="font-bold text-orange-600">{qr.no_good_index_used?.toLocaleString()}</p>
                    </div>
                    <div className="bg-slate-50 rounded-lg p-2">
                      <p className="text-slate-400 text-[10px] uppercase font-bold">Rows / Call</p>
                      <p className="font-bold text-slate-700">
                        {qr.count_calls ? Math.round(qr.rows_examined / qr.count_calls).toLocaleString() : '—'}
                      </p>
                    </div>
                  </div>
                </div>
              }>
              <td className="px-3 py-2 text-slate-500">{qr.db_name || <span className="italic text-slate-300">No Database</span>}</td>
              <td className="px-3 py-2 font-mono text-slate-600 max-w-xs truncate">
                {(qr.sql_text || '').slice(0, 80)}{(qr.sql_text || '').length > 80 ? '…' : ''}
              </td>
              <td className="px-3 py-2 text-right font-mono text-slate-600">{qr.count_calls?.toLocaleString()}</td>
              <td className={`px-3 py-2 text-right font-mono font-bold ${qr.avg_sec > 1 ? 'text-red-600' : qr.avg_sec > 0.1 ? 'text-orange-600' : 'text-slate-600'}`}>
                {qr.avg_sec}
              </td>
              <td className="px-3 py-2 text-right font-mono text-red-600 font-bold">
                {(Number(qr.no_index_used || 0) + Number(qr.no_good_index_used || 0)).toLocaleString()}
              </td>
              <td className="px-3 py-2 text-right font-mono text-slate-500">{qr.rows_examined?.toLocaleString()}</td>
              <td className="px-3 py-2 text-slate-400 whitespace-nowrap">{qr.last_seen}</td>
            </ExpandRow>
          ))}
        </tbody>
      </table>
      {pager}
      </>)}</Paged>
    </div>
  );
}

/* ── All Indexes Tab ── */
function AllIndexesTab({ indexes, q, err }) {
  const [dbFilter, setDbFilter] = useState('ALL');
  const dbs = ['ALL', ...new Set(indexes.map(i => i.db_name))];

  const filtered = indexes.filter(i => {
    const okDb  = dbFilter === 'ALL' || i.db_name === dbFilter;
    const okQ   = !q || i.index_name?.toLowerCase().includes(q) || i.table_name?.toLowerCase().includes(q);
    return okDb && okQ;
  });

  if (err) return <ErrBox msg={err} />;
  if (!filtered.length) return <Empty icon={Database} msg={indexes.length ? 'No matches' : 'No indexes found'} />;

  return (
    <div>
      <div className="px-4 py-2 flex gap-2 flex-wrap border-b border-slate-100">
        {dbs.map(d => (
          <button key={d} onClick={() => setDbFilter(d)}
            className={`px-2 h-6 rounded-md text-[10px] font-bold transition-all ${
              dbFilter === d ? 'bg-slate-900 text-white' : 'border border-slate-200 text-slate-500 hover:bg-slate-50'
            }`}>{d}</button>
        ))}
        <span className="ml-auto text-xs text-slate-400 self-center">{filtered.length} indexes</span>
      </div>
      <div className="overflow-auto max-h-[540px]">
        <Paged rows={filtered} unit="indexes">{(pageRows, pager) => (<>
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-white border-b border-slate-100 z-10">
            <tr>
              <th className="px-3 py-2 text-left text-[11px] font-bold text-slate-400">Database</th>
              <th className="px-3 py-2 text-left text-[11px] font-bold text-slate-400">Table</th>
              <th className="px-3 py-2 text-left text-[11px] font-bold text-slate-400">Index</th>
              <th className="px-3 py-2 text-left text-[11px] font-bold text-slate-400">Columns</th>
              <th className="px-3 py-2 text-left text-[11px] font-bold text-slate-400">Type</th>
              <th className="px-3 py-2 text-left text-[11px] font-bold text-slate-400">Unique</th>
              <th className="px-3 py-2 text-right text-[11px] font-bold text-slate-400">Cardinality</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.map((idx, i) => (
              <tr key={i} className="border-t border-slate-50 hover:bg-slate-50">
                <td className="px-3 py-1.5 text-slate-500">{idx.db_name}</td>
                <td className="px-3 py-1.5 font-mono text-slate-700">{idx.table_name}</td>
                <td className="px-3 py-1.5 font-mono font-bold text-slate-700">
                  {idx.index_name === 'PRIMARY'
                    ? <span className="text-cyan-700">{idx.index_name}</span>
                    : idx.index_name}
                </td>
                <td className="px-3 py-1.5 text-slate-500 font-mono">{(idx.columns || []).join(', ')}</td>
                <td className="px-3 py-1.5">
                  <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold ${
                    idx.index_type === 'FULLTEXT' ? 'bg-purple-100 text-purple-700' :
                    idx.index_type === 'SPATIAL'  ? 'bg-green-100 text-green-700' :
                    'bg-slate-100 text-slate-500'
                  }`}>{idx.index_type}</span>
                </td>
                <td className="px-3 py-1.5">
                  {idx.non_unique === 0
                    ? <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-cyan-50 text-cyan-700">UNIQUE</span>
                    : <span className="text-slate-400">—</span>
                  }
                </td>
                <td className="px-3 py-1.5 text-right font-mono text-slate-500">
                  {idx.cardinality !== null ? Number(idx.cardinality).toLocaleString() : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {pager}
        </>)}</Paged>
      </div>
    </div>
  );
}

/* ── Shared empties ── */
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
