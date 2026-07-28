import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useQueries, useMutation } from '@tanstack/react-query';
import {
  ChevronRight, ChevronLeft, Database, Clock, Zap, RefreshCw,
  AlertTriangle, X, Copy, FileJson, CheckCircle2, Settings2,
  Activity, Hash, XCircle, Boxes, ListTree, Sparkles, Search, Download,
  Layers, HardDrive, Fingerprint, Maximize2,
} from 'lucide-react';
import {
  ResponsiveContainer, PieChart, Pie, Cell, Tooltip,
} from 'recharts';

import { getConnectionDetails } from '../../api/connections';
import { cosmosApi } from '../../api/cosmosdb';
import { TechLogo } from '../agents/setup/logos';
import { DashboardScopeProvider } from '../../context/DashboardAppearanceContext';
import Gauge from '../../components/gauges/Gauge';
import TrendChart from '../../components/gauges/TrendChart';

const CHART_COLORS = ['#2563eb', '#0d9488', '#7c3aed', '#f59e0b', '#db2777', '#0891b2', '#dc2626', '#65a30d', '#6b7280'];
const CHART_TOOLTIP_STYLE = { background: '#ffffff', border: '1px solid #e5e7eb', borderRadius: 8 };
const CROSS_PARTITION_OPS = new Set(['browse_items', 'document_stats', 'document_count', 'custom_query']);

const TABS = [
  { id: 'overview', label: 'Overview', icon: Layers },
  { id: 'databases', label: 'Databases', icon: Database },
  { id: 'containers', label: 'Containers', icon: Boxes },
  { id: 'documents', label: 'Documents', icon: FileJson },
  { id: 'indexing', label: 'Indexing Policy', icon: ListTree },
  { id: 'slow-queries', label: 'Slow Queries', icon: Clock },
  { id: 'error-logs', label: 'Error Logs', icon: AlertTriangle },
  { id: 'ai', label: 'Actmon AI', icon: Sparkles },
];

// ─────────────────────────── shared helpers ───────────────────────────

