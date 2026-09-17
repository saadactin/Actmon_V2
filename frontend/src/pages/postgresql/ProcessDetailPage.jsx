import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { HardDrive, Save, FileText, RefreshCw, Archive, GitBranch, ChevronDown, Sparkles, Loader2 } from 'lucide-react';
import cn from '@/lib/cn';
import client, { TOKEN_KEY } from '@/api/client';
import { APP } from '@/config/app.config';
import PageHeader from '@/components/layout/PageHeader';
import Badge from '@/components/ui/Badge';
import { PageLoading } from '@/components/ui/Loading';
import { TypingDots } from '@/components/chat/ChatWidget';
import { fullTime } from '@/lib/format';
import PerfTrendChart from './PerfTrendChart';

const AI_LANGUAGES = [
  'English', 'Hindi', 'Marathi', 'Spanish', 'French', 'German', 'Portuguese',
  'Arabic', 'Chinese (Simplified)', 'Japanese', 'Russian',
];

const ICON_MAP = { HardDrive, Save, FileText, RefreshCw, Archive, GitBranch };
const STATUS_TONE = { good: 'success', warning: 'warning', critical: 'danger', unknown: 'neutral' };
const STATUS_LABEL = { good: 'Healthy', warning: 'Warning', critical: 'Critical', unknown: 'Unavailable' };
const REFRESH_OPTIONS = [
  { id: 5000, label: '5 sec' }, { id: 10000, label: '10 sec' },
  { id: 30000, label: '30 sec' }, { id: 60000, label: '1 min' },
];

const KPI_LABELS = {
  buffers_clean_per_sec: 'Buffers Written/sec',
  buffers_alloc_per_sec: 'Buffers Allocated/sec',
  buffers_backend_per_sec: 'Direct Backend Writes/sec',
  buffers_checkpoint_per_sec: 'Checkpoint Buffers/sec',
  checkpoints_timed_per_sec: 'Scheduled Checkpoints/sec',
  checkpoints_req_per_sec: 'Requested Checkpoints/sec',
  checkpoint_write_time_per_sec: 'Write Time (ms/sec)',
  checkpoint_sync_time_per_sec: 'Sync Time (ms/sec)',
  wal_bytes_per_sec: 'WAL Generation',
  wal_records_per_sec: 'WAL Records/sec',
  wal_write_per_sec: 'WAL Writes/sec',
  wal_sync_per_sec: 'WAL Syncs/sec',
  wal_write_time_per_sec: 'WAL Write Time (ms/sec)',
  wal_sync_time_per_sec: 'WAL Sync Time (ms/sec)',
  archived_count_per_sec: 'Archive Rate/sec',
  failed_count_per_sec: 'Failed/sec',
};

