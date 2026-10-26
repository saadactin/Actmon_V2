import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import cn from '@/lib/cn';
import PageHeader from '@/components/layout/PageHeader';
import HeaderRefreshButton from '@/components/layout/HeaderRefreshButton';
import Icon from '@/components/ui/Icon';
import IconButton from '@/components/ui/IconButton';
import ChartCard from '@/components/charts/ChartCard';
import StatTile from '@/components/charts/StatTile';
import RecentAlertsPanel from '@/components/dashboard/RecentAlertsPanel';
import TopHostsCard from '@/components/dashboard/TopHostsCard';
import { severityOf, STATUS } from '@/components/charts/status';
import useDashboardData from '@/hooks/useDashboardData';

// ApexCharts is a large dependency used by exactly one card on this page —
// lazy-loaded so its ~250KB (gzipped) doesn't ship inside the Dashboard
// route's own chunk, which every user pays for on first login.
const ApexDonut = lazy(() => import('@/components/charts/ApexDonut'));

const AUTO_REFRESH_SECONDS = 30;

// The design mockup lifts every card on hover (translateY + a stronger
// shadow) — applied here per-card via each component's own `className` prop
// rather than added to the shared `.card` rule, which every other page in
// the app (forms, tables, config panels) also uses and shouldn't inherit a
// hover animation never designed for it.
const CARD_HOVER = 'transition-[transform,box-shadow] duration-300 hover:-translate-y-[3px] hover:shadow-md';

// Hoisted to module scope: these never change, so recreating them every render
// (as inline literals) only ever produced garbage for the GC and, worse, broke
// ChartCard's memoization (a "stable" items/rows array paired with a freshly
// allocated tableColumns array still fails ChartCard's shallow-prop-equality
// check).
const FLEET_HEALTH_COLUMNS = [
  { key: 'status', label: 'Status' },
  { key: 'hosts', label: 'Hosts', align: 'right' },
  { key: 'share', label: 'Share', align: 'right' },
];
const SEVERITY_COLUMNS = [
  { key: 'severity', label: 'Severity' },
  { key: 'count', label: 'Alerts', align: 'right' },
];
// The three resource rankings, in display order. `key` matches useDashboardData's topHosts.
const TOP_HOST_CARDS = [
  { key: 'cpu', title: 'Top CPU Hosts', metricLabel: 'CPU Usage', icon: 'cpu' },
  { key: 'memory', title: 'Top Memory Hosts', metricLabel: 'Memory Usage', icon: 'memory' },
  { key: 'disk', title: 'Top Disk Hosts', metricLabel: 'Disk Usage', icon: 'archive' },
];
const ENGINE_TABLE_COLUMNS = [
  { key: 'engine', label: 'Engine' },
  { key: 'online', label: 'Online', align: 'right' },
  { key: 'warning', label: 'Warning', align: 'right' },
  { key: 'offline', label: 'Offline', align: 'right' },
  { key: 'total', label: 'Total', align: 'right' },
];

/**
 * Monitoring overview.
 *
 * Reads in three bands: the counts, then the shape of the estate, then what is
 * wrong with it. The alert feed runs down the right so "what needs attention" is
 * never below the fold, and the charts keep the left three quarters.
 *
 * Each card declares its DATA and its family, and names the form the layout was
 * drawn around via `defaultKind`. That form is what renders — only an explicit
 * pick from the card's own ⋮ menu changes it, so the page always opens looking the
 * way it was designed.
 *
 * What stays fixed no matter which form is picked:
 *   • health and utilisation wear the fixed status scale, never the accent
 *   • a legend for two or more series, and values printed on the marks
 *   • a table view on every card, so no number is reachable only by hovering
 *
 * Every `items`/`rows`/`chartProps`/`tableRows` below is useMemo'd, keyed on the
 * SPECIFIC slice of `d` it needs (not the whole `d` object) — `useDashboardData`
 * itself splits its derived data by domain (infra/resources/topCpu vs. alerts vs.
 * cloud), so alerts refetching every 15s no longer forces every OTHER card to
 * recompute its props and re-render; pairing that with `ChartCard` being
 * `memo()`-wrapped means an alerts-only tick now only re-renders the alerts card
 * and the alert feed, not the 4 other independent charts + 2 stat tiles.
 */
