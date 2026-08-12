import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Paged } from '@/components/ui/Pagination';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle, RefreshCw, FileText, ArrowLeft,
  CheckCircle2, XCircle, Info, AlertCircle, Search,
  Brain, Terminal, BarChart2,
  Server, Shield, Zap, Copy, Play, Settings, Eye, EyeOff,
  Download, Clock, Database, Activity,
} from 'lucide-react';
import client from '@/api/client';
import PageHeader from '@/components/layout/PageHeader';
import { PageLoading } from '@/components/ui/Loading';

// ─── API ─────────────────────────────────────────────────────────────────────

const fetchErrorLogs = (id) =>
  client.get(`/connections/mysql/${id}/error-logs`).then(r => r.data);

const analyzeGroq = (id, payload) =>
  client.post(`/connections/mysql/${id}/analyze-groq`, payload).then(r => r.data);

const saveSSHConfig = (id, payload) =>
  client.put(`/connections/mysql/${id}/ssh-config`, payload).then(r => r.data);

const getSSHConfig = (id) =>
  client.get(`/connections/mysql/${id}/ssh-config`).then(r => r.data);

// ─── Severity config ──────────────────────────────────────────────────────────

const SEV = {
  CRITICAL: { badge: 'bg-red-100 text-red-800 border border-red-200', row: 'bg-red-50', icon: XCircle, color: 'text-red-600' },
  ERROR:    { badge: 'bg-red-50 text-red-700 border border-red-100',   row: 'bg-rose-50/40', icon: AlertCircle, color: 'text-rose-500' },
  WARNING:  { badge: 'bg-amber-50 text-amber-700 border border-amber-100', row: 'bg-amber-50/40', icon: AlertTriangle, color: 'text-amber-500' },
  INFO:     { badge: 'bg-slate-100 text-slate-500',                    row: '', icon: Info, color: 'text-slate-400' },
};

// ─── SSH Config Modal ─────────────────────────────────────────────────────────

