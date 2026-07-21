import React, { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useUIStore } from '../../store/uiStore';
import { useAuthStore } from '../../store/authStore';
import { useSettingsStore } from '../../store/settingsStore';
import {
  LayoutDashboard, Server, Database, Cloud, HardDrive, Brain, Bell, Users,
  Settings, LogOut, ChevronLeft, ChevronRight, Shield, MessageSquare, Circle, ScrollText, Briefcase,
} from 'lucide-react';
import { Avatar } from '@fluentui/react-components';

// module_icon (from DB) → lucide icon
const ICONS = {
  dashboard: LayoutDashboard, server: Server, database: Database, cloud: Cloud,
  desktop: HardDrive, brain: Brain, alert: Bell, shield: Shield, settings: Settings,
  chat: MessageSquare, users: Users, logs: ScrollText, sales: Briefcase,
};
const iconFor = (name) => ICONS[String(name || '').toLowerCase()] || Circle;

// Fallback (pre-login / menu not yet loaded) — replaced by the DB menu once available
const FALLBACK = [
  { name: 'Dashboard', route: '/dashboard', icon: 'dashboard' },
  { name: 'Agents', route: '/agents', icon: 'server' },
  { name: 'Databases', route: '/databases', icon: 'database' },
  { name: 'Cloud', route: '/cloud', icon: 'cloud' },
  { name: 'Administration', route: '/administration', icon: 'shield' },
  { name: 'Settings', route: '/settings', icon: 'settings' },
];

export const Sidebar = () => {
  const { sidebarOpen, toggleSidebar } = useUIStore();
  const { user, menu, clearToken } = useAuthStore();
  const sidebarLabels = useSettingsStore((s) => s.sidebarLabels);
  const navigate = useNavigate();
  // "Hide menu names" setting collapses the sidebar to icon-only.
  const open = sidebarOpen && sidebarLabels;

  const handleLogout = () => { clearToken(); navigate('/'); };

  const [profileOpen, setProfileOpen] = useState(false);
  const displayName = user?.employee_name || user?.username || 'User';
  const initials = displayName.trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase() || 'U';
  const email = user?.email || `${user?.username || 'user'}@actmon.local`;
  const roleName = user?.role || user?.role_name || '—';
  const orgName = user?.org_name || '—';

  // RBAC: render the DB-driven menu (only modules the user can view); fall back when empty
  const baseItems = (menu && menu.length)
    ? menu.map((m) => ({ name: m.name, route: m.route || (m.children?.[0]?.url) || '#', icon: m.icon }))
    : FALLBACK;
  // ensure the Logs page is reachable even before it's registered in the DB menu
  const items = baseItems.some((i) => i.route === '/logs')
    ? baseItems
    : [...baseItems, { name: 'Logs', route: '/logs', icon: 'logs' }];

  return (
    <aside className={`bg-brand-sidebar text-white flex flex-col transition-all duration-300 select-none border-r border-brand-sidebar-hover ${open ? 'w-64' : 'w-20'}`}>
      {/* Header */}
      <div className="h-16 flex items-center justify-between px-4 border-b border-brand-sidebar-hover">
        {open ? (
          <div className="flex items-center gap-2 font-semibold text-lg text-white">
            <div className="bg-brand-primary p-1.5 rounded"><Shield className="h-5 w-5 text-white" /></div>
            <span>ActMon</span>
          </div>
        ) : (
          <div className="mx-auto bg-brand-primary p-1.5 rounded"><Shield className="h-5 w-5 text-white" /></div>
        )}
        {sidebarLabels && (
          <button onClick={toggleSidebar} className="text-gray-400 hover:text-white p-1 hover:bg-brand-sidebar-hover rounded transition-colors">
            {open ? <ChevronLeft className="h-5 w-5" /> : <ChevronRight className="h-5 w-5" />}
          </button>
        )}
      </div>

      {/* Dynamic nav */}
      <nav className="flex-1 py-4 space-y-1 overflow-y-auto px-2">
        {items.map((item) => {
          const Icon = iconFor(item.icon);
          return (
            <NavLink key={item.route + item.name} to={item.route}
              className={({ isActive }) =>
                `flex items-center gap-3 px-4 py-3 rounded-md transition-all text-sm font-medium ${
                  isActive ? 'bg-brand-sidebar-active text-brand-primary border-l-4 border-brand-primary'
                           : 'text-gray-300 hover:text-white hover:bg-brand-sidebar-hover border-l-4 border-transparent'}`}>
              {({ isActive }) => (
                <>
                  <Icon className={`h-5 w-5 flex-shrink-0 ${isActive ? 'text-brand-primary' : 'text-gray-400'}`} />
                  {open ? <span>{item.name}</span> : <span className="sr-only">{item.name}</span>}
                </>
              )}
            </NavLink>
          );
        })}
      </nav>

      {/* User footer — click to open the profile card */}
      <div className="p-4 border-t border-brand-sidebar-hover">
        <button onClick={() => setProfileOpen((v) => !v)}
          className={`w-full flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-brand-sidebar-hover transition-colors ${!open && 'justify-center'}`}
          title="Account">
          <Avatar name={displayName} color="brand" className="flex-shrink-0" />
          {open && (
            <div className="min-w-0 flex-1 text-left">
              <p className="text-sm font-medium text-white truncate">{displayName}</p>
              <p className="text-xs text-gray-400 truncate">{roleName}</p>
            </div>
          )}
        </button>
      </div>

      {/* ── Profile card popup (same as old top-bar card) ── */}
      {profileOpen && (
        <>
          <div className="fixed inset-0 z-[55]" onClick={() => setProfileOpen(false)} />
          <div className="fixed bottom-4 left-4 w-64 bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden z-[60]">
            <div className="h-16" style={{ background: 'linear-gradient(135deg,#1e40af 0%,#3b82f6 55%,#0ea5e9 100%)' }} />
            <div className="px-4">
              <div className="-mt-7 w-14 h-14 rounded-2xl bg-white shadow border-4 border-white flex items-center justify-center">
                <span className="text-base font-black text-blue-700">{initials}</span>
              </div>
              <p className="mt-1.5 font-black text-slate-900 text-sm leading-tight truncate">{displayName}</p>
              <p className="text-[11px] text-slate-400 truncate">{email}</p>
            </div>
            <div className="px-4 py-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wide">Organization</span>
                <span className="text-[11px] font-semibold text-slate-700 truncate max-w-[140px] text-right">{orgName}</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wide">Role</span>
                <span className="px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 text-[10px] font-bold border border-blue-100 truncate max-w-[140px]">{roleName}</span>
              </div>
            </div>
            <div className="px-3 pb-3">
              <button onClick={handleLogout}
                className="w-full flex items-center justify-center gap-2 h-9 rounded-xl bg-red-50 text-red-600 hover:bg-red-100 text-sm font-bold border border-red-100 transition-colors">
                <LogOut className="h-4 w-4" /> Sign out
              </button>
            </div>
          </div>
        </>
      )}
    </aside>
  );
};
