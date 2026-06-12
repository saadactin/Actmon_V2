import React, { useState } from 'react';
import { useLocation, Link, useNavigate } from 'react-router-dom';
import { useNotifications } from '../../hooks/useNotifications';
import { useAuthStore } from '../../store/authStore';
import { Bell, LogOut, X, Check, CheckSquare, AlertTriangle, AlertCircle, Info } from 'lucide-react';
import { Avatar, Badge, Button, Popover, PopoverTrigger, PopoverSurface, Persona } from '@fluentui/react-components';
import { formatTimeAgo } from '../../utils/formatters';

export const TopBar = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, clearToken } = useAuthStore();
  const { notifications, unreadCount, markRead, markAllRead, isPending } = useNotifications();
  
  const [panelOpen, setPanelOpen] = useState(false);

  // Logout handler
  const handleLogout = () => {
    clearToken();
    navigate('/login');
  };

  // Breadcrumbs generation
  const pathnames = location.pathname.split('/').filter((x) => x);
  
  const getBreadcrumbLabel = (part) => {
    if (part.toLowerCase() === 'dashboard') return 'Dashboard';
    if (part.toLowerCase() === 'agents') return 'Agents';
    if (part.toLowerCase() === 'connections') return 'Databases';
    if (part.toLowerCase() === 'databases') return 'Databases';
    if (part.toLowerCase() === 'cloud') return 'Cloud';
    if (part.toLowerCase() === 'infra') return 'Infrastructure';
    if (part.toLowerCase() === 'ml') return 'ML / AI';
    if (part.toLowerCase() === 'alerts') return 'Alerts';
    if (part.toLowerCase() === 'users') return 'Users';
    if (part.toLowerCase() === 'settings') return 'Settings';
    return part;
  };

  const getSeverityIcon = (severity) => {
    switch (severity?.toLowerCase()) {
      case 'critical':
        return <AlertCircle className="h-5 w-5 text-[#A4262C]" />;
      case 'warning':
        return <AlertTriangle className="h-5 w-5 text-[#D83B01]" />;
      case 'info':
      default:
        return <Info className="h-5 w-5 text-[#0078D4]" />;
    }
  };

  return (
    <header className="h-16 bg-white border-b border-brand-border flex items-center justify-between px-6 z-10 sticky top-0">
      {/* Breadcrumbs */}
      <nav className="flex text-sm text-brand-text-secondary" aria-label="Breadcrumb">
        <ol className="inline-flex items-center space-x-1 md:space-x-2">
          <li className="inline-flex items-center">
            <Link to="/dashboard" className="hover:text-brand-primary font-medium">
              ActMon
            </Link>
          </li>
          {pathnames.map((value, index) => {
            const last = index === pathnames.length - 1;
            const to = `/${pathnames.slice(0, index + 1).join('/')}`;

            return (
              <li key={to} className="flex items-center">
                <span className="mx-1 text-gray-400">/</span>
                {last ? (
                  <span className="font-semibold text-brand-text-primary">
                    {getBreadcrumbLabel(value)}
                  </span>
                ) : (
                  <Link to={to} className="hover:text-brand-primary font-medium">
                    {getBreadcrumbLabel(value)}
                  </Link>
                )}
              </li>
            );
          })}
        </ol>
      </nav>

      {/* Action Controls */}
      <div className="flex items-center gap-4">
        {/* Notification Bell */}
        <div className="relative">
          <button
            onClick={() => setPanelOpen(true)}
            className="p-2 text-brand-text-secondary hover:text-brand-primary hover:bg-gray-100 rounded-full transition-all focus:outline-none"
            aria-label="Notifications"
          >
            <Bell className="h-5 w-5" />
            {unreadCount > 0 && (
              <span className="absolute top-1 right-1 flex h-4 w-4 items-center justify-center rounded-full bg-[#A4262C] text-[10px] font-bold text-white">
                {unreadCount}
              </span>
            )}
          </button>
        </div>

        {/* User Account Popover */}
        <Popover trapFocus>
          <PopoverTrigger disableButtonEnhancement>
            <button className="flex items-center focus:outline-none">
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
              <div className="flex flex-col gap-1">
                <p className="text-xs text-brand-text-secondary px-2">
                  Role: <span className="font-semibold">{user?.role || 'Admin'}</span>
                </p>
              </div>
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

      {/* Slide-out Notification Drawer / Panel */}
      {panelOpen && (
        <>
          {/* Backdrop Overlay */}
          <div
            className="fixed inset-0 bg-black/30 z-40 transition-opacity"
            onClick={() => setPanelOpen(false)}
          />

          {/* Panel Container */}
          <div className="fixed right-0 top-0 bottom-0 w-80 md:w-96 bg-white shadow-2xl z-50 flex flex-col border-l border-brand-border animate-in slide-in-from-right duration-200">
            {/* Panel Header */}
            <div className="p-4 border-b border-brand-border flex items-center justify-between bg-[#FAF9F8]">
              <div className="flex items-center gap-2">
                <Bell className="h-5 w-5 text-brand-primary" />
                <span className="font-semibold text-brand-text-primary">Notifications</span>
                {unreadCount > 0 && (
                  <Badge color="danger" size="small">
                    {unreadCount} new
                  </Badge>
                )}
              </div>
              <div className="flex items-center gap-1">
                {unreadCount > 0 && (
                  <button
                    onClick={markAllRead}
                    disabled={isPending}
                    title="Mark all as read"
                    className="p-1.5 text-gray-500 hover:text-brand-primary hover:bg-gray-150 rounded"
                  >
                    <CheckSquare className="h-4 w-4" />
                  </button>
                )}
                <button
                  onClick={() => setPanelOpen(false)}
                  className="p-1.5 text-gray-500 hover:text-gray-800 hover:bg-gray-200 rounded"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            {/* Notifications List */}
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {notifications.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-brand-text-secondary py-12">
                  <Bell className="h-10 w-10 text-gray-300 mb-2" />
                  <p className="text-sm font-medium">No notifications yet</p>
                  <p className="text-xs text-gray-400">Everything looks green.</p>
                </div>
              ) : (
                notifications.map((notif) => (
                  <div
                    key={notif.id}
                    className={`p-3 rounded-lg border transition-all flex gap-3 items-start ${
                      notif.is_read
                        ? 'bg-white border-brand-border opacity-75'
                        : 'bg-blue-50/55 border-blue-100 shadow-sm'
                    }`}
                  >
                    <div className="mt-0.5 flex-shrink-0">
                      {getSeverityIcon(notif.severity)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-brand-text-primary break-words leading-tight">
                        {notif.message}
                      </p>
                      <p className="text-xs text-brand-text-secondary mt-1" title={notif.timestamp}>
                        {formatTimeAgo(notif.timestamp)}
                      </p>
                    </div>
                    {!notif.is_read && (
                      <button
                        onClick={() => markRead([notif.id])}
                        disabled={isPending}
                        className="p-1 text-gray-400 hover:text-brand-primary hover:bg-white rounded border border-transparent hover:border-gray-200"
                        title="Mark read"
                      >
                        <Check className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </header>
  );
};