function SSHConfigModal({ id, sshData, onClose, onSaved }) {
  const [form, setForm] = useState({
    ssh_host: sshData?.ssh_host || '',
    ssh_port: sshData?.ssh_port || 22,
    ssh_user: sshData?.ssh_user || '',
    ssh_password: sshData?.ssh_password || '',
  });
  const [show, setShow] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);

  const handle = async () => {
    setSaving(true); setMsg(null);
    try {
      const res = await saveSSHConfig(id, {
        ssh_host: form.ssh_host || null,
        ssh_port: parseInt(form.ssh_port) || 22,
        ssh_user: form.ssh_user,
        ssh_password: form.ssh_password,
      });
      if (res.status === 'success') {
        setMsg({ ok: true, text: res.message || 'SSH credentials saved.' });
        setTimeout(() => { onSaved(form); onClose(); }, 1200);
      } else {
        setMsg({ ok: false, text: res.message || 'SSH test failed.' });
      }
    } catch (e) {
      setMsg({ ok: false, text: e.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md">
        <div className="bg-gradient-to-r from-slate-800 to-slate-700 text-white rounded-t-2xl px-5 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Settings size={16} className="text-cyan-300" />
            <span className="font-bold text-sm">SSH Configuration</span>
          </div>
          <button onClick={onClose} className="text-white/60 hover:text-white text-lg leading-none">✕</button>
        </div>
        <div className="p-5 space-y-3">
          <p className="text-xs text-slate-500">SSH credentials allow reading remote log files directly from the server.</p>
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <label className="text-xs font-semibold text-slate-500 mb-1 block">SSH Host (optional)</label>
              <input value={form.ssh_host} onChange={e => setForm(f => ({...f, ssh_host: e.target.value}))}
                placeholder="same as DB host"
                className="w-full border border-slate-200 rounded-xl px-3 h-9 text-sm outline-none focus:border-cyan-500" />
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-500 mb-1 block">Port</label>
              <input value={form.ssh_port} onChange={e => setForm(f => ({...f, ssh_port: e.target.value}))}
                type="number"
                className="w-full border border-slate-200 rounded-xl px-3 h-9 text-sm outline-none focus:border-cyan-500" />
            </div>
          </div>
          <div>
            <label className="text-xs font-semibold text-slate-500 mb-1 block">Username</label>
            <input value={form.ssh_user} onChange={e => setForm(f => ({...f, ssh_user: e.target.value}))}
              placeholder="suyash"
              className="w-full border border-slate-200 rounded-xl px-3 h-9 text-sm outline-none focus:border-cyan-500" />
          </div>
          <div>
            <label className="text-xs font-semibold text-slate-500 mb-1 block">Password</label>
            <div className="relative">
              <input value={form.ssh_password} onChange={e => setForm(f => ({...f, ssh_password: e.target.value}))}
                type={show ? 'text' : 'password'}
                className="w-full border border-slate-200 rounded-xl px-3 pr-10 h-9 text-sm outline-none focus:border-cyan-500" />
              <button onClick={() => setShow(s => !s)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                {show ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </div>
          {msg && (
            <div className={`rounded-xl px-3 py-2 text-xs font-semibold ${msg.ok ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>
              {msg.ok ? '✓ ' : '✗ '}{msg.text}
            </div>
          )}
          <button onClick={handle} disabled={saving || !form.ssh_user || !form.ssh_password}
            className="w-full h-10 rounded-xl bg-slate-900 text-white text-sm font-bold disabled:opacity-50 hover:bg-slate-700 transition-colors">
            {saving ? 'Testing & Saving…' : 'Test & Save SSH Config'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Terminal Line ────────────────────────────────────────────────────────────

function TermLine({ evt }) {
  if (!evt) return null;
  if (evt.type === 'cmd') return (
    <div className="mt-3 first:mt-0">
      <span className="text-green-400 select-none">$ </span>
      <span className="text-cyan-200 font-bold">{evt.cmd}</span>
    </div>
  );
  if (evt.type === 'stdout') return (
    <div className="text-green-300 whitespace-pre-wrap text-xs leading-relaxed pl-2">{evt.data}</div>
  );
  if (evt.type === 'stderr') return (
    <div className="text-red-400 whitespace-pre-wrap text-xs leading-relaxed pl-2">{evt.data}</div>
  );
  if (evt.type === 'error') return (
    <div className="text-red-400 font-semibold mt-1">✗ {evt.msg}</div>
  );
  if (evt.type === 'info') return (
    <div className="text-yellow-300 text-xs">⟳ {evt.msg}</div>
  );
  if (evt.type === 'connected') return (
    <div className="text-green-400 text-xs font-semibold">✓ {evt.msg}</div>
  );
  if (evt.type === 'done') return (
    <div className="text-green-300 font-bold text-sm border-t border-green-900/50 mt-3 pt-3">✓ {evt.msg}</div>
  );
  return null;
}

// ─── Severity Badge ───────────────────────────────────────────────────────────

function SevBadge({ sev }) {
  const cfg = SEV[sev] || SEV.INFO;
  const Icon = cfg.icon;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold ${cfg.badge}`}>
      <Icon size={9} /> {sev}
    </span>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

const TABS = [
  { id: 'logs',    label: 'Error Logs',  Icon: FileText },
  { id: 'ai',      label: 'AI Analysis', Icon: Brain },
  { id: 'heal',    label: 'Self-Heal',   Icon: Terminal },
  { id: 'reports', label: 'Reports',     Icon: BarChart2 },
];

export default function ErrorLogs() {
  const { id } = useParams();
  const [tab, setTab] = useState('logs');
  const [sev, setSev] = useState('ALL');
  const [search, setSearch] = useState('');
  const [showSSH, setShowSSH] = useState(false);
  const [sshData, setSshData] = useState(null);

  const [analysis, setAnalysis] = useState(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeErr, setAnalyzeErr] = useState(null);

  const [termLines, setTermLines] = useState([]);
  const [healing, setHealing] = useState(false);
  const [healCmds, setHealCmds] = useState([]);
  const [customCmd, setCustomCmd] = useState('');
  const termRef = useRef(null);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['mysqlErrorLogs', id],
    queryFn: () => fetchErrorLogs(id),
    retry: false,
    refetchInterval: 60000,
  });

  useEffect(() => {
    getSSHConfig(id).then(r => { if (r?.ssh_user) setSshData(r); }).catch(() => {});
  }, [id]);

  useEffect(() => {
    if (termRef.current) termRef.current.scrollTop = termRef.current.scrollHeight;
  }, [termLines]);

  // ─── AI Analysis ──────────────────────────────────────────────────────────

  const runAnalysis = useCallback(async () => {
    if (!data) return;
    setAnalyzing(true); setAnalyzeErr(null);
    try {
      const topLogs = (data.logs || [])
        .filter(l => ['CRITICAL', 'ERROR', 'WARNING'].includes(l.severity))
        .slice(0, 30);
      const res = await analyzeGroq(id, {
        logs: topLogs.length ? topLogs : (data.logs || []).slice(0, 20),
        log_path: data.log_path || '',
        source: data.source || '',
        host: '', database: '',
      });
      setAnalysis(res.analysis);
      if (res.analysis?.ssh_commands?.length) setHealCmds(res.analysis.ssh_commands);
    } catch (e) {
      setAnalyzeErr(e.message);
    } finally {
      setAnalyzing(false);
    }
  }, [data, id]);

  // ─── Self-Heal Stream ─────────────────────────────────────────────────────

  const runSelfHeal = useCallback(async (commands) => {
    if (!commands.length) return;
    setTermLines([]); setHealing(true);
    const token = localStorage.getItem('actmon_token');
    try {
      const resp = await fetch(`/api/v1/connections/mysql/${id}/self-heal-stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ commands }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop() || '';
        for (const part of parts) {
          for (const line of part.split('\n')) {
            if (line.startsWith('data: ')) {
              try {
                const evt = JSON.parse(line.slice(6));
                setTermLines(prev => [...prev, evt]);
              } catch {}
            }
          }
        }
      }
    } catch (e) {
      setTermLines(prev => [...prev, { type: 'error', msg: e.message }]);
    } finally {
      setHealing(false);
    }
  }, [id]);

  // ─── Derived ──────────────────────────────────────────────────────────────

  const logs     = data?.logs || [];
  const source   = data?.source || 'unknown';
  const logPath  = data?.log_path || '';
  const note     = data?.note || '';
  const summary  = data?.summary || {};
  const counts   = summary.severities || { CRITICAL: 0, ERROR: 0, WARNING: 0, INFO: 0 };
  const critErrors = (counts.CRITICAL || 0) + (counts.ERROR || 0);
  const hasSSH   = !!(sshData?.ssh_user);

  const filtered = logs.filter(l => {
    const okSev    = sev === 'ALL' || l.severity === sev;
    const okSearch = !search || (l.message || '').toLowerCase().includes(search.toLowerCase());
    return okSev && okSearch;
  });

  const sourceLabel = {
    performance_schema:        'performance_schema.error_log (SQL)',
    performance_schema_errors: 'performance_schema error summary',
    ssh_file:                  `SSH file: ${logPath}`,
    ssh_journald:              'SSH journald (systemd)',
    ssh_syslog:                `SSH syslog`,
    file:                      `Log file: ${logPath}`,
    none:                      'Not accessible — error logging disabled on server',
  }[source] || source;

  // Fix commands to enable MariaDB error logging (requires root via su)
  const FIX_CMDS = [
    "mkdir -p /var/log/mysql && chown mysql:adm /var/log/mysql && chmod 750 /var/log/mysql",
    "sed -i 's|^#log_error = /var/log/mysql/error.log|log_error = /var/log/mysql/error.log|' /etc/mysql/mariadb.conf.d/50-server.cnf",
    "sed -i 's/^skip_log_error/#skip_log_error/' /etc/mysql/mariadb.conf.d/50-mysqld_safe.cnf",
    "usermod -aG adm suyash",
    "systemctl restart mariadb",
    "ls -la /var/log/mysql/error.log && head -5 /var/log/mysql/error.log",
  ];

  const exportCSV = () => {
    const rows = [['Timestamp', 'Severity', 'Subsystem', 'Message']];
    logs.forEach(l => rows.push([l.logged || '', l.severity || '', l.subsystem || 'MySQL', (l.message || '').replace(/"/g, '""')]));
    const csv = rows.map(r => r.map(c => `"${c}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a'); a.href = url;
    a.download = `error-logs-conn${id}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  // ─── Loading / Error ──────────────────────────────────────────────────────

  if (isLoading) return (
    <PageLoading title="Loading error logs…" />
  );

  if (error) return (
    <div className="p-6">
      <div className="bg-red-50 border border-red-200 rounded-2xl p-6 max-w-lg">
        <AlertTriangle className="text-red-500 mb-2" size={20} />
        <p className="font-bold text-red-700">Failed to load error logs</p>
        <p className="text-sm text-red-600 mt-1">{error.message}</p>
        <button onClick={() => refetch()} className="mt-3 px-4 py-2 bg-red-600 text-white rounded-xl text-sm font-bold hover:bg-red-700">Retry</button>
      </div>
    </div>
  );

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <>
      {showSSH && (
        <SSHConfigModal id={id} sshData={sshData} onClose={() => setShowSSH(false)}
          onSaved={(d) => { setSshData(d); refetch(); }} />
      )}

      <div className="min-h-full bg-brand-bg">

        <PageHeader
          icon={FileText}
          title="Error Logs"
          subtitle={sourceLabel}
          accent="mysql"
          backTo={`/mysql-dashboard/${id}`}
          crumbs={[{ label: 'Databases', to: '/databases' }, { label: 'MySQL', to: `/mysql-dashboard/${id}` }, { label: 'Error Logs' }]}
          actions={(
            <>
              <button onClick={() => setShowSSH(true)}
                className={`flex items-center gap-2 px-3 py-1.5 border rounded-lg text-xs font-semibold ${
                  hasSSH
                    ? 'bg-green-500/20 hover:bg-green-500/30 border-green-400/30 text-green-200'
                    : 'bg-amber-500/20 hover:bg-amber-500/30 border-amber-400/30 text-amber-200'
                }`}>
                {hasSSH ? <><Shield size={12} /> SSH ✓</> : <><Settings size={12} /> SSH Config</>}
              </button>
              <button onClick={() => refetch()}
                className="flex items-center gap-2 px-3 py-1.5 bg-white/10 hover:bg-white/20 border border-white/20 rounded-lg text-xs font-semibold text-white">
                <RefreshCw size={12} /> Refresh
              </button>
            </>
          )}
        />

        <div className="py-5 space-y-4">

          {/* Tabs */}
          <div className="flex gap-1 flex-wrap">
            {TABS.map(({ id: tid, label, Icon }) => (
              <button key={tid} onClick={() => setTab(tid)}
                className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all ${
                  tab === tid ? 'bg-slate-900 text-white shadow' : 'text-slate-500 hover:text-slate-800 hover:bg-slate-100'
                }`}>
                <Icon size={14} /> {label}
                {tid === 'heal' && termLines.length > 0 && (
                  <span className="w-2 h-2 rounded-full bg-green-400 flex-shrink-0" />
                )}
              </button>
            ))}
          </div>

          {/* Severity cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {['CRITICAL', 'ERROR', 'WARNING', 'INFO'].map(s => {
              const cfg = SEV[s];
              const Icon = cfg.icon;
              const active = sev === s && tab === 'logs';
              return (
                <button key={s} onClick={() => { setSev(active ? 'ALL' : s); setTab('logs'); }}
                  className={`rounded-2xl border p-4 text-left hover:shadow-md transition-all ${
                    active ? `${cfg.badge} border-2 shadow-md` : 'bg-white border-slate-200'
                  }`}>
                  <div className="flex justify-between items-start">
                    <div>
                      <p className="text-[10px] font-bold text-slate-400 uppercase">{s}</p>
                      <p className={`text-2xl font-black mt-1 ${cfg.color}`}>{counts[s] || 0}</p>
                    </div>
                    <Icon size={18} className={cfg.color} />
                  </div>
                </button>
              );
            })}
          </div>

          {/* Alert banner */}
          {critErrors > 0 && tab !== 'ai' && (
            <div className="bg-red-50 border border-red-200 rounded-2xl p-3 flex items-center gap-3">
              <AlertTriangle className="text-red-500 flex-shrink-0" size={16} />
              <span className="text-red-700 text-sm font-semibold">
                {critErrors} critical/error event{critErrors !== 1 ? 's' : ''} detected
              </span>
              {/* "Analyze with AI" removed from this banner on request — the
                  AI Analysis tab above still reaches the same analysis. */}
            </div>
          )}

          {/* ── TAB: ERROR LOGS ─────────────────────────────────────── */}
          {tab === 'logs' && (
            <>
              <div className="bg-white rounded-2xl border border-slate-200 p-3 flex flex-wrap gap-3 items-center">
                <div className="flex gap-1 flex-wrap">
                  {['ALL', 'CRITICAL', 'ERROR', 'WARNING', 'INFO'].map(s => (
                    <button key={s} onClick={() => setSev(s)}
                      className={`px-3 h-7 rounded-lg text-xs font-bold transition-all ${
                        sev === s ? 'bg-slate-900 text-white' : 'border border-slate-200 text-slate-600 hover:bg-slate-50'
                      }`}>
                      {s === 'ALL' ? `All (${logs.length})` : `${s} (${counts[s] || 0})`}
                    </button>
                  ))}
                </div>
                <div className="relative ml-auto">
                  <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input value={search} onChange={e => setSearch(e.target.value)}
                    placeholder="Search messages…"
                    className="pl-7 pr-3 h-8 rounded-xl border border-slate-200 text-xs outline-none focus:border-cyan-500 w-56" />
                </div>
                <span className="text-xs text-slate-400">{filtered.length} entries</span>
              </div>

              <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
                {logs.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-10 text-center px-6">
                    {source === 'none' ? (
                      <>
                        <AlertTriangle size={32} className="text-amber-400 mb-3" />
                        <p className="font-semibold text-slate-700 text-base">Error logging is disabled on the server</p>
                        <p className="text-xs text-slate-500 mt-2 max-w-lg leading-relaxed">
                          MariaDB is configured with <code className="bg-slate-100 px-1 rounded">skip_log_error</code> and
                          no <code className="bg-slate-100 px-1 rounded">log_error</code> path is set.
                          Error logs go to journald but <strong>suyash</strong> is not in the <strong>adm</strong> group.
                        </p>
                        <div className="mt-5 flex flex-wrap gap-3 justify-center">
                          {!hasSSH && (
                            <button onClick={() => setShowSSH(true)}
                              className="px-4 py-2 bg-slate-900 text-white rounded-xl text-xs font-bold hover:bg-slate-700 flex items-center gap-2">
                              <Settings size={13} /> Configure SSH First
                            </button>
                          )}
                          {hasSSH && (
                            <button onClick={() => {
                              setHealCmds(FIX_CMDS);
                              setTab('heal');
                            }}
                              className="px-4 py-2 bg-green-600 text-white rounded-xl text-xs font-bold hover:bg-green-700 flex items-center gap-2">
                              <Terminal size={13} /> Fix Server (Enable Error Logging)
                            </button>
                          )}
                          <button onClick={() => setShowSSH(true)}
                            className={`px-4 py-2 border rounded-xl text-xs font-bold flex items-center gap-2 ${
                              hasSSH ? 'border-green-200 text-green-700 bg-green-50 hover:bg-green-100' : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                            }`}>
                            <Shield size={13} /> {hasSSH ? 'SSH ✓ Configured' : 'Configure SSH'}
                          </button>
                        </div>
                        <div className="mt-4 bg-slate-900 rounded-xl p-3 text-left w-full max-w-xl">
                          <p className="text-slate-400 text-[10px] font-bold mb-2 uppercase tracking-wide">Commands needed (as root on the server):</p>
                          {FIX_CMDS.map((cmd, i) => (
                            <div key={i} className="flex items-center gap-2 py-0.5">
                              <span className="text-green-400 font-mono text-xs">$ {cmd}</span>
                            </div>
                          ))}
                        </div>
                        {note && (
                          <p className="text-[11px] text-slate-400 mt-3 max-w-lg leading-relaxed">{note}</p>
                        )}
                      </>
                    ) : (
                      <>
                        <CheckCircle2 size={32} className="text-green-400 mb-3" />
                        <p className="font-semibold text-slate-700">No log entries found</p>
                        <p className="text-xs text-slate-400 mt-2">{note || 'Database appears healthy.'}</p>
                      </>
                    )}
                  </div>
                ) : filtered.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12">
                    <p className="text-slate-400 text-sm">No entries match the current filter</p>
                  </div>
                ) : (
                  <div className="overflow-auto max-h-[600px]">
                    <Paged rows={filtered} unit="log entries">{(pageRows, pager) => (<>
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-white border-b border-slate-200 z-10">
                        <tr>
                          <th className="px-4 py-3 text-left font-bold text-[11px] text-slate-400 whitespace-nowrap">Timestamp</th>
                          <th className="px-3 py-3 text-left font-bold text-[11px] text-slate-400 whitespace-nowrap">Severity</th>
                          <th className="px-3 py-3 text-left font-bold text-[11px] text-slate-400 whitespace-nowrap">Subsystem</th>
                          <th className="px-3 py-3 text-left font-bold text-[11px] text-slate-400">Message</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pageRows.map((log, i) => (
                          <tr key={i} className={`border-t border-slate-100 ${SEV[log.severity]?.row || ''}`}>
                            <td className="px-4 py-2 font-mono text-slate-500 whitespace-nowrap text-[11px]">{log.logged || '—'}</td>
                            <td className="px-3 py-2"><SevBadge sev={log.severity} /></td>
                            <td className="px-3 py-2 text-slate-400 whitespace-nowrap">{log.subsystem || 'MySQL'}</td>
                            <td className="px-3 py-2 text-slate-700 max-w-2xl break-words">{log.message}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {pager}
                    </>)}</Paged>
                  </div>
                )}
              </div>

              {note && (
                <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-2 text-xs text-amber-700">
                  ⚠ {note}
                </div>
              )}
            </>
          )}

          {/* ── TAB: AI ANALYSIS ────────────────────────────────────── */}
          {tab === 'ai' && (
            <div className="space-y-4">
              {!analysis && !analyzing && (
                <div className="bg-white rounded-2xl border border-slate-200 p-8 text-center">
                  <Brain size={40} className="text-purple-400 mx-auto mb-4" />
                  <p className="font-semibold text-slate-700 text-lg mb-2">ActMon AI Error Analysis</p>
                  <p className="text-sm text-slate-400 mb-6 max-w-md mx-auto">
                    Powered by <strong>ActMon AI Engine</strong>. Analyzes error patterns,
                    identifies root causes, and generates actionable fix commands.
                  </p>
                  <button onClick={runAnalysis}
                    className="px-6 py-3 bg-purple-600 text-white rounded-xl text-sm font-bold hover:bg-purple-700 flex items-center gap-2 mx-auto">
                    <Zap size={16} /> Analyze Error Logs with ActMon AI
                  </button>
                  {analyzeErr && <p className="text-red-500 text-xs mt-4">Error: {analyzeErr}</p>}
                </div>
              )}

              {analyzing && (
                <div className="bg-white rounded-2xl border border-slate-200 p-8 text-center">
                  <div className="w-12 h-12 border-4 border-purple-200 border-t-purple-600 rounded-full animate-spin mx-auto mb-4" />
                  <p className="font-semibold text-slate-700">Analyzing with ActMon AI…</p>
                  <p className="text-xs text-slate-400 mt-1">ActMon AI Engine is reviewing your error logs</p>
                </div>
              )}

              {analysis && !analyzing && (
                <>
                  <div className={`rounded-2xl p-4 border flex items-start gap-4 ${
                    analysis.severity === 'CRITICAL' ? 'bg-red-50 border-red-200' :
                    analysis.severity === 'ERROR'    ? 'bg-rose-50 border-rose-200' :
                    analysis.severity === 'WARNING'  ? 'bg-amber-50 border-amber-200' :
                    'bg-green-50 border-green-200'
                  }`}>
                    <div className="flex-1">
                      <div className="flex items-center gap-3 mb-2">
                        <SevBadge sev={analysis.severity || 'INFO'} />
                        <span className="text-xs font-semibold text-slate-500 flex items-center gap-1">
                          <Clock size={11} /> Est. fix: {analysis.estimated_fix_time || 'Unknown'}
                        </span>
                      </div>
                      <p className="font-bold text-slate-800 text-base">{analysis.summary}</p>
                    </div>
                    <button onClick={runAnalysis} title="Re-analyze" className="text-slate-400 hover:text-slate-600 p-1">
                      <RefreshCw size={14} />
                    </button>
                  </div>

                  <div className="grid md:grid-cols-2 gap-4">
                    <div className="bg-white rounded-2xl border border-slate-200 p-4">
                      <h3 className="font-bold text-slate-700 text-sm mb-2 flex items-center gap-2">
                        <Search size={14} className="text-purple-500" /> Root Cause
                      </h3>
                      <p className="text-sm text-slate-600 leading-relaxed">{analysis.root_cause}</p>
                    </div>
                    <div className="bg-white rounded-2xl border border-slate-200 p-4">
                      <h3 className="font-bold text-slate-700 text-sm mb-2 flex items-center gap-2">
                        <Activity size={14} className="text-amber-500" /> Business Impact
                      </h3>
                      <p className="text-sm text-slate-600 leading-relaxed">{analysis.business_impact}</p>
                    </div>
                  </div>

                  {analysis.error_patterns?.length > 0 && (
                    <div className="bg-white rounded-2xl border border-slate-200 p-4">
                      <h3 className="font-bold text-slate-700 text-sm mb-3 flex items-center gap-2">
                        <AlertCircle size={14} className="text-red-500" /> Detected Error Patterns
                      </h3>
                      <div className="flex flex-wrap gap-2">
                        {analysis.error_patterns.map((p, i) => (
                          <span key={i} className="px-3 py-1 rounded-lg bg-red-50 text-red-700 text-xs font-semibold border border-red-100">{p}</span>
                        ))}
                      </div>
                    </div>
                  )}

                  {analysis.fix_steps?.length > 0 && (
                    <div className="bg-white rounded-2xl border border-slate-200 p-4">
                      <h3 className="font-bold text-slate-700 text-sm mb-3 flex items-center gap-2">
                        <CheckCircle2 size={14} className="text-green-500" /> Fix Steps
                      </h3>
                      <ol className="space-y-2">
                        {analysis.fix_steps.map((step, i) => (
                          <li key={i} className="flex items-start gap-3 text-sm text-slate-600">
                            <span className="w-6 h-6 rounded-full bg-slate-100 text-slate-500 font-bold text-xs flex items-center justify-center flex-shrink-0 mt-0.5">{i + 1}</span>
                            {step}
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}

                  {analysis.ssh_commands?.length > 0 && (
                    <div className="bg-white rounded-2xl border border-slate-200 p-4">
                      <div className="flex items-center justify-between mb-3">
                        <h3 className="font-bold text-slate-700 text-sm flex items-center gap-2">
                          <Terminal size={14} /> SSH Commands to Run
                        </h3>
                        <button onClick={() => { setHealCmds(analysis.ssh_commands); setTab('heal'); }}
                          className="flex items-center gap-2 px-3 h-7 rounded-lg bg-green-600 text-white text-xs font-bold hover:bg-green-700">
                          <Play size={11} /> Run Auto-Fix
                        </button>
                      </div>
                      <div className="space-y-2">
                        {analysis.ssh_commands.map((cmd, i) => (
                          <div key={i} className="flex items-center gap-3 bg-slate-900 rounded-xl px-4 py-2">
                            <span className="text-green-400 text-xs font-mono flex-1">{cmd}</span>
                            <button onClick={() => navigator.clipboard.writeText(cmd)} className="text-slate-500 hover:text-slate-300 flex-shrink-0">
                              <Copy size={12} />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {analysis.mysql_commands?.length > 0 && (
                    <div className="bg-white rounded-2xl border border-slate-200 p-4">
                      <h3 className="font-bold text-slate-700 text-sm mb-3 flex items-center gap-2">
                        <Database size={14} className="text-cyan-500" /> MySQL Diagnostic Commands
                      </h3>
                      <div className="space-y-2">
                        {analysis.mysql_commands.map((cmd, i) => (
                          <div key={i} className="flex items-center gap-3 bg-cyan-50 rounded-xl px-4 py-2 border border-cyan-100">
                            <span className="text-cyan-800 text-xs font-mono flex-1">{cmd}</span>
                            <button onClick={() => navigator.clipboard.writeText(cmd)} className="text-cyan-400 hover:text-cyan-600 flex-shrink-0">
                              <Copy size={12} />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {analysis.preventive_measures?.length > 0 && (
                    <div className="bg-white rounded-2xl border border-slate-200 p-4">
                      <h3 className="font-bold text-slate-700 text-sm mb-3 flex items-center gap-2">
                        <Shield size={14} className="text-blue-500" /> Preventive Measures
                      </h3>
                      <ul className="space-y-1">
                        {analysis.preventive_measures.map((m, i) => (
                          <li key={i} className="text-sm text-slate-600 flex items-start gap-2">
                            <span className="text-blue-400 mt-0.5">•</span> {m}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* ── TAB: SELF-HEAL TERMINAL ──────────────────────────────── */}
          {tab === 'heal' && (
            <div className="space-y-4">
              {!hasSSH && (
                <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 flex items-start gap-3">
                  <AlertTriangle size={16} className="text-amber-500 flex-shrink-0 mt-0.5" />
                  <div className="flex-1">
                    <p className="font-semibold text-amber-800 text-sm">SSH not configured</p>
                    <p className="text-xs text-amber-600 mt-0.5">Configure SSH credentials to run commands on the remote server.</p>
                  </div>
                  <button onClick={() => setShowSSH(true)}
                    className="px-3 h-8 rounded-xl bg-amber-600 text-white text-xs font-bold hover:bg-amber-700 flex-shrink-0">
                    Configure SSH
                  </button>
                </div>
              )}

              <div className="bg-white rounded-2xl border border-slate-200 p-4">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="font-bold text-slate-700 text-sm flex items-center gap-2">
                    <Terminal size={14} /> Commands to Execute
                  </h3>
                  {!analysis && (
                    <button onClick={() => { setTab('ai'); runAnalysis(); }}
                      className="text-xs text-purple-600 hover:text-purple-800 flex items-center gap-1 font-semibold">
                      <Brain size={12} /> Get from AI
                    </button>
                  )}
                </div>

                {healCmds.length === 0 ? (
                  <div className="text-center py-8 text-slate-400">
                    <Terminal size={24} className="mx-auto mb-2 text-slate-300" />
                    <p className="text-sm">No commands yet.</p>
                    <p className="text-sm">Run AI Analysis to get suggested commands, or add manually below.</p>
                  </div>
                ) : (
                  <div className="space-y-1 mb-3">
                    {healCmds.map((cmd, i) => (
                      <div key={i} className="flex items-center gap-2 bg-slate-800 rounded-xl px-3 py-2 group">
                        <span className="text-green-400 text-xs font-mono flex-1">{cmd}</span>
                        <button onClick={() => setHealCmds(prev => prev.filter((_, j) => j !== i))}
                          className="text-slate-600 group-hover:text-red-400 text-xs font-bold px-1">✕</button>
                      </div>
                    ))}
                  </div>
                )}

                <div className="flex gap-2 mt-2">
                  <input value={customCmd} onChange={e => setCustomCmd(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && customCmd.trim()) { setHealCmds(p => [...p, customCmd.trim()]); setCustomCmd(''); }}}
                    placeholder="Add command and press Enter…"
                    className="flex-1 border border-slate-200 rounded-xl px-3 h-9 text-xs font-mono outline-none focus:border-cyan-500" />
                  <button onClick={() => { if (customCmd.trim()) { setHealCmds(p => [...p, customCmd.trim()]); setCustomCmd(''); }}}
                    className="px-3 h-9 rounded-xl bg-slate-200 text-slate-700 text-xs font-bold hover:bg-slate-300">
                    Add
                  </button>
                </div>

                {healCmds.length > 0 && (
                  <div className="flex gap-2 mt-3 pt-3 border-t border-slate-100">
                    <button onClick={() => runSelfHeal(healCmds)} disabled={healing || !hasSSH}
                      className="flex items-center gap-2 px-4 h-9 rounded-xl bg-green-600 text-white text-xs font-bold hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed">
                      {healing
                        ? <><div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Running…</>
                        : <><Play size={12} /> Run {healCmds.length} Command{healCmds.length !== 1 ? 's' : ''}</>
                      }
                    </button>
                    <button onClick={() => { setHealCmds([]); setTermLines([]); }}
                      className="px-3 h-9 rounded-xl border border-slate-200 text-slate-600 text-xs font-semibold hover:bg-slate-50">
                      Clear All
                    </button>
                  </div>
                )}
              </div>

              {(termLines.length > 0 || healing) && (
                <div className="bg-slate-950 rounded-2xl overflow-hidden border border-slate-800">
                  <div className="bg-slate-900 px-4 py-2 flex items-center gap-3 border-b border-slate-800">
                    <div className="flex gap-1.5">
                      <div className="w-3 h-3 rounded-full bg-red-500" />
                      <div className="w-3 h-3 rounded-full bg-amber-400" />
                      <div className="w-3 h-3 rounded-full bg-green-400" />
                    </div>
                    <span className="text-slate-400 text-xs font-mono flex-1">
                      Self-Heal Terminal — {sshData?.ssh_host || sshData?.ssh_user || 'remote'}
                    </span>
                    {healing
                      ? <div className="flex items-center gap-1.5 text-green-400 text-xs"><div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" /> Running</div>
                      : <span className="text-slate-500 text-xs">Done</span>
                    }
                  </div>
                  <div ref={termRef} className="p-4 font-mono text-sm overflow-auto max-h-[500px] space-y-0.5">
                    {termLines.map((evt, i) => <TermLine key={i} evt={evt} />)}
                    {healing && (
                      <div className="flex items-center gap-2 text-green-400 mt-2">
                        <div className="w-2 h-2 rounded-full bg-green-400 animate-ping" />
                        <span className="text-xs">Executing…</span>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── TAB: REPORTS ─────────────────────────────────────────── */}
          {tab === 'reports' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="font-bold text-slate-700">Error Log Report</h2>
                <button onClick={exportCSV}
                  className="flex items-center gap-2 px-4 h-9 rounded-xl border border-slate-200 text-slate-700 text-xs font-semibold hover:bg-slate-50">
                  <Download size={13} /> Export CSV
                </button>
              </div>

              <div className="grid md:grid-cols-2 gap-4">
                <div className="bg-white rounded-2xl border border-slate-200 p-4">
                  <h3 className="font-bold text-slate-700 text-sm mb-3 flex items-center gap-2">
                    <AlertCircle size={14} className="text-red-500" /> Severity Breakdown
                  </h3>
                  <div className="space-y-2">
                    {['CRITICAL', 'ERROR', 'WARNING', 'INFO'].map(s => {
                      const cnt = counts[s] || 0;
                      const pct = logs.length ? Math.round((cnt / logs.length) * 100) : 0;
                      const cfg = SEV[s];
                      return (
                        <div key={s}>
                          <div className="flex items-center justify-between text-xs mb-1">
                            <span className={`font-bold ${cfg.color}`}>{s}</span>
                            <span className="text-slate-400">{cnt} ({pct}%)</span>
                          </div>
                          <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                            <div className={`h-full rounded-full ${
                              s === 'CRITICAL' ? 'bg-red-600' : s === 'ERROR' ? 'bg-red-400' :
                              s === 'WARNING'  ? 'bg-amber-400' : 'bg-slate-300'
                            }`} style={{ width: `${pct}%` }} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="bg-white rounded-2xl border border-slate-200 p-4">
                  <h3 className="font-bold text-slate-700 text-sm mb-3 flex items-center gap-2">
                    <Activity size={14} className="text-blue-500" /> Log Summary
                  </h3>
                  <div className="space-y-2">
                    {[
                      ['Total Entries', logs.length],
                      ['Critical + Errors', critErrors],
                      ['Warnings', counts.WARNING || 0],
                      ['Info / System', counts.INFO || 0],
                      ['Data Source', sourceLabel],
                      ['Log Path', logPath || 'N/A'],
                    ].map(([label, val]) => (
                      <div key={label} className="flex items-center justify-between py-1 border-b border-slate-50">
                        <span className="text-slate-400 text-xs">{label}</span>
                        <span className="font-semibold text-slate-700 text-xs text-right max-w-[200px] break-all">{val}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {critErrors > 0 && (
                <div className="bg-white rounded-2xl border border-slate-200 p-4">
                  <h3 className="font-bold text-slate-700 text-sm mb-3 flex items-center gap-2">
                    <XCircle size={14} className="text-red-500" /> Top Critical &amp; Errors
                  </h3>
                  <div className="space-y-2">
                    {logs.filter(l => ['CRITICAL', 'ERROR'].includes(l.severity)).slice(0, 10).map((log, i) => (
                      <div key={i} className="flex items-start gap-3 p-3 bg-red-50 rounded-xl border border-red-100">
                        <SevBadge sev={log.severity} />
                        <div className="flex-1 min-w-0">
                          <p className="text-xs text-slate-700 break-words leading-relaxed">{log.message}</p>
                          {log.logged && <p className="text-[10px] text-slate-400 mt-1 font-mono">{log.logged}</p>}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

        </div>
      </div>
    </>
  );
}
