import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCloudAccounts } from '../hooks/useCloudAccounts';
import { useCostAnalytics } from '../hooks/useCost';
import { useCloudStore } from '../state/cloudStore';
import { CloudProviderSelector } from '../components/CloudProviderSelector';
import { ArrowLeft, DollarSign, TrendingUp, Sparkles, AlertTriangle, ShieldCheck, ChevronRight } from 'lucide-react';
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
      <div style={PAGE_STYLE}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh', flexDirection: 'column', gap: 16 }}>
          <div style={SPINNER_STYLE} />
          <span style={{ color: '#94a3b8', fontSize: 15, fontWeight: 500 }}>Analyzing cost trends and optimization savings...</span>
        </div>
      </div>
    );
  }

  const getSeverityStyle = (sev: string) => {
    switch (sev.toUpperCase()) {
      case 'CRITICAL':
      case 'HIGH':
        return { bg: 'rgba(239,68,68,0.15)', fg: '#ef4444', border: 'rgba(239,68,68,0.3)' };
      case 'MEDIUM':
        return { bg: 'rgba(249,115,22,0.15)', fg: '#f97316', border: 'rgba(249,115,22,0.3)' };
      case 'LOW':
      default:
        return { bg: 'rgba(59,130,246,0.15)', fg: '#3b82f6', border: 'rgba(59,130,246,0.3)' };
    }
  };

  const trends = analytics?.trends || [];
  const optimizations = analytics?.optimizations || [];
  const isBilled = analytics?.cost_source === 'billing_api';
  const currencySymbol =
    ({ USD: '$', INR: '₹', EUR: '€', GBP: '£' } as Record<string, string>)[analytics?.currency ?? 'USD']
    ?? `${analytics?.currency ?? ''} `;

  return (
    <div style={PAGE_STYLE}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 28 }}>
        <div>
          <button onClick={() => navigate('/cloud')} style={BACK_BTN}>
            <ArrowLeft size={16} /> Cloud Control Center
          </button>
          <h1 style={{ margin: '8px 0 0', fontSize: 28, fontWeight: 800, color: '#1e293b', letterSpacing: -0.5 }}>
            📈 Cost Analytics & Optimization
          </h1>
          <p style={{ margin: '6px 0 0', color: '#64748b', fontSize: 14 }}>
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
        <div style={CARD_STYLE}>
          <div style={{ textAlign: 'center', padding: '40px 20px' }}>
            <AlertTriangle size={48} color="#ef4444" style={{ marginBottom: 16 }} />
            <h3 style={{ margin: '0 0 8px', color: '#334155', fontSize: 18, fontWeight: 700 }}>Analytics Unavailable</h3>
            <p style={{ margin: 0, color: '#64748b', fontSize: 14 }}>
              Unable to analyze cloud billing. Please make sure resources have been discovered first.
            </p>
          </div>
        </div>
      ) : (
        <>
          {/* Spend Summary Stat Cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 20, marginBottom: 28 }}>
            
            {/* Projected Spend */}
            <div style={CARD_STYLE}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                <div style={{ padding: 12, background: 'rgba(59,130,246,0.12)', borderRadius: 12, color: '#3b82f6' }}>
                  <DollarSign size={24} />
                </div>
                <div>
                  <p style={{ color: '#64748b', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.8, margin: 0 }}>
                    {isBilled ? 'Billed Spend (Last 30 Days)' : 'Projected Monthly Spend'}
                  </p>
                  <p style={{ color: '#1e293b', fontSize: 26, fontWeight: 800, margin: '4px 0 0' }}>
                    {currencySymbol}{analytics.total_monthly_cost.toFixed(2)}
                  </p>
                  <p style={{ color: '#94a3b8', fontSize: 11, margin: '2px 0 0' }}>
                    {isBilled ? 'Actual spend from the cloud billing API' : 'Estimated — billing API returned no cost data'}
                  </p>
                </div>
              </div>
            </div>

            {/* Savings Potentials */}
            <div style={CARD_STYLE}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                <div style={{ padding: 12, background: 'rgba(16,185,129,0.12)', borderRadius: 12, color: '#10b981' }}>
                  <Sparkles size={24} />
                </div>
                <div>
                  <p style={{ color: '#64748b', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.8, margin: 0 }}>Potential Savings</p>
                  <p style={{ color: '#10b981', fontSize: 26, fontWeight: 800, margin: '4px 0 0' }}>
                    -{currencySymbol}{analytics.potential_savings.toFixed(2)}
                  </p>
                </div>
              </div>
            </div>

            {/* Optimized Spend */}
            <div style={CARD_STYLE}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                <div style={{ padding: 12, background: 'rgba(168,85,247,0.12)', borderRadius: 12, color: '#a855f7' }}>
                  <TrendingUp size={24} />
                </div>
                <div>
                  <p style={{ color: '#64748b', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.8, margin: 0 }}>Optimized Net Spend</p>
                  <p style={{ color: '#a855f7', fontSize: 26, fontWeight: 800, margin: '4px 0 0' }}>
                    {currencySymbol}{analytics.net_projected_cost.toFixed(2)}
                  </p>
                </div>
              </div>
            </div>

          </div>

          {/* Historical Charts Grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(450px, 1fr))', gap: 24, marginBottom: 28 }}>
            
            {/* Projected Spend Line */}
            <div style={CARD_STYLE}>
              <h3 style={{ margin: '0 0 16px', color: '#475569', fontSize: 15, fontWeight: 700 }}>
                📊 Monthly Spend Trend (Last 30 Days)
              </h3>
              <div style={{ height: 230 }}>
                {trends.length === 0 ? (
                  <div style={EMPTY_CHART_STYLE}>No trend data found</div>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={trends} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                      <defs>
                        <linearGradient id="colorCost" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#60a5fa" stopOpacity={0.2}/>
                          <stop offset="95%" stopColor="#60a5fa" stopOpacity={0.01}/>
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#eef2f6" vertical={false} />
                      <XAxis dataKey="date" stroke="#64748b" fontSize={9} tickLine={false} />
                      <YAxis stroke="#64748b" fontSize={9} tickLine={false} unit="$" />
                      <Tooltip
                        contentStyle={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: 8 }}
                        itemStyle={{ color: '#475569', fontSize: 11 }}
                      />
                      <Area type="monotone" dataKey="estimated_cost" name="Projected Cost" stroke="#60a5fa" strokeWidth={2} fillOpacity={1} fill="url(#colorCost)" />
                    </AreaChart>
                  </ResponsiveContainer>
                )}
              </div>
            </div>

            {/* Resource Sprawl Line */}
            <div style={CARD_STYLE}>
              <h3 style={{ margin: '0 0 16px', color: '#475569', fontSize: 15, fontWeight: 700 }}>
                📈 Resource Sprawl / growth (Last 30 Days)
              </h3>
              <div style={{ height: 230 }}>
                {trends.length === 0 ? (
                  <div style={EMPTY_CHART_STYLE}>No sprawl data found</div>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={trends} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                      <defs>
                        <linearGradient id="colorCount" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#a855f7" stopOpacity={0.2}/>
                          <stop offset="95%" stopColor="#a855f7" stopOpacity={0.01}/>
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#eef2f6" vertical={false} />
                      <XAxis dataKey="date" stroke="#64748b" fontSize={9} tickLine={false} />
                      <YAxis stroke="#64748b" fontSize={9} tickLine={false} />
                      <Tooltip
                        contentStyle={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: 8 }}
                        itemStyle={{ color: '#475569', fontSize: 11 }}
                      />
                      <Area type="monotone" dataKey="resource_count" name="Total Resources" stroke="#a855f7" strokeWidth={2} fillOpacity={1} fill="url(#colorCount)" />
                    </AreaChart>
                  </ResponsiveContainer>
                )}
              </div>
            </div>

          </div>

          {/* Cost Optimization Recommendations */}
          <div>
            <h3 style={{ margin: '0 0 16px', color: '#475569', fontSize: 16, fontWeight: 800 }}>
              💡 Actionable Cost Optimization Recommendations
            </h3>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {optimizations.length === 0 ? (
                <div style={{ ...CARD_STYLE, padding: '48px 20px', textAlign: 'center' }}>
                  <ShieldCheck size={36} color="#22c55e" style={{ marginBottom: 12 }} />
                  <p style={{ color: '#94a3b8', fontSize: 14, margin: 0 }}>Your cloud resources are fully optimized. No savings recommendations found!</p>
                </div>
              ) : (
                optimizations.map((opt: any) => {
                  const style = getSeverityStyle(opt.severity);
                  return (
                    <div key={opt.id} style={{
                      ...CARD_STYLE,
                      borderLeft: `4px solid ${style.fg}`,
                      background: '#f8fafc',
                      padding: '18px 24px',
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
                        <div>
                          {/* Title & tags */}
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                            <h4 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: '#1e293b' }}>{opt.rule}</h4>
                            <span style={{
                              fontSize: 10, fontWeight: 800, padding: '2px 8px', borderRadius: 12,
                              background: style.bg, border: `1px solid ${style.border}`, color: style.fg,
                              textTransform: 'uppercase', letterSpacing: 0.5
                            }}>
                              {opt.severity} Severity
                            </span>
                            <span style={{
                              fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 12,
                              background: 'rgba(16,185,129,0.15)', border: '1px solid rgba(16,185,129,0.3)', color: '#10b981'
                            }}>
                              Savings: ${opt.potential_savings.toFixed(2)}/mo
                            </span>
                          </div>

                          {/* Description */}
                          <p style={{ margin: '8px 0 12px', color: '#94a3b8', fontSize: 13, lineHeight: 1.5 }}>
                            {opt.description}
                          </p>

                          {/* Remediation */}
                          <div style={{
                            padding: '10px 14px', borderRadius: 8, background: '#f1f5f9', border: '1px solid #eef2f6'
                          }}>
                            <div style={{ color: '#a855f7', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>
                              🔧 Actionable Steps
                            </div>
                            <p style={{ margin: 0, color: '#475569', fontSize: 12 }}>
                              {opt.recommendation}
                            </p>
                          </div>

                          {/* Sub-Resources Breakdown */}
                          {opt.sub_resources && opt.sub_resources.length > 0 && (
                            <div style={{ marginTop: 12, padding: '10px 14px', borderRadius: 8, background: 'rgba(59,130,246,0.05)', border: '1px solid rgba(59,130,246,0.15)' }}>
                              <div style={{ color: '#60a5fa', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>
                                🔍 Resource Cost Breakdown
                              </div>
                              {opt.sub_resources.map((sr: any, idx: number) => (
                                <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 8px', background: 'rgba(0,0,0,0.1)', borderRadius: 6, marginBottom: idx === opt.sub_resources.length - 1 ? 0 : 4 }}>
                                  <span style={{ color: '#334155', fontSize: 12, fontFamily: 'monospace' }}>{sr.name}</span>
                                  <span style={{ color: '#10b981', fontSize: 12, fontWeight: 600 }}>${sr.cost.toFixed(2)}/mo</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>

                        {/* Affected Resource Link */}
                        <div style={{ flexShrink: 0, textAlign: 'right' }}>
                          <span style={{ color: '#64748b', fontSize: 10, fontWeight: 600, display: 'block', textTransform: 'uppercase' }}>Target Resource</span>
                          <button
                            onClick={() => navigate(`/cloud/resources/${opt.resource_id}`)}
                            style={{
                              background: 'none', border: 'none', color: '#60a5fa', fontSize: 13, fontWeight: 600,
                              cursor: 'pointer', padding: '4px 0 0', display: 'inline-flex', alignItems: 'center', gap: 4,
                              fontFamily: 'inherit'
                            }}
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

const PAGE_STYLE: React.CSSProperties = {
  minHeight: '100%',
  background: '#f1f5f9',
  padding: '28px 32px',
  fontFamily: "'Inter', -apple-system, sans-serif",
};

const SPINNER_STYLE: React.CSSProperties = {
  width: 44,
  height: 44,
  borderRadius: '50%',
  border: '3px solid rgba(96,165,250,0.2)',
  borderTopColor: '#60a5fa',
  animation: 'spin 0.9s linear infinite',
};

const CARD_STYLE: React.CSSProperties = {
  background: '#f8fafc',
  border: '1px solid #e2e8f0',
  borderRadius: 16,
  padding: '20px 24px',
};

const BACK_BTN: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '6px 12px',
  background: '#ffffff',
  border: '1px solid #e2e8f0',
  borderRadius: 8,
  color: '#94a3b8',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
  fontFamily: 'inherit',
  marginBottom: 4,
};

const SELECT_STYLE: React.CSSProperties = {
  background: '#ffffff',
  border: '1px solid #e2e8f0',
  borderRadius: 10,
  color: '#334155',
  fontSize: 13,
  padding: '8px 14px',
  fontFamily: 'inherit',
  outline: 'none',
  cursor: 'pointer',
};

const EMPTY_CHART_STYLE: React.CSSProperties = {
  height: '100%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: '#64748b',
  fontSize: 13,
  border: '1px dashed #e2e8f0',
  borderRadius: 12,
};
