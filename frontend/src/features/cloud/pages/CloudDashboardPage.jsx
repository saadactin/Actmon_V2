import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import client, { errorText } from '@/api/client';
import PageHeader from '@/components/layout/PageHeader';
import StatTile from '@/components/charts/StatTile';
import ChartCard from '@/components/charts/ChartCard';
import { STATUS } from '@/components/charts/status';
import RecentAlertsPanel from '@/components/dashboard/RecentAlertsPanel';
import Notice from '@/components/ui/Notice';
import { PageLoading } from '@/components/ui/Loading';

/**
 * Cloud Dashboard — an independent landing page for Cloud Engineers, separate
 * from the main Admin Dashboard (pages/Dashboard.jsx). Shows ONLY cloud data
 * (accounts, resources, cost, security, alerts) aggregated cross-account —
 * never Database/Infrastructure/Agent numbers, so a role that holds only
 * this page's permission never sees anything outside its remit.
 *
 * Same visual language as the Admin Dashboard on purpose (KPI row → donut
 * charts → a real alert feed, using the SAME ChartCard/RecentAlertsPanel
 * components, not look-alikes) — this is meant to read as "the same kind of
 * dashboard," just scoped to cloud.
 *
 * Backed by GET /api/v1/cloud-dashboard/overview (Backend/database, gated by
 * require_permission on the CLOUD_DASHBOARD page — real backend
 * authorization, 403 on denial, not just this route existing in the router).
 * That endpoint itself proxies the separate Cloud microservice server-to-
 * server, so the browser never talks to that service directly for this page.
 */

const REFRESH_SECONDS = 30;

const PROVIDER_COLUMNS = [
  { key: 'provider', label: 'Provider' },
  { key: 'accounts', label: 'Accounts', align: 'right' },
];

const SEVERITY_COLUMNS = [
  { key: 'severity', label: 'Severity' },
  { key: 'count', label: 'Findings', align: 'right' },
];

const ALERT_STATE_COLUMNS = [
  { key: 'state', label: 'State' },
  { key: 'count', label: 'Alerts', align: 'right' },
];

const PROVIDER_HEALTH_COLUMNS = [
  { key: 'provider', label: 'Provider' },
  { key: 'ok', label: 'Healthy', align: 'right' },
  { key: 'scanning', label: 'Scanning', align: 'right' },
  { key: 'failed', label: 'Failed', align: 'right' },
  { key: 'never_scanned', label: 'Never Scanned', align: 'right' },
  { key: 'total', label: 'Total', align: 'right' },
];

