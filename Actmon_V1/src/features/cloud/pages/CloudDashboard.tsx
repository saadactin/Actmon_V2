import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCloudAccounts } from '../hooks/useCloudAccounts';
import { useAllResources } from '../hooks/useResources';
import { useQueries } from '@tanstack/react-query';
import { getSecurityPosture } from '../api/security.api';
import { getCostEstimate } from '../api/cost.api';
import { useCloudStore } from '../state/cloudStore';
import { Button, Spinner } from '@fluentui/react-components';
import { Cloud, Server, DollarSign, Activity, Plus, ShieldAlert, ShieldCheck, ArrowRight, Clock } from 'lucide-react';
import { ResponsiveContainer, PieChart, Pie, Cell, Tooltip, Legend, BarChart, Bar, XAxis, YAxis, CartesianGrid } from 'recharts';
import { ProviderSummaryBar, CloudProviderSelector, PROVIDER_META, getProviderColor } from '../components/CloudProviderSelector';

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
      <div style={PAGE_STYLE}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh', flexDirection: 'column', gap: 16 }}>
          <Spinner size="large" />
          <span style={{ color: '#94a3b8', fontSize: 14 }}>Aggregating cloud resources...</span>
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
      case 'A': return '#22c55e';
      case 'B': return '#10b981';
      case 'C': return '#eab308';
      case 'D': return '#f97316';
      case 'F': return '#ef4444';
      default: return '#94a3b8';
    }
  };

  // 1. Donut chart data: resources by type
  const typeCounts = filteredResources.reduce((acc, r) => {
    acc[r.resource_type] = (acc[r.resource_type] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const COLORS = ['#60a5fa', '#a855f7', '#10b981', '#f59e0b', '#ec4899', '#3b82f6', '#ef4444', '#06b6d4', '#6366f1'];
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
    <div style={PAGE_STYLE}>
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
        <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
          <button
            onClick={() => setSelectedView('ALL')}
            style={{
              padding: '7px 14px', borderRadius: 10, fontSize: 12, fontWeight: 600,
              fontFamily: 'inherit', cursor: 'pointer', transition: 'all 0.15s',
              border: `1.5px solid ${selectedView === 'ALL' ? PROVIDER_META[selectedProvider]?.color : '#e2e8f0'}`,
              background: selectedView === 'ALL' ? PROVIDER_META[selectedProvider]?.accent : '#eef2f6',
              color: selectedView === 'ALL' ? PROVIDER_META[selectedProvider]?.color : '#64748b',
            }}
          >
            All {selectedProvider} accounts
          </button>
          {visibleAccounts.map(acc => (
            <button
              key={acc.id}
              onClick={() => setSelectedView(acc.id)}
              style={{
                padding: '7px 14px', borderRadius: 10, fontSize: 12, fontWeight: 600,
                fontFamily: 'inherit', cursor: 'pointer', transition: 'all 0.15s',
                border: `1.5px solid ${selectedView === acc.id ? PROVIDER_META[selectedProvider]?.color : '#e2e8f0'}`,
                background: selectedView === acc.id ? PROVIDER_META[selectedProvider]?.accent : '#eef2f6',
                color: selectedView === acc.id ? PROVIDER_META[selectedProvider]?.color : '#64748b',
              }}
            >
              {acc.account_name}
              {acc.environment && (
                <span style={{ marginLeft: 6, opacity: 0.6 }}>({acc.environment})</span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Stat Cards Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 20, marginBottom: 28 }}>
        <div style={CARD_STYLE}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{ p: 3, padding: 12, background: 'rgba(59,130,246,0.12)', borderRadius: 12, color: '#3b82f6' }}>
              <Cloud size={24} />
            </div>
            <div>
              <p style={{ color: '#64748b', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.8, margin: 0 }}>Cloud Accounts</p>
              <p style={{ color: '#1e293b', fontSize: 24, fontWeight: 800, margin: '4px 0 0' }}>{accounts?.length || 0}</p>
            </div>
          </div>
        </div>

        <div style={CARD_STYLE}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{ p: 3, padding: 12, background: 'rgba(168,85,247,0.12)', borderRadius: 12, color: '#a855f7' }}>
              <Server size={24} />
            </div>
            <div>
              <p style={{ color: '#64748b', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.8, margin: 0 }}>Total Resources</p>
              <p style={{ color: '#1e293b', fontSize: 24, fontWeight: 800, margin: '4px 0 0' }}>{totalResources}</p>
            </div>
          </div>
        </div>

        <div
          onClick={() => navigate('/cloud/cost')}
          style={{ ...CARD_STYLE, cursor: 'pointer', transition: 'all 0.15s' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{ p: 3, padding: 12, background: 'rgba(16,185,129,0.12)', borderRadius: 12, color: '#10b981' }}>
              <DollarSign size={24} />
            </div>
            <div>
              <p style={{ color: '#64748b', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.8, margin: 0 }}>Est. Monthly Cost</p>
              <p style={{ color: '#1e293b', fontSize: 24, fontWeight: 800, margin: '4px 0 0' }}>${totalCost.toFixed(2)}</p>
            </div>
          </div>
        </div>


        <div style={CARD_STYLE}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{ p: 3, padding: 12, background: 'rgba(234,179,8,0.12)', borderRadius: 12, color: '#eab308' }}>
              <Activity size={24} />
            </div>
            <div>
              <p style={{ color: '#64748b', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.8, margin: 0 }}>Active Scans</p>
              <p style={{ color: '#1e293b', fontSize: 24, fontWeight: 800, margin: '4px 0 0' }}>{activeJobsCount}</p>
            </div>
          </div>
        </div>

        {/* Security Health Score Card */}
        <div
          onClick={() => navigate('/cloud/security')}
          style={{ ...CARD_STYLE, cursor: 'pointer', hover: { background: '#ffffff' }, transition: 'all 0.15s' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{
              p: 3, padding: 12,
              background: `${getGradeColor(securityGrade)}12`,
              borderRadius: 12,
              color: getGradeColor(securityGrade)
            }}>
              {avgSecurityScore >= 80 ? <ShieldCheck size={24} /> : <ShieldAlert size={24} />}
            </div>
            <div style={{ flex: 1 }}>
              <p style={{ color: '#64748b', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.8, margin: 0 }}>Security Health</p>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, margin: '4px 0 0' }}>
                <span style={{ color: '#1e293b', fontSize: 24, fontWeight: 800 }}>{avgSecurityScore}</span>
                <span style={{ color: getGradeColor(securityGrade), fontSize: 14, fontWeight: 700 }}>Grade {securityGrade}</span>
              </div>
            </div>
            <ArrowRight size={16} color="#64748b" />
          </div>
        </div>
      </div>

      {/* Main Charts & Timeline Section */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(450px, 1fr))', gap: 24, marginBottom: 28 }}>
        
        {/* Resource Breakdown Donut */}
        <div style={CARD_STYLE}>
          <h3 style={{ margin: '0 0 16px', color: '#475569', fontSize: 15, fontWeight: 700 }}>
            Resource Type Distribution
          </h3>
          <div style={{ height: 260, position: 'relative' }}>
            {pieData.length === 0 ? (
              <div style={EMPTY_CHART_STYLE}>No resources found</div>
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
                    contentStyle={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: 8 }}
                    itemStyle={{ color: '#475569', fontSize: 12 }}
                  />
                  <Legend
                    verticalAlign="bottom"
                    height={36}
                    iconType="circle"
                    iconSize={8}
                    wrapperStyle={{ fontSize: 11, color: '#64748b' }}
                  />
                </PieChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        {/* Region Heatmap Bar */}
        <div style={CARD_STYLE}>
          <h3 style={{ margin: '0 0 16px', color: '#475569', fontSize: 15, fontWeight: 700 }}>
            Geographic / Region Breakdown
          </h3>
          <div style={{ height: 260 }}>
            {barData.length === 0 ? (
              <div style={EMPTY_CHART_STYLE}>No region data found</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={barData} margin={{ top: 10, right: 10, left: -25, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#eef2f6" vertical={false} />
                  <XAxis dataKey="name" stroke="#64748b" fontSize={10} tickLine={false} />
                  <YAxis stroke="#64748b" fontSize={10} tickLine={false} />
                  <Tooltip
                    contentStyle={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: 8 }}
                    itemStyle={{ color: '#475569', fontSize: 12 }}
                    cursor={{ fill: '#eef2f6' }}
                  />
                  <Bar dataKey="value" fill="#60a5fa" radius={[4, 4, 0, 0]}>
                    {barData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={COLORS[(index + 2) % COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

      </div>

      {/* Lower Section: Scan Timeline & Recently Discovered */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(450px, 1fr))', gap: 24 }}>
        
        {/* Scan timeline and accounts */}
        <div style={CARD_STYLE}>
          <h3 style={{ margin: '0 0 16px', color: '#475569', fontSize: 15, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Clock size={16} /> Scan History & Account Health
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {(accounts || []).map((acc, idx) => {
              const posture = postureQueries?.[idx]?.data;
              const meta = PROVIDER_META[acc.provider];
              return (
                <div key={acc.id} style={ACCOUNT_ROW_STYLE}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    {/* Provider badge */}
                    <span style={{
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      width: 32, height: 32, borderRadius: 9,
                      background: meta?.bg, fontSize: 18, flexShrink: 0,
                    }}>{meta?.logo || '⚪'}</span>
                    <div>
                      <div style={{ color: '#334155', fontSize: 13, fontWeight: 700 }}>{acc.account_name}</div>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 3 }}>
                        <span style={{
                          fontSize: 10, fontWeight: 800, padding: '1px 6px', borderRadius: 6,
                          background: meta?.accent, color: meta?.color,
                        }}>{acc.provider}</span>
                        <span style={{ color: '#475569', fontSize: 11 }}>{acc.environment || 'production'}</span>
                      </div>
                    </div>
                  </div>
                  
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ color: '#475569', fontSize: 11 }}>
                      {acc.last_discovery ? new Date(acc.last_discovery).toLocaleDateString() : 'Never scanned'}
                    </div>
                    {posture && (
                      <div style={{ fontSize: 12, fontWeight: 800, color: getGradeColor(posture.grade), marginTop: 4 }}>
                        Grade {posture.grade} · {posture.score}/100
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            {(!accounts || accounts.length === 0) && (
              <div style={{ color: '#64748b', fontSize: 13, padding: '20px 0', textAlign: 'center' }}>
                No cloud accounts connected yet.
              </div>
            )}
          </div>
        </div>

        {/* Recently Discovered */}
        <div style={CARD_STYLE}>
          <h3 style={{ margin: '0 0 16px', color: '#475569', fontSize: 15, fontWeight: 700 }}>
            Recently Discovered Resources
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {recentlyDiscovered.map(res => (
              <div
                key={res.id}
                onClick={() => navigate(`/cloud/resources/${res.id}`)}
                style={{ ...RESOURCE_ROW_STYLE, cursor: 'pointer' }}
              >
                <div>
                  <div style={{ color: '#334155', fontSize: 13, fontWeight: 700 }}>{res.resource_name}</div>
                  <div style={{ color: '#64748b', fontSize: 11, marginTop: 2 }}>{res.resource_type} • {res.region_or_zone}</div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  {res.cost_monthly != null && (
                    <span style={{ color: '#10b981', fontSize: 12, fontWeight: 700 }}>
                      ${Number(res.cost_monthly).toFixed(2)}/mo
                    </span>
                  )}
                  <ArrowRight size={14} color="#64748b" />
                </div>
              </div>
            ))}
            {recentlyDiscovered.length === 0 && (
              <div style={{ color: '#64748b', fontSize: 13, padding: '20px 0', textAlign: 'center' }}>
                No resources discovered yet. Run a discovery scan first.
              </div>
            )}
          </div>
        </div>

      </div>

    </div>
  );
};

const PAGE_STYLE: React.CSSProperties = {
  minHeight: '100%',
  background: '#f1f5f9',
  padding: '28px 32px',
  fontFamily: "'Inter', -apple-system, sans-serif",
};

const CARD_STYLE: React.CSSProperties = {
  background: '#f8fafc',
  border: '1px solid #e2e8f0',
  borderRadius: 16,
  padding: '20px 24px',
};

const UI_BTN_STYLE: React.CSSProperties = {
  background: '#ffffff',
  border: '1px solid #e2e8f0',
  color: '#475569',
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

const ACCOUNT_ROW_STYLE: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '12px 16px',
  background: '#f8fafc',
  border: '1px solid #e2e8f0',
  borderRadius: 12,
};

const RESOURCE_ROW_STYLE: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '12px 16px',
  background: '#f8fafc',
  border: '1px solid #e2e8f0',
  borderRadius: 12,
};
