import React, { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useCloudAccounts } from '../hooks/useCloudAccounts';
import { useAllResources } from '../hooks/useResources';
import { useQueries } from '@tanstack/react-query';
import { getSecurityPosture } from '../api/security.api';
import { getCostEstimate } from '../api/cost.api';
import { useCloudStore } from '../state/cloudStore';
import { Cloud, Server, DollarSign, Activity, Shield, ShieldAlert, ShieldCheck, ArrowRight, ArrowLeft, Clock, Loader2, Layers, Globe, Sparkles, Plus } from 'lucide-react';
import { ResponsiveContainer, PieChart, Pie, Cell, Tooltip, BarChart, Bar, XAxis, YAxis, CartesianGrid } from 'recharts';
import { PROVIDER_META } from '../components/CloudProviderSelector';
import { formatCurrency } from '../utils/formatters';

const PROVIDER_BADGE_CLASSES: Record<string, string> = {
  AWS: 'bg-orange-50 text-orange-700 border-orange-200',
  Azure: 'bg-sky-50 text-sky-700 border-sky-200',
  OCI: 'bg-red-50 text-red-700 border-red-200',
};

const PROVIDER_ICON_CHIP_CLASSES: Record<string, string> = {
  AWS: 'bg-orange-50 text-orange-600',
  Azure: 'bg-sky-50 text-sky-600',
  OCI: 'bg-red-50 text-red-600',
};

const CHART_TOOLTIP_STYLE: React.CSSProperties = {
  background: '#ffffff',
  border: '1px solid #e5e7eb',
  borderRadius: 8,
};

