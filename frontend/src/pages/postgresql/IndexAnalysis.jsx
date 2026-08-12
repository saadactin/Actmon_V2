import React, { useState } from 'react';
import { Paged } from '@/components/ui/Pagination';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft, RefreshCw, Database, AlertTriangle, CheckCircle2,
  TrendingDown, Copy, ChevronDown, ChevronRight, Info,
  Layers, Trash2, Zap, BarChart2, Search, XCircle,
} from 'lucide-react';
import client from '@/api/client';
import PageHeader from '@/components/layout/PageHeader';
import { PageLoading } from '@/components/ui/Loading';

const fetchIndexAnalysis = (id) =>
  client.get(`/connections/postgresql/${id}/pg-index-analysis`).then(r => r.data);

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
    queryKey: ['pgIndexAnalysis', id],
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
      <div className="p-6">
        <div className="bg-red-50 border border-red-200 rounded-2xl p-5 max-w-lg">
          <AlertTriangle className="text-red-500 mb-2" size={18} />
          <p className="font-bold text-red-700">Failed to load index analysis</p>
          <p className="text-sm text-red-600 mt-1">{error.message}</p>
          <button onClick={refetch} className="mt-3 px-4 py-2 bg-red-600 text-white rounded-xl text-sm font-bold">Retry</button>
        </div>
      </div>
    </div>
  );

  const summary        = data?.summary           || {};
  const unused         = data?.unused_indexes    || [];
  const allIndexes     = data?.all_indexes       || [];
  const bloated        = data?.bloated_tables    || [];
  const pgssQueries    = data?.pg_stat_statements || [];
  const errors         = data?.errors            || {};

  const TABS = [
    { id: 'unused',   label: 'Unused Indexes',      count: unused.length,      color: unused.length    ? 'bg-red-100 text-red-700'       : 'bg-green-100 text-green-700' },
    { id: 'all',      label: 'All Indexes',          count: allIndexes.length,  color: 'bg-slate-100 text-slate-600' },
    { id: 'bloated',  label: 'Bloated Tables',       count: bloated.length,     color: bloated.length   ? 'bg-orange-100 text-orange-700' : 'bg-green-100 text-green-700' },
    { id: 'pgss',     label: 'pg_stat_statements',   count: pgssQueries.length, color: 'bg-indigo-100 text-indigo-600' },
  ];

  const q = search.toLowerCase();

  return (
    <div className="min-h-full bg-brand-bg">
      <Header id={id} refetch={refetch} />

      <div className="py-5 space-y-5">

        {/* ── Summary strip ── */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
          <div className="bg-white rounded-2xl border border-slate-200 p-4 col-span-2 md:col-span-1 flex items-center gap-4">
            <ScoreRing score={summary.health_score ?? 100} />
            <div>
              <p className="text-[10px] font-bold text-slate-400 uppercase">Index Health</p>
              <p className="text-sm font-semibold text-slate-600 mt-0.5">
                {(summary.health_score ?? 100) >= 80 ? 'Good' : (summary.health_score ?? 100) >= 60 ? 'Needs Attention' : 'Critical'}
              </p>
            </div>
          </div>
          {[
            { label: 'Total Indexes',   val: summary.total_indexes,     color: 'text-slate-700' },
            { label: 'Unused',          val: summary.unused_count,      color: summary.unused_count  ? 'text-red-600'    : 'text-green-600' },
            { label: 'Bloated Tables',  val: summary.bloated_count,     color: summary.bloated_count ? 'text-orange-600' : 'text-green-600' },
            { label: 'Schemas',         val: summary.schema_count,      color: 'text-indigo-600' },
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
                className="pl-7 pr-3 h-8 text-xs rounded-xl border border-slate-200 outline-none focus:border-indigo-500 w-40" />
            </div>
          </div>

          {tab === 'unused'  && <UnusedTab  unused={unused}       q={q} err={errors.unused_indexes} />}
          {tab === 'all'     && <AllIndexesTab indexes={allIndexes} q={q} err={errors.all_indexes} />}
          {tab === 'bloated' && <BloatedTab bloated={bloated}     q={q} err={errors.bloated_tables} />}
          {tab === 'pgss'    && <PgssTab    queries={pgssQueries} q={q} err={errors.pg_stat_statements} />}
        </div>
      </div>
    </div>
  );
}

/* ── Header — standard PageHeader band (breadcrumb + gradient, flush layout) ── */
function Header({ id, refetch }) {
  return (
    <PageHeader
      icon={Layers}
      title="Index Analysis"
      subtitle="Unused · All Indexes · Bloated Tables · pg_stat_statements"
      accent="postgres"
      backTo={`/postgresql-dashboard/${id}`}
      crumbs={[{ label: 'Databases', to: '/databases' }, { label: 'PostgreSQL', to: `/postgresql-dashboard/${id}` }, { label: 'Index Analysis' }]}
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
function UnusedTab({ unused, q, err }) {
  const filtered = unused.filter(u =>
    !q ||
    u.schemaname?.toLowerCase().includes(q) ||
    u.tablename?.toLowerCase().includes(q)  ||
    u.indexname?.toLowerCase().includes(q)
  );
  if (err) return <ErrBox msg={err} />;
  if (!filtered.length) return <Empty icon={CheckCircle2} msg={unused.length ? 'No matches' : 'No unused indexes detected'} good={!unused.length} />;

  return (
    <div className="overflow-auto">
      <div className="px-4 py-2 bg-red-50 border-b border-red-100 flex items-center gap-2 text-xs text-red-700">
        <AlertTriangle size={12} /> Unused indexes waste write performance and storage. Verify over a representative period before dropping.
      </div>
      <Paged rows={filtered} unit="indexes">{(pageRows, pager) => (<>
      <table className="w-full text-xs">
        <thead className="bg-white border-b border-slate-100">
          <tr>
            <th className="w-8 px-3 py-2" />
            <th className="px-3 py-2 text-left text-[11px] font-bold text-slate-400">Schema</th>
            <th className="px-3 py-2 text-left text-[11px] font-bold text-slate-400">Table</th>
            <th className="px-3 py-2 text-left text-[11px] font-bold text-slate-400">Index</th>
            <th className="px-3 py-2 text-right text-[11px] font-bold text-slate-400">Scans (idx_scan)</th>
            <th className="px-3 py-2 text-right text-[11px] font-bold text-slate-400">Size</th>
            <th className="px-3 py-2 text-left text-[11px] font-bold text-slate-400">Action</th>
          </tr>
        </thead>
        <tbody>
          {pageRows.map((u, i) => {
            const dropStmt = `DROP INDEX CONCURRENTLY ${u.schemaname ? u.schemaname + '.' : ''}${u.indexname};`;
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
                        pg_stat_user_indexes counters reset on server restart. Use CONCURRENTLY to avoid locking.
                        Confirm the index is truly unused over a representative time window before dropping.
                      </span>
                    </div>
                  </div>
                }>
                <td className="px-3 py-2 text-slate-500 font-mono">{u.schemaname || 'public'}</td>
                <td className="px-3 py-2 font-mono text-slate-700">{u.tablename}</td>
                <td className="px-3 py-2 font-mono text-red-700 font-bold">{u.indexname}</td>
                <td className="px-3 py-2 text-right font-mono text-slate-500">{(+u.idx_scan || 0).toLocaleString()}</td>
                <td className="px-3 py-2 text-right font-mono text-slate-500">{u.index_size || u.size || '—'}</td>
                <td className="px-3 py-2">
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-red-50 text-red-600 border border-red-100">
                    <Trash2 size={9} className="inline mr-1" />Drop
                  </span>
                </td>
              </ExpandRow>
            );
          })}
        </tbody>
      </table>
      {pager}
      </>)}</Paged>
    </div>
  );
}

/* ── All Indexes Tab ── */
function AllIndexesTab({ indexes, q, err }) {
  const [schemaFilter, setSchemaFilter] = useState('ALL');
  const schemas = ['ALL', ...new Set(indexes.map(i => i.schemaname).filter(Boolean))];

  const filtered = indexes.filter(i => {
    const okSchema = schemaFilter === 'ALL' || i.schemaname === schemaFilter;
    const okQ      = !q ||
      i.indexname?.toLowerCase().includes(q) ||
      i.tablename?.toLowerCase().includes(q)  ||
      i.schemaname?.toLowerCase().includes(q);
    return okSchema && okQ;
  });

  if (err) return <ErrBox msg={err} />;
  if (!filtered.length) return <Empty icon={Database} msg={indexes.length ? 'No matches' : 'No indexes found'} />;

  return (
    <div>
      <div className="px-4 py-2 flex gap-2 flex-wrap border-b border-slate-100">
        {schemas.map(s => (
          <button key={s} onClick={() => setSchemaFilter(s)}
            className={`px-2 h-6 rounded-md text-[10px] font-bold transition-all ${
              schemaFilter === s ? 'bg-slate-900 text-white' : 'border border-slate-200 text-slate-500 hover:bg-slate-50'
            }`}>{s}</button>
        ))}
        <span className="ml-auto text-xs text-slate-400 self-center">{filtered.length} indexes</span>
      </div>
      <div className="overflow-auto max-h-[540px]">
        <Paged rows={filtered} unit="indexes">{(pageRows, pager) => (<>
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-white border-b border-slate-100 z-10">
            <tr>
              <th className="px-3 py-2 text-left text-[11px] font-bold text-slate-400">Schema</th>
              <th className="px-3 py-2 text-left text-[11px] font-bold text-slate-400">Table</th>
              <th className="px-3 py-2 text-left text-[11px] font-bold text-slate-400">Index</th>
              <th className="px-3 py-2 text-right text-[11px] font-bold text-slate-400">idx_scan</th>
              <th className="px-3 py-2 text-left text-[11px] font-bold text-slate-400">Definition</th>
              <th className="px-3 py-2 text-right text-[11px] font-bold text-slate-400">Size</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.map((idx, i) => (
              <tr key={i} className="border-t border-slate-50 hover:bg-slate-50">
                <td className="px-3 py-1.5 text-slate-500 font-mono">{idx.schemaname || 'public'}</td>
                <td className="px-3 py-1.5 font-mono text-slate-700">{idx.tablename}</td>
                <td className="px-3 py-1.5 font-mono font-bold text-slate-700">
                  {idx.indexname?.includes('pkey')
                    ? <span className="text-cyan-700">{idx.indexname}</span>
                    : idx.indexname}
                </td>
                <td className="px-3 py-1.5 text-right font-mono text-slate-500">
                  {(+idx.idx_scan || 0).toLocaleString()}
                </td>
                <td className="px-3 py-1.5 text-slate-400 font-mono text-[10px] max-w-xs truncate" title={idx.index_def || idx.indexdef}>
                  {idx.index_def || idx.indexdef || '—'}
                </td>
                <td className="px-3 py-1.5 text-right font-mono text-slate-500">
                  {idx.index_size || idx.size || '—'}
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

/* ── Bloated Tables Tab ── */
function BloatedTab({ bloated, q, err }) {
  const filtered = bloated.filter(t =>
    !q ||
    t.schemaname?.toLowerCase().includes(q) ||
    t.tablename?.toLowerCase().includes(q)
  );
  if (err) return <ErrBox msg={err} />;
  if (!filtered.length) return <Empty icon={CheckCircle2} msg={bloated.length ? 'No matches' : 'No bloated tables detected'} good={!bloated.length} />;

  return (
    <div className="overflow-auto">
      <div className="px-4 py-2 bg-orange-50 border-b border-orange-100 flex items-center gap-2 text-xs text-orange-700">
        <Info size={12} /> Tables with high dead tuple counts accumulate bloat. Run VACUUM ANALYZE to reclaim space and improve performance.
      </div>
      <Paged rows={filtered} unit="indexes">{(pageRows, pager) => (<>
      <table className="w-full text-xs">
        <thead className="bg-white border-b border-slate-100">
          <tr>
            <th className="w-8 px-3 py-2" />
            <th className="px-3 py-2 text-left text-[11px] font-bold text-slate-400">Schema</th>
            <th className="px-3 py-2 text-left text-[11px] font-bold text-slate-400">Table</th>
            <th className="px-3 py-2 text-right text-[11px] font-bold text-slate-400">Live Tuples</th>
            <th className="px-3 py-2 text-right text-[11px] font-bold text-slate-400">Dead Tuples</th>
            <th className="px-3 py-2 text-right text-[11px] font-bold text-slate-400">Dead %</th>
            <th className="px-3 py-2 text-left text-[11px] font-bold text-slate-400">Last Vacuum</th>
          </tr>
        </thead>
        <tbody>
          {pageRows.map((t, i) => {
            const deadPct = +t.dead_pct || 0;
            const vacuumCmd = `VACUUM ANALYZE ${t.schemaname ? t.schemaname + '.' : ''}${t.tablename};`;
            return (
              <ExpandRow key={i}
                detail={
                  <div className="space-y-2">
                    <p className="text-xs font-bold text-slate-600">Recommended Command</p>
                    <div className="flex items-start gap-2">
                      <pre className="flex-1 bg-white border border-slate-200 rounded-lg px-3 py-2 text-xs font-mono text-indigo-700 whitespace-pre-wrap">
                        {vacuumCmd}
                      </pre>
                      <CopyBtn text={vacuumCmd} />
                    </div>
                    {t.last_autovacuum && (
                      <p className="text-xs text-slate-400">Last autovacuum: {t.last_autovacuum}</p>
                    )}
                    {t.last_autoanalyze && (
                      <p className="text-xs text-slate-400">Last autoanalyze: {t.last_autoanalyze}</p>
                    )}
                    <div className="bg-blue-50 border border-blue-200 rounded-lg p-2 text-xs text-blue-700 flex gap-2">
                      <Info size={12} className="flex-shrink-0 mt-0.5" />
                      <span>For very large tables, consider <code className="font-mono">VACUUM (VERBOSE, ANALYZE)</code> during off-peak hours to avoid lock contention.</span>
                    </div>
                  </div>
                }>
                <td className="px-3 py-2 text-slate-500 font-mono">{t.schemaname || 'public'}</td>
                <td className="px-3 py-2 font-mono font-bold text-slate-700">{t.tablename}</td>
                <td className="px-3 py-2 text-right font-mono text-slate-500">{(+t.n_live_tup || 0).toLocaleString()}</td>
                <td className="px-3 py-2 text-right font-mono text-orange-600 font-bold">{(+t.n_dead_tup || 0).toLocaleString()}</td>
                <td className="px-3 py-2 text-right">
                  <span className={`font-black text-xs ${deadPct > 20 ? 'text-red-600' : deadPct > 10 ? 'text-orange-500' : 'text-slate-600'}`}>
                    {deadPct.toFixed(1)}%
                  </span>
                </td>
                <td className="px-3 py-2 text-slate-400 whitespace-nowrap font-mono text-[10px]">
                  {t.last_vacuum || t.last_autovacuum || '—'}
                </td>
              </ExpandRow>
            );
          })}
        </tbody>
      </table>
      {pager}
      </>)}</Paged>
    </div>
  );
}

/* ── pg_stat_statements Tab ── */
function PgssTab({ queries, q, err }) {
  const filtered = queries.filter(qr =>
    !q || (qr.query || '').toLowerCase().includes(q)
  );
  if (err) return <ErrBox msg={err} />;
  if (!filtered.length) return (
    <Empty icon={CheckCircle2}
      msg={queries.length ? 'No matches' : 'No pg_stat_statements data available'}
      good={false} />
  );

  return (
    <div className="overflow-auto">
      <div className="px-4 py-2 bg-indigo-50 border-b border-indigo-100 flex items-center gap-2 text-xs text-indigo-700">
        <Zap size={12} /> Cumulative query statistics from pg_stat_statements — sorted by total execution time.
      </div>
      <div className="overflow-auto max-h-[540px]">
        <Paged rows={filtered} unit="indexes">{(pageRows, pager) => (<>
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-white border-b border-slate-100 z-10">
            <tr>
              <th className="w-8 px-3 py-2" />
              <th className="px-3 py-2 text-left text-[11px] font-bold text-slate-400">Query</th>
              <th className="px-3 py-2 text-right text-[11px] font-bold text-slate-400">Calls</th>
              <th className="px-3 py-2 text-right text-[11px] font-bold text-slate-400">Mean (ms)</th>
              <th className="px-3 py-2 text-right text-[11px] font-bold text-slate-400">Max (ms)</th>
              <th className="px-3 py-2 text-right text-[11px] font-bold text-slate-400">Total (ms)</th>
              <th className="px-3 py-2 text-right text-[11px] font-bold text-slate-400">Rows</th>
              <th className="px-3 py-2 text-right text-[11px] font-bold text-slate-400">Blks Read</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.map((qr, i) => {
              const mean  = +qr.mean_exec_time || 0;
              const max   = +qr.max_exec_time  || 0;
              const total = +qr.total_exec_time || 0;
              const calls = +qr.calls          || 0;
              const read  = +qr.shared_blks_read || 0;
              return (
                <ExpandRow key={i}
                  detail={
                    <div className="space-y-2">
                      <p className="text-xs font-bold text-slate-600">Full Query</p>
                      <div className="flex items-start gap-2">
                        <pre className="flex-1 bg-white border border-slate-200 rounded-lg px-3 py-2 text-xs font-mono text-slate-700 whitespace-pre-wrap break-words max-h-40 overflow-auto">
                          {qr.query}
                        </pre>
                        <CopyBtn text={qr.query || ''} />
                      </div>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                        {[
                          { label: 'Blks Hit',    val: (+qr.shared_blks_hit || 0).toLocaleString() },
                          { label: 'Blks Read',   val: read.toLocaleString(), warn: read > 0 },
                          { label: 'Blks Dirty',  val: (+qr.shared_blks_dirtied || 0).toLocaleString() },
                          { label: 'Blks Written',val: (+qr.shared_blks_written || 0).toLocaleString() },
                        ].map(({ label, val, warn }) => (
                          <div key={label} className={`rounded-lg border p-2 ${warn ? 'bg-amber-50 border-amber-200' : 'bg-slate-50 border-slate-200'}`}>
                            <p className={`text-[10px] uppercase font-bold mb-0.5 ${warn ? 'text-amber-600' : 'text-slate-400'}`}>{label}</p>
                            <p className={`font-bold ${warn ? 'text-amber-700' : 'text-slate-700'}`}>{val}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  }>
                  <td className="px-3 py-2 font-mono text-slate-600 max-w-xs truncate">
                    {(qr.query || '').slice(0, 80)}{(qr.query || '').length > 80 ? '…' : ''}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-slate-600">{calls.toLocaleString()}</td>
                  <td className={`px-3 py-2 text-right font-mono font-bold ${mean > 5000 ? 'text-red-600' : mean > 1000 ? 'text-orange-600' : 'text-slate-600'}`}>
                    {mean.toFixed(2)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-slate-500">{max.toFixed(2)}</td>
                  <td className="px-3 py-2 text-right font-mono text-slate-500">{total.toFixed(0)}</td>
                  <td className="px-3 py-2 text-right font-mono text-slate-500">{(+qr.rows || 0).toLocaleString()}</td>
                  <td className={`px-3 py-2 text-right font-mono ${read > 0 ? 'text-amber-600 font-bold' : 'text-slate-400'}`}>
                    {read.toLocaleString()}
                  </td>
                </ExpandRow>
              );
            })}
          </tbody>
        </table>
        {pager}
        </>)}</Paged>
      </div>
    </div>
  );
}

/* ── Shared empties / errors ── */
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
