import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import cn from '@/lib/cn';
import PageHeader from '@/components/layout/PageHeader';
import Icon from '@/components/ui/Icon';
import IconButton from '@/components/ui/IconButton';
import { PageLoading } from '@/components/ui/Loading';
import Button from '@/components/ui/Button';
import Badge from '@/components/ui/Badge';
import Select from '@/components/ui/Select';
import Input from '@/components/ui/Input';
import { EmptyState } from '@/components/ui/Table';
import ChartCard from '@/components/charts/ChartCard';
import useHostOverview from '@/hooks/useHostOverview';
import { getMetricsHistory, getDbAgentInfo, getDbAgentChecks, getDbAgentTimeline } from '@/api/agents';
import { agentState, engineOf } from '@/config/agents';
import { ago, fullTime } from '@/lib/format';

/* Same range/granularity/timezone controls as the Host Agent page — the
   spec asks Live Database Telemetry to reuse them verbatim. */
const RANGE_OPTIONS = [
  { id: '60', label: 'Last 1 Hour' },
  { id: '240', label: 'Last 4 Hours' },
  { id: '1440', label: 'Last 24 Hours' },
  { id: '4320', label: 'Last 3 Days' },
  { id: '10080', label: 'Last 7 Days' },
  { id: 'custom', label: 'Custom' },
];
const GRANULARITY_OPTIONS = [
  { id: '60', label: 'Per Minute' },
  { id: '900', label: 'Per 15 Minutes' },
  { id: '1800', label: 'Per 30 Minutes' },
  { id: '3600', label: 'Per Hour' },
];
const METRIC_FIELD = {
  qps: 'qps', tps: 'tps', sessions: 'active_sessions',
  connections: 'connections_used', cache: 'cache_hit_pct',
};
const BROWSER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const COMMON_TIMEZONES = [
  'UTC', 'Asia/Kolkata', 'Asia/Dubai', 'Asia/Karachi', 'Asia/Dhaka', 'Asia/Bangkok',
  'Asia/Singapore', 'Asia/Hong_Kong', 'Asia/Shanghai', 'Asia/Tokyo', 'Asia/Seoul',
  'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Moscow',
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'America/Sao_Paulo', 'Australia/Sydney', 'Pacific/Auckland',
];
const ALL_TIMEZONES = typeof Intl.supportedValuesOf === 'function'
  ? Intl.supportedValuesOf('timeZone')
  : COMMON_TIMEZONES;
const TIMEZONE_OPTIONS = [
  { id: BROWSER_TZ, label: `Browser (${BROWSER_TZ})`, group: 'Local' },
  ...Array.from(new Set(ALL_TIMEZONES.filter((z) => z !== BROWSER_TZ)))
    .map((z) => ({ id: z, label: z, group: 'All timezones' })),
];

/** Check status → display label + tone. Distinct from diagnosisKit's
    CHECK_STATUS_TONE map because this page's vocabulary is the spec's own
    (Working / Degraded / Failed / Not Supported / Never Run), not the
    Diagnosis workspace's (passed / warning / failed / skipped). */
const CHECK_DISPLAY = {
  passed: { label: 'Working', tone: 'success', icon: 'check' },
  warning: { label: 'Degraded', tone: 'warning', icon: 'alert' },
  failed: { label: 'Failed', tone: 'danger', icon: 'close' },
  skipped: { label: 'Not Supported', tone: 'neutral', icon: 'ban' },
  never_run: { label: 'Never Run', tone: 'neutral', icon: 'clock' },
};

