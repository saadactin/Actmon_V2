import React, { useState, useEffect } from 'react';
import { Link, useParams, useLocation, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Zap, Brain, Eye, BarChart2, Code, Copy, Check,
  AlertTriangle, CheckCircle2, Clock, Activity, Database,
  TrendingDown, Info, XCircle, Loader2, RefreshCw, PlayCircle,
  Settings, FileDown, ChevronRight,
} from 'lucide-react';
import client from '../../api/client';

// ── API ───────────────────────────────────────────────────────────────────────

const explainAnalyze = (id, sql, database) =>
  client.post(`/connections/postgresql/${id}/pg-slow-queries/explain-analyze`, { sql_text: sql, database: database || null }).then(r => r.data);

const analyzeGroq = (id, payload) =>
  client.post(`/connections/postgresql/${id}/pg-slow-queries/analyze-groq`, payload).then(r => r.data);

// ── CopyBtn ───────────────────────────────────────────────────────────────────

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
      className="flex-shrink-0 flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-bold transition-all"
      style={copied
        ? { background: '#dcfce7', color: '#166534', border: '1px solid #bbf7d0' }
        : { background: '#f1f5f9', color: '#475569', border: '1px solid #e2e8f0' }}
    >
      {copied ? <Check size={11} /> : <Copy size={11} />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

// ── SeverityBadge ─────────────────────────────────────────────────────────────

function SeverityBadge({ severity }) {
  const styles = {
    critical: { bg: '#fef2f2', color: '#dc2626', border: '#fecaca', label: 'Critical' },
    high:     { bg: '#fff7ed', color: '#d97706', border: '#fed7aa', label: 'High' },
    medium:   { bg: '#fffbeb', color: '#ca8a04', border: '#fde68a', label: 'Medium' },
    low:      { bg: '#f0fdf4', color: '#16a34a', border: '#bbf7d0', label: 'Low' },
  };
  const s = styles[severity?.toLowerCase()] || styles.medium;
  return (
    <span className="px-2.5 py-0.5 rounded-full text-xs font-black border"
      style={{ background: s.bg, color: s.color, borderColor: s.border }}>
      {s.label}
    </span>
  );
}

// ── MetricCard ────────────────────────────────────────────────────────────────

function MetricCard({ label, value, sub, accent = 'slate', icon }) {
  const border = {
    red: 'border-l-red-500', yellow: 'border-l-yellow-400',
    green: 'border-l-green-500', indigo: 'border-l-indigo-500',
    orange: 'border-l-orange-400', slate: 'border-l-slate-300',
  }[accent] || 'border-l-slate-300';
  return (
    <div className={`bg-white rounded-2xl border border-slate-200 border-l-4 ${border} p-4`}>
      <div className="flex justify-between items-start">
        <div className="flex-1">
          <p className="text-xs text-slate-400 font-bold uppercase tracking-wide">{label}</p>
          <p className="text-2xl font-black text-slate-800 mt-1">{value}</p>
          {sub && <p className="text-xs text-slate-400 mt-0.5">{sub}</p>}
        </div>
        {icon && <div className="flex-shrink-0 ml-2">{icon}</div>}
      </div>
    </div>
  );
}

// ── Plan Tree Helpers ─────────────────────────────────────────────────────────

function buildTree(nodes) {
  if (!nodes.length) return [];
  const roots = [];
  const stack = [];
  for (const raw of nodes) {
    const item = { ...raw, children: [] };
    while (stack.length > 0 && stack[stack.length - 1].depth >= item.depth) stack.pop();
    if (stack.length === 0) roots.push(item);
    else stack[stack.length - 1].children.push(item);
    stack.push(item);
  }
  return roots;
}

const NODE_COLORS = {
  'Seq Scan':          { bg: 'bg-red-950/60',     border: 'border-l-red-500',     badge: 'bg-red-800/80 text-red-200' },
  'Index Scan':        { bg: 'bg-emerald-950/50', border: 'border-l-emerald-500', badge: 'bg-emerald-800/80 text-emerald-200' },
  'Index Only Scan':   { bg: 'bg-emerald-950/50', border: 'border-l-emerald-500', badge: 'bg-emerald-800/80 text-emerald-200' },
  'Bitmap Heap Scan':  { bg: 'bg-sky-950/50',     border: 'border-l-sky-500',     badge: 'bg-sky-800/80 text-sky-200' },
  'Bitmap Index Scan': { bg: 'bg-sky-950/40',     border: 'border-l-sky-400',     badge: 'bg-sky-800/80 text-sky-200' },
  'Hash':              { bg: 'bg-violet-950/50',  border: 'border-l-violet-500',  badge: 'bg-violet-800/80 text-violet-200' },
  'Hash Join':         { bg: 'bg-violet-950/50',  border: 'border-l-violet-500',  badge: 'bg-violet-800/80 text-violet-200' },
  'Nested Loop':       { bg: 'bg-orange-950/50',  border: 'border-l-orange-500',  badge: 'bg-orange-800/80 text-orange-200' },
  'Merge Join':        { bg: 'bg-yellow-950/50',  border: 'border-l-yellow-500',  badge: 'bg-yellow-800/80 text-yellow-200' },
  'Sort':              { bg: 'bg-amber-950/50',   border: 'border-l-amber-500',   badge: 'bg-amber-800/80 text-amber-200' },
  'Aggregate':         { bg: 'bg-indigo-950/50',  border: 'border-l-indigo-500',  badge: 'bg-indigo-800/80 text-indigo-200' },
  'default':           { bg: 'bg-slate-800/50',   border: 'border-l-slate-500',   badge: 'bg-slate-700 text-slate-300' },
};

function nodeColor(type) {
  return NODE_COLORS[type] || NODE_COLORS.default;
}

function PlanNodeRow({ node, isLast, prefix, maxCost, analyzed }) {
  const [expanded, setExpanded] = useState(false);
  const c = nodeColor(node.node_type);
  const cost = analyzed ? (node.actual_total_time || 0) : (node.total_cost || 0);
  const pct = maxCost > 0 ? Math.min(100, (cost / maxCost) * 100) : 0;
  const isSeq = node.node_type?.includes('Seq Scan');
  const rows = analyzed ? (node.actual_rows ?? node.plan_rows ?? 0) : (node.plan_rows ?? 0);
  const loops = analyzed ? (node.actual_loops ?? 1) : null;
  const connStr = prefix + (isLast ? '└─ ' : '├─ ');
  const childPrefix = prefix + (isLast ? '   ' : '│  ');
  const hasDetails = node.filter || node.join_type || node.sort_key || node.sort_method || (loops != null && loops > 1);

  return (
    <div>
      <div
        className={`group flex items-start gap-2 px-3 py-2 rounded-xl mb-1 border-l-2 transition-colors ${c.bg} ${c.border} ${hasDetails ? 'cursor-pointer hover:brightness-125' : ''}`}
        onClick={() => hasDetails && setExpanded(e => !e)}
      >
        <span className="font-mono text-slate-600 text-xs flex-shrink-0 mt-0.5 select-none whitespace-pre">{connStr}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-[11px] font-black px-2 py-0.5 rounded-md ${c.badge}`}>{node.node_type}</span>
            {(node.relation || node.alias) && (
              <span className="text-slate-300 font-mono text-xs">
                {node.relation}{node.alias && node.alias !== node.relation ? ` as ${node.alias}` : ''}
              </span>
            )}
            {isSeq && <span className="text-[10px] px-1.5 py-0.5 bg-red-700/80 text-red-200 rounded font-black uppercase tracking-wider">⚠ Full Scan</span>}
          </div>
          <div className="mt-1.5 flex items-center gap-3">
            <div className="flex-1 h-1.5 bg-slate-700 rounded-full overflow-hidden min-w-[60px] max-w-[200px]">
              <div
                className={`h-full rounded-full transition-all ${pct > 70 ? 'bg-red-500' : pct > 35 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                style={{ width: `${pct.toFixed(1)}%` }}
              />
            </div>
            <div className="flex items-center gap-3 text-xs text-slate-400 flex-shrink-0">
              <span><span className="text-slate-100 font-bold">{rows.toLocaleString()}</span> rows</span>
              {analyzed && node.actual_total_time != null && (
                <span><span className={`font-bold ${node.actual_total_time > 1000 ? 'text-red-300' : 'text-slate-100'}`}>{node.actual_total_time.toFixed(1)}</span> ms</span>
              )}
              {!analyzed && node.total_cost != null && (
                <span>cost <span className="text-slate-100 font-bold">{node.total_cost.toFixed(0)}</span></span>
              )}
              {loops != null && loops > 1 && (
                <span className="text-amber-400 font-bold">×{loops} loops</span>
              )}
            </div>
          </div>
          {expanded && hasDetails && (
            <div className="mt-2 space-y-1 pl-1 border-l border-slate-700 ml-1">
              {node.filter && <p className="text-xs pl-2"><span className="text-slate-500 font-semibold">Filter: </span><code className="text-yellow-300">{node.filter}</code></p>}
              {node.join_type && <p className="text-xs pl-2"><span className="text-slate-500 font-semibold">Join Type: </span><span className="text-slate-300">{node.join_type}</span></p>}
              {node.sort_key && <p className="text-xs pl-2"><span className="text-slate-500 font-semibold">Sort Key: </span><code className="text-cyan-300">{Array.isArray(node.sort_key) ? node.sort_key.join(', ') : node.sort_key}</code></p>}
              {node.sort_method && <p className="text-xs pl-2"><span className="text-slate-500 font-semibold">Sort Method: </span><span className="text-slate-300">{node.sort_method}</span></p>}
              {analyzed && node.actual_startup_time != null && <p className="text-xs pl-2"><span className="text-slate-500 font-semibold">Startup: </span><span className="text-slate-300">{node.actual_startup_time.toFixed(2)} ms</span></p>}
              {(node.shared_read_blocks > 0) && <p className="text-xs pl-2"><span className="text-slate-500 font-semibold">Disk reads: </span><span className="text-red-300 font-bold">{node.shared_read_blocks.toLocaleString()} blocks</span></p>}
              {(node.shared_hit_blocks > 0) && <p className="text-xs pl-2"><span className="text-slate-500 font-semibold">Cache hits: </span><span className="text-green-300">{node.shared_hit_blocks.toLocaleString()} blocks</span></p>}
            </div>
          )}
        </div>
        {hasDetails && (
          <ChevronRight size={12} className={`flex-shrink-0 text-slate-600 mt-1 transition-transform ${expanded ? 'rotate-90' : ''}`} />
        )}
      </div>
      {node.children?.map((child, i) => (
        <PlanNodeRow key={i} node={child} isLast={i === node.children.length - 1}
          prefix={childPrefix} maxCost={maxCost} analyzed={analyzed} />
      ))}
    </div>
  );
}

// ── EXPLAIN Panel ─────────────────────────────────────────────────────────────

function ExplainSection({ connId, query, database, autoRun, onPlanReady }) {
  const [loading, setLoading] = useState(false);
  const [data, setData]       = useState(null);
  const [error, setError]     = useState(null);
  const [step, setStep]       = useState('');

  const run = async () => {
    setLoading(true);
    setError(null);
    setData(null);
    setStep('Connecting to database…');
    try {
      setStep('Running EXPLAIN ANALYZE (max 6s, falls back to EXPLAIN if query is slow)…');
      const r = await explainAnalyze(connId, query, database);
      if (r.status === 'error') throw new Error(r.error);
      setStep('Parsing execution plan…');
      setData(r);
      onPlanReady?.(r.nodes || []);
    } catch (err) {
      setError(err?.message || 'EXPLAIN failed');
    } finally {
      setLoading(false);
      setStep('');
    }
  };

  useEffect(() => { if (autoRun) run(); }, []);

  if (!data && !loading && !error) {
    return (
      <div className="text-center py-10">
        <button onClick={run}
          className="flex items-center gap-2 px-6 py-3 rounded-xl text-sm font-bold text-white mx-auto hover:opacity-90 active:scale-95 transition-all"
          style={{ background: 'linear-gradient(135deg, #1e293b, #334155)' }}>
          <Eye size={16} /> Run EXPLAIN ANALYZE
        </button>
        <p className="text-sm text-slate-400 mt-2">
          Runs <code className="font-mono bg-slate-100 px-1 rounded">EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)</code>
          {database && <span className="ml-1 text-indigo-500 font-mono">on db: {database}</span>}
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-4">
        <div className="relative">
          <div className="w-14 h-14 border-4 border-indigo-100 border-t-indigo-600 rounded-full animate-spin" />
          <Eye size={18} className="text-indigo-500 absolute inset-0 m-auto" />
        </div>
        <div className="text-center">
          <p className="text-slate-700 font-semibold">{step || 'Running EXPLAIN ANALYZE…'}</p>
          {database && <p className="text-xs text-indigo-500 mt-1">database: {database}</p>}
        </div>
      </div>
    );
  }

  if (error) {
    const isTableMissing = error.includes('does not exist') || error.includes('EXPLAIN could not run');
    return (
      <div className={`rounded-2xl p-5 border ${isTableMissing ? 'bg-amber-50 border-amber-200' : 'bg-red-50 border-red-200'}`}>
        <div className={`flex items-center gap-2 font-bold mb-2 ${isTableMissing ? 'text-amber-700' : 'text-red-700'}`}>
          {isTableMissing ? <Info size={16} /> : <XCircle size={16} />}
          {isTableMissing ? 'EXPLAIN not available for this query' : 'EXPLAIN failed'}
        </div>
        {isTableMissing ? (
          <div className="space-y-3">
            {error.split('\n\n').map((para, i) => (
              <p key={i} className="text-sm text-amber-800">{para}</p>
            ))}
            <div className="bg-amber-100 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-800">
              <strong>How to fix:</strong> In ActMon, edit connection {connId} and set the
              <strong> Database</strong> field to the database where this query actually runs
              (e.g. <code className="font-mono bg-amber-200 px-1 rounded">testdb</code>, not <code className="font-mono bg-amber-200 px-1 rounded">postgres</code>).
              Then retry EXPLAIN here.
            </div>
            <button onClick={run}
              className="flex items-center gap-2 px-4 py-2 bg-amber-600 text-white rounded-xl text-sm font-semibold hover:bg-amber-700 transition-colors">
              <RefreshCw size={13} /> Retry
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-red-600 font-mono whitespace-pre-wrap">{error}</p>
            <button onClick={run}
              className="flex items-center gap-2 px-4 py-2 bg-red-600 text-white rounded-xl text-sm font-semibold hover:bg-red-700 transition-colors">
              <RefreshCw size={13} /> Retry
            </button>
          </div>
        )}
      </div>
    );
  }

  const nodes = data.nodes || [];
  const hints = data.hints || [];

  return (
    <div className="space-y-5">
      {/* Timings bar */}
      <div className="flex flex-wrap gap-2 items-center bg-slate-800 rounded-2xl px-4 py-3">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <div>
            <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Planning Time</p>
            <p className="text-base font-black text-white">{(data.planning_time || 0).toFixed(2)} ms</p>
          </div>
          {data.analyzed && (
            <>
              <div className="w-px h-8 bg-slate-700" />
              <div>
                <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Execution Time</p>
                <p className={`text-base font-black ${(data.execution_time || 0) > 1000 ? 'text-red-400' : (data.execution_time || 0) > 100 ? 'text-amber-400' : 'text-emerald-400'}`}>
                  {(data.execution_time || 0).toFixed(2)} ms
                </p>
              </div>
            </>
          )}
          {!data.analyzed && (
            <div className="flex items-center gap-1.5 px-2.5 py-1 bg-amber-900/40 border border-amber-700/40 rounded-lg text-xs text-amber-400 font-semibold">
              <Info size={12} /> Estimated plan — ANALYZE skipped (parameterized query)
            </div>
          )}
          {hints.length > 0 && (
            <div className="flex items-center gap-1.5 px-2.5 py-1 bg-red-900/40 border border-red-700/40 rounded-lg text-xs text-red-400 font-bold">
              <AlertTriangle size={12} /> {hints.length} issue{hints.length !== 1 ? 's' : ''} detected
            </div>
          )}
        </div>
        <button onClick={run}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold text-slate-400 hover:text-white hover:bg-slate-700 border border-slate-700 transition-colors flex-shrink-0">
          <RefreshCw size={12} /> Re-run
        </button>
      </div>

      {/* Hints */}
      {hints.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-bold text-slate-500 uppercase tracking-wider">Issues Found</p>
          {hints.map((h, i) => (
            <div key={i} className={`rounded-xl border px-4 py-3 ${
              h.level === 'critical' ? 'bg-red-50 border-red-200'
              : 'bg-amber-50 border-amber-200'}`}>
              <div className={`font-bold flex items-center gap-2 mb-1 text-sm ${
                h.level === 'critical' ? 'text-red-700' : 'text-amber-700'}`}>
                <AlertTriangle size={14} /> {h.title}
              </div>
              <p className="text-sm text-slate-600">{h.text}</p>
              {h.fix && <p className="text-xs text-slate-500 italic mt-1">{h.fix}</p>}
            </div>
          ))}
        </div>
      )}

      {/* Plan Tree */}
      {nodes.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-bold text-slate-500 uppercase tracking-wider">
              Execution Plan Tree
              <span className="ml-2 font-normal text-slate-600 normal-case">
                {" — "}{nodes.length} node{nodes.length !== 1 ? 's' : ''}
              </span>
            </p>
            <span className="text-xs text-slate-600 italic">Click any node to expand details</span>
          </div>
          <div className="bg-slate-900 rounded-2xl border border-slate-700 p-4 overflow-x-auto">
            {(() => {
              const tree = buildTree(nodes);
              const maxCost = data.analyzed
                ? Math.max(...nodes.map(n => n.actual_total_time || 0), 0.001)
                : Math.max(...nodes.map(n => n.total_cost || 0), 0.001);
              return tree.map((root, i) => (
                <PlanNodeRow key={i} node={root} isLast={i === tree.length - 1}
                  prefix="" maxCost={maxCost} analyzed={!!data.analyzed} />
              ));
            })()}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 px-1">
            {[
              { label: 'Seq Scan', cls: 'bg-red-800/80 text-red-200' },
              { label: 'Index Scan', cls: 'bg-emerald-800/80 text-emerald-200' },
              { label: 'Hash Join', cls: 'bg-violet-800/80 text-violet-200' },
              { label: 'Nested Loop', cls: 'bg-orange-800/80 text-orange-200' },
              { label: 'Sort', cls: 'bg-amber-800/80 text-amber-200' },
              { label: 'Aggregate', cls: 'bg-indigo-800/80 text-indigo-200' },
            ].map(({ label, cls }) => (
              <div key={label} className="flex items-center gap-1.5">
                <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${cls}`}>{label}</span>
              </div>
            ))}
            <div className="flex items-center gap-1.5 ml-auto">
              <div className="w-8 h-1.5 rounded-full bg-gradient-to-r from-emerald-500 via-amber-500 to-red-500" />
              <span className="text-[10px] text-slate-500">bar = relative cost</span>
            </div>
          </div>
        </div>
      )}

      {/* Tables touched */}
      {(() => {
        const tables = [...new Set(nodes.map(n => n.relation).filter(Boolean))];
        if (!tables.length) return null;
        return (
          <div className="bg-blue-50 border border-blue-200 rounded-2xl p-4">
            <p className="text-xs font-bold text-blue-600 uppercase mb-2">Tables in this Plan</p>
            <div className="flex flex-wrap gap-2">
              {tables.map(t => (
                <span key={t} className="px-3 py-1 bg-blue-100 border border-blue-200 rounded-lg text-sm font-mono font-semibold text-blue-800">
                  {t}
                </span>
              ))}
            </div>
          </div>
        );
      })()}
    </div>
  );
}

// ── AI Analysis Section ───────────────────────────────────────────────────────

function AISection({ connId, query, explainNodes, autoRun }) {
  const [loading, setLoading] = useState(false);
  const [result, setResult]   = useState(null);
  const [error, setError]     = useState(null);

  useEffect(() => { if (autoRun && !result && !loading) run(); }, [autoRun]);

  const run = async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const hit  = +(query.shared_blks_hit  || 0);
      const read = +(query.shared_blks_read || 0);
      const cacheHitPct = (hit + read) > 0 ? ((hit / (hit + read)) * 100) : 100;
      const r = await analyzeGroq(connId, {
        sql_text:           query.query || '',
        user_name:          query.user_name || '',
        calls:              +(query.calls || 0),
        mean_exec_time_ms:  +(query.mean_exec_time  || 0),
        max_exec_time_ms:   +(query.max_exec_time   || 0),
        total_exec_time_ms: +(query.total_exec_time || 0),
        rows:               +(query.rows || 0),
        shared_blks_hit:    hit,
        shared_blks_read:   read,
        cache_hit_pct:      +cacheHitPct.toFixed(2),
        explain_rows:       explainNodes || [],
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
      <div className="flex flex-col items-center py-12 gap-4">
        <div className="w-14 h-14 rounded-2xl bg-indigo-100 flex items-center justify-center">
          <Brain size={28} className="text-indigo-600" />
        </div>
        <div className="text-center">
          <p className="font-bold text-slate-700 mb-1">ActMon AI Analysis</p>
          <p className="text-sm text-slate-400">DBA-level query insights powered by ActMon AI Engine</p>
        </div>
        <button onClick={run}
          className="flex items-center gap-2 px-6 py-2.5 rounded-xl text-sm font-bold text-white hover:opacity-90 active:scale-95 transition-all"
          style={{ background: 'linear-gradient(135deg, #4f46e5, #7c3aed)' }}>
          <Brain size={15} /> Run AI Analysis
        </button>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-4">
        <div className="relative w-14 h-14">
          <div className="w-14 h-14 border-4 border-indigo-100 border-t-indigo-600 rounded-full animate-spin" />
          <Brain size={18} className="text-indigo-500 absolute inset-0 m-auto" />
        </div>
        <div className="text-center">
          <p className="font-semibold text-slate-700">ActMon AI is analyzing your query…</p>
          <p className="text-xs text-slate-400 mt-1">Usually 5–10 seconds</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-2xl p-5">
        <div className="flex items-center gap-2 text-red-700 font-bold mb-2">
          <XCircle size={16} /> Analysis failed
        </div>
        <p className="text-sm text-red-600 font-mono">{error}</p>
        <button onClick={run} className="mt-3 flex items-center gap-1.5 text-sm text-red-700 font-semibold hover:underline">
          <RefreshCw size={13} /> Retry
        </button>
      </div>
    );
  }

  const a = result;

  return (
    <div className="space-y-4">
      {/* ActMon AI header */}
      <div className="flex items-center gap-3 bg-gradient-to-r from-indigo-50 to-violet-50 border border-indigo-200 rounded-2xl px-4 py-3">
        <div className="w-9 h-9 rounded-xl bg-indigo-600 flex items-center justify-center flex-shrink-0">
          <Brain size={16} className="text-white" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-black text-indigo-900 text-sm">ActMon AI Analysis</span>
            <SeverityBadge severity={a.severity} />
          </div>
          {a.severity_reason && <p className="text-xs text-indigo-600 mt-0.5 leading-snug">{a.severity_reason}</p>}
        </div>
        <button onClick={run} title="Re-analyze"
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold text-indigo-600 hover:bg-indigo-100 border border-indigo-200 transition-colors flex-shrink-0">
          <RefreshCw size={12} /> Re-analyze
        </button>
      </div>

      {/* Summary */}
      <div className="bg-white border border-slate-200 rounded-2xl px-4 py-3">
        <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-1.5">Summary</p>
        <p className="text-slate-700 text-sm leading-relaxed">{a.summary}</p>
      </div>

      {/* Root cause */}
      <div className="bg-amber-50 border border-amber-200 rounded-2xl px-4 py-3">
        <p className="text-xs font-bold text-amber-600 uppercase tracking-wider mb-1.5">Root Cause</p>
        <p className="text-slate-700 text-sm leading-relaxed">{a.root_cause}</p>
      </div>

      {/* Issues */}
      {a.issues?.length > 0 && (
        <div>
          <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">Detected Issues</p>
          <div className="space-y-2">
            {a.issues.map((issue, i) => (
              <div key={i} className={`rounded-2xl border px-4 py-3 ${
                issue.severity === 'critical' ? 'bg-red-50 border-red-200'
                : issue.severity === 'high'   ? 'bg-orange-50 border-orange-200'
                : 'bg-amber-50 border-amber-200'}`}>
                <div className="flex items-center gap-2 mb-1">
                  <SeverityBadge severity={issue.severity} />
                  <span className="font-bold text-slate-700">{issue.type}</span>
                  {issue.table && <span className="text-slate-400 font-mono text-sm">({issue.table})</span>}
                </div>
                <p className="text-sm text-slate-600">{issue.description}</p>
                {issue.evidence && (
                  <p className="mt-1 font-mono text-slate-400 text-xs bg-slate-100 rounded px-2 py-1">
                    Evidence: {issue.evidence}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Index recommendations */}
      {a.index_recommendations?.length > 0 && (
        <div>
          <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">Index Recommendations</p>
          <div className="space-y-3">
            {a.index_recommendations.map((rec, i) => (
              <div key={i} className="bg-green-50 border border-green-200 rounded-2xl p-4">
                <div className="flex items-center gap-2 mb-2">
                  <span className="font-bold text-green-800">{rec.table}</span>
                  <span className="text-xs text-green-600 bg-green-100 px-2 py-0.5 rounded-full font-semibold">
                    {rec.index_type}
                  </span>
                </div>
                <p className="text-sm text-green-700 mb-2">{rec.reason}</p>
                {rec.create_sql && (
                  <div className="bg-slate-900 rounded-xl p-3 flex items-start gap-2">
                    <code className="flex-1 text-sm font-mono text-green-300 whitespace-pre-wrap">{rec.create_sql}</code>
                    <CopyBtn text={rec.create_sql} />
                  </div>
                )}
                {rec.estimated_improvement && (
                  <p className="text-xs text-green-600 mt-2 font-semibold">{rec.estimated_improvement}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Query rewrite */}
      {a.query_rewrite?.applicable && a.query_rewrite?.optimized_sql && (
        <div>
          <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">Optimized Query</p>
          <div className="bg-slate-900 rounded-2xl p-4 relative">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-xs font-bold text-green-400">
                Expected gain: {a.query_rewrite.expected_gain}
              </span>
            </div>
            <pre className="text-sm font-mono text-green-300 whitespace-pre-wrap pr-16 max-h-64 overflow-auto">
              {a.query_rewrite.optimized_sql}
            </pre>
            <div className="absolute top-3 right-3">
              <CopyBtn text={a.query_rewrite.optimized_sql} />
            </div>
          </div>
          {a.query_rewrite.explanation && (
            <p className="text-sm text-slate-500 mt-2">{a.query_rewrite.explanation}</p>
          )}
          {a.query_rewrite.changes_made?.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {a.query_rewrite.changes_made.map((c, i) => (
                <span key={i} className="text-xs bg-blue-50 border border-blue-200 text-blue-700 px-2 py-1 rounded-lg font-semibold">
                  {c}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Priority actions */}
      {a.priority_actions?.length > 0 && (
        <div>
          <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">Priority Actions</p>
          <div className="space-y-2">
            {a.priority_actions.map((action, i) => (
              <div key={i} className="flex items-start gap-3 bg-white border border-slate-200 rounded-xl px-4 py-3">
                <span className="w-6 h-6 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center text-xs font-black flex-shrink-0 mt-0.5">
                  {i + 1}
                </span>
                <span className="text-sm text-slate-700">{action}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Business impact + improvement */}
      {(a.business_impact || a.estimated_overall_improvement) && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {a.business_impact && (
            <div className="bg-blue-50 border border-blue-200 rounded-2xl p-4">
              <p className="text-xs font-bold text-blue-600 uppercase mb-2">Business Impact</p>
              <p className="text-sm text-blue-800">{a.business_impact}</p>
            </div>
          )}
          {a.estimated_overall_improvement && (
            <div className="bg-emerald-50 border border-emerald-200 rounded-2xl p-4">
              <p className="text-xs font-bold text-emerald-600 uppercase mb-2">Expected Improvement</p>
              <p className="text-sm text-emerald-800">{a.estimated_overall_improvement}</p>
            </div>
          )}
        </div>
      )}

      {/* Validation queries */}
      {a.validation_queries?.length > 0 && (
        <div>
          <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">Validation Queries</p>
          <div className="space-y-2">
            {a.validation_queries.map((vq, i) => (
              <div key={i} className="bg-slate-900 rounded-2xl p-4 flex items-start gap-2">
                <code className="flex-1 text-sm font-mono text-cyan-300 whitespace-pre-wrap">{vq}</code>
                <CopyBtn text={vq} />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function QueryDetailPage() {
  const { id }    = useParams();
  const location  = useLocation();
  const navigate  = useNavigate();
  const [tab, setTab]           = useState('explain');   // open EXPLAIN immediately
  const [explainNodes, setExplainNodes] = useState([]);
  const [groqAuto, setGroqAuto] = useState(false);       // auto-trigger Groq after EXPLAIN

  const query = location.state?.query;

  // Redirect if navigated directly without state
  if (!query) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="text-center">
          <AlertTriangle size={32} className="text-amber-400 mx-auto mb-3" />
          <p className="font-bold text-slate-700 mb-1">No query data found</p>
          <p className="text-sm text-slate-500 mb-4">Navigate here from the Slow Queries list.</p>
          <Link to={`/postgresql-dashboard/${id}/slow-queries`}
            className="px-5 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-bold hover:bg-indigo-700">
            ← Back to Slow Queries
          </Link>
        </div>
      </div>
    );
  }

  const avg   = +(query.mean_exec_time  || 0);
  const max   = +(query.max_exec_time   || 0);
  const total = +(query.total_exec_time || 0);
  const calls = +(query.calls           || 0);
  const rows  = +(query.rows            || 0);
  const hit   = +(query.shared_blks_hit  || 0);
  const read  = +(query.shared_blks_read || 0);
  const cacheHitPct = (hit + read) > 0 ? ((hit / (hit + read)) * 100).toFixed(1) : null;

  const severity = avg > 10000 ? 'critical' : avg > 2000 ? 'high' : avg > 500 ? 'medium' : 'low';
  const fmtMs = (ms) => ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(1)} ms`;

  // Performance warnings
  const warnings = [];
  if (avg > 10000) warnings.push({ level: 'error', title: 'Critically Slow', text: `Avg ${fmtMs(avg)} exceeds 10s. Urgent investigation needed.` });
  else if (avg > 2000) warnings.push({ level: 'warn', title: 'Slow Query', text: `Avg ${fmtMs(avg)} — impacting user experience.` });
  if (cacheHitPct !== null && +cacheHitPct < 90) warnings.push({ level: 'warn', title: 'Low Cache Hit Rate', text: `${cacheHitPct}% — ${read.toLocaleString()} blocks read from disk. Increase shared_buffers.` });
  if (calls > 10000) warnings.push({ level: 'warn', title: 'High Frequency', text: `Called ${calls.toLocaleString()} times. Even 10ms improvement saves ${(calls * 10 / 1000).toFixed(0)}s total.` });

  const TABS = [
    { id: 'overview', label: 'Overview',        icon: <BarChart2 size={15} /> },
    { id: 'sql',      label: 'SQL',             icon: <Code size={15} /> },
    { id: 'explain',  label: 'EXPLAIN',         icon: <Eye size={15} /> },
    { id: 'ai',       label: 'ActMon AI',       icon: <Brain size={15} /> },
  ];

  return (
    <div className="min-h-screen bg-slate-50">

      {/* Header */}
      <div className="bg-gradient-to-r from-slate-900 via-indigo-900 to-violet-800 text-white px-6 py-5">
        <div className="flex items-center gap-4 mb-4">
          <Link to={`/postgresql-dashboard/${id}/slow-queries`}
            className="w-10 h-10 rounded-xl bg-white/10 hover:bg-white/20 border border-white/20 flex items-center justify-center transition-colors">
            <ArrowLeft size={17} />
          </Link>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 mb-1">
              <h1 className="font-black text-lg tracking-tight flex items-center gap-2">
                <Zap size={16} className="text-yellow-400" /> Query Analysis
              </h1>
              <SeverityBadge severity={severity} />
              {query.user_name && (
                <span className="text-xs bg-white/10 border border-white/20 px-2 py-0.5 rounded-full text-indigo-200">
                  user: {query.user_name}
                </span>
              )}
            </div>
            <p className="text-indigo-300 text-sm font-mono truncate">
              {(query.query || '').replace(/\s+/g, ' ').slice(0, 120)}
            </p>
          </div>
        </div>

        {/* Quick stats row */}
        <div className="flex flex-wrap gap-4 text-sm mb-4">
          {[
            { label: 'Avg Time', value: fmtMs(avg), warn: avg > 2000 },
            { label: 'Max Time', value: fmtMs(max), warn: max > 5000 },
            { label: 'Calls',    value: calls.toLocaleString() },
            { label: 'Rows',     value: rows.toLocaleString() },
            { label: 'Cache',    value: cacheHitPct !== null ? `${cacheHitPct}%` : '—', warn: cacheHitPct !== null && +cacheHitPct < 90 },
          ].map(s => (
            <div key={s.label} className="flex items-center gap-1.5">
              <span className="text-indigo-300 text-xs">{s.label}:</span>
              <span className={`font-black ${s.warn ? 'text-red-300' : 'text-white'}`}>{s.value}</span>
            </div>
          ))}
        </div>

        {/* Tabs */}
        <div className="flex gap-1">
          {TABS.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-bold transition-all ${
                tab === t.id ? 'bg-white text-slate-900' : 'text-indigo-300 hover:bg-white/10'}`}>
              {t.icon} {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="p-6 max-w-5xl mx-auto">
        {/* ── Overview ── */}
        {tab === 'overview' && (
          <div className="space-y-5">
            {/* Metric cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <MetricCard
                label="Avg Execution" value={fmtMs(avg)}
                accent={avg > 10000 ? 'red' : avg > 2000 ? 'orange' : 'slate'}
                icon={<Clock size={20} className="text-orange-400" />}
              />
              <MetricCard
                label="Max Execution" value={fmtMs(max)}
                accent={max > 10000 ? 'red' : 'slate'}
                icon={<TrendingDown size={20} className="text-red-400" />}
              />
              <MetricCard
                label="Total Calls" value={calls.toLocaleString()}
                accent="indigo"
                icon={<Activity size={20} className="text-indigo-400" />}
              />
              <MetricCard
                label="Total DB Time" value={`${(total / 1000).toFixed(1)} s`}
                icon={<BarChart2 size={20} className="text-slate-400" />}
              />
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <MetricCard label="Rows Returned"   value={rows.toLocaleString()} icon={<Database size={20} className="text-slate-400" />} />
              <MetricCard label="Blocks Hit (cache)" value={hit.toLocaleString()}  icon={<CheckCircle2 size={20} className="text-green-500" />} accent="green" />
              <MetricCard label="Blocks Read (disk)" value={read.toLocaleString()} icon={<Database size={20} className="text-yellow-500" />} accent={read > 0 ? 'yellow' : 'slate'} />
              <MetricCard
                label="Cache Hit Rate"
                value={cacheHitPct !== null ? `${cacheHitPct}%` : '—'}
                accent={cacheHitPct !== null && +cacheHitPct < 90 ? 'red' : cacheHitPct !== null && +cacheHitPct < 99 ? 'yellow' : 'green'}
                icon={<Activity size={20} className={cacheHitPct !== null && +cacheHitPct < 90 ? 'text-red-400' : 'text-green-500'} />}
              />
            </div>

            {/* Warnings */}
            {warnings.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-bold text-slate-500 uppercase tracking-wider">Performance Issues</p>
                {warnings.map((w, i) => (
                  <div key={i} className={`rounded-2xl border px-4 py-3 flex items-start gap-3 ${
                    w.level === 'error' ? 'bg-red-50 border-red-200' : 'bg-amber-50 border-amber-200'}`}>
                    {w.level === 'error'
                      ? <XCircle size={16} className="text-red-500 flex-shrink-0 mt-0.5" />
                      : <AlertTriangle size={16} className="text-amber-500 flex-shrink-0 mt-0.5" />}
                    <div>
                      <p className={`font-bold text-sm ${w.level === 'error' ? 'text-red-800' : 'text-amber-800'}`}>{w.title}</p>
                      <p className="text-sm text-slate-600 mt-0.5">{w.text}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Quick action tiles */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {[
                { id: 'sql',     icon: <Code size={18} className="text-slate-600" />,   title: 'View Full SQL',        desc: 'See the complete query with syntax', bg: 'bg-slate-50 border-slate-200' },
                { id: 'explain', icon: <Eye size={18} className="text-indigo-600" />,   title: 'Run EXPLAIN ANALYZE', desc: 'Visualize the execution plan',        bg: 'bg-indigo-50 border-indigo-200' },
                { id: 'ai',      icon: <Brain size={18} className="text-violet-600" />, title: 'AI Analysis',          desc: 'Get DBA-level recommendations',      bg: 'bg-violet-50 border-violet-200' },
              ].map(a => (
                <button key={a.id} onClick={() => setTab(a.id)}
                  className={`text-left p-4 rounded-2xl border ${a.bg} hover:opacity-80 transition-opacity`}>
                  <div className="flex items-center gap-2 mb-1">
                    {a.icon}
                    <span className="font-bold text-sm text-slate-800">{a.title}</span>
                    <ChevronRight size={14} className="text-slate-400 ml-auto" />
                  </div>
                  <p className="text-xs text-slate-500">{a.desc}</p>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* ── SQL ── */}
        {tab === 'sql' && (
          <div className="space-y-4">
            <div className="bg-white rounded-2xl border border-slate-200 p-5">
              <div className="flex items-center justify-between mb-3">
                <p className="font-bold text-slate-700">Full Query Text</p>
                <CopyBtn text={query.query || ''} />
              </div>
              <div className="bg-slate-900 rounded-2xl p-4">
                <pre className="text-sm font-mono text-green-300 whitespace-pre-wrap break-words max-h-[500px] overflow-auto">
                  {query.query || '(empty)'}
                </pre>
              </div>
            </div>

            {/* EXPLAIN command to copy */}
            <div className="bg-blue-50 border border-blue-200 rounded-2xl p-4">
              <p className="text-sm font-bold text-blue-700 mb-2 flex items-center gap-2">
                <Info size={14} /> Run this in psql to see the full plan:
              </p>
              <div className="bg-slate-900 rounded-xl p-3 flex items-start gap-2">
                <code className="flex-1 text-sm font-mono text-green-300 whitespace-pre-wrap">
                  {`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)\n${query.query || ''}`}
                </code>
                <CopyBtn text={`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)\n${query.query || ''}`} />
              </div>
            </div>
          </div>
        )}

        {/* ── EXPLAIN + inline AI ── */}
        {tab === 'explain' && (
          <div className="space-y-6">
            <ExplainSection
              connId={id}
              query={query.query}
              database={query.datname || null}
              autoRun={true}
              onPlanReady={(nodes) => {
                setExplainNodes(nodes);
                setGroqAuto(true);   // trigger ActMon AI after EXPLAIN succeeds
              }}
            />
            {(groqAuto || explainNodes.length > 0) && (
              <div>
                <div className="flex items-center gap-3 mb-4">
                  <div className="flex-1 h-px bg-gradient-to-r from-transparent to-indigo-200" />
                  <div className="flex items-center gap-2 px-3 py-1.5 bg-indigo-50 border border-indigo-200 rounded-full">
                    <Brain size={12} className="text-indigo-600" />
                    <span className="text-xs font-black text-indigo-700 uppercase tracking-widest">ActMon AI Analysis</span>
                  </div>
                  <div className="flex-1 h-px bg-gradient-to-l from-transparent to-indigo-200" />
                </div>
                <AISection connId={id} query={query} explainNodes={explainNodes} autoRun={groqAuto} />
              </div>
            )}
          </div>
        )}

        {/* ── Standalone AI tab ── */}
        {tab === 'ai' && (
          <AISection connId={id} query={query} explainNodes={explainNodes} autoRun={false} />
        )}
      </div>
    </div>
  );
}
