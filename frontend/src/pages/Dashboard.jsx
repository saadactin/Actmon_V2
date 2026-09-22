import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import cn from '@/lib/cn';
import PageHeader from '@/components/layout/PageHeader';
import HeaderRefreshButton from '@/components/layout/HeaderRefreshButton';
import Icon from '@/components/ui/Icon';
import IconButton from '@/components/ui/IconButton';
import ChartCard from '@/components/charts/ChartCard';
import StatTile from '@/components/charts/StatTile';
import Gauge from '@/components/charts/Gauge';
import RecentAlertsPanel from '@/components/dashboard/RecentAlertsPanel';
import RankedTable from '@/components/dashboard/RankedTable';
import RankedBarChart from '@/components/dashboard/RankedBarChart';
import { bandFor, severityOf, STATUS } from '@/components/charts/status';
import useDashboardData, { TOP_CPU_HOSTS, TOP_ALERT_HOSTS } from '@/hooks/useDashboardData';

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
const ENGINE_DIST_COLUMNS = [
  { key: 'engine', label: 'Engine' },
  { key: 'hosts', label: 'Hosts', align: 'right' },
];
const SEVERITY_COLUMNS = [
  { key: 'severity', label: 'Severity' },
  { key: 'count', label: 'Alerts', align: 'right' },
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
    { key: 'good', label: 'Online', value: d.infra.good, status: STATUS.good },
    { key: 'warning', label: 'Warning', value: d.infra.warning, status: STATUS.warning },
    { key: 'critical', label: 'Offline', value: d.infra.critical, status: STATUS.critical },
  ], [d.infra.good, d.infra.warning, d.infra.critical]);

  const severityItems = useMemo(() => [
    { key: 'critical', label: 'Critical', value: d.alerts.critical, status: STATUS.critical },
    { key: 'warning', label: 'Warning', value: d.alerts.warning, status: STATUS.warning },
    { key: 'info', label: 'Info', value: d.alerts.info, status: severityOf('info') },
  ], [d.alerts.critical, d.alerts.warning, d.alerts.info]);

  const engineRows = useMemo(() => d.perTech.map((t) => ({
    key: t.id,
    label: t.label,
    total: t.total,
    onClick: () => navigate(t.route),
    segments: [
      { key: 'good', label: 'Online', value: t.good, status: STATUS.good },
      { key: 'warning', label: 'Warning', value: t.warning, status: STATUS.warning },
      { key: 'critical', label: 'Offline', value: t.critical + t.unknown, status: STATUS.critical },
    ],
  })), [d.perTech, navigate]);

  // Share of hosts per engine — engines with nothing deployed would only add
  // zero-width slices, so they sit this card out and stay in the one beside it.
  const engineShare = useMemo(() => d.perTech
    .filter((t) => t.total > 0)
    .map((t) => ({ key: t.id, label: t.label, value: t.total, onClick: () => navigate(t.route) })),
  [d.perTech, navigate]);

  // CPU means good→bad, so these wear utilisation bands rather than series slots.
  const cpuItems = useMemo(() => d.topCpu.map((h) => ({ ...h, status: bandFor(h.value) })), [d.topCpu]);

  const showCloud = d.cloud.total > 0;
  const distribution = useMemo(() => (showCloud ? d.cloud.byProvider : d.byEnvironment),
    [showCloud, d.cloud.byProvider, d.byEnvironment]);

  /* ── table-view rows, each memoized off the (already memoized) items above ── */

  const fleetHealthRows = useMemo(() => healthItems.map((s) => ({
    key: s.key,
    cells: {
      status: s.label,
      hosts: s.value,
      share: d.infra.total ? `${Math.round((s.value / d.infra.total) * 100)}%` : '—',
    },
  })), [healthItems, d.infra.total]);

  const engineShareRows = useMemo(() => engineShare.map((e) => ({ key: e.key, cells: { engine: e.label, hosts: e.value } })),
    [engineShare]);

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

  const engineDistTotal = useMemo(() => engineShare.reduce((s, e) => s + e.value, 0), [engineShare]);
  const engineDistChartProps = useMemo(() => ({
    legend: 'below', size: 146, centerLabel: `${engineDistTotal} Hosts`,
    emptyLabel: 'No database hosts discovered yet', labelWidth: 84,
  }), [engineDistTotal]);

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
  const agentTone = !d.agents.total ? 'neutral' : d.agents.critical ? 'warning' : 'good';
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
      <div className="grid grid-cols-2 gap-gutter-lg sm:grid-cols-3 lg:grid-cols-6">
        <StatTile
          label="Database Server" value={d.databases.total} icon="database" tone="neutral"
          sub={<><b className="font-semibold text-success-fg">{d.databases.good} Online</b>{'   '}{d.databases.critical} Offline</>}
          loading={d.isLoading} onClick={() => navigate('/databases')}
        />
        <StatTile
          label="Infra Hosts" value={d.infra.total} icon="server" tone={healthTone} valueTone={healthTone}
          sub={<b className="font-semibold text-success-fg">{d.infra.health}% Healthy</b>}
          loading={d.isLoading} onClick={() => navigate('/infra')}
        />
        <StatTile
          label="Cloud Accounts" value={d.cloudError ? '—' : d.cloud.total} icon="cloud" tone={cloudTone} valueTone={cloudTone}
          sub={d.cloudError ? 'Cloud service unavailable' : (d.cloud.byProvider.map((p) => p.label).join(' ') || 'None connected')}
          loading={d.isLoading} onClick={() => navigate('/cloud')}
        />
        <StatTile
          label="Agents" value={d.agents.total} icon="agent" tone={agentTone} valueTone={agentTone}
          sub={`${d.agents.good} Online`}
          loading={d.isLoading} onClick={() => navigate('/agents')}
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
          {/* how hard the fleet is working, at a glance */}
          <div className="grid gap-gutter-lg lg:grid-cols-3">
            <GaugeCard label="Avg. CPU Usage" value={d.resources.cpu} loading={busy} />
            <GaugeCard label="Avg. Memory Usage" value={d.resources.ram} loading={busy} />
            <GaugeCard label="Avg. Disk Usage" value={d.resources.disk} loading={busy} />
          </div>

          {/* shape of the estate: health, engines, where it runs */}
          <div className="grid gap-gutter-lg lg:grid-cols-4">
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
              <h2 className="mb-2 text-center text-[17px] font-bold text-fg">Hosts by OS</h2>
              <Suspense fallback={<div className="grid flex-1 place-items-center text-[12px] text-subtle">Loading chart…</div>}>
                <ApexDonut items={d.byOsType} centerLabel="Hosts" height={230} />
              </Suspense>
            </section>

            <ChartCard
              cardId="engine-distribution"
              family="flat"
              defaultKind="donut"
              items={engineShare}
              chartProps={engineDistChartProps}
              title="Engine Distribution"
              className={cn('lg:min-h-[260px]', CARD_HOVER)}
              loading={busy}
              tableColumns={ENGINE_DIST_COLUMNS}
              tableRows={engineShareRows}
            />

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

          {/* who is loudest right now: busiest hosts, most-alerting hosts */}
          <div className="grid gap-gutter-lg lg:grid-cols-2">
            <RankedTable
              title="Top Alerting Hosts"
              titleNote={`(Top ${TOP_ALERT_HOSTS})`}
              countLabel="Alerts"
              rows={d.alerts.topHosts}
              className={cn('lg:min-h-[316px]', CARD_HOVER)}
              onMore={() => navigate('/alerts')}
            />

            <RankedBarChart
              title="Top Hosts By CPU"
              titleNote={`(Top ${TOP_CPU_HOSTS})`}
              unit="%"
              max={100}
              rows={cpuItems}
              className={cn('lg:min-h-[316px]', CARD_HOVER)}
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
          className={CARD_HOVER}
        />
      </div>
    </>
  );
}

/* ── small pieces ───────────────────────────────────────────────────────── */

/** Speedometer-style resource gauge, one per card — the open half-ring form
 * of the shared Gauge component (`sweep={180}`), animated in on mount. */
function GaugeCard({ label, value, loading }) {
  return (
    <section className={cn('card flex flex-col items-center px-card py-card', CARD_HOVER, loading && 'opacity-70')}>
      <h2 className="mb-1 text-[17px] font-bold text-fg">{label}</h2>
      <Gauge label={label} value={value} size={220} thickness={20} sweep={180} showValue showLabel={false} animate />
    </section>
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
