import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  RefreshCw, ChevronDown, ChevronRight, CheckCircle2,
  Search, Clock, ArrowLeft, TrendingDown, BarChart2,
  XCircle, Download, FileText, Brain, Table2, Activity,
  Database, Loader2, Copy, Check, ArrowUpDown, ArrowUp,
  ArrowDown, Eye, EyeOff, Shield, Target, Cpu, HardDrive,
  BookOpen, Terminal, Star, Layers,
} from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell,
} from 'recharts';
import client from '../../api/client';

// ─── API functions ────────────────────────────────────────────────────────────

const fetchSlowQueries   = (id) => client.get(`/connections/mysql/${id}/slow-queries`).then(r => r.data);
const explainAnalyze     = (id, sql, db) => client.post(`/connections/mysql/${id}/slow-queries/explain-analyze`, { sql_text: sql, db_name: db }).then(r => r.data);
const analyzeGroq        = (id, payload) => client.post(`/connections/mysql/${id}/slow-queries/analyze-groq`, payload).then(r => r.data);
const saveSSHConfig      = (id, payload) => client.put(`/connections/mysql/${id}/ssh-config`, payload).then(r => r.data);

// ─── constants ────────────────────────────────────────────────────────────────

const TABS = [
  { id: 'overview',  label: 'Overview',      icon: Activity },
  { id: 'explorer',  label: 'Query Explorer', icon: Table2 },
  { id: 'ai',        label: 'AI Analysis',    icon: Brain },
  { id: 'reports',   label: 'Reports',        icon: Download },
];

const PIE_COLORS = ['#3b82f6','#f59e0b','#22c55e','#ef4444','#8b5cf6','#06b6d4','#f97316','#ec4899'];

const SEVERITY_CFG = {
  critical: { bg: 'bg-red-100',    text: 'text-red-700',    border: 'border-red-300',    dot: 'bg-red-500'    },
  high:     { bg: 'bg-orange-100', text: 'text-orange-700', border: 'border-orange-300', dot: 'bg-orange-500' },
  medium:   { bg: 'bg-amber-100',  text: 'text-amber-700',  border: 'border-amber-300',  dot: 'bg-amber-500'  },
  warning:  { bg: 'bg-amber-100',  text: 'text-amber-700',  border: 'border-amber-300',  dot: 'bg-amber-500'  },
  low:      { bg: 'bg-blue-100',   text: 'text-blue-700',   border: 'border-blue-200',   dot: 'bg-blue-400'   },
};

const EXPLAIN_TYPE_CFG = {
  'ALL':     { cls: 'bg-red-100 text-red-700',     label: 'ALL',     tooltip: 'Full table scan — worst' },
  'index':   { cls: 'bg-orange-100 text-orange-700', label: 'INDEX',  tooltip: 'Full index scan' },
  'range':   { cls: 'bg-amber-100 text-amber-700',  label: 'RANGE',   tooltip: 'Index range scan — OK' },
  'ref':     { cls: 'bg-yellow-100 text-yellow-700', label: 'REF',    tooltip: 'Index lookup — good' },
  'eq_ref':  { cls: 'bg-green-100 text-green-700',  label: 'EQ_REF',  tooltip: 'Unique index lookup — very good' },
  'const':   { cls: 'bg-green-200 text-green-800',  label: 'CONST',   tooltip: 'Constant — best' },
  'system':  { cls: 'bg-green-200 text-green-800',  label: 'SYSTEM',  tooltip: 'System table — best' },
};

// ─── small helpers ────────────────────────────────────────────────────────────

const fmtSec = (v) => {
  const n = Number(v) || 0;
  if (n >= 1) return n.toFixed(2) + 's';
  if (n >= 0.001) return (n * 1000).toFixed(1) + 'ms';
  return (n * 1000000).toFixed(0) + 'µs';
};
const fmtNum = (n) => {
  const v = Number(n) || 0;
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return String(v);
};
const truncSql = (sql, len = 90) => {
  if (!sql) return '—';
  const s = sql.replace(/\s+/g, ' ').trim();
  return s.length > len ? s.slice(0, len) + '…' : s;
};

// ─── sub-components ───────────────────────────────────────────────────────────

function KpiCard({ icon: Icon, label, value, sub, accent = 'blue' }) {
  const accentMap = {
    blue:   { bg: 'bg-blue-50',   icon: 'text-blue-600',   val: 'text-blue-700'   },
    red:    { bg: 'bg-red-50',    icon: 'text-red-600',    val: 'text-red-700'    },
    amber:  { bg: 'bg-amber-50',  icon: 'text-amber-600',  val: 'text-amber-700'  },
    green:  { bg: 'bg-green-50',  icon: 'text-green-600',  val: 'text-green-700'  },
    purple: { bg: 'bg-purple-50', icon: 'text-purple-600', val: 'text-purple-700' },
    orange: { bg: 'bg-orange-50', icon: 'text-orange-600', val: 'text-orange-700' },
  };
  const c = accentMap[accent] || accentMap.blue;
  return (
    <div className={`rounded-2xl border border-slate-200 bg-white p-4 flex flex-col gap-3`}>
      <div className={`w-9 h-9 rounded-xl ${c.bg} flex items-center justify-center`}>
        <Icon className={`h-4.5 w-4.5 ${c.icon}`} size={18} />
      </div>
      <div>
        <div className={`text-2xl font-black ${c.val}`}>{value}</div>
        <div className="text-xs font-semibold text-slate-500 mt-0.5">{label}</div>
        {sub && <div className="text-[10px] text-slate-400 mt-0.5">{sub}</div>}
      </div>
    </div>
  );
}

function SourceBanner({ data }) {
  const hasPerfSchema = data?.perf_schema_enabled && (data?.perf_schema_queries || []).length > 0;
  const hasFileLog    = (data?.file_queries || []).length > 0;
  const perfErr       = data?.perf_schema_error;
  const fileErr       = data?.file_error;

  return (
    <div className="flex flex-wrap gap-3">
      {/* Performance Schema */}
      <div className={`flex items-center gap-2 px-3 py-2 rounded-xl border text-xs font-semibold ${
        hasPerfSchema ? 'bg-green-50 border-green-200 text-green-700' : 'bg-slate-50 border-slate-200 text-slate-500'
      }`}>
        <div className={`w-2 h-2 rounded-full ${hasPerfSchema ? 'bg-green-500 animate-pulse' : 'bg-slate-300'}`} />
        Performance Schema
        {hasPerfSchema && <span className="font-normal text-green-600">({(data?.perf_schema_queries || []).length} queries)</span>}
        {perfErr && <span className="text-red-500 font-normal ml-1">✗ {perfErr.slice(0, 60)}</span>}
      </div>

      {/* Slow Log File */}
      <div className={`flex items-center gap-2 px-3 py-2 rounded-xl border text-xs font-semibold ${
        hasFileLog ? 'bg-blue-50 border-blue-200 text-blue-700' : 'bg-slate-50 border-slate-200 text-slate-500'
      }`}>
        <div className={`w-2 h-2 rounded-full ${hasFileLog ? 'bg-blue-500' : 'bg-slate-300'}`} />
        Slow Query Log File
        {data?.slow_log_config?.log_file && (
          <span className="font-mono font-normal text-slate-500">{data.slow_log_config.log_file}</span>
        )}
        {hasFileLog && <span className="font-normal text-blue-600">({(data?.file_queries || []).length} entries)</span>}
        {fileErr && <span className="text-amber-600 font-normal ml-1">⚠ {fileErr.slice(0, 60)}</span>}
      </div>

      {/* Log config pills */}
      {data?.slow_log_config?.enabled !== undefined && (
        <div className={`flex items-center gap-2 px-3 py-2 rounded-xl border text-xs font-semibold ${
          data.slow_log_config.enabled ? 'bg-amber-50 border-amber-200 text-amber-700' : 'bg-slate-50 border-slate-200 text-slate-500'
        }`}>
          <Clock size={12} />
          long_query_time: {data.slow_log_config.long_query_time ?? '—'}s
        </div>
      )}
    </div>
  );
}