const SEVERITY_DISPLAY = {
  FATAL: { tone: 'danger', icon: 'alert' },
  CRITICAL: { tone: 'danger', icon: 'alert' },
  ERROR: { tone: 'danger', icon: 'alert' },
  WARNING: { tone: 'warning', icon: 'alert' },
  INFO: { tone: 'neutral', icon: 'info' },
};
const LOG_ENTRY_TIMESTAMP = /(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/;

/** The errors check's output is a flattened "[LEVEL] timestamp message…" blob
    per entry (a real stack trace can span many lines) — split back into
    entries at each new "[LEVEL]" line start, latest first (the backend
    already orders DESC; this only re-groups, never re-sorts). */
function parseLogEntries(raw) {
  if (!raw) return [];
  return raw.split(/\n(?=\[[A-Z]+\])/).map((chunk) => {
    const head = chunk.match(/^\[(\w+)\]\s*/);
    const severity = (head?.[1] || 'INFO').toUpperCase();
    const rest = head ? chunk.slice(head[0].length) : chunk;
    const tsMatch = rest.match(LOG_ENTRY_TIMESTAMP);
    const timestamp = tsMatch ? tsMatch[1] : null;
    const message = (timestamp ? rest.slice(rest.indexOf(timestamp) + timestamp.length) : rest)
      .trim().split('\n')[0];
    return { severity, timestamp, message: message || rest.trim() };
  }).filter((e) => e.message);
}

/** A bare "2026-08-11 10:34:31" carries no zone marker, and which zone it
    actually means varies by engine (ClickHouse's own text_log is UTC; a
    Windows-local engine's log is server-local) — guessing wrong shows an
    "ago" that's off by a timezone offset. Only entries that already state
    their zone (MongoDB's ISO+offset) get a relative time; everything else
    shows its own literal timestamp rather than a guessed-at one. */
function displayLogTime(ts) {
  if (!ts) return '';
  if (/T/.test(ts) && /Z$|[+-]\d{2}:?\d{2}$/.test(ts)) return ago(ts);
  return ts;
}

/**
 * DATABASE AGENT MONITORING.
 *
 * Same subject as HostAgentPage but for a database-type agent: is the agent
 * alive, is it actually connected to the database, and what its own real
 * monitoring checks last found (see db_agent_checks.py) — surfaced here as
 * Connection Health / Permission Status / Errors, read-only. Nothing on this
 * page executes a check; nothing here is invented.
 */
export default function DatabaseAgentPage({ name, meta }) {
  const d = useHostOverview(name, { hasConnection: true });
  const state = agentState({ ...d.agent, has_connection: true, last_error: meta?.last_error });
  const connId = meta?.db_connection_id;
  const engine = engineOf(meta?.db_type);
  const techRaw = meta?.db_type || '';

  const infoQ = useQuery({
    queryKey: ['agents', 'db-agent-info', connId],
    queryFn: () => getDbAgentInfo(connId),
    enabled: Boolean(connId),
    retry: false,
  });
  const info = infoQ.data?.status === 'success' ? infoQ.data : null;

  // Identity / Connection Health / Permission Status / Monitoring Timeline are
  // all hidden by default — each is a card the user clicks to reveal, one at a
  // time (clicking the open one again collapses it).
  const [activePanel, setActivePanel] = useState(null);
  const togglePanel = (id) => setActivePanel((v) => (v === id ? null : id));

  // ── range / granularity picker for Live Database Telemetry ──────────────
  const [range, setRange] = useState('60');
  const [customMinutes, setCustomMinutes] = useState('1440');
  const [granularity, setGranularity] = useState('60');
  const [timezone, setTimezone] = useState(BROWSER_TZ);
  const minutes = range === 'custom' ? (Number(customMinutes) || 1440) : Number(range);
  const bucketSeconds = Number(granularity);

  const historyQ = useQuery({
    queryKey: ['agents', 'db-metrics-history', name, connId, minutes, bucketSeconds],
    queryFn: () => getMetricsHistory(name, {
      minutes, bucketSeconds, kind: 'database', tech: techRaw, connId,
    }),
    refetchInterval: Math.max(15_000, Math.min(60_000, bucketSeconds * 250)),
    enabled: Boolean(name && connId),
    retry: false,
  });
  const historySeries = useMemo(() => {
    const rows = historyQ.data?.samples || [];
    return rows.slice().reverse().map((s) => {
      const at = new Date(`${String(s.ts).replace(' ', 'T')}Z`);
      const label = Number.isNaN(at.getTime())
        ? String(s.ts)
        : minutes > 1440
          ? at.toLocaleString([], { timeZone: timezone, month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' })
          : at.toLocaleTimeString([], { timeZone: timezone, hour: '2-digit', minute: '2-digit' });
      return {
        label,
        qps: Number(s.qps || 0), tps: Number(s.tps || 0),
        active_sessions: Number(s.active_sessions || 0),
        connections_used: Number(s.connections_used || 0),
        cache_hit_pct: Number(s.cache_hit_pct || 0),
      };
    });
  }, [historyQ.data, minutes, timezone]);
  const historySeriesFor = (metric) => historySeries.map((s) => ({ label: s.label, value: s[METRIC_FIELD[metric]] }));
  const hasHistorySeries = historySeries.length > 0;
  const rangeLabel = RANGE_OPTIONS.find((o) => o.id === range)?.label || '';
  const granLabel = GRANULARITY_OPTIONS.find((o) => o.id === granularity)?.label || '';

  // ── the check catalogue — read-only here; feeds Connection Health,
  // Permission Status and Errors below (the checks TABLE itself lives only
  // on the Diagnosis page, not on this one).
  const checksQ = useQuery({
    queryKey: ['agents', 'db-agent-checks', connId],
    queryFn: () => getDbAgentChecks(connId),
    enabled: Boolean(connId),
    refetchInterval: 30_000,
    retry: false,
  });
  const checks = checksQ.data?.checks || [];

  const groupedChecks = useMemo(() => {
    const byCategory = new Map();
    for (const c of checks) {
      if (!byCategory.has(c.category)) byCategory.set(c.category, []);
      byCategory.get(c.category).push(c);
    }
    return Array.from(byCategory.entries()).map(([category, items]) => ({ category, items }));
  }, [checks]);

  // ── permission status, one row per check category ───────────────────────
  const permissionRows = useMemo(() => groupedChecks.map(({ category, items }) => {
    const withIssue = items.find((c) => c.permission_issue);
    const anyPassed = items.some((c) => c.status === 'passed');
    const anyFailed = items.some((c) => c.status === 'failed');
    const allSkipped = items.every((c) => c.status === 'skipped');
    let state;
    if (withIssue) state = { label: 'Permission Required', tone: 'warning', issue: withIssue.permission_issue };
    else if (allSkipped) state = { label: 'Not Supported', tone: 'neutral' };
    else if (anyPassed) state = { label: 'Allowed', tone: 'success' };
    else if (anyFailed) state = { label: 'Failed', tone: 'danger' };
    else state = { label: 'Not Run Yet', tone: 'neutral' };
    return { category, ...state };
  }), [groupedChecks]);

  // ── errors: reuse the 'errors' check's last real output ──────────────────
  const errorsCheck = checks.find((c) => c.id === 'errors');
  const connectionCheck = checks.find((c) => c.id === 'connection');
  // Latest 5 only — the backend already orders newest-first; this just caps
  // how much of it the page shows, so an old resolved burst doesn't dominate.
  const errorEntries = useMemo(
    () => parseLogEntries(errorsCheck?.output).slice(0, 5),
    [errorsCheck?.output],
  );

  // Fetched only once the Monitoring Timeline card is opened.
  const timelineQ = useQuery({
    queryKey: ['agents', 'db-agent-timeline', connId],
    queryFn: () => getDbAgentTimeline(connId),
    enabled: Boolean(connId) && activePanel === 'timeline',
    refetchInterval: 60_000,
    retry: false,
  });
  const timelineEvents = timelineQ.data?.events || [];

  if (d.isLoading || infoQ.isLoading) {
    return (
      <>
        <Header name={name} d={d} state={state} engine={engine} info={info} />
        <PageLoading illustration />
      </>
    );
  }

  if (d.error) {
    return (
      <>
        <Header name={name} d={d} state={state} engine={engine} info={info} />
        <div className="card px-card py-14">
          <EmptyState
            icon={d.notFound ? 'search' : 'alert'}
            title={d.notFound ? `No agent named "${name}"` : 'Could not load agent telemetry'}
            body={d.notFound
              ? 'It may have been removed, or the name in the URL is wrong.'
              : d.error.message}
            action={<Button size="sm" icon="arrow-left" onClick={() => window.history.back()}>Back to agents</Button>}
          />
        </div>
      </>
    );
  }

  const interval = d.agent.collection_interval_sec || meta?.collection_interval_sec || 60;

  return (
    <>
      <Header name={name} d={d} state={state} engine={engine} info={info} />

      {/* ── top status ──────────────────────────────────────────────────── */}
      <SectionTitle icon="activity" title="Top Status" hint="Agent, connection and monitoring state — at a glance" />
      <div className="grid grid-cols-2 gap-gutter lg:grid-cols-3 xl:grid-cols-6">
        <Kpi icon="database" label="Database" value={engine.label} sub={info?.database_name || info?.instance_name || info?.sid || '—'} />
        <Kpi icon="agent" label="Agent" value={d.online ? 'Online' : 'Offline'} tone={d.online ? 'good' : 'critical'} sub={meta?.agent_version ? `v${meta.agent_version}` : 'version unknown'} />
        <Kpi
          icon="plug" label="Connection"
          value={connectionCheck ? (CHECK_DISPLAY[connectionCheck.status]?.label || connectionCheck.status) : 'Unknown'}
          tone={connectionCheck?.status === 'passed' ? 'good' : connectionCheck?.status === 'failed' ? 'critical' : 'neutral'}
          sub={connectionCheck?.last_run ? `checked ${ago(connectionCheck.last_run)}` : 'not checked yet'}
        />
        <Kpi
          icon="radio" label="Monitoring"
          value={d.online ? 'Active' : 'Stopped'}
          tone={d.online ? 'good' : 'critical'}
          sub={`every ${interval}s`}
        />
        <Kpi icon="clock" label="Last Heartbeat" value={d.agent.last_heartbeat ? ago(d.agent.last_heartbeat) : 'never'} sub={d.agent.last_heartbeat ? fullTime(d.agent.last_heartbeat) : ''} />
        <Kpi icon="history" label="Monitoring Interval" value={`${interval}s`} sub="collection cadence" />
      </div>

      {/* ── delivery & communication (identical to the Host Agent page) ──── */}
      <SectionTitle
        className="mt-gutter-lg"
        icon="activity"
        title="Delivery"
        hint={d.deliveryFromRing ? 'Computed from the hot ring — blank while the ring is empty' : "How reliably this agent's telemetry is arriving"}
      />
      <div className="grid grid-cols-2 gap-gutter lg:grid-cols-4 xl:grid-cols-8">
        <Kpi icon="radio" label="Heartbeat" value={secs(d.comm.last_sample_age_s)} sub="since last sample" tone={d.online ? 'good' : 'critical'} />
        <Kpi
          icon="check" label="Delivery"
          value={d.delivery.known ? `${Math.round(d.delivery.pct)}%` : '—'}
          sub={d.delivery.known ? `${d.delivery.received}/${d.delivery.expected} in the last hour` : 'no samples expected yet'}
          tone={d.delivery.tone}
        />
        <Kpi icon="history" label="Avg interval" value={d.comm.avg_interval_s ? `${d.comm.avg_interval_s}s` : '—'} sub={`target ${interval}s`} />
        <Kpi
          icon="cpu" label="Jitter"
          value={d.comm.jitter_s === null || d.comm.jitter_s === undefined ? '—' : `${d.comm.jitter_s}s`}
          sub="interval variance"
          tone={(d.comm.jitter_s || 0) > interval ? 'warning' : 'neutral'}
        />
        <Kpi icon="boxes" label="Incoming rate" value={d.comm.incoming_rate_per_min ? `${d.comm.incoming_rate_per_min}/min` : '—'} sub="telemetry packets" />
        <Kpi
          icon="trend" label="Throughput"
          value={d.comm.throughput_bytes_per_min ? `${(d.comm.throughput_bytes_per_min / 1024).toFixed(1)} KB/m` : '—'}
          sub={`~${d.comm.sample_size_bytes || 0} B per packet`}
        />
        <Kpi icon="database" label="Stored 24h" value={d.telemetry.clickhouse?.rows_24h ?? '—'} sub={d.telemetry.clickhouse ? 'ClickHouse rows' : 'ClickHouse offline'} tone={d.telemetry.clickhouse ? 'neutral' : 'warning'} />
        <Kpi icon="layers" label="Transfer queue" value={d.telemetry.pending_ch_queue ?? 0} sub="pending → ClickHouse" tone={(d.telemetry.pending_ch_queue || 0) > 1000 ? 'warning' : 'good'} />
      </div>

      {/* ── live database telemetry ──────────────────────────────────────── */}
      <SectionTitle
        className="mt-gutter-lg"
        icon="trend"
        title="Live Database Telemetry"
        hint={hasHistorySeries ? `${rangeLabel} · ${granLabel}` : undefined}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Select value={range} onChange={setRange} options={RANGE_OPTIONS} size="sm" width="auto" aria-label="Time range" />
            {range === 'custom' && (
              <Input type="number" min={1} value={customMinutes} onChange={(e) => setCustomMinutes(e.target.value)} wrapperClassName="w-20" size="sm" aria-label="Custom minutes" />
            )}
            <Select value={granularity} onChange={setGranularity} options={GRANULARITY_OPTIONS} size="sm" width="auto" aria-label="Granularity" />
            <Select value={timezone} onChange={setTimezone} options={TIMEZONE_OPTIONS} size="sm" width="auto" aria-label="Timezone" />
          </div>
        }
      />
      <div className="grid gap-gutter lg:grid-cols-2">
        <TelemetryChart title="Queries per second" metric="qps" slot={1} unit="" data={historySeriesFor('qps')} hasData={hasHistorySeries} loading={historyQ.isFetching} subtitle={`${rangeLabel} · ${granLabel}`} />
        <TelemetryChart title="Transactions per second" metric="tps" slot={2} unit="" data={historySeriesFor('tps')} hasData={hasHistorySeries} loading={historyQ.isFetching} subtitle={`${rangeLabel} · ${granLabel}`} />
        <TelemetryChart title="Active sessions" metric="sessions" slot={3} unit="" data={historySeriesFor('sessions')} hasData={hasHistorySeries} loading={historyQ.isFetching} subtitle={`${rangeLabel} · ${granLabel}`} />
        <TelemetryChart title="Cache hit rate" metric="cache" slot={4} domain={[0, 100]} data={historySeriesFor('cache')} hasData={hasHistorySeries} loading={historyQ.isFetching} subtitle={`${rangeLabel} · ${granLabel}`} />
      </div>
      {!hasHistorySeries && (
        <p className="mt-2 flex items-center gap-1.5 text-[11px] text-subtle">
          <Icon name="info" size={12} className="shrink-0" />
          No database telemetry samples in this range yet — this fills in as the collector reports.
        </p>
      )}

      {/* ── Database Identity / Connection Health / Permission Status /
          Monitoring Timeline — four cards, each closed until clicked ────── */}
      <SectionTitle className="mt-gutter-lg" icon="list" title="More Details" hint="Click a card to view — nothing here runs automatically" />
      <div className="grid grid-cols-2 gap-gutter lg:grid-cols-4">
        <PanelCard icon="database" label="Database Identity" active={activePanel === 'identity'} onClick={() => togglePanel('identity')} />
        <PanelCard
          icon="plug" label="Connection Health"
          active={activePanel === 'connection'}
          tone={connectionCheck?.status === 'passed' ? 'good' : connectionCheck?.status === 'failed' ? 'critical' : 'neutral'}
          sub={connectionCheck ? (CHECK_DISPLAY[connectionCheck.status]?.label || connectionCheck.status) : undefined}
          onClick={() => togglePanel('connection')}
        />
        <PanelCard
          icon="shield-check" label="Permission Status"
          active={activePanel === 'permission'}
          tone={permissionRows.some((r) => r.tone === 'warning') ? 'warning' : permissionRows.some((r) => r.tone === 'danger') ? 'critical' : 'neutral'}
          sub={permissionRows.length ? `${permissionRows.filter((r) => r.tone === 'success').length}/${permissionRows.length} allowed` : undefined}
          onClick={() => togglePanel('permission')}
        />
        <PanelCard icon="clock" label="Monitoring Timeline" active={activePanel === 'timeline'} onClick={() => togglePanel('timeline')} />
      </div>

      {activePanel === 'identity' && (
        <div className="card mt-gutter-sm p-card">
          <dl className="space-y-1.5 text-[11px]">
            <Row label="Technology" value={engine.label} />
            <Row label="Host" value={info?.host || meta?.hostname || meta?.ip_address} />
            <Row label="IP address" value={meta?.ip_address} />
            <Row label="Port" value={info?.port} />
            <Row label="Database / Instance" value={info?.database_name || info?.instance_name || info?.sid || info?.service_name} />
            <Row label="Connection name" value={info?.connection_name} />
            <Row label="Agent version" value={meta?.agent_version} />
          </dl>
        </div>
      )}

      {activePanel === 'connection' && (
        <div className="card mt-gutter-sm p-card">
          {connectionCheck ? (
            <>
              <div className="flex items-center gap-2">
                <span
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-white"
                  style={{ background: connectionCheck.status === 'passed' ? 'var(--status-good)' : connectionCheck.status === 'failed' ? 'var(--status-critical)' : 'var(--status-unknown)' }}
                >
                  <Icon name={CHECK_DISPLAY[connectionCheck.status]?.icon || 'clock'} size={15} strokeWidth={3} />
                </span>
                <span>
                  <span className="block text-[15px] leading-none font-bold text-fg">
                    {CHECK_DISPLAY[connectionCheck.status]?.label || 'Not checked yet'}
                  </span>
                  <span className="mt-1 block text-[11px] text-subtle">
                    {info?.host}{info?.port ? `:${info.port}` : ''}
                  </span>
                </span>
              </div>
              <dl className="mt-3 space-y-1 border-t border-border pt-3 text-[11px]">
                <Row label="Last success" value={connectionCheck.last_success_at ? fullTime(connectionCheck.last_success_at) : 'never'} />
                <Row label="Last failure" value={connectionCheck.last_failure_at ? fullTime(connectionCheck.last_failure_at) : 'never'} />
                <Row label="Failure count" value={connectionCheck.failure_count} />
              </dl>
            </>
          ) : (
            <p className="text-[12px] text-subtle">Loading…</p>
          )}
        </div>
      )}

      {activePanel === 'permission' && (
        <div className="card mt-gutter-sm overflow-hidden">
          <div className="divide-y divide-border">
            {permissionRows.map((r) => (
              <div key={r.category} className="flex items-center gap-3 px-4 py-2.5">
                <span className="min-w-0 flex-1 text-[12.5px] font-semibold text-fg">{r.category}</span>
                <Badge tone={r.tone} size="sm">{r.label}</Badge>
              </div>
            ))}
            {permissionRows.length === 0 && <p className="px-4 py-6 text-center text-[12px] text-subtle">No check categories yet.</p>}
          </div>
          {permissionRows.some((r) => r.issue) && (
            <div className="border-t border-border p-4">
              {permissionRows.filter((r) => r.issue).map((r) => (
                <div key={r.category} className="mb-2 last:mb-0">
                  <p className="mb-1 text-[11px] font-bold text-subtle">{r.category}</p>
                  <PermissionIssue issue={r.issue} />
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {activePanel === 'timeline' && (
        <div className="card mt-gutter-sm p-card">
          {timelineQ.isLoading ? (
            <p className="text-[12px] text-subtle">Loading…</p>
          ) : timelineEvents.length === 0 ? (
            <p className="text-[12px] text-subtle">No monitoring events recorded yet.</p>
          ) : (
            <ul className="space-y-3">
              {timelineEvents.slice(0, 5).map((e, i) => (
                <li key={`${e.timestamp}-${i}`} className="flex items-start gap-3">
                  <span className="mt-1 h-2 w-2 shrink-0 rounded-full" style={{ background: 'var(--accent)' }} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[12.5px] font-bold text-fg">{e.label}</span>
                    <span className="block text-[11px] text-muted">{e.detail}</span>
                  </span>
                  <span className="shrink-0 text-[11px] text-subtle">{e.timestamp ? fullTime(e.timestamp) : ''}</span>
                </li>
              ))}
            </ul>
          )}
          {timelineEvents.length > 5 && (
            <p className="mt-3 border-t border-border pt-2 text-[10.5px] text-subtle">
              Showing the latest 5 of {timelineEvents.length} events.
            </p>
          )}
        </div>
      )}

      {/* ── database error log — the database's OWN log (via the agent's
          Errors check), not the agent's own operational health; that lives
          in Permission Status (check pass/fail) and Monitoring Timeline
          (agent notifications) above ──────────────────────────────────── */}
      <SectionTitle className="mt-gutter-lg" icon="alert" title="Database Error Log" hint={`${engine.label}'s own log, read by the agent's Errors check`} />
      <div className="card p-card">
        {!errorsCheck || errorsCheck.status === 'never_run' ? (
          <p className="flex items-center gap-2 text-[12px] text-muted">
            <Icon name="info" size={13} className="shrink-0 text-subtle" />
            No "Error Logs" check has been run for this connection yet.
          </p>
        ) : errorsCheck.status === 'skipped' ? (
          <p className="text-[12px] text-subtle">{errorsCheck.error || 'Not available for this technology yet.'}</p>
        ) : errorsCheck.status === 'passed' || errorEntries.length === 0 ? (
          <p className="flex items-center gap-2 text-[12px] font-semibold text-success-fg">
            <Icon name="check" size={14} className="shrink-0" />
            OK — no errors found. Last checked {errorsCheck.last_run ? ago(errorsCheck.last_run) : 'just now'}.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {errorEntries.map((e, i) => {
              const sev = SEVERITY_DISPLAY[e.severity] || SEVERITY_DISPLAY.INFO;
              return (
                <li key={i} className="flex items-start gap-2.5 py-2 first:pt-0 last:pb-0">
                  <Icon name={sev.icon} size={13} className={cn('mt-0.5 shrink-0', KPI_TONES[sev.tone === 'danger' ? 'critical' : sev.tone === 'warning' ? 'warning' : 'neutral'])} />
                  <Badge tone={sev.tone} size="xs" className="mt-px shrink-0">{e.severity}</Badge>
                  <span className="min-w-0 flex-1 truncate-safe font-mono text-[11px] text-fg" title={e.message}>{e.message}</span>
                  <span className="shrink-0 text-[10.5px] text-subtle">{displayLogTime(e.timestamp)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <p className="mt-gutter flex items-center gap-1.5 text-[11px] text-subtle">
        <Icon name="info" size={12} className="shrink-0" />
        This page monitors the ActMon agent's connection to
        {' '}{engine.label}, not the database's own workload dashboard.
        Looking for query/table/replication detail?
        <Link to="/databases" className="font-semibold text-accent-text hover:underline">Databases</Link>
        covers that.
      </p>
    </>
  );
}

/* ── pieces ─────────────────────────────────────────────────────────────── */

function Header({ name, d, state, engine, info }) {
  return (
    <PageHeader
      backTo="/agents"
      backLabel="Agents"
      title={engine?.label || name}
      icon="database"
      description={`${engine?.label || 'Database'} Database Agent · ${info?.host || d.agent?.hostname || d.agent?.ip || name}`}
      actions={
        <div className="flex items-center gap-2">
          <span title={state.tip}>
            <Badge tone={state.tone}>
              <Icon name={state.icon} size={10} strokeWidth={3} />
              {state.label}
            </Badge>
          </span>
          <span className="hidden text-right sm:block">
            <span className="block text-[11px] font-semibold text-fg">
              {d.agent.last_heartbeat ? ago(d.agent.last_heartbeat) : 'never'}
            </span>
            <span className="block text-[10px] text-subtle">last heartbeat</span>
          </span>
          <IconButton icon="refresh" label="Refresh now" onClick={d.refresh} iconClassName={d.isFetching ? 'animate-spin' : undefined} />
        </div>
      }
    />
  );
}

function SectionTitle({ icon, title, hint, actions, className }) {
  return (
    <div className={cn('mb-gutter-sm flex flex-wrap items-center justify-between gap-x-2.5 gap-y-2', className)}>
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <h2 className="flex items-center gap-1.5 text-[13px] font-bold text-fg">
          <Icon name={icon} size={14} className="text-subtle" />
          {title}
        </h2>
        {hint && <span className="text-[11px] text-subtle">{hint}</span>}
      </div>
      {actions}
    </div>
  );
}

const KPI_TONES = { good: 'text-success-fg', warning: 'text-warning-fg', critical: 'text-danger-fg', neutral: 'text-fg' };

function Kpi({ icon, label, value, sub, tone = 'neutral' }) {
  return (
    <div className="card px-card py-3">
      <div className="flex items-start justify-between gap-2">
        <p className="truncate-safe text-[10px] font-bold tracking-wide text-subtle uppercase">{label}</p>
        <Icon name={icon} size={14} className="shrink-0 text-subtle" />
      </div>
      <p className={cn('mt-1.5 text-[20px] leading-none font-bold', KPI_TONES[tone])}>{value}</p>
      {sub && <p className="truncate-safe mt-1 text-[10px] text-subtle">{sub}</p>}
    </div>
  );
}

/** One of the four click-to-reveal cards (Database Identity / Connection
    Health / Permission Status / Monitoring Timeline). Closed by default —
    clicking toggles its panel below; clicking the open one again closes it. */
function PanelCard({ icon, label, sub, tone = 'neutral', active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'card flex items-center gap-3 px-card py-3 text-left transition-colors',
        active ? 'border-accent ring-1 ring-accent' : 'hover:bg-sunken',
      )}
    >
      <span
        className={cn(
          'grid h-9 w-9 shrink-0 place-items-center rounded-md',
          active ? 'bg-accent-soft text-accent-text' : 'bg-sunken text-subtle',
        )}
      >
        <Icon name={icon} size={16} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate-safe text-[12.5px] font-bold text-fg">{label}</span>
        {sub && <span className={cn('block truncate-safe text-[10.5px]', KPI_TONES[tone])}>{sub}</span>}
      </span>
      <Icon name={active ? 'chevron-down' : 'chevron-right'} size={14} className="shrink-0 text-subtle" />
    </button>
  );
}

function TelemetryChart({ title, data, hasData, subtitle, loading, metric, slot, unit = '%', domain }) {
  return (
    <ChartCard
      cardId={`db-agent-telemetry-${metric}`}
      family="trend"
      defaultKind="area"
      items={data}
      chartProps={{
        color: `var(--chart-${slot})`, unit, domain,
        emptyLabel: 'Waiting for samples',
      }}
      title={title}
      icon="activity"
      subtitle={hasData ? subtitle : undefined}
      loading={loading && hasData}
      tableColumns={hasData ? [{ key: 'time', label: 'Time' }, { key: 'value', label: title, align: 'right' }] : undefined}
      tableRows={hasData ? data.slice(-40).reverse().map((p, i) => ({
        key: `${p.label}-${i}`,
        cells: { time: p.label, value: `${Math.round(p.value * 10) / 10}${unit}` },
      })) : undefined}
    />
  );
}

function Row({ label, value }) {
  if (value === null || value === undefined || value === '') return null;
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="shrink-0 text-subtle">{label}</dt>
      <dd className="truncate-safe text-right font-medium text-fg">{value}</dd>
    </div>
  );
}

/** Same shape/rendering as diagnosisKit's PermissionRequired, reproduced here
    (rather than imported) because this page's permission callout is keyed by
    check CATEGORY, not by a single check entry. */
function PermissionIssue({ issue }) {
  if (!issue) return null;
  return (
    <div className="rounded-control border border-warning-soft bg-warning-soft p-3 text-[12.5px]">
      <dl className="space-y-1 text-fg">
        <div><dt className="inline font-bold">Required: </dt><dd className="inline">{issue.required}</dd></div>
        <div><dt className="inline font-bold">Why: </dt><dd className="inline">{issue.why}</dd></div>
        <div><dt className="inline font-bold">How obtained: </dt><dd className="inline">{issue.how_obtained}</dd></div>
      </dl>
    </div>
  );
}

const secs = (v) => {
  if (v === null || v === undefined) return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return n < 90 ? `${Math.round(n)}s` : `${Math.round(n / 60)}m`;
};
