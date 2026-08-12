import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import cn from '@/lib/cn';
import PageHeader from '@/components/layout/PageHeader';
import Icon from '@/components/ui/Icon';
import IconButton from '@/components/ui/IconButton';
import Button from '@/components/ui/Button';
import Badge from '@/components/ui/Badge';
import Select from '@/components/ui/Select';
import Input from '@/components/ui/Input';
import { EmptyState } from '@/components/ui/Table';
import ChartCard from '@/components/charts/ChartCard';
import { STATUS, StatusKey } from '@/components/charts/status';
import useHostOverview from '@/hooks/useHostOverview';
import { getMetricsHistory } from '@/api/agents';
import { agentState } from '@/config/agents';
import { ago, fullTime } from '@/lib/format';

/** Range → minutes back. "Custom" hands off to a plain minutes input instead
    of a real date-range picker — simpler, and just as precise for "how far
    back", which is all this control actually needs to express. */
const RANGE_OPTIONS = [
  { id: '60', label: 'Last 1 Hour' },
  { id: '240', label: 'Last 4 Hours' },
  { id: '1440', label: 'Last 24 Hours' },
  { id: '4320', label: 'Last 3 Days' },
  { id: '10080', label: 'Last 7 Days' },
  { id: 'custom', label: 'Custom' },
];
/** Granularity → the server-side average-bucket width (history_bucketed).
    "Per Minute" is the default — the raw feed is 15s-cadence, and charting
    that as-is over anything longer than a few minutes is just noise. */
const GRANULARITY_OPTIONS = [
  { id: '60', label: 'Per Minute' },
  { id: '900', label: 'Per 15 Minutes' },
  { id: '1800', label: 'Per 30 Minutes' },
  { id: '3600', label: 'Per Hour' },
];
const METRIC_FIELD = { cpu: 'host_cpu', memory: 'host_memory', disk: 'host_disk', qps: 'qps' };

/** metrics_history_service.py pins its SELECT output to UTC via toTimeZone(...,
    'UTC') regardless of the ClickHouse server's own default display timezone
    (which varies per install — this dev WSL box happens to be UTC, a prior
    deployment was server-local, so the API contract can't ride on either). So
    every `ts` here is always a genuine UTC instant — parse with a 'Z', never as
    a naive local string, or every label reads hours off from the real time. */
const BROWSER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const COMMON_TIMEZONES = [
  'UTC', 'Asia/Kolkata', 'Asia/Dubai', 'Asia/Karachi', 'Asia/Dhaka', 'Asia/Bangkok',
  'Asia/Singapore', 'Asia/Hong_Kong', 'Asia/Shanghai', 'Asia/Tokyo', 'Asia/Seoul',
  'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Moscow',
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'America/Sao_Paulo', 'Australia/Sydney', 'Pacific/Auckland',
];
/** Full IANA list where the browser supports it (Chrome/Edge); the curated set
    above otherwise — either way "Browser" is pinned first as the sane default. */
const ALL_TIMEZONES = typeof Intl.supportedValuesOf === 'function'
  ? Intl.supportedValuesOf('timeZone')
  : COMMON_TIMEZONES;
const TIMEZONE_OPTIONS = [
  { id: BROWSER_TZ, label: `Browser (${BROWSER_TZ})`, group: 'Local' },
  ...Array.from(new Set(ALL_TIMEZONES.filter((z) => z !== BROWSER_TZ)))
    .map((z) => ({ id: z, label: z, group: 'All timezones' })),
];

/**
 * AGENT SELF-MONITORING.
 *
 * The subject is the agent and nothing else: is its service running, is it
 * delivering telemetry, on what cadence, through which endpoints, and where in the
 * pipeline data stops flowing.
 *
 * Host OS detail (filesystems, processes, interfaces) is deliberately NOT here —
 * that belongs to Infrastructure. The `host` block of the API response is ignored.
 */
