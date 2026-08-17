import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import PageHeader from '@/components/layout/PageHeader';
import HeaderRefreshButton from '@/components/layout/HeaderRefreshButton';
import Icon from '@/components/ui/Icon';
import IconButton from '@/components/ui/IconButton';
import ChartCard from '@/components/charts/ChartCard';
import StatTile from '@/components/charts/StatTile';
import RecentAlertsPanel from '@/components/dashboard/RecentAlertsPanel';
import { bandFor, severityOf, STATUS } from '@/components/charts/status';
import useDashboardData, { TOP_CPU_HOSTS } from '@/hooks/useDashboardData';

const AUTO_REFRESH_SECONDS = 30;

/**
 * Each resource gets its own hue rather than a utilisation band.
 *
 * This card's job is to compare three different things side by side; three rings
 * all sitting in the same band would be indistinguishable. Series slots rather
 * than raw hex so the trio stays contrast-checked in every theme — the number
 * under each ring is what reports severity here.
 */
const RESOURCE_COLORS = {
  cpu: 'var(--chart-2)',
  ram: 'var(--chart-5)',
  disk: 'var(--chart-1)',
};

// Hoisted to module scope: these never change, so recreating them every render
// (as inline literals) only ever produced garbage for the GC and, worse, broke
// ChartCard's memoization (a "stable" items/rows array paired with a freshly
// allocated tableColumns array still fails ChartCard's shallow-prop-equality
// check). Same reasoning for `roundFormat` below — an inline arrow function is
// a new reference every render.
const FLEET_HEALTH_COLUMNS = [
  { key: 'status', label: 'Status' },
  { key: 'hosts', label: 'Hosts', align: 'right' },
  { key: 'share', label: 'Share', align: 'right' },
];
const HOSTS_BY_OS_COLUMNS = [
  { key: 'os', label: 'OS' },
  { key: 'hosts', label: 'Hosts', align: 'right' },
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
const TOP_CPU_COLUMNS = [
  { key: 'host', label: 'Host' },
  { key: 'cpu', label: 'CPU', align: 'right' },
  { key: 'band', label: 'Band', align: 'right' },
];
const RESOURCE_COLUMNS = [
  { key: 'resource', label: 'Resource' },
  { key: 'used', label: 'Avg used', align: 'right' },
  { key: 'band', label: 'Band', align: 'right' },
];
const roundFormat = (v) => Math.round(v);

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

  const resourceItems = useMemo(() => [
    { key: 'cpu', label: 'CPU', value: d.resources.cpu, color: RESOURCE_COLORS.cpu },
    { key: 'ram', label: 'RAM', value: d.resources.ram, color: RESOURCE_COLORS.ram },
    { key: 'disk', label: 'Disk', value: d.resources.disk, color: RESOURCE_COLORS.disk },
  ], [d.resources.cpu, d.resources.ram, d.resources.disk]);

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

  const hostsByOsRows = useMemo(() => d.byOsType.map((o) => ({ key: o.key, cells: { os: o.label, hosts: o.value } })),
    [d.byOsType]);

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

  const topCpuRows = useMemo(() => d.topCpu.map((h) => ({
    key: h.key,
    cells: { host: h.label, cpu: `${Math.round(h.value)}%`, band: bandFor(h.value).label },
  })), [d.topCpu]);

  const resourceRows = useMemo(() => resourceItems.map((r) => ({
    key: r.key,
    cells: { resource: r.label, used: `${r.value}%`, band: bandFor(r.value).label },
  })), [resourceItems]);

  /* ── chart-only props, memoized on their specific small inputs ──────────── */

  const fleetHealthChartProps = useMemo(() => ({
    legend: 'below', size: 146, centerLabel: `${d.infra.total} Hosts`,
    emptyLabel: 'No hosts registered yet', labelWidth: 64,
  }), [d.infra.total]);

  const hostsByOsChartProps = useMemo(() => ({
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

  const topCpuChartProps = useMemo(() => ({
    max: 100, unit: '%', format: roundFormat,
    emptyLabel: 'No host is reporting CPU yet',
    // Switched to the donut form, these are independent hosts' CPU %s —
    // summing them (PieChart's default center label) is a meaningless number,
    // not a "total". Name what's actually being counted instead, same as the
    // other donuts on this page.
    centerLabel: `${cpuItems.length} Host${cpuItems.length !== 1 ? 's' : ''}`,
  }), [cpuItems.length]);

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
          loading={d.isLoading} onClick={() => navigate('/infra')}
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
          {/* shape of the estate: health, engines, where it runs */}
          <div className="grid gap-gutter-lg lg:grid-cols-4">
            <ChartCard
              cardId="fleet-health"
              family="flat"
              defaultKind="donut"
              items={healthItems}
              chartProps={fleetHealthChartProps}
              title="Fleet Health"
              className="lg:min-h-[260px]"
              loading={busy}
              tableColumns={FLEET_HEALTH_COLUMNS}
              tableRows={fleetHealthRows}
            />

            <ChartCard
              cardId="hosts-by-os"
              family="flat"
              defaultKind="donut"
              items={d.byOsType}
              chartProps={hostsByOsChartProps}
              title="Hosts by OS"
              className="lg:min-h-[260px]"
              loading={busy}
              tableColumns={HOSTS_BY_OS_COLUMNS}
              tableRows={hostsByOsRows}
            />

            <ChartCard
              cardId="engine-distribution"
              family="flat"
              defaultKind="donut"
              items={engineShare}
              chartProps={engineDistChartProps}
              title="Engine Distribution"
              className="lg:min-h-[260px]"
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
              className="lg:min-h-[260px]"
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
              className="lg:min-h-[316px]"
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
              title="Servers By Technology"
              className="lg:min-h-[316px]"
              loading={busy}
              tableColumns={ENGINE_TABLE_COLUMNS}
              tableRows={engineTableRows}
            />
          </div>

          {/* how hard it is working */}
          <div className="grid gap-gutter-lg lg:grid-cols-2">
            <ChartCard
              cardId="top-cpu"
              family="flat"
              defaultKind="bar"
              items={cpuItems}
              chartProps={topCpuChartProps}
              title="Top Hosts By CPU"
              titleNote={`(Top ${TOP_CPU_HOSTS})`}
              className="lg:min-h-[316px]"
              loading={busy}
              tableColumns={TOP_CPU_COLUMNS}
              tableRows={topCpuRows}
            />

            <ChartCard
              cardId="resource-usage"
              family="ratio"
              defaultKind="gauge"
              items={resourceItems}
              title="Average Resource Usage"
              className="lg:min-h-[316px]"
              loading={busy}
              tableColumns={RESOURCE_COLUMNS}
              tableRows={resourceRows}
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
        />
      </div>
    </>
  );
}

/* ── small pieces ───────────────────────────────────────────────────────── */

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
