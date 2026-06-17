import React, { useState } from 'react';
import { useLocation, Link, useNavigate } from 'react-router-dom';
import { useNotifications } from '../../hooks/useNotifications';
import { useAuthStore } from '../../store/authStore';
import { Bell, BellRing, LogOut } from 'lucide-react';
import { Avatar, Button, Popover, PopoverTrigger, PopoverSurface, Persona } from '@fluentui/react-components';
import NotificationPopup  from '../notifications/NotificationPopup';
import NotificationCenter from '../notifications/NotificationCenter';

export const TopBar = () => {
  const location  = useLocation();
  const navigate  = useNavigate();
  const { user, clearToken } = useAuthStore();

  const { notifications, unreadCount, markRead, markAllRead, isPending } = useNotifications();

  // popup  = mini dropdown  (bell click)
  // center = full side panel (popup "See all" click)
  const [popupOpen,  setPopupOpen]  = useState(false);
  const [centerOpen, setCenterOpen] = useState(false);

  const handleLogout = () => { clearToken(); navigate('/login'); };

  const togglePopup = () => {
    setCenterOpen(false);
    setPopupOpen((v) => !v);
  };

  const openCenter = () => {
    setPopupOpen(false);
    setCenterOpen(true);
  };

  const LABEL = {
    dashboard: 'Dashboard', agents: 'Agents', connections: 'Databases',
    databases: 'Databases', cloud: 'Cloud', infra: 'Infrastructure',
    ml: 'ML / AI', alerts: 'Alerts', users: 'Users', settings: 'Settings',
  };

  const pathnames = location.pathname.split('/').filter(Boolean);

  return (
    <header className="h-16 bg-white border-b border-brand-border flex items-center justify-between px-6 z-30 sticky top-0">

      {/* ── Breadcrumbs ── */}
      <nav className="flex text-sm text-brand-text-secondary" aria-label="Breadcrumb">
        <ol className="inline-flex items-center space-x-1 md:space-x-2">
          <li>
            <Link to="/dashboard" className="hover:text-brand-primary font-medium">ActMon</Link>
          </li>
          {pathnames.map((value, index) => {
            const last  = index === pathnames.length - 1;
            const to    = `/${pathnames.slice(0, index + 1).join('/')}`;
            const label = LABEL[value.toLowerCase()] || value;
            return (
              <li key={to} className="flex items-center">
                <span className="mx-1 text-gray-400">/</span>
                {last
                  ? <span className="font-semibold text-brand-text-primary">{label}</span>
                  : <Link to={to} className="hover:text-brand-primary font-medium">{label}</Link>
                }
              </li>
            );
          })}
        </ol>
      </nav>

      {/* ── Right controls ── */}
      <div className="flex items-center gap-3">

        {/* ── Bell + mini popup ── */}
        <div className="relative">
          <button
            onClick={togglePopup}
            className={`relative p-2 rounded-xl transition-colors focus:outline-none focus:ring-2 focus:ring-slate-200 ${
              popupOpen
                ? 'bg-slate-100 text-slate-800'
                : 'text-slate-500 hover:text-slate-800 hover:bg-slate-100'
            }`}
            aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ''}`}
          >
            {unreadCount > 0
              ? <BellRing className="h-5 w-5" style={{ animation: 'bellShake 1s ease-in-out' }} />
              : <Bell className="h-5 w-5" />
            }

            {/* Badge — drops to 0 the instant markRead() fires (optimistic update) */}
            {unreadCount > 0 && (
              <span className="absolute top-0.5 right-0.5 flex h-[18px] min-w-[18px] px-0.5 items-center justify-center rounded-full bg-red-500 text-[10px] font-bold text-white shadow-sm">
                {unreadCount > 99 ? '99+' : unreadCount}
              </span>
            )}
          </button>

          {/* Mini popup */}
          {popupOpen && (
            <NotificationPopup
              notifications={notifications}
              unreadCount={unreadCount}
              markRead={markRead}
              markAllRead={markAllRead}
              isPending={isPending}
              onClose={() => setPopupOpen(false)}
              onViewAll={openCenter}
            />
          )}
        </div>

        {/* ── User account popover ── */}
        <Popover trapFocus>
          <PopoverTrigger disableButtonEnhancement>
            <button className="flex items-center focus:outline-none focus:ring-2 focus:ring-slate-200 rounded-full">
              <Avatar
                name={user?.username || 'Admin'}
                color="brand"
                size={32}
                className="cursor-pointer hover:opacity-80 transition-opacity"
              />
            </button>
          </PopoverTrigger>
          <PopoverSurface className="w-64 p-4">
            <div className="flex flex-col gap-3">
              <Persona
                name={user?.username || 'admin'}
                secondaryText={user?.email || 'admin@actmon.local'}
                presence={{ status: 'available' }}
                avatar={{ color: 'brand' }}
              />
              <div className="border-t border-brand-border my-1" />
              <p className="text-xs text-brand-text-secondary px-2">
                Role: <span className="font-semibold">{user?.role || 'Admin'}</span>
              </p>
              <div className="border-t border-brand-border my-1" />
              <Button
                icon={<LogOut className="h-4 w-4" />}
                appearance="subtle"
                onClick={handleLogout}
                className="justify-start text-left text-brand-error hover:bg-red-50"
              >
                Sign out
              </Button>
            </div>
          </PopoverSurface>
        </Popover>
      </div>

      {/* ── Full notification side panel ── */}
      <NotificationCenter open={centerOpen} onClose={() => setCenterOpen(false)} />

      <style>{`
        @keyframes bellShake {
          0%,100% { transform: rotate(0); }
          12%      { transform: rotate(14deg); }
          24%      { transform: rotate(-12deg); }
          36%      { transform: rotate(9deg); }
          48%      { transform: rotate(-6deg); }
          60%      { transform: rotate(4deg); }
          72%      { transform: rotate(-2deg); }
          84%      { transform: rotate(0); }
        }
      `}</style>
    </header>
  );
};
