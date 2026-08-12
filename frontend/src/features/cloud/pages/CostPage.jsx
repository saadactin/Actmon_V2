import { Fragment, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCostAnalytics } from '../hooks/useCost';
import { useCloudScope } from '../hooks/useCloudScope';
import { CloudProviderSelector } from '../components/CloudProviderSelector';
import { RecommendationDetailModal } from '../components/RecommendationDetailModal';
import { CostFilterTree, EMPTY_TREE_SELECTION, matchesTreeSelection } from '../components/CostFilterTree';
import { CostReportPanel } from '../components/CostReportPanel';
import { DiagnosticModal } from '../components/DiagnosticModal';
import {
  DollarSign, TrendingUp, Sparkles, AlertTriangle, ShieldCheck, ChevronRight, ChevronDown,
  Loader2, Info, PowerOff, Filter, Download, HelpCircle,
} from 'lucide-react';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';

export const CostPage = () => {
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
  // Drill-down tree filter for the Stopped Instances table below
  const [treeSelection, setTreeSelection] = useState(EMPTY_TREE_SELECTION);
  const [expandedStoppedRow, setExpandedStoppedRow] = useState(null);
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
    return (
      <div className="p-6">
        <div className="flex flex-col items-center justify-center py-24 gap-3">
          <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
          <span className="text-sm text-gray-500">Analyzing cost trends and optimization savings...</span>
        </div>
      </div>
    );
  }

  const getSeverityStyle = (sev) => {
    switch (sev.toUpperCase()) {
      case 'CRITICAL':
      case 'HIGH':
        return { accent: 'border-l-red-500', pill: 'bg-red-50 text-red-700 border-red-200' };
      case 'MEDIUM':
        return { accent: 'border-l-amber-500', pill: 'bg-amber-50 text-amber-700 border-amber-200' };
      case 'LOW':
      default:
        return { accent: 'border-l-blue-500', pill: 'bg-blue-50 text-blue-700 border-blue-200' };
    }
  };

  const trends = analytics?.trends || [];
  const optimizations = analytics?.optimizations || [];
  const stoppedInstances = analytics?.stopped_instances || [];
  const filteredStopped = stoppedInstances.filter((i) => matchesTreeSelection(i, treeSelection));
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
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-blue-50 text-blue-600">
              <DollarSign size={20} />
            </div>
            Cost Analytics & Optimization
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Visualize spending trends, sprawl projections, and automated cost-saving recommendations
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {/* Standardized account picker */}
          {accounts && accounts.length > 0 && (
            <CloudProviderSelector
              accounts={accounts}
              mode="multi"
              selected={currentAccountView}
              onSelect={(id) => setCurrentAccountView(id || 'ALL')}
            />
          )}
          {/* Opens the detailed, all-3-provider cost report below */}
          <button
            onClick={() => setReportOpen((o) => !o)}
            className="flex items-center gap-2 px-4 py-2 rounded-xl border text-sm font-semibold transition-colors bg-blue-600 text-white border-blue-600 hover:bg-blue-700"
          >
            <Download size={16} /> Download Report
          </button>
        </div>
      </div>

      {isError || !analytics ? (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
          <div className="flex flex-col items-center justify-center text-center py-12">
            <AlertTriangle size={40} className="text-red-500 mb-4" />
            <h3 className="text-base font-semibold text-gray-900 mb-1">Analytics Unavailable</h3>
            <p className="text-sm text-gray-500">
              Unable to analyze cloud billing. Please make sure resources have been discovered first.
            </p>
          </div>
        </div>
      ) : (
        <>
          {/* Spend Summary Stat Cards */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">

            {/* Projected Spend */}
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
              <div className="flex items-center gap-3.5">
                <div className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0 bg-blue-50 text-blue-600">
                  <DollarSign size={20} />
                </div>
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">
                    {isBilled ? 'Billed Spend (Last 30 Days)' : 'Monthly Spend'}
                  </p>
                  <p
                    className="text-2xl font-bold text-gray-900 mt-0.5 truncate"
                    title={analytics.total_monthly_cost != null ? `${currencySymbol}${analytics.total_monthly_cost.toFixed(2)}` : undefined}
                  >
                    {analytics.total_monthly_cost == null
                      ? 'NA'
                      : `${currencySymbol}${analytics.total_monthly_cost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                  </p>
                  {analytics.total_monthly_cost != null && !currencyCode && (
                    <p className="text-[11px] text-gray-400 mt-0.5">currency: NA</p>
                  )}
                  <p className="text-[11px] text-gray-400 mt-0.5 flex items-center gap-1.5 flex-wrap">
                    {isBilled
                      ? 'Actual spend from the cloud billing API'
                      : 'No billing data is available for this account'}
                    {!isBilled && (
                      <button
                        onClick={() => setShowCostDiagnostic(true)}
                        className="inline-flex items-center gap-1 text-blue-600 hover:text-blue-700 font-semibold"
                      >
                        <HelpCircle size={11} /> Why?
                      </button>
                    )}
                  </p>
                </div>
              </div>
            </div>

            {/* Savings Potentials */}
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
              <div className="flex items-center gap-3.5">
                <div className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0 bg-green-50 text-green-600">
                  <Sparkles size={20} />
                </div>
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">Potential Savings</p>
                  <p className="text-2xl font-bold text-green-600 mt-0.5 truncate" title={analytics.potential_savings != null ? `${currencySymbol}${analytics.potential_savings.toFixed(2)}` : undefined}>
                    {analytics.potential_savings == null
                      ? 'NA'
                      : `${currencySymbol}${analytics.potential_savings.toFixed(2)}`}
                  </p>
                </div>
              </div>
            </div>

            {/* Optimized Spend */}
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
              <div className="flex items-center gap-3.5">
                <div className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0 bg-purple-50 text-purple-600">
                  <TrendingUp size={20} />
                </div>
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">Optimized Net Spend</p>
                  <p
                    className="text-2xl font-bold text-purple-600 mt-0.5 truncate"
                    title={analytics.net_projected_cost != null ? `${currencySymbol}${analytics.net_projected_cost.toFixed(2)}` : undefined}
                  >
                    {analytics.net_projected_cost == null
                      ? 'NA'
                      : `${currencySymbol}${analytics.net_projected_cost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                  </p>
                </div>
              </div>
            </div>

          </div>

          {/* Billed Spend Trend */}
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
            <h3 className="text-sm font-bold text-gray-700 uppercase tracking-wider flex items-center gap-2 mb-4">
              <TrendingUp size={16} className="text-blue-600" />
              Monthly Spend Trend (Last 30 Days)
              {trendCurrencyCode && (
                <span className="text-[11px] font-semibold text-gray-400 normal-case tracking-normal">({trendCurrencyCode})</span>
              )}
            </h3>
            <div className="h-[230px]">
              {trends.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center gap-2 text-center border border-dashed border-gray-200 rounded-lg bg-gray-50/50">
                  <Info size={22} className="text-gray-300" />
                  <p className="text-sm text-gray-500">No billing trend data available</p>
                  <button
                    onClick={() => setShowCostDiagnostic(true)}
                    className="inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 font-semibold"
                  >
                    <HelpCircle size={12} /> Why is this unavailable?
                  </button>
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={trends} margin={{ top: 5, right: 5, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="colorCost" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#2563eb" stopOpacity={0.2} />
                        <stop offset="95%" stopColor="#2563eb" stopOpacity={0.01} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />
                    <XAxis dataKey="date" tick={{ fill: '#6b7280', fontSize: 12 }} axisLine={{ stroke: '#e5e7eb' }} tickLine={false} />
                    <YAxis
                      tick={{ fill: '#6b7280', fontSize: 12 }}
                      axisLine={{ stroke: '#e5e7eb' }}
                      tickLine={false}
                      width={64}
                      tickFormatter={(v) => `${trendCurrencySymbol}${formatCompactAxisNumber(Number(v))}`}
                    />
                    <Tooltip
                      contentStyle={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 12 }}
                      formatter={(value) => [
                        `${trendCurrencySymbol}${Number(value).toFixed(2)}`,
                        'Daily Billed Spend',
                      ]}
                    />
                    <Area type="monotone" dataKey="cost" name="Daily Billed Spend" stroke="#2563eb" strokeWidth={2} fillOpacity={1} fill="url(#colorCost)" />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          {/* Stopped Instances — Last 30 Days Billing */}
          <div>
            <h3 className="text-sm font-bold text-gray-700 uppercase tracking-wider flex items-center gap-2 mb-4">
              <PowerOff size={16} className="text-red-500" />
              Stopped Instances — Last 30 Days Billing
              <span className="text-[11px] font-semibold text-gray-400 normal-case tracking-normal">
                ({stoppedInstances.length} stopped)
              </span>
            </h3>

            {stoppedInstances.length === 0 ? (
              <div className="bg-white rounded-xl border border-gray-200 shadow-sm flex flex-col items-center justify-center text-center py-12 px-5">
                <ShieldCheck size={40} className="text-green-500 mb-3" />
                <h4 className="text-base font-semibold text-gray-900 mb-1">No Stopped Instances</h4>
                <p className="text-sm text-gray-500 max-w-md">
                  Every discovered compute instance in this view is currently running.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-[220px_1fr] gap-4">
                {/* Drill-down tree filter */}
                <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-3">
                  <div className="flex items-center gap-1.5 text-[11px] font-bold text-gray-500 uppercase tracking-wider mb-2 px-1">
                    <Filter size={12} /> Drill Down
                  </div>
                  <CostFilterTree items={stoppedInstances} selection={treeSelection} onChange={setTreeSelection} />
                </div>

                {/* Results table */}
                <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full border-collapse">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">Instance</th>
                          <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">Account</th>
                          <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">Region</th>
                          <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">Status</th>
                          <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">Own Cost</th>
                          <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">Attached Storage</th>
                          <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">Total / mo</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {filteredStopped.length === 0 ? (
                          <tr>
                            <td colSpan={7} className="px-4 py-12 text-center text-sm text-gray-500">
                              No stopped instances match this filter.
                            </td>
                          </tr>
                        ) : (
                          filteredStopped.map((inst) => {
                            const isExpanded = expandedStoppedRow === inst.resource_id;
                            const sym = symbolFor(inst.currency);
                            const hasStorage = (inst.attached_storage || []).length > 0;
                            return (
                              <Fragment key={inst.resource_id}>
                                <tr
                                  onClick={() => navigate(`/cloud/resources/${inst.resource_id}`)}
                                  className="cursor-pointer hover:bg-gray-50 transition-colors"
                                >
                                  <td className="px-4 py-3 text-sm whitespace-nowrap">
                                    <div className="flex items-center gap-2">
                                      <span className="font-semibold text-gray-900">{inst.resource_name}</span>
                                      <span className="text-[10px] text-gray-400 font-mono">{inst.resource_type}</span>
                                    </div>
                                  </td>
                                  <td className="px-4 py-3 text-sm text-gray-600 whitespace-nowrap">{inst.account_name || '—'}</td>
                                  <td className="px-4 py-3 text-sm text-gray-600 whitespace-nowrap">{inst.region || '—'}</td>
                                  <td className="px-4 py-3 text-sm whitespace-nowrap">
                                    <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-semibold border bg-red-50 text-red-700 border-red-200">
                                      <PowerOff size={10} /> {inst.status || 'STOPPED'}
                                    </span>
                                  </td>
                                  <td className="px-4 py-3 text-sm text-right whitespace-nowrap text-gray-700">
                                    {inst.own_cost_monthly == null ? 'NA' : `${sym}${inst.own_cost_monthly.toFixed(2)}`}
                                  </td>
                                  <td className="px-4 py-3 text-sm text-right whitespace-nowrap">
                                    {hasStorage ? (
                                      <button
                                        onClick={(e) => { e.stopPropagation(); setExpandedStoppedRow(isExpanded ? null : inst.resource_id); }}
                                        className="inline-flex items-center gap-1 text-blue-600 hover:text-blue-700 font-semibold"
                                      >
                                        {inst.attached_storage_cost_monthly == null ? 'NA' : `${sym}${inst.attached_storage_cost_monthly.toFixed(2)}`}
                                        {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                                      </button>
                                    ) : (
                                      <span className="text-gray-400">None</span>
                                    )}
                                  </td>
                                  <td className="px-4 py-3 text-sm text-right whitespace-nowrap font-bold text-gray-900">
                                    {inst.total_cost_monthly == null ? 'NA' : `${sym}${inst.total_cost_monthly.toFixed(2)}`}
                                  </td>
                                </tr>
                                {isExpanded && hasStorage && (
                                  <tr className="bg-gray-50/60">
                                    <td colSpan={7} className="px-4 py-2.5">
                                      <div className="pl-6 space-y-1">
                                        {inst.attached_storage.map((sr, idx) => (
                                          <div key={idx} className="flex items-center justify-between px-2.5 py-1.5 bg-white border border-gray-200 rounded-md text-xs">
                                            <span className="text-gray-600 font-mono">{sr.resource_name} <span className="text-gray-400">({sr.resource_type})</span></span>
                                            <span className="text-gray-700 font-semibold">
                                              {sr.monthly_cost == null ? 'NA' : `${sym}${sr.monthly_cost.toFixed(2)}/mo`}
                                            </span>
                                          </div>
                                        ))}
                                      </div>
                                    </td>
                                  </tr>
                                )}
                              </Fragment>
                            );
                          })
                        )}
                      </tbody>
                    </table>
                  </div>
                  <div className="flex items-center justify-between px-4 py-2.5 border-t border-gray-100 bg-gray-50">
                    <span className="text-xs text-gray-500">
                      Showing <strong className="font-semibold text-gray-700">{filteredStopped.length}</strong> of{' '}
                      <strong className="font-semibold text-gray-700">{stoppedInstances.length}</strong> stopped instances
                    </span>
                    {treeSelection.provider && (
                      <button
                        onClick={() => setTreeSelection(EMPTY_TREE_SELECTION)}
                        className="text-xs font-semibold text-blue-600 hover:text-blue-700"
                      >
                        Clear drill-down
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Cost Optimization Recommendations */}
          <div>
            <h3 className="text-sm font-bold text-gray-700 uppercase tracking-wider flex items-center gap-2 mb-4">
              <Sparkles size={16} className="text-amber-500" />
              Actionable Cost Optimization Recommendations
            </h3>

            <div className="flex flex-col gap-3.5">
              {optimizations.length === 0 ? (
                <div className="bg-white rounded-xl border border-gray-200 shadow-sm flex flex-col items-center justify-center text-center py-12 px-5">
                  <ShieldCheck size={40} className="text-green-500 mb-3" />
                  <h4 className="text-base font-semibold text-gray-900 mb-1">No Recommendations Found</h4>
                  <p className="text-sm text-gray-500 max-w-md">
                    We checked the discovered resources in this view for common waste patterns
                    — stopped compute &amp; databases, idle clusters, load balancers and gateways
                    with no backends, legacy instance types, and missing storage policies —
                    and found none.
                  </p>
                  <p className="text-xs text-gray-400 mt-2 max-w-md">
                    This is a configuration-based check, not a guarantee of full optimization:
                    usage-based rightsizing and rupee savings estimates are not yet wired up.
                  </p>
                </div>
              ) : (
                optimizations.map((opt) => {
                  const style = getSeverityStyle(opt.severity);
                  return (
                    <div
                      key={opt.id}
                      onClick={() => setActiveOpt(opt)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => { if (e.key === 'Enter') setActiveOpt(opt); }}
                      className={`bg-white rounded-xl border border-gray-200 shadow-sm border-l-4 ${style.accent} p-5 cursor-pointer transition-shadow hover:shadow-md hover:border-gray-300`}
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0">
                          {/* Title & tags */}
                          <div className="flex items-center gap-2.5 flex-wrap">
                            <h4 className="text-[15px] font-semibold text-gray-900">{opt.rule}</h4>
                            <span className={`rounded-full text-[11px] font-bold uppercase tracking-wide px-2.5 py-0.5 border ${style.pill}`}>
                              {opt.severity} Severity
                            </span>
                            <span className="text-[11px] text-green-600 font-bold">
                              Savings: {opt.potential_savings == null
                                ? 'NA'
                                : `${symbolFor(opt.savings_currency)}${opt.potential_savings.toFixed(2)}/mo`}
                            </span>
                            <span className="text-[11px] text-blue-600 font-semibold inline-flex items-center gap-1 ml-auto">
                              <Info size={12} /> Click for detailed steps &amp; savings
                            </span>
                          </div>

                          {/* Description */}
                          <p className="text-sm text-gray-600 leading-relaxed mt-2 mb-3">
                            {opt.description}
                          </p>

                          {/* Remediation */}
                          <div className="bg-blue-50/60 border border-blue-100 rounded-lg p-3">
                            <div className="text-[11px] font-bold text-blue-700 uppercase tracking-wider mb-1">
                              Actionable Steps
                            </div>
                            <p className="text-xs text-gray-700">
                              {opt.recommendation}
                            </p>
                          </div>

                          {/* Sub-Resources Breakdown */}
                          {opt.sub_resources && opt.sub_resources.length > 0 && (
                            <div className="mt-3 bg-gray-50 border border-gray-200 rounded-lg p-3">
                              <div className="text-[11px] font-bold text-gray-500 uppercase tracking-wider mb-2">
                                Resource Cost Breakdown
                              </div>
                              <div className="space-y-1">
                                {opt.sub_resources.map((sr, idx) => (
                                  <div key={idx} className="flex items-center justify-between px-2 py-1.5 bg-white border border-gray-100 rounded-md">
                                    <span className="text-xs text-gray-500 font-mono">{sr.name}</span>
                                    <span className="text-xs text-green-600 font-semibold">
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
                          <span className="block text-[11px] font-semibold text-gray-500 uppercase tracking-wider">Target Resource</span>
                          <button
                            onClick={(e) => { e.stopPropagation(); navigate(`/cloud/resources/${opt.resource_id}`); }}
                            className="inline-flex items-center gap-1 pt-1 text-sm font-semibold text-blue-600 hover:text-blue-700 cursor-pointer"
                          >
                            {opt.affected_resource}
                            <ChevronRight size={14} />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

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
        </>
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
    </div>
  );
};
