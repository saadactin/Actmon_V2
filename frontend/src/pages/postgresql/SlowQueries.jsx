import React, { useState, useEffect } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { Paged } from '@/components/ui/Pagination';
import { useQuery } from '@tanstack/react-query';
import {
  RefreshCw, ChevronRight, AlertTriangle,
  CheckCircle2, Search, Zap, Clock, ArrowLeft,
  TrendingDown, BarChart2, Info, XCircle, Filter,
  Copy, Check, Settings, PlayCircle, Brain, FileDown,
  Activity, Eye, Code, Loader2, Database, Layers,
} from 'lucide-react';
import client from '@/api/client';
import PageHeader from '@/components/layout/PageHeader';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, PieChart, Pie, Cell, Legend,
} from 'recharts';

// ── API ────────────────────────────────────────────────────────────────────────

const fetchSlowQueries = (id) =>
  client.get(`/connections/postgresql/${id}/pg-slow-queries`).then(r => r.data);

const enableExtension = (id) =>
  client.post(`/connections/postgresql/${id}/enable-pg-stat-statements`).then(r => r.data);

const explainAnalyze = (id, sql) =>
  client.post(`/connections/postgresql/${id}/pg-slow-queries/explain-analyze`, { sql_text: sql }).then(r => r.data);

const analyzeGroq = (id, payload) =>
  client.post(`/connections/postgresql/${id}/pg-slow-queries/analyze-groq`, payload).then(r => r.data);

const PIE_COLORS = ['#6366f1','#f59e0b','#10b981','#ef4444','#8b5cf6','#06b6d4','#f97316','#84cc16'];

// ── CopyBtn ────────────────────────────────────────────────────────────────────

