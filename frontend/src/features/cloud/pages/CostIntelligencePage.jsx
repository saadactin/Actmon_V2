/**
 * Cost Intelligence — the multi-cloud FinOps workspace.
 *
 * Replaces the single scrolling Cost page with a tabbed workspace, while
 * REUSING the existing Explorer, Report and Recommendation components rather
 * than reimplementing them: those already carry the server-side filtering,
 * pagination and list-price savings maths that took real work to get right.
 *
 * Three things here are structural rather than cosmetic:
 *
 *  - **Tab and filters live in the URL.** A cost finding is something people
 *    send to each other; a link that reopens on the Overview with no filters
 *    is not a finding, it is a suggestion to go looking.
 *  - **Account switching resets filters.** Provider capabilities differ, so a
 *    filter carried from OCI to AWS could silently match nothing and read as
 *    "AWS costs nothing".
 *  - **Data quality sits in the header, not buried.** It is visible on every
 *    tab and opens the diagnostics, because a number whose reliability you
 *    cannot check is not usable for a decision.
 */
import { useCallback, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import CloudPageHeader from '../components/CloudPageHeader';
import CloudToolbar from '../components/CloudToolbar';
import CloudSection from '../components/CloudSection';
import Tabs from '@/components/ui/Tabs';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import { PageLoading } from '@/components/ui/Loading';
import {
  Activity, AlertTriangle, BarChart3, Gauge, LayoutDashboard, PiggyBank,
  Receipt, Target, TrendingUp,
} from 'lucide-react';

import { useCloudScope } from '../hooks/useCloudScope';
import {
  useBudgetStatus, useCostAnalytics, useCostAnomalies, useCostBackfillStatus,
  useCostCapabilities, useCostCoverage, useCostForecast, useCostHistory,
  useCostQuality, useCostTrends, useStartBackfill,
} from '../hooks/useCost';

import { CostExplorerPanel } from '../components/CostExplorerPanel';
import { CostReportPanel } from '../components/CostReportPanel';
import { RecommendationDetailModal } from '../components/RecommendationDetailModal';
import { DiagnosticModal } from '../components/DiagnosticModal';

import CostKpiCards, { ProviderSpendCards, SpendHeadline } from '../components/cost/CostKpiCards';
import {
  CapabilityMatrix, DataQualityBadge, FreshnessPanel, ProviderStatusStrip,
} from '../components/cost/CostDataQuality';
import {
  CostBreakdownBars, CostCalendarHeatmap, CostTrendChart,
} from '../components/cost/CostCharts';
import {
  AnomalyList, BudgetPanel, ChangeAnalysisPanel, ForecastPanel, TopCostDrivers,
} from '../components/cost/CostPanels';
import { PanelHeading } from '../components/cost/CostPrimitives';
import { groupByCurrency, isMissing } from '../utils/costFormat';

/** Date presets. Exact dates are always shown alongside — "last 30 days" on its
 *  own is not a period anyone can reconcile against an invoice. */
const RANGES = [
  { label: 'Last 7 days', days: 7 },
  { label: 'Last 30 days', days: 30 },
  { label: 'Last 90 days', days: 90 },
  { label: 'Last 180 days', days: 180 },
  { label: 'Last 365 days', days: 365 },
];

function rangeDates(days) {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - days);
  const fmt = (d) => d.toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
  });
  return { start: fmt(start), end: fmt(end) };
}