function SeverityBadge({ level }) {
  const l = (level || 'low').toLowerCase();
  const cfg = SEVERITY_CFG[l] || SEVERITY_CFG.low;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold border ${cfg.bg} ${cfg.text} ${cfg.border}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
      {l.toUpperCase()}
    </span>
  );
}

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <button onClick={copy} className="p-1.5 rounded-lg hover:bg-slate-200 transition-colors text-slate-400 hover:text-slate-700">
      {copied ? <Check size={13} className="text-green-600" /> : <Copy size={13} />}
    </button>
  );
}

function ExplainTypeBadge({ type }) {
  const t = (type || '').toLowerCase();
  const cfg = EXPLAIN_TYPE_CFG[t] || { cls: 'bg-slate-100 text-slate-600', label: type || '—', tooltip: '' };
  return (
    <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${cfg.cls}`} title={cfg.tooltip}>
      {cfg.label || type}
    </span>
  );
}

// ─── SSH Config Modal ─────────────────────────────────────────────────────────

function SSHConfigModal({ connId, currentHost, onClose, onSaved }) {
  const [form, setForm] = useState({ ssh_host: currentHost || '', ssh_port: 22, ssh_user: 'suyash', ssh_password: '' });
  const [loading, setLoading] = useState(false);
  const [result, setResult]   = useState(null);
  const [showPwd, setShowPwd] = useState(false);

  const save = async () => {
    setLoading(true); setResult(null);
    try {
      const r = await saveSSHConfig(connId, form);
      setResult(r);
      if (r.status === 'success') { setTimeout(() => { onSaved(); onClose(); }, 1200); }
    } catch (e) {
      setResult({ status: 'error', message: e.message });
    } finally { setLoading(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden">
        {/* Header */}
        <div className="bg-slate-800 text-white px-5 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Terminal size={16} className="text-green-400" />
            <span className="font-bold">Configure SSH Access</span>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white"><XCircle size={18} /></button>
        </div>

        <div className="p-5 space-y-4">
          <p className="text-xs text-slate-500">
            SSH credentials allow ACTMON to read the slow query log file directly from the remote server when
            <code className="mx-1 px-1 bg-slate-100 rounded text-slate-700 text-[10px]">LOAD_FILE()</code> is unavailable.
          </p>

          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="text-xs font-bold text-slate-600 block mb-1">SSH Host</label>
              <input
                type="text" value={form.ssh_host}
                onChange={e => setForm(f => ({ ...f, ssh_host: e.target.value }))}
                placeholder={currentHost}
                className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-slate-400"
              />
              <p className="text-[10px] text-slate-400 mt-1">Leave blank to use MySQL host ({currentHost})</p>
            </div>
            <div>
              <label className="text-xs font-bold text-slate-600 block mb-1">SSH Port</label>
              <input
                type="number" value={form.ssh_port}
                onChange={e => setForm(f => ({ ...f, ssh_port: parseInt(e.target.value) || 22 }))}
                className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-slate-400"
              />
            </div>
            <div>
              <label className="text-xs font-bold text-slate-600 block mb-1">SSH Username</label>
              <input
                type="text" value={form.ssh_user}
                onChange={e => setForm(f => ({ ...f, ssh_user: e.target.value }))}
                placeholder="suyash"
                className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-slate-400"
              />
            </div>
            <div className="col-span-2">
              <label className="text-xs font-bold text-slate-600 block mb-1">SSH Password</label>
              <div className="relative">
                <input
                  type={showPwd ? 'text' : 'password'}
                  value={form.ssh_password}
                  onChange={e => setForm(f => ({ ...f, ssh_password: e.target.value }))}
                  placeholder="••••••••"
                  className="w-full border border-slate-200 rounded-xl px-3 py-2 pr-10 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-slate-400"
                />
                <button
                  onClick={() => setShowPwd(s => !s)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700"
                >{showPwd ? <EyeOff size={14} /> : <Eye size={14} />}</button>
              </div>
            </div>
          </div>

          {/* Result */}
          {result && (
            <div className={`rounded-xl p-3 text-xs font-semibold ${
              result.status === 'success' ? 'bg-green-50 border border-green-200 text-green-700' : 'bg-red-50 border border-red-200 text-red-700'
            }`}>
              {result.status === 'success' ? '✓' : '✗'} {result.message}
            </div>
          )}

          <div className="flex gap-3 pt-2">
            <button onClick={onClose} className="flex-1 py-2.5 rounded-xl border border-slate-200 text-sm font-bold text-slate-600 hover:bg-slate-50">
              Cancel
            </button>
            <button
              onClick={save} disabled={loading || !form.ssh_user || !form.ssh_password}
              className="flex-1 py-2.5 rounded-xl bg-slate-800 text-white text-sm font-bold hover:bg-slate-700 disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {loading ? <Loader2 size={14} className="animate-spin" /> : <Terminal size={14} />}
              {loading ? 'Testing SSH…' : 'Save & Test'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}


function HintCard({ hint }) {
  const levelMap = {
    critical: 'border-red-400 bg-red-50',
    high:     'border-orange-400 bg-orange-50',
    warning:  'border-amber-400 bg-amber-50',
    low:      'border-blue-300 bg-blue-50',
  };
  const textMap = {
    critical: 'text-red-700',
    high:     'text-orange-700',
    warning:  'text-amber-700',
    low:      'text-blue-700',
  };
  const l = (hint.level || 'low').toLowerCase();
  return (
    <div className={`rounded-xl border-l-4 p-3 ${levelMap[l] || levelMap.low}`}>
      <p className={`font-bold text-xs ${textMap[l] || textMap.low}`}>{hint.title}</p>
      <p className="text-xs text-slate-600 mt-0.5">{hint.text}</p>
      {hint.fix && (
        <p className="text-xs text-slate-700 mt-1 font-medium">
          <span className="text-green-700 font-bold">Fix: </span>{hint.fix}
        </p>
      )}
    </div>
  );
}

// ─── ExplainPanel ─────────────────────────────────────────────────────────────

function ExplainPanel({ connId, sql, dbName, onSelectAI }) {
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [ran, setRan] = useState(false);

  const run = async () => {
    setLoading(true);
    try {
      const r = await explainAnalyze(connId, sql, dbName);
      setResult(r);
      setRan(true);
    } catch (e) {
      setResult({ status: 'error', error: e.message });
      setRan(true);
    } finally {
      setLoading(false);
    }
  };

  if (!ran) {
    return (
      <button
        onClick={run}
        disabled={loading}
        className="flex items-center gap-2 px-4 py-2 rounded-xl bg-slate-800 text-white text-xs font-bold hover:bg-slate-700 transition-colors disabled:opacity-60"
      >
        {loading ? <Loader2 size={13} className="animate-spin" /> : <Eye size={13} />}
        Run EXPLAIN Analysis
      </button>
    );
  }

  if (result?.status === 'error') {
    return (
      <div className="rounded-xl bg-red-50 border border-red-200 p-3 text-xs text-red-700">
        <p className="font-bold">EXPLAIN failed</p>
        <p className="font-mono mt-1">{result.error}</p>
        <button onClick={() => setRan(false)} className="mt-2 text-xs text-red-600 underline">Try again</button>
      </div>
    );
  }

  const hints  = result?.hints || [];
  const rows   = result?.explain_rows || [];
  const stats  = result?.stats || {};

  return (
    <div className="space-y-3">
      {/* Stats strip */}
      <div className="flex flex-wrap gap-2">
        {stats.has_full_scan && (
          <span className="px-2.5 py-1 rounded-full text-[10px] font-bold bg-red-100 text-red-700 border border-red-200">⚠ FULL SCAN</span>
        )}
        {stats.has_filesort && (
          <span className="px-2.5 py-1 rounded-full text-[10px] font-bold bg-amber-100 text-amber-700 border border-amber-200">↕ FILESORT</span>
        )}
        {stats.has_temp_table && (
          <span className="px-2.5 py-1 rounded-full text-[10px] font-bold bg-orange-100 text-orange-700 border border-orange-200">⚙ TEMP TABLE</span>
        )}
        {stats.has_no_index && (
          <span className="px-2.5 py-1 rounded-full text-[10px] font-bold bg-purple-100 text-purple-700 border border-purple-200">∅ NO INDEX</span>
        )}
        {stats.total_rows_estimate > 0 && (
          <span className="px-2.5 py-1 rounded-full text-[10px] font-bold bg-slate-100 text-slate-600 border border-slate-200">
            ~{fmtNum(stats.total_rows_estimate)} rows estimated
          </span>
        )}
        <button
          onClick={() => onSelectAI && onSelectAI(result)}
          className="ml-auto px-3 py-1 rounded-full text-[10px] font-bold bg-purple-600 text-white hover:bg-purple-700 transition-colors flex items-center gap-1"
        >
          <Brain size={11} /> Analyze with AI
        </button>
      </div>

      {/* Hints */}
      {hints.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-bold text-slate-600">Issues Detected ({hints.length})</p>
          {hints.map((h, i) => <HintCard key={i} hint={h} />)}
        </div>
      )}

      {hints.length === 0 && rows.length > 0 && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-green-50 border border-green-200 text-xs text-green-700 font-semibold">
          <CheckCircle2 size={14} /> No critical issues detected — query looks optimized
        </div>
      )}

      {/* EXPLAIN table */}
      {rows.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-slate-200">
          <table className="w-full text-[11px]">
            <thead className="bg-slate-800 text-white">
              <tr>
                {['id','select_type','table','type','possible_keys','key','rows','Extra'].map(col => (
                  <th key={col} className="px-3 py-2 text-left font-bold whitespace-nowrap">{col}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => {
                const typ = String(row.type || row.Type || '');
                const extra = String(row.Extra || row.extra || '');
                const rowBg = typ === 'ALL' ? 'bg-red-50' : typ === 'index' ? 'bg-amber-50' : '';
                return (
                  <tr key={i} className={`border-t border-slate-100 ${rowBg}`}>
                    <td className="px-3 py-1.5 font-mono text-slate-500">{row.id || row.Id}</td>
                    <td className="px-3 py-1.5 font-mono text-slate-600">{row.select_type || row.select_Type}</td>
                    <td className="px-3 py-1.5 font-bold text-slate-800">{row.table || row.Table}</td>
                    <td className="px-3 py-1.5"><ExplainTypeBadge type={typ} /></td>
                    <td className="px-3 py-1.5 font-mono text-slate-500 max-w-[120px] truncate" title={row.possible_keys}>{row.possible_keys || '—'}</td>
                    <td className="px-3 py-1.5 font-mono text-green-700 font-semibold">{row.key || '—'}</td>
                    <td className="px-3 py-1.5 font-mono text-slate-700 font-bold">{fmtNum(row.rows || row.Rows)}</td>
                    <td className="px-3 py-1.5 font-mono text-slate-500 max-w-[200px] truncate" title={extra}>{extra || '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <button onClick={() => setRan(false)} className="text-[10px] text-slate-400 underline">Re-run EXPLAIN</button>
    </div>
  );
}

// ─── AI Analysis Panel ────────────────────────────────────────────────────────

function AIAnalysisPanel({ connId, queryData, explainRows, onClose }) {
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]   = useState(null);

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await analyzeGroq(connId, {
        sql_text:      queryData.sql_text,
        db_name:       queryData.db_name,
        count_calls:   queryData.count_calls,
        avg_exec_sec:  queryData.avg_exec_sec,
        max_exec_sec:  queryData.max_exec_sec,
        total_exec_sec: queryData.total_exec_sec,
        rows_examined: queryData.rows_examined,
        rows_returned: queryData.rows_returned,
        no_index_count: queryData.no_index_count,
        explain_rows:  explainRows || [],
      });
      if (r.status === 'error') setError(r.error);
      else setResult(r.analysis);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [connId, queryData, explainRows]);

  useEffect(() => { run(); }, [run]);

  const a = result;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Brain size={16} className="text-purple-600" />
          <span className="font-bold text-slate-800 text-sm">ActMon AI Deep Analysis</span>
          {loading && <Loader2 size={14} className="animate-spin text-purple-500" />}
        </div>
        {onClose && (
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 transition-colors">
            <XCircle size={16} />
          </button>
        )}
      </div>

      {error && (
        <div className="rounded-xl bg-red-50 border border-red-200 p-4 text-sm text-red-700">
          <p className="font-bold">AI analysis failed</p>
          <p className="font-mono text-xs mt-1">{error}</p>
          <button onClick={run} className="mt-2 px-3 py-1.5 rounded-lg bg-red-600 text-white text-xs font-bold hover:bg-red-700">Retry</button>
        </div>
      )}

      {loading && !a && (
        <div className="flex flex-col items-center justify-center py-12 gap-3">
          <div className="w-12 h-12 rounded-2xl bg-purple-100 flex items-center justify-center">
            <Brain size={24} className="text-purple-600 animate-pulse" />
          </div>
          <p className="text-sm font-semibold text-slate-600">Analyzing with ActMon AI…</p>
          <p className="text-xs text-slate-400">ActMon AI Engine · deep analysis in progress</p>
        </div>
      )}

      {a && (
        <div className="space-y-4">
          {/* Severity + Summary */}
          <div className="flex flex-col sm:flex-row gap-3 items-start">
            <SeverityBadge level={a.severity} />
            <p className="text-sm text-slate-700 font-medium">{a.summary}</p>
          </div>

          {/* Root cause */}
          <div className="rounded-xl bg-slate-800 text-white p-4 text-sm">
            <p className="font-bold mb-1 text-slate-300 text-xs uppercase tracking-wider">Root Cause</p>
            <p>{a.root_cause}</p>
          </div>

          {/* Issues */}
          {(a.issues || []).length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-bold text-slate-600 uppercase tracking-wider">Issues Identified</p>
              {a.issues.map((issue, i) => (
                <div key={i} className={`rounded-xl p-3 border-l-4 ${
                  issue.severity === 'critical' ? 'bg-red-50 border-red-500' :
                  issue.severity === 'high'     ? 'bg-orange-50 border-orange-500' :
                  issue.severity === 'medium'   ? 'bg-amber-50 border-amber-400' :
                                                  'bg-blue-50 border-blue-400'
                }`}>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[10px] font-black px-1.5 py-0.5 rounded bg-slate-800 text-white">{issue.type}</span>
                    {issue.table && <span className="text-[10px] font-mono text-slate-500">table: {issue.table}</span>}
                    <SeverityBadge level={issue.severity} />
                  </div>
                  <p className="text-xs text-slate-700">{issue.description}</p>
                  {issue.evidence && <p className="text-[10px] font-mono text-slate-500 mt-1">Evidence: {issue.evidence}</p>}
                </div>
              ))}
            </div>
          )}

          {/* Index recommendations */}
          {(a.index_recommendations || []).length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-bold text-slate-600 uppercase tracking-wider">Index Recommendations</p>
              {a.index_recommendations.map((rec, i) => (
                <div key={i} className="rounded-xl bg-green-50 border border-green-200 p-3">
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold text-green-800">Table: {rec.table}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-200 text-green-800 font-bold">{rec.index_type}</span>
                    </div>
                    {rec.estimated_improvement && (
                      <span className="text-[10px] font-bold text-green-700">{rec.estimated_improvement}</span>
                    )}
                  </div>
                  {rec.create_sql && (
                    <div className="relative">
                      <pre className="text-[11px] font-mono bg-slate-900 text-green-400 rounded-lg p-3 overflow-x-auto">{rec.create_sql}</pre>
                      <div className="absolute top-2 right-2"><CopyButton text={rec.create_sql} /></div>
                    </div>
                  )}
                  <p className="text-xs text-slate-600 mt-2">{rec.reason}</p>
                  {rec.estimated_row_reduction && (
                    <p className="text-[10px] text-slate-500 mt-1">Row reduction: {rec.estimated_row_reduction}</p>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Query rewrite */}
          {a.query_rewrite?.applicable && a.query_rewrite?.optimized_sql && (
            <div className="space-y-2">
              <p className="text-xs font-bold text-slate-600 uppercase tracking-wider">Optimized Query</p>
              <div className="rounded-xl bg-slate-900 p-3 relative">
                <pre className="text-[11px] font-mono text-cyan-300 overflow-x-auto whitespace-pre-wrap">{a.query_rewrite.optimized_sql}</pre>
                <div className="absolute top-2 right-2"><CopyButton text={a.query_rewrite.optimized_sql} /></div>
              </div>
              {a.query_rewrite.explanation && (
                <p className="text-xs text-slate-600">{a.query_rewrite.explanation}</p>
              )}
              {a.query_rewrite.expected_gain && (
                <span className="inline-block px-2.5 py-1 rounded-full text-xs font-bold bg-blue-100 text-blue-700">
                  Expected gain: {a.query_rewrite.expected_gain}
                </span>
              )}
            </div>
          )}

          {/* Priority actions */}
          {(a.priority_actions || []).length > 0 && (
            <div className="rounded-xl bg-slate-50 border border-slate-200 p-4">
              <p className="text-xs font-bold text-slate-600 uppercase tracking-wider mb-3">Priority Actions</p>
              <ol className="space-y-2">
                {a.priority_actions.map((action, i) => (
                  <li key={i} className="flex items-start gap-2.5 text-xs text-slate-700">
                    <span className="w-5 h-5 rounded-full bg-slate-800 text-white flex-shrink-0 flex items-center justify-center text-[10px] font-black">
                      {i + 1}
                    </span>
                    <span>{typeof action === 'string' ? action.replace(/^\d+\.\s*/, '') : action}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}

          {/* Business impact + estimated improvement */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {a.business_impact && (
              <div className="rounded-xl bg-amber-50 border border-amber-200 p-3">
                <p className="text-[10px] font-bold text-amber-700 uppercase mb-1">Business Impact</p>
                <p className="text-xs text-slate-700">{a.business_impact}</p>
              </div>
            )}
            {a.estimated_overall_improvement && (
              <div className="rounded-xl bg-blue-50 border border-blue-200 p-3">
                <p className="text-[10px] font-bold text-blue-700 uppercase mb-1">Estimated Improvement</p>
                <p className="text-xs font-bold text-slate-800">{a.estimated_overall_improvement}</p>
              </div>
            )}
          </div>

          {/* Validation queries */}
          {(a.validation_queries || []).length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-bold text-slate-600 uppercase tracking-wider">Validation Queries</p>
              {a.validation_queries.map((q, i) => (
                <div key={i} className="relative rounded-xl bg-slate-900 p-3">
                  <pre className="text-[11px] font-mono text-slate-300 overflow-x-auto">{q}</pre>
                  <div className="absolute top-2 right-2"><CopyButton text={q} /></div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── QueryRow (Explorer table row) ───────────────────────────────────────────

function QueryRow({ q, idx, connId, onAnalyzeAI }) {
  const [open, setOpen]           = useState(false);
  const [activeInner, setInner]   = useState('sql');
  const [explainResult, setERes]  = useState(null);

  const efficiency = q.rows_examined > 0 ? Math.round((q.rows_returned / q.rows_examined) * 100) : 100;
  const hasIssue   = q.no_index_count > 0 || q.rows_examined > 10000;
  const rowBg      = hasIssue ? 'bg-red-50/40' : '';

  return (
    <>
      <tr
        className={`border-b border-slate-100 cursor-pointer hover:bg-blue-50/40 transition-colors group ${rowBg}`}
        onClick={() => setOpen(o => !o)}
      >
        <td className="px-4 py-3 w-8 text-slate-400">
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </td>
        <td className="px-2 py-3">
          <span className="text-xs font-mono text-slate-400">#{idx + 1}</span>
        </td>
        <td className="px-3 py-3 max-w-xs">
          <p className="text-xs font-mono text-slate-700 truncate" title={q.sql_text}>{truncSql(q.sql_text)}</p>
          {q.db_name && <span className="text-[10px] text-slate-400">{q.db_name}</span>}
        </td>
        <td className="px-3 py-3 text-right">
          <span className={`text-sm font-black ${Number(q.avg_exec_sec) >= 1 ? 'text-red-600' : Number(q.avg_exec_sec) >= 0.1 ? 'text-amber-600' : 'text-slate-700'}`}>
            {fmtSec(q.avg_exec_sec)}
          </span>
        </td>
        <td className="px-3 py-3 text-right text-xs font-bold text-slate-600">{fmtSec(q.max_exec_sec)}</td>
        <td className="px-3 py-3 text-right text-xs font-semibold text-slate-600">{fmtNum(q.count_calls)}</td>
        <td className="px-3 py-3 text-right text-xs text-slate-600">{fmtNum(q.rows_examined)}</td>
        <td className="px-3 py-3 text-right text-xs text-slate-600">{fmtNum(q.rows_returned)}</td>
        <td className="px-3 py-3 text-center">
          {q.no_index_count > 0
            ? <span className="px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-red-100 text-red-700">{fmtNum(q.no_index_count)}</span>
            : <span className="text-green-500 text-xs">✓</span>
          }
        </td>
        <td className="px-3 py-3 text-right text-[10px] text-slate-400">{q.last_seen || '—'}</td>
      </tr>

      {open && (
        <tr className="bg-slate-50/80">
          <td colSpan={10} className="px-4 py-4">
            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
              {/* Inner tabs */}
              <div className="flex border-b border-slate-200 bg-slate-50">
                {[
                  { id: 'sql',     label: 'SQL',           icon: Terminal },
                  { id: 'stats',   label: 'Stats',         icon: BarChart2 },
                  { id: 'explain', label: 'EXPLAIN',       icon: Eye },
                  { id: 'ai',      label: 'AI Analysis',   icon: Brain },
                ].map(({ id, label, icon: Icon }) => (
                  <button
                    key={id}
                    onClick={() => setInner(id)}
                    className={`flex items-center gap-1.5 px-4 py-2.5 text-xs font-bold transition-colors ${
                      activeInner === id
                        ? 'bg-white text-slate-800 border-b-2 border-slate-800'
                        : 'text-slate-500 hover:text-slate-700'
                    }`}
                  >
                    <Icon size={12} />{label}
                    {id === 'ai' && <span className="px-1 py-0.5 rounded text-[9px] bg-purple-100 text-purple-700 font-black">AI</span>}
                  </button>
                ))}
              </div>

              <div className="p-4">
                {/* SQL tab */}
                {activeInner === 'sql' && (
                  <div className="space-y-3">
                    <div className="relative">
                      <pre className="text-xs font-mono bg-slate-900 text-emerald-400 rounded-xl p-4 overflow-x-auto whitespace-pre-wrap leading-relaxed">
                        {q.sql_text}
                      </pre>
                      <div className="absolute top-3 right-3">
                        <CopyButton text={q.sql_text} />
                      </div>
                    </div>
                    {q.db_name && (
                      <div className="flex items-center gap-2 text-xs text-slate-500">
                        <Database size={12} /> <span>Database: <strong>{q.db_name}</strong></span>
                      </div>
                    )}
                  </div>
                )}

                {/* Stats tab */}
                {activeInner === 'stats' && (
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    {[
                      { label: 'Avg Exec Time',   value: fmtSec(q.avg_exec_sec),   accent: Number(q.avg_exec_sec)>=1?'red':'amber' },
                      { label: 'Max Exec Time',   value: fmtSec(q.max_exec_sec),   accent: 'orange' },
                      { label: 'Total CPU Time',  value: fmtSec(q.total_exec_sec), accent: 'purple' },
                      { label: 'Executions',      value: fmtNum(q.count_calls),    accent: 'blue' },
                      { label: 'Rows Examined',   value: fmtNum(q.rows_examined),  accent: q.rows_examined>10000?'red':'amber' },
                      { label: 'Rows Returned',   value: fmtNum(q.rows_returned),  accent: 'green' },
                      { label: 'Efficiency',      value: efficiency + '%',          accent: efficiency<10?'red':efficiency<50?'amber':'green' },
                      { label: 'No-Index Scans',  value: fmtNum(q.no_index_count), accent: q.no_index_count>0?'red':'green' },
                    ].map(({ label, value, accent }) => {
                      const amap = { red:'text-red-700 bg-red-50', amber:'text-amber-700 bg-amber-50', orange:'text-orange-700 bg-orange-50', purple:'text-purple-700 bg-purple-50', blue:'text-blue-700 bg-blue-50', green:'text-green-700 bg-green-50' };
                      return (
                        <div key={label} className={`rounded-xl p-3 ${amap[accent] || amap.blue}`}>
                          <div className={`text-xl font-black ${(amap[accent]||amap.blue).split(' ')[0]}`}>{value}</div>
                          <div className="text-[10px] font-semibold text-slate-500 mt-0.5">{label}</div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* EXPLAIN tab */}
                {activeInner === 'explain' && (
                  <ExplainPanel
                    connId={connId}
                    sql={q.sql_text}
                    dbName={q.db_name}
                    onSelectAI={(expResult) => {
                      setERes(expResult);
                      setInner('ai');
                    }}
                  />
                )}

                {/* AI Analysis tab */}
                {activeInner === 'ai' && (
                  <AIAnalysisPanel
                    connId={connId}
                    queryData={q}
                    explainRows={explainResult?.explain_rows || []}
                  />
                )}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function SlowQueries() {
  const { id } = useParams();

  const [activeTab, setActiveTab]   = useState('overview');
  const [search, setSearch]         = useState('');
  const [dbFilter, setDbFilter]     = useState('all');
  const [minTime, setMinTime]       = useState(0);
  const [noIndexOnly, setNoIndex]   = useState(false);
  const [sortKey, setSortKey]       = useState('avg_exec_sec');
  const [sortDir, setSortDir]       = useState('desc');
  const [exportPeriod, setExportPeriod] = useState('daily');
  const [exportLoading, setExportLoading] = useState(false);
  const [countdown, setCountdown]   = useState(30);
  const [showSSH, setShowSSH]       = useState(false);

  // AI tab state
  const [aiQuery, setAiQuery]       = useState(null);

  const { data, isLoading, error, refetch, dataUpdatedAt } = useQuery({
    queryKey: ['mysqlSlowQueries', id],
    queryFn: () => fetchSlowQueries(id),
    retry: false,
    refetchInterval: 30000,
  });

  // Countdown timer
  useEffect(() => {
    setCountdown(30);
    const t = setInterval(() => setCountdown(c => c <= 1 ? 30 : c - 1), 1000);
    return () => clearInterval(t);
  }, [dataUpdatedAt]);

  // Deduplicate + merge queries from both sources
  const allQueries = useMemo(() => {
    const perf = data?.perf_schema_queries || [];
    const file = data?.file_queries || [];
    const seen = new Set();
    const merged = [];
    for (const q of [...perf, ...file]) {
      if (!q?.sql_text) continue;
      const key = (q.sql_text || '').trim().slice(0, 120);
      if (!seen.has(key)) { seen.add(key); merged.push(q); }
    }
    return merged;
  }, [data]);

  // Unique DB names
  const dbNames = useMemo(() => {
    const s = new Set(allQueries.map(q => q.db_name).filter(Boolean));
    return ['all', ...Array.from(s).sort()];
  }, [allQueries]);

  // Filter + sort
  const filtered = useMemo(() => {
    let list = allQueries;
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(r => r.sql_text?.toLowerCase().includes(q) || r.db_name?.toLowerCase().includes(q));
    }
    if (dbFilter !== 'all') list = list.filter(r => r.db_name === dbFilter);
    if (minTime > 0) list = list.filter(r => Number(r.avg_exec_sec) >= minTime);
    if (noIndexOnly) list = list.filter(r => Number(r.no_index_count) > 0);

    return [...list].sort((a, b) => {
      const va = Number(a[sortKey]) || 0;
      const vb = Number(b[sortKey]) || 0;
      return sortDir === 'desc' ? vb - va : va - vb;
    });
  }, [allQueries, search, dbFilter, minTime, noIndexOnly, sortKey, sortDir]);

  // KPI stats
  const kpis = useMemo(() => {
    if (!allQueries.length) return {};
    const total  = allQueries.length;
    const avgArr = allQueries.map(q => Number(q.avg_exec_sec) || 0);
    const avgAvg = avgArr.reduce((a, b) => a + b, 0) / total;
    const maxMax = Math.max(...allQueries.map(q => Number(q.max_exec_sec) || 0));
    const noIdx  = allQueries.filter(q => Number(q.no_index_count) > 0).length;
    const totalCpu = allQueries.reduce((a, q) => a + (Number(q.total_exec_sec) || 0), 0);
    return { total, avgAvg, maxMax, noIdx, totalCpu };
  }, [allQueries]);

  // Chart data
  const topChartData = useMemo(() =>
    allQueries
      .slice()
      .sort((a, b) => Number(b.avg_exec_sec) - Number(a.avg_exec_sec))
      .slice(0, 12)
      .map((q, i) => ({
        name: `Q${i + 1}`,
        avg:  parseFloat((Number(q.avg_exec_sec) * 1000).toFixed(1)),
        max:  parseFloat((Number(q.max_exec_sec) * 1000).toFixed(1)),
        full: q.sql_text?.replace(/\s+/g, ' ').slice(0, 60),
      })),
  [allQueries]);

  const dbChartData = useMemo(() => {
    const counts = {};
    allQueries.forEach(q => { const d = q.db_name || '(all)'; counts[d] = (counts[d] || 0) + 1; });
    return Object.entries(counts).map(([name, value]) => ({ name, value }));
  }, [allQueries]);

  const handleSort = (key) => {
    setSortKey(k => {
      if (k === key) { setSortDir(d => d === 'desc' ? 'asc' : 'desc'); return key; }
      setSortDir('desc'); return key;
    });
  };

  const SortIcon = ({ col }) => {
    if (sortKey !== col) return <ArrowUpDown size={11} className="text-slate-300 ml-1 inline" />;
    return sortDir === 'desc'
      ? <ArrowDown size={11} className="text-blue-600 ml-1 inline" />
      : <ArrowUp size={11} className="text-blue-600 ml-1 inline" />;
  };

  // Export
  const handleExport = async () => {
    setExportLoading(true);
    try {
      const response = await client.get(
        `/connections/mysql/${id}/slow-queries/export?period=${exportPeriod}`,
        { responseType: 'blob' }
      );
      const url = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', `slow_queries_${exportPeriod}_${new Date().toISOString().slice(0,10)}.csv`);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch (e) {
      alert('Export failed: ' + e.message);
    } finally {
      setExportLoading(false);
    }
  };

  // ── Loading / error states ──
  if (isLoading && !data) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4">
        <div className="w-14 h-14 rounded-2xl bg-amber-100 flex items-center justify-center">
          <Clock size={28} className="text-amber-600 animate-pulse" />
        </div>
        <p className="text-slate-600 font-semibold">Loading slow query analysis…</p>
        <p className="text-xs text-slate-400">Checking performance schema and log files</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4">
        <XCircle size={40} className="text-red-400" />
        <p className="text-slate-700 font-bold">Failed to load slow queries</p>
        <p className="text-xs text-slate-500 font-mono">{error.message}</p>
        <button onClick={refetch} className="px-4 py-2 rounded-xl bg-slate-800 text-white text-sm font-bold hover:bg-slate-700">
          Retry
        </button>
      </div>
    );
  }

  // ── Render ──
  return (
    <>
    {/* SSH Config Modal */}
    {showSSH && (
      <SSHConfigModal
        connId={id}
        currentHost={data?.ssh_host || ''}
        onClose={() => setShowSSH(false)}
        onSaved={() => { refetch(); setCountdown(30); }}
      />
    )}

    <div className="min-h-screen bg-slate-50 flex flex-col">

      {/* ── HEADER ── */}
      <div className="bg-gradient-to-r from-slate-800 to-slate-900 text-white px-6 py-4">
        <div className="flex flex-col sm:flex-row sm:items-center gap-3 justify-between">
          <div className="flex items-center gap-3">
            <Link
              to={`/mysql-dashboard/${id}`}
              className="p-1.5 rounded-lg bg-white/10 hover:bg-white/20 transition-colors"
            >
              <ArrowLeft size={16} />
            </Link>
            <div>
              <h1 className="text-xl font-black tracking-tight flex items-center gap-2">
                <TrendingDown size={20} className="text-amber-400" />
                Slow Query Analyzer
              </h1>
              <p className="text-slate-400 text-xs mt-0.5">
                {allQueries.length} queries · {data?.source || 'performance_schema'} · auto-refresh in {countdown}s
              </p>
            </div>
          </div>

          <button
            onClick={() => { refetch(); setCountdown(30); }}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-white/10 hover:bg-white/20 text-white text-sm font-bold transition-colors"
          >
            <RefreshCw size={14} /> Refresh
          </button>
        </div>

        {/* Source banners */}
        <div className="mt-3">
          <SourceBanner data={data} />
        </div>
      </div>

      {/* ── KPI STRIP ── */}
      <div className="px-6 py-4">
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <KpiCard icon={Layers}      label="Total Queries"     value={fmtNum(kpis.total || 0)}         accent="blue" />
          <KpiCard icon={Clock}       label="Avg Exec Time"     value={fmtSec(kpis.avgAvg)}              accent={kpis.avgAvg >= 1 ? 'red' : kpis.avgAvg >= 0.1 ? 'amber' : 'green'} />
          <KpiCard icon={Activity}    label="Max Exec Time"     value={fmtSec(kpis.maxMax)}              accent="orange" />
          <KpiCard icon={Shield}      label="No-Index Queries"  value={fmtNum(kpis.noIdx || 0)}         accent={kpis.noIdx > 0 ? 'red' : 'green'}
                                      sub={kpis.total ? `${Math.round((kpis.noIdx / kpis.total) * 100)}% of total` : ''} />
          <KpiCard icon={Cpu}         label="Total CPU Time"    value={fmtSec(kpis.totalCpu)}            accent="purple" />
          <KpiCard icon={Target}      label="Filtered"          value={fmtNum(filtered.length)}          accent="blue"
                                      sub={`of ${allQueries.length} total`} />
        </div>
      </div>

      {/* ── TABS ── */}
      <div className="px-6">
        <div className="flex gap-1 border-b border-slate-200">
          {TABS.map(({ id: tid, label, icon: Icon }) => (
            <button
              key={tid}
              onClick={() => setActiveTab(tid)}
              className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-bold transition-colors border-b-2 -mb-px ${
                activeTab === tid
                  ? 'text-slate-800 border-slate-800 bg-white rounded-t-xl'
                  : 'text-slate-500 border-transparent hover:text-slate-700'
              }`}
            >
              <Icon size={14} />{label}
              {tid === 'ai' && <span className="px-1.5 py-0.5 rounded text-[9px] bg-purple-100 text-purple-700 font-black">AI</span>}
            </button>
          ))}
        </div>
      </div>

      {/* ── TAB CONTENT ── */}
      <div className="flex-1 px-6 py-5 space-y-5">

        {/* ════ OVERVIEW ════ */}
        {activeTab === 'overview' && (
          <div className="space-y-5">

            {/* Charts row */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">

              {/* Top slowest bar chart */}
              <div className="lg:col-span-2 bg-white rounded-2xl border border-slate-200 p-5">
                <p className="text-sm font-bold text-slate-700 mb-4">Top 12 Slowest Queries (avg ms)</p>
                {topChartData.length > 0 ? (
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart data={topChartData} layout="vertical" barSize={12}>
                      <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#f1f5f9" />
                      <XAxis type="number" tick={{ fontSize: 10 }} tickFormatter={v => v + 'ms'} />
                      <YAxis type="category" dataKey="name" tick={{ fontSize: 10 }} width={30} />
                      <Tooltip
                        contentStyle={{ fontSize: 11, borderRadius: 8 }}
                        formatter={(val, name) => [val + 'ms', name === 'avg' ? 'Avg Time' : 'Max Time']}
                        labelFormatter={(label, payload) => payload?.[0]?.payload?.full || label}
                      />
                      <Bar dataKey="avg" fill="#f59e0b" name="avg" radius={[0, 4, 4, 0]} />
                      <Bar dataKey="max" fill="#ef444480" name="max" radius={[0, 4, 4, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="flex items-center justify-center h-40 text-slate-400 text-sm">No data</div>
                )}
              </div>

              {/* DB distribution pie */}
              <div className="bg-white rounded-2xl border border-slate-200 p-5">
                <p className="text-sm font-bold text-slate-700 mb-4">By Database</p>
                {dbChartData.length > 0 ? (
                  <ResponsiveContainer width="100%" height={220}>
                    <PieChart>
                      <Pie data={dbChartData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={75} label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`} labelLine={false}>
                        {dbChartData.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                      </Pie>
                      <Tooltip contentStyle={{ fontSize: 11, borderRadius: 8 }} />
                    </PieChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="flex items-center justify-center h-40 text-slate-400 text-sm">No data</div>
                )}
              </div>
            </div>

            {/* Hot spots: top 5 by different metrics */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
              {[
                { title: 'Slowest (avg)', key: 'avg_exec_sec', fmt: fmtSec, icon: Clock, accent: 'text-red-600' },
                { title: 'Most Calls',   key: 'count_calls',  fmt: fmtNum, icon: Activity, accent: 'text-blue-600' },
                { title: 'Most Rows Examined', key: 'rows_examined', fmt: fmtNum, icon: HardDrive, accent: 'text-orange-600' },
              ].map(({ title, key, fmt, icon: Icon, accent }) => {
                const top5 = allQueries.slice().sort((a, b) => Number(b[key]) - Number(a[key])).slice(0, 5);
                return (
                  <div key={key} className="bg-white rounded-2xl border border-slate-200 p-4">
                    <div className="flex items-center gap-2 mb-3">
                      <Icon size={14} className={accent} />
                      <p className="text-xs font-bold text-slate-600">{title}</p>
                    </div>
                    <div className="space-y-2">
                      {top5.map((q, i) => (
                        <div key={i} className="flex items-center gap-2">
                          <span className="text-[10px] w-4 text-slate-400 font-bold">#{i + 1}</span>
                          <span className="flex-1 text-[10px] font-mono text-slate-600 truncate" title={q.sql_text}>
                            {truncSql(q.sql_text, 50)}
                          </span>
                          <span className={`text-xs font-black ${accent}`}>{fmt(q[key])}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Source detail panel */}
            <div className="bg-white rounded-2xl border border-slate-200 p-5">
              <div className="flex items-center justify-between mb-4">
                <p className="text-sm font-bold text-slate-700">Data Source Configuration</p>
                {/* SSH config button */}
                {data?.agent_connected && !data?.ssh_configured ? (
                  <span className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold bg-sky-100 text-sky-700 border border-sky-300">
                    <Terminal size={12} /> Connected via Agent — SSH not required
                  </span>
                ) : (
                  <button
                    onClick={() => setShowSSH(true)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold transition-all ${
                      data?.ssh_configured
                        ? 'bg-green-100 text-green-700 border border-green-300 hover:bg-green-200'
                        : 'bg-slate-800 text-white hover:bg-slate-700'
                    }`}
                  >
                    <Terminal size={12} />
                    {data?.ssh_configured ? `SSH: ${data.ssh_user}@${data.ssh_host}` : 'Configure SSH'}
                  </button>
                )}
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 text-sm">
                <div className="space-y-2">
                  <p className="text-xs font-bold text-slate-500 uppercase">Performance Schema</p>
                  {[
                    ['Enabled',           data?.perf_schema_enabled ? '✓ YES' : '✗ NO'],
                    ['Queries collected', (data?.perf_schema_queries || []).length],
                    ['Error',             data?.perf_schema_error || 'None'],
                    ['Consumers auto-enabled', data?.consumers_auto_enabled ? 'YES' : 'NO'],
                  ].map(([l, v]) => (
                    <div key={l} className="flex justify-between gap-2 py-1.5 border-b border-slate-50">
                      <span className="text-slate-500">{l}</span>
                      <span className="font-mono text-xs text-slate-700 font-semibold text-right max-w-[200px] truncate">{String(v)}</span>
                    </div>
                  ))}
                </div>
                <div className="space-y-2">
                  <p className="text-xs font-bold text-slate-500 uppercase">Slow Query Log</p>
                  {[
                    ['Log enabled',     data?.slow_log_config?.enabled ? 'ON' : 'OFF'],
                    ['Log file path',   data?.slow_log_config?.log_file || '—'],
                    ['long_query_time', (data?.slow_log_config?.long_query_time ?? '—') + 's'],
                    ['File queries',    (data?.file_queries || []).length],
                    ['SSH configured',  data?.ssh_configured ? `✓ ${data.ssh_user}@${data.ssh_host}` : (data?.agent_connected ? '— Via agent (not needed)' : '✗ Not configured')],
                    ['File error',      data?.file_error || 'None'],
                  ].map(([l, v]) => (
                    <div key={l} className="flex justify-between gap-2 py-1.5 border-b border-slate-50">
                      <span className="text-slate-500">{l}</span>
                      <span className={`font-mono text-xs font-semibold text-right max-w-[230px] truncate ${
                        l === 'SSH configured' ? (data?.ssh_configured ? 'text-green-600' : (data?.agent_connected ? 'text-sky-600' : 'text-orange-500')) : 'text-slate-700'
                      }`}>{String(v)}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* SSH not configured warning (irrelevant for agent-connected DBs —
                  the agent already delivers query data via performance_schema) */}
              {!data?.ssh_configured && !data?.agent_connected && data?.slow_log_config?.enabled && (
                <div className="mt-4 flex items-start gap-3 p-3 rounded-xl bg-amber-50 border border-amber-200">
                  <Terminal size={14} className="text-amber-600 flex-shrink-0 mt-0.5" />
                  <div className="flex-1 text-xs text-amber-700">
                    <p className="font-bold">SSH not configured</p>
                    <p className="mt-0.5">The slow log file is on a remote server. Configure SSH credentials so ACTMON can read it directly.</p>
                  </div>
                  <button onClick={() => setShowSSH(true)} className="px-3 py-1.5 rounded-lg bg-amber-600 text-white text-xs font-bold hover:bg-amber-700 flex-shrink-0">
                    Configure
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ════ EXPLORER ════ */}
        {activeTab === 'explorer' && (
          <div className="space-y-4">

            {/* Filter bar */}
            <div className="bg-white rounded-2xl border border-slate-200 p-4 space-y-3">
              <div className="flex flex-col sm:flex-row gap-3">
                {/* Search */}
                <div className="relative flex-1">
                  <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input
                    type="text" value={search} onChange={e => setSearch(e.target.value)}
                    placeholder="Search SQL text, table name, keyword…"
                    className="w-full pl-9 pr-4 py-2 text-sm border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-400 bg-slate-50"
                  />
                </div>

                {/* DB filter */}
                <select
                  value={dbFilter} onChange={e => setDbFilter(e.target.value)}
                  className="text-sm border border-slate-200 rounded-xl px-3 py-2 bg-slate-50 focus:outline-none focus:ring-2 focus:ring-blue-400 font-medium text-slate-600"
                >
                  {dbNames.map(d => <option key={d} value={d}>{d === 'all' ? 'All Databases' : d}</option>)}
                </select>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                {/* Min time */}
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-500 font-semibold">Min avg time:</span>
                  {[0, 0.1, 0.5, 1, 5].map(v => (
                    <button
                      key={v} onClick={() => setMinTime(v)}
                      className={`px-2.5 py-1 rounded-full text-xs font-bold transition-all ${minTime === v ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}
                    >{v === 0 ? 'All' : `>${v}s`}</button>
                  ))}
                </div>

                <div className="w-px h-4 bg-slate-200" />

                {/* No-index filter */}
                <label className="flex items-center gap-2 cursor-pointer">
                  <div
                    onClick={() => setNoIndex(n => !n)}
                    className={`w-9 h-5 rounded-full transition-all relative ${noIndexOnly ? 'bg-red-500' : 'bg-slate-200'}`}
                  >
                    <div className={`w-4 h-4 rounded-full bg-white shadow absolute top-0.5 transition-all ${noIndexOnly ? 'left-4' : 'left-0.5'}`} />
                  </div>
                  <span className="text-xs font-semibold text-slate-600">No-Index Only</span>
                </label>

                {/* Sort */}
                <div className="ml-auto flex items-center gap-2">
                  <span className="text-xs text-slate-500 font-semibold">Sort:</span>
                  {[
                    { key: 'avg_exec_sec', label: 'Avg Time' },
                    { key: 'max_exec_sec', label: 'Max Time' },
                    { key: 'count_calls',  label: 'Calls' },
                    { key: 'rows_examined', label: 'Rows' },
                  ].map(({ key: k, label }) => (
                    <button
                      key={k} onClick={() => handleSort(k)}
                      className={`px-2.5 py-1 rounded-full text-xs font-bold transition-all flex items-center gap-1 ${sortKey === k ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}
                    >{label}<SortIcon col={k} /></button>
                  ))}
                </div>

                <span className="text-xs text-slate-400">{filtered.length} / {allQueries.length}</span>
              </div>
            </div>

            {/* Query table */}
            <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 border-b border-slate-200">
                    <tr>
                      <th className="w-8 px-4 py-3" />
                      <th className="px-2 py-3 text-left font-bold text-slate-400 w-10">#</th>
                      <th className="px-3 py-3 text-left font-bold text-slate-500">Query / Database</th>
                      <th
                        className="px-3 py-3 text-right font-bold text-slate-500 cursor-pointer hover:text-slate-700"
                        onClick={() => handleSort('avg_exec_sec')}
                      >Avg Time <SortIcon col="avg_exec_sec" /></th>
                      <th
                        className="px-3 py-3 text-right font-bold text-slate-500 cursor-pointer hover:text-slate-700"
                        onClick={() => handleSort('max_exec_sec')}
                      >Max <SortIcon col="max_exec_sec" /></th>
                      <th
                        className="px-3 py-3 text-right font-bold text-slate-500 cursor-pointer hover:text-slate-700"
                        onClick={() => handleSort('count_calls')}
                      >Calls <SortIcon col="count_calls" /></th>
                      <th
                        className="px-3 py-3 text-right font-bold text-slate-500 cursor-pointer hover:text-slate-700"
                        onClick={() => handleSort('rows_examined')}
                      >Rows Exam. <SortIcon col="rows_examined" /></th>
                      <th className="px-3 py-3 text-right font-bold text-slate-500">Rows Ret.</th>
                      <th className="px-3 py-3 text-center font-bold text-slate-500">No-Idx</th>
                      <th className="px-3 py-3 text-right font-bold text-slate-500">Last Seen</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.length === 0 ? (
                      <tr>
                        <td colSpan={10} className="py-16 text-center">
                          <div className="flex flex-col items-center gap-3 text-slate-400">
                            <Search size={32} className="text-slate-200" />
                            <p className="font-semibold">No queries match your filters</p>
                          </div>
                        </td>
                      </tr>
                    ) : (
                      filtered.map((q, i) => (
                        <QueryRow key={`${q.sql_text?.slice(0, 40)}-${i}`} q={q} idx={i} connId={id} />
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* ════ AI ANALYSIS ════ */}
        {activeTab === 'ai' && (
          <div className="space-y-5">
            <div className="bg-white rounded-2xl border border-slate-200 p-5">
              <div className="flex items-start gap-4">
                <div className="w-12 h-12 rounded-2xl bg-purple-100 flex items-center justify-center flex-shrink-0">
                  <Brain size={24} className="text-purple-600" />
                </div>
                <div>
                  <h2 className="font-black text-slate-800 text-lg">ActMon AI Query Intelligence</h2>
                  <p className="text-sm text-slate-500 mt-1">
                    Select any query from the <strong>Query Explorer</strong> tab, click the <strong>EXPLAIN</strong> inner tab, then press <strong>"Analyze with AI"</strong>.
                    The AI uses <code className="text-xs bg-slate-100 px-1 rounded">ActMon AI Engine</code> to provide root cause analysis, index recommendations, query rewrites and optimized SQL.
                  </p>
                </div>
              </div>
            </div>

            {/* Quick pick: top 5 worst queries to analyze */}
            <div className="bg-white rounded-2xl border border-slate-200 p-5">
              <p className="text-sm font-bold text-slate-700 mb-4 flex items-center gap-2">
                <Star size={14} className="text-amber-500" /> Quick Pick — Top 5 Worst Queries
              </p>
              <div className="space-y-2">
                {allQueries.slice().sort((a, b) => Number(b.avg_exec_sec) - Number(a.avg_exec_sec)).slice(0, 5).map((q, i) => (
                  <div
                    key={i}
                    className={`flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition-all hover:border-purple-300 hover:bg-purple-50 ${aiQuery === q ? 'border-purple-400 bg-purple-50' : 'border-slate-200'}`}
                    onClick={() => setAiQuery(q)}
                  >
                    <span className="text-xs font-black text-slate-400 w-5">#{i + 1}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-mono text-slate-700 truncate">{truncSql(q.sql_text, 80)}</p>
                      <p className="text-[10px] text-slate-400 mt-0.5">{q.db_name} · avg {fmtSec(q.avg_exec_sec)} · {fmtNum(q.count_calls)} calls</p>
                    </div>
                    {q.no_index_count > 0 && (
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-red-100 text-red-700 flex-shrink-0">NO INDEX</span>
                    )}
                    <Brain size={14} className="text-purple-400 flex-shrink-0" />
                  </div>
                ))}
              </div>
            </div>

            {/* Inline AI analysis for selected query */}
            {aiQuery && (
              <div className="bg-white rounded-2xl border border-slate-200 p-5">
                <div className="mb-3 p-3 rounded-xl bg-slate-900">
                  <pre className="text-xs font-mono text-emerald-400 whitespace-pre-wrap overflow-x-auto">{aiQuery.sql_text}</pre>
                </div>
                <AIAnalysisPanel connId={id} queryData={aiQuery} explainRows={[]} onClose={() => setAiQuery(null)} />
              </div>
            )}
          </div>
        )}

        {/* ════ REPORTS ════ */}
        {activeTab === 'reports' && (
          <div className="space-y-5">

            <div className="bg-white rounded-2xl border border-slate-200 p-6">
              <div className="flex items-start gap-4 mb-6">
                <div className="w-12 h-12 rounded-2xl bg-blue-100 flex items-center justify-center flex-shrink-0">
                  <FileText size={24} className="text-blue-600" />
                </div>
                <div>
                  <h2 className="font-black text-slate-800 text-lg">Slow Query Reports</h2>
                  <p className="text-sm text-slate-500 mt-1">
                    Download CSV reports filtered by time period. Data is fetched live from performance schema or slow query log file dynamically per server.
                  </p>
                </div>
              </div>

              {/* Period selector */}
              <div className="space-y-4">
                <p className="text-xs font-bold text-slate-600 uppercase tracking-wider">Report Period</p>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {[
                    { key: 'hourly', label: 'Last Hour',  icon: Clock,    desc: 'Queries from the last 60 minutes' },
                    { key: 'daily',  label: 'Last 24h',   icon: BarChart2, desc: 'Queries from the last 24 hours' },
                    { key: 'weekly', label: 'Last 7 Days', icon: BookOpen, desc: 'Queries from the last 7 days' },
                    { key: 'all',    label: 'All Time',   icon: Layers,   desc: 'All queries in performance schema' },
                  ].map(({ key, label, icon: Icon, desc }) => (
                    <button
                      key={key}
                      onClick={() => setExportPeriod(key)}
                      className={`flex flex-col items-start p-4 rounded-xl border-2 text-left transition-all ${
                        exportPeriod === key
                          ? 'border-blue-500 bg-blue-50'
                          : 'border-slate-200 bg-slate-50 hover:border-slate-300'
                      }`}
                    >
                      <Icon size={18} className={exportPeriod === key ? 'text-blue-600' : 'text-slate-400'} />
                      <p className={`font-bold text-sm mt-2 ${exportPeriod === key ? 'text-blue-700' : 'text-slate-700'}`}>{label}</p>
                      <p className="text-[10px] text-slate-500 mt-0.5">{desc}</p>
                    </button>
                  ))}
                </div>

                {/* Report includes */}
                <div className="rounded-xl bg-slate-50 border border-slate-200 p-4">
                  <p className="text-xs font-bold text-slate-600 mb-3">Report Includes</p>
                  <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                    {['db_name', 'sql_text', 'count_calls', 'avg_exec_sec', 'max_exec_sec', 'total_exec_sec', 'rows_examined', 'rows_returned', 'no_index_count', 'last_seen'].map(col => (
                      <div key={col} className="flex items-center gap-1.5 text-[10px] text-slate-600">
                        <CheckCircle2 size={11} className="text-green-500 flex-shrink-0" />
                        <span className="font-mono">{col}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Download button */}
                <button
                  onClick={handleExport}
                  disabled={exportLoading}
                  className="flex items-center gap-2 px-6 py-3 rounded-xl bg-blue-600 text-white font-bold hover:bg-blue-700 transition-colors disabled:opacity-60 disabled:cursor-not-allowed text-sm"
                >
                  {exportLoading
                    ? <><Loader2 size={16} className="animate-spin" /> Generating…</>
                    : <><Download size={16} /> Download {exportPeriod.charAt(0).toUpperCase() + exportPeriod.slice(1)} Report (CSV)</>
                  }
                </button>
              </div>
            </div>

            {/* Preview table */}
            <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
              <div className="px-5 py-3 border-b border-slate-200 flex items-center justify-between">
                <p className="text-sm font-bold text-slate-700">Preview — Top 20 Slowest</p>
                <span className="text-xs text-slate-400">{filtered.length} total in current view</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 border-b border-slate-200">
                    <tr>
                      {['#','Database','SQL (truncated)','Avg Time','Max Time','Calls','Rows Exam.','Last Seen'].map(h => (
                        <th key={h} className="px-4 py-2.5 text-left font-bold text-slate-500 whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {allQueries.slice().sort((a, b) => Number(b.avg_exec_sec) - Number(a.avg_exec_sec)).slice(0, 20).map((q, i) => (
                      <tr key={i} className="border-t border-slate-100 hover:bg-slate-50">
                        <td className="px-4 py-2.5 font-bold text-slate-400">#{i + 1}</td>
                        <td className="px-4 py-2.5 font-mono text-slate-600">{q.db_name || '—'}</td>
                        <td className="px-4 py-2.5 font-mono text-slate-700 max-w-xs truncate" title={q.sql_text}>{truncSql(q.sql_text, 70)}</td>
                        <td className="px-4 py-2.5 font-bold text-red-600">{fmtSec(q.avg_exec_sec)}</td>
                        <td className="px-4 py-2.5 text-orange-600 font-semibold">{fmtSec(q.max_exec_sec)}</td>
                        <td className="px-4 py-2.5 text-slate-700 font-bold">{fmtNum(q.count_calls)}</td>
                        <td className="px-4 py-2.5 text-slate-600">{fmtNum(q.rows_examined)}</td>
                        <td className="px-4 py-2.5 text-slate-400 whitespace-nowrap">{q.last_seen || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

          </div>
        )}

      </div>
    </div>
    </>
  );
}