export default function Dashboard() {
  const navigate = useNavigate();
  const d = useDashboardData();

  const [countdown, setCountdown] = useState(AUTO_REFRESH_SECONDS);

  useEffect(() => {
    const t = setInterval(() => {
      setCountdown((c) => (c <= 1 ? AUTO_REFRESH_SECONDS : c - 1));
    }, 1000);
    return () => clearInterval(t);
  }, []);

  const refreshNow = () => { d.refresh(); setCountdown(AUTO_REFRESH_SECONDS); };
  const busy = d.isFetching && !d.isLoading;

  /* ── datasets, each memoized on only the slice of `d` it actually reads ── */

  const healthItems = useMemo(() => [
    { key: 'good', label: 'Online', value: d.infra.good, status: STATUS.good, onClick: () => navigate('/infra/hosts?status=online') },
    { key: 'warning', label: 'Warning', value: d.infra.warning, status: STATUS.warning, onClick: () => navigate('/infra/hosts?status=warning') },
    { key: 'critical', label: 'Offline', value: d.infra.critical, status: STATUS.critical, onClick: () => navigate('/infra/hosts?status=offline') },
  ], [d.infra.good, d.infra.warning, d.infra.critical, navigate]);

  const severityItems = useMemo(() => [
    { key: 'critical', label: 'Critical', value: d.alerts.critical, status: STATUS.critical, onClick: () => navigate('/alerts?sev=critical') },
    { key: 'warning', label: 'Warning', value: d.alerts.warning, status: STATUS.warning, onClick: () => navigate('/alerts?sev=warning') },
    { key: 'info', label: 'Info', value: d.alerts.info, status: severityOf('info'), onClick: () => navigate('/alerts?sev=info') },
  ], [d.alerts.critical, d.alerts.warning, d.alerts.info, navigate]);

  const engineRows = useMemo(() => d.perTech.map((t) => ({
    key: t.id,
    label: t.label,
    total: t.total,
    onClick: () => navigate(t.route),
    // a segment opens that technology filtered to the status; the legend opens every technology at that status
    segments: [
      { key: 'good', label: 'Online', value: t.good, status: STATUS.good, onClick: () => navigate(`${t.route}?status=online`), onLegendClick: () => navigate('/databases?status=online') },
      { key: 'warning', label: 'Warning', value: t.warning, status: STATUS.warning, onClick: () => navigate(`${t.route}?status=warning`), onLegendClick: () => navigate('/databases?status=warning') },
      { key: 'critical', label: 'Offline', value: t.critical + t.unknown, status: STATUS.critical, onClick: () => navigate(`${t.route}?status=offline`), onLegendClick: () => navigate('/databases?status=offline') },
    ],
  })), [d.perTech, navigate]);


  // CPU means good→bad, so these wear utilisation bands rather than series slots.

  const showCloud = d.cloud.total > 0;
  const CLOUD_ROUTE = { AWS: '/cloud/aws-accounts', AZURE: '/cloud/azure-accounts', OCI: '/cloud/oci-accounts' };
  const distribution = useMemo(() => (showCloud
    ? d.cloud.byProvider.map((p) => ({ ...p, onClick: () => navigate(CLOUD_ROUTE[String(p.key).toUpperCase()] || '/cloud') }))
    : d.byEnvironment.map((e) => ({ ...e, onClick: () => navigate(`/infra/hosts?env=${encodeURIComponent(e.key)}`) }))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [showCloud, d.cloud.byProvider, d.byEnvironment, navigate]);
  const osItems = useMemo(() => d.byOsType.map((o) => ({ ...o, onClick: () => navigate(`/infra/hosts?os=${encodeURIComponent(o.label)}`) })),
    [d.byOsType, navigate]);

  /* ── table-view rows, each memoized off the (already memoized) items above ── */

  const fleetHealthRows = useMemo(() => healthItems.map((s) => ({
    key: s.key,
    cells: {
      status: s.label,
      hosts: s.value,
      share: d.infra.total ? `${Math.round((s.value / d.infra.total) * 100)}%` : '—',
    },
  })), [healthItems, d.infra.total]);


  const distributionRows = useMemo(() => distribution.map((x) => ({ key: x.key, cells: { name: x.label, count: x.value } })),
    [distribution]);

  const distributionColumns = useMemo(() => [
    { key: 'name', label: showCloud ? 'Provider' : 'Environment' },
    { key: 'count', label: showCloud ? 'Accounts' : 'Hosts', align: 'right' },
  ], [showCloud]);

  const severityRows = useMemo(() => severityItems.map((s) => ({ key: s.key, cells: { severity: s.label, count: s.value } })),
    [severityItems]);

  const engineTableRows = useMemo(() => d.perTech.map((t) => ({
    key: t.id,
    cells: {
      engine: t.label, online: t.good, warning: t.warning,
      offline: t.critical + t.unknown, total: t.total,
    },
  })), [d.perTech]);

  /* ── chart-only props, memoized on their specific small inputs ──────────── */

  const fleetHealthChartProps = useMemo(() => ({
    legend: 'below', size: 146, centerLabel: `${d.infra.total} Hosts`,
    emptyLabel: 'No hosts registered yet', labelWidth: 64,
  }), [d.infra.total]);


  const distributionChartProps = useMemo(() => ({
    legend: 'below', size: 146, labelWidth: 92,
    centerLabel: showCloud ? `${d.cloud.total} Accounts` : `${d.infra.total} Hosts`,
    emptyLabel: showCloud ? 'No accounts' : 'No hosts registered yet',
  }), [showCloud, d.cloud.total, d.infra.total]);

  const severityChartProps = useMemo(() => ({ emptyLabel: 'Nothing firing', labelWidth: 60, height: 205 }), []);
  const engineChartProps = useMemo(() => ({ emptyLabel: 'No database hosts discovered yet', height: 205 }), []);

  const severityDisplayItems = d.alerts.total ? severityItems : [];

  /* ── tones: colour a count only where the colour means something ─────── */
  const healthTone = !d.infra.total ? 'neutral'
    : d.infra.health >= 90 ? 'good' : d.infra.health >= 60 ? 'warning' : 'danger';
  const sshTone = !d.ssh.total ? 'neutral' : d.ssh.critical ? 'warning' : 'good';
  const alertTone = d.alerts.critical ? 'danger' : d.alerts.warning ? 'warning' : 'good';
  const cloudTone = d.cloudError ? 'warning' : d.cloud.total ? 'danger' : 'neutral';

  return (
    <>
      <PageHeader
        title="Monitoring Overview"
        hideBreadcrumbs
        actions={<HeaderRefreshButton seconds={countdown} onClick={refreshNow} spinning={d.isFetching} />}
      />

      {(d.offline || d.unauthorised) && (
        <Notice
          tone={d.unauthorised ? 'warning' : 'danger'}
          icon={d.unauthorised ? 'shield' : 'alert'}
          title={d.unauthorised ? 'Not signed in' : 'Backend unreachable'}
          body={
            d.unauthorised
              ? 'The API rejected these requests. Sign in to load live monitoring data.'
              : 'Could not reach the API. Start the backend, then refresh.'
          }
        />
      )}

      {/* ── headline counts ──────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-gutter-lg sm:grid-cols-3 lg:grid-cols-5">
        <StatusTile
          label="Database Server" icon="database" tone="neutral" loading={d.isLoading} error={d.hostsError}
          total={d.databases.total} onTotal={() => navigate('/databases?status=all')}
          parts={[
            { key: 'online', label: 'Online', value: d.databases.good, tone: 'good', onClick: () => navigate('/databases?status=online') },
            { key: 'warning', label: 'Warning', value: d.databases.warning, tone: 'warning', optional: true, onClick: () => navigate('/databases?status=warning') },
            { key: 'offline', label: 'Offline', value: d.databases.critical, tone: 'danger', onClick: () => navigate('/databases?status=offline') },
            { key: 'unknown', label: 'Unknown', value: d.databases.unknown, tone: 'muted', optional: true, onClick: () => navigate('/databases?status=unknown') },
          ]}
        />
        <StatusTile
          label="Infra Hosts" icon="server" tone={healthTone} loading={d.isLoading} error={d.hostsError}
          total={d.infra.total} onTotal={() => navigate('/infra/hosts')}
          parts={[
            { key: 'online', label: 'Online', value: d.infra.good, tone: 'good', onClick: () => navigate('/infra/hosts?status=online') },
            { key: 'warning', label: 'Warning', value: d.infra.warning, tone: 'warning', optional: true, onClick: () => navigate('/infra/hosts?status=warning') },
            { key: 'offline', label: 'Offline', value: d.infra.critical, tone: 'danger', onClick: () => navigate('/infra/hosts?status=offline') },
          ]}
        />
        <StatTile
          label="Cloud Accounts" value={d.cloudError ? '—' : d.cloud.total} icon="cloud" tone={cloudTone} valueTone={cloudTone}
          sub={d.cloudError ? 'Cloud service unavailable' : (d.cloud.byProvider.map((p) => p.label).join(' ') || 'None connected')}
          loading={d.isLoading} onClick={() => navigate('/cloud')}
        />
        <StatTile
          label="SSH Hosts" value={d.ssh.total} icon="terminal" tone={sshTone} valueTone={sshTone}
          sub={`${d.ssh.good} Online`}
          loading={d.isLoading} onClick={() => navigate('/infra')}
        />
        <StatTile
          label="Active Alerts" value={d.alerts.total}
          icon={d.alerts.total ? 'bell-ring' : 'bell'}
          tone={alertTone} valueTone={d.alerts.total ? alertTone : 'neutral'}
          sub={<><b className="font-semibold text-danger-fg">{d.alerts.critical} Critical</b>{'   '}{d.alerts.warning} Warning</>}
          loading={d.isLoading} onClick={() => navigate('/alerts')}
        />
      </div>

      {/* ── charts, with the alert feed running down the right ────────────── */}
      <div className="mt-gutter-lg grid gap-gutter-lg xl:grid-cols-4">
        <div className="flex flex-col gap-gutter-lg xl:col-span-3">
          {/* which hosts are working hardest: one ranking per resource */}
          <div className="grid gap-gutter-lg md:grid-cols-2 xl:grid-cols-3">
            {TOP_HOST_CARDS.map((c) => (
              <TopHostsCard
                key={c.key}
                title={c.title}
                metricLabel={c.metricLabel}
                icon={c.icon}
                data={d.topHosts[c.key]}
                loading={d.isLoading || busy}
                error={d.hostsError}
                fetchedAt={d.hostsFetchedAt}
                // each ranking drills into that host's CPU / Memory / Disk consumption page; the arrow opens the full ranking
                onHost={(h) => navigate(c.key === 'cpu' ? `/cpu-performance/${h.id}` : c.key === 'memory' ? `/memory/${h.id}` : `/disk/${h.id}`)}
                onMore={() => navigate(`/hosts/top/${c.key}`)}
                className={CARD_HOVER}
              />
            ))}
          </div>

          {/* shape of the estate: health, operating systems, where it runs —
              three equal columns (Engine Distribution was removed; the
              per-engine breakdown stays in "Servers By Database Technologies") */}
          <div className="grid gap-gutter-lg md:grid-cols-2 xl:grid-cols-3">
            <ChartCard
              cardId="fleet-health"
              family="flat"
              defaultKind="donut"
              items={healthItems}
              chartProps={fleetHealthChartProps}
              title="Fleet Health"
              className={cn('lg:min-h-[260px]', CARD_HOVER)}
              loading={busy}
              tableColumns={FLEET_HEALTH_COLUMNS}
              tableRows={fleetHealthRows}
            />

            <section className={cn('card flex flex-col px-card py-card lg:min-h-[260px]', CARD_HOVER, busy && 'opacity-70')}>
              <h2 className="mb-2 text-[17px] font-bold text-fg">Hosts by OS</h2>
              <Suspense fallback={<div className="grid flex-1 place-items-center text-[12px] text-subtle">Loading chart…</div>}>
                <ApexDonut items={osItems} centerLabel="Hosts" height={230} />
              </Suspense>
            </section>

            <ChartCard
              cardId="distribution"
              family="flat"
              defaultKind="donut"
              items={distribution}
              chartProps={distributionChartProps}
              title={showCloud ? 'Cloud by Provider' : 'Hosts by Environment'}
              className={cn('lg:min-h-[260px]', CARD_HOVER)}
              loading={busy}
              tableColumns={distributionColumns}
              tableRows={distributionRows}
            />
          </div>

          {/* what is firing, and where the hosts sit */}
          <div className="grid gap-gutter-lg lg:grid-cols-2">
            <ChartCard
              cardId="alerts-severity"
              family="flat"
              defaultKind="column"
              items={severityDisplayItems}
              chartProps={severityChartProps}
              title="Alerts By Severity"
              className={cn('lg:min-h-[316px]', CARD_HOVER)}
              loading={busy}
              action={<IconButton icon="arrow-right" label="Open alerts" size="sm" onClick={() => navigate('/alerts')} />}
              tableColumns={SEVERITY_COLUMNS}
              tableRows={severityRows}
            />

            <ChartCard
              cardId="hosts-by-engine"
              family="breakdown"
              defaultKind="stackedColumn"
              rows={engineRows}
              chartProps={engineChartProps}
              title="Servers By Database Technologies"
              className={cn('lg:min-h-[316px]', CARD_HOVER)}
              loading={busy}
              tableColumns={ENGINE_TABLE_COLUMNS}
              tableRows={engineTableRows}
            />
          </div>

        </div>

        <RecentAlertsPanel
          alerts={d.alerts.list}
          counts={{
            total: d.alerts.total,
            critical: d.alerts.critical,
            warning: d.alerts.warning,
            info: d.alerts.info,
          }}
          loading={busy}
          onOpenAll={() => navigate('/alerts')}
          className={cn('xl:self-start', CARD_HOVER)}
        />
      </div>
    </>
  );
}

/* ── small pieces ───────────────────────────────────────────────────────── */

const TILE_ICON = {
  neutral: 'bg-sunken text-muted', good: 'bg-success-soft text-success-fg',
  warning: 'bg-warning-soft text-warning-fg', danger: 'bg-danger-soft text-danger-fg',
};
const PART_TEXT = { good: 'text-success-fg', warning: 'text-warning-fg', danger: 'text-danger-fg', muted: 'text-muted' };
const PART_DOT = { good: 'bg-success', warning: 'bg-warning', danger: 'bg-danger', muted: 'bg-[var(--status-unknown)]' };
const FOCUS_RING = 'rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1';

/**
 * StatTile's look (same card, icon disc, 30px count, 12px status line), but with
 * the title/total and each status as its own button, so "Online" and "Offline"
 * can each open their filtered list. (StatTile itself is one button; buttons
 * cannot nest.) Optional parts (Warning) appear only when non-zero, so the parts
 * shown always add up to the total.
 */
function StatusTile({ label, icon, tone = 'neutral', total, onTotal, parts, loading, error }) {
  const text = error ? '—' : (typeof total === 'number' && total < 10 ? `0${total}` : String(total ?? '—'));
  return (
    <div className={cn('card group flex flex-col gap-3.5 px-card py-card transition-colors hover:border-strong', loading && 'opacity-55')}>
      <button type="button" onClick={onTotal} className={cn('flex items-center gap-3 text-left', FOCUS_RING)} aria-label={`${label}: ${error ? 'unavailable' : total} — open the full list`}>
        <span className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-full transition-transform duration-300 group-hover:scale-110 group-hover:-rotate-6', TILE_ICON[tone] || TILE_ICON.neutral)}>
          <Icon name={icon} size={18} />
        </span>
        <span className="truncate-safe min-w-0 flex-1 text-[15px] font-medium text-fg">{label}</span>
        <Icon name="arrow-right" size={14} className="shrink-0 text-subtle opacity-0 transition-opacity group-hover:opacity-100" />
      </button>
      <span className="min-w-0">
        <button type="button" onClick={onTotal} tabIndex={-1} className="block text-[30px] leading-none font-bold text-fg tabular-nums hover:text-accent-text">
          {text}
        </button>
        <span className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
          {error ? <span className="text-subtle">Host list unavailable</span> : parts.filter((p) => !p.optional || p.value > 0).map((p) => (
            <button
              key={p.key} type="button" onClick={p.onClick}
              aria-label={`${p.value} ${p.label} — show only ${p.label.toLowerCase()} ones`}
              className={cn('inline-flex items-center gap-1 font-semibold tabular-nums underline-offset-2 hover:underline', PART_TEXT[p.tone], FOCUS_RING)}
            >
              <span className={cn('h-1.5 w-1.5 rounded-full', PART_DOT[p.tone])} aria-hidden="true" />
              {p.value} {p.label}
            </button>
          ))}
        </span>
      </span>
    </div>
  );
}

function Notice({ tone, icon, title, body }) {
  const TONES = {
    warning: 'bg-warning-soft text-warning-fg',
    danger: 'bg-danger-soft text-danger-fg',
  };
  return (
    <div className="card mb-gutter-lg flex items-start gap-3 px-card py-3">
      <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-md ${TONES[tone]}`}>
        <Icon name={icon} size={16} />
      </span>
      <div className="min-w-0">
        <p className="text-[13px] font-bold text-fg">{title}</p>
        <p className="mt-0.5 text-[12px] text-muted">{body}</p>
      </div>
    </div>
  );
}
