import React from 'react';
import { NavLink, Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  Cloud, RefreshCw, Plus, LayoutDashboard, Server, DollarSign,
  ShieldAlert, Share2, ClipboardCheck, Bell, Filter, X,
} from 'lucide-react';
import { useCloudAccounts } from '../hooks/useCloudAccounts';
import { useAllResources } from '../hooks/useResources';
import { useTriggerAllDiscovery } from '../hooks/useDiscovery';
import { useCloudStore } from '../state/cloudStore';
import { useCloudScope } from '../hooks/useCloudScope';
import { keyFromSlug, providerKeyOf } from '../utils/providerScope';
import { DrawerPanel } from '../../../components/ui/DrawerPanel';
import { AddCloudAccountForm } from './AddCloudAccountForm';
import { DiscoveryWatcher } from './DiscoveryWatcher';
import { usePermissions } from '../../../hooks/usePermissions';

const TABS = [
  { to: '/cloud', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/cloud/accounts', label: 'Accounts', icon: Cloud },
  { to: '/cloud/resources', label: 'Resources', icon: Server },
  { to: '/cloud/cost', label: 'Cost', icon: DollarSign },
  { to: '/cloud/security', label: 'Security', icon: ShieldAlert },
  { to: '/cloud/topology', label: 'Topology', icon: Share2 },
  { to: '/cloud/compliance', label: 'Compliance', icon: ClipboardCheck },
  { to: '/cloud/alerts', label: 'Alerts', icon: Bell },
];

// Routes with their own full-page hero (Choose Provider, Provider's Accounts) —
// the shell's dashboard-style header/tab bar would just duplicate/clash with these.
const LITERAL_ROUTES = new Set(['accounts', 'resources', 'cost', 'security', 'topology', 'compliance', 'alerts']);

const useHideChrome = () => {
  const { pathname } = useLocation();
  const segments = pathname.replace(/^\/cloud\/?/, '').split('/').filter(Boolean);
  const isProviderChooser = segments.length === 0;
  const isProviderAccountsList = segments.length === 1 && !LITERAL_ROUTES.has(segments[0]);
  return isProviderChooser || isProviderAccountsList;
};

/**
 * Mirror the provider/account in the URL into the persisted scope.
 *
 * The tab bar links to flat routes (/cloud/cost, /cloud/resources, …) which carry
 * no provider segment, so without this the scope would be lost the moment you
 * left the account dashboard. Landing on /cloud (the chooser) clears the scope,
 * which is what makes "All providers" the natural reset.
 */
const useSyncScopeFromUrl = () => {
  const { pathname } = useLocation();
  const { provider: providerSlug, accountId: routeAccountId } = useParams();
  const setProviderScope = useCloudStore((s) => s.setScopeProviderKey);
  const setAccountScope = useCloudStore((s) => s.setSelectedAccountId);
  const clearScope = useCloudStore((s) => s.clearScope);

  React.useEffect(() => {
    // Provider chooser is the "everything" view — drop any previous scope.
    if (pathname.replace(/\/+$/, '') === '/cloud') {
      clearScope();
      return;
    }
    const key = keyFromSlug(providerSlug);
    if (key) setProviderScope(key);
    if (routeAccountId) setAccountScope(routeAccountId);
  }, [pathname, providerSlug, routeAccountId, setProviderScope, setAccountScope, clearScope]);
};

export const CloudShell: React.FC = () => {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data: accounts } = useCloudAccounts();
  const { data: resources } = useAllResources();
  const isDrawerOpen = useCloudStore((s) => s.isAddAccountDrawerOpen);
  const setDrawerOpen = useCloudStore((s) => s.setAddAccountDrawerOpen);
  const activeJobCount = useCloudStore((s) => Object.keys(s.activeDiscoveryJobs).length);
  const { mutate: scanAll, isPending: scanAllPending } = useTriggerAllDiscovery();
  const { canHere } = usePermissions();
  const canAdd = canHere('add');
  const canScan = canHere('execute');
  const hideChrome = useHideChrome();
  const { accountId: routeAccountId } = useParams();
  useSyncScopeFromUrl();
  const scope = useCloudScope();

  const isAccountScoped = !!routeAccountId;
  const scopedAccount = isAccountScoped ? (accounts || []).find((a: any) => a.id === routeAccountId) : null;

  // Counts follow the scope: inside a provider, only that provider's accounts and
  // resources are counted, so the header never contradicts the tab content.
  const accountCount = scope.isScoped ? scope.scopedAccounts.length : (accounts?.length ?? 0);
  const resourceCount = isAccountScoped
    ? (resources || []).filter((r: any) => r.account_id === routeAccountId).length
    : scope.filterByScope(resources as any[]).length;
  const providers = Array.from(
    new Set((scope.isScoped ? scope.scopedAccounts : accounts || []).map((a: any) => providerKeyOf(a.provider))),
  );
  const scanning = scanAllPending || activeJobCount > 0;

  return (
    <div className="-mx-6 md:-mx-8 min-h-full bg-[#f1f5f9] flex flex-col">
      {/* Always-on watcher: live resource refresh + completion toasts on every page */}
      <DiscoveryWatcher />

      {/* ─── TOP HEADER ─── */}
      {!hideChrome && (
      <div className="text-white shadow-xl"
        style={{ background: 'linear-gradient(135deg,#0f172a 0%,#1e40af 52%,#0369a1 100%)' }}>
        <div className="px-6 py-4 flex flex-wrap justify-between items-center gap-3">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-2xl flex items-center justify-center"
              style={{ background: 'rgba(56,189,248,0.18)', border: '1px solid rgba(56,189,248,0.45)' }}>
              <Cloud size={24} className="text-sky-200" />
            </div>
            <div>
              <h1 className="text-2xl font-black tracking-tight flex items-center gap-2.5 flex-wrap">
                {isAccountScoped
                  ? (scopedAccount?.account_name || 'Account')
                  : scope.isScoped ? `${scope.providerKey} Cloud` : 'Cloud Dashboard'}
                {/* Active scope chip — makes it obvious every tab is filtered, and
                    gives a one-click way back to the all-providers view. */}
                {scope.isScoped && (
                  <button
                    onClick={() => { scope.clearScope(); navigate('/cloud'); }}
                    title="Showing one provider — click to view all providers"
                    className="group flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold transition-all"
                    style={{ background: 'rgba(56,189,248,0.18)', border: '1px solid rgba(56,189,248,0.45)' }}>
                    <Filter size={11} className="text-sky-200" />
                    <span className="text-sky-100">{scope.providerKey} only</span>
                    <X size={11} className="text-sky-300 group-hover:text-white" />
                  </button>
                )}
              </h1>
              <p className="text-sky-300 text-sm mt-0.5">
                {isAccountScoped
                  ? `${scopedAccount?.provider || routeAccountId} · ${scopedAccount?.tenant_or_region || scopedAccount?.environment || ''}`
                  : (
                    <>
                      {scope.isScoped ? `${scope.providerKey} Discovery` : 'Multi-Cloud Discovery'}
                      {accountCount > 0 && ` — ${accountCount} account${accountCount > 1 ? 's' : ''}`}
                      {providers.length > 0 && ` · ${providers.join(', ')}`}
                    </>
                  )}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {/* summary badges */}
            <span className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold"
              style={{ background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)' }}>
              <Server size={13} className="text-sky-300" /> {resourceCount} Resources
            </span>
            {canAdd && (
              <button onClick={() => setDrawerOpen(true)}
                className="flex items-center gap-2 px-4 py-1.5 rounded-lg text-sm font-bold bg-white text-blue-700 hover:bg-sky-50 transition-all shadow-sm">
                <Plus size={15} /> Add Account
              </button>
            )}
            {!isAccountScoped && canScan && accountCount > 0 && (
              <button onClick={() => scanAll()} disabled={scanning}
                className="flex items-center gap-2 px-4 py-1.5 rounded-lg text-sm font-bold bg-sky-400 text-slate-900 hover:bg-sky-300 transition-all shadow-sm disabled:opacity-60 disabled:cursor-not-allowed">
                <RefreshCw size={14} className={scanning ? 'animate-spin' : ''} />
                {scanning ? `Scanning${activeJobCount > 0 ? ` · ${activeJobCount}` : ''}…` : 'Scan All Accounts'}
              </button>
            )}
            <button onClick={() => qc.invalidateQueries()}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-semibold transition-all"
              style={{ background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)' }}>
              <RefreshCw size={13} /> Refresh
            </button>
          </div>
        </div>

        {/* ─── TAB BAR ─── */}
        <div className="px-4 pt-2 flex gap-0.5 overflow-x-auto border-t border-white/10">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            return (
              <NavLink key={tab.to} to={tab.to} end={tab.end}
                className={({ isActive }) =>
                  `relative flex items-center gap-2 px-4 py-2.5 text-xs font-semibold rounded-t-lg whitespace-nowrap transition-all ${
                    isActive ? 'bg-[#f1f5f9] text-blue-700' : 'text-white/60 hover:text-white hover:bg-white/10'
                  }`
                }>
                <Icon size={13} />
                {tab.label}
              </NavLink>
            );
          })}
        </div>
      </div>
      )}

      {/* ─── PAGE CONTENT ─── */}
      <div className="flex-1 overflow-auto">
        <Outlet />
      </div>

      {/* ─── Add Cloud Account drawer (global — works from any cloud tab; add-gated) ─── */}
      <DrawerPanel open={isDrawerOpen && canAdd} onClose={() => setDrawerOpen(false)} title="Connect a Cloud Provider">
        <AddCloudAccountForm onSuccess={() => setDrawerOpen(false)} />
      </DrawerPanel>
    </div>
  );
};
