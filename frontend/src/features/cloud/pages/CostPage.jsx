import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCostAnalytics } from '../hooks/useCost';
import { useCloudScope } from '../hooks/useCloudScope';
import { RecommendationDetailModal } from '../components/RecommendationDetailModal';
import { CostExplorerPanel } from '../components/CostExplorerPanel';
import { CostReportPanel } from '../components/CostReportPanel';
import { DiagnosticModal } from '../components/DiagnosticModal';
import CloudPageHeader from '../components/CloudPageHeader';
import CloudToolbar from '../components/CloudToolbar';
import CloudSection from '../components/CloudSection';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import { PageLoading } from '@/components/ui/Loading';
import {
  DollarSign, TrendingUp, Sparkles, AlertTriangle, ShieldCheck, ChevronRight,
  Info, HelpCircle, Layers,
} from 'lucide-react';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';

export const CostPage = ({ embedded = false }) => {
  const navigate = useNavigate();

  // Scope-aware: previously this always queried 'ALL', so picking OCI in the
  // chooser and opening Cost still showed every provider's spend combined.
  const scope = useCloudScope();
  const accounts = scope.scopedAccounts;
  const selectedAccountId = scope.accountId;
  const selectedAccount = scope.account;

  // 'ALL' aggregates — but only ever within the current provider scope. When no
  // provider is scoped it means genuinely all accounts, as before.
  const [accountView, setAccountView] = useState('ALL');
  // Recommendation whose detail popup is open
  const [activeOpt, setActiveOpt] = useState(null);
  // Detailed cross-provider report — opened from the header button, next to
  // the account picker, so it's reachable without scrolling to the bottom.
  const [reportOpen, setReportOpen] = useState(false);
  const reportRef = useRef(null);
  const [showCostDiagnostic, setShowCostDiagnostic] = useState(false);

  useEffect(() => {
    if (reportOpen) reportRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [reportOpen]);

  // Inside a provider scope, 'ALL' must not fan out to other providers, so fall
  // back to the scoped account rather than the backend's cross-account rollup.
  const currentAccountView = accountView === 'ALL'
    ? (scope.isScoped ? (selectedAccountId ?? 'ALL') : 'ALL')
    : accountView;
  const setCurrentAccountView = setAccountView;

  const { data: analytics, isLoading, isError } = useCostAnalytics(currentAccountView);

  if (isLoading) {
    return <PageLoading title="Analyzing cost trends & optimization savings…" />;
  }

  const getSeverityStyle = (sev) => {
    switch (sev.toUpperCase()) {
      case 'CRITICAL':
      case 'HIGH':
        return { accent: 'border-l-danger', tone: 'danger' };
      case 'MEDIUM':
        return { accent: 'border-l-warning', tone: 'warning' };
      case 'LOW':
      default:
        return { accent: 'border-l-info', tone: 'info' };
    }
  };

  const trends = analytics?.trends || [];
  const optimizations = analytics?.optimizations || [];
  const isBilled = analytics?.cost_source === 'billing_api';
  // No currency default: when the API reports no currency, render amounts without a
  // symbol and disclose 'currency: NA' explicitly.
  const symbolFor = (code) => (code
    ? ({ USD: '$', INR: '₹', EUR: '€', GBP: '£' }[code] ?? `${code} `)
    : '');
  // Y-axis tick space is fixed and narrow — a 6-digit INR amount (e.g. 120000)
  // doesn't fit, so it renders clipped down to its last 4 digits ("0000").
  // Abbreviate instead of truncating.
  const formatCompactAxisNumber = (value) => {
    const abs = Math.abs(value);
    if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
    if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
    if (abs >= 1_000) return `${(value / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}K`;
    return `${value}`;
  };
  const currencyCode = analytics?.currency ?? null;
  const currencySymbol = symbolFor(currencyCode);
  const trendCurrencyCode = analytics?.trend_currency ?? currencyCode;
  const trendCurrencySymbol = symbolFor(trendCurrencyCode);

  const costDiagnosticItems = (analytics?.cost_diagnostics || []).map((d) => ({
    scope: d.account_name,
    provider: d.provider,
    category: d.category,
    message: d.message,
  }));

  return (
    <>
      {embedded ? (
        <div className="mb-4 flex justify-end">
          <Button variant="primary" icon="download" onClick={() => setReportOpen((o) => !o)}>
            Download Report
          </Button>
        </div>
      ) : (
        <CloudPageHeader
          backTo="/cloud"
          title="Cost Analytics & Optimization"
          description="Visualize spending trends, sprawl projections, and automated cost-saving recommendations"
          actions={(
            <CloudToolbar
              selectorProps={accounts && accounts.length > 0 ? {
                accounts,
                mode: 'multi',
                selected: currentAccountView,
                onSelect: (id) => setCurrentAccountView(id || 'ALL'),
              } : undefined}
            >
              {/* Opens the detailed, all-3-provider cost report below */}
              <Button variant="primary" icon="download" onClick={() => setReportOpen((o) => !o)}>
                Download Report
              </Button>
            </CloudToolbar>
          )}
        />
      )}

      {isError || !analytics ? (
        <CloudSection bodyClassName="flex flex-col items-center justify-center gap-2 py-12 px-6 text-center">
          <AlertTriangle size={40} className="mb-2 text-danger" />
          <h3 className="text-base font-semibold text-fg">Analytics Unavailable</h3>
          <p className="text-sm text-muted">
            Unable to analyze cloud billing. Please make sure resources have been discovered first.
          </p>
        </CloudSection>
      ) : (
        <div className="space-y-6">
          {/* Spend Summary Stat Cards */}
          <div className="grid grid-cols-1 gap-6 md:grid-cols-3">

            {/* Projected Spend */}
            <CloudSection>
              <div className="flex items-center gap-3.5">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-control bg-accent-soft text-accent-text">
                  <DollarSign size={20} />
                </div>
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                    {isBilled ? 'Billed Spend (Last 30 Days)' : 'Monthly Spend'}
                  </p>
                  <p
                    className="mt-0.5 truncate text-2xl font-bold text-fg"
                    title={analytics.total_monthly_cost != null ? `${currencySymbol}${analytics.total_monthly_cost.toFixed(2)}` : undefined}
                  >
                    {analytics.total_monthly_cost == null
                      ? 'NA'
                      : `${currencySymbol}${analytics.total_monthly_cost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                  </p>
                  {analytics.total_monthly_cost != null && !currencyCode && (
                    <p className="mt-0.5 text-[11px] text-subtle">currency: NA</p>
                  )}
                  <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-subtle">
                    {isBilled
                      ? 'Actual spend from the cloud billing API'
                      : 'No billing data is available for this account'}
                    {!isBilled && (
                      <button
                        onClick={() => setShowCostDiagnostic(true)}
                        className="inline-flex items-center gap-1 font-semibold text-accent-text hover:opacity-80"
                      >
                        <HelpCircle size={11} /> Why?
                      </button>
                    )}
                  </p>
                </div>
              </div>
            </CloudSection>

            {/* Savings Potentials */}
            <CloudSection>
              <div className="flex items-center gap-3.5">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-control bg-success-soft text-success-fg">
                  <Sparkles size={20} />
                </div>
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">Potential Savings</p>
                  <p className="mt-0.5 truncate text-2xl font-bold text-success" title={analytics.potential_savings != null ? `${currencySymbol}${analytics.potential_savings.toFixed(2)}` : undefined}>
                    {analytics.potential_savings == null
                      ? 'NA'
                      : `${currencySymbol}${analytics.potential_savings.toFixed(2)}`}
                  </p>
                </div>
              </div>
            </CloudSection>

            {/* Optimized Spend */}
            <CloudSection>
              <div className="flex items-center gap-3.5">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-control bg-info-soft text-info-fg">
                  <TrendingUp size={20} />
                </div>
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">Optimized Net Spend</p>
                  <p
                    className="mt-0.5 truncate text-2xl font-bold text-info"
                    title={analytics.net_projected_cost != null ? `${currencySymbol}${analytics.net_projected_cost.toFixed(2)}` : undefined}
                  >
                    {analytics.net_projected_cost == null
                      ? 'NA'
                      : `${currencySymbol}${analytics.net_projected_cost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                  </p>
                </div>
              </div>
            </CloudSection>

          </div>

          {/* Billed Spend Trend */}
          <CloudSection
            title={(
              <span className="inline-flex items-center gap-2">
                <TrendingUp size={15} className="text-accent-text" />
                Monthly Spend Trend (Last 30 Days)
              </span>
            )}
            action={trendCurrencyCode && <Badge tone="neutral">{trendCurrencyCode}</Badge>}
          >
            <div className="h-[230px]">
              {trends.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center gap-2 rounded-control border border-dashed border-border bg-sunken text-center">
                  <Info size={22} className="text-subtle" />
                  <p className="text-sm text-muted">No billing trend data available</p>
                  <button
                    onClick={() => setShowCostDiagnostic(true)}
                    className="inline-flex items-center gap-1 text-xs font-semibold text-accent-text hover:opacity-80"
                  >
                    <HelpCircle size={12} /> Why is this unavailable?
                  </button>
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={trends} margin={{ top: 5, right: 5, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="colorCost" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="var(--chart-1)" stopOpacity={0.25} />
                        <stop offset="95%" stopColor="var(--chart-1)" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" vertical={false} />
                    <XAxis dataKey="date" tick={{ fill: 'var(--chart-axis)', fontSize: 12 }} axisLine={{ stroke: 'var(--chart-grid)' }} tickLine={false} />
                    <YAxis
                      tick={{ fill: 'var(--chart-axis)', fontSize: 12 }}
                      axisLine={{ stroke: 'var(--chart-grid)' }}
                      tickLine={false}
                      width={64}
                      tickFormatter={(v) => `${trendCurrencySymbol}${formatCompactAxisNumber(Number(v))}`}
                    />
                    <Tooltip
                      contentStyle={{
                        background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12, color: 'var(--fg)',
                      }}
                      formatter={(value) => [
                        `${trendCurrencySymbol}${Number(value).toFixed(2)}`,
                        'Daily Billed Spend',
                      ]}
                    />
                    <Area type="monotone" dataKey="cost" name="Daily Billed Spend" stroke="var(--chart-1)" strokeWidth={2} fillOpacity={1} fill="url(#colorCost)" />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </div>
          </CloudSection>

          {/* Cost Explorer — generic Provider -> Account -> Region -> Service ->
              Resource Type -> Resource drill-down over real billing data, freely
              groupable (not locked to Compute Instances). Stopped-instance
              billing is now a "Stopped only" quick filter within this view
              rather than a separate table. */}
          <CloudSection
            title={(
              <span className="inline-flex items-center gap-2">
                <Layers size={15} className="text-accent-text" />
                Cost Explorer
              </span>
            )}
          >
            {/* key forces a full remount on account switch — without it, the
                account can change (via the header's account picker, no route
                change) while groupBy/filters/pagination state carries over
                from whatever account was open before, which is wrong for a
                per-account explorer (e.g. an AWS account's forced "no per-
                resource billing" fallback state leaking into the next OCI
                account that DOES have resource-level data). */}
            <CostExplorerPanel
              key={currentAccountView}
              accountId={currentAccountView}
              potentialSavings={analytics.potential_savings}
              savingsCurrency={currencyCode}
            />
          </CloudSection>

          {/* Cost Optimization Recommendations */}
          <CloudSection
            title={(
              <span className="inline-flex items-center gap-2">
                <Sparkles size={15} className="text-warning" />
                Actionable Cost Optimization Recommendations
              </span>
            )}
          >
            {optimizations.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <ShieldCheck size={40} className="mb-3 text-success" />
                <h4 className="mb-1 text-base font-semibold text-fg">No Recommendations Found</h4>
                <p className="max-w-md text-sm text-muted">
                  We checked the discovered resources in this view for common waste patterns
                  — stopped compute &amp; databases, idle clusters, load balancers and gateways
                  with no backends, legacy instance types, and missing storage policies —
                  and found none.
                </p>
                <p className="mt-2 max-w-md text-xs text-subtle">
                  This is a configuration-based check, not a guarantee of full optimization:
                  usage-based rightsizing and rupee savings estimates are not yet wired up.
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-3.5">
                {optimizations.map((opt) => {
                  const style = getSeverityStyle(opt.severity);
                  return (
                    <div
                      key={opt.id}
                      onClick={() => setActiveOpt(opt)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => { if (e.key === 'Enter') setActiveOpt(opt); }}
                      className={`card border-l-4 ${style.accent} cursor-pointer p-5 transition-shadow hover:border-strong hover:shadow-md`}
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0">
                          {/* Title & tags */}
                          <div className="flex flex-wrap items-center gap-2.5">
                            <h4 className="text-[15px] font-semibold text-fg">{opt.rule}</h4>
                            <Badge tone={style.tone} className="uppercase tracking-wide">
                              {opt.severity} Severity
                            </Badge>
                            <span className="text-[11px] font-bold text-success">
                              Savings: {opt.potential_savings == null
                                ? 'NA'
                                : `${symbolFor(opt.savings_currency)}${opt.potential_savings.toFixed(2)}/mo`}
                            </span>
                            <span className="ml-auto inline-flex items-center gap-1 text-[11px] font-semibold text-accent-text">
                              <Info size={12} /> Click for detailed steps &amp; savings
                            </span>
                          </div>

                          {/* Description */}
                          <p className="mt-2 mb-3 text-sm leading-relaxed text-muted">
                            {opt.description}
                          </p>

                          {/* Remediation */}
                          <div className="rounded-control border border-accent-border bg-accent-soft/60 p-3">
                            <div className="mb-1 text-[11px] font-bold uppercase tracking-wider text-accent-text">
                              Actionable Steps
                            </div>
                            <p className="text-xs text-fg">
                              {opt.recommendation}
                            </p>
                          </div>

                          {/* Sub-Resources Breakdown */}
                          {opt.sub_resources && opt.sub_resources.length > 0 && (
                            <div className="mt-3 rounded-control border border-border bg-sunken p-3">
                              <div className="mb-2 text-[11px] font-bold uppercase tracking-wider text-muted">
                                Resource Cost Breakdown
                              </div>
                              <div className="space-y-1">
                                {opt.sub_resources.map((sr, idx) => (
                                  <div key={idx} className="flex items-center justify-between rounded-control border border-border bg-surface px-2 py-1.5">
                                    <span className="font-mono text-xs text-muted">{sr.name}</span>
                                    <span className="text-xs font-semibold text-success">
                                      {sr.cost == null ? 'NA' : `${currencySymbol}${sr.cost.toFixed(2)}/mo`}
                                    </span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>

                        {/* Affected Resource Link */}
                        <div className="shrink-0 text-right">
                          <span className="block text-[11px] font-semibold uppercase tracking-wider text-muted">Target Resource</span>
                          <button
                            onClick={(e) => { e.stopPropagation(); navigate(`/cloud/resources/${opt.resource_id}`); }}
                            className="inline-flex cursor-pointer items-center gap-1 pt-1 text-sm font-semibold text-accent-text hover:opacity-80"
                          >
                            {opt.affected_resource}
                            <ChevronRight size={14} />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CloudSection>

          {/* Detailed cross-provider cost report (365-day, per-service, downloadable) —
              opened via the "Download Report" button in the header. */}
          <div ref={reportRef}>
            {/* Follows the page's account/provider scope — viewing OCI should not
                fan out to every provider's billing API just to build a report. */}
            <CostReportPanel
              accountId={currentAccountView}
              open={reportOpen}
              onOpenChange={setReportOpen}
            />
          </div>
        </div>
      )}

      {activeOpt && (
        <RecommendationDetailModal opt={activeOpt} onClose={() => setActiveOpt(null)} />
      )}

      {showCostDiagnostic && (
        <DiagnosticModal
          title="Why is cost data unavailable?"
          items={
            costDiagnosticItems.length > 0
              ? costDiagnosticItems
              : [{
                scope: selectedAccount?.account_name || 'This account',
                category: 'no_data',
                message:
                    "No specific error was recorded for this account's last billing query — it likely means the "
                    + 'provider genuinely reported zero cost records (common for sponsored/credit subscriptions, '
                    + "or a brand-new account with no usage yet), or the query hasn't run yet. Click Refresh to try again.",
              }]
          }
          onClose={() => setShowCostDiagnostic(false)}
        />
      )}
    </>
  );
};
