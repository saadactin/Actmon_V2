import React from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  Cloud, RefreshCw, Plus, LayoutDashboard, Server, DollarSign,
  ShieldAlert, Share2, ClipboardCheck, Bell,
} from 'lucide-react';
import { useCloudAccounts } from '../hooks/useCloudAccounts';
import { useAllResources } from '../hooks/useResources';
import { useTriggerAllDiscovery } from '../hooks/useDiscovery';
import { useCloudStore } from '../state/cloudStore';
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

export const CloudShell: React.FC = () => {
  const qc = useQueryClient();
  const { data: accounts } = useCloudAccounts();
  const { data: resources } = useAllResources();
  const isDrawerOpen = useCloudStore((s) => s.isAddAccountDrawerOpen);
  const setDrawerOpen = useCloudStore((s) => s.setAddAccountDrawerOpen);
  const activeJobCount = useCloudStore((s) => Object.keys(s.activeDiscoveryJobs).length);
  const { mutate: scanAll, isPending: scanAllPending } = useTriggerAllDiscovery();
  const { canHere } = usePermissions();
  const canAdd = canHere('add');
  const canScan = canHere('execute');

  const accountCount = accounts?.length ?? 0;
  const resourceCount = resources?.length ?? 0;
  const providers = Array.from(new Set((accounts || []).map((a: any) => a.provider)));
  const scanning = scanAllPending || activeJobCount > 0;

  return (
    <div className="-mx-6 md:-mx-8 min-h-full bg-[#f1f5f9] flex flex-col">
      {/* Always-on watcher: live resource refresh + completion toasts on every page */}
      <DiscoveryWatcher />

      {/* ─── TOP HEADER ─── */}
      <div className="text-white shadow-xl"
        style={{ background: 'linear-gradient(135deg,#0f172a 0%,#1e40af 52%,#0369a1 100%)' }}>
        <div className="px-6 py-4 flex flex-wrap justify-between items-center gap-3">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-2xl flex items-center justify-center"
              style={{ background: 'rgba(56,189,248,0.18)', border: '1px solid rgba(56,189,248,0.45)' }}>
              <Cloud size={24} className="text-sky-200" />
            </div>
            <div>
              <h1 className="text-2xl font-black tracking-tight">Cloud Dashboard</h1>
              <p className="text-sky-300 text-sm mt-0.5">
                Multi-Cloud Discovery
                {accountCount > 0 && ` — ${accountCount} account${accountCount > 1 ? 's' : ''}`}
                {providers.length > 0 && ` · ${providers.join(', ')}`}
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
            {canScan && accountCount > 0 && (
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
