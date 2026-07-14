import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCloudAccounts } from '../hooks/useCloudAccounts';
import { useCostAnalytics } from '../hooks/useCost';
import { useCloudStore } from '../state/cloudStore';
import { CloudProviderSelector } from '../components/CloudProviderSelector';
import { DollarSign, TrendingUp, Sparkles, AlertTriangle, ShieldCheck, ChevronRight, Loader2 } from 'lucide-react';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';

export const CostPage = () => {
  const navigate = useNavigate();
  const { data: accounts } = useCloudAccounts();
  const selectedAccountId = useCloudStore(state => state.selectedAccountId);
  const setSelectedAccountId = useCloudStore(state => state.setSelectedAccountId);

  useEffect(() => {
    if (!selectedAccountId && accounts && accounts.length > 0) {
      setSelectedAccountId(accounts[0].id);
    }
  }, [accounts, selectedAccountId, setSelectedAccountId]);

  // Support querying 'ALL' or specific accountId
  const [currentAccountView, setCurrentAccountView] = useState<string>('ALL');

  const { data: analytics, isLoading, isError } = useCostAnalytics(currentAccountView);

  const selectedAccount = accounts?.find(a => a.id === selectedAccountId);

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

  const getSeverityStyle = (sev: string) => {
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
  const isBilled = analytics?.cost_source === 'billing_api';
  const currencySymbol =
    ({ USD: '$', INR: '₹', EUR: '€', GBP: '£' } as Record<string, string>)[analytics?.currency ?? 'USD']
    ?? `${analytics?.currency ?? ''} `;

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

        {/* Standardized account picker */}
        {accounts && accounts.length > 0 && (
          <CloudProviderSelector
            accounts={accounts}
            mode="multi"
            selected={currentAccountView}
            onSelect={id => setCurrentAccountView(id || 'ALL')}
          />
        )}
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
                    {isBilled ? 'Billed Spend (Last 30 Days)' : 'Projected Monthly Spend'}
                  </p>
                  <p className="text-2xl font-bold text-gray-900 mt-0.5">
                    {currencySymbol}{analytics.total_monthly_cost.toFixed(2)}
                  </p>
                  <p className="text-[11px] text-gray-400 mt-0.5">
                    {isBilled ? 'Actual spend from the cloud billing API' : 'Estimated — billing API returned no cost data'}
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
                  <p className="text-2xl font-bold text-green-600 mt-0.5">
                    -{currencySymbol}{analytics.potential_savings.toFixed(2)}
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
                  <p className="text-2xl font-bold text-purple-600 mt-0.5">
                    {currencySymbol}{analytics.net_projected_cost.toFixed(2)}
                  </p>
                </div>
              </div>
            </div>

          </div>

          {/* Historical Charts Grid */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

            {/* Projected Spend Line */}
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
              <h3 className="text-sm font-bold text-gray-700 uppercase tracking-wider flex items-center gap-2 mb-4">
                <TrendingUp size={16} className="text-blue-600" />
                Monthly Spend Trend (Last 30 Days)
              </h3>
              <div className="h-[230px]">
                {trends.length === 0 ? (
                  <div className="h-full flex items-center justify-center text-sm text-gray-500 border border-dashed border-gray-200 rounded-lg">
                    No trend data found
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={trends} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                      <defs>
                        <linearGradient id="colorCost" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#2563eb" stopOpacity={0.2}/>
                          <stop offset="95%" stopColor="#2563eb" stopOpacity={0.01}/>
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />
                      <XAxis dataKey="date" tick={{ fill: '#6b7280', fontSize: 12 }} axisLine={{ stroke: '#e5e7eb' }} tickLine={false} />
                      <YAxis tick={{ fill: '#6b7280', fontSize: 12 }} axisLine={{ stroke: '#e5e7eb' }} tickLine={false} unit="$" />
                      <Tooltip
                        contentStyle={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 12 }}
                      />
                      <Area type="monotone" dataKey="estimated_cost" name="Projected Cost" stroke="#2563eb" strokeWidth={2} fillOpacity={1} fill="url(#colorCost)" />
                    </AreaChart>
                  </ResponsiveContainer>
                )}
              </div>
            </div>

            {/* Resource Sprawl Line */}
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
              <h3 className="text-sm font-bold text-gray-700 uppercase tracking-wider flex items-center gap-2 mb-4">
                <TrendingUp size={16} className="text-teal-600" />
                Resource Sprawl / Growth (Last 30 Days)
              </h3>
              <div className="h-[230px]">
                {trends.length === 0 ? (
                  <div className="h-full flex items-center justify-center text-sm text-gray-500 border border-dashed border-gray-200 rounded-lg">
                    No sprawl data found
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={trends} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                      <defs>
                        <linearGradient id="colorCount" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#0d9488" stopOpacity={0.2}/>
                          <stop offset="95%" stopColor="#0d9488" stopOpacity={0.01}/>
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />
                      <XAxis dataKey="date" tick={{ fill: '#6b7280', fontSize: 12 }} axisLine={{ stroke: '#e5e7eb' }} tickLine={false} />
                      <YAxis tick={{ fill: '#6b7280', fontSize: 12 }} axisLine={{ stroke: '#e5e7eb' }} tickLine={false} />
                      <Tooltip
                        contentStyle={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 12 }}
                      />
                      <Area type="monotone" dataKey="resource_count" name="Total Resources" stroke="#0d9488" strokeWidth={2} fillOpacity={1} fill="url(#colorCount)" />
                    </AreaChart>
                  </ResponsiveContainer>
                )}
              </div>
            </div>

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
                  <h4 className="text-base font-semibold text-gray-900 mb-1">Fully Optimized</h4>
                  <p className="text-sm text-gray-500">Your cloud resources are fully optimized. No savings recommendations found!</p>
                </div>
              ) : (
                optimizations.map((opt: any) => {
                  const style = getSeverityStyle(opt.severity);
                  return (
                    <div
                      key={opt.id}
                      className={`bg-white rounded-xl border border-gray-200 shadow-sm border-l-4 ${style.accent} p-5`}
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
                              Savings: ${opt.potential_savings.toFixed(2)}/mo
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
                                {opt.sub_resources.map((sr: any, idx: number) => (
                                  <div key={idx} className="flex items-center justify-between px-2 py-1.5 bg-white border border-gray-100 rounded-md">
                                    <span className="text-xs text-gray-500 font-mono">{sr.name}</span>
                                    <span className="text-xs text-green-600 font-semibold">${sr.cost.toFixed(2)}/mo</span>
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
                            onClick={() => navigate(`/cloud/resources/${opt.resource_id}`)}
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
        </>
      )}
    </div>
  );
};
