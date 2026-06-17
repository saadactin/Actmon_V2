import React, { useState, useEffect, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  useAgentDashboard,
  useAgentMetrics,
  useAgentSQL,
  useAgentWaitEvents,
  useOracleSnapshot,
} from '../../hooks/useAgents';
import { exportCSV } from '../../api/agents';
import { StatusPill } from '../../components/ui/StatusPill';
import { DBTypeBadge } from '../../components/ui/DBTypeBadge';
import { formatUptime, formatBytes } from '../../utils/formatters';
import {
  Spinner, Button, TabList, Tab, Card,
  MessageBar, MessageBarBody, MessageBarTitle, Select,
} from '@fluentui/react-components';
import {
  ArrowLeft, Download, RefreshCw, BarChart2, Database, Table,
  Activity, Cpu, Zap, Server, Clock, Shield, AlertTriangle,
  CheckCircle, TrendingUp, TrendingDown, Copy, ChevronDown, ChevronUp,
  Wifi, HardDrive, Users, Timer, HelpCircle,
} from 'lucide-react';
import {
  AreaChart, Area, BarChart, Bar, ComposedChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, Cell,
} from 'recharts';

// ─── tiny helpers ────────────────────────────────────────────────────────────

const fmt = (ts) => {
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });
  } catch { return ts; }
};