// One entry per process — the 2-4 charts its detail page shows, sourced
// from the SAME /performance/history rate fields the Performance tab's own
// trend charts already use (see postgres_perf_history_service.py). Never a
// new endpoint per process — the history endpoint already computes every
// field any of these processes could ever need.
const PROCESS_CHARTS = {
  bgwriter: [
    { title: 'Buffers Written/sec', series: [{ key: 'buffers_clean_per_sec', label: 'Buffers Clean/sec', color: 'var(--chart-1)' }] },
    { title: 'Buffers Allocated/sec', series: [{ key: 'buffers_alloc_per_sec', label: 'Buffers Alloc/sec', color: 'var(--chart-3)' }] },
    { title: 'Backend Writes/sec', series: [{ key: 'buffers_backend_per_sec', label: 'Backend Writes/sec', color: 'var(--chart-4)' }] },
    { title: 'Checkpoint Buffer Activity', series: [{ key: 'buffers_checkpoint_per_sec', label: 'Checkpoint Buffers/sec', color: 'var(--chart-8)' }] },
  ],
  checkpointer: [
    { title: 'Checkpoint Activity', series: [
      { key: 'checkpoints_timed_per_sec', label: 'Timed/sec', color: 'var(--chart-3)' },
      { key: 'checkpoints_req_per_sec', label: 'Requested/sec', color: 'var(--chart-8)' },
    ] },
    { title: 'Write Time', series: [{ key: 'checkpoint_write_time_per_sec', label: 'Write Time (ms/sec)', color: 'var(--chart-4)' }] },
    { title: 'Sync Time', series: [{ key: 'checkpoint_sync_time_per_sec', label: 'Sync Time (ms/sec)', color: 'var(--chart-1)' }] },
    { title: 'Buffers Written', series: [{ key: 'buffers_checkpoint_per_sec', label: 'Buffers/sec', color: 'var(--chart-8)' }] },
  ],
  walwriter: [
    { title: 'WAL Generation', series: [{ key: 'wal_bytes_per_sec', label: 'Bytes/sec', color: 'var(--chart-1)' }] },
    { title: 'WAL Write Rate', series: [{ key: 'wal_write_per_sec', label: 'Writes/sec', color: 'var(--chart-3)' }] },
    { title: 'WAL Sync Rate', series: [{ key: 'wal_sync_per_sec', label: 'Syncs/sec', color: 'var(--chart-4)' }] },
    { title: 'WAL Write Time', series: [{ key: 'wal_write_time_per_sec', label: 'Write Time (ms/sec)', color: 'var(--chart-8)' }] },
  ],
  archiver: [
    { title: 'Archive Rate', series: [{ key: 'archived_count_per_sec', label: 'Archived/sec', color: 'var(--chart-3)' }] },
  ],
  autovacuum: [],
  logical_replication: [],
};

function fmtBytes(v) {
  const abs = Math.abs(v);
  if (abs >= 1_073_741_824) return `${(v / 1_073_741_824).toFixed(2)} GB`;
  if (abs >= 1_048_576) return `${(v / 1_048_576).toFixed(2)} MB`;
  if (abs >= 1024) return `${(v / 1024).toFixed(2)} KB`;
  return `${v.toFixed(0)} B`;
}
function fmtKpiValue(key, value) {
  if (value === null || value === undefined) return '—';
  if (key === 'wal_bytes_per_sec') return `${fmtBytes(value)}/sec`;
  return Number(value).toFixed(2);
}

const STARTER_QUESTIONS = [
  'What do these current numbers mean?',
  'Is this healthy right now?',
  'What would make this process behave differently?',
];

