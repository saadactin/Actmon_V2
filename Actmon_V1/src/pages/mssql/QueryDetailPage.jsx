import React, { useState, useEffect } from 'react';
import { Link, useParams, useLocation, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Zap, Database, Key, Table as TableIcon, AlertTriangle,
  ChevronRight, ChevronDown, Loader2, CheckCircle2, Layers, Gauge,
} from 'lucide-react';
import client from '../../api/client';
import { mssqlTableDetail } from '../../api/drilldown';

const analyzeQuery = (id, body) =>
  client.post(`/connections/mssql/${id}/mssql-slow-queries/analyze-groq`, body).then(r => r.data);

function fmtNum(n) {
  const v = Number(n);
  if (!v && v !== 0) return '—';
  return v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : v.toLocaleString();
}
const sevCls = (s) =>
  s === 'critical' ? 'bg-red-100 text-red-700' : s === 'high' ? 'bg-orange-100 text-orange-700'
  : s === 'medium' ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700';

function CopyBtn({ text }) {
  const [c, setC] = useState(false);
  return (
    <button onClick={() => { navigator.clipboard.writeText(text || ''); setC(true); setTimeout(() => setC(false), 1500); }}
      className="px-2.5 py-1 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-600 text-xs font-semibold flex-shrink-0">
      {c ? 'Copied!' : 'Copy'}
    </button>
  );
}

/* Parse table names from a T-SQL statement (best-effort). */
function parseTables(sql) {
  if (!sql) return [];
  const re = /\b(?:from|join|into|update)\s+(\[?[A-Za-z0-9_#$]+\]?(?:\s*\.\s*\[?[A-Za-z0-9_#$]+\]?){0,2})/gi;
  const KW = new Set(['select', 'where', 'set', 'values', 'on', 'as', 'inner', 'left', 'right', 'outer', 'cross', 'group', 'order', 'by', 'with']);
  const out = []; const seen = new Set(); let m;
  while ((m = re.exec(sql))) {
    const raw = m[1].replace(/[\[\]\s]/g, '');
    if (!raw || raw.includes('(')) continue;
    const parts = raw.split('.').filter(Boolean);
    let schema = 'dbo', table = null;
    if (parts.length === 1) table = parts[0];
    else if (parts.length === 2) { schema = parts[0]; table = parts[1]; }
    else { schema = parts[parts.length - 2]; table = parts[parts.length - 1]; }
    if (!table || KW.has(table.toLowerCase())) continue;
    const key = `${schema}.${table}`.toLowerCase();
    if (seen.has(key)) continue; seen.add(key);
    out.push({ schema, table });
  }
  return out;
}

function StepHead({ n, title, sub }) {
  return (
    <div className="flex items-center gap-3 mb-3">
      <span className="w-8 h-8 rounded-xl bg-gradient-to-br from-blue-600 to-sky-600 text-white font-black flex items-center justify-center text-sm flex-shrink-0">{n}</span>
      <div>
        <h2 className="font-black text-slate-800 text-[15px]">{title}</h2>
        {sub && <p className="text-xs text-slate-400">{sub}</p>}
      </div>
    </div>
  );
}

function AiAnalysis({ a }) {
  if (!a) return null;
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        {a.severity && <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${sevCls(a.severity)}`}>{a.severity}</span>}
        {a.estimated_overall_improvement && <span className="text-[11px] text-emerald-600 font-semibold">Expected gain: {a.estimated_overall_improvement}</span>}
      </div>
      {a.summary && <p className="text-sm text-slate-700"><b>Summary:</b> {a.summary}</p>}
      {a.root_cause && (
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <p className="text-[10px] font-bold text-slate-400 uppercase mb-1">Root cause</p>
          <p className="text-xs text-slate-700">{a.root_cause}</p>
        </div>
      )}
      {(a.issues || []).length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[10px] font-bold text-slate-400 uppercase">Issues found</p>
          {a.issues.map((is, i) => (
            <div key={i} className="bg-white border border-slate-200 rounded-lg px-3 py-2 text-xs">
              <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold mr-2 ${sevCls(is.severity)}`}>{is.type}</span>
              <span className="text-slate-700">{is.description}</span>
              {is.evidence && <p className="text-[10px] text-slate-400 mt-1">Evidence: {is.evidence}</p>}
            </div>
          ))}
        </div>
      )}
      {(a.index_recommendations || []).length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[10px] font-bold text-slate-400 uppercase">Index recommendations</p>
          {a.index_recommendations.map((ix, i) => (
            <div key={i} className="bg-white border border-slate-200 rounded-lg p-3">
              <p className="text-xs text-slate-600 mb-1.5">{ix.reason} {ix.estimated_improvement && <span className="text-emerald-600 font-semibold">({ix.estimated_improvement})</span>}</p>
              <div className="flex items-start gap-2">
                <pre className="flex-1 bg-slate-900 text-green-400 rounded-lg p-2 text-[11px] font-mono overflow-x-auto whitespace-pre-wrap">{ix.create_sql}</pre>
                <CopyBtn text={ix.create_sql} />
              </div>
            </div>
          ))}
        </div>
      )}
      {a.query_rewrite && a.query_rewrite.applicable && a.query_rewrite.optimized_sql && (
        <div className="bg-white border border-slate-200 rounded-lg p-3">
          <p className="text-[10px] font-bold text-slate-400 uppercase mb-1">Suggested rewrite {a.query_rewrite.expected_gain && <span className="text-emerald-600">· {a.query_rewrite.expected_gain}</span>}</p>
          <pre className="bg-slate-900 text-green-400 rounded-lg p-2 text-[11px] font-mono overflow-x-auto whitespace-pre-wrap">{a.query_rewrite.optimized_sql}</pre>
        </div>
      )}
      {(a.priority_actions || []).length > 0 && (
        <div>
          <p className="text-[10px] font-bold text-slate-400 uppercase mb-1">Priority actions</p>
          <ul className="space-y-1 list-disc pl-5">{a.priority_actions.map((p, i) => <li key={i} className="text-xs text-slate-700">{p}</li>)}</ul>
        </div>
      )}
      {a.business_impact && <p className="text-xs text-slate-500"><b>Business impact:</b> {a.business_impact}</p>}
    </div>
  );
}

