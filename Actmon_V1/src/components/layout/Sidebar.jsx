import React from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useUIStore } from '../../store/uiStore';
import { useAuthStore } from '../../store/authStore';
import {
  LayoutDashboard, Server, Database, Cloud, HardDrive, Brain, Bell, Users,
  Settings, LogOut, ChevronLeft, ChevronRight, Shield, MessageSquare, Circle,
} from 'lucide-react';
import { Avatar } from '@fluentui/react-components';

// module_icon (from DB) → lucide icon
const ICONS = {
  dashboard: LayoutDashboard, server: Server, database: Database, cloud: Cloud,
  desktop: HardDrive, brain: Brain, alert: Bell, shield: Shield, settings: Settings,
  chat: MessageSquare, users: Users,
};
const iconFor = (name) => ICONS[String(name || '').toLowerCase()] || Circle;

// Fallback (pre-login / menu not yet loaded) — replaced by the DB menu once available
const FALLBACK = [
  { name: 'Dashboard', route: '/dashboard', icon: 'dashboard' },
  { name: 'Agents', route: '/agents', icon: 'server' },
  { name: 'Databases', route: '/databases', icon: 'database' },
  { name: 'Administration', route: '/administration', icon: 'shield' },
  { name: 'Settings', route: '/settings', icon: 'settings' },
];

export const Sidebar = () => {
  const { sidebarOpen, toggleSidebar } = useUIStore();
  const { user, menu, clearToken } = useAuthStore();
  const navigate = useNavigate();

  const handleLogout = () => { clearToken(); navigate('/login'); };

  // RBAC: render the DB-driven menu (only modules the user can view); fall back when empty
  const items = (menu && menu.length)
    ? menu.map((m) => ({ name: m.name, route: m.route || (m.children?.[0]?.url) || '#', icon: m.icon }))
    : FALLBACK;

  return (
    <aside className={`bg-brand-sidebar text-white flex flex-col transition-all duration-300 select-none border-r border-brand-sidebar-hover ${sidebarOpen ? 'w-64' : 'w-20'}`}>
      {/* Header */}
      <div className="h-16 flex items-center justify-between px-4 border-b border-brand-sidebar-hover">
        {sidebarOpen ? (
          <div className="flex items-center gap-2 font-semibold text-lg text-white">
            <div className="bg-[#0078D4] p-1.5 rounded"><Shield className="h-5 w-5 text-white" /></div>
            <span>ActMon</span>
          </div>
        ) : (
          <div className="mx-auto bg-[#0078D4] p-1.5 rounded"><Shield className="h-5 w-5 text-white" /></div>
        )}
        <button onClick={toggleSidebar} className="text-gray-400 hover:text-white p-1 hover:bg-brand-sidebar-hover rounded transition-colors">
          {sidebarOpen ? <ChevronLeft className="h-5 w-5" /> : <ChevronRight className="h-5 w-5" />}
        </button>
      </div>

      {/* Dynamic nav */}
      <nav className="flex-1 py-4 space-y-1 overflow-y-auto px-2">
        {items.map((item) => {
          const Icon = iconFor(item.icon);
          return (
            <NavLink key={item.route + item.name} to={item.route}
              className={({ isActive }) =>
                `flex items-center gap-3 px-4 py-3 rounded-md transition-all text-sm font-medium ${
                  isActive ? 'bg-brand-sidebar-active text-[#0078D4] border-l-4 border-[#0078D4]'
                           : 'text-gray-300 hover:text-white hover:bg-brand-sidebar-hover border-l-4 border-transparent'}`}>
              {({ isActive }) => (
                <>
                  <Icon className={`h-5 w-5 flex-shrink-0 ${isActive ? 'text-[#0078D4]' : 'text-gray-400'}`} />
                  {sidebarOpen ? <span>{item.name}</span> : <span className="sr-only">{item.name}</span>}
                </>
              )}
            </NavLink>
          );
        })}
      </nav>

      {/* User footer */}
      <div className="p-4 border-t border-brand-sidebar-hover flex flex-col gap-3">
        <div className={`flex items-center gap-3 ${!sidebarOpen && 'justify-center'}`}>
          <Avatar name={user?.employee_name || user?.username || 'User'} color="brand" className="flex-shrink-0" />
          {sidebarOpen && (
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-white truncate">{user?.employee_name || user?.username || 'User'}</p>
              <p className="text-xs text-gray-400 truncate">{user?.role || user?.role_name || '—'}</p>
            </div>
          )}
        </div>
        <button onClick={handleLogout}
          className={`flex items-center gap-3 px-4 py-2 text-sm text-gray-300 hover:text-white hover:bg-[#A4262C] rounded-md transition-all ${sidebarOpen ? 'w-full justify-start' : 'w-full justify-center'}`}>
          <LogOut className="h-5 w-5 flex-shrink-0 text-gray-400" />
          {sidebarOpen && <span>Logout</span>}
        </button>
      </div>
    </aside>
  );
};