function AiChatPanel({ connId, processId }) {
  const [language, setLanguage] = useState('English');
  const [messages, setMessages] = useState([]); // [{role:'user'|'assistant', content}]
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Streamed the same way the app's main AI chat is (fetch + ReadableStream
  // of SSE frames) — the Groq call itself isn't instant, but a one-shot
  // "wait for the full answer" request made it FEEL far slower than it is,
  // since nothing appeared until the entire response was ready.
  const send = async (text) => {
    const question = (text ?? input).trim();
    if (!question || loading) return;
    const history = messages.map(({ role, content }) => ({ role, content }));
    setMessages((m) => [...m, { role: 'user', content: question }, { role: 'assistant', content: '' }]);
    setInput('');
    setError(null);
    setLoading(true);

    const setAssistant = (patch) => {
      setMessages((m) => m.map((msg, i) => (i === m.length - 1 ? { ...msg, ...patch } : msg)));
    };

    try {
      const token = localStorage.getItem(TOKEN_KEY);
      const res = await fetch(`${APP.apiBase}/connections/postgresql/${connId}/processes/${processId}/ask`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ question, history, language }),
      });
      if (!res.ok || !res.body) throw new Error(`Request failed (${res.status})`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let text2 = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const frames = buf.split('\n\n');
        buf = frames.pop() ?? '';
        for (const frame of frames) {
          const line = frame.split('\n').find((l) => l.startsWith('data:'));
          if (!line) continue;
          let evt;
          try { evt = JSON.parse(line.slice(5).trim()); } catch { continue; }
          if (evt.type === 'token') {
            text2 += evt.text ?? '';
            setAssistant({ content: text2 });
          } else if (evt.type === 'error') {
            setError(evt.error || 'Something went wrong.');
            setMessages((m) => m.slice(0, -1));
          }
        }
      }
    } catch (e) {
      setError(e.message || 'Request failed.');
      setMessages((m) => m.slice(0, -1));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="card flex flex-col gap-3 p-card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-[13px] font-bold text-fg">
          <Sparkles size={15} className="text-accent-text" /> ActMon AI
        </h3>
        <select
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
          className="rounded-control border border-border bg-surface px-2 py-1 text-[11px] font-semibold text-fg"
        >
          {AI_LANGUAGES.map((l) => <option key={l} value={l}>{l}</option>)}
        </select>
      </div>

      {messages.length === 0 ? (
        <div className="space-y-2">
          <p className="text-[12px] text-subtle">
            Ask anything about this process — what the numbers mean, whether it's healthy, what to do about it — grounded in its live data right now.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {STARTER_QUESTIONS.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => send(q)}
                className="rounded-control border border-border bg-surface px-2.5 py-1 text-[11px] font-semibold text-muted transition-colors hover:bg-sunken hover:text-fg"
              >
                {q}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="max-h-96 space-y-3 overflow-y-auto">
          {messages.map((m, i) => {
            const isStreamingPlaceholder = loading && i === messages.length - 1 && m.role === 'assistant' && !m.content;
            return (
              <div key={i} className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}>
                <div className={cn(
                  'max-w-[85%] whitespace-pre-wrap rounded-control px-3 py-2 text-[12.5px]',
                  m.role === 'user' ? 'bg-accent-soft text-accent-text' : 'bg-sunken text-fg',
                )}>
                  {isStreamingPlaceholder ? <TypingDots /> : m.content}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {error && <p className="text-[12px] font-semibold text-danger-fg">{error}</p>}

      <form
        onSubmit={(e) => { e.preventDefault(); send(); }}
        className="flex items-center gap-2 border-t border-border pt-3"
      >
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask a question about this process…"
          disabled={loading}
          className="min-w-0 flex-1 rounded-control border border-border bg-surface px-3 py-2 text-[12.5px] text-fg placeholder:text-subtle disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={loading || !input.trim()}
          className="flex items-center gap-1.5 rounded-control bg-accent-soft px-3 py-2 text-[11.5px] font-bold text-accent-text transition-colors hover:brightness-95 disabled:opacity-60"
        >
          {loading ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
          Ask
        </button>
      </form>
    </div>
  );
}

function TechRow({ label, value, mono }) {
  return (
    <div>
      <p className="text-subtle">{label}</p>
      <p className={cn('font-semibold text-fg', mono && 'font-mono')}>{value ?? '—'}</p>
    </div>
  );
}

function AutovacuumDetail({ detail }) {
  return (
    <div className="card space-y-3 p-card">
      <h3 className="text-[13px] font-bold text-fg">Current Status</h3>
      <div className="grid grid-cols-2 gap-3 text-[12px] sm:grid-cols-4">
        <TechRow label="Active Workers" value={detail.active_workers} />
        <TechRow label="Dead Tuples" value={detail.dead_tuples?.toLocaleString()} />
        <TechRow label="Last Vacuum" value={detail.last_vacuum ? fullTime(detail.last_vacuum) : 'Never'} />
        <TechRow label="Last Analyze" value={detail.last_analyze ? fullTime(detail.last_analyze) : 'Never'} />
      </div>
      {detail.tables_being_vacuumed?.length > 0 && (
        <div>
          <p className="mb-1.5 text-[11px] font-bold tracking-wide text-subtle uppercase">Tables Being Vacuumed</p>
          <div className="overflow-x-auto rounded-control border border-border">
            <table className="w-full text-[12px]">
              <thead><tr className="bg-sunken text-left text-subtle"><th className="px-3 py-1.5">Table</th><th className="px-3 py-1.5">Phase</th><th className="px-3 py-1.5">Progress</th></tr></thead>
              <tbody>
                {detail.tables_being_vacuumed.map((t) => (
                  <tr key={t.pid} className="border-t border-border">
                    <td className="px-3 py-1.5 font-mono">{t.table_name}</td>
                    <td className="px-3 py-1.5">{t.phase}</td>
                    <td className="px-3 py-1.5">
                      {t.heap_blks_total ? `${Math.round((t.heap_blks_scanned / t.heap_blks_total) * 100)}%` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function LogicalReplicationDetail({ detail }) {
  return (
    <div className="card space-y-3 p-card">
      <h3 className="text-[13px] font-bold text-fg">Current Status</h3>
      <div className="grid grid-cols-2 gap-3 text-[12px] sm:grid-cols-3">
        <TechRow label="Active Workers" value={detail.active_workers} />
        <TechRow label="Worker Status" value={detail.worker_status} />
        <TechRow label="Subscriptions" value={detail.subscriptions?.length ?? 0} />
      </div>
      {detail.subscriptions?.length > 0 && (
        <div className="overflow-x-auto rounded-control border border-border">
          <table className="w-full text-[12px]">
            <thead><tr className="bg-sunken text-left text-subtle"><th className="px-3 py-1.5">Subscription</th><th className="px-3 py-1.5">Last Message</th></tr></thead>
            <tbody>
              {detail.subscriptions.map((s) => (
                <tr key={s.subname} className="border-t border-border">
                  <td className="px-3 py-1.5 font-mono">{s.subname}</td>
                  <td className="px-3 py-1.5">{s.last_msg_receipt_time ? fullTime(s.last_msg_receipt_time) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ArchiverDetail({ detail }) {
  return (
    <div className="card p-card">
      <h3 className="mb-3 text-[13px] font-bold text-fg">Current Status</h3>
      <div className="grid grid-cols-2 gap-3 text-[12px] sm:grid-cols-4">
        <TechRow label="Archived WAL (total)" value={detail.archived_total?.toLocaleString()} />
        <TechRow label="Failed Archives (total)" value={detail.failed_total?.toLocaleString()} />
        <TechRow label="Last Successful Archive" value={detail.last_archived_time ? fullTime(detail.last_archived_time) : '—'} />
        <TechRow label="Last Failed Archive" value={detail.last_failed_time ? fullTime(detail.last_failed_time) : 'None'} />
      </div>
    </div>
  );
}

export default function ProcessDetailPage() {
  const { id: connId, processId } = useParams();
  const [refreshMs, setRefreshMs] = useState(10000);
  const [techOpen, setTechOpen] = useState(false);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['pgProcessDetail', connId, processId],
    queryFn: () => client.get(`/connections/postgresql/${connId}/processes/${processId}`).then((r) => r.data),
    enabled: !!connId && !!processId,
    refetchInterval: refreshMs,
  });

  const backTo = `/postgresql-dashboard/${connId}/performance`;

  if (isLoading) {
    return (<><PageHeader title="Process Detail" backTo={backTo} /><PageLoading title="Loading process…" illustration={false} /></>);
  }
  if (isError || !data || data.status === 'error') {
    return (
      <>
        <PageHeader title="Process Detail" backTo={backTo} />
        <div className="card p-card"><p className="text-[13px] font-semibold text-danger-fg">Unable to load this process.</p></div>
      </>
    );
  }

  const Icon = ICON_MAP[data.icon] || RefreshCw;
  const tone = STATUS_TONE[data.health_status] || 'neutral';
  const charts = PROCESS_CHARTS[processId] || [];
  const kpiEntries = Object.entries(data.kpis || {}).filter(([, v]) => v !== undefined);

  return (
    <>
      <PageHeader
        title={data.friendly_name}
        backTo={backTo}
        actions={
          <label className="flex items-center gap-2 text-[11px] font-semibold text-muted">
            <span className="flex items-center gap-1 font-bold text-success-fg">
              <span className="h-1.5 w-1.5 rounded-full bg-success-fg" /> LIVE
            </span>
            <select
              value={refreshMs}
              onChange={(e) => setRefreshMs(Number(e.target.value))}
              className="rounded-control border border-border bg-surface px-2 py-1 text-[11px] font-semibold text-fg"
            >
              {REFRESH_OPTIONS.map((o) => <option key={o.id} value={o.id}>Auto refresh: {o.label}</option>)}
            </select>
          </label>
        }
      />

      <div className="space-y-4">
        {/* ── Header card ── */}
        <div className="card p-card">
          <div className="flex flex-wrap items-center gap-3">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-sunken">
              <Icon size={20} className="text-fg" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-[16px] font-black text-fg">{data.friendly_name}</h2>
                <Badge tone={tone} size="sm">{STATUS_LABEL[data.health_status] || 'Unavailable'}</Badge>
                {data.running && <Badge tone="neutral" size="sm">Running</Badge>}
              </div>
              <p className="mt-0.5 text-[12px] text-subtle">
                {data.pid ? `PID: ${data.pid} · ` : ''}Last updated: {data.updated_at ? fullTime(data.updated_at) : '—'}
              </p>
            </div>
          </div>
          <p className="mt-3 text-[13px] text-muted">{data.description}</p>
        </div>

        {/* ── KPI cards ── */}
        {kpiEntries.length > 0 && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {kpiEntries.map(([key, value]) => (
              <div key={key} className="card p-card">
                <p className="text-[10.5px] font-bold tracking-wide text-subtle uppercase">{KPI_LABELS[key] || key}</p>
                <p className="mt-1 text-[18px] font-black text-fg tabular-nums">{fmtKpiValue(key, value)}</p>
              </div>
            ))}
          </div>
        )}

        {/* ── Process-specific current status ── */}
        {processId === 'autovacuum' && data.detail && <AutovacuumDetail detail={data.detail} />}
        {processId === 'logical_replication' && data.detail && <LogicalReplicationDetail detail={data.detail} />}
        {processId === 'archiver' && data.detail && <ArchiverDetail detail={data.detail} />}

        {/* ── Live charts ── */}
        {charts.length > 0 && (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {charts.map((chart) => (
              <PerfTrendChart
                key={chart.title}
                connId={connId}
                title={chart.title}
                series={chart.series}
                defaultRange="15m"
                refetchMsOverride={refreshMs}
                compact
              />
            ))}
          </div>
        )}

        {/* ── Technical Details (collapsible, secondary) ── */}
        <div className="card p-card">
          <button type="button" onClick={() => setTechOpen((v) => !v)} className="flex w-full items-center justify-between text-left">
            <span className="text-[13px] font-bold text-fg">Technical Details</span>
            <ChevronDown size={16} className={cn('text-subtle transition-transform', techOpen && 'rotate-180')} />
          </button>
          {techOpen && (
            <div className="mt-3 grid grid-cols-1 gap-3 border-t border-border pt-3 text-[12px] sm:grid-cols-2">
              <TechRow label="PostgreSQL Process" value={data.technical_name} mono />
              <TechRow label="PID" value={data.pid} mono />
              <TechRow label="Wait Event" value={data.wait_event} mono />
              <TechRow label="Backend Type" value={data.technical_name} mono />
              <TechRow label="View" value={data.view} mono />
              <TechRow label="Backend Start" value={data.backend_start ? fullTime(data.backend_start) : '—'} />
            </div>
          )}
        </div>

        {/* ── ActMon AI chat ── */}
        <AiChatPanel connId={connId} processId={processId} />
      </div>
    </>
  );
}