function fmtBytes(n) {
  if (n == null) return null;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
}
// Backend timestamps are naive UTC (Python datetime.utcnow().isoformat(), no
// offset) — append 'Z' so the browser parses them as UTC instead of local
// time, then always render in Indian Standard Time regardless of the
// viewer's own timezone (matches the convention already used in reportKit.jsx).
function ensureUtcSuffix(iso) {
  if (!iso) return iso;
  return /[zZ]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`;
}
function fmtTime(iso) {
  try { return new Date(ensureUtcSuffix(iso)).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }); }
  catch { return iso; }
}
function fmtDateTime(iso) {
  if (!iso) return null;
  try { return new Date(ensureUtcSuffix(iso)).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'medium' }); }
  catch { return iso; }
}
function fmtEpochSec(ts) {
  if (ts == null) return null;
  try { return new Date(ts * 1000).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'medium' }); } catch { return null; }
}
function parseDbContainer(detail) {
  if (!detail) return { database: null, container: null };
  const parts = detail.split('/');
  return { database: parts[0] || null, container: parts[1] || null };
}
function toCSV(rows) {
  if (!rows.length) return '';
  const keys = Array.from(new Set(rows.flatMap((r) => Object.keys(r))));
  const esc = (v) => {
    if (v == null) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return `"${s.replace(/"/g, '""')}"`;
  };
  return [keys.join(','), ...rows.map((r) => keys.map((k) => esc(r[k])).join(','))].join('\n');
}
function downloadBlob(content, filename, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function DonutChart({ data }) {
  if (!data?.length) return <p className="text-sm text-slate-400 py-8 text-center">No data yet</p>;
  return (
    <>
      <div style={{ height: 200 }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={data} cx="50%" cy="50%" innerRadius={58} outerRadius={85} paddingAngle={3} dataKey="value">
              {data.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
            </Pie>
            <Tooltip contentStyle={CHART_TOOLTIP_STYLE} itemStyle={{ color: '#374151', fontSize: 12 }} />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <div className="flex flex-wrap justify-center gap-x-4 gap-y-1.5 mt-3">
        {data.map((entry, i) => (
          <span key={entry.name} className="inline-flex items-center gap-1.5 text-[11px] text-gray-600">
            <span className="h-2 w-2 rounded-full shrink-0" style={{ background: CHART_COLORS[i % CHART_COLORS.length] }} />
            {entry.name}
            <span className="text-gray-400 font-semibold">{entry.value.toLocaleString()}</span>
          </span>
        ))}
      </div>
    </>
  );
}

function Panel({ title, accent = 'sky', children, right }) {
  const border = {
    sky: 'border-l-sky-500', slate: 'border-l-slate-400',
    green: 'border-l-emerald-500', amber: 'border-l-amber-500', red: 'border-l-red-500', violet: 'border-l-violet-500',
  }[accent] || 'border-l-sky-500';
  return (
    <div className={`bg-white rounded-2xl border border-slate-200 shadow-sm border-l-4 ${border} overflow-hidden`}>
      <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-100">
        <h3 className="text-[13px] font-black text-slate-700 uppercase tracking-wide">{title}</h3>
        {right}
      </div>
      <div className="p-5">{children}</div>
    </div>
  );
}

function MetaTile({ icon: Icon, label, value, sub }) {
  return (
    <div className="bg-slate-50 rounded-xl border border-slate-100 p-3.5">
      <div className="flex items-center gap-1.5 text-[10px] font-black text-slate-400 uppercase tracking-wider mb-1.5">
        <Icon size={12} /> {label}
      </div>
      <div className="text-lg font-black text-slate-800 font-mono tabular-nums truncate">{value ?? '—'}</div>
      {sub && <p className="text-[10.5px] text-slate-400 mt-0.5">{sub}</p>}
    </div>
  );
}

function NotAvailable({ icon: Icon = AlertTriangle, label }) {
  return (
    <div className="bg-slate-50 rounded-xl border border-dashed border-slate-200 p-3.5">
      <div className="flex items-center gap-1.5 text-[10px] font-black text-slate-400 uppercase tracking-wider mb-1.5">
        <Icon size={12} /> {label}
      </div>
      <div className="text-[12.5px] text-slate-400 italic leading-snug">Not Available with Current Credentials</div>
    </div>
  );
}

function JsonDrawer({ item, onClose }) {
  if (!item) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-end">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative z-10 w-full max-w-xl h-full bg-white shadow-2xl flex flex-col">
        <div className="flex items-center justify-between p-5 border-b border-slate-200 bg-gradient-to-r from-slate-900 to-slate-800">
          <h2 className="text-white font-black text-lg flex items-center gap-2"><FileJson size={18} /> {item.title}</h2>
          <button onClick={onClose} className="text-white/60 hover:text-white text-xl font-bold"><X size={20} /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">
          <div className="flex justify-end mb-2">
            <button onClick={() => navigator.clipboard.writeText(JSON.stringify(item.json, null, 2))}
              className="flex items-center gap-1 px-2 py-1 bg-slate-800 text-white rounded text-[10px] hover:bg-slate-700">
              <Copy size={9} /> Copy
            </button>
          </div>
          <pre className="bg-slate-900 rounded-xl p-4 font-mono text-[11px] text-sky-300 whitespace-pre-wrap break-all max-h-[75vh] overflow-y-auto">
            {JSON.stringify(item.json, null, 2)}
          </pre>
        </div>
      </div>
    </div>
  );
}

function AIReportModal({ report, target, onClose }) {
  if (!report) return null;
  const available = report.available;
  const r = report.data || {};
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 md:p-8">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative z-10 w-full max-w-3xl max-h-full bg-white rounded-2xl shadow-2xl flex flex-col overflow-hidden">
        <div className="flex items-center justify-between p-5 border-b border-slate-200 bg-gradient-to-r from-violet-800 to-violet-600 flex-shrink-0">
          <h2 className="text-white font-black text-lg flex items-center gap-2"><Sparkles size={18} /> Actmon AI Report{target ? ` — ${target}` : ''}</h2>
          <button onClick={onClose} className="text-white/70 hover:text-white"><X size={22} /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {!available ? (
            <div className="flex items-center gap-3 py-10 justify-center text-center">
              <AlertTriangle size={20} className="text-amber-400 flex-shrink-0" />
              <p className="text-sm text-slate-500">{report.reason || 'Actmon AI is not available right now.'}</p>
            </div>
          ) : (
            <>
              {r.checks_performed?.length > 0 && (
                <section>
                  <h3 className="text-[12px] font-black text-slate-400 uppercase tracking-wide mb-2">What We Checked</h3>
                  <ul className="space-y-1.5">
                    {r.checks_performed.map((p, i) => (
                      <li key={i} className="flex items-start gap-2 text-sm text-slate-600"><CheckCircle2 size={14} className="text-slate-400 mt-0.5 flex-shrink-0" /> {p}</li>
                    ))}
                  </ul>
                </section>
              )}

              {r.health_score != null && (
                <section className="flex justify-center">
                  <div className="max-w-xs w-full">
                    <Gauge icon={Sparkles} label="Health Score" pct={r.health_score ?? 0} sub="Actmon AI composite score"
                      colorFn={(v) => (v >= 80 ? '#22c55e' : v >= 60 ? '#f59e0b' : '#ef4444')} />
                  </div>
                </section>
              )}

              {r.problems_detected?.length > 0 && (
                <section>
                  <h3 className="text-[12px] font-black text-amber-500 uppercase tracking-wide mb-2">Problems Detected</h3>
                  <ul className="space-y-2">
                    {r.problems_detected.map((p, i) => (
                      <li key={i} className="flex items-start gap-2 text-sm text-slate-700"><AlertTriangle size={14} className="text-amber-500 mt-0.5 flex-shrink-0" /> {p}</li>
                    ))}
                  </ul>
                </section>
              )}

              {[
                ['Performance Analysis', r.performance_analysis],
                ['Storage Analysis', r.storage_analysis],
                ['Partition Analysis', r.partition_analysis],
                ['Index Analysis', r.index_analysis],
              ].filter(([, v]) => v).map(([title, text]) => (
                <section key={title}>
                  <h3 className="text-[12px] font-black text-slate-400 uppercase tracking-wide mb-2">{title}</h3>
                  <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">{text}</p>
                </section>
              ))}

              {r.cost_optimization_suggestions?.length > 0 && (
                <section>
                  <h3 className="text-[12px] font-black text-emerald-600 uppercase tracking-wide mb-2">Cost Optimization Suggestions</h3>
                  <ul className="space-y-2">
                    {r.cost_optimization_suggestions.map((p, i) => (
                      <li key={i} className="flex items-start gap-2 text-sm text-slate-700"><Zap size={14} className="text-emerald-500 mt-0.5 flex-shrink-0" /> {p}</li>
                    ))}
                  </ul>
                </section>
              )}

              {r.recommended_actions?.length > 0 && (
                <section>
                  <h3 className="text-[12px] font-black text-violet-600 uppercase tracking-wide mb-2">Recommended Actions</h3>
                  <ul className="space-y-2">
                    {r.recommended_actions.map((p, i) => (
                      <li key={i} className="flex items-start gap-2 text-sm text-slate-700"><CheckCircle2 size={14} className="text-violet-500 mt-0.5 flex-shrink-0" /> {p}</li>
                    ))}
                  </ul>
                </section>
              )}

              {r.expected_performance_improvement && (
                <section>
                  <h3 className="text-[12px] font-black text-slate-400 uppercase tracking-wide mb-2">Expected Performance Improvement</h3>
                  <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">{r.expected_performance_improvement}</p>
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function LogAnalysisModal({ row, state, onClose, onRetry }) {
  if (!row) return null;
  const isSlowQuery = row.success;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 md:p-8">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative z-10 w-full max-w-2xl max-h-full bg-white rounded-2xl shadow-2xl flex flex-col overflow-hidden">
        <div className={`flex items-center justify-between p-5 border-b border-slate-200 bg-gradient-to-r ${isSlowQuery ? 'from-amber-700 to-amber-600' : 'from-red-700 to-red-600'} flex-shrink-0`}>
          <h2 className="text-white font-black text-lg flex items-center gap-2">
            <Sparkles size={18} /> Actmon AI — {isSlowQuery ? 'Slow Query Analysis' : 'Error Analysis'}
          </h2>
          <button onClick={onClose} className="text-white/70 hover:text-white"><X size={22} /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          <div className="rounded-xl bg-slate-50 border border-slate-100 p-4 grid grid-cols-2 md:grid-cols-4 gap-3 text-[12px]">
            <div><span className="block text-slate-400 uppercase text-[10px] font-bold mb-0.5">When</span><span className="text-slate-700">{fmtDateTime(row.created_at)}</span></div>
            <div><span className="block text-slate-400 uppercase text-[10px] font-bold mb-0.5">Operation</span><span className="text-slate-700 font-bold">{row.operation}</span></div>
            <div><span className="block text-slate-400 uppercase text-[10px] font-bold mb-0.5">Duration</span><span className="text-slate-700 font-mono">{row.duration_ms} ms</span></div>
            <div><span className="block text-slate-400 uppercase text-[10px] font-bold mb-0.5">Request Charge</span><span className="text-slate-700 font-mono">{row.request_charge != null ? `${row.request_charge} RU` : '—'}</span></div>
            <div className="col-span-2 md:col-span-4"><span className="block text-slate-400 uppercase text-[10px] font-bold mb-0.5">Target</span><span className="text-slate-700 font-mono">{row.detail || '—'}</span></div>
          </div>

          {state?.loading && (
            <div className="flex items-center gap-2 text-slate-400 text-sm py-10 justify-center"><RefreshCw size={16} className="animate-spin" /> Actmon AI is analyzing this {isSlowQuery ? 'query' : 'error'}…</div>
          )}
          {state?.error && (
            <div className="flex items-center gap-3 py-6">
              <AlertTriangle size={18} className="text-red-500 flex-shrink-0" />
              <p className="text-sm text-red-600 flex-1">{state.error}</p>
              <button onClick={onRetry} className="h-8 px-3 rounded-lg border border-slate-300 text-slate-600 text-xs font-bold hover:bg-slate-50 flex-shrink-0">Retry</button>
            </div>
          )}
          {state?.data && !state.data.available && (
            <p className="text-sm text-slate-500 italic py-6">{state.data.reason || 'Actmon AI is not available right now.'}</p>
          )}
          {state?.data?.available && (
            <>
              <section>
                <h3 className="text-[12px] font-black text-slate-400 uppercase tracking-wide mb-2">Summary</h3>
                <p className="text-sm text-slate-700 leading-relaxed">{state.data.data.summary}</p>
              </section>
              <section>
                <h3 className={`text-[12px] font-black uppercase tracking-wide mb-2 ${isSlowQuery ? 'text-amber-600' : 'text-red-600'}`}>Root Cause</h3>
                <p className="text-sm text-slate-700 leading-relaxed">{state.data.data.root_cause}</p>
              </section>
              <section>
                <h3 className="text-[12px] font-black text-emerald-600 uppercase tracking-wide mb-2">Suggested Fix</h3>
                <p className="text-sm text-slate-700 leading-relaxed">{state.data.data.suggested_fix}</p>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────── main component ───────────────────────────

export default function CosmosDBDashboard() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [activeTab, setActiveTab] = useState('overview');
  const [selectedDb, setSelectedDb] = useState(null);
  const [selectedContainer, setSelectedContainer] = useState(null);
  const [viewingItem, setViewingItem] = useState(null);
  const [showAiReport, setShowAiReport] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [testing, setTesting] = useState(false);
  const [errorAnalysis, setErrorAnalysis] = useState({}); // logId -> { loading, data, error }
  const [logAnalysisRow, setLogAnalysisRow] = useState(null); // the log row currently shown in the analysis modal

  // Documents tab
  const [tokenStack, setTokenStack] = useState([]);
  const [currentToken, setCurrentToken] = useState(null);
  const [sortRecent, setSortRecent] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [appliedFilter, setAppliedFilter] = useState('');

  // Slow Queries tab filters
  const [sqContainerFilter, setSqContainerFilter] = useState('');
  const [sqMinRu, setSqMinRu] = useState('');
  const [sqMinMs, setSqMinMs] = useState('');

  const { data: conn } = useQuery({
    queryKey: ['cosmosConnDetail', id],
    queryFn: () => getConnectionDetails('cosmosdb', id),
    retry: false,
  });
  const primaryDb = conn?.data?.database_name || null;
  const primaryContainer = conn?.data?.container_name || null;

  const { data: dbList = [], isLoading: dbsLoading, error: dbsError } = useQuery({
    queryKey: ['cosmosDatabases', id],
    queryFn: () => cosmosApi.listDatabases(id).then((r) => r.data || []),
  });

  useEffect(() => {
    if (!dbList.length) return;
    if (!selectedDb) {
      const preferred = primaryDb && dbList.some((d) => d.id === primaryDb) ? primaryDb : dbList[0].id;
      setSelectedDb(preferred);
    }
  }, [dbList, selectedDb, primaryDb]);

  const { data: containers = [], isLoading: containersLoading, error: containersError } = useQuery({
    queryKey: ['cosmosContainers', id, selectedDb],
    queryFn: () => cosmosApi.listContainers(id, selectedDb).then((r) => r.data || []),
    enabled: !!selectedDb,
  });

  useEffect(() => {
    if (!containers.length) { setSelectedContainer(null); return; }
    if (!selectedContainer || !containers.some((c) => c.id === selectedContainer)) {
      const preferred = primaryContainer && containers.some((c) => c.id === primaryContainer) ? primaryContainer : containers[0].id;
      setSelectedContainer(preferred);
    }
  }, [containers, selectedDb]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setTokenStack([]); setCurrentToken(null); setAppliedFilter(''); setSearchText('');
  }, [selectedDb, selectedContainer, sortRecent]);

  const { data: activity, refetch: refetchActivity } = useQuery({
    queryKey: ['cosmosActivity', id],
    queryFn: () => cosmosApi.activity(id, 200),
    refetchInterval: 30000,
  });

  const { data: primaryDetails, isError: primaryDetailsIsError, error: primaryDetailsError, refetch: refetchPrimaryDetails, dataUpdatedAt: primaryDetailsAt } = useQuery({
    queryKey: ['cosmosContainerDetails', id, primaryDb, primaryContainer],
    queryFn: () => cosmosApi.containerDetails(id, primaryDb, primaryContainer),
    enabled: !!primaryDb && !!primaryContainer,
  });
  const { data: primaryDocStats, isError: primaryDocStatsIsError, error: primaryDocStatsError, refetch: refetchPrimaryDocStats } = useQuery({
    queryKey: ['cosmosDocStats', id, primaryDb, primaryContainer],
    queryFn: () => cosmosApi.documentStats(id, primaryDb, primaryContainer),
    enabled: !!primaryDb && !!primaryContainer,
  });

  // Guards against a real race: when selectedDb changes, selectedContainer
  // still holds the PREVIOUS database's container id for one render before
  // the corrective effect below runs — firing a request with that stale,
  // now-invalid (new database, old container) pair. Requiring the container
  // to actually be present in the freshly-loaded `containers` list for the
  // current selectedDb closes that window regardless of effect timing.
  const containerIsValid = !!selectedContainer && containers.some((c) => c.id === selectedContainer);

  const { data: selectedDetails, isLoading: selectedDetailsLoading, error: selectedDetailsError, refetch: refetchSelectedDetails } = useQuery({
    queryKey: ['cosmosContainerDetails', id, selectedDb, selectedContainer],
    queryFn: () => cosmosApi.containerDetails(id, selectedDb, selectedContainer),
    enabled: !!selectedDb && containerIsValid,
  });
  const { data: selectedDocStats } = useQuery({
    queryKey: ['cosmosDocStats', id, selectedDb, selectedContainer],
    queryFn: () => cosmosApi.documentStats(id, selectedDb, selectedContainer),
    enabled: !!selectedDb && containerIsValid,
  });

  const { data: itemsResp, isLoading: itemsLoading, error: itemsError, refetch: refetchItems } = useQuery({
    queryKey: ['cosmosItems', id, selectedDb, selectedContainer, currentToken, sortRecent, appliedFilter],
    queryFn: () => cosmosApi.browseItems(id, selectedDb, selectedContainer, {
      limit: 25, continuation_token: currentToken, sort_recent: sortRecent,
      filter_query: appliedFilter ? `SELECT * FROM c WHERE ${appliedFilter}` : undefined,
    }),
    enabled: activeTab === 'documents' && !!selectedDb && containerIsValid,
    keepPreviousData: true,
  });
  const items = itemsResp?.data || [];
  const nextToken = itemsResp?.continuation_token || null;

  const goNextPage = () => {
    if (!nextToken) return;
    setTokenStack((s) => [...s, currentToken]);
    setCurrentToken(nextToken);
  };
  const goPrevPage = () => {
    setTokenStack((s) => {
      if (!s.length) return s;
      const copy = [...s];
      const prev = copy.pop();
      setCurrentToken(prev || null);
      return copy;
    });
  };

  const dbSummaryQueries = useQueries({
    queries: dbList.map((d) => ({
      queryKey: ['cosmosDbSummary', id, d.id],
      queryFn: () => cosmosApi.databaseSummary(id, d.id).then((r) => r.data),
      enabled: activeTab === 'databases',
    })),
  });

  const aiMutation = useMutation({
    mutationFn: () => cosmosApi.aiAnalysis(id, selectedDb, selectedContainer),
  });

  const handleAnalyzeError = async (logId) => {
    setErrorAnalysis((m) => ({ ...m, [logId]: { loading: true } }));
    try {
      const r = await cosmosApi.errorAnalysis(id, logId);
      setErrorAnalysis((m) => ({ ...m, [logId]: { loading: false, data: r } }));
    } catch (e) {
      setErrorAnalysis((m) => ({ ...m, [logId]: { loading: false, error: e?.response?.data?.detail || e.message } }));
    }
  };

  // Opens the analysis modal immediately (showing a spinner) and kicks off the
  // fetch; reopening an already-analyzed row just shows the cached result.
  const openLogAnalysis = (row) => {
    setLogAnalysisRow(row);
    if (!errorAnalysis[row.id]) handleAnalyzeError(row.id);
  };

  const handleTest = async () => {
    setTesting(true); setTestResult(null);
    try {
      const r = await cosmosApi.testSaved(id);
      setTestResult({ ok: true, text: r.message || 'Connection successful' });
    } catch (e) {
      setTestResult({ ok: false, text: e?.response?.data?.detail || e.message || 'Connection failed' });
    } finally {
      setTesting(false);
      refetchActivity();
    }
  };

  const handleExportJson = () => {
    downloadBlob(JSON.stringify(items, null, 2), `${selectedContainer || 'documents'}_page.json`, 'application/json');
  };
  const handleExportCsv = () => {
    downloadBlob(toCSV(items), `${selectedContainer || 'documents'}_page.csv`, 'text/csv');
  };

  const healthBadge = activity
    ? activity.connection_status === 'connected'
      ? { label: activity.failure_count > 0 ? `Connected · ${activity.failure_count} recent error${activity.failure_count === 1 ? '' : 's'}` : 'Connected', tone: activity.failure_count > 0 ? 'warn' : 'good' }
      : activity.connection_status === 'error'
        ? { label: 'Connection Error', tone: 'bad' }
        : { label: 'Unknown', tone: 'neutral' }
    : null;
  const badgeClasses = {
    good: 'bg-emerald-500/20 text-emerald-100 border-emerald-400/30',
    warn: 'bg-amber-500/20 text-amber-100 border-amber-400/30',
    bad: 'bg-red-500/20 text-red-100 border-red-400/30',
    neutral: 'bg-white/10 text-white/70 border-white/15',
  };

  const indexSizeBytes = (primaryDetails?.data?.collection_size_bytes != null && primaryDetails?.data?.data_size_bytes != null)
    ? Math.max(primaryDetails.data.collection_size_bytes - primaryDetails.data.data_size_bytes, 0)
    : null;

  return (
    <DashboardScopeProvider tech="cosmosdb">
    <div className="-mx-6 md:-mx-8 min-h-full bg-[#f1f4f9]">
      <div className="bg-gradient-to-r from-slate-900 via-blue-800 to-sky-700 px-6 pt-3 pb-0 relative overflow-hidden">
        <div className="absolute inset-0 opacity-[0.04]"
          style={{ backgroundImage: 'linear-gradient(#fff 1px,transparent 1px),linear-gradient(90deg,#fff 1px,transparent 1px)', backgroundSize: '28px 28px' }} />
        <div className="relative flex items-center gap-2 text-xs text-slate-300/70 mb-2.5">
          <button onClick={() => navigate('/databases')} className="hover:text-slate-300">ActMon</button>
          <ChevronRight size={11} />
          <button onClick={() => navigate('/cosmosdb-servers')} className="hover:text-slate-300">Azure Cosmos DB</button>
          <ChevronRight size={11} />
          <span className="text-slate-300 font-semibold">{conn?.data?.connection_name || `Connection #${id}`}</span>
        </div>
        <div className="relative flex flex-col md:flex-row md:items-center justify-between gap-3 pb-4">
          <div className="flex items-center gap-3">
            <button onClick={() => navigate('/cosmosdb-servers')}
              className="w-8 h-8 rounded-lg bg-white/10 hover:bg-white/20 border border-white/10 flex items-center justify-center text-white flex-shrink-0">
              <ChevronLeft size={16} />
            </button>
            <TechLogo id="cosmosdb" size={34} />
            <div>
              <h1 className="text-lg font-black text-white tracking-tight leading-none">{conn?.data?.connection_name || 'Azure Cosmos DB'}</h1>
              <p className="text-sky-200/70 text-[11px] mt-0.5 font-mono">{conn?.data?.endpoint}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {healthBadge && (
              <span className={`h-9 px-3.5 rounded-lg border text-xs font-black flex items-center gap-1.5 ${badgeClasses[healthBadge.tone]}`}>
                <span className="w-1.5 h-1.5 rounded-full bg-current" /> {healthBadge.label}
              </span>
            )}
            <button onClick={() => navigate(`/cosmosdb-edit/${id}`)}
              className="h-9 px-4 rounded-lg bg-white/10 hover:bg-white/20 border border-white/15 text-white font-bold text-sm flex items-center gap-2">
              <Settings2 size={14} /> Edit Connection
            </button>
            <button onClick={handleTest} disabled={testing}
              className="h-9 px-4 rounded-lg bg-white/10 hover:bg-white/20 border border-white/15 text-white font-bold text-sm flex items-center gap-2 disabled:opacity-50">
              {testing ? <RefreshCw size={14} className="animate-spin" /> : <CheckCircle2 size={14} />} Test Connection
            </button>
          </div>
        </div>
        {testResult && (
          <div className={`relative mb-3 text-[12px] font-semibold rounded-lg px-3 py-2 inline-flex items-center gap-2 ${testResult.ok ? 'bg-emerald-500/20 text-emerald-100' : 'bg-red-500/20 text-red-100'}`}>
            {testResult.ok ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />} {testResult.text}
          </div>
        )}

        <div className="relative flex items-center gap-1 overflow-x-auto">
          {TABS.map((t) => {
            const Icon = t.icon;
            const active = activeTab === t.id;
            return (
              <button key={t.id} onClick={() => setActiveTab(t.id)}
                className={`h-10 px-4 rounded-t-lg text-sm font-bold flex items-center gap-2 whitespace-nowrap transition-colors ${
                  active ? 'bg-[#f1f4f9] text-blue-700' : 'text-white/60 hover:text-white/90'}`}>
                <Icon size={14} /> {t.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="max-w-screen-2xl mx-auto px-8 py-8 space-y-6">

        {/* ══════════════════ OVERVIEW ══════════════════ */}
        {activeTab === 'overview' && (
          <>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <Panel title="Storage Growth">
                {activity?.storage_growth?.length ? (
                  <TrendChart height={180}
                    data={activity.storage_growth.map((p) => ({ t: fmtTime(p.t), v: +(p.v / (1024 * 1024)).toFixed(2) }))}
                    series={[{ key: 'v', label: 'Storage (MB)', color: '#7c3aed' }]} showLegend={false} yDomain={['auto', 'auto']} />
                ) : <p className="text-sm text-slate-400 py-8 text-center">Not enough samples yet — open this container a few times over time</p>}
              </Panel>
              <Panel title="Document Growth">
                {activity?.document_growth?.length ? (
                  <TrendChart height={180}
                    data={activity.document_growth.map((p) => ({ t: fmtTime(p.t), v: p.v }))}
                    series={[{ key: 'v', label: 'Documents', color: '#0d9488' }]} showLegend={false} yDomain={['auto', 'auto']} />
                ) : <p className="text-sm text-slate-400 py-8 text-center">Not enough samples yet</p>}
              </Panel>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <Panel title="Request Charge Trend">
                {activity?.request_charge_trend?.length ? (
                  <TrendChart height={180}
                    data={activity.request_charge_trend.map((p) => ({ t: fmtTime(p.t), v: p.v }))}
                    series={[{ key: 'v', label: 'RU consumed', color: '#0ea5e9' }]} showLegend={false} yDomain={['auto', 'auto']} />
                ) : <p className="text-sm text-slate-400 py-8 text-center">No data yet</p>}
              </Panel>
              <Panel title="Operations Breakdown (Read-Only)">
                <p className="text-[11px] text-slate-400 mb-2">ActMon only reads from Cosmos DB — it never writes to your data, so every logged call below is a read.</p>
                <DonutChart data={(activity?.operations || []).map((op) => ({ name: op.type, value: op.count }))} />
              </Panel>
            </div>

            <Panel title="Database & Container Overview" accent="violet" right={
              <button onClick={() => refetchPrimaryDetails()} className="text-slate-400 hover:text-slate-700"><RefreshCw size={13} /></button>
            }>
              {!primaryDb || !primaryContainer ? (
                <p className="text-sm text-slate-400 py-4 text-center">No database/container configured on this connection yet.</p>
              ) : primaryDetailsIsError ? (
                <div className="flex items-center gap-3 py-4">
                  <AlertTriangle size={16} className="text-red-500 flex-shrink-0" />
                  <p className="text-sm text-red-600 flex-1">{primaryDetailsError?.response?.data?.detail || primaryDetailsError.message}</p>
                  <button onClick={() => refetchPrimaryDetails()} className="h-8 px-3 rounded-lg border border-slate-300 text-slate-600 text-xs font-bold hover:bg-slate-50 flex-shrink-0">Retry</button>
                </div>
              ) : !primaryDetails ? (
                <div className="flex items-center gap-2 text-slate-400 text-sm py-2"><RefreshCw size={14} className="animate-spin" /> Loading…</div>
              ) : (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <MetaTile icon={Database} label="Database Name" value={primaryDb || '—'} />
                  <MetaTile icon={Boxes} label="Container Name" value={primaryContainer || '—'} />
                  <MetaTile icon={Hash} label="Partition Key" value={(primaryDetails.data.partition_key || []).join(', ') || '—'} />
                  <MetaTile icon={Clock} label="Consistency Level" value={conn?.data?.consistency_level || 'Account default'} />
                  <MetaTile icon={Zap} label="Throughput" value={primaryDetails.data.throughput_ru != null ? `${primaryDetails.data.throughput_ru} RU/s` : 'Serverless'}
                    sub={primaryDetails.data.throughput_ru != null ? (primaryDetails.data.is_autoscale ? 'Autoscale (max)' : 'Manual') : undefined} />
                  <MetaTile icon={HardDrive} label="Container Storage" value={fmtBytes(primaryDetails.data.data_size_bytes) || '—'} />
                  <MetaTile icon={Hash} label="Est. Document Count" value={primaryDetails.data.estimated_document_count?.toLocaleString() ?? '—'} sub="from Cosmos usage header" />
                  {indexSizeBytes != null ? (
                    <MetaTile icon={ListTree} label="Index Size (est.)" value={fmtBytes(indexSizeBytes)} sub="collection size − data size" />
                  ) : <NotAvailable icon={ListTree} label="Index Size" />}
                  <MetaTile icon={Clock} label="Default TTL" value={primaryDetails.data.default_ttl != null ? `${primaryDetails.data.default_ttl}s` : 'Off'} />
                  <MetaTile icon={CheckCircle2} label="Analytical Store" value={primaryDetails.data.analytical_store_enabled ? 'Enabled' : 'Disabled'} />
                  <MetaTile icon={ListTree} label="Indexing Mode" value={primaryDetails.data.indexing_policy?.indexingMode || '—'}
                    sub={primaryDetails.data.indexing_policy?.automatic ? 'Automatic indexing on' : 'Automatic indexing off'} />
                  <MetaTile icon={Boxes} label="Est. Physical Partitions" value={primaryDetails.data.estimated_physical_partitions ?? '—'} sub="estimated, not exact" />
                  <MetaTile icon={RefreshCw} label="Last Refreshed" value={primaryDetailsAt ? fmtTime(new Date(primaryDetailsAt).toISOString()) : '—'} />
                </div>
              )}
            </Panel>

            <Panel title="Document Recency" right={
              <button onClick={() => refetchPrimaryDocStats()} className="text-slate-400 hover:text-slate-700"><RefreshCw size={13} /></button>
            }>
              {primaryDocStatsIsError ? (
                <div className="flex items-center gap-3 py-4">
                  <AlertTriangle size={16} className="text-red-500 flex-shrink-0" />
                  <p className="text-sm text-red-600 flex-1">{primaryDocStatsError?.response?.data?.detail || primaryDocStatsError.message}</p>
                  <button onClick={() => refetchPrimaryDocStats()} className="h-8 px-3 rounded-lg border border-slate-300 text-slate-600 text-xs font-bold hover:bg-slate-50 flex-shrink-0">Retry</button>
                </div>
              ) : !primaryDocStats ? (
                <div className="flex items-center gap-2 text-slate-400 text-sm py-2"><RefreshCw size={14} className="animate-spin" /> Loading…</div>
              ) : (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <MetaTile icon={Clock} label="Latest Document" value={fmtEpochSec(primaryDocStats.data.newest_document?._ts) || '—'} />
                  <MetaTile icon={Clock} label="Oldest Document" value={fmtEpochSec(primaryDocStats.data.oldest_document?._ts) || '—'} />
                  <NotAvailable icon={HardDrive} label="Average Document Size" />
                  <NotAvailable icon={HardDrive} label="Largest Document" />
                </div>
              )}
            </Panel>

            <Panel title="Health & Live Request Charge" accent={activity?.failure_count > 0 ? 'amber' : 'green'} right={
              <button onClick={() => setActiveTab('error-logs')} className="text-[11px] font-bold text-sky-600 hover:text-sky-800">View error logs →</button>
            }>
              {!activity ? (
                <div className="flex items-center gap-2 text-slate-400 text-sm py-2"><RefreshCw size={14} className="animate-spin" /> Loading…</div>
              ) : (
                <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                  <MetaTile icon={Activity} label="Current Health Status" value={healthBadge?.label.split(' · ')[0] || '—'} />
                  <MetaTile icon={Zap} label="Last Request Charge" value={activity.recent?.[0]?.request_charge != null ? `${activity.recent[0].request_charge} RU` : '—'} />
                  <MetaTile icon={Clock} label="Avg Response" value={activity.avg_response_ms != null ? `${activity.avg_response_ms} ms` : '—'} />
                  <MetaTile icon={Hash} label="Queries Logged" value={activity.query_count?.toLocaleString() ?? '—'} />
                  <MetaTile icon={XCircle} label="Errors" value={activity.failure_count?.toLocaleString() ?? '—'} />
                </div>
              )}
            </Panel>

            <Panel title="Partition Distribution" accent="slate">
              <div className="flex flex-col sm:flex-row items-center gap-5 py-2 text-center sm:text-left">
                <div className="w-14 h-14 rounded-2xl bg-slate-50 border border-slate-100 flex items-center justify-center flex-shrink-0">
                  <Boxes size={22} className="text-slate-400" />
                </div>
                <div className="flex-1">
                  <p className="font-black text-slate-700 text-sm">Exact per-partition distribution is Not Available with Current Credentials</p>
                  <p className="text-sm text-slate-400 mt-0.5">
                    Cosmos's public SDK doesn't expose physical partition key ranges without Azure Monitor. Estimated physical partitions
                    (from provisioned RU/s and storage): <b className="text-slate-600 font-mono">{primaryDetails?.data?.estimated_physical_partitions ?? '—'}</b>
                  </p>
                </div>
              </div>
            </Panel>
          </>
        )}

        {/* ══════════════════ DATABASES ══════════════════ */}
        {activeTab === 'databases' && (
          <Panel title="Databases" right={<span className="text-[11px] text-slate-400 font-semibold">{dbList.length} found</span>}>
            {dbsLoading ? (
              <div className="flex items-center gap-2 text-slate-400 text-sm py-2"><RefreshCw size={14} className="animate-spin" /> Loading databases…</div>
            ) : dbsError ? (
              <p className="text-sm text-red-600 flex items-center gap-2"><AlertTriangle size={14} /> {dbsError?.response?.data?.detail || dbsError.message}</p>
            ) : dbList.length === 0 ? (
              <p className="text-sm text-slate-400">No databases found on this account.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50">
                    <tr>
                      <th className="px-3 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase">Database Name</th>
                      <th className="px-3 py-2.5 text-right text-[10px] font-bold text-slate-400 uppercase"># Containers</th>
                      <th className="px-3 py-2.5 text-right text-[10px] font-bold text-slate-400 uppercase">Total Documents</th>
                      <th className="px-3 py-2.5 text-right text-[10px] font-bold text-slate-400 uppercase">Storage Used</th>
                      <th className="px-3 py-2.5 text-right text-[10px] font-bold text-slate-400 uppercase">Throughput</th>
                      <th className="px-3 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase">Status</th>
                      <th className="px-3 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase">Last Activity</th>
                      <th className="px-3 py-2.5 text-right text-[10px] font-bold text-slate-400 uppercase">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dbList.map((d, i) => {
                      const q = dbSummaryQueries[i];
                      const s = q?.data;
                      const lastRow = activity?.recent?.find((r) => parseDbContainer(r.detail).database === d.id || r.detail === d.id);
                      return (
                        <tr key={d.id} className="border-t border-slate-100 hover:bg-sky-50/30">
                          <td className="px-3 py-2.5 font-bold text-slate-700">{d.id}</td>
                          <td className="px-3 py-2.5 text-right font-mono">{q?.isLoading ? <RefreshCw size={12} className="animate-spin inline text-slate-300" /> : (s?.container_count ?? '—')}</td>
                          <td className="px-3 py-2.5 text-right font-mono">{q?.isLoading ? '…' : (s?.total_documents != null ? `${s.total_documents.toLocaleString()}${s.total_documents_partial ? '+' : ''}` : '—')}</td>
                          <td className="px-3 py-2.5 text-right font-mono">{q?.isLoading ? '…' : (fmtBytes(s?.storage_bytes) || '—')}</td>
                          <td className="px-3 py-2.5 text-right font-mono">{q?.isLoading ? '…' : (s?.throughput_ru ? `${s.throughput_ru} RU/s` : '—')}</td>
                          <td className="px-3 py-2.5">
                            {q?.isError ? <span className="text-[10px] font-black text-red-700 bg-red-100 px-2 py-0.5 rounded-full">UNREACHABLE</span>
                              : s ? <span className="text-[10px] font-black text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded-full">REACHABLE</span>
                              : <span className="text-[10px] text-slate-400">—</span>}
                          </td>
                          <td className="px-3 py-2.5 text-[11px] text-slate-500 whitespace-nowrap">{lastRow ? fmtDateTime(lastRow.created_at) : 'No recent activity'}</td>
                          <td className="px-3 py-2.5 text-right">
                            <button onClick={() => { setSelectedDb(d.id); setActiveTab('containers'); }}
                              className="text-[11px] font-bold text-sky-600 hover:text-sky-800">View Containers →</button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        )}

        {/* ══════════════════ CONTAINERS ══════════════════ */}
        {activeTab === 'containers' && (
          <>
            <Panel title="Select Database" right={<span className="text-[11px] text-slate-400 font-semibold">{containers.length} containers</span>}>
              <div className="flex flex-wrap gap-2">
                {dbList.map((d) => (
                  <button key={d.id} onClick={() => setSelectedDb(d.id)}
                    className={`h-9 px-4 rounded-lg text-sm font-bold transition-colors ${selectedDb === d.id ? 'bg-sky-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>
                    {d.id}
                  </button>
                ))}
              </div>
            </Panel>

            <Panel title={`Containers — ${selectedDb || ''}`}>
              {containersLoading ? (
                <div className="flex items-center gap-2 text-slate-400 text-sm py-2"><RefreshCw size={14} className="animate-spin" /> Loading containers…</div>
              ) : containersError ? (
                <p className="text-sm text-red-600 flex items-center gap-2"><AlertTriangle size={14} /> {containersError?.response?.data?.detail || containersError.message}</p>
              ) : containers.length === 0 ? (
                <p className="text-sm text-slate-400">No containers found in this database.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50">
                      <tr>
                        <th className="px-3 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase">Container</th>
                        <th className="px-3 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase">Partition Key</th>
                        <th className="px-3 py-2.5 text-right text-[10px] font-bold text-slate-400 uppercase">Throughput</th>
                        <th className="px-3 py-2.5 text-right text-[10px] font-bold text-slate-400 uppercase">Storage</th>
                        <th className="px-3 py-2.5 text-right text-[10px] font-bold text-slate-400 uppercase">Documents</th>
                        <th className="px-3 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase">Indexing</th>
                        <th className="px-3 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase">TTL</th>
                        <th className="px-3 py-2.5 text-right text-[10px] font-bold text-slate-400 uppercase">Index Size</th>
                        <th className="px-3 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase">Last Checked</th>
                        <th className="px-3 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {containers.map((c) => {
                        const active = selectedContainer === c.id;
                        const d = active ? selectedDetails?.data : null;
                        const idxSize = (d?.collection_size_bytes != null && d?.data_size_bytes != null) ? Math.max(d.collection_size_bytes - d.data_size_bytes, 0) : null;
                        return (
                          <tr key={c.id} onClick={() => setSelectedContainer(c.id)}
                            className={`border-t border-slate-100 cursor-pointer ${active ? 'bg-sky-50/60' : 'hover:bg-slate-50'}`}>
                            <td className="px-3 py-2.5 font-bold text-slate-700 flex items-center gap-1.5"><Boxes size={12} className={active ? 'text-sky-600' : 'text-slate-300'} />{c.id}</td>
                            <td className="px-3 py-2.5 font-mono text-[11px] text-slate-500">{(c.partition_key || []).join(', ') || '—'}</td>
                            <td className="px-3 py-2.5 text-right font-mono">{c.throughput_ru != null ? `${c.throughput_ru} RU/s` : 'Serverless'}</td>
                            <td className="px-3 py-2.5 text-right font-mono">{active ? (selectedDetailsLoading ? '…' : (fmtBytes(d?.data_size_bytes) || '—')) : 'Click to load'}</td>
                            <td className="px-3 py-2.5 text-right font-mono">{active ? (selectedDetailsLoading ? '…' : (d?.estimated_document_count?.toLocaleString() ?? '—')) : 'Click to load'}</td>
                            <td className="px-3 py-2.5 text-[11px]">{c.indexing_policy?.automatic ? 'Automatic' : 'Manual'} · {c.indexing_policy?.indexingMode || '—'}</td>
                            <td className="px-3 py-2.5 text-[11px]">{c.default_ttl != null ? `${c.default_ttl}s` : 'Off'}</td>
                            <td className="px-3 py-2.5 text-right font-mono">{active ? (selectedDetailsLoading ? '…' : (fmtBytes(idxSize) || '—')) : '—'}</td>
                            <td className="px-3 py-2.5 text-[11px] text-slate-500">{active ? (d?.last_refreshed ? fmtDateTime(d.last_refreshed) : '—') : '—'}</td>
                            <td className="px-3 py-2.5">
                              {active
                                ? (selectedDetailsError
                                  ? <span className="text-[10px] font-black text-red-700 bg-red-100 px-2 py-0.5 rounded-full">ERROR</span>
                                  : d ? <span className="text-[10px] font-black text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded-full">REACHABLE</span> : <span className="text-[10px] text-slate-400">…</span>)
                                : <span className="text-[10px] text-slate-300">—</span>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>
          </>
        )}

        {/* ══════════════════ DOCUMENTS ══════════════════ */}
        {activeTab === 'documents' && (
          <>
            <Panel title="Database / Container">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-bold text-slate-500 uppercase mb-1.5">Database</label>
                  <select value={selectedDb || ''} onChange={(e) => setSelectedDb(e.target.value)} className="w-full h-10 rounded-lg border border-slate-300 px-3 text-sm">
                    {dbList.map((d) => <option key={d.id} value={d.id}>{d.id}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-500 uppercase mb-1.5">Container</label>
                  <select value={selectedContainer || ''} onChange={(e) => setSelectedContainer(e.target.value)} className="w-full h-10 rounded-lg border border-slate-300 px-3 text-sm">
                    {containers.map((c) => <option key={c.id} value={c.id}>{c.id}</option>)}
                  </select>
                </div>
              </div>
            </Panel>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <MetaTile icon={Hash} label="Total Documents" value={selectedDetails?.data?.estimated_document_count?.toLocaleString() ?? '—'} />
              <MetaTile icon={Clock} label="Newest Document" value={fmtEpochSec(selectedDocStats?.data?.newest_document?._ts) || '—'} />
              <MetaTile icon={Clock} label="Oldest Document" value={fmtEpochSec(selectedDocStats?.data?.oldest_document?._ts) || '—'} />
              <MetaTile icon={Boxes} label="Est. Physical Partitions" value={selectedDetails?.data?.estimated_physical_partitions ?? '—'} sub="estimated, not exact" />
              <NotAvailable icon={HardDrive} label="Average Document Size" />
              <NotAvailable icon={HardDrive} label="Largest Document" />
              <NotAvailable icon={Hash} label="Today's Inserts / Updates / Deletes" />
              <NotAvailable icon={Boxes} label="Partition Distribution" />
            </div>

            <Panel title={`Items — ${selectedContainer || ''}`} right={
              <div className="flex items-center gap-2">
                <button onClick={() => setSortRecent((s) => !s)}
                  className={`h-7 px-2.5 rounded-md text-[11px] font-bold transition-colors ${sortRecent ? 'bg-sky-600 text-white' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}>
                  Recently Modified
                </button>
                <button onClick={handleExportJson} disabled={!items.length} className="h-7 px-2.5 rounded-md text-[11px] font-bold bg-slate-100 text-slate-600 hover:bg-slate-200 disabled:opacity-40 flex items-center gap-1">
                  <Download size={11} /> Export JSON
                </button>
                <button onClick={handleExportCsv} disabled={!items.length} className="h-7 px-2.5 rounded-md text-[11px] font-bold bg-slate-100 text-slate-600 hover:bg-slate-200 disabled:opacity-40 flex items-center gap-1">
                  <Download size={11} /> Export CSV
                </button>
                <button onClick={() => refetchItems()} className="text-slate-400 hover:text-slate-700"><RefreshCw size={14} className={itemsLoading ? 'animate-spin' : ''} /></button>
              </div>
            }>
              <div className="flex items-center gap-2 mb-4">
                <div className="relative flex-1">
                  <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input value={searchText} onChange={(e) => setSearchText(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { setTokenStack([]); setCurrentToken(null); setAppliedFilter(searchText.trim()); } }}
                    placeholder="Filter — Cosmos SQL WHERE clause, e.g. c.status = 'active'"
                    className="w-full h-9 rounded-lg border border-slate-300 pl-9 pr-3 text-sm font-mono outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-100" />
                </div>
                <button onClick={() => { setTokenStack([]); setCurrentToken(null); setAppliedFilter(searchText.trim()); }}
                  className="h-9 px-4 rounded-lg bg-blue-700 text-white text-sm font-bold hover:bg-blue-800">Filter</button>
                {appliedFilter && (
                  <button onClick={() => { setSearchText(''); setAppliedFilter(''); setTokenStack([]); setCurrentToken(null); }}
                    className="h-9 px-3 rounded-lg border border-slate-300 text-slate-600 text-sm font-bold hover:bg-slate-50">Clear</button>
                )}
              </div>

              {itemsLoading && !itemsResp ? (
                <div className="flex items-center gap-2 text-slate-400 text-sm py-6 justify-center"><RefreshCw size={14} className="animate-spin" /> Loading items…</div>
              ) : itemsError ? (
                <p className="text-sm text-red-600 flex items-center gap-2"><AlertTriangle size={14} /> {itemsError?.response?.data?.detail || itemsError.message}</p>
              ) : items.length === 0 ? (
                <p className="text-sm text-slate-400 py-6 text-center">No documents match.</p>
              ) : (
                <>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-slate-50">
                        <tr>
                          <th className="px-3 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase">id</th>
                          <th className="px-3 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase">Preview</th>
                          <th className="px-3 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase">Last Modified</th>
                          <th className="px-3 py-2.5 text-right text-[10px] font-bold text-slate-400 uppercase">Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {items.map((it, i) => (
                          <tr key={it.id || i} className="border-t border-slate-100 hover:bg-sky-50/30 cursor-pointer" onClick={() => setViewingItem({ title: `Document: ${it.id || ''}`, json: it })}>
                            <td className="px-3 py-2.5 font-mono text-[11px] text-sky-700 whitespace-nowrap">{it.id || '—'}</td>
                            <td className="px-3 py-2.5 font-mono text-[11px] text-slate-500 max-w-[420px] truncate">{JSON.stringify(it)}</td>
                            <td className="px-3 py-2.5 text-[11px] text-slate-500 whitespace-nowrap">{it._ts ? fmtEpochSec(it._ts) : '—'}</td>
                            <td className="px-3 py-2.5 text-right">
                              <span className="text-[11px] font-bold text-sky-600 inline-flex items-center gap-1"><FileJson size={12} /> View JSON</span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="flex items-center justify-between mt-4">
                    <button onClick={goPrevPage} disabled={!tokenStack.length}
                      className="h-8 px-3 rounded-lg border border-slate-300 text-slate-600 text-xs font-bold hover:bg-slate-50 disabled:opacity-40 flex items-center gap-1">
                      <ChevronLeft size={13} /> Previous
                    </button>
                    <span className="text-[11px] text-slate-400">{items.length} shown</span>
                    <button onClick={goNextPage} disabled={!nextToken}
                      className="h-8 px-3 rounded-lg border border-slate-300 text-slate-600 text-xs font-bold hover:bg-slate-50 disabled:opacity-40 flex items-center gap-1">
                      Next <ChevronRight size={13} />
                    </button>
                  </div>
                </>
              )}
            </Panel>
          </>
        )}

        {/* ══════════════════ INDEXING POLICY ══════════════════ */}
        {activeTab === 'indexing' && (
          <>
            <Panel title="Database / Container">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <select value={selectedDb || ''} onChange={(e) => setSelectedDb(e.target.value)} className="w-full h-10 rounded-lg border border-slate-300 px-3 text-sm">
                  {dbList.map((d) => <option key={d.id} value={d.id}>{d.id}</option>)}
                </select>
                <select value={selectedContainer || ''} onChange={(e) => setSelectedContainer(e.target.value)} className="w-full h-10 rounded-lg border border-slate-300 px-3 text-sm">
                  {containers.map((c) => <option key={c.id} value={c.id}>{c.id}</option>)}
                </select>
              </div>
            </Panel>

            {selectedDetailsLoading ? (
              <div className="flex items-center gap-2 text-slate-400 text-sm py-2"><RefreshCw size={14} className="animate-spin" /> Loading…</div>
            ) : selectedDetailsError ? (
              <p className="text-sm text-red-600 flex items-center gap-2"><AlertTriangle size={14} /> {selectedDetailsError?.response?.data?.detail || selectedDetailsError.message}</p>
            ) : (() => {
              const ip = selectedDetails?.data?.indexing_policy || {};
              const uk = selectedDetails?.data?.unique_key_policy?.uniqueKeys || [];
              return (
                <>
                  <Panel title="Actmon AI — Index Analysis" accent="violet" right={
                    <div className="flex items-center gap-2">
                      {aiMutation.data?.available && (
                        <button onClick={() => setShowAiReport(true)} title="Open full report in a window"
                          className="h-9 w-9 rounded-lg border border-slate-300 text-slate-500 hover:bg-slate-50 flex items-center justify-center flex-shrink-0">
                          <Maximize2 size={14} />
                        </button>
                      )}
                      <button onClick={() => aiMutation.mutate()} disabled={aiMutation.isPending || !selectedDb || !selectedContainer}
                        className="h-9 px-4 rounded-lg bg-violet-600 text-white text-sm font-bold hover:bg-violet-700 disabled:opacity-40 flex items-center gap-2">
                        {aiMutation.isPending ? <RefreshCw size={14} className="animate-spin" /> : <Sparkles size={14} />}
                        {aiMutation.data?.available ? 'Regenerate' : 'Analyze Indexing'}
                      </button>
                    </div>
                  }>
                    <p className="text-[13px] text-slate-600 leading-relaxed mb-3">
                      Indexing controls which fields Cosmos DB can search quickly. Every field indexed makes reads faster but adds storage and a small
                      write cost; every field <i>not</i> indexed keeps writes cheap but makes filtering on it slow (a full scan). This report reads real
                      documents from <b className="text-slate-700">{selectedDb}/{selectedContainer}</b> and explains, in plain language, what this
                      container's current indexing setup actually does — its benefits, its trade-offs, and what (if anything) to change.
                    </p>
                    {!aiMutation.data && !aiMutation.isPending && (
                      <p className="text-sm text-slate-400 py-4 text-center">Click "Analyze Indexing" for an index-focused Actmon AI report.</p>
                    )}
                    {aiMutation.isPending && (
                      <div className="flex items-center gap-2 text-slate-400 text-sm py-4 justify-center"><RefreshCw size={14} className="animate-spin" /> Actmon AI is sampling real documents and analyzing indexing…</div>
                    )}
                    {aiMutation.isError && (
                      <p className="text-sm text-red-600 flex items-center gap-2 py-2"><AlertTriangle size={14} /> {aiMutation.error?.response?.data?.detail || aiMutation.error.message}</p>
                    )}
                    {aiMutation.data && !aiMutation.data.available && (
                      <p className="text-sm text-slate-500 flex items-center gap-2 py-2"><AlertTriangle size={14} className="text-amber-400 flex-shrink-0" /> {aiMutation.data.reason || 'Actmon AI is not available right now.'}</p>
                    )}
                    {aiMutation.data?.available && (
                      <div className="space-y-3">
                        {aiMutation.data.data?.checks_performed?.length > 0 && (
                          <ul className="space-y-1">
                            {aiMutation.data.data.checks_performed.map((p, i) => (
                              <li key={i} className="flex items-start gap-2 text-[12px] text-slate-500"><CheckCircle2 size={12} className="text-slate-400 mt-0.5 flex-shrink-0" /> {p}</li>
                            ))}
                          </ul>
                        )}
                        <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">{aiMutation.data.data?.index_analysis || '—'}</p>
                        {aiMutation.data.data?.recommended_actions?.length > 0 && (
                          <ul className="space-y-1.5 pt-2 border-t border-slate-100">
                            {aiMutation.data.data.recommended_actions.map((p, i) => (
                              <li key={i} className="flex items-start gap-2 text-sm text-slate-700"><CheckCircle2 size={14} className="text-violet-500 mt-0.5 flex-shrink-0" /> {p}</li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </Panel>

                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <MetaTile icon={CheckCircle2} label="Automatic Indexing" value={ip.automatic ? 'Enabled' : 'Disabled'}
                      sub={ip.automatic ? 'Every new field is indexed automatically — no setup needed, but costs a bit more storage/RU per write.' : 'New fields are NOT indexed unless added manually — cheaper writes, but you must remember to add paths yourself.'} />
                    <MetaTile icon={ListTree} label="Indexing Mode" value={ip.indexingMode || '—'}
                      sub={ip.indexingMode === 'consistent' ? 'Indexes update instantly on every write, so query results are always current.' : ip.indexingMode === 'none' ? 'Indexing is off — you can only fetch by ID, not search/filter.' : 'Controls when indexes are kept up to date.'} />
                    <MetaTile icon={Clock} label="TTL" value={selectedDetails?.data?.default_ttl != null ? `${selectedDetails.data.default_ttl}s` : 'Off'}
                      sub={selectedDetails?.data?.default_ttl != null ? 'Documents are auto-deleted this long after their last write — good for temporary/expiring data.' : 'Documents are kept forever unless your app deletes them.'} />
                    <MetaTile icon={Fingerprint} label="Unique Keys" value={uk.length}
                      sub="Number of field-combinations Cosmos enforces as unique per partition, like a uniqueness constraint." />
                  </div>

                  <Panel title="Included Paths">
                    <p className="text-[12px] text-slate-500 mb-2">
                      Fields listed here <b>are indexed</b>. <span className="text-emerald-600">Benefit:</span> filtering/sorting on them is fast and cheap.
                      <span className="text-amber-600"> Trade-off:</span> each extra indexed field adds a little storage and write cost.
                    </p>
                    {ip.includedPaths?.length ? (
                      <div className="flex flex-wrap gap-2">
                        {ip.includedPaths.map((p, i) => <span key={i} className="px-2.5 py-1 rounded-md bg-emerald-50 border border-emerald-100 text-emerald-700 text-[11px] font-mono">{p.path}</span>)}
                      </div>
                    ) : <p className="text-sm text-slate-400">None</p>}
                  </Panel>
                  <Panel title="Excluded Paths">
                    <p className="text-[12px] text-slate-500 mb-2">
                      Fields listed here are <b>explicitly NOT indexed</b>. <span className="text-emerald-600">Benefit:</span> saves storage/RU on
                      fields you never search by. <span className="text-amber-600">Trade-off:</span> filtering on these fields requires scanning
                      every document — slow and expensive.
                    </p>
                    {ip.excludedPaths?.length ? (
                      <div className="flex flex-wrap gap-2">
                        {ip.excludedPaths.map((p, i) => <span key={i} className="px-2.5 py-1 rounded-md bg-slate-50 border border-slate-200 text-slate-600 text-[11px] font-mono">{p.path}</span>)}
                      </div>
                    ) : <p className="text-sm text-slate-400">None</p>}
                  </Panel>
                  <Panel title="Composite Indexes">
                    <p className="text-[12px] text-slate-500 mb-2">
                      Indexes covering <b>multiple fields together</b> — needed when a query filters or sorts on more than one field at once.
                      <span className="text-emerald-600"> Benefit:</span> fast multi-field queries that a single-field index can't serve efficiently.
                      <span className="text-amber-600"> Trade-off:</span> extra storage per document.
                    </p>
                    {ip.compositeIndexes?.length ? (
                      <div className="space-y-1.5">
                        {ip.compositeIndexes.map((combo, i) => (
                          <div key={i} className="text-[12px] font-mono text-slate-600">
                            {combo.map((c) => `${c.path} ${c.order || 'asc'}`).join(', ')}
                          </div>
                        ))}
                      </div>
                    ) : <p className="text-sm text-slate-400">None configured</p>}
                  </Panel>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <Panel title="Spatial Indexes">
                      <p className="text-[12px] text-slate-500 mb-2">
                        Indexes for location/geography fields — power queries like "find documents within X km."
                        <span className="text-emerald-600"> Benefit:</span> fast geo queries. <span className="text-amber-600">Trade-off:</span> only
                        useful if your app actually queries by location.
                      </p>
                      {ip.spatialIndexes?.length ? (
                        <div className="flex flex-wrap gap-2">
                          {ip.spatialIndexes.map((p, i) => <span key={i} className="px-2.5 py-1 rounded-md bg-violet-50 border border-violet-100 text-violet-700 text-[11px] font-mono">{p.path}</span>)}
                        </div>
                      ) : <p className="text-sm text-slate-400">None configured</p>}
                    </Panel>
                    <Panel title="Vector Indexes">
                      <p className="text-[12px] text-slate-500 mb-2">
                        Indexes for AI/similarity search over vector embeddings (semantic search, recommendations).
                        <span className="text-emerald-600"> Benefit:</span> fast similarity search. <span className="text-amber-600">Trade-off:</span> only
                        useful for AI/ML use cases.
                      </p>
                      {ip.vectorIndexes?.length ? (
                        <div className="flex flex-wrap gap-2">
                          {ip.vectorIndexes.map((p, i) => <span key={i} className="px-2.5 py-1 rounded-md bg-sky-50 border border-sky-100 text-sky-700 text-[11px] font-mono">{p.path}</span>)}
                        </div>
                      ) : <p className="text-sm text-slate-400">None configured</p>}
                    </Panel>
                  </div>
                  <Panel title="Unique Keys">
                    <p className="text-[12px] text-slate-500 mb-2">
                      Guarantees no two documents in the same partition can share these field values — like a uniqueness constraint in a traditional
                      database. <span className="text-emerald-600">Benefit:</span> prevents accidental duplicate data.
                      <span className="text-amber-600"> Trade-off:</span> a write that would violate this is rejected, so your app must handle that case.
                    </p>
                    {uk.length ? (
                      <div className="flex flex-wrap gap-2">
                        {uk.map((u, i) => <span key={i} className="px-2.5 py-1 rounded-md bg-amber-50 border border-amber-100 text-amber-700 text-[11px] font-mono">{(u.paths || []).join(', ')}</span>)}
                      </div>
                    ) : <p className="text-sm text-slate-400">None configured</p>}
                  </Panel>

                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <NotAvailable icon={ListTree} label="Index Utilization" />
                    <NotAvailable icon={Zap} label="Estimated RU Savings" />
                    <NotAvailable icon={ListTree} label="Missing Index Recommendations" />
                    <NotAvailable icon={ListTree} label="Unused Indexes" />
                  </div>
                </>
              );
            })()}
          </>
        )}

        {/* ══════════════════ SLOW QUERIES ══════════════════ */}
        {activeTab === 'slow-queries' && (() => {
          const rows = activity?.slow_queries || [];
          const containerOptions = Array.from(new Set(rows.map((r) => parseDbContainer(r.detail).container).filter(Boolean)));
          const filtered = rows.filter((r) => {
            const { container } = parseDbContainer(r.detail);
            if (sqContainerFilter && container !== sqContainerFilter) return false;
            if (sqMinRu && !(r.request_charge >= Number(sqMinRu))) return false;
            if (sqMinMs && !(r.duration_ms >= Number(sqMinMs))) return false;
            return true;
          });
          return (
            <Panel title={`Slow Queries (> ${activity?.slow_query_threshold_ms ?? 500}ms)`} accent="amber" right={
              <span className="text-[11px] text-slate-400 font-semibold">{filtered.length} of {rows.length}</span>
            }>
              <p className="text-[11px] text-slate-400 mb-4">
                Only real query executions ActMon itself performed against this connection — never generated. Stored durably and sorted by highest execution time.
              </p>
              <div className="flex flex-wrap items-center gap-2 mb-4">
                <select value={sqContainerFilter} onChange={(e) => setSqContainerFilter(e.target.value)} className="h-9 rounded-lg border border-slate-300 px-3 text-sm">
                  <option value="">All containers</option>
                  {containerOptions.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
                <input value={sqMinRu} onChange={(e) => setSqMinRu(e.target.value)} placeholder="Min RU cost" type="number"
                  className="h-9 w-32 rounded-lg border border-slate-300 px-3 text-sm" />
                <input value={sqMinMs} onChange={(e) => setSqMinMs(e.target.value)} placeholder="Min duration (ms)" type="number"
                  className="h-9 w-36 rounded-lg border border-slate-300 px-3 text-sm" />
              </div>

              {!filtered.length ? (
                <p className="text-sm text-slate-400 py-4 text-center">No slow queries recorded yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50">
                      <tr>
                        <th className="px-3 py-2 text-left text-[10px] font-bold text-slate-400 uppercase">When</th>
                        <th className="px-3 py-2 text-left text-[10px] font-bold text-slate-400 uppercase">Operation</th>
                        <th className="px-3 py-2 text-left text-[10px] font-bold text-slate-400 uppercase">Query / Detail</th>
                        <th className="px-3 py-2 text-right text-[10px] font-bold text-slate-400 uppercase">Duration</th>
                        <th className="px-3 py-2 text-right text-[10px] font-bold text-slate-400 uppercase">Request Charge</th>
                        <th className="px-3 py-2 text-left text-[10px] font-bold text-slate-400 uppercase">Cross Partition</th>
                        <th className="px-3 py-2 text-left text-[10px] font-bold text-slate-400 uppercase">Activity ID</th>
                        <th className="px-3 py-2 text-left text-[10px] font-bold text-slate-400 uppercase">Status</th>
                        <th className="px-3 py-2 text-left text-[10px] font-bold text-slate-400 uppercase">AI Analysis</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.map((r) => {
                        const st = errorAnalysis[r.id];
                        return (
                          <tr key={r.id} className="border-t border-slate-100">
                            <td className="px-3 py-2 text-[11px] text-slate-500 whitespace-nowrap">{fmtDateTime(r.created_at)}</td>
                            <td className="px-3 py-2 text-[11px] font-bold text-slate-700">{r.operation}</td>
                            <td className="px-3 py-2 font-mono text-[11px] text-slate-500 max-w-[360px] truncate">{r.detail || '—'}</td>
                            <td className="px-3 py-2 text-right font-mono text-[12px] font-bold text-amber-600">{r.duration_ms} ms</td>
                            <td className="px-3 py-2 text-right font-mono text-[12px]">{r.request_charge != null ? `${r.request_charge} RU` : '—'}</td>
                            <td className="px-3 py-2 text-[11px]">{CROSS_PARTITION_OPS.has(r.operation) ? 'Yes' : 'N/A'}</td>
                            <td className="px-3 py-2 font-mono text-[10px] text-slate-400">{r.activity_id || '—'}</td>
                            <td className="px-3 py-2">
                              {r.success
                                ? <span className="text-[10px] font-black text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded-full">OK</span>
                                : <span className="text-[10px] font-black text-red-700 bg-red-100 px-2 py-0.5 rounded-full">FAILED</span>}
                            </td>
                            <td className="px-3 py-2 text-[11px] whitespace-nowrap">
                              <button onClick={() => openLogAnalysis(r)}
                                className="font-bold text-violet-600 hover:text-violet-800 inline-flex items-center gap-1">
                                <Sparkles size={11} /> {st ? 'View Analysis' : 'Analyze'}
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mt-5">
                <NotAvailable icon={Hash} label="Retrieved / Returned Documents" />
                <NotAvailable icon={ListTree} label="Index Utilization" />
              </div>
            </Panel>
          );
        })()}

        {/* ══════════════════ ERROR LOGS ══════════════════ */}
        {activeTab === 'error-logs' && (
          <Panel title="Error Logs" accent="red">
            <p className="text-[11px] text-slate-400 mb-4">
              Every Cosmos SDK exception and operation failure ActMon itself encountered on this connection — captured and stored, never fabricated.
            </p>
            {!activity?.error_logs?.length ? (
              <div className="flex flex-col items-center gap-2 py-10 text-center">
                <CheckCircle2 size={28} className="text-emerald-400" />
                <p className="font-black text-slate-700">No Errors Detected</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50">
                    <tr>
                      <th className="px-3 py-2 text-left text-[10px] font-bold text-slate-400 uppercase">When</th>
                      <th className="px-3 py-2 text-left text-[10px] font-bold text-slate-400 uppercase">Error Type</th>
                      <th className="px-3 py-2 text-right text-[10px] font-bold text-slate-400 uppercase">HTTP Status</th>
                      <th className="px-3 py-2 text-left text-[10px] font-bold text-slate-400 uppercase">Database</th>
                      <th className="px-3 py-2 text-left text-[10px] font-bold text-slate-400 uppercase">Container</th>
                      <th className="px-3 py-2 text-left text-[10px] font-bold text-slate-400 uppercase">Operation</th>
                      <th className="px-3 py-2 text-right text-[10px] font-bold text-slate-400 uppercase">Request Charge</th>
                      <th className="px-3 py-2 text-right text-[10px] font-bold text-slate-400 uppercase">Duration</th>
                      <th className="px-3 py-2 text-left text-[10px] font-bold text-slate-400 uppercase">Activity ID</th>
                      <th className="px-3 py-2 text-left text-[10px] font-bold text-slate-400 uppercase">Exception</th>
                      <th className="px-3 py-2 text-left text-[10px] font-bold text-slate-400 uppercase">AI Analysis</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activity.error_logs.map((r) => {
                      const { database, container } = parseDbContainer(r.detail);
                      const st = errorAnalysis[r.id];
                      return (
                        <tr key={r.id} className="border-t border-slate-100 align-top">
                          <td className="px-3 py-2 text-[11px] text-slate-500 whitespace-nowrap">{fmtDateTime(r.created_at)}</td>
                          <td className="px-3 py-2 text-[11px] font-bold text-red-600">{r.error_type || '—'}</td>
                          <td className="px-3 py-2 text-right font-mono text-[12px]">{r.http_status_code ?? '—'}</td>
                          <td className="px-3 py-2 text-[11px] text-slate-600">{database || '—'}</td>
                          <td className="px-3 py-2 text-[11px] text-slate-600">{container || '—'}</td>
                          <td className="px-3 py-2 text-[11px] font-bold text-slate-700">{r.operation}</td>
                          <td className="px-3 py-2 text-right font-mono text-[12px]">{r.request_charge != null ? `${r.request_charge} RU` : '—'}</td>
                          <td className="px-3 py-2 text-right font-mono text-[12px]">{r.duration_ms != null ? `${r.duration_ms} ms` : '—'}</td>
                          <td className="px-3 py-2 font-mono text-[10px] text-slate-400">{r.activity_id || '—'}</td>
                          <td className="px-3 py-2 text-[11px] text-red-600 max-w-[280px] truncate" title={r.error_message}>{r.error_message || '—'}</td>
                          <td className="px-3 py-2 text-[11px] whitespace-nowrap">
                            <button onClick={() => openLogAnalysis(r)}
                              className="font-bold text-violet-600 hover:text-violet-800 inline-flex items-center gap-1">
                              <Sparkles size={11} /> {st ? 'View Analysis' : 'Analyze'}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mt-5">
              <NotAvailable icon={RefreshCw} label="Retry Count" />
            </div>
          </Panel>
        )}

        {/* ══════════════════ ACTMON AI ══════════════════ */}
        {activeTab === 'ai' && (
          <>
            <Panel title="Actmon AI" accent="violet" right={
              <div className="flex items-center gap-2">
                {aiMutation.data?.available && (
                  <button onClick={() => setShowAiReport(true)} title="Open full report in a window"
                    className="h-9 w-9 rounded-lg border border-slate-300 text-slate-500 hover:bg-slate-50 flex items-center justify-center flex-shrink-0">
                    <Maximize2 size={14} />
                  </button>
                )}
                <button onClick={() => aiMutation.mutate()} disabled={aiMutation.isPending || !selectedDb || !selectedContainer}
                  className="h-9 px-4 rounded-lg bg-violet-600 text-white text-sm font-bold hover:bg-violet-700 disabled:opacity-40 flex items-center gap-2">
                  {aiMutation.isPending ? <RefreshCw size={14} className="animate-spin" /> : <Sparkles size={14} />} Generate Report
                </button>
              </div>
            }>
              <p className="text-[12px] text-slate-500 mb-3">
                Analyzing <b className="text-slate-700">{selectedDb}/{selectedContainer}</b> — every sibling container in this database, real container health,
                a genuine sample of live documents (schema/field/null patterns, not just metadata), partition distribution, indexing policy, request charge
                usage, query performance, storage usage, growth trends, inefficient queries, expensive operations, and optimization recommendations.
              </p>
              {!aiMutation.data && !aiMutation.isPending && (
                <p className="text-sm text-slate-400 py-6 text-center">Click "Generate Report" to have Actmon AI analyze this container. This reads real documents and sibling containers, so it can take a bit longer than a metadata-only summary.</p>
              )}
              {aiMutation.isPending && (
                <div className="flex items-center gap-2 text-slate-400 text-sm py-6 justify-center"><RefreshCw size={14} className="animate-spin" /> Actmon AI is sampling real documents and analyzing this container — this can take up to a minute…</div>
              )}
              {aiMutation.isError && (
                <p className="text-sm text-red-600 flex items-center gap-2 py-4"><AlertTriangle size={14} /> {aiMutation.error?.response?.data?.detail || aiMutation.error.message}</p>
              )}
              {aiMutation.data && !aiMutation.data.available && (
                <div className="flex items-center gap-3 py-6 justify-center text-center">
                  <AlertTriangle size={20} className="text-amber-400 flex-shrink-0" />
                  <p className="text-sm text-slate-500">{aiMutation.data.reason || 'Actmon AI is not available right now.'}</p>
                </div>
              )}
            </Panel>

            {aiMutation.data?.available && (() => {
              const r = aiMutation.data.data || {};
              return (
                <>
                  {r.checks_performed?.length > 0 && (
                    <Panel title="What We Checked" accent="slate">
                      <ul className="space-y-1.5">
                        {r.checks_performed.map((p, i) => (
                          <li key={i} className="flex items-start gap-2 text-sm text-slate-600"><CheckCircle2 size={14} className="text-slate-400 mt-0.5 flex-shrink-0" /> {p}</li>
                        ))}
                      </ul>
                    </Panel>
                  )}

                  <Panel title="Overall Health Score">
                    <div className="max-w-xs mx-auto">
                      <Gauge icon={Sparkles} label="Health Score" pct={r.health_score ?? 0} sub="Actmon AI composite score"
                        colorFn={(v) => (v >= 80 ? '#22c55e' : v >= 60 ? '#f59e0b' : '#ef4444')} />
                    </div>
                  </Panel>

                  {r.problems_detected?.length > 0 && (
                    <Panel title="Problems Detected" accent="amber">
                      <ul className="space-y-2">
                        {r.problems_detected.map((p, i) => (
                          <li key={i} className="flex items-start gap-2 text-sm text-slate-700"><AlertTriangle size={14} className="text-amber-500 mt-0.5 flex-shrink-0" /> {p}</li>
                        ))}
                      </ul>
                    </Panel>
                  )}

                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    <Panel title="Performance Analysis"><p className="text-sm text-slate-600 leading-relaxed whitespace-pre-wrap">{r.performance_analysis || '—'}</p></Panel>
                    <Panel title="Storage Analysis"><p className="text-sm text-slate-600 leading-relaxed whitespace-pre-wrap">{r.storage_analysis || '—'}</p></Panel>
                    <Panel title="Partition Analysis"><p className="text-sm text-slate-600 leading-relaxed whitespace-pre-wrap">{r.partition_analysis || '—'}</p></Panel>
                    <Panel title="Index Analysis"><p className="text-sm text-slate-600 leading-relaxed whitespace-pre-wrap">{r.index_analysis || '—'}</p></Panel>
                  </div>

                  {r.cost_optimization_suggestions?.length > 0 && (
                    <Panel title="Cost Optimization Suggestions" accent="green">
                      <ul className="space-y-2">
                        {r.cost_optimization_suggestions.map((p, i) => (
                          <li key={i} className="flex items-start gap-2 text-sm text-slate-700"><Zap size={14} className="text-emerald-500 mt-0.5 flex-shrink-0" /> {p}</li>
                        ))}
                      </ul>
                    </Panel>
                  )}
                  {r.recommended_actions?.length > 0 && (
                    <Panel title="Recommended Actions" accent="violet">
                      <ul className="space-y-2">
                        {r.recommended_actions.map((p, i) => (
                          <li key={i} className="flex items-start gap-2 text-sm text-slate-700"><CheckCircle2 size={14} className="text-violet-500 mt-0.5 flex-shrink-0" /> {p}</li>
                        ))}
                      </ul>
                    </Panel>
                  )}
                  {r.expected_performance_improvement && (
                    <Panel title="Expected Performance Improvement">
                      <p className="text-sm text-slate-600 leading-relaxed whitespace-pre-wrap">{r.expected_performance_improvement}</p>
                    </Panel>
                  )}
                </>
              );
            })()}
          </>
        )}
      </div>

      <JsonDrawer item={viewingItem} onClose={() => setViewingItem(null)} />
      {showAiReport && (
        <AIReportModal report={aiMutation.data} target={selectedDb && selectedContainer ? `${selectedDb}/${selectedContainer}` : undefined}
          onClose={() => setShowAiReport(false)} />
      )}
      <LogAnalysisModal row={logAnalysisRow} state={logAnalysisRow ? errorAnalysis[logAnalysisRow.id] : null}
        onClose={() => setLogAnalysisRow(null)} onRetry={() => logAnalysisRow && handleAnalyzeError(logAnalysisRow.id)} />
    </div>
    </DashboardScopeProvider>
  );
}