export default function CostIntelligencePage({ embedded = false, accountId }) {
  const scope = useCloudScope();
  const accounts = scope.scopedAccounts;
  const scopedAccountId = scope.accountId;

  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') || 'overview';
  const days = Number(params.get('days') || 30);
  const accountParam = params.get('account') || 'ALL';
  const serviceFilter = params.get('service') || null;

  // Inside a provider scope, 'ALL' must not fan out to other providers. When
  // embedded in the account dashboard the route's account always wins — the
  // surrounding page has already committed to one account.
  const accountView = accountId
    || (accountParam === 'ALL'
      ? (scope.isScoped ? (scopedAccountId ?? 'ALL') : 'ALL')
      : accountParam);

  const setParam = useCallback((patch) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      Object.entries(patch).forEach(([k, v]) => {
        if (v === null || v === undefined || v === '') next.delete(k);
        else next.set(k, String(v));
      });
      return next;
    }, { replace: true });
  }, [setParams]);

  // Switching account clears every filter but the tab and range.
  const onAccountChange = useCallback((id) => {
    setParams((prev) => {
      const next = new URLSearchParams();
      const t = prev.get('tab');
      if (t) next.set('tab', t);
      next.set('account', id || 'ALL');
      next.set('days', String(days));
      return next;
    }, { replace: true });
  }, [setParams, days]);

  const [activeOpt, setActiveOpt] = useState(null);
  const [showDiagnostics, setShowDiagnostics] = useState(false);

  const analytics = useCostAnalytics(accountView);
  const quality = useCostQuality(accountView);
  const capabilities = useCostCapabilities(accountView);
  const coverage = useCostCoverage(accountView);
  const history = useCostHistory(accountView, days, 'service');
  const forecast = useCostForecast(accountView, Math.max(days, 90));
  const anomalies = useCostAnomalies(accountView, Math.max(days, 90));
  const trends = useCostTrends(accountView, days, 'service');
  const budgets = useBudgetStatus(accountView !== 'ALL' ? accountView : undefined);
  const backfill = useCostBackfillStatus(accountView !== 'ALL' ? accountView : null);
  const startBackfill = useStartBackfill(accountView);

  const a = analytics.data;
  const totals = a?.totals_by_currency;
  const primaryCurrency = totals?.currency || a?.currency || null;
  const quality_ = quality.data;
  const dates = rangeDates(days);

  // One trend chart per currency — stacking USD on INR would draw a shape
  // whose height is a meaningless number.
  const historyByCurrency = useMemo(
    () => groupByCurrency(history.data?.series || []),
    [history.data],
  );

  const anomaliesForCurrency = useCallback(
    (code) => anomalies.data?.by_currency?.[code]?.anomalies || [],
    [anomalies.data],
  );

  const serviceRows = useMemo(() => {
    const rows = (a?.by_service || []).map((r) => ({
      service: r.service,
      amount: r.monthly_cost,
      currency: r.currency,
      provider: r.provider,
    }));
    return serviceFilter ? rows.filter((r) => r.service === serviceFilter) : rows;
  }, [a, serviceFilter]);

  const diagnosticItems = useMemo(() => {
    const fromCost = (a?.cost_diagnostics || []).map((d) => ({
      scope: d.account_name,
      provider: d.provider,
      category: d.category,
      message: d.message,
      retry_after_seconds: d.retry_after_seconds,
      required_permission: d.required_permission,
      http_status: d.http_status,
    }));
    // Capability limits are not failures, but the user is asking the same
    // question ("why is this blank?"), so they belong in the same place.
    const blocked = capabilities.data?.blocked_by || {};
    const fromCaps = Object.entries(blocked).flatMap(([dimension, byProvider]) =>
      Object.entries(byProvider || {}).map(([provider, reason]) => ({
        scope: dimension.replace(/_/g, ' '),
        provider,
        category: 'unsupported',
        message: reason,
      })));
    return [...fromCost, ...fromCaps];
  }, [a, capabilities.data]);

  const calendarDays = useMemo(() => {
    const first = historyByCurrency[0];
    if (!first) return { currency: null, days: [] };
    const peak = Math.max(...first.items.map((x) => Number(x.amount) || 0), 0);
    const flagged = anomaliesForCurrency(first.currency).map((x) => x.date);
    return {
      currency: first.currency,
      days: first.items.map((p) => ({
        date: p.date,
        amount: p.amount,
        intensity: peak > 0 && !isMissing(p.amount) ? Number(p.amount) / peak : null,
        anomalous: flagged.includes(p.date),
      })),
    };
  }, [historyByCurrency, anomaliesForCurrency]);

  const TABS = [
    { id: 'overview', label: 'Overview', icon: LayoutDashboard },
    { id: 'explorer', label: 'Explorer', icon: BarChart3 },
    { id: 'trends', label: 'Trends', icon: TrendingUp },
    { id: 'forecast', label: 'Forecast', icon: Activity },
    {
      id: 'anomalies',
      label: 'Anomalies',
      icon: AlertTriangle,
      count: anomalies.data?.total || undefined,
      tone: 'danger',
    },
    {
      id: 'recommendations',
      label: 'Optimize',
      icon: PiggyBank,
      count: a?.optimizations?.length || undefined,
    },
    { id: 'budgets', label: 'Budgets', icon: Target },
    { id: 'reports', label: 'Reports', icon: Receipt },
    { id: 'diagnostics', label: 'Diagnostics', icon: Gauge },
  ];

  if (analytics.isLoading && !a) {
    return <PageLoading title="Loading cost intelligence…" />;
  }

  return (
    <>
      {embedded ? (
        // The dashboard already supplies a page header and an account picker,
        // so only the quality badge is carried over — it must stay reachable
        // from every context, not just the standalone page.
        <div className="mb-3 flex justify-end">
          <DataQualityBadge
            quality={quality_?.quality}
            onClick={() => setShowDiagnostics(true)}
          />
        </div>
      ) : (
        <CloudPageHeader
          backTo="/cloud"
          title="Cost Intelligence"
          description="Multi-cloud spend, trends, forecasting, anomalies and optimization across AWS, Azure and OCI"
          actions={(
            <CloudToolbar
              selectorProps={accounts?.length ? {
                accounts,
                mode: 'multi',
                selected: accountView,
                onSelect: onAccountChange,
              } : undefined}
            >
              <DataQualityBadge
                quality={quality_?.quality}
                onClick={() => setShowDiagnostics(true)}
              />
            </CloudToolbar>
          )}
        />
      )}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div
          className="flex flex-wrap gap-1 rounded-control border border-border bg-surface p-1"
          role="group"
          aria-label="Date range"
        >
          {RANGES.map((r) => (
            <button
              key={r.days}
              type="button"
              onClick={() => setParam({ days: r.days })}
              aria-pressed={days === r.days}
              className={
                days === r.days
                  ? 'rounded-[6px] bg-accent-soft px-2.5 py-1 text-[11.5px] font-semibold text-accent-text'
                  : 'rounded-[6px] px-2.5 py-1 text-[11.5px] font-medium text-muted hover:text-fg'
              }
            >
              {r.label}
            </button>
          ))}
        </div>
        <span className="text-[11.5px] text-muted">
          {dates.start} → {dates.end}
          <span className="ml-1.5 text-subtle">(UTC)</span>
        </span>
        {serviceFilter && (
          <Badge tone="accent">
            Service: {serviceFilter}
            <button
              type="button"
              onClick={() => setParam({ service: null })}
              className="ml-1 font-bold"
              aria-label="Clear service filter"
            >
              ×
            </button>
          </Badge>
        )}
      </div>

      <ProviderStatusStrip
        quality={quality_}
        onDiagnostics={() => setShowDiagnostics(true)}
      />

      <Tabs tabs={TABS} value={tab} onChange={(id) => setParam({ tab: id })} className="my-4" />

      {/* ── Overview ────────────────────────────────────────────────────── */}
      {tab === 'overview' && (
        <div className="space-y-4">
          <SpendHeadline
            totals={totals}
            period={{ ...dates, days }}
            source={a?.cost_source}
            onWhy={() => setShowDiagnostics(true)}
          />

          {accountView === 'ALL' && <ProviderSpendCards byService={a?.by_service} />}

          <CostKpiCards
            totals={totals}
            forecast={forecast.data}
            coverage={coverage.data}
            quality={quality_}
            savings={a?.potential_savings}
            savingsCurrency={a?.currency}
            optimizationCount={a?.optimizations?.length}
            unmatchedCount={a?.unmatched_resources}
            monthOverMonth={trends.data?.month_over_month}
          />

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            <CloudSection
              title="Spend trend"
              description="Daily billed spend from stored history"
              className="xl:col-span-2"
            >
              {historyByCurrency.length ? (
                historyByCurrency.map(({ currency, items }) => (
                  <div key={currency} className="mb-4 last:mb-0">
                    {historyByCurrency.length > 1 && (
                      <p className="mb-1 text-[11px] font-bold uppercase tracking-wider text-muted">
                        {currency}
                      </p>
                    )}
                    <CostTrendChart
                      series={items}
                      currency={currency}
                      anomalies={anomaliesForCurrency(currency)}
                      onWhy={() => setShowDiagnostics(true)}
                    />
                  </div>
                ))
              ) : (
                <CostTrendChart series={[]} onWhy={() => setShowDiagnostics(true)} />
              )}
            </CloudSection>

            <CloudSection title="Top cost drivers" description="Click to filter the page">
              <TopCostDrivers
                rows={serviceRows}
                currency={primaryCurrency}
                onSelect={(name) => setParam({ service: name })}
              />
            </CloudSection>
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <CloudSection title="Cost by service">
              <CostBreakdownBars
                rows={serviceRows}
                currency={primaryCurrency}
                dimension="service"
                onSelect={(name) => setParam({ service: name })}
                onWhy={() => setShowDiagnostics(true)}
              />
            </CloudSection>
            <CloudSection
              title="Spend calendar"
              description="Daily intensity; anomalous days are ringed"
            >
              {calendarDays.days.length ? (
                <CostCalendarHeatmap
                  currency={calendarDays.currency}
                  days={calendarDays.days}
                />
              ) : (
                <p className="text-[12px] text-muted">
                  No stored billing history for this period.
                </p>
              )}
            </CloudSection>
          </div>
        </div>
      )}

      {/* ── Explorer (reuses the existing panel) ────────────────────────── */}
      {tab === 'explorer' && (
        <CostExplorerPanel
          accountId={accountView}
          potentialSavings={a?.potential_savings}
          savingsCurrency={a?.currency}
        />
      )}

      {/* ── Trends ─────────────────────────────────────────────────────── */}
      {tab === 'trends' && (
        <CloudSection
          title="What changed"
          description="Associated cost movement between this period and the one before it"
        >
          <ChangeAnalysisPanel
            change={trends.data?.change}
            period={trends.data?.period}
            comparisonPeriod={trends.data?.comparison_period}
            onWhy={() => setShowDiagnostics(true)}
          />
        </CloudSection>
      )}

      {/* ── Forecast ───────────────────────────────────────────────────── */}
      {tab === 'forecast' && (
        <CloudSection
          title="Forecast"
          description="Run-rate projection from observed daily spend"
        >
          <ForecastPanel
            forecast={forecast.data}
            history={history.data?.series}
            coverage={coverage.data}
            onBackfill={accountView !== 'ALL' ? () => startBackfill.mutate(90) : undefined}
            onWhy={() => setShowDiagnostics(true)}
          />
        </CloudSection>
      )}

      {/* ── Anomalies ──────────────────────────────────────────────────── */}
      {tab === 'anomalies' && (
        <CloudSection
          title="Cost anomalies"
          description="Days exceeding both a percentage and an absolute threshold against their trailing baseline"
        >
          <AnomalyList
            anomalies={anomalies.data}
            coverage={coverage.data}
            onBackfill={accountView !== 'ALL' ? () => startBackfill.mutate(90) : undefined}
          />
        </CloudSection>
      )}

      {/* ── Recommendations ────────────────────────────────────────────── */}
      {tab === 'recommendations' && (
        <CloudSection
          title="Optimization opportunities"
          description="Savings are priced from provider list rates; where they cannot be priced they show NA"
        >
          {(a?.optimizations || []).length ? (
            <ul className="space-y-2">
              {a.optimizations.map((opt) => (
                <li key={opt.id}>
                  <button
                    type="button"
                    onClick={() => setActiveOpt(opt)}
                    className="flex w-full items-start gap-3 rounded-card border border-border bg-surface p-3 text-left transition-colors hover:bg-sunken"
                  >
                    <Badge
                      tone={opt.severity === 'CRITICAL' || opt.severity === 'HIGH'
                        ? 'danger' : opt.severity === 'MEDIUM' ? 'warning' : 'info'}
                      size="xs"
                    >
                      {opt.severity}
                    </Badge>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-semibold text-fg">{opt.rule}</span>
                      <span className="mt-0.5 block text-[11.5px] leading-relaxed text-muted">
                        {opt.description}
                      </span>
                    </span>
                    <span className="shrink-0 text-right">
                      <span className="block text-[13px] font-bold tabular-nums text-fg">
                        {isMissing(opt.potential_savings)
                          ? 'NA'
                          : `${opt.savings_currency || ''} ${opt.potential_savings}`}
                      </span>
                      <span className="block text-[10.5px] text-subtle">per month</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[12px] text-muted">
              No optimization opportunities found in the current inventory.
            </p>
          )}
        </CloudSection>
      )}

      {/* ── Budgets ────────────────────────────────────────────────────── */}
      {tab === 'budgets' && (
        <CloudSection
          title="Budgets"
          description="Each budget is evaluated in its own currency against stored billing facts"
        >
          <BudgetPanel budgets={budgets.data} canManage />
        </CloudSection>
      )}

      {/* ── Reports (reuses the existing panel) ────────────────────────── */}
      {tab === 'reports' && (
        <CostReportPanel accountId={accountView} open onOpenChange={() => {}} />
      )}

      {/* ── Diagnostics ────────────────────────────────────────────────── */}
      {tab === 'diagnostics' && (
        <div className="space-y-4">
          <CloudSection
            title="Data freshness"
            description="Each dataset refreshes on its own schedule — these are not synchronized"
          >
            <FreshnessPanel quality={quality_} />
          </CloudSection>

          <CloudSection
            title="Provider capabilities"
            description="What each billing integration can and cannot answer"
          >
            <CapabilityMatrix capabilities={capabilities.data} />
          </CloudSection>

          <CloudSection
            title="Stored history"
            description="What the analytics on this page are computed from"
          >
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {[
                ['Days covered', coverage.data?.days_covered ?? 0],
                ['Billing facts', (coverage.data?.records ?? 0).toLocaleString()],
                ['Provisional', (coverage.data?.provisional_records ?? 0).toLocaleString()],
                ['Currencies', (coverage.data?.currencies || []).join(', ') || '—'],
              ].map(([label, value]) => (
                <div key={label} className="rounded-control border border-border bg-sunken p-3">
                  <p className="text-[10.5px] font-bold uppercase tracking-wider text-muted">
                    {label}
                  </p>
                  <p className="mt-1 text-[16px] font-bold tabular-nums text-fg">{value}</p>
                </div>
              ))}
            </div>

            {coverage.data?.supports && (
              <div className="mt-4">
                <PanelHeading
                  title="What this history supports"
                  description="An analysis is withheld rather than computed from too few days"
                />
                <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                  {Object.entries(coverage.data.supports).map(([key, ready]) => (
                    <li key={key} className="flex items-center gap-2 text-[12px]">
                      <Badge tone={ready ? 'success' : 'neutral'} size="xs">
                        {ready ? 'Ready' : 'Needs more history'}
                      </Badge>
                      <span className="text-muted">{key.replace(/_/g, ' ')}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {accountView !== 'ALL' && (
              <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-border pt-3">
                <Button
                  variant="secondary"
                  onClick={() => startBackfill.mutate(90)}
                  disabled={backfill.data?.job?.status === 'RUNNING'}
                >
                  {backfill.data?.job?.status === 'RUNNING'
                    ? `Backfilling… ${backfill.data.job.progress_percent}%`
                    : 'Backfill 90 days'}
                </Button>
                {backfill.data?.job && (
                  <span className="text-[11.5px] text-muted">
                    Last run: {backfill.data.job.status} ·{' '}
                    {backfill.data.job.records_written.toLocaleString()} written,{' '}
                    {backfill.data.job.records_updated.toLocaleString()} corrected
                    {backfill.data.job.windows_failed > 0
                      && ` · ${backfill.data.job.windows_failed} window(s) failed`}
                  </span>
                )}
              </div>
            )}
          </CloudSection>
        </div>
      )}

      {showDiagnostics && (
        <DiagnosticModal
          title="Cost diagnostics"
          items={diagnosticItems}
          onClose={() => setShowDiagnostics(false)}
        />
      )}
      {activeOpt && (
        <RecommendationDetailModal opt={activeOpt} onClose={() => setActiveOpt(null)} />
      )}
    </>
  );
}