export default function CloudDashboardPage() {
  const navigate = useNavigate();
  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ['cloudDashboardOverview'],
    queryFn: () => client.get('/cloud-dashboard/overview').then((r) => r.data),
    refetchInterval: REFRESH_SECONDS * 1000,
    retry: false,
  });

  const [countdown, setCountdown] = useState(REFRESH_SECONDS);
  useEffect(() => {
    const t = setInterval(() => setCountdown((c) => (c <= 1 ? REFRESH_SECONDS : c - 1)), 1000);
    return () => clearInterval(t);
  }, []);

  const accounts = data?.accounts || {};
  const resources = data?.resources || {};
  const security = data?.security || {};
  const alerts = data?.alerts || {};
  const cost = data?.cost || {};

  const providerItems = useMemo(() => Object.entries(accounts.by_provider || {})
    .map(([p, n]) => ({ key: p, label: p, value: n })), [accounts.by_provider]);
  const providerRows = useMemo(() => providerItems.map((p) => ({
    key: p.key, cells: { provider: p.label, accounts: p.value },
  })), [providerItems]);

  // Cloud connections by provider, split by connection health — same
  // category x status shape as the Admin Dashboard's "Servers By Database
  // Technologies" chart (AWS/Azure/OCI, and GCP too the moment the Cloud
  // service actually returns a "GCP" provider on an account; nothing here
  // hardcodes the provider list, so a new one just shows up).
  const providerHealthRows = useMemo(() => Object.entries(accounts.by_provider_status || {}).map(([provider, s]) => ({
    key: provider,
    label: provider,
    total: (s.ok || 0) + (s.scanning || 0) + (s.failed || 0) + (s.never_scanned || 0),
    segments: [
      { key: 'ok', label: 'Healthy', value: s.ok || 0, status: STATUS.good },
      { key: 'scanning', label: 'Scanning', value: s.scanning || 0, status: STATUS.warning },
      { key: 'failed', label: 'Failed', value: s.failed || 0, status: STATUS.critical },
      { key: 'never_scanned', label: 'Never Scanned', value: s.never_scanned || 0, status: STATUS.unknown },
    ],
  })), [accounts.by_provider_status]);
  const providerHealthTableRows = useMemo(() => providerHealthRows.map((r) => ({
    key: r.key,
    cells: {
      provider: r.label,
      ok: r.segments[0].value, scanning: r.segments[1].value,
      failed: r.segments[2].value, never_scanned: r.segments[3].value,
      total: r.total,
    },
  })), [providerHealthRows]);

  const severityItems = useMemo(() => [
    { key: 'critical', label: 'Critical', value: security.critical_findings || 0, status: STATUS.critical },
    { key: 'high', label: 'High', value: security.high_findings || 0, status: STATUS.serious },
    { key: 'medium', label: 'Medium', value: security.medium_findings || 0, status: STATUS.warning },
    { key: 'low', label: 'Low', value: security.low_findings || 0, status: STATUS.good },
  ], [security.critical_findings, security.high_findings, security.medium_findings, security.low_findings]);
  const severityRows = useMemo(() => severityItems.map((s) => ({
    key: s.key, cells: { severity: s.label, count: s.value },
  })), [severityItems]);
  const severityTotal = severityItems.reduce((sum, s) => sum + s.value, 0);

  const alertStateItems = useMemo(() => [
    { key: 'open', label: 'Open', value: alerts.open || 0, status: STATUS.critical },
    { key: 'acknowledged', label: 'Acknowledged', value: alerts.acknowledged || 0, status: STATUS.warning },
    { key: 'resolved', label: 'Resolved', value: alerts.resolved || 0, status: STATUS.good },
  ], [alerts.open, alerts.acknowledged, alerts.resolved]);
  const alertStateRows = useMemo(() => alertStateItems.map((a) => ({
    key: a.key, cells: { state: a.label, count: a.value },
  })), [alertStateItems]);
  const alertStateTotal = alertStateItems.reduce((sum, a) => sum + a.value, 0);

  const alertCounts = useMemo(() => {
    const bySeverity = { critical: 0, warning: 0, info: 0 };
    for (const a of (alerts.recent || [])) bySeverity[a.severity] = (bySeverity[a.severity] || 0) + 1;
    return { total: (alerts.recent || []).length, ...bySeverity };
  }, [alerts.recent]);

  if (isLoading) return <PageLoading title="Reading cloud accounts, resources, cost and security…" illustration />;
  if (error) {
    return (
      <>
        <PageHeader title="Cloud Dashboard" icon="cloud" />
        <Notice tone="danger" title="Could not load the Cloud Dashboard.">{errorText(error)}</Notice>
      </>
    );
  }

  const byProviderText = providerItems.map((p) => `${p.label} ${p.value}`).join(' · ') || 'No accounts connected';

  return (
    <>
      <PageHeader
        title="Cloud Dashboard"
        description="Cross-account overview — accounts, resources, cost, security and alerts across every connected cloud provider."
        icon="cloud"
      />

      <div className="space-y-gutter">
        {(data.errors || []).length > 0 && (
          <Notice tone="warning" title="Some cloud data could not be collected right now.">
            {data.errors.join(' · ')}
          </Notice>
        )}

        <div className="grid grid-cols-2 gap-gutter-lg lg:grid-cols-5">
          <StatTile
            label="Cloud Accounts" value={accounts.total ?? 0} icon="cloud" tone="accent"
            sub={byProviderText}
            loading={isFetching}
          />
          <StatTile
            label="Cloud Resources" value={resources.total ?? '—'} icon="boxes" tone="neutral"
            sub={resources.total == null ? 'Unavailable right now' : 'Across all connected accounts'}
            loading={isFetching}
          />
          <StatTile
            label="Monthly Cost" value={cost.available ? `${cost.currency || '$'} ${cost.total_monthly}` : '—'}
            icon="chart-trend" tone={cost.available ? 'good' : 'neutral'}
            sub={cost.available ? 'Sum across all accounts' : 'No billing data available'}
            loading={isFetching}
          />
          <StatTile
            label="Security Findings" value={severityTotal}
            icon="shield" tone={security.critical_findings ? 'danger' : security.high_findings ? 'warning' : 'good'}
            sub={`${security.critical_findings || 0} critical · ${security.high_findings || 0} high`}
            valueTone={security.critical_findings ? 'danger' : security.high_findings ? 'warning' : 'neutral'}
            loading={isFetching}
          />
          <StatTile
            label="Active Cloud Alerts" value={(alerts.open || 0) + (alerts.acknowledged || 0)}
            icon={alerts.open ? 'bell-ring' : 'bell'} tone={alerts.open ? 'danger' : 'good'}
            sub={`${alerts.open || 0} open · ${alerts.acknowledged || 0} acknowledged`}
            valueTone={alerts.open ? 'danger' : 'neutral'}
            loading={isFetching}
          />
        </div>

        <div className="grid gap-gutter-lg xl:grid-cols-4">
          <div className="flex flex-col gap-gutter-lg xl:col-span-3">
            <div className="grid gap-gutter-lg lg:grid-cols-3">
              <ChartCard
                cardId="cloud-dashboard-providers"
                family="flat"
                defaultKind="donut"
                items={providerItems}
                chartProps={{ legend: 'below', size: 146, centerLabel: `${accounts.total || 0} Accounts`, emptyLabel: 'No accounts connected', labelWidth: 84 }}
                title="Accounts by Provider"
                className="lg:min-h-[260px]"
                loading={isFetching}
                tableColumns={PROVIDER_COLUMNS}
                tableRows={providerRows}
              />

              <ChartCard
                cardId="cloud-dashboard-security"
                family="flat"
                defaultKind="donut"
                items={severityItems}
                chartProps={{ legend: 'below', size: 146, centerLabel: `${severityTotal} Findings`, emptyLabel: 'No findings — clean bill of health', labelWidth: 76 }}
                title="Security Findings by Severity"
                className="lg:min-h-[260px]"
                loading={isFetching}
                tableColumns={SEVERITY_COLUMNS}
                tableRows={severityRows}
              />

              <ChartCard
                cardId="cloud-dashboard-alert-states"
                family="flat"
                defaultKind="donut"
                items={alertStateItems}
                chartProps={{ legend: 'below', size: 146, centerLabel: `${alertStateTotal} Alerts`, emptyLabel: 'Nothing firing', labelWidth: 92 }}
                title="Alerts by State"
                className="lg:min-h-[260px]"
                loading={isFetching}
                tableColumns={ALERT_STATE_COLUMNS}
                tableRows={alertStateRows}
              />
            </div>

            <ChartCard
              cardId="cloud-dashboard-provider-health"
              family="breakdown"
              defaultKind="stackedColumn"
              rows={providerHealthRows}
              chartProps={{ emptyLabel: 'No cloud connections discovered yet', height: 205 }}
              title="Cloud Connections by Provider"
              className="lg:min-h-[316px]"
              loading={isFetching}
              tableColumns={PROVIDER_HEALTH_COLUMNS}
              tableRows={providerHealthTableRows}
            />
          </div>

          <RecentAlertsPanel
            title="Recent Cloud Alerts"
            alerts={alerts.recent || []}
            counts={alertCounts}
            loading={isFetching}
            onOpenAll={() => navigate('/cloud')}
            className="xl:col-span-1"
          />
        </div>

        <p className="text-[11px] text-subtle">
          Refreshes every {REFRESH_SECONDS}s (next in {countdown}s)
          {data.execution_time_ms != null && ` · backend responded in ${data.execution_time_ms}ms`}.
          {' '}
          <button type="button" onClick={() => { refetch(); setCountdown(REFRESH_SECONDS); }} className="font-semibold text-accent-text hover:underline">
            Refresh now
          </button>
        </p>
      </div>
    </>
  );
}