function CopyBtn({ text }) {
  const [copied, setCopied] = useState(false);
  const handle = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <button
      onClick={handle}
      className="ml-auto flex-shrink-0 flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-bold transition-all"
      style={copied
        ? { background: '#dcfce7', color: '#166534', border: '1px solid #bbf7d0' }
        : { background: '#f1f5f9', color: '#475569', border: '1px solid #e2e8f0' }}
      title="Copy to clipboard"
    >
      {copied ? <Check size={10} /> : <Copy size={10} />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

// ── SeverityBadge ──────────────────────────────────────────────────────────────

function SeverityBadge({ severity }) {
  const styles = {
    critical: { bg:'#fef2f2', color:'#dc2626', border:'#fecaca', label:'Critical' },
    high:     { bg:'#fff7ed', color:'#d97706', border:'#fed7aa', label:'High' },
    medium:   { bg:'#fffbeb', color:'#ca8a04', border:'#fde68a', label:'Medium' },
    low:      { bg:'#f0fdf4', color:'#16a34a', border:'#bbf7d0', label:'Low' },
  };
  const s = styles[severity?.toLowerCase()] || styles.medium;
  return (
    <span className="px-2 py-0.5 rounded-full text-[10px] font-black border"
      style={{ background: s.bg, color: s.color, borderColor: s.border }}>
      {s.label}
    </span>
  );
}

// ── KpiCard ────────────────────────────────────────────────────────────────────

function KpiCard({ icon, label, value, accent = 'slate', sub }) {
  const border = {
    red: 'border-l-red-500', yellow: 'border-l-yellow-400',
    green: 'border-l-green-500', indigo: 'border-l-indigo-500', slate: 'border-l-slate-300',
  }[accent] || 'border-l-slate-300';
  return (
    <div className={`bg-white rounded-2xl border border-slate-200 border-l-4 ${border} p-4`}>
      <div className="flex justify-between items-start">
        <div>
          <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wide">{label}</p>
          <p className="text-xl font-black text-slate-800 mt-1">{value}</p>
          {sub && <p className="text-[10px] text-slate-400 mt-0.5">{sub}</p>}
        </div>
        {icon}
      </div>
    </div>
  );
}

// ── SetupGuide ─────────────────────────────────────────────────────────────────

function SetupGuide({ connId, onSuccess }) {
  const [enabling, setEnabling] = useState(false);
  const [result, setResult]     = useState(null);

  const handleEnable = async () => {
    setEnabling(true);
    setResult(null);
    try {
      const res = await enableExtension(connId);
      setResult(res);
      if (res.status === 'success') onSuccess?.();
    } catch (err) {
      setResult({ status: 'error', message: err?.message || 'Request failed.' });
    } finally {
      setEnabling(false);
    }
  };

  const step1 = `shared_preload_libraries = 'pg_stat_statements'`;
  const step2 = `CREATE EXTENSION IF NOT EXISTS pg_stat_statements;`;
  const grantCmd = `GRANT pg_read_all_stats TO your_user;`;

  return (
    <div className="bg-orange-50 border border-orange-200 rounded-2xl overflow-hidden">
      <div className="px-5 py-4 flex items-center gap-3 bg-orange-100/60 border-b border-orange-200">
        <div className="w-9 h-9 rounded-xl bg-orange-200 flex items-center justify-center flex-shrink-0">
          <Settings size={18} className="text-orange-700" />
        </div>
        <div className="flex-1">
          <p className="font-extrabold text-orange-900 text-sm">pg_stat_statements is not enabled</p>
          <p className="text-xs text-orange-700 mt-0.5">
            Required for slow query analysis — enable it to unlock all 4 tabs.
          </p>
        </div>
      </div>
      <div className="p-5 space-y-4">
        {result && (
          <div className={`px-4 py-3 rounded-xl border text-sm flex items-start gap-2 ${
            result.status === 'success'       ? 'bg-green-50 border-green-200 text-green-800'
            : result.status === 'needs_restart' ? 'bg-amber-50 border-amber-300 text-amber-800'
            : 'bg-red-50 border-red-200 text-red-800'}`}>
            {result.status === 'success'
              ? <CheckCircle2 size={15} className="mt-0.5 flex-shrink-0 text-green-600" />
              : <AlertTriangle size={15} className="mt-0.5 flex-shrink-0" />}
            <span>{result.message}</span>
          </div>
        )}
        {result?.status !== 'success' && (
          <div className="flex items-center gap-3">
            <button onClick={handleEnable} disabled={enabling}
              className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-bold text-white transition-all disabled:opacity-60 hover:opacity-90 active:scale-95"
              style={{ background: 'linear-gradient(135deg, #f59e0b, #d97706)' }}>
              {enabling ? <Loader2 size={15} className="animate-spin" /> : <PlayCircle size={15} />}
              {enabling ? 'Enabling…' : 'Enable Extension Automatically'}
            </button>
            <span className="text-xs text-orange-600">
              Runs <code className="font-mono bg-orange-100 px-1 rounded">CREATE EXTENSION</code>
            </span>
          </div>
        )}
        <div className="flex items-center gap-3">
          <div className="flex-1 h-px bg-orange-200" />
          <span className="text-[10px] font-bold text-orange-400 uppercase tracking-wider">or set up manually</span>
          <div className="flex-1 h-px bg-orange-200" />
        </div>
        <div className="space-y-1.5">
          <p className="text-xs font-extrabold text-orange-900 flex items-center gap-1.5">
            <span className="w-5 h-5 rounded-full bg-orange-300 text-orange-900 flex items-center justify-center text-[10px] font-black flex-shrink-0">1</span>
            Add to <code className="font-mono">postgresql.conf</code> and restart
          </p>
          <div className="bg-slate-900 rounded-xl p-3 flex items-center gap-2">
            <code className="flex-1 text-xs font-mono text-green-300">{step1}</code>
            <CopyBtn text={step1} />
          </div>
        </div>
        <div className="space-y-1.5">
          <p className="text-xs font-extrabold text-orange-900 flex items-center gap-1.5">
            <span className="w-5 h-5 rounded-full bg-orange-300 text-orange-900 flex items-center justify-center text-[10px] font-black flex-shrink-0">2</span>
            Create the extension
          </p>
          <div className="bg-slate-900 rounded-xl p-3 flex items-center gap-2">
            <code className="flex-1 text-xs font-mono text-yellow-300">{step2}</code>
            <CopyBtn text={step2} />
          </div>
        </div>
        <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 text-xs text-blue-700 flex items-start gap-2">
          <Info size={13} className="mt-0.5 flex-shrink-0 text-blue-500" />
          <div>
            <strong>Permission needed?</strong> Grant stats access with:
            <div className="mt-1.5 bg-slate-900 rounded-lg p-2 flex items-center gap-2">
              <code className="flex-1 font-mono text-green-300">{grantCmd}</code>
              <CopyBtn text={grantCmd} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── AIAnalysisPanel ────────────────────────────────────────────────────────────

function AIAnalysisPanel({ connId, query, extraPayload }) {
  const [loading, setLoading] = useState(false);
  const [result, setResult]   = useState(null);
  const [error, setError]     = useState(null);

  const run = async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const hit  = +(query.shared_blks_hit  || 0);
      const read = +(query.shared_blks_read || 0);
      const cacheHitPct = (hit + read) > 0 ? ((hit / (hit + read)) * 100) : 100;
      const r = await analyzeGroq(connId, {
        sql_text:          query.query || '',
        user_name:         query.user_name || '',
        calls:             +(query.calls || 0),
        mean_exec_time_ms: +(query.mean_exec_time || 0),
        max_exec_time_ms:  +(query.max_exec_time  || 0),
        total_exec_time_ms: +(query.total_exec_time || 0),
        rows:              +(query.rows || 0),
        shared_blks_hit:   hit,
        shared_blks_read:  read,
        cache_hit_pct:     +cacheHitPct.toFixed(2),
        explain_rows:      extraPayload?.explain_rows || [],
      });
      if (r.status === 'error') throw new Error(r.error);
      setResult(r.analysis);
    } catch (err) {
      setError(err?.message || 'Analysis failed');
    } finally {
      setLoading(false);
    }
  };

  if (!result && !loading && !error) {
    return (
      <button onClick={run}
        className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-bold text-white hover:opacity-90 active:scale-95 transition-all"
        style={{ background: 'linear-gradient(135deg, #6366f1, #8b5cf6)' }}>
        <Brain size={15} /> Analyze with ActMon AI
      </button>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center gap-3 py-4">
        <Loader2 size={20} className="animate-spin text-indigo-500" />
        <span className="text-sm text-slate-600">Running ActMon AI analysis — usually 5–10 seconds…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-xl p-4">
        <div className="flex items-center gap-2 text-red-700 font-bold mb-1 text-sm">
          <XCircle size={14} /> Analysis failed
        </div>
        <p className="text-xs text-red-600">{error}</p>
        <button onClick={run} className="mt-2 text-xs text-red-700 underline">Retry</button>
      </div>
    );
  }

  const a = result;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 rounded-xl bg-indigo-100 flex items-center justify-center">
          <Brain size={15} className="text-indigo-600" />
        </div>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="font-extrabold text-slate-800 text-sm">ActMon AI Analysis</span>
            <SeverityBadge severity={a.severity} />
          </div>
          {a.severity_reason && <p className="text-xs text-slate-500 mt-0.5">{a.severity_reason}</p>}
        </div>
        <button onClick={run} title="Re-analyze" className="p-1.5 rounded-lg hover:bg-slate-100">
          <RefreshCw size={13} className="text-slate-400" />
        </button>
      </div>

      {/* Summary */}
      <div className="bg-indigo-50 border border-indigo-200 rounded-xl p-3">
        <p className="text-xs font-bold text-indigo-700 mb-1">Summary</p>
        <p className="text-sm text-indigo-900">{a.summary}</p>
      </div>

      {/* Root cause */}
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-3">
        <p className="text-xs font-bold text-amber-700 mb-1">Root Cause</p>
        <p className="text-sm text-amber-900">{a.root_cause}</p>
      </div>

      {/* Issues */}
      {a.issues?.length > 0 && (
        <div>
          <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2">Detected Issues</p>
          <div className="space-y-2">
            {a.issues.map((issue, i) => (
              <div key={i} className={`rounded-xl border px-3 py-2 text-xs ${
                issue.severity === 'critical' ? 'bg-red-50 border-red-200'
                : issue.severity === 'high'   ? 'bg-orange-50 border-orange-200'
                : 'bg-amber-50 border-amber-200'}`}>
                <div className="flex items-center gap-2 mb-0.5">
                  <SeverityBadge severity={issue.severity} />
                  <span className="font-bold text-slate-700">{issue.type}</span>
                  {issue.table && <span className="text-slate-400 font-mono">({issue.table})</span>}
                </div>
                <p className="text-slate-600">{issue.description}</p>
                {issue.evidence && (
                  <p className="mt-0.5 font-mono text-slate-500 text-[10px]">Evidence: {issue.evidence}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Index recommendations */}
      {a.index_recommendations?.length > 0 && (
        <div>
          <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2">Index Recommendations</p>
          <div className="space-y-2">
            {a.index_recommendations.map((rec, i) => (
              <div key={i} className="bg-green-50 border border-green-200 rounded-xl p-3">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs font-bold text-green-800">{rec.table}</span>
                  <span className="text-[10px] text-green-600">({rec.index_type})</span>
                </div>
                <p className="text-xs text-green-700 mb-1">{rec.reason}</p>
                {rec.create_sql && (
                  <div className="bg-slate-900 rounded-lg p-2 flex items-start gap-2">
                    <code className="flex-1 text-[11px] font-mono text-green-300 whitespace-pre-wrap">{rec.create_sql}</code>
                    <CopyBtn text={rec.create_sql} />
                  </div>
                )}
                {rec.estimated_improvement && (
                  <p className="text-[10px] text-green-600 mt-1">{rec.estimated_improvement}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Query rewrite */}
      {a.query_rewrite?.applicable && a.query_rewrite?.optimized_sql && (
        <div>
          <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2">Optimized Query</p>
          <div className="bg-slate-900 rounded-xl p-3 relative">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[10px] font-bold text-green-400">
                Expected gain: {a.query_rewrite.expected_gain}
              </span>
            </div>
            <pre className="text-xs font-mono text-green-300 whitespace-pre-wrap pr-14 max-h-48 overflow-auto">
              {a.query_rewrite.optimized_sql}
            </pre>
            <div className="absolute top-2 right-2">
              <CopyBtn text={a.query_rewrite.optimized_sql} />
            </div>
          </div>
          {a.query_rewrite.explanation && (
            <p className="text-xs text-slate-500 mt-1">{a.query_rewrite.explanation}</p>
          )}
        </div>
      )}

      {/* Priority actions */}
      {a.priority_actions?.length > 0 && (
        <div>
          <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2">Priority Actions</p>
          <div className="space-y-1">
            {a.priority_actions.map((action, i) => (
              <div key={i} className="flex items-start gap-2 text-xs text-slate-700 bg-white border border-slate-200 rounded-xl px-3 py-2">
                <span className="w-4 h-4 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center text-[9px] font-black flex-shrink-0 mt-0.5">
                  {i + 1}
                </span>
                {action}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Business impact + improvement */}
      {(a.business_impact || a.estimated_overall_improvement) && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {a.business_impact && (
            <div className="bg-blue-50 border border-blue-200 rounded-xl p-3">
              <p className="text-[10px] font-bold text-blue-600 uppercase mb-1">Business Impact</p>
              <p className="text-xs text-blue-800">{a.business_impact}</p>
            </div>
          )}
          {a.estimated_overall_improvement && (
            <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3">
              <p className="text-[10px] font-bold text-emerald-600 uppercase mb-1">Expected Improvement</p>
              <p className="text-xs text-emerald-800">{a.estimated_overall_improvement}</p>
            </div>
          )}
        </div>
      )}

      {/* Validation queries */}
      {a.validation_queries?.length > 0 && (
        <div>
          <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2">Validation Queries</p>
          <div className="space-y-2">
            {a.validation_queries.map((vq, i) => (
              <div key={i} className="bg-slate-900 rounded-xl p-3 flex items-start gap-2">
                <code className="flex-1 text-[11px] font-mono text-cyan-300 whitespace-pre-wrap">{vq}</code>
                <CopyBtn text={vq} />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── ExplainPanel ───────────────────────────────────────────────────────────────

function ExplainPanel({ connId, query }) {
  const [loading, setLoading] = useState(false);
  const [data, setData]       = useState(null);
  const [error, setError]     = useState(null);

  const run = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await explainAnalyze(connId, query.query);
      if (r.status === 'error') throw new Error(r.error);
      setData(r);
    } catch (err) {
      setError(err?.message || 'EXPLAIN failed');
    } finally {
      setLoading(false);
    }
  };

  if (!data && !loading && !error) {
    return (
      <div className="space-y-2">
        <button onClick={run}
          className="flex items-center gap-2 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-xl text-xs font-bold transition-colors">
          <Eye size={13} /> Run EXPLAIN ANALYZE
        </button>
        <p className="text-[10px] text-slate-400">
          Runs <code className="font-mono">EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)</code> on this connection.
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center gap-3 py-4">
        <Loader2 size={18} className="animate-spin text-slate-500" />
        <span className="text-sm text-slate-600">Running EXPLAIN ANALYZE…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-xl p-4">
        <p className="font-bold text-red-700 text-xs mb-1">EXPLAIN failed</p>
        <p className="text-xs text-red-600">{error}</p>
        <button onClick={run} className="mt-2 text-xs text-red-700 underline">Retry</button>
      </div>
    );
  }

  const nodes = data.nodes || [];
  const hints = data.hints || [];

  return (
    <div className="space-y-3">
      {/* Timings */}
      <div className="flex flex-wrap gap-3 items-center">
        <StatPill label="Planning Time"  value={`${(data.planning_time  || 0).toFixed(2)} ms`} />
        {data.analyzed && (
          <StatPill label="Execution Time" value={`${(data.execution_time || 0).toFixed(2)} ms`} />
        )}
        {!data.analyzed && (
          <div className="flex items-center gap-1 px-2 py-1 bg-amber-50 border border-amber-200 rounded-lg text-[10px] font-semibold text-amber-700">
            <Info size={10} /> Estimated plan — params replaced with NULL
          </div>
        )}
        {hints.length > 0 && (
          <div className="flex items-center gap-1 px-2 py-1 bg-amber-50 border border-amber-200 rounded-lg text-[10px] font-bold text-amber-700">
            <AlertTriangle size={10} /> {hints.length} issue{hints.length !== 1 ? 's' : ''}
          </div>
        )}
      </div>

      {/* Plan nodes */}
      {nodes.length > 0 && (
        <div className="rounded-xl overflow-hidden border border-slate-700">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-slate-800 text-slate-300">
                <th className="px-3 py-1.5 text-left font-bold">Node Type</th>
                <th className="px-3 py-1.5 text-left font-bold">Relation</th>
                <th className="px-3 py-1.5 text-right font-bold">{data.analyzed ? 'Actual Rows' : 'Est. Rows'}</th>
                <th className="px-3 py-1.5 text-right font-bold">{data.analyzed ? 'Actual Time' : 'Est. Cost'}</th>
                <th className="px-3 py-1.5 text-right font-bold">Loops</th>
              </tr>
            </thead>
            <tbody>
              {nodes.map((node, i) => {
                const isSeq  = node.node_type?.includes('Seq Scan');
                const isSort = node.node_type?.includes('Sort');
                const indent = '  '.repeat(node.depth || 0);
                return (
                  <tr key={i} className={`border-b border-slate-700 ${
                    isSeq ? 'bg-red-950/30' : isSort ? 'bg-amber-950/30' : 'bg-slate-900'}`}>
                    <td className="px-3 py-1.5 font-mono text-[11px]">
                      <span className={isSeq ? 'text-red-400' : isSort ? 'text-amber-400' : 'text-green-300'}>
                        {indent}{node.node_type}
                      </span>
                      {isSeq && <span className="ml-1 text-[9px] bg-red-900 text-red-300 px-1 rounded font-bold uppercase">seq scan</span>}
                    </td>
                    <td className="px-3 py-1.5 text-slate-400 font-mono text-[10px]">
                      {node.relation || node.alias || '—'}
                    </td>
                    <td className="px-3 py-1.5 text-right text-slate-300">
                      {data.analyzed
                        ? (node.actual_rows ?? 0).toLocaleString()
                        : (node.plan_rows ?? 0).toLocaleString()}
                    </td>
                    <td className="px-3 py-1.5 text-right text-slate-300">
                      {data.analyzed
                        ? (node.actual_total_time != null ? `${node.actual_total_time.toFixed(2)} ms` : '—')
                        : (node.total_cost != null ? node.total_cost.toFixed(2) : '—')}
                    </td>
                    <td className="px-3 py-1.5 text-right text-slate-400">
                      {data.analyzed ? (node.actual_loops ?? 1) : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Hints */}
      {hints.length > 0 && (
        <div className="space-y-2">
          {hints.map((h, i) => (
            <div key={i} className={`rounded-xl border px-3 py-2 text-xs ${
              h.level === 'critical' ? 'bg-red-50 border-red-200 text-red-800'
              : 'bg-amber-50 border-amber-200 text-amber-800'}`}>
              <div className="font-bold mb-0.5 flex items-center gap-1.5">
                <AlertTriangle size={10} /> {h.title}
              </div>
              <p>{h.text}</p>
              {h.fix && <p className="mt-0.5 italic text-slate-500">{h.fix}</p>}
            </div>
          ))}
        </div>
      )}

      <button onClick={run} className="text-[10px] text-slate-400 hover:text-slate-600 underline">
        Re-run EXPLAIN
      </button>
    </div>
  );
}

// ── StatPill ───────────────────────────────────────────────────────────────────

function StatPill({ label, value, warn }) {
  return (
    <div className={`rounded-xl border p-2.5 ${warn ? 'bg-amber-50 border-amber-200' : 'bg-white border-slate-200'}`}>
      <p className="text-[9px] font-bold text-slate-400 uppercase tracking-wide">{label}</p>
      <p className={`font-bold text-sm mt-0.5 ${warn ? 'text-amber-700' : 'text-slate-800'}`}>{value}</p>
    </div>
  );
}

// ── QueryRow ───────────────────────────────────────────────────────────────────

function QueryRow({ q, idx, connId }) {
  const navigate = useNavigate();

  const avg   = +(q.mean_exec_time  || 0);
  const max   = +(q.max_exec_time   || 0);
  const calls = +(q.calls           || 0);
  const hit   = +(q.shared_blks_hit  || 0);
  const read  = +(q.shared_blks_read || 0);
  const cacheHitPct = (hit + read) > 0 ? ((hit / (hit + read)) * 100).toFixed(1) : null;

  const severity = avg > 10000 ? 'critical' : avg > 2000 ? 'high' : avg > 500 ? 'medium' : 'low';
  const fmtMs = (ms) => ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(1)} ms`;

  const goToDetail = () =>
    navigate(`/postgresql-dashboard/${connId}/slow-queries/detail`, { state: { query: q } });

  return (
    <>
      <tr
        onClick={goToDetail}
        className="border-b border-slate-100 cursor-pointer hover:bg-indigo-50 transition-colors group"
      >
        <td className="px-3 py-3 text-slate-300 group-hover:text-indigo-400">
          <ChevronRight size={14} />
        </td>
        <td className="px-3 py-3">
          <SeverityBadge severity={severity} />
        </td>
        <td className="px-4 py-3 max-w-xs">
          <div className="flex items-center gap-2">
            {read > 0 && <span className="w-2 h-2 rounded-full bg-yellow-400 flex-shrink-0" title="Disk reads detected" />}
            <span className="font-mono text-xs text-slate-700 truncate group-hover:text-indigo-700">
              {(q.query || '').replace(/\s+/g, ' ').slice(0, 90)}
            </span>
          </div>
          {q.user_name && (
            <span className="text-[10px] text-slate-400 mt-0.5 block">user: {q.user_name}</span>
          )}
        </td>
        <td className="px-3 py-3 text-right">
          <span className={`text-xs font-black ${avg > 10000 ? 'text-red-600' : avg > 2000 ? 'text-orange-500' : avg > 500 ? 'text-amber-600' : 'text-slate-700'}`}>
            {fmtMs(avg)}
          </span>
        </td>
        <td className="px-3 py-3 text-right text-xs font-semibold text-slate-600">{fmtMs(max)}</td>
        <td className="px-3 py-3 text-right text-xs text-slate-500">{calls.toLocaleString()}</td>
        <td className="px-3 py-3 text-right text-xs text-slate-500">{(+(q.rows || 0)).toLocaleString()}</td>
        <td className="px-3 py-3 text-right text-xs">
          {cacheHitPct !== null ? (
            <span className={`font-bold ${+cacheHitPct < 90 ? 'text-red-600' : +cacheHitPct < 99 ? 'text-orange-500' : 'text-green-600'}`}>
              {cacheHitPct}%
            </span>
          ) : <span className="text-slate-300">—</span>}
        </td>
      </tr>

    </>
  );
}

// ── HotspotCard ────────────────────────────────────────────────────────────────

function HotspotCard({ title, icon, items, metric, metricColor }) {
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-4">
      <div className="flex items-center gap-2 mb-3">
        {icon}
        <p className="text-xs font-extrabold text-slate-700">{title}</p>
      </div>
      {items.length === 0 ? (
        <p className="text-xs text-slate-400">No data</p>
      ) : (
        <div className="space-y-2">
          {items.map((q, i) => (
            <div key={i} className="flex items-start justify-between gap-2">
              <span className="text-[10px] font-mono text-slate-600 truncate flex-1">
                {(q.query || '').replace(/\s+/g, ' ').slice(0, 55)}
              </span>
              <span className={`text-[10px] font-black flex-shrink-0 ${metricColor(q)}`}>
                {metric(q)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Overview Tab ───────────────────────────────────────────────────────────────

function OverviewTab({ queries, pgssAvail, connId, onRefetch }) {
  const totalCalls     = queries.reduce((s, q) => s + +(q.calls || 0), 0);
  const avgTime        = queries.length ? queries.reduce((s, q) => s + +(q.mean_exec_time || 0), 0) / queries.length : 0;
  const cacheMissCount = queries.filter(q => +(q.shared_blks_read || 0) > 0).length;

  const barData = [...queries]
    .sort((a, b) => +(b.mean_exec_time || 0) - +(a.mean_exec_time || 0))
    .slice(0, 12)
    .map((q, i) => ({
      name: `Q${i + 1}`,
      avg:  +(q.mean_exec_time || 0),
      max:  +(q.max_exec_time  || 0),
      label: (q.query || '').replace(/\s+/g, ' ').slice(0, 40),
    }));

  const userMap = {};
  queries.forEach(q => {
    const u = q.user_name || 'unknown';
    userMap[u] = (userMap[u] || 0) + 1;
  });
  const pieData = Object.entries(userMap).map(([name, value]) => ({ name, value }));

  const fmtMs = (ms) => ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms.toFixed(0)}ms`;

  const top5Slow      = [...queries].sort((a, b) => +(b.mean_exec_time  || 0) - +(a.mean_exec_time  || 0)).slice(0, 5);
  const top5Calls     = [...queries].sort((a, b) => +(b.calls           || 0) - +(a.calls           || 0)).slice(0, 5);
  const top5CacheMiss = [...queries].filter(q => +(q.shared_blks_read || 0) > 0)
    .sort((a, b) => +(b.shared_blks_read || 0) - +(a.shared_blks_read || 0)).slice(0, 5);

  return (
    <div className="space-y-4">
      {!pgssAvail && <SetupGuide connId={connId} onSuccess={onRefetch} />}

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard icon={<BarChart2 size={18} className="text-slate-400" />}
          label="Unique Queries" value={queries.length} />
        <KpiCard icon={<Activity size={18} className="text-indigo-400" />}
          label="Total Calls" value={totalCalls.toLocaleString()} accent="indigo" />
        <KpiCard icon={<Clock size={18} className="text-orange-400" />}
          label="Avg Query Time" value={`${avgTime.toFixed(1)} ms`}
          accent={avgTime > 2000 ? 'red' : 'slate'} />
        <KpiCard icon={<TrendingDown size={18} className="text-yellow-500" />}
          label="Cache Miss Queries" value={cacheMissCount}
          accent={cacheMissCount > 0 ? 'yellow' : 'slate'} />
      </div>

      {/* Charts */}
      {pgssAvail && queries.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2 bg-white rounded-2xl border border-slate-200 p-4">
            <p className="text-xs font-bold text-slate-600 mb-3">Top 12 Slowest Queries — Avg vs Max Time</p>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={barData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="name" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} unit=" ms" width={55} />
                <Tooltip
                  formatter={(v, n) => [`${v.toFixed(2)} ms`, n === 'avg' ? 'Avg Time' : 'Max Time']}
                  labelFormatter={(_, p) => p?.[0]?.payload?.label || ''}
                  contentStyle={{ fontSize: 11 }}
                />
                <Bar dataKey="avg" name="avg" fill="#6366f1" radius={[4, 4, 0, 0]} />
                <Bar dataKey="max" name="max" fill="#f59e0b" radius={[4, 4, 0, 0]} opacity={0.55} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="bg-white rounded-2xl border border-slate-200 p-4">
            <p className="text-xs font-bold text-slate-600 mb-3">Queries by User</p>
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie data={pieData} cx="50%" cy="50%" innerRadius={50} outerRadius={80}
                  dataKey="value" nameKey="name"
                  label={({ name, percent }) => percent > 0.08 ? name : ''}>
                  {pieData.map((_, i) => (
                    <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip contentStyle={{ fontSize: 11 }} />
                <Legend iconSize={8} wrapperStyle={{ fontSize: 11 }} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Hotspots */}
      {pgssAvail && queries.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <HotspotCard title="Slowest Queries" icon={<Clock size={14} className="text-orange-500" />}
            items={top5Slow}
            metric={q => fmtMs(+(q.mean_exec_time || 0))}
            metricColor={q => +(q.mean_exec_time || 0) > 10000 ? 'text-red-600' : 'text-orange-600'} />
          <HotspotCard title="Most Called" icon={<Activity size={14} className="text-indigo-500" />}
            items={top5Calls}
            metric={q => `${(+(q.calls || 0)).toLocaleString()} calls`}
            metricColor={() => 'text-indigo-600'} />
          <HotspotCard title="Most Disk Reads" icon={<Database size={14} className="text-yellow-500" />}
            items={top5CacheMiss}
            metric={q => `${(+(q.shared_blks_read || 0)).toLocaleString()} blks`}
            metricColor={() => 'text-yellow-600'} />
        </div>
      )}

      {pgssAvail && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 text-xs text-blue-700 flex items-center gap-2">
          <Info size={13} className="text-blue-500 flex-shrink-0" />
          Data from <strong className="mx-1">pg_stat_statements</strong> — cumulative since last reset or server restart.
          Use <code className="font-mono bg-blue-100 px-1 rounded mx-1">pg_stat_statements_reset()</code> to clear all counters.
        </div>
      )}
    </div>
  );
}

// ── AI Analysis Tab ────────────────────────────────────────────────────────────

function AIAnalysisTab({ queries, connId }) {
  const [selected, setSelected] = useState(null);
  const [selIdx, setSelIdx]     = useState(null);

  const worst5 = [...queries]
    .sort((a, b) => +(b.mean_exec_time || 0) - +(a.mean_exec_time || 0))
    .slice(0, 5);

  const fmtMs = (ms) => ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms.toFixed(0)}ms`;

  return (
    <div className="space-y-4">
      <div className="bg-indigo-50 border border-indigo-200 rounded-2xl p-4">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-9 h-9 rounded-xl bg-indigo-100 flex items-center justify-center">
            <Brain size={16} className="text-indigo-600" />
          </div>
          <div>
            <p className="font-extrabold text-indigo-900 text-sm">ActMon AI Deep Analysis</p>
            <p className="text-xs text-indigo-600">
              Powered by <strong>ActMon AI Engine</strong> — instant DBA-level insights
            </p>
          </div>
        </div>

        {worst5.length === 0 ? (
          <p className="text-xs text-indigo-500">No query data available. Enable pg_stat_statements and run some queries first.</p>
        ) : (
          <>
            <p className="text-xs font-bold text-indigo-700 mb-2">Top 5 Worst Queries — Quick Pick</p>
            <div className="space-y-1.5">
              {worst5.map((q, i) => (
                <button key={i} onClick={() => { setSelected(q); setSelIdx(i); }}
                  className={`w-full text-left px-3 py-2 rounded-xl text-xs border transition-all ${
                    selected === q
                      ? 'bg-indigo-600 text-white border-indigo-600'
                      : 'bg-white border-indigo-200 hover:bg-indigo-100 text-indigo-900'}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono truncate flex-1">
                      {(q.query || '').replace(/\s+/g, ' ').slice(0, 70)}
                    </span>
                    <span className="font-black flex-shrink-0">
                      {fmtMs(+(q.mean_exec_time || 0))}
                    </span>
                  </div>
                  {q.user_name && (
                    <span className={`text-[10px] ${selected === q ? 'text-indigo-200' : 'text-indigo-400'}`}>
                      user: {q.user_name}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {selected && (
        <div className="bg-white rounded-2xl border border-slate-200 p-4">
          <p className="text-[10px] font-bold text-slate-500 uppercase mb-3">
            Analyzing Query #{(selIdx || 0) + 1}
          </p>
          <AIAnalysisPanel connId={connId} query={selected} key={(selected.query || '').slice(0, 40)} />
        </div>
      )}

      {!selected && worst5.length > 0 && (
        <div className="text-center py-12 text-slate-400">
          <Brain size={32} className="mx-auto mb-3 opacity-30" />
          <p className="text-sm">Select a query above to get AI analysis</p>
        </div>
      )}
    </div>
  );
}

// ── Reports Tab ────────────────────────────────────────────────────────────────

function ReportsTab({ queries, connId }) {
  const exportCsv = () => {
    const headers = ['Query','User','Calls','Avg Time (ms)','Max Time (ms)','Total Time (ms)','Rows','Blks Hit','Blks Read','Cache Hit%'];
    const rows = queries.map(q => {
      const hit  = +(q.shared_blks_hit  || 0);
      const read = +(q.shared_blks_read || 0);
      const cacheHitPct = (hit + read) > 0 ? ((hit / (hit + read)) * 100).toFixed(1) : '';
      return [
        `"${(q.query || '').replace(/"/g, '""').slice(0, 200)}"`,
        q.user_name || '',
        +(q.calls || 0),
        +(q.mean_exec_time  || 0),
        +(q.max_exec_time   || 0),
        +(q.total_exec_time || 0),
        +(q.rows || 0),
        hit,
        read,
        cacheHitPct,
      ].join(',');
    });
    const csv  = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `pg_slow_queries_${connId}_${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const totalCalls = queries.reduce((s, q) => s + +(q.calls || 0), 0);
  const totalTime  = queries.reduce((s, q) => s + +(q.total_exec_time || 0), 0);
  const cacheMissQ = queries.filter(q => +(q.shared_blks_read || 0) > 0).length;
  const criticalQ  = queries.filter(q => +(q.mean_exec_time || 0) > 10000).length;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard icon={<BarChart2 size={18} className="text-slate-400" />}
          label="Total Queries" value={queries.length} />
        <KpiCard icon={<Activity size={18} className="text-indigo-400" />}
          label="Total Calls" value={totalCalls.toLocaleString()} accent="indigo" />
        <KpiCard icon={<Clock size={18} className="text-orange-400" />}
          label="Total DB Time" value={`${(totalTime / 1000).toFixed(1)} s`} accent="slate" />
        <KpiCard icon={<AlertTriangle size={18} className="text-red-400" />}
          label="Critical Queries (>10s)" value={criticalQ}
          accent={criticalQ > 0 ? 'red' : 'slate'} />
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 p-5">
        <div className="flex items-center justify-between mb-3">
          <div>
            <p className="font-extrabold text-slate-800">Export Slow Query Report</p>
            <p className="text-xs text-slate-500 mt-0.5">
              {queries.length} queries · {cacheMissQ} with disk reads · {criticalQ} critical (&gt;10s avg)
            </p>
          </div>
          <button onClick={exportCsv}
            className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-bold text-white hover:opacity-90 active:scale-95 transition-all"
            style={{ background: 'linear-gradient(135deg, #6366f1, #8b5cf6)' }}>
            <FileDown size={14} /> Export CSV
          </button>
        </div>
        <p className="text-xs text-slate-400">
          Includes query text, user, call counts, timing stats, and cache metrics. Suitable for performance audits and sharing with your team.
        </p>
      </div>
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────────

export default function SlowQueries() {
  const { id } = useParams();
  const [tab, setTab]               = useState('overview');
  const [search, setSearch]         = useState('');
  const [minTime, setMinTime]       = useState(0);
  const [sortBy, setSortBy]         = useState('avg_desc');
  const [userFilter, setUserFilter] = useState('');
  const [countdown, setCountdown]   = useState(30);

  const { data, isLoading, error, refetch, dataUpdatedAt } = useQuery({
    queryKey:       ['pgSlowQueries', id],
    queryFn:        () => fetchSlowQueries(id),
    retry:          false,
    refetchInterval: 30000,
  });

  useEffect(() => {
    if (!dataUpdatedAt) return;
    const tick = setInterval(() => {
      const elapsed = Math.floor((Date.now() - dataUpdatedAt) / 1000);
      setCountdown(Math.max(0, 30 - elapsed));
    }, 1000);
    return () => clearInterval(tick);
  }, [dataUpdatedAt]);

  if (isLoading) return <Spinner label="Loading slow queries…" />;
  if (error)     return <Err msg={error.message} onRetry={refetch} />;

  const queries   = data?.queries || [];
  const pgssAvail = data?.pg_stat_statements_available !== false;

  const users = [...new Set(queries.map(q => q.user_name).filter(Boolean))];

  const filtered = queries
    .filter(q => {
      const okSearch = !search || (q.query || '').toLowerCase().includes(search.toLowerCase());
      const okTime   = +(q.mean_exec_time || 0) >= minTime;
      const okUser   = !userFilter || q.user_name === userFilter;
      return okSearch && okTime && okUser;
    })
    .sort((a, b) => {
      if (sortBy === 'avg_desc')   return +(b.mean_exec_time   || 0) - +(a.mean_exec_time   || 0);
      if (sortBy === 'max_desc')   return +(b.max_exec_time    || 0) - +(a.max_exec_time    || 0);
      if (sortBy === 'calls_desc') return +(b.calls            || 0) - +(a.calls            || 0);
      if (sortBy === 'total_desc') return +(b.total_exec_time  || 0) - +(a.total_exec_time  || 0);
      if (sortBy === 'cache_miss') return +(b.shared_blks_read || 0) - +(a.shared_blks_read || 0);
      return 0;
    });

  const TABS = [
    { id: 'overview',  label: 'Overview',       icon: <Layers size={14} /> },
    { id: 'explorer',  label: 'Query Explorer', icon: <Search size={14} /> },
    { id: 'ai',        label: 'AI Analysis',    icon: <Brain size={14} /> },
    { id: 'reports',   label: 'Reports',        icon: <FileDown size={14} /> },
  ];

  return (
    <div className="min-h-full bg-brand-bg">

      <PageHeader
        icon={Zap}
        title="PostgreSQL Slow Queries"
        subtitle={pgssAvail
          ? 'pg_stat_statements — cumulative query digest'
          : 'pg_stat_activity — live sessions (limited)'}
        accent="postgres"
        backTo={`/postgresql-dashboard/${id}`}
        crumbs={[{ label: 'Databases', to: '/databases' }, { label: 'PostgreSQL', to: `/postgresql-dashboard/${id}` }, { label: 'Slow Queries' }]}
        actions={(
          <div className="flex items-center gap-3">
            <div className="text-right text-xs text-white/70">
              <div>Refresh in <span className="font-black text-white">{countdown}s</span></div>
              <div className="text-[10px]">{queries.length} queries loaded</div>
            </div>
            <button onClick={() => refetch()}
              className="flex items-center gap-2 px-4 py-1.5 bg-white/10 hover:bg-white/20 border border-white/20 rounded-lg text-sm font-semibold text-white transition-colors">
              <RefreshCw size={13} /> Refresh
            </button>
          </div>
        )}
      />

      {/* Tab bar */}
      <div className="mt-4 flex gap-1">
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-bold transition-all ${
              tab === t.id ? 'bg-slate-900 text-white' : 'text-slate-500 hover:bg-slate-200'}`}>
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="py-5">
        {tab === 'overview' && (
          <OverviewTab queries={queries} pgssAvail={pgssAvail} connId={id} onRefetch={refetch} />
        )}

        {tab === 'explorer' && (
          <div className="space-y-4">
            {/* Filters */}
            <div className="bg-white rounded-2xl border border-slate-200 p-3 flex flex-wrap gap-3 items-center">
              <Filter size={14} className="text-slate-400 flex-shrink-0" />
              <div className="relative flex-1 min-w-44">
                <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input value={search} onChange={e => setSearch(e.target.value)}
                  placeholder="Search query text…"
                  className="w-full pl-8 pr-3 h-9 rounded-xl border border-slate-200 text-sm outline-none focus:border-indigo-400" />
              </div>
              {users.length > 1 && (
                <select value={userFilter} onChange={e => setUserFilter(e.target.value)}
                  className="h-9 px-3 rounded-xl border border-slate-200 text-sm outline-none bg-white">
                  <option value="">All users</option>
                  {users.map(u => <option key={u} value={u}>{u}</option>)}
                </select>
              )}
              <select value={minTime} onChange={e => setMinTime(Number(e.target.value))}
                className="h-9 px-3 rounded-xl border border-slate-200 text-sm outline-none bg-white">
                <option value={0}>All times</option>
                <option value={100}>≥ 100 ms</option>
                <option value={500}>≥ 500 ms</option>
                <option value={1000}>≥ 1 s</option>
                <option value={5000}>≥ 5 s</option>
                <option value={10000}>≥ 10 s</option>
              </select>
              <select value={sortBy} onChange={e => setSortBy(e.target.value)}
                className="h-9 px-3 rounded-xl border border-slate-200 text-sm outline-none bg-white">
                <option value="avg_desc">Sort: Slowest Avg</option>
                <option value="max_desc">Sort: Slowest Max</option>
                <option value="calls_desc">Sort: Most Calls</option>
                <option value="total_desc">Sort: Most Total Time</option>
                <option value="cache_miss">Sort: Cache Miss</option>
              </select>
              <span className="text-xs text-slate-400">{filtered.length} / {queries.length}</span>
            </div>

            {/* Table */}
            <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
              {filtered.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
                  <CheckCircle2 size={32} className="text-green-300 mb-3" />
                  <p className="font-semibold text-slate-600">No queries match your filters</p>
                  <p className="text-xs text-slate-400 mt-2">
                    {!pgssAvail
                      ? 'Enable pg_stat_statements in the Overview tab to capture query statistics.'
                      : 'Try relaxing the filters above.'}
                  </p>
                </div>
              ) : (
                <Paged rows={filtered} unit="queries">{(pageRows, pager) => (<>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200">
                      <th className="w-8 px-3 py-3"></th>
                      <th className="w-20 px-3 py-3 text-left text-[11px] font-bold text-slate-400">Severity</th>
                      <th className="px-4 py-3 text-left text-[11px] font-bold text-slate-400">Query</th>
                      <th className="px-3 py-3 text-right text-[11px] font-bold text-slate-400 whitespace-nowrap">Avg Time</th>
                      <th className="px-3 py-3 text-right text-[11px] font-bold text-slate-400 whitespace-nowrap">Max Time</th>
                      <th className="px-3 py-3 text-right text-[11px] font-bold text-slate-400 whitespace-nowrap">Calls</th>
                      <th className="px-3 py-3 text-right text-[11px] font-bold text-slate-400 whitespace-nowrap">Rows</th>
                      <th className="px-3 py-3 text-right text-[11px] font-bold text-slate-400 whitespace-nowrap">Cache Hit%</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.map((q, i) => (
                      <QueryRow
                        key={`${i}__${(q.query || '').slice(0, 30)}`}
                        q={q} idx={i} connId={id}
                      />
                    ))}
                  </tbody>
                </table>
                {pager}
                </>)}</Paged>
              )}
            </div>
          </div>
        )}

        {tab === 'ai' && (
          <AIAnalysisTab queries={queries} connId={id} />
        )}

        {tab === 'reports' && (
          <ReportsTab queries={queries} connId={id} />
        )}
      </div>
    </div>
  );
}

// ── Shared helpers ─────────────────────────────────────────────────────────────

function Spinner({ label }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50">
      <div className="text-center">
        <div className="w-10 h-10 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin mx-auto mb-3" />
        <p className="text-slate-500 text-sm">{label}</p>
      </div>
    </div>
  );
}

function Err({ msg, onRetry }) {
  return (
    <div className="p-6">
      <div className="bg-red-50 border border-red-200 rounded-2xl p-6 max-w-lg">
        <AlertTriangle className="text-red-500 mb-2" size={20} />
        <p className="font-bold text-red-700">Failed to load slow queries</p>
        <p className="text-sm text-red-600 mt-1">{msg}</p>
        <button onClick={onRetry}
          className="mt-3 px-4 py-2 bg-red-600 text-white rounded-xl text-sm font-bold hover:bg-red-700">
          Retry
        </button>
      </div>
    </div>
  );
}
