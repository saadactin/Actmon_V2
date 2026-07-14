import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCloudAccounts } from '../hooks/useCloudAccounts';
import { useAllResources } from '../hooks/useResources';
import { useQueries } from '@tanstack/react-query';
import { getSecurityPosture } from '../api/security.api';
import { getCostEstimate } from '../api/cost.api';
import { useCloudStore } from '../state/cloudStore';
import { Cloud, Server, DollarSign, Activity, ShieldAlert, ShieldCheck, ArrowRight, Clock, Loader2, Layers, Globe, Sparkles } from 'lucide-react';
import { ResponsiveContainer, PieChart, Pie, Cell, Tooltip, Legend, BarChart, Bar, XAxis, YAxis, CartesianGrid } from 'recharts';
import { ProviderSummaryBar, PROVIDER_META } from '../components/CloudProviderSelector';

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
  const { data: accounts, isLoading: accountsLoading } = useCloudAccounts();
  const { data: allResources, isLoading: resourcesLoading } = useAllResources();
  const activeJobs = useCloudStore(state => state.activeDiscoveryJobs);
  const activeJobsCount = Object.keys(activeJobs).length;
  const setDrawerOpen = useCloudStore(state => state.setAddAccountDrawerOpen);

  // Selected view: null = ALL, string = accountId
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [selectedView, setSelectedView] = useState<string>('ALL');

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

  // Filter security postures
  const activePostures = postureQueries
    ? postureQueries
      .map(q => q.data)
      .filter((p): p is NonNullable<typeof p> => !!p &&
        (selectedView === 'ALL' ? visibleAccountIds.has(p.account_id) : p.account_id === selectedView))
    : [];

  // Filter cost estimates
  const activeCosts = costQueries
    ? costQueries
      .map(q => q.data)
      .filter((c): c is NonNullable<typeof c> => !!c &&
        (selectedView === 'ALL' ? visibleAccountIds.has(c.account_id) : c.account_id === selectedView))
    : [];

  // Compute stats
  const totalResources = filteredResources.length;
  const totalCost = activeCosts.reduce((sum, c) => sum + (c.total_monthly_cost || 0), 0);

  // Security score (average of selected)
  const avgSecurityScore = activePostures.length > 0
    ? Math.round(activePostures.reduce((sum, p) => sum + p.score, 0) / activePostures.length)
    : 100;

  const getSecurityGrade = (score: number) => {
    if (score >= 90) return 'A';
    if (score >= 75) return 'B';
    if (score >= 60) return 'C';
    if (score >= 40) return 'D';
    return 'F';
  };

  const securityGrade = getSecurityGrade(avgSecurityScore);

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

  const COLORS = ['#2563eb', '#0d9488', '#7c3aed', '#f59e0b', '#db2777', '#0891b2', '#dc2626', '#65a30d', '#6366f1'];
  const pieData = Object.entries(typeCounts).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);

  // 2. Bar chart data: region breakdown
  const regionCounts = filteredResources.reduce((acc, r) => {
    const region = r.region_or_zone || 'unknown';
    acc[region] = (acc[region] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const barData = Object.entries(regionCounts).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value).slice(0, 8);

  // Recently Discovered
  const recentlyDiscovered = allResources
    ? [...allResources]
      .sort((a, b) => new Date(b.discovered_at).getTime() - new Date(a.discovered_at).getTime())
      .slice(0, 5)
    : [];

  const handleAddAccount = () => {
    navigate('/cloud/accounts');
    setTimeout(() => setDrawerOpen(true), 100);
  };

  return (
    <div className="p-6 space-y-6">
      {/* ── Provider Summary Bar (AWS / Azure / OCI panels) ── */}
      <ProviderSummaryBar
        accounts={accounts || []}
        selectedProvider={selectedProvider}
        onSelectProvider={p => {
          setSelectedProvider(p);
          setSelectedView('ALL');
        }}
      />

      {/* ── Per-provider account chips (only when a provider is selected) ── */}
      {selectedProvider && (
        <div className="flex flex-wrap gap-2">
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
              <p className="text-2xl font-bold text-gray-900">{accounts?.length || 0}</p>
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
            <div>
              <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">Est. Monthly Cost</p>
              <p className="text-2xl font-bold text-gray-900">${totalCost.toFixed(2)}</p>
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
              style={{ background: `${getGradeColor(securityGrade)}14`, color: getGradeColor(securityGrade) }}
            >
              {avgSecurityScore >= 80 ? <ShieldCheck size={20} /> : <ShieldAlert size={20} />}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">Security Health</p>
              <div className="flex items-baseline gap-1.5">
                <span className="text-2xl font-bold text-gray-900">{avgSecurityScore}</span>
                <span className="text-sm font-bold" style={{ color: getGradeColor(securityGrade) }}>Grade {securityGrade}</span>
              </div>
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
          <div className="relative h-[260px]">
            {pieData.length === 0 ? (
              <div className="h-full flex items-center justify-center rounded-lg border border-dashed border-gray-200 text-sm text-gray-500">
                No resources found
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={pieData}
                    cx="50%"
                    cy="50%"
                    innerRadius={65}
                    outerRadius={90}
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
                  <Legend
                    verticalAlign="bottom"
                    height={36}
                    iconType="circle"
                    iconSize={8}
                    wrapperStyle={{ fontSize: 11, color: '#6b7280' }}
                  />
                </PieChart>
              </ResponsiveContainer>
            )}
          </div>
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
            {(accounts || []).map((acc, idx) => {
              const posture = postureQueries?.[idx]?.data;
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
                        <span className="text-xs text-gray-500">{acc.environment || 'production'}</span>
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
            {(!accounts || accounts.length === 0) && (
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
                  {res.cost_monthly != null && (
                    <span className="text-xs font-bold text-green-600">
                      ${Number(res.cost_monthly).toFixed(2)}/mo
                    </span>
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
