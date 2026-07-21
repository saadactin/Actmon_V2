import React, { useState } from 'react';
import { useLocation, Link, useNavigate } from 'react-router-dom';
import { useNotifications } from '../../hooks/useNotifications';
import { useAuthStore } from '../../store/authStore';
import { Bell, BellRing, LogOut } from 'lucide-react';
import { Avatar } from '@fluentui/react-components';
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
  const [profileOpen, setProfileOpen] = useState(false);

  const handleLogout = () => { clearToken(); navigate('/'); };

  const displayName = user?.employee_name || user?.username || 'User';
  const initials = displayName.trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase() || 'U';
  const email = user?.email || `${user?.username || 'user'}@actmon.local`;
  const roleName = user?.role || user?.role_name || '—';

  const togglePopup = () => {
    setCenterOpen(false);
    setProfileOpen(false);
    setPopupOpen((v) => !v);
  };

  const toggleProfile = () => {
    setPopupOpen(false);
    setCenterOpen(false);
    setProfileOpen((v) => !v);
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
    <header className="h-12 bg-brand-topbar text-brand-topbar-text border-b border-brand-topbar-border flex items-center justify-end px-6 md:px-8 z-30 sticky top-0">

      {/* ── Right controls (slim bar — breadcrumb removed) ── */}
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

        {/* ── User account dropdown (custom — Fluent Popover crashed the app) ── */}
        <div className="relative">
          <button onClick={toggleProfile}
            className="flex items-center focus:outline-none focus:ring-2 focus:ring-slate-200 rounded-full">
            <Avatar name={user?.username || 'Admin'} color="brand" size={32}
              className="cursor-pointer hover:opacity-80 transition-opacity" />
          </button>

          {profileOpen && (
            <>
              {/* click-away */}
              <div className="fixed inset-0 z-40" onClick={() => setProfileOpen(false)} />
              {/* fancy card */}
              <div className="absolute right-0 top-full mt-2 w-[300px] bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden z-50">
                <div className="relative">
                  <div className="h-20" style={{ background: 'linear-gradient(135deg,#1e40af 0%,#3b82f6 55%,#0ea5e9 100%)' }} />
                  <div className="px-5">
                    <div className="-mt-9 w-16 h-16 rounded-2xl bg-white shadow-md border-4 border-white flex items-center justify-center">
                      <span className="text-lg font-black text-blue-700">{initials}</span>
                    </div>
                    <p className="mt-2 font-black text-slate-900 text-[15px] leading-tight truncate">{displayName}</p>
                    <p className="text-xs text-slate-400 truncate">{email}</p>
                  </div>
                </div>

                <div className="px-5 py-4 space-y-2.5">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wide">Organization</span>
                    <span className="text-xs font-semibold text-slate-700 truncate max-w-[160px] text-right">{user?.org_name || '—'}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wide">Role</span>
                    <span className="px-2.5 py-0.5 rounded-full bg-blue-50 text-blue-700 text-[11px] font-bold border border-blue-100 truncate max-w-[160px]">{roleName}</span>
                  </div>
                </div>

                <div className="px-4 pb-4">
                  <button onClick={handleLogout}
                    className="w-full flex items-center justify-center gap-2 h-10 rounded-xl bg-red-50 text-red-600 hover:bg-red-100 text-sm font-bold border border-red-100 transition-colors">
                    <LogOut className="h-4 w-4" /> Sign out
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
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