export const CloudDashboard = () => {
  const navigate = useNavigate();
  // Reached either as the aggregate dashboard (/cloud, legacy) or, via the new
  // provider → accounts drill-down, scoped to one account (/cloud/:provider/:accountId).
  // When accountId is present we lock the view to that single account and hide the
  // provider-picker chrome — selection already happened on the pages before this one.
  const { provider: routeProviderSlug, accountId: routeAccountId } = useParams();
  const { data: accounts, isLoading: accountsLoading } = useCloudAccounts();
  const { data: allResources, isLoading: resourcesLoading } = useAllResources();
  const activeJobs = useCloudStore(state => state.activeDiscoveryJobs);
  const activeJobsCount = Object.keys(activeJobs).length;
  const setDrawerOpen = useCloudStore(state => state.setAddAccountDrawerOpen);

  const isAccountScoped = !!routeAccountId;
  const scopedAccount = isAccountScoped ? (accounts || []).find(a => a.id === routeAccountId) : null;

  // Selected view: null = ALL, string = accountId
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [selectedViewState, setSelectedView] = useState<string>('ALL');
  const selectedView = isAccountScoped ? routeAccountId : selectedViewState;

  // Fetch security posture for all accounts
  const postureQueries = useQueries({
    queries: (accounts || []).map(acc => ({
      queryKey: ['securityPosture', acc.id],
      queryFn: () => getSecurityPosture(acc.id),
      enabled: !!accounts && accounts.length > 0,
      staleTime: 30_000,
    }))
  });

  // Fetch cost estimates for all accounts
  const costQueries = useQueries({
    queries: (accounts || []).map(acc => ({
      queryKey: ['costEstimate', acc.id],
      queryFn: () => getCostEstimate(acc.id),
      enabled: !!accounts && accounts.length > 0,
      staleTime: 30_000,
    }))
  });

  const isLoading = accountsLoading || resourcesLoading;

  if (isLoading) {
    return (
      <div className="p-6 space-y-6">
        <div className="flex flex-col items-center justify-center gap-3 py-24">
          <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
          <span className="text-sm text-gray-500">Aggregating cloud resources...</span>
        </div>
      </div>
    );
  }

  // Accounts filtered by selected provider
  const visibleAccounts = selectedProvider
    ? (accounts || []).filter(a => a.provider === selectedProvider)
    : (accounts || []);

  const visibleAccountIds = new Set(visibleAccounts.map(a => a.id));

  // Filter resources based on selected provider → account
  const filteredResources = allResources
    ? (selectedView === 'ALL'
      ? allResources.filter(r => visibleAccountIds.has(r.account_id))
      : allResources.filter(r => r.account_id === selectedView))
    : [];

  // Zip per-account queries with their account by index (responses may not echo account_id)
  const isAccountSelected = (accId: string) =>
    selectedView === 'ALL' ? visibleAccountIds.has(accId) : accId === selectedView;

  const relevantPostureQueries = (accounts || [])
    .map((acc, idx) => ({ acc, query: postureQueries[idx] }))
    .filter(({ acc }) => isAccountSelected(acc.id));

  const relevantCostQueries = (accounts || [])
    .map((acc, idx) => ({ acc, query: costQueries[idx] }))
    .filter(({ acc }) => isAccountSelected(acc.id));

  const posturesLoading = relevantPostureQueries.some(({ query }) => query?.isLoading);
  const costsLoading = relevantCostQueries.some(({ query }) => query?.isLoading);

  const activePostures = relevantPostureQueries
    .map(({ query }) => query?.data)
    .filter((p): p is NonNullable<typeof p> => !!p);

  // Compute stats
  const totalResources = filteredResources.length;

  // Only accounts with real billing data (non-null total_monthly_cost) contribute to the sum
  const billedCosts = relevantCostQueries
    .map(({ query }) => query?.data)
    .filter((c): c is { total_monthly_cost: number; currency: string | null } =>
      !!c && typeof c.total_monthly_cost === 'number');
  const totalCost = billedCosts.reduce((sum, c) => sum + c.total_monthly_cost, 0);
  const hasCostData = billedCosts.length > 0;
  const costCurrencySet = new Set(billedCosts.map(c => c.currency ?? null));
  const singleCurrency = costCurrencySet.size === 1 ? [...costCurrencySet][0] : null;
  const hasMixedCurrencies = costCurrencySet.size > 1;

  // Security score (average of selected); null when no posture data — never fabricate 100
  const avgSecurityScore = activePostures.length > 0
    ? Math.round(activePostures.reduce((sum, p) => sum + p.score, 0) / activePostures.length)
    : null;

  const getSecurityGrade = (score: number) => {
    if (score >= 90) return 'A';
    if (score >= 75) return 'B';
    if (score >= 60) return 'C';
    if (score >= 40) return 'D';
    return 'F';
  };

  const securityGrade = avgSecurityScore != null ? getSecurityGrade(avgSecurityScore) : null;

  const getGradeColor = (grade: string) => {
    switch (grade) {
      case 'A': return '#16a34a';
      case 'B': return '#059669';
      case 'C': return '#ca8a04';
      case 'D': return '#ea580c';
      case 'F': return '#dc2626';
      default: return '#6b7280';
    }
  };

  // 1. Donut chart data: resources by type
  const typeCounts = filteredResources.reduce((acc, r) => {
    acc[r.resource_type] = (acc[r.resource_type] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const COLORS = ['#2563eb', '#0d9488', '#7c3aed', '#f59e0b', '#db2777', '#0891b2', '#dc2626', '#65a30d', '#6b7280'];
  // Cap the donut at the top 8 types; everything else rolls into "Other"
  // (some accounts have 50+ types — a full legend overflows the card).
  const allTypes = Object.entries(typeCounts).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  const otherCount = allTypes.slice(8).reduce((sum, t) => sum + t.value, 0);
  const otherTypes = allTypes.length - 8;
  const pieData = otherCount > 0
    ? [...allTypes.slice(0, 8), { name: `Other (${otherTypes} types)`, value: otherCount }]
    : allTypes;

  // 2. Bar chart data: region breakdown
  const regionCounts = filteredResources.reduce((acc, r) => {
    const region = r.region_or_zone || 'unknown';
    acc[region] = (acc[region] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const barData = Object.entries(regionCounts).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value).slice(0, 8);

  // Recently Discovered — respects the current scope (one account, one provider, or all)
  const recentlyDiscovered = [...filteredResources]
    .sort((a, b) => new Date(b.discovered_at).getTime() - new Date(a.discovered_at).getTime())
    .slice(0, 5);

  const handleAddAccount = () => {
    navigate('/cloud/accounts');
    setTimeout(() => setDrawerOpen(true), 100);
  };

  // Accounts to display in this-scope-only sections (stat card, scan history) —
  // just the one account when reached via Cloud → Provider → Account.
  const scopedAccountsList = isAccountScoped
    ? (scopedAccount ? [scopedAccount] : [])
    : (accounts || []);
  const postureByAccountId = new Map((accounts || []).map((acc, idx) => [acc.id, postureQueries[idx]?.data]));

  // Per-provider rollups for the three provider cards ("Oracle" counts as OCI)
  const providerKeyOf = (p: string) => (p === 'Oracle' ? 'OCI' : p);
  const providerStats = ['AWS', 'Azure', 'OCI'].map(key => {
    const provAccounts = (accounts || []).filter(a => providerKeyOf(a.provider) === key);
    const provAccountIds = new Set(provAccounts.map(a => a.id));
    const provResources = (allResources || []).filter(r => provAccountIds.has(r.account_id));
    return { key, accounts: provAccounts, resourceCount: provResources.length };
  });

  return (
    <div className="p-6 space-y-6">
      {/* ── Scoped-account breadcrumb (only when reached via Cloud → Provider → Account) ── */}
      {isAccountScoped && (
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => navigate('/cloud')}
            className="inline-flex items-center gap-1.5 rounded-full border border-gray-300 bg-white px-3.5 py-1.5 text-xs font-semibold text-gray-600 hover:bg-gray-50 transition-colors"
          >
            <ArrowLeft size={13} /> All clouds
          </button>
          <span className="h-4 w-px bg-gray-200" />
          <button
            onClick={() => navigate(`/cloud/${routeProviderSlug}`)}
            className="inline-flex items-center gap-1.5 rounded-full border border-gray-300 bg-white px-3.5 py-1.5 text-xs font-semibold text-gray-600 hover:bg-gray-50 transition-colors"
          >
            {scopedAccount ? scopedAccount.provider : routeProviderSlug} accounts
          </button>
          <span className="h-4 w-px bg-gray-200" />
          <span className="rounded-full border px-3.5 py-1.5 text-xs font-bold"
            style={{
              borderColor: PROVIDER_META[scopedAccount?.provider || '']?.color,
              background: PROVIDER_META[scopedAccount?.provider || '']?.accent,
              color: PROVIDER_META[scopedAccount?.provider || '']?.color,
            }}>
            {scopedAccount?.account_name || 'Account'}
          </span>
        </div>
      )}

      {/* ── Provider cards: click a cloud to drill into it (hidden once scoped to one account) ── */}
      {!isAccountScoped && (
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {providerStats.map(({ key, accounts: provAccounts, resourceCount }) => {
          const meta = PROVIDER_META[key];
          const isSelected = selectedProvider === key;
          const isEmpty = provAccounts.length === 0;
          return (
            <button
              key={key}
              onClick={() => {
                if (isEmpty) { handleAddAccount(); return; }
                setSelectedProvider(isSelected ? null : key);
                setSelectedView('ALL');
              }}
              className={`text-left w-full rounded-xl p-5 transition-all cursor-pointer ${
                isEmpty
                  ? 'bg-white border-2 border-dashed border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                  : isSelected
                    ? 'bg-white border-2 shadow-md'
                    : 'bg-white border border-gray-200 shadow-sm hover:shadow-md hover:-translate-y-0.5'
              }`}
              style={isSelected ? { borderColor: meta?.color } : undefined}
            >
              <div className="flex items-center gap-4">
                <div
                  className="w-12 h-12 rounded-xl flex items-center justify-center shrink-0"
                  style={{ background: meta?.bg, color: meta?.color }}
                >
                  <Cloud size={24} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-lg font-bold text-gray-900">{key}</span>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold border ${PROVIDER_BADGE_CLASSES[key] || 'bg-gray-50 text-gray-600 border-gray-200'}`}>
                      {meta?.label || key}
                    </span>
                  </div>
                  {isEmpty ? (
                    <div className="flex items-center gap-1.5 text-sm text-gray-400 mt-1">
                      <Plus size={14} /> Not connected — add an account
                    </div>
                  ) : (
                    <div className="flex items-center gap-3 text-sm text-gray-500 mt-1">
                      <span><span className="font-bold text-gray-900">{provAccounts.length}</span> account{provAccounts.length > 1 ? 's' : ''}</span>
                      <span className="text-gray-300">·</span>
                      <span><span className="font-bold text-gray-900">{resourceCount}</span> resources</span>
                    </div>
                  )}
                </div>
                {!isEmpty && (
                  <ArrowRight
                    size={18}
                    className={`shrink-0 transition-transform ${isSelected ? '' : 'text-gray-300'}`}
                    style={isSelected ? { color: meta?.color } : undefined}
                  />
                )}
              </div>
            </button>
          );
        })}
      </div>
      )}

      {/* ── Inside a provider: back link + its account chips (aggregate view only) ── */}
      {!isAccountScoped && selectedProvider && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => { setSelectedProvider(null); setSelectedView('ALL'); }}
            className="inline-flex items-center gap-1.5 rounded-full border border-gray-300 bg-white px-3.5 py-1.5 text-xs font-semibold text-gray-600 hover:bg-gray-50 transition-colors cursor-pointer"
          >
            <ArrowLeft size={13} /> All clouds
          </button>
          <span className="h-4 w-px bg-gray-200" />
          <button
            onClick={() => setSelectedView('ALL')}
            className={`rounded-full border px-3.5 py-1.5 text-xs font-semibold transition-colors cursor-pointer ${
              selectedView === 'ALL' ? '' : 'bg-white border-gray-300 text-gray-600 hover:bg-gray-50'
            }`}
            style={selectedView === 'ALL' ? {
              borderColor: PROVIDER_META[selectedProvider]?.color,
              background: PROVIDER_META[selectedProvider]?.accent,
              color: PROVIDER_META[selectedProvider]?.color,
            } : undefined}
          >
            All {selectedProvider} accounts
          </button>
          {visibleAccounts.map(acc => (
            <button
              key={acc.id}
              onClick={() => setSelectedView(acc.id)}
              className={`rounded-full border px-3.5 py-1.5 text-xs font-semibold transition-colors cursor-pointer ${
                selectedView === acc.id ? '' : 'bg-white border-gray-300 text-gray-600 hover:bg-gray-50'
              }`}
              style={selectedView === acc.id ? {
                borderColor: PROVIDER_META[selectedProvider]?.color,
                background: PROVIDER_META[selectedProvider]?.accent,
                color: PROVIDER_META[selectedProvider]?.color,
              } : undefined}
            >
              {acc.account_name}
              {acc.environment && (
                <span className="ml-1.5 opacity-60">({acc.environment})</span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Stat Cards Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg flex items-center justify-center bg-blue-50 text-blue-600 shrink-0">
              <Cloud size={20} />
            </div>
            <div>
              <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">Cloud Accounts</p>
              <p className="text-2xl font-bold text-gray-900">{scopedAccountsList.length}</p>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg flex items-center justify-center bg-purple-50 text-purple-600 shrink-0">
              <Server size={20} />
            </div>
            <div>
              <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">Total Resources</p>
              <p className="text-2xl font-bold text-gray-900">{totalResources}</p>
            </div>
          </div>
        </div>

        <div
          onClick={() => navigate('/cloud/cost')}
          className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 hover:shadow-md hover:border-blue-200 transition-all cursor-pointer"
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg flex items-center justify-center bg-green-50 text-green-600 shrink-0">
              <DollarSign size={20} />
            </div>
            {/* min-w-0 lets the amount truncate instead of overflowing the card:
                a flex child defaults to min-width:auto and refuses to shrink. */}
            <div className="min-w-0">
              <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">Monthly Cost (billed)</p>
              {costsLoading ? (
                <div className="h-7 w-24 mt-1 rounded bg-gray-100 animate-pulse" />
              ) : !hasCostData ? (
                <p className="text-2xl font-bold text-gray-400">NA</p>
              ) : hasMixedCurrencies ? (
                <>
                  <p className="text-2xl font-bold text-gray-400">NA</p>
                  <p className="text-[11px] text-gray-400">mixed currencies</p>
                </>
              ) : (
                <p
                  className="text-2xl font-bold text-gray-900 truncate"
                  title={singleCurrency ? formatCurrency(totalCost, singleCurrency) : totalCost.toFixed(2)}
                >
                  {singleCurrency ? formatCurrency(totalCost, singleCurrency) : totalCost.toFixed(2)}
                </p>
              )}
            </div>
          </div>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg flex items-center justify-center bg-amber-50 text-amber-600 shrink-0">
              <Activity size={20} />
            </div>
            <div>
              <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">Active Scans</p>
              <p className="text-2xl font-bold text-gray-900">{activeJobsCount}</p>
            </div>
          </div>
        </div>

        {/* Security Health Score Card */}
        <div
          onClick={() => navigate('/cloud/security')}
          className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 hover:shadow-md hover:border-blue-200 transition-all cursor-pointer"
        >
          <div className="flex items-center gap-3">
            <div
              className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0"
              style={securityGrade != null
                ? { background: `${getGradeColor(securityGrade)}14`, color: getGradeColor(securityGrade) }
                : { background: '#f3f4f6', color: '#6b7280' }}
            >
              {avgSecurityScore == null
                ? <Shield size={20} />
                : avgSecurityScore >= 80 ? <ShieldCheck size={20} /> : <ShieldAlert size={20} />}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">Security Health</p>
              {posturesLoading ? (
                <div className="h-7 w-16 mt-1 rounded bg-gray-100 animate-pulse" />
              ) : avgSecurityScore != null && securityGrade != null ? (
                <div className="flex items-baseline gap-1.5">
                  <span className="text-2xl font-bold text-gray-900">{avgSecurityScore}</span>
                  <span className="text-sm font-bold" style={{ color: getGradeColor(securityGrade) }}>Grade {securityGrade}</span>
                </div>
              ) : (
                <p className="text-2xl font-bold text-gray-400">NA</p>
              )}
            </div>
            <ArrowRight size={16} className="text-gray-400 shrink-0" />
          </div>
        </div>
      </div>

      {/* Main Charts & Timeline Section */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

        {/* Resource Breakdown Donut */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
          <h3 className="text-sm font-bold text-gray-700 uppercase tracking-wider flex items-center gap-2 mb-4">
            <Layers size={16} className="text-blue-600" />
            Resource Type Distribution
          </h3>
          {pieData.length === 0 ? (
            <div className="h-[260px] flex items-center justify-center rounded-lg border border-dashed border-gray-200 text-sm text-gray-500">
              No resources found
            </div>
          ) : (
            <>
              <div className="h-[200px]">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={pieData}
                      cx="50%"
                      cy="50%"
                      innerRadius={58}
                      outerRadius={85}
                      paddingAngle={3}
                      dataKey="value"
                    >
                      {pieData.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={CHART_TOOLTIP_STYLE}
                      itemStyle={{ color: '#374151', fontSize: 12 }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              {/* Capped legend in normal flow — wraps inside the card instead of overflowing it */}
              <div className="flex flex-wrap justify-center gap-x-4 gap-y-1.5 mt-3">
                {pieData.map((entry, index) => (
                  <span key={entry.name} className="inline-flex items-center gap-1.5 text-[11px] text-gray-600">
                    <span className="h-2 w-2 rounded-full shrink-0" style={{ background: COLORS[index % COLORS.length] }} />
                    {entry.name}
                    <span className="text-gray-400 font-semibold">{entry.value}</span>
                  </span>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Region Heatmap Bar */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
          <h3 className="text-sm font-bold text-gray-700 uppercase tracking-wider flex items-center gap-2 mb-4">
            <Globe size={16} className="text-blue-600" />
            Geographic / Region Breakdown
          </h3>
          <div className="h-[260px]">
            {barData.length === 0 ? (
              <div className="h-full flex items-center justify-center rounded-lg border border-dashed border-gray-200 text-sm text-gray-500">
                No region data found
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={barData} margin={{ top: 10, right: 10, left: -25, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />
                  <XAxis dataKey="name" tick={{ fill: '#6b7280', fontSize: 12 }} tickLine={false} axisLine={{ stroke: '#e5e7eb' }} />
                  <YAxis tick={{ fill: '#6b7280', fontSize: 12 }} tickLine={false} axisLine={{ stroke: '#e5e7eb' }} />
                  <Tooltip
                    contentStyle={CHART_TOOLTIP_STYLE}
                    itemStyle={{ color: '#374151', fontSize: 12 }}
                    cursor={{ fill: '#f3f4f6' }}
                  />
                  <Bar dataKey="value" fill="#2563eb" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

      </div>

      {/* Lower Section: Scan Timeline & Recently Discovered */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

        {/* Scan timeline and accounts */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
          <h3 className="text-sm font-bold text-gray-700 uppercase tracking-wider flex items-center gap-2 mb-4">
            <Clock size={16} className="text-blue-600" />
            Scan History &amp; Account Health
          </h3>
          <div className="flex flex-col gap-3">
            {scopedAccountsList.map((acc) => {
              const posture = postureByAccountId.get(acc.id);
              return (
                <div key={acc.id} className="flex items-center justify-between rounded-lg border border-gray-100 bg-gray-50 px-4 py-3">
                  <div className="flex items-center gap-3 min-w-0">
                    {/* Provider icon chip */}
                    <span className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${PROVIDER_ICON_CHIP_CLASSES[acc.provider] || 'bg-gray-100 text-gray-500'}`}>
                      <Cloud size={16} />
                    </span>
                    <div className="min-w-0">
                      <div className="text-[15px] font-semibold text-gray-900 truncate">{acc.account_name}</div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-bold border ${PROVIDER_BADGE_CLASSES[acc.provider] || 'bg-gray-50 text-gray-600 border-gray-200'}`}>
                          {acc.provider}
                        </span>
                        <span className="text-xs text-gray-500">{acc.environment || 'NA'}</span>
                      </div>
                    </div>
                  </div>

                  <div className="text-right shrink-0">
                    <div className="text-xs text-gray-500">
                      {acc.last_discovery ? new Date(acc.last_discovery).toLocaleDateString() : 'Never scanned'}
                    </div>
                    {posture && (
                      <div className="text-xs font-bold mt-1" style={{ color: getGradeColor(posture.grade) }}>
                        Grade {posture.grade} · {posture.score}/100
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            {scopedAccountsList.length === 0 && (
              <div className="flex flex-col items-center gap-2 py-12 text-center">
                <Cloud className="h-6 w-6 text-gray-300" />
                <div className="text-base font-semibold text-gray-900">No cloud accounts</div>
                <div className="text-sm text-gray-500">No cloud accounts connected yet.</div>
              </div>
            )}
          </div>
        </div>

        {/* Recently Discovered */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
          <h3 className="text-sm font-bold text-gray-700 uppercase tracking-wider flex items-center gap-2 mb-4">
            <Sparkles size={16} className="text-blue-600" />
            Recently Discovered Resources
          </h3>
          <div className="flex flex-col gap-2.5">
            {recentlyDiscovered.map(res => (
              <div
                key={res.id}
                onClick={() => navigate(`/cloud/resources/${res.id}`)}
                className="flex items-center justify-between rounded-lg border border-gray-100 bg-gray-50 px-4 py-3 hover:bg-white hover:border-blue-200 hover:shadow-sm transition-all cursor-pointer"
              >
                <div className="min-w-0">
                  <div className="text-[15px] font-semibold text-gray-900 truncate">{res.resource_name}</div>
                  <div className="text-xs text-gray-500 mt-0.5">{res.resource_type} · {res.region_or_zone}</div>
                </div>
                <div className="flex items-center gap-2.5 shrink-0">
                  {res.cost_monthly != null ? (
                    // No currency on resource records — show the raw number, no asserted symbol
                    <span className="text-xs font-bold text-green-600">
                      {Number(res.cost_monthly).toFixed(2)}/mo
                    </span>
                  ) : (
                    <span className="text-xs font-semibold text-gray-400">NA</span>
                  )}
                  <ArrowRight size={14} className="text-gray-400" />
                </div>
              </div>
            ))}
            {recentlyDiscovered.length === 0 && (
              <div className="flex flex-col items-center gap-2 py-12 text-center">
                <Server className="h-6 w-6 text-gray-300" />
                <div className="text-base font-semibold text-gray-900">No resources yet</div>
                <div className="text-sm text-gray-500">No resources discovered yet. Run a discovery scan first.</div>
              </div>
            )}
          </div>
        </div>

      </div>

    </div>
  );
};
