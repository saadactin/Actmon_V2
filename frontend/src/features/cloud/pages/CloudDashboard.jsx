import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useCloudAccounts } from '../hooks/useCloudAccounts';
import { useAllResources } from '../hooks/useResources';
import { getSecurityPosture } from '../api/security.api';
import { getCostEstimate } from '../api/cost.api';
import {
  Cloud, Server, DollarSign, Activity, Shield, ShieldAlert, ShieldCheck, ArrowRight,
  Clock, Layers, Globe, Sparkles, LayoutDashboard, ClipboardCheck, Bell, Share2,
} from 'lucide-react';
import {
  ResponsiveContainer, PieChart, Pie, Cell, Tooltip, BarChart, Bar, XAxis, YAxis, CartesianGrid,
} from 'recharts';
import { PROVIDER_META } from '../components/CloudProviderSelector';
import { formatCurrency } from '../utils/formatters';
import CloudPageHeader from '../components/CloudPageHeader';
import CloudSection from '../components/CloudSection';
import Tabs from '@/components/ui/Tabs';
import { PageLoading } from '@/components/ui/Loading';
import { ResourcesPage } from './ResourcesPage';
import { CostPage } from './CostPage';
import { SecurityPosturePage } from './SecurityPosturePage';
import { CloudTopologyPage } from './CloudTopologyPage';
import { CompliancePage } from './CompliancePage';
import { AlertsPage } from './AlertsPage';

// Provider brand colours are pinned (external identity), same rationale as
// CloudProviderSelector — never tokenized.
const PROVIDER_BADGE_CLASSES = {
  AWS: 'bg-orange-50 text-orange-700 border-orange-200',
  Azure: 'bg-sky-50 text-sky-700 border-sky-200',
  OCI: 'bg-red-50 text-red-700 border-red-200',
};

const CHART_TOOLTIP_STYLE = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 8,
};

// Generic categorical palette (not provider brand) — the app's chart tokens,
// with a neutral tone for the "Other" rollup bucket.
const COLORS = [
  'var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)',
  'var(--chart-5)', 'var(--chart-6)', 'var(--chart-7)', 'var(--chart-8)',
  'var(--fg-subtle)',
];

// Security grade → status tone. Collapses the five-letter grade scale onto
// the app's three status tones (only that many exist as design tokens).
const GRADE_TONE = { A: 'success', B: 'success', C: 'warning', D: 'warning', F: 'danger' };
const GRADE_TONE_TEXT = {
  success: 'text-success-fg',
  warning: 'text-warning-fg',
  danger: 'text-danger-fg',
  neutral: 'text-muted',
};
const GRADE_TONE_ICON_BG = {
  success: 'bg-success-soft text-success-fg',
  warning: 'bg-warning-soft text-warning-fg',
  danger: 'bg-danger-soft text-danger-fg',
  neutral: 'bg-sunken text-muted',
};
const getGradeTone = (grade) => GRADE_TONE[grade] || 'neutral';
const getSecurityGrade = (score) => {
  if (score >= 90) return 'A';
  if (score >= 75) return 'B';
  if (score >= 60) return 'C';
  if (score >= 40) return 'D';
  return 'F';
};

const TABS = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'resources', label: 'Resources', icon: Server },
  { id: 'cost', label: 'Cost', icon: DollarSign },
  { id: 'security', label: 'Security', icon: ShieldAlert },
  { id: 'topology', label: 'Topology', icon: Share2 },
  { id: 'compliance', label: 'Compliance', icon: ClipboardCheck },
  { id: 'alerts', label: 'Alerts', icon: Bell },
];

/**
 * One cloud account's full dashboard — reached via Cloud → Provider → Account,
 * exactly the way a database connection's own dashboard (e.g. PostgreSQL
 * Dashboard) is reached via Databases → Servers → connection. Overview,
 * Resources, Cost, Security, Topology, Compliance and Alerts are TABS of this
 * one page, scoped to this one account, instead of separate top-level pages —
 * the same shape as EngineDashboardHeader's Overview/Performance/Queries/…
 * tabs for a database connection.
 */