/* One table's drill-down: stats → indexes → columns → missing indexes */
function TablePanel({ connId, dbName, schema, table }) {
  const [st, setSt] = useState({ loading: true });
  const [showCols, setShowCols] = useState(false);
  useEffect(() => {
    let alive = true;
    mssqlTableDetail(connId, dbName, schema, table)
      .then((d) => { if (alive) setSt({ data: d }); })
      .catch((e) => { if (alive) setSt({ err: e?.response?.data?.detail || e.message }); });
    return () => { alive = false; };
  }, [connId, dbName, schema, table]);

  const d = st.data;
  const stats = d?.stats || {};
  const indexes = d?.indexes || [];
  const cols = d?.columns || [];
  const missing = (d?.missing_indexes || []).filter((m) => m.ddl);

  return (
    <div className="bg-slate-50 rounded-2xl border border-slate-200 overflow-hidden">
      <div className="px-4 py-3 bg-white border-b border-slate-100 flex items-center gap-2 flex-wrap">
        <TableIcon size={14} className="text-blue-600" />
        <span className="font-black text-slate-800 font-mono text-sm">{schema}.{table}</span>
        {d && <>
          <span className="ml-auto text-[11px] text-slate-500">{fmtNum(stats.row_count)} rows</span>
          <span className="text-[11px] text-slate-400">· {stats.total_mb != null ? `${stats.total_mb} MB` : '—'}</span>
          <span className="text-[11px] text-slate-400">· {indexes.length} index{indexes.length !== 1 ? 'es' : ''}</span>
        </>}
      </div>

      {st.loading ? (
        <div className="py-8 flex justify-center"><Loader2 size={20} className="animate-spin text-slate-400" /></div>
      ) : st.err ? (
        <p className="px-4 py-4 text-xs text-slate-400">Could not load details for this object ({st.err}). It may be a CTE, alias, temp table or view.</p>
      ) : (
        <div className="p-4 space-y-4">
          {/* Indexes */}
          <div>
            <p className="text-[10px] font-black text-slate-500 uppercase mb-2 flex items-center gap-1.5"><Key size={11} /> Indexes on this table ({indexes.length})</p>
            {indexes.length === 0 ? (
              <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">No indexes — this table can only be read by full scans, which is slow for large tables.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[11px]">
                  <thead><tr className="bg-white border-b border-slate-200">
                    {['Index', 'Type', 'Unique', 'Key columns', 'Frag %', 'Seeks', 'Scans', 'Lookups'].map(h => (
                      <th key={h} className="px-2 py-1.5 text-left font-bold text-slate-400 uppercase text-[9px] whitespace-nowrap">{h}</th>
                    ))}
                  </tr></thead>
                  <tbody>
                    {indexes.map((ix, i) => (
                      <tr key={i} className="border-b border-slate-100">
                        <td className="px-2 py-1.5 font-bold text-blue-700">{ix.index_name || '(heap)'} {ix.is_primary_key ? <span className="text-[8px] bg-yellow-100 text-yellow-700 px-1 rounded font-bold">PK</span> : null}</td>
                        <td className="px-2 py-1.5 text-slate-500">{ix.type_desc}</td>
                        <td className="px-2 py-1.5">{ix.is_unique ? <span className="text-blue-600 font-bold">Yes</span> : <span className="text-slate-400">No</span>}</td>
                        <td className="px-2 py-1.5 font-mono text-slate-700">{ix.key_columns || '—'}</td>
                        <td className={`px-2 py-1.5 font-bold ${(ix.frag_pct || 0) >= 30 ? 'text-red-600' : 'text-slate-500'}`}>{ix.frag_pct != null ? `${ix.frag_pct}%` : '—'}</td>
                        <td className="px-2 py-1.5 text-slate-500">{fmtNum(ix.seeks)}</td>
                        <td className="px-2 py-1.5 text-slate-500">{fmtNum(ix.scans)}</td>
                        <td className="px-2 py-1.5 text-slate-500">{fmtNum(ix.lookups)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Columns (collapsible) */}
          <div>
            <button onClick={() => setShowCols(s => !s)} className="text-[10px] font-black text-slate-500 uppercase flex items-center gap-1.5">
              {showCols ? <ChevronDown size={12} /> : <ChevronRight size={12} />} <Layers size={11} /> Columns ({cols.length})
            </button>
            {showCols && (
              <div className="overflow-x-auto mt-2">
                <table className="w-full text-[11px]">
                  <thead><tr className="bg-white border-b border-slate-200">
                    {['#', 'Name', 'Type', 'Length', 'Null', 'Key'].map(h => <th key={h} className="px-2 py-1.5 text-left font-bold text-slate-400 uppercase text-[9px]">{h}</th>)}
                  </tr></thead>
                  <tbody>
                    {cols.map((c, i) => (
                      <tr key={i} className="border-b border-slate-100">
                        <td className="px-2 py-1.5 text-slate-400">{c.column_id}</td>
                        <td className="px-2 py-1.5 font-bold text-slate-700">{c.name}</td>
                        <td className="px-2 py-1.5 font-mono text-blue-600">{c.data_type}</td>
                        <td className="px-2 py-1.5 text-slate-500">{c.length}</td>
                        <td className="px-2 py-1.5">{c.is_nullable ? <span className="text-slate-400">NULL</span> : <span className="text-red-500 font-bold">NOT NULL</span>}</td>
                        <td className="px-2 py-1.5">{c.is_pk ? <span className="text-[8px] bg-yellow-100 text-yellow-700 px-1 rounded font-bold">PK</span> : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Missing indexes */}
          {missing.length > 0 && (
            <div>
              <p className="text-[10px] font-black text-slate-500 uppercase mb-2 flex items-center gap-1.5"><AlertTriangle size={11} className="text-amber-500" /> Missing indexes SQL Server suggests ({missing.length})</p>
              <div className="space-y-2">
                {missing.map((m, i) => (
                  <div key={i} className="bg-white border border-amber-200 rounded-lg p-2.5">
                    <p className="text-[11px] text-slate-600 mb-1.5">Estimated <b className="text-emerald-600">{m.impact}%</b> improvement · {fmtNum(m.uses)} uses</p>
                    <div className="flex items-start gap-2">
                      <pre className="flex-1 bg-slate-900 text-green-400 rounded-lg p-2 text-[10px] font-mono overflow-x-auto whitespace-pre-wrap">{m.ddl}</pre>
                      <CopyBtn text={m.ddl} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function MSSQLQueryDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { state } = useLocation();
  const q = state?.query;
  const [ai, setAi] = useState(null);

  if (!q) {
    return (
      <div className="min-h-screen bg-slate-50 p-6">
        <div className="bg-white border border-slate-200 rounded-2xl p-8 max-w-lg">
          <p className="font-bold text-slate-700">No query selected</p>
          <p className="text-sm text-slate-500 mt-1">Open this page by clicking a query on the Slow Queries screen.</p>
          <button onClick={() => navigate(`/mssql-dashboard/${id}/slow-queries`)} className="mt-3 px-4 py-2 bg-blue-600 text-white rounded-xl text-sm font-bold">Go to Slow Queries</button>
        </div>
      </div>
    );
  }

  const sql = q.sql_text || '';
  const tables = parseTables(sql);
  const dbName = q.db_name;

  const runAi = async () => {
    setAi({ loading: true });
    try {
      const res = await analyzeQuery(id, {
        sql_text: sql, db_name: dbName,
        execution_count: Number(q.execution_count) || 0,
        avg_elapsed_ms: Number(q.avg_elapsed_ms) || 0,
        total_cpu_ms: Number(q.total_cpu_ms) || 0,
        avg_logical_reads: Number(q.avg_logical_reads) || 0,
        avg_physical_reads: Number(q.avg_physical_reads) || 0,
      });
      setAi(res.status === 'success' ? { result: res.analysis } : { err: res.error || 'Analysis failed' });
    } catch (e) { setAi({ err: e?.response?.data?.detail || e.message }); }
  };

  const metrics = [
    ['Avg Elapsed', `${fmtNum(q.avg_elapsed_ms)} ms`],
    ['Executions', fmtNum(q.execution_count)],
    ['Total CPU', `${fmtNum(q.total_cpu_ms)} ms`],
    ['Avg Logical Reads', fmtNum(q.avg_logical_reads)],
    ['Avg Physical Reads', fmtNum(q.avg_physical_reads)],
    ['Database', dbName || '—'],
  ];

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="bg-gradient-to-r from-slate-900 via-blue-800 to-sky-700 text-white px-6 py-4">
        <div className="flex items-center gap-4">
          <Link to={`/mssql-dashboard/${id}/slow-queries`} className="w-9 h-9 rounded-xl bg-white/10 hover:bg-white/20 border border-white/20 flex items-center justify-center"><ArrowLeft size={16} /></Link>
          <div>
            <h1 className="text-xl font-black tracking-tight flex items-center gap-2"><Zap size={18} className="text-yellow-400" /> Query Analysis</h1>
            <p className="text-sky-300 text-xs mt-0.5">Tables → indexes → structure → AI performance advice</p>
          </div>
        </div>
      </div>

      <div className="p-5 space-y-6 max-w-6xl">
        {/* STEP 1 */}
        <div className="bg-white rounded-2xl border border-slate-200 p-5">
          <StepHead n="1" title="The query" sub="What it is and how it performs today" />
          <div className="flex items-start gap-2 mb-3">
            <pre className="flex-1 bg-slate-900 text-slate-100 rounded-xl p-3 text-xs font-mono overflow-auto max-h-56 whitespace-pre-wrap break-all">{sql || '(empty)'}</pre>
            <CopyBtn text={sql} />
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
            {metrics.map(([l, v]) => (
              <div key={l} className="bg-slate-50 border border-slate-200 rounded-xl p-2.5">
                <p className="text-[9px] font-bold text-slate-400 uppercase">{l}</p>
                <p className="font-bold text-sm text-slate-800 mt-0.5">{v}</p>
              </div>
            ))}
          </div>
        </div>

        {/* STEP 2 */}
        <div className="bg-white rounded-2xl border border-slate-200 p-5">
          <StepHead n="2" title="Tables this query touches" sub={`${tables.length} table${tables.length !== 1 ? 's' : ''} found in the SQL`} />
          {tables.length === 0 ? (
            <p className="text-sm text-slate-400">No table names could be parsed from this statement.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {tables.map((t, i) => (
                <span key={i} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-blue-50 border border-blue-200 text-blue-700 text-sm font-bold font-mono">
                  <Database size={12} /> {t.schema}.{t.table}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* STEP 3 */}
        {tables.length > 0 && (
          <div className="bg-white rounded-2xl border border-slate-200 p-5">
            <StepHead n="3" title="Indexes & structure (per table)" sub="What indexes exist, how fragmented they are, and which are missing" />
            <div className="space-y-4">
              {tables.map((t, i) => <TablePanel key={i} connId={id} dbName={dbName} schema={t.schema} table={t.table} />)}
            </div>
          </div>
        )}

        {/* STEP 4 */}
        <div className="bg-white rounded-2xl border border-slate-200 p-5">
          <StepHead n="4" title="How to make it faster" sub="AI reviews the query and the table structure above" />
          {!ai && (
            <button onClick={runAi}
              className="inline-flex items-center gap-2 h-11 px-6 rounded-xl bg-gradient-to-r from-indigo-600 to-violet-600 text-white text-sm font-bold shadow hover:shadow-lg transition-all">
              <Gauge size={16} /> Analyse performance with AI
            </button>
          )}
          {ai?.loading && <div className="flex items-center gap-2 text-slate-500 text-sm"><Loader2 size={18} className="animate-spin" /> Analysing the query…</div>}
          {ai?.err && (
            <div className="text-sm text-red-600">
              AI analysis failed: {ai.err}
              <button onClick={runAi} className="ml-3 underline">Retry</button>
            </div>
          )}
          {ai?.result && (
            <>
              <button onClick={runAi} className="mb-3 text-xs text-indigo-600 underline">Re-analyse</button>
              <AiAnalysis a={ai.result} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