const ago = (ts) => {
  if (!ts) return 'Never';
  const diff = Math.floor((Date.now() - new Date(ts)) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
};

const pct = (v, max) => max > 0 ? Math.round((v / max) * 100) : 0;

const healthColor = (score) => {
  if (score >= 80) return { bg: 'bg-green-500', text: 'text-green-600', label: 'Healthy', ring: '#16a34a' };
  if (score >= 60) return { bg: 'bg-yellow-500', text: 'text-yellow-600', label: 'Warning', ring: '#ca8a04' };
  return { bg: 'bg-red-500', text: 'text-red-600', label: 'Critical', ring: '#dc2626' };
};

const connBarColor = (pct) => {
  if (pct < 60) return '#16a34a';
  if (pct < 80) return '#ca8a04';
  return '#dc2626';
};

const CHART_COLORS = {
  cpu:     '#0078D4',
  memory:  '#8764B8',
  sessions:'#D83B01',
  qps:     '#107C10',
  tps:     '#00B294',
  cache:   '#0078D4',
};

const AREA_GRADIENT = (id, color) => (
  <defs>
    <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
      <stop offset="5%"  stopColor={color} stopOpacity={0.25} />
      <stop offset="95%" stopColor={color} stopOpacity={0.02} />
    </linearGradient>
  </defs>
);

const tooltipStyle = {
  backgroundColor: '#fff',
  border: '1px solid #EDEBE9',
  borderRadius: 6,
  fontSize: 12,
  boxShadow: '0 2px 8px rgba(0,0,0,.12)',
};

// ─── sub-components ──────────────────────────────────────────────────────────

const KPICard = ({ label, value, sub, icon: Icon, iconBg = '#DEECF9', iconColor = '#0078D4', alert }) => (
  <Card className="p-4 bg-white border border-brand-border rounded-xl shadow-sm hover:shadow-md transition-shadow">
    <div className="flex items-start justify-between gap-2">
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-semibold text-brand-text-secondary uppercase tracking-wide truncate">{label}</p>
        <p className="text-2xl font-bold text-brand-text-primary mt-1 leading-tight">{value ?? '—'}</p>
        {sub && <p className="text-xs text-brand-text-secondary mt-1 truncate">{sub}</p>}
      </div>
      <div className="flex-shrink-0 flex flex-col items-end gap-1">
        <div style={{ background: iconBg }} className="p-2 rounded-lg">
          {Icon && <Icon size={16} style={{ color: iconColor }} />}
        </div>
        {alert && <AlertTriangle size={12} className="text-yellow-500" />}
      </div>
    </div>
  </Card>
);

const ConnBar = ({ used, max }) => {
  const p = pct(used, max);
  const color = connBarColor(p);
  return (
    <div className="flex items-center gap-3">
      <div className="flex-1 h-2.5 bg-gray-100 rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${Math.min(p, 100)}%`, background: color }} />
      </div>
      <span className="text-xs font-bold tabular-nums" style={{ color }}>
        {used}/{max} ({p}%)
      </span>
    </div>
  );
};

const HealthBadge = ({ score }) => {
  const c = healthColor(score);
  return (
    <div className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-sm font-semibold ${c.text} bg-opacity-10`}
         style={{ background: score >= 80 ? '#f0fdf4' : score >= 60 ? '#fefce8' : '#fef2f2' }}>
      {score >= 80 ? <CheckCircle size={14} /> : <AlertTriangle size={14} />}
      {c.label} — {score}/100
    </div>
  );
};

const PulseDot = ({ online }) => (
  <span className="relative flex h-2.5 w-2.5">
    {online && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />}
    <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${online ? 'bg-green-500' : 'bg-gray-400'}`} />
  </span>
);

const TrendChip = ({ cur, prev }) => {
  if (prev == null || cur == null) return null;
  const diff = cur - prev;
  const isUp = diff > 0;
  return (
    <span className={`inline-flex items-center gap-0.5 text-[10px] font-bold px-1.5 py-0.5 rounded
      ${isUp ? 'bg-red-50 text-red-600' : 'bg-green-50 text-green-700'}`}>
      {isUp ? <TrendingUp size={10} /> : <TrendingDown size={10} />}
      {Math.abs(diff).toFixed(1)}
    </span>
  );
};

// Horizontal bar for wait events
const WaitBar = ({ name, value, max, color }) => (
  <div className="space-y-1">
    <div className="flex justify-between text-xs">
      <span className="text-brand-text-secondary truncate max-w-[240px]" title={name}>{name}</span>
      <span className="font-mono font-semibold text-brand-text-primary ml-2">{value.toFixed(1)} ms</span>
    </div>
    <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
      <div className="h-full rounded-full" style={{ width: `${Math.min((value / max) * 100, 100)}%`, background: color }} />
    </div>
  </div>
);

// Expandable SQL row
const SQLRow = ({ row, idx }) => {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(row.sql_text || '');
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <>
      <tr className={`border-b border-gray-100 hover:bg-[#F3F9FD] transition-colors ${open ? 'bg-[#F3F9FD]' : ''}`}>
        <td className="px-4 py-3 text-xs">
          <button onClick={() => setOpen(o => !o)} className="flex items-center gap-1 text-brand-primary">
            {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            <code className="bg-gray-100 px-1.5 py-0.5 rounded font-mono text-[11px]">{row.sql_id || `#${idx + 1}`}</code>
          </button>
        </td>
        <td className="px-4 py-3 text-xs tabular-nums font-semibold text-right">{(row.executions || 0).toLocaleString()}</td>
        <td className="px-4 py-3 text-xs tabular-nums text-right">
          <span className={`font-semibold ${row.avg_elapsed_ms > 1000 ? 'text-red-600' : row.avg_elapsed_ms > 100 ? 'text-yellow-600' : 'text-green-600'}`}>
            {(row.avg_elapsed_ms || 0).toFixed(2)} ms
          </span>
        </td>
        <td className="px-4 py-3 text-xs tabular-nums text-right">{(row.cpu_time_ms || 0).toFixed(0)} ms</td>
        <td className="px-4 py-3 text-xs tabular-nums text-right">{(row.buffer_gets || 0).toLocaleString()}</td>
        <td className="px-4 py-3 text-xs max-w-[280px]">
          <span className="font-mono text-brand-text-secondary truncate block" title={row.sql_text}>{row.sql_text?.slice(0, 80)}</span>
        </td>
      </tr>
      {open && (
        <tr className="bg-slate-50 border-b border-gray-100">
          <td colSpan={6} className="px-4 py-3">
            <div className="flex items-start justify-between gap-2">
              <pre className="text-xs font-mono text-slate-700 whitespace-pre-wrap break-all leading-relaxed max-h-40 overflow-y-auto flex-1 bg-white border border-gray-200 rounded p-3">
                {row.sql_text || '(no text)'}
              </pre>
              <button onClick={copy}
                className="flex-shrink-0 flex items-center gap-1 text-xs text-brand-primary hover:underline mt-1">
                <Copy size={12} />{copied ? 'Copied!' : 'Copy'}
              </button>
            </div>
            <div className="flex gap-6 mt-2 text-[11px] text-brand-text-secondary">
              <span>Max elapsed: <strong>{(row.max_ms || 0).toFixed(2)} ms</strong></span>
              <span>Total time: <strong>{(row.total_ms || 0).toFixed(2)} ms</strong></span>
              <span>Rows examined: <strong>{(row.rows_examined || 0).toLocaleString()}</strong></span>
              <span>Rows sent: <strong>{(row.rows_sent || 0).toLocaleString()}</strong></span>
            </div>
          </td>
        </tr>
      )}
    </>
  );
};

// ─── main component ───────────────────────────────────────────────────────────

const REFRESH_SEC = 30;

export const AgentDetail = () => {
  const { id = '' } = useParams();
  const [hours, setHours] = useState(6);
  const [activeTab, setActiveTab] = useState('perf');
  const [countdown, setCountdown] = useState(REFRESH_SEC);

  const { data: dashboard, isLoading: dashLoading, refetch: dashRefetch } = useAgentDashboard(id, hours);
  const { data: metrics = [], isLoading: metricsLoading, refetch: metricsRefetch } = useAgentMetrics(id, hours);
  const { data: sqlList = [], isLoading: sqlLoading, refetch: sqlRefetch } = useAgentSQL(id, hours);
  const { data: waitList = [], isLoading: waitsLoading, refetch: waitsRefetch } = useAgentWaitEvents(id, hours);

  const isOracle = dashboard?.db_type === 'Oracle';
  const { data: oracleSnap, isLoading: snapLoading } = useOracleSnapshot(id, isOracle);

  // auto-refresh countdown
  useEffect(() => {
    const t = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) {
          dashRefetch(); metricsRefetch(); sqlRefetch(); waitsRefetch();
          return REFRESH_SEC;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [dashRefetch, metricsRefetch, sqlRefetch, waitsRefetch]);

  const handleRefresh = () => {
    dashRefetch(); metricsRefetch(); sqlRefetch(); waitsRefetch();
    setCountdown(REFRESH_SEC);
  };

  // chart data
  const chartData = useMemo(() => metrics.map(m => ({
    ...m,
    ts: fmt(m.timestamp),
  })), [metrics]);

  // derived metrics
  const m = dashboard?.metrics || {};
  const connPct = pct(m.connections_used, m.connections_max || 151);
  const prevMetric = metrics.length > 1 ? metrics[metrics.length - 2] : null;

  const healthScore = useMemo(() => {
    if (!m) return 0;
    let s = 100;
    if (connPct > 90) s -= 30; else if (connPct > 75) s -= 15;
    if ((m.cache_hit_pct || 100) < 85) s -= 20; else if ((m.cache_hit_pct || 100) < 90) s -= 10;
    if ((m.db_cpu || 0) > 80) s -= 20; else if ((m.db_cpu || 0) > 60) s -= 10;
    return Math.max(0, Math.min(100, s));
  }, [m, connPct]);

  const waitMax = useMemo(() => Math.max(...waitList.map(w => w.time_waited_ms || 0), 1), [waitList]);
  const waitColors = ['#0078D4','#8764B8','#D83B01','#107C10','#00B294','#ca8a04','#dc2626','#6366f1'];

  // ── loading / error ───────────────────────────────────────────────────────
  if (dashLoading) {
    return (
      <div className="flex justify-center items-center min-h-[60vh]">
        <Spinner size="large" label={`Connecting to agent ${id}…`} />
      </div>
    );
  }

  if (!dashboard) {
    return (
      <div className="space-y-6">
        <Link to="/agents" className="inline-flex items-center gap-2 text-sm text-brand-primary hover:underline">
          <ArrowLeft size={16} /> Back to Agents
        </Link>
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Agent Not Found</MessageBarTitle>
            The monitoring agent "{id}" could not be located.
          </MessageBarBody>
        </MessageBar>
      </div>
    );
  }

  const online = dashboard.status === 'online';

  // ── render ────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-5 animate-in fade-in duration-200">

      {/* ── HEADER ── */}
      <div className="bg-white border border-brand-border rounded-xl shadow-sm p-5">
        <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
          <div className="space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <Link to="/agents" className="p-1 text-gray-400 hover:text-brand-primary hover:bg-blue-50 rounded-lg transition-colors">
                <ArrowLeft size={18} />
              </Link>
              <PulseDot online={online} />
              <h1 className="text-2xl font-bold text-brand-text-primary">{dashboard.agent_name}</h1>
              <DBTypeBadge type={dashboard.db_type} />
              <StatusPill status={dashboard.status} />
              <HealthBadge score={healthScore} />
            </div>

            <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-brand-text-secondary ml-1">
              <span className="flex items-center gap-1"><Server size={12} />{dashboard.hostname}</span>
              <span className="flex items-center gap-1"><Wifi size={12} />{dashboard.ip_address}</span>
              <span className="flex items-center gap-1"><HardDrive size={12} />{dashboard.environment}</span>
              <span className="flex items-center gap-1"><Clock size={12} />
                Last seen: <strong className="text-brand-text-primary ml-1">{ago(dashboard.last_heartbeat)}</strong>
              </span>
            </div>
          </div>

          <div className="flex flex-col items-end gap-3">
            <div className="flex items-center gap-2 flex-wrap justify-end">
              <div className="flex items-center gap-1.5 text-xs text-brand-text-secondary bg-gray-50 border border-brand-border px-3 py-1.5 rounded-lg">
                <Timer size={13} className="text-brand-primary" />
                <span>Refresh in <strong className="text-brand-primary tabular-nums">{countdown}s</strong></span>
              </div>
              <Select value={hours} onChange={(_, d) => setHours(Number(d.value))} size="small">
                <option value={1}>Last 1 Hour</option>
                <option value={6}>Last 6 Hours</option>
                <option value={12}>Last 12 Hours</option>
                <option value={24}>Last 24 Hours</option>
                <option value={48}>Last 48 Hours</option>
              </Select>
              <Button icon={<RefreshCw size={14} />} size="small" appearance="secondary" onClick={handleRefresh}>
                Refresh
              </Button>
              <Button icon={<Download size={14} />} size="small" appearance="primary" onClick={() => exportCSV(id, hours)}>
                Export CSV
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* ── KPI CARDS ── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <KPICard label="DB CPU Load"
          value={`${(m.db_cpu || 0).toFixed(1)}%`}
          sub={<TrendChip cur={m.db_cpu} prev={prevMetric?.db_cpu} />}
          icon={Cpu}
          iconBg={m.db_cpu > 80 ? '#fef2f2' : '#DEECF9'}
          iconColor={m.db_cpu > 80 ? '#dc2626' : '#0078D4'}
          alert={m.db_cpu > 80}
        />
        <KPICard label="Active Sessions"
          value={m.active_sessions ?? 0}
          sub={`of ${m.connections_max || 151} max`}
          icon={Users}
          iconBg="#F3F2F1"
          iconColor="#605E5C"
        />
        <KPICard label="Cache Hit Rate"
          value={`${(m.cache_hit_pct || 0).toFixed(1)}%`}
          sub={(m.cache_hit_pct || 0) < 85 ? '⚠ Below 85% threshold' : 'Buffer pool healthy'}
          icon={Shield}
          iconBg={(m.cache_hit_pct || 100) >= 85 ? '#f0fdf4' : '#fef9c3'}
          iconColor={(m.cache_hit_pct || 100) >= 85 ? '#16a34a' : '#ca8a04'}
          alert={(m.cache_hit_pct || 100) < 85}
        />
        <KPICard label="Connections"
          value={`${m.connections_used || 0} / ${m.connections_max || 151}`}
          sub={`${connPct}% utilized`}
          icon={Zap}
          iconBg={connPct > 75 ? '#fff7ed' : '#DEECF9'}
          iconColor={connPct > 75 ? '#ea580c' : '#0078D4'}
          alert={connPct > 75}
        />
        <KPICard label="QPS"
          value={`${(m.qps || 0).toFixed(2)}`}
          sub="Queries / second"
          icon={Activity}
          iconBg="#f0fdf4"
          iconColor="#16a34a"
        />
        <KPICard label="TPS"
          value={`${(m.tps || 0).toFixed(2)}`}
          sub="Transactions / second"
          icon={BarChart2}
          iconBg="#f0f9ff"
          iconColor="#0ea5e9"
        />
        <KPICard label="Uptime"
          value={formatUptime(m.uptime_seconds || 0)}
          sub="Since last restart"
          icon={Server}
          iconBg="#f5f3ff"
          iconColor="#7c3aed"
        />
        <KPICard label="Data Age"
          value={ago(dashboard.last_heartbeat)}
          sub={`Refreshes every ${dashboard.collection_interval_sec || 60}s`}
          icon={Clock}
          iconBg="#fff7ed"
          iconColor="#ea580c"
        />
      </div>

      {/* ── CONNECTION HEALTH BAR ── */}
      <Card className="p-4 bg-white border border-brand-border rounded-xl shadow-sm">
        <div className="flex items-center justify-between mb-2">
          <p className="text-sm font-semibold text-brand-text-primary flex items-center gap-2">
            <Zap size={15} className="text-brand-primary" /> Connection Pool Usage
          </p>
          <span className="text-xs text-brand-text-secondary">
            {m.connections_used || 0} active  ·  {(m.connections_max || 151) - (m.connections_used || 0)} available  ·  {m.connections_max || 151} max
          </span>
        </div>
        <ConnBar used={m.connections_used || 0} max={m.connections_max || 151} />
        <div className="flex gap-6 mt-3 text-[11px] text-brand-text-secondary">
          <span className="flex items-center gap-1"><span className="inline-block w-2.5 h-2.5 rounded-full bg-green-500" />0–60% Normal</span>
          <span className="flex items-center gap-1"><span className="inline-block w-2.5 h-2.5 rounded-full bg-yellow-500" />60–80% Warning</span>
          <span className="flex items-center gap-1"><span className="inline-block w-2.5 h-2.5 rounded-full bg-red-500" />80%+ Critical</span>
        </div>
      </Card>

      {/* ── TABS ── */}
      <div className="space-y-3">
        <TabList selectedValue={activeTab} onTabSelect={(_, d) => setActiveTab(d.value)} className="border-b border-brand-border">
          <Tab value="perf"     icon={<BarChart2 size={15} />}>Performance</Tab>
          <Tab value="sql"      icon={<Table size={15} />}>Top SQL</Tab>
          <Tab value="waits"    icon={<HelpCircle size={15} />}>Wait Events</Tab>
          {isOracle && <Tab value="snapshot" icon={<Database size={15} />}>Oracle</Tab>}
        </TabList>

        <div className="bg-white border border-brand-border rounded-xl shadow-sm p-5 min-h-[400px]">

          {/* ── PERFORMANCE TAB ── */}
          {activeTab === 'perf' && (
            <div>
              {metricsLoading ? (
                <div className="flex justify-center items-center h-64"><Spinner label="Loading metrics…" /></div>
              ) : chartData.length === 0 ? (
                <div className="text-center text-brand-text-secondary py-20">
                  <Activity size={40} className="mx-auto mb-3 opacity-30" />
                  <p>No telemetry data for this time range.</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

                  {/* DB CPU */}
                  <div>
                    <p className="text-sm font-semibold text-brand-text-primary mb-3 flex items-center gap-2">
                      <Cpu size={14} className="text-blue-500" /> Database CPU (%)
                    </p>
                    <ResponsiveContainer width="100%" height={220}>
                      <AreaChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                        {AREA_GRADIENT('gradCpu', CHART_COLORS.cpu)}
                        <CartesianGrid strokeDasharray="3 3" stroke="#F3F2F1" />
                        <XAxis dataKey="ts" fontSize={10} tickLine={false} />
                        <YAxis domain={[0, 100]} fontSize={10} tickLine={false} tickFormatter={v => `${v}%`} />
                        <Tooltip contentStyle={tooltipStyle} formatter={(v) => [`${v?.toFixed(2)}%`, 'DB CPU']} />
                        <Area type="monotone" dataKey="db_cpu" name="DB CPU" stroke={CHART_COLORS.cpu} fill="url(#gradCpu)" strokeWidth={2} dot={false} />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>

                  {/* Active Sessions */}
                  <div>
                    <p className="text-sm font-semibold text-brand-text-primary mb-3 flex items-center gap-2">
                      <Users size={14} className="text-orange-500" /> Active Sessions
                    </p>
                    <ResponsiveContainer width="100%" height={220}>
                      <AreaChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                        {AREA_GRADIENT('gradSess', CHART_COLORS.sessions)}
                        <CartesianGrid strokeDasharray="3 3" stroke="#F3F2F1" />
                        <XAxis dataKey="ts" fontSize={10} tickLine={false} />
                        <YAxis fontSize={10} tickLine={false} />
                        <Tooltip contentStyle={tooltipStyle} formatter={(v) => [v, 'Sessions']} />
                        <Area type="monotone" dataKey="active_sessions" name="Sessions" stroke={CHART_COLORS.sessions} fill="url(#gradSess)" strokeWidth={2} dot={false} />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>

                  {/* QPS + TPS */}
                  <div>
                    <p className="text-sm font-semibold text-brand-text-primary mb-3 flex items-center gap-2">
                      <Zap size={14} className="text-green-500" /> QPS &amp; TPS (per second)
                    </p>
                    <ResponsiveContainer width="100%" height={220}>
                      <ComposedChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#F3F2F1" />
                        <XAxis dataKey="ts" fontSize={10} tickLine={false} />
                        <YAxis fontSize={10} tickLine={false} />
                        <Tooltip contentStyle={tooltipStyle} />
                        <Legend iconSize={8} wrapperStyle={{ fontSize: 11 }} />
                        <Line type="monotone" dataKey="qps" name="QPS" stroke={CHART_COLORS.qps} strokeWidth={2} dot={false} />
                        <Line type="monotone" dataKey="tps" name="TPS" stroke={CHART_COLORS.tps} strokeWidth={2} dot={false} strokeDasharray="4 2" />
                      </ComposedChart>
                    </ResponsiveContainer>
                  </div>

                  {/* Cache Hit */}
                  <div>
                    <p className="text-sm font-semibold text-brand-text-primary mb-3 flex items-center gap-2">
                      <Shield size={14} className="text-blue-500" /> Buffer Cache Hit Rate (%)
                    </p>
                    <ResponsiveContainer width="100%" height={220}>
                      <AreaChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                        {AREA_GRADIENT('gradCache', '#0078D4')}
                        <CartesianGrid strokeDasharray="3 3" stroke="#F3F2F1" />
                        <XAxis dataKey="ts" fontSize={10} tickLine={false} />
                        <YAxis domain={[0, 100]} fontSize={10} tickLine={false} tickFormatter={v => `${v}%`} />
                        <Tooltip contentStyle={tooltipStyle} formatter={(v) => [`${v?.toFixed(2)}%`, 'Cache Hit']} />
                        <Area type="monotone" dataKey="cache_hit_pct" name="Cache Hit" stroke="#0078D4" fill="url(#gradCache)" strokeWidth={2} dot={false} />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>

                  {/* Connections over time */}
                  <div className="lg:col-span-2">
                    <p className="text-sm font-semibold text-brand-text-primary mb-3 flex items-center gap-2">
                      <Activity size={14} className="text-purple-500" /> Connections Used (over time)
                    </p>
                    <ResponsiveContainer width="100%" height={180}>
                      <AreaChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                        {AREA_GRADIENT('gradConn', '#8764B8')}
                        <CartesianGrid strokeDasharray="3 3" stroke="#F3F2F1" />
                        <XAxis dataKey="ts" fontSize={10} tickLine={false} />
                        <YAxis fontSize={10} tickLine={false} />
                        <Tooltip contentStyle={tooltipStyle} formatter={(v) => [v, 'Connections']} />
                        <Area type="monotone" dataKey="connections_used" name="Connections" stroke="#8764B8" fill="url(#gradConn)" strokeWidth={2} dot={false} />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>

                </div>
              )}
            </div>
          )}

          {/* ── TOP SQL TAB ── */}
          {activeTab === 'sql' && (
            <div>
              <div className="flex items-center justify-between mb-4">
                <p className="text-sm font-semibold text-brand-text-primary flex items-center gap-2">
                  <Table size={15} className="text-brand-primary" />
                  Top SQL Statements — last {hours}h
                  <span className="ml-1 text-xs font-normal bg-blue-50 text-blue-700 px-2 py-0.5 rounded-full">
                    {sqlList.length} statements
                  </span>
                </p>
              </div>
              {sqlLoading ? (
                <div className="flex justify-center h-64 items-center"><Spinner label="Analyzing SQL…" /></div>
              ) : sqlList.length === 0 ? (
                <div className="text-center py-20">
                  <Database size={40} className="mx-auto mb-3 opacity-30" />
                  <p className="text-brand-text-secondary">No SQL statements captured in this window.</p>
                  <p className="text-xs text-brand-text-secondary mt-1">Performance Schema must be enabled on the monitored server.</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b-2 border-gray-100">
                        <th className="px-4 py-2 text-left text-xs font-semibold text-brand-text-secondary uppercase">SQL ID</th>
                        <th className="px-4 py-2 text-right text-xs font-semibold text-brand-text-secondary uppercase">Executions</th>
                        <th className="px-4 py-2 text-right text-xs font-semibold text-brand-text-secondary uppercase">Avg Elapsed</th>
                        <th className="px-4 py-2 text-right text-xs font-semibold text-brand-text-secondary uppercase">CPU Time</th>
                        <th className="px-4 py-2 text-right text-xs font-semibold text-brand-text-secondary uppercase">Buffer Gets</th>
                        <th className="px-4 py-2 text-left text-xs font-semibold text-brand-text-secondary uppercase">Statement</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sqlList.map((row, i) => <SQLRow key={row.sql_id || i} row={row} idx={i} />)}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* ── WAIT EVENTS TAB ── */}
          {activeTab === 'waits' && (
            <div>
              <p className="text-sm font-semibold text-brand-text-primary mb-4 flex items-center gap-2">
                <HelpCircle size={15} className="text-brand-primary" />
                Database Wait Events — last {hours}h
                <span className="ml-1 text-xs font-normal bg-blue-50 text-blue-700 px-2 py-0.5 rounded-full">
                  {waitList.length} event types
                </span>
              </p>
              {waitsLoading ? (
                <div className="flex justify-center h-64 items-center"><Spinner label="Profiling waits…" /></div>
              ) : waitList.length === 0 ? (
                <div className="text-center py-20">
                  <Activity size={40} className="mx-auto mb-3 opacity-30" />
                  <p className="text-brand-text-secondary">No wait events recorded for this period.</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">

                  {/* Horizontal bar chart */}
                  <div className="lg:col-span-3">
                    <ResponsiveContainer width="100%" height={Math.max(260, waitList.length * 36)}>
                      <BarChart
                        data={waitList.slice(0, 15).map((w, i) => ({
                          name: w.event_name?.split('/').pop() || w.event_name,
                          full: w.event_name,
                          time: parseFloat((w.time_waited_ms || 0).toFixed(2)),
                          count: w.count,
                          color: waitColors[i % waitColors.length],
                        }))}
                        layout="vertical"
                        margin={{ top: 0, right: 30, left: 10, bottom: 0 }}
                      >
                        <CartesianGrid strokeDasharray="3 3" stroke="#F3F2F1" horizontal={false} />
                        <XAxis type="number" fontSize={10} tickLine={false} tickFormatter={v => `${v}ms`} />
                        <YAxis type="category" dataKey="name" width={150} fontSize={10} tickLine={false} />
                        <Tooltip
                          contentStyle={tooltipStyle}
                          formatter={(v, n, p) => [`${v} ms  (${p?.payload?.count} waits)`, p?.payload?.full]}
                        />
                        <Bar dataKey="time" name="Time Waited" radius={[0, 4, 4, 0]}>
                          {waitList.slice(0, 15).map((_, i) => (
                            <Cell key={i} fill={waitColors[i % waitColors.length]} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>

                  {/* Explanation panel */}
                  <div className="lg:col-span-2 space-y-3">
                    <div className="p-4 bg-slate-50 border border-brand-border rounded-xl text-xs text-brand-text-secondary space-y-3">
                      <h4 className="font-bold text-brand-text-primary text-sm flex items-center gap-2">
                        <HelpCircle size={14} /> Understanding Waits
                      </h4>
                      <ul className="space-y-2">
                        {[
                          ['User I/O', 'Waiting on storage reads/writes'],
                          ['System I/O', 'Redo log syncs, background writers'],
                          ['Concurrency', 'Lock contention, latches, row locks'],
                          ['Network', 'Client response, SQL*Net waits'],
                          ['CPU / Idle', 'Threads waiting for work'],
                        ].map(([k, v]) => (
                          <li key={k}><strong className="text-brand-text-primary">{k}:</strong> {v}</li>
                        ))}
                      </ul>
                    </div>
                    {/* Top 5 list */}
                    <div className="space-y-2">
                      <p className="text-xs font-semibold text-brand-text-secondary uppercase">Top Events by Time</p>
                      {waitList.slice(0, 6).map((w, i) => (
                        <WaitBar
                          key={i}
                          name={w.event_name}
                          value={w.time_waited_ms || 0}
                          max={waitMax}
                          color={waitColors[i % waitColors.length]}
                        />
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── ORACLE SNAPSHOT TAB ── */}
          {activeTab === 'snapshot' && isOracle && (
            <div>
              <p className="text-sm font-semibold text-brand-text-primary mb-4 flex items-center gap-2">
                <Database size={15} className="text-brand-primary" /> Oracle Instance Snapshot
              </p>
              {snapLoading ? (
                <div className="flex justify-center h-64 items-center"><Spinner label="Querying V$INSTANCE…" /></div>
              ) : !oracleSnap ? (
                <div className="text-center py-20 text-brand-text-secondary">No Oracle metadata available.</div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {[
                    ['Version',         oracleSnap.version],
                    ['Instance / SID',  oracleSnap.instance_name],
                    ['Startup Time',    new Date(oracleSnap.startup_time).toLocaleString()],
                    ['SGA Size',        formatBytes(oracleSnap.sga_size_bytes)],
                    ['PGA Size',        formatBytes(oracleSnap.pga_size_bytes)],
                    ['Log Mode',        `${oracleSnap.log_mode} (${oracleSnap.archiver})`],
                    ['Status',          oracleSnap.status],
                    ['Open Mode',       `${oracleSnap.open_mode} — ${oracleSnap.database_status}`],
                    ['Instance Role',   oracleSnap.instance_role],
                  ].map(([label, value]) => (
                    <div key={label} className="p-4 bg-gray-50 border border-brand-border rounded-xl">
                      <p className="text-[11px] text-brand-text-secondary uppercase font-semibold tracking-wide">{label}</p>
                      <p className="font-bold text-brand-text-primary mt-1 text-sm">{value || '—'}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

        </div>
      </div>
    </div>
  );
};