// `provider` ('aws' | 'azure' | 'oci') comes in as a literal prop from the
// route definition (App.jsx), same as CloudProviderAccountsPage — only
// `accountId`/`tab` are genuine dynamic route params.
export const CloudDashboard = ({ provider: routeProviderSlug }) => {
  const navigate = useNavigate();
  const { accountId: routeAccountId, tab = 'overview' } = useParams();
  const { data: accounts, isLoading: accountsLoading } = useCloudAccounts();
  const { data: allResources, isLoading: resourcesLoading } = useAllResources();

  const scopedAccount = (accounts || []).find((a) => a.id === routeAccountId);

  const { data: posture, isLoading: postureLoading } = useQuery({
    queryKey: ['securityPosture', routeAccountId],
    queryFn: () => getSecurityPosture(routeAccountId),
    enabled: !!routeAccountId,
    staleTime: 30_000,
  });
  const { data: costEstimate, isLoading: costLoading } = useQuery({
    queryKey: ['costEstimate', routeAccountId],
    queryFn: () => getCostEstimate(routeAccountId),
    enabled: !!routeAccountId,
    staleTime: 30_000,
  });

  // Scoped to the Overview tab only (not an early return for the whole page):
  // the other tabs are independent components with their own loading state, and
  // early-returning here would mount/unmount them in lockstep with this query —
  // each fresh mount re-triggers React Query's refetch-on-mount for the same
  // ['cloudAccounts'] key, which (while the query keeps failing) never lets the
  // loading state settle, looping forever instead of a one-time retry.
  const isLoading = accountsLoading || resourcesLoading;

  const setTab = (id) => navigate(`/cloud/${routeProviderSlug}-accounts/${routeAccountId}/${id}`, { replace: true });

  const accountResources = (allResources || []).filter((r) => r.account_id === routeAccountId);
  const totalResources = accountResources.length;

  const hasCostData = !!costEstimate && typeof costEstimate.total_monthly_cost === 'number';
  const totalCost = hasCostData ? costEstimate.total_monthly_cost : 0;

  const securityScore = posture?.score ?? null;
  const securityGrade = securityScore != null ? getSecurityGrade(securityScore) : null;

  // Resource type distribution — capped at the top 8; everything else rolls
  // into "Other" (some accounts have 50+ types — a full legend overflows the card).
  const typeCounts = accountResources.reduce((acc, r) => {
    acc[r.resource_type] = (acc[r.resource_type] || 0) + 1;
    return acc;
  }, {});
  const allTypesArr = Object.entries(typeCounts).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  const otherCount = allTypesArr.slice(8).reduce((sum, t) => sum + t.value, 0);
  const otherTypes = allTypesArr.length - 8;
  const pieData = otherCount > 0
    ? [...allTypesArr.slice(0, 8), { name: `Other (${otherTypes} types)`, value: otherCount }]
    : allTypesArr;

  // Region breakdown
  const regionCounts = accountResources.reduce((acc, r) => {
    const region = r.region_or_zone || 'unknown';
    acc[region] = (acc[region] || 0) + 1;
    return acc;
  }, {});
  const barData = Object.entries(regionCounts).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value).slice(0, 8);

  const recentlyDiscovered = [...accountResources]
    .sort((a, b) => new Date(b.discovered_at).getTime() - new Date(a.discovered_at).getTime())
    .slice(0, 5);

  return (
    <>
      <CloudPageHeader
        hideBreadcrumbs
        backTo={`/cloud/${routeProviderSlug}-accounts`}
        leading={(
          <span
            className="grid h-10 w-10 shrink-0 place-items-center rounded-md text-[20px]"
            style={{ background: PROVIDER_META[scopedAccount?.provider]?.bg }}
          >
            <Cloud size={20} style={{ color: PROVIDER_META[scopedAccount?.provider]?.color }} />
          </span>
        )}
        title={scopedAccount?.account_name || 'Account'}
        description={[scopedAccount?.provider, scopedAccount?.tenant_or_region || scopedAccount?.environment].filter(Boolean).join(' · ')}
        tabs={<Tabs tabs={TABS} value={tab} onChange={setTab} />}
      />

      {tab === 'overview' && (isLoading ? <PageLoading title="Loading account…" /> : (
        <div className="space-y-6">
          {/* Stat Cards Grid */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-card border border-border bg-surface p-5 shadow-sm">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-text">
                  <Server size={20} />
                </div>
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">Total Resources</p>
                  <p className="text-2xl font-bold text-fg">{totalResources}</p>
                </div>
              </div>
            </div>

            <div
              onClick={() => setTab('cost')}
              className="cursor-pointer rounded-card border border-border bg-surface p-5 shadow-sm transition-all hover:border-accent hover:shadow-md"
            >
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-success-soft text-success-fg">
                  <DollarSign size={20} />
                </div>
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">Monthly Cost (billed)</p>
                  {costLoading ? (
                    <div className="mt-1 h-7 w-24 animate-pulse rounded bg-sunken" />
                  ) : !hasCostData ? (
                    <p className="text-2xl font-bold text-subtle">NA</p>
                  ) : (
                    <p
                      className="truncate text-2xl font-bold text-fg"
                      title={costEstimate.currency ? formatCurrency(totalCost, costEstimate.currency) : totalCost.toFixed(2)}
                    >
                      {costEstimate.currency ? formatCurrency(totalCost, costEstimate.currency) : totalCost.toFixed(2)}
                    </p>
                  )}
                </div>
              </div>
            </div>

            <div
              onClick={() => setTab('security')}
              className="cursor-pointer rounded-card border border-border bg-surface p-5 shadow-sm transition-all hover:border-accent hover:shadow-md"
            >
              <div className="flex items-center gap-3">
                <div
                  className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${
                    GRADE_TONE_ICON_BG[securityGrade != null ? getGradeTone(securityGrade) : 'neutral']
                  }`}
                >
                  {securityScore == null
                    ? <Shield size={20} />
                    : securityScore >= 80 ? <ShieldCheck size={20} /> : <ShieldAlert size={20} />}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">Security Health</p>
                  {postureLoading ? (
                    <div className="mt-1 h-7 w-16 animate-pulse rounded bg-sunken" />
                  ) : securityScore != null && securityGrade != null ? (
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-2xl font-bold text-fg">{securityScore}</span>
                      <span className={`text-sm font-bold ${GRADE_TONE_TEXT[getGradeTone(securityGrade)]}`}>Grade {securityGrade}</span>
                    </div>
                  ) : (
                    <p className="text-2xl font-bold text-subtle">NA</p>
                  )}
                </div>
                <ArrowRight size={16} className="shrink-0 text-subtle" />
              </div>
            </div>

            <div className="rounded-card border border-border bg-surface p-5 shadow-sm">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-info-soft text-info-fg">
                  <Activity size={20} />
                </div>
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">Last Scan</p>
                  <p className="text-2xl font-bold text-fg">
                    {scopedAccount?.last_discovery ? new Date(scopedAccount.last_discovery).toLocaleDateString() : 'Never'}
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* Charts */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <CloudSection title={(
              <span className="flex items-center gap-2">
                <Layers size={16} className="text-accent-text" />
                Resource Type Distribution
              </span>
            )}
            >
              {pieData.length === 0 ? (
                <div className="flex h-[260px] items-center justify-center rounded-card border border-dashed border-border text-sm text-muted">
                  No resources found
                </div>
              ) : (
                <>
                  <div className="h-[200px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie data={pieData} cx="50%" cy="50%" innerRadius={58} outerRadius={85} paddingAngle={3} dataKey="value">
                          {pieData.map((entry, index) => (
                            <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                          ))}
                        </Pie>
                        <Tooltip contentStyle={CHART_TOOLTIP_STYLE} itemStyle={{ color: 'var(--fg)', fontSize: 12 }} />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="mt-3 flex flex-wrap justify-center gap-x-4 gap-y-1.5">
                    {pieData.map((entry, index) => (
                      <span key={entry.name} className="inline-flex items-center gap-1.5 text-[11px] text-muted">
                        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: COLORS[index % COLORS.length] }} />
                        {entry.name}
                        <span className="font-semibold text-subtle">{entry.value}</span>
                      </span>
                    ))}
                  </div>
                </>
              )}
            </CloudSection>

            <CloudSection title={(
              <span className="flex items-center gap-2">
                <Globe size={16} className="text-accent-text" />
                Geographic / Region Breakdown
              </span>
            )}
            >
              <div className="h-[260px]">
                {barData.length === 0 ? (
                  <div className="flex h-full items-center justify-center rounded-card border border-dashed border-border text-sm text-muted">
                    No region data found
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={barData} margin={{ top: 10, right: 10, left: -25, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" vertical={false} />
                      <XAxis dataKey="name" tick={{ fill: 'var(--chart-axis)', fontSize: 12 }} tickLine={false} axisLine={{ stroke: 'var(--chart-grid)' }} />
                      <YAxis tick={{ fill: 'var(--chart-axis)', fontSize: 12 }} tickLine={false} axisLine={{ stroke: 'var(--chart-grid)' }} />
                      <Tooltip contentStyle={CHART_TOOLTIP_STYLE} itemStyle={{ color: 'var(--fg)', fontSize: 12 }} cursor={{ fill: 'var(--chart-track)' }} />
                      <Bar dataKey="value" fill="var(--chart-1)" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </div>
            </CloudSection>
          </div>

          {/* Account health + recently discovered */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <CloudSection title={(
              <span className="flex items-center gap-2">
                <Clock size={16} className="text-accent-text" />
                Account Health
              </span>
            )}
            >
              {scopedAccount ? (
                <div className="flex items-center justify-between rounded-card border border-border bg-sunken px-4 py-3">
                  <div className="min-w-0">
                    <div className="truncate text-[15px] font-semibold text-fg">{scopedAccount.account_name}</div>
                    <div className="mt-0.5 flex items-center gap-2">
                      <span className={`rounded-full border px-2.5 py-0.5 text-[11px] font-bold ${PROVIDER_BADGE_CLASSES[scopedAccount.provider] || 'border-border bg-sunken text-muted'}`}>
                        {scopedAccount.provider}
                      </span>
                      <span className="text-xs text-muted">{scopedAccount.environment || 'NA'}</span>
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-xs text-muted">
                      {scopedAccount.last_discovery ? new Date(scopedAccount.last_discovery).toLocaleDateString() : 'Never scanned'}
                    </div>
                    {posture && (
                      <div className={`mt-1 text-xs font-bold ${GRADE_TONE_TEXT[getGradeTone(posture.grade)]}`}>
                        Grade {posture.grade} · {posture.score}/100
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-2 py-12 text-center">
                  <Cloud className="h-6 w-6 text-subtle" />
                  <div className="text-base font-semibold text-fg">Account not found</div>
                </div>
              )}
            </CloudSection>

            <CloudSection title={(
              <span className="flex items-center gap-2">
                <Sparkles size={16} className="text-accent-text" />
                Recently Discovered Resources
              </span>
            )}
            >
              <div className="flex flex-col gap-2.5">
                {recentlyDiscovered.map((res) => (
                  <div
                    key={res.id}
                    onClick={() => navigate(`/cloud/resources/${res.id}`)}
                    className="flex cursor-pointer items-center justify-between rounded-card border border-border bg-sunken px-4 py-3 transition-all hover:border-accent hover:bg-raised hover:shadow-sm"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-[15px] font-semibold text-fg">{res.resource_name}</div>
                      <div className="mt-0.5 text-xs text-muted">{res.resource_type} · {res.region_or_zone}</div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2.5">
                      {res.cost_monthly != null ? (
                        <span className="text-xs font-bold text-success-fg">{Number(res.cost_monthly).toFixed(2)}/mo</span>
                      ) : (
                        <span className="text-xs font-semibold text-subtle">NA</span>
                      )}
                      <ArrowRight size={14} className="text-subtle" />
                    </div>
                  </div>
                ))}
                {recentlyDiscovered.length === 0 && (
                  <div className="flex flex-col items-center gap-2 py-12 text-center">
                    <Server className="h-6 w-6 text-subtle" />
                    <div className="text-base font-semibold text-fg">No resources yet</div>
                    <div className="text-sm text-muted">No resources discovered yet. Run a discovery scan first.</div>
                  </div>
                )}
              </div>
            </CloudSection>
          </div>
        </div>
      ))}

      {tab === 'resources' && <ResourcesPage embedded accountId={routeAccountId} />}
      {tab === 'cost' && <CostPage embedded accountId={routeAccountId} />}
      {tab === 'security' && <SecurityPosturePage embedded accountId={routeAccountId} />}
      {tab === 'topology' && <CloudTopologyPage embedded accountId={routeAccountId} />}
      {tab === 'compliance' && <CompliancePage embedded accountId={routeAccountId} />}
      {tab === 'alerts' && <AlertsPage embedded accountId={routeAccountId} />}
    </>
  );
};