export default function HostAgentPage({ name, hasConnection = false }) {
  // Whether this agent feeds the metric tiers decides how an empty chart set is
  // explained, and only the caller knows it (host-overview doesn't report it).
  const d = useHostOverview(name, { hasConnection });
  const state = agentState({ ...d.agent, has_connection: false });

  // ── range / granularity picker for Live telemetry — see RANGE_OPTIONS above ──
  const [range, setRange] = useState('60');
  const [customMinutes, setCustomMinutes] = useState('1440');
  const [granularity, setGranularity] = useState('60');
  const [timezone, setTimezone] = useState(BROWSER_TZ);
  const minutes = range === 'custom' ? (Number(customMinutes) || 1440) : Number(range);
  const bucketSeconds = Number(granularity);

  const historyQ = useQuery({
    queryKey: ['agents', 'metrics-history', name, minutes, bucketSeconds],
    // kind/tech pin this to the host's OWN table — see getMetricsHistory's
    // own note on why omitting them silently dilutes the result.
    queryFn: () => getMetricsHistory(name, { minutes, bucketSeconds, kind: 'infra', tech: 'host' }),
    // A finer bucket is worth refreshing more often; a daily rollup doesn't
    // need to poll every 15s to still feel live.
    refetchInterval: Math.max(15_000, Math.min(60_000, bucketSeconds * 250)),
    enabled: Boolean(name),
    retry: false,
  });

  /** Bucketed ClickHouse rows → chronological { label, ...fields }, independent
      of the hot-ring `d.series` (which is fixed at "last hour, 15s"). */
  const historySeries = useMemo(() => {
    const rows = historyQ.data?.samples || [];
    return rows.slice().reverse().map((s) => {
      // Genuinely UTC — see BROWSER_TZ's comment above — so the 'Z' is required,
      // then rendered in whichever zone the picker below has selected.
      const at = new Date(`${String(s.ts).replace(' ', 'T')}Z`);
      const label = Number.isNaN(at.getTime())
        ? String(s.ts)
        : minutes > 1440
          ? at.toLocaleString([], { timeZone: timezone, month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' })
          : at.toLocaleTimeString([], { timeZone: timezone, hour: '2-digit', minute: '2-digit' });
      return {
        label,
        host_cpu: Number(s.host_cpu || 0), host_memory: Number(s.host_memory || 0),
        host_disk: Number(s.host_disk || 0), qps: Number(s.qps || 0),
      };
    });
  }, [historyQ.data, minutes, timezone]);
  const historySeriesFor = (metric) => historySeries.map((s) => ({ label: s.label, value: s[METRIC_FIELD[metric]] }));
  const hasHistorySeries = historySeries.length > 0;
  const rangeLabel = RANGE_OPTIONS.find((o) => o.id === range)?.label || '';
  const granLabel = GRANULARITY_OPTIONS.find((o) => o.id === granularity)?.label || '';
  const tzLabel = timezone === BROWSER_TZ ? `${timezone} (browser)` : timezone;

  if (d.isLoading) {
    return (
      <>
        <Header name={name} d={d} state={state} />
        <div className="grid min-h-[40vh] place-items-center">
          <div
            className="h-7 w-7 animate-spin rounded-full border-[3px] border-border"
            style={{ borderTopColor: 'var(--accent)' }}
          />
        </div>
      </>
    );
  }

  if (d.error) {
    return (
      <>
        <Header name={name} d={d} state={state} />
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

  const interval = d.agent.collection_interval_sec || 60;
  const jitter = d.comm.jitter_s;
  const svc = d.service;

  return (
    <>
      <Header name={name} d={d} state={state} />

      {/* ── delivery & communication ────────────────────────────────────── */}
      <SectionTitle
        icon="activity"
        title="Delivery"
        /* These are all computed from the ring, so say so when it's empty —
           otherwise eight dashes read as a broken page. */
        hint={d.deliveryFromRing
          ? 'Computed from the hot ring — blank while the ring is empty'
          : "How reliably this agent's telemetry is arriving"}
      />
      <div className="grid grid-cols-2 gap-gutter lg:grid-cols-4 xl:grid-cols-8">
        <Kpi
          icon="radio" label="Heartbeat" value={secs(d.comm.last_sample_age_s)}
          sub="since last sample" tone={d.online ? 'good' : 'critical'}
        />
        <Kpi
          icon="check" label="Delivery"
          /* an agent that has sent nothing has no delivery record — not 100% */
          value={d.delivery.known ? `${Math.round(d.delivery.pct)}%` : '—'}
          sub={d.delivery.known
            ? `${d.delivery.received}/${d.delivery.expected} in the last hour`
            : 'no samples expected yet'}
          tone={d.delivery.tone}
        />
        <Kpi
          icon="history" label="Avg interval"
          value={d.comm.avg_interval_s ? `${d.comm.avg_interval_s}s` : '—'}
          sub={`target ${interval}s`}
        />
        <Kpi
          icon="cpu" label="Jitter"
          value={jitter === null || jitter === undefined ? '—' : `${jitter}s`}
          sub="interval variance"
          tone={(jitter || 0) > interval ? 'warning' : 'neutral'}
        />
        <Kpi
          icon="boxes" label="Incoming rate"
          value={d.comm.incoming_rate_per_min ? `${d.comm.incoming_rate_per_min}/min` : '—'}
          sub="telemetry packets"
        />
        <Kpi
          icon="trend" label="Throughput"
          value={d.comm.throughput_bytes_per_min
            ? `${(d.comm.throughput_bytes_per_min / 1024).toFixed(1)} KB/m`
            : '—'}
          sub={`~${d.comm.sample_size_bytes || 0} B per packet`}
        />
        <Kpi
          icon="database" label="Stored 24h"
          value={d.telemetry.clickhouse?.rows_24h ?? '—'}
          sub={d.telemetry.clickhouse ? 'ClickHouse rows' : 'ClickHouse offline'}
          tone={d.telemetry.clickhouse ? 'neutral' : 'warning'}
        />
        <Kpi
          icon="layers" label="Transfer queue"
          value={d.telemetry.pending_ch_queue ?? 0}
          sub="pending → ClickHouse"
          tone={(d.telemetry.pending_ch_queue || 0) > 1000 ? 'warning' : 'good'}
        />
      </div>

      {/* ── live telemetry ────────────────────────────────────────────────
          Four identical "waiting for samples" panels tell the reader nothing and
          look broken. When there is no series, the reason is stated once. */}
      <SectionTitle
        className="mt-gutter-lg"
        icon="trend"
        title="Live telemetry"
        hint={hasHistorySeries ? `${rangeLabel} · ${granLabel} · ${tzLabel}` : undefined}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={range}
              onChange={setRange}
              options={RANGE_OPTIONS}
              size="sm"
              width="auto"
              aria-label="Time range"
            />
            {range === 'custom' && (
              <Input
                type="number"
                min={1}
                value={customMinutes}
                onChange={(e) => setCustomMinutes(e.target.value)}
                wrapperClassName="w-20"
                size="sm"
                aria-label="Custom minutes"
              />
            )}
            <Select
              value={granularity}
              onChange={setGranularity}
              options={GRANULARITY_OPTIONS}
              size="sm"
              width="auto"
              aria-label="Granularity"
            />
            <Select
              value={timezone}
              onChange={setTimezone}
              options={TIMEZONE_OPTIONS}
              size="sm"
              width="auto"
              aria-label="Timezone"
            />
          </div>
        }
      />
      {d.noSeriesReason ? (
        <div className="card flex items-start gap-3 px-card py-card">
          <span
            className={cn(
              'grid h-9 w-9 shrink-0 place-items-center rounded-md',
              d.noSeriesReason.tone === 'info'
                ? 'bg-info-soft text-info-fg'
                : 'bg-warning-soft text-warning-fg',
            )}
          >
            <Icon name={d.noSeriesReason.tone === 'info' ? 'info' : 'alert'} size={17} />
          </span>
          <div className="min-w-0">
            <p className="text-[13px] font-bold text-fg">{d.noSeriesReason.title}</p>
            <p className="mt-1 max-w-3xl text-[12px] leading-relaxed text-muted">
              {d.noSeriesReason.body}
            </p>
            {d.deliveryFromRing && (
              <p className="mt-2 text-[11px] text-subtle">
                The Delivery figures above are blank for the same reason — the backend derives
                them from the ring, not from the heartbeat. The last-heartbeat time in the header
                is the one live signal.
              </p>
            )}
          </div>
        </div>
      ) : (
        <div className="grid gap-gutter lg:grid-cols-2">
          <TelemetryChart
            title="Reported host CPU" metric="cpu" slot={1} domain={[0, 100]} thresholds
            data={historySeriesFor('cpu')} hasData={hasHistorySeries} loading={historyQ.isFetching}
            subtitle={`${rangeLabel} · ${granLabel}`} noDataHint={d.noSeriesReason?.title}
          />
          <TelemetryChart
            title="Reported host memory" metric="memory" slot={2} domain={[0, 100]} thresholds
            data={historySeriesFor('memory')} hasData={hasHistorySeries} loading={historyQ.isFetching}
            subtitle={`${rangeLabel} · ${granLabel}`} noDataHint={d.noSeriesReason?.title}
          />
          <TelemetryChart
            title="Reported host disk" metric="disk" slot={5} domain={[0, 100]} thresholds
            data={historySeriesFor('disk')} hasData={hasHistorySeries} loading={historyQ.isFetching}
            subtitle={`${rangeLabel} · ${granLabel}`} noDataHint={d.noSeriesReason?.title}
          />
          <TelemetryChart
            title="Telemetry QPS" metric="qps" slot={3} unit=""
            data={historySeriesFor('qps')} hasData={hasHistorySeries} loading={historyQ.isFetching}
            subtitle={`${rangeLabel} · ${granLabel}`} noDataHint={d.noSeriesReason?.title}
          />
        </div>
      )}

      {/* ── the pipeline ────────────────────────────────────────────────── */}
      <SectionTitle
        className="mt-gutter-lg"
        icon="link"
        title="Telemetry pipeline"
        hint="Every hop between this agent and stored history"
      />
      <div className="card p-card">
        {/* The verdict sits with the pipeline it describes, not at the top of the
            page — the reader gets the agent's own state first. */}
        {d.brokenStage && (
          <div className="mb-4 flex items-start gap-2.5 rounded-control bg-warning-soft px-3 py-2.5">
            <Icon name="alert" size={15} className="mt-px shrink-0 text-warning-fg" />
            <div className="min-w-0">
              <p className="text-[12px] font-bold text-warning-fg">
                Telemetry stops at: {d.brokenStage.label}
              </p>
              <p className="mt-0.5 text-[11px] text-warning-fg/80">{d.brokenStage.detail}</p>
            </div>
          </div>
        )}

        <ol className="flex flex-col gap-3 lg:flex-row lg:items-stretch">
          {d.pipeline.map((stage, i) => (
            <li key={stage.id} className="flex min-w-0 flex-1 items-start gap-3">
              <span
                className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-white"
                style={{ background: stage.ok ? 'var(--status-good)' : 'var(--status-critical)' }}
              >
                <Icon name={stage.ok ? 'check' : 'close'} size={13} strokeWidth={3} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[12px] font-bold text-fg">{stage.label}</span>
                <span className="mt-0.5 block text-[11px] leading-snug text-muted">{stage.detail}</span>
              </span>
              {i < d.pipeline.length - 1 && (
                <Icon
                  name="chevron-right"
                  size={15}
                  className="mt-1 hidden shrink-0 text-subtle lg:block"
                />
              )}
            </li>
          ))}
        </ol>

        <div className="mt-4 border-t border-border pt-3">
          <p className="mb-2 text-[10px] font-bold tracking-wide text-subtle uppercase">
            Endpoints the agent posts to
          </p>
          <ul className="grid gap-1.5 sm:grid-cols-2">
            {(d.comm.endpoints || []).map((e) => (
              <li key={e} className="flex items-start gap-2">
                <span
                  className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ background: 'var(--status-good)' }}
                  aria-hidden="true"
                />
                <code className="min-w-0 font-mono text-[11px] break-all text-muted">{e}</code>
              </li>
            ))}
            {(d.comm.endpoints || []).length === 0 && (
              <li className="text-[12px] text-subtle">None reported.</li>
            )}
          </ul>
        </div>
      </div>

      {/* ── the agent process itself ─────────────────────────────────────── */}
      <SectionTitle
        className="mt-gutter-lg"
        icon="agent"
        title="Agent process"
        hint="What the host reports about the ActMon service"
      />
      <div className="grid gap-gutter lg:grid-cols-3">
        <div className="card p-card">
          <h3 className="mb-3 text-[13px] font-bold text-fg">Service</h3>
          {d.serviceLoading ? (
            <p className="text-[12px] text-subtle">Checking…</p>
          ) : !svc?.checked ? (
            <p className="text-[12px] text-subtle">
              The service state could not be checked from the server.
            </p>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <span
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-white"
                  style={{ background: svc.running ? 'var(--status-good)' : 'var(--status-critical)' }}
                >
                  <Icon name={svc.running ? 'check' : 'close'} size={15} strokeWidth={3} />
                </span>
                <span>
                  <span className="block text-[15px] leading-none font-bold text-fg">
                    {svc.running ? 'Running' : 'Not running'}
                  </span>
                  <span className="mt-1 block text-[11px] text-subtle">
                    reported state: {svc.state || '—'}
                  </span>
                </span>
              </div>
              {svc.detail && <p className="mt-3 text-[11px] leading-relaxed text-muted">{svc.detail}</p>}
            </>
          )}
        </div>

        <div className="card p-card">
          <h3 className="mb-3 text-[13px] font-bold text-fg">Version</h3>
          <p className="text-[15px] font-bold text-fg">
            {d.agent.agent_version || 'Not reported'}
          </p>
          <p className="mt-1 text-[11px] text-subtle">
            {d.agent.agent_version
              ? 'reported on the last boot ping'
              : 'this host runs an agent from before version reporting'}
          </p>
          <div className="mt-3 border-t border-border pt-3">
            {!d.update ? (
              <p className="text-[11px] text-subtle">Checking for pushed updates…</p>
            ) : !d.update.has_update ? (
              <p className="flex items-center gap-1.5 text-[11px] text-muted">
                <StatusKey status={{ ...STATUS.good, label: 'No pending update' }} />
              </p>
            ) : (
              <UpdateState update={d.update} />
            )}
          </div>
        </div>

        <div className="card p-card">
          <h3 className="mb-3 text-[13px] font-bold text-fg">Registration</h3>
          <dl className="space-y-1.5 text-[11px]">
            <Row label="Agent name" value={d.agent.name} />
            <Row label="Host" value={d.agent.hostname} />
            <Row label="IP address" value={d.agent.ip} />
            <Row label="Operating system" value={d.agent.os_type} />
            <Row label="Environment" value={d.agent.environment} />
            <Row label="Collection interval" value={`${interval}s`} />
            <Row label="Registered" value={d.agent.created_at ? fullTime(d.agent.created_at) : null} />
            <Row label="Last heartbeat" value={d.agent.last_heartbeat ? fullTime(d.agent.last_heartbeat) : 'never'} />
          </dl>
        </div>
      </div>

      {/* ── events ──────────────────────────────────────────────────────── */}
      <SectionTitle className="mt-gutter-lg" icon="history" title="Agent events" />
      <div className="card p-card">
        {d.events.length === 0 ? (
          <p className="flex items-center gap-2 text-[12px] text-muted">
            <StatusKey status={STATUS.good} />
            No recent events — the agent is healthy.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {d.events.map((e, i) => (
              <li key={`${e.ts}-${i}`} className="flex items-start gap-2 text-[11px]">
                <Icon
                  name="alert" size={12} className="mt-0.5 shrink-0"
                  style={{ color: e.severity === 'critical' ? 'var(--status-critical)' : 'var(--status-warning)' }}
                />
                <span className="shrink-0 font-mono text-subtle">{String(e.ts || '').slice(0, 19)}</span>
                <span className="min-w-0 text-muted">{e.message}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Host OS detail intentionally lives under Infrastructure, not here. */}
      <p className="mt-gutter flex items-center gap-1.5 text-[11px] text-subtle">
        <Icon name="info" size={12} className="shrink-0" />
        Looking for CPU, disks, processes or interfaces on this machine?
        <Link to="/infra" className="font-semibold text-accent-text hover:underline">Infrastructure</Link>
        covers the host itself.
      </p>
    </>
  );
}

/* ── pieces ─────────────────────────────────────────────────────────────── */

function Header({ name, d, state }) {
  return (
    <PageHeader
      backTo="/agents"
      backLabel="Agents"
      title={name}
      icon="agent"
      description={[
        'Agent monitoring',
        d.agent.os_type ? `${d.agent.os_type} host agent` : null,
        d.agent.ip,
        `reporting every ${d.agent.collection_interval_sec || 60}s`,
      ].filter(Boolean).join(' · ')}
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
          <IconButton
            icon="refresh"
            label="Refresh now"
            onClick={d.refresh}
            iconClassName={d.isFetching ? 'animate-spin' : undefined}
          />
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

const KPI_TONES = {
  good: 'text-success-fg',
  warning: 'text-warning-fg',
  critical: 'text-danger-fg',
  neutral: 'text-fg',
};

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

/** Upgrade ledger state for this agent. */
function UpdateState({ update }) {
  const TONES = {
    pending: 'warning', installing: 'warning',
    confirmed: 'success', failed: 'danger', timed_out: 'danger',
  };
  return (
    <div>
      <div className="flex items-center gap-2">
        <Badge tone={TONES[update.status] || 'neutral'} size="xs">{update.status}</Badge>
        <span className="text-[11px] text-muted">
          {update.from_version || '—'} → <b className="text-fg">{update.expected_version}</b>
        </span>
      </div>
      {update.detail && <p className="mt-1.5 text-[11px] leading-relaxed text-muted">{update.detail}</p>}
      <dl className="mt-2 space-y-1 text-[10px]">
        <Row label="Issued" value={update.issued_at ? fullTime(update.issued_at) : null} />
        <Row label="Delivered" value={update.delivered_at ? fullTime(update.delivered_at) : null} />
        <Row label="Confirmed" value={update.confirmed_at ? fullTime(update.confirmed_at) : null} />
      </dl>
    </div>
  );
}

/**
 * One telemetry series. An empty ring is stated plainly, not drawn as zero.
 *
 * `family="trend"` routes through ChartCard's own ⋮ menu — the same picker
 * every other chart on this app offers (area/line/column/step/sparkline here),
 * remembered per card, instead of this being the one chart type with no choice.
 */
function TelemetryChart({ title, data, hasData, subtitle, loading, noDataHint, metric, slot, unit = '%', domain, thresholds = false }) {
  return (
    <ChartCard
      cardId={`agent-telemetry-${metric}`}
      family="trend"
      defaultKind="area"
      items={data}
      chartProps={{
        color: `var(--chart-${slot})`,
        unit,
        domain,
        thresholds,
        emptyLabel: 'Waiting for samples',
        emptyHint: noDataHint,
      }}
      title={title}
      icon="activity"
      subtitle={hasData ? subtitle : undefined}
      loading={loading && hasData}
      tableColumns={hasData ? [
        { key: 'time', label: 'Time' },
        { key: 'value', label: title, align: 'right' },
      ] : undefined}
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

const secs = (v) => {
  if (v === null || v === undefined) return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return n < 90 ? `${Math.round(n)}s` : `${Math.round(n / 60)}m`;
};
