import React, { useState, useMemo, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Bell, BellRing, X, CheckSquare, Search, AlertCircle, AlertTriangle,
  Info, ExternalLink, Clock, Check, Filter,
} from 'lucide-react';
import { useNotifications } from '../../hooks/useNotifications';
import { formatTimeAgo } from '../../utils/formatters';

// ─── Severity config ──────────────────────────────────────────────────────────
const SEV = {
  critical: {
    Icon: AlertCircle,
    color:  'text-red-600',
    bg:     'bg-red-50',
    border: 'border-red-200',
    strip:  'bg-gradient-to-b from-red-500 to-red-600',
    badge:  'bg-red-100 text-red-700',
    dot:    'bg-red-500',
    ring:   'ring-red-200',
    label:  'Critical',
    glow:   'shadow-red-100',
  },
  warning: {
    Icon: AlertTriangle,
    color:  'text-amber-500',
    bg:     'bg-amber-50',
    border: 'border-amber-200',
    strip:  'bg-gradient-to-b from-amber-400 to-orange-500',
    badge:  'bg-amber-100 text-amber-700',
    dot:    'bg-amber-400',
    ring:   'ring-amber-200',
    label:  'Warning',
    glow:   'shadow-amber-100',
  },
  info: {
    Icon: Info,
    color:  'text-blue-500',
    bg:     'bg-blue-50',
    border: 'border-blue-200',
    strip:  'bg-gradient-to-b from-blue-400 to-blue-600',
    badge:  'bg-blue-100 text-blue-700',
    dot:    'bg-blue-400',
    ring:   'ring-blue-200',
    label:  'Info',
    glow:   'shadow-blue-100',
  },
};

function getSev(severity) {
  return SEV[(severity || 'info').toLowerCase()] || SEV.info;
}

// ─── Navigation path resolver ─────────────────────────────────────────────────
function getNavPath(notif) {
  const agent = notif.agent_name;
  if (!agent) return null;
  const msg = (notif.message || '').toLowerCase();
  if (msg.includes('slow quer'))                       return `/agents/${agent}?tab=sql`;
  if (msg.includes('error log') || msg.includes('error rate')) return `/agents/${agent}?tab=errors`;
  return `/agents/${agent}`;
}

// ─── Date grouping ────────────────────────────────────────────────────────────
function groupByDate(list) {
  const todayStr     = new Date().toDateString();
  const yesterStr    = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return d.toDateString(); })();
  const groups       = { Today: [], Yesterday: [], Earlier: [] };

  list.forEach(n => {
    const d = new Date(n.created_at || n.timestamp || 0);
    const ds = d.toDateString();
    if (ds === todayStr)  groups.Today.push(n);
    else if (ds === yesterStr) groups.Yesterday.push(n);
    else groups.Earlier.push(n);
  });

  return groups;
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function NotificationCenter({ open, onClose }) {
  const navigate  = useNavigate();
  const { notifications, unreadCount, markRead, markAllRead, isPending, isLoading } = useNotifications(100);
  const [tab, setTab]       = useState('all');
  const [search, setSearch] = useState('');
  const searchRef           = useRef(null);

  // Focus search when panel opens
  useEffect(() => {
    if (open) { setTimeout(() => searchRef.current?.focus(), 250); }
    else { setSearch(''); setTab('all'); }
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);

  const filtered = useMemo(() => {
    let list = [...notifications];
    if (tab === 'unread')     list = list.filter(n => !n.is_read);
    else if (tab !== 'all')   list = list.filter(n => (n.severity || 'info').toLowerCase() === tab);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(n =>
        (n.message    || '').toLowerCase().includes(q) ||
        (n.agent_name || '').toLowerCase().includes(q)
      );
    }
    return list;
  }, [notifications, tab, search]);

  const counts = useMemo(() => ({
    all:      notifications.length,
    critical: notifications.filter(n => n.severity?.toLowerCase() === 'critical').length,
    warning:  notifications.filter(n => n.severity?.toLowerCase() === 'warning').length,
    info:     notifications.filter(n => n.severity?.toLowerCase() === 'info').length,
    unread:   unreadCount,
  }), [notifications, unreadCount]);

  const grouped = useMemo(() => groupByDate(filtered), [filtered]);

  const handleClick = (notif) => {
    if (!notif.is_read) markRead([notif.id]);
    const path = getNavPath(notif);
    if (path) { onClose(); navigate(path); }
  };

  if (!open) return null;

  const TABS = [
    { key: 'all',      label: 'All' },
    { key: 'critical', label: 'Critical' },
    { key: 'warning',  label: 'Warning' },
    { key: 'info',     label: 'Info' },
    { key: 'unread',   label: 'Unread' },
  ];

  return (
    <>
      {/* ── Backdrop ── */}
      <div
        className="fixed inset-0 bg-black/40 backdrop-blur-[2px] z-40"
        style={{ animation: 'fadeIn 0.2s ease-out' }}
        onClick={onClose}
      />

      {/* ── Panel ── */}
      <div
        className="fixed right-0 top-0 bottom-0 w-[480px] bg-white z-50 flex flex-col shadow-[−8px_0_40px_rgba(0,0,0,0.18)]"
        style={{ animation: 'slideInRight 0.25s cubic-bezier(0.16,1,0.3,1)' }}
      >

        {/* ─── Header ──────────────────────────────────────────────────────── */}
        <div className="flex-shrink-0 bg-gradient-to-br from-slate-800 via-slate-800 to-slate-900 px-5 pt-5 pb-4">
          {/* Title row */}
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <div className="relative">
                <div className="h-11 w-11 rounded-2xl bg-white/10 border border-white/10 flex items-center justify-center">
                  {unreadCount > 0
                    ? <BellRing className="h-5 w-5 text-white" style={{ animation: 'ringBell 2s ease-in-out 1' }} />
                    : <Bell className="h-5 w-5 text-white/80" />
                  }
                </div>
                {unreadCount > 0 && (
                  <span className="absolute -top-1.5 -right-1.5 h-5 min-w-5 px-1 flex items-center justify-center rounded-full bg-red-500 text-[10px] font-bold text-white shadow-lg shadow-red-900/40">
                    {unreadCount > 99 ? '99+' : unreadCount}
                  </span>
                )}
              </div>
              <div>
                <h2 className="text-base font-semibold text-white leading-tight">Notification Center</h2>
                <p className="text-[11px] text-slate-400 mt-0.5">
                  {unreadCount > 0 ? `${unreadCount} unread · ` : ''}{notifications.length} total
                </p>
              </div>
            </div>

            <div className="flex items-center gap-1">
              {unreadCount > 0 && (
                <button
                  onClick={markAllRead}
                  disabled={isPending}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-300 hover:text-white hover:bg-white/10 rounded-lg transition-colors disabled:opacity-50"
                >
                  <CheckSquare className="h-3.5 w-3.5" />
                  Mark all read
                </button>
              )}
              <button
                onClick={onClose}
                className="h-8 w-8 flex items-center justify-center text-slate-400 hover:text-white hover:bg-white/10 rounded-lg transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400 pointer-events-none" />
            <input
              ref={searchRef}
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search by agent, message…"
              className="w-full pl-9 pr-9 py-2 bg-white/10 border border-white/10 rounded-xl text-sm text-white placeholder-slate-500 focus:outline-none focus:border-white/25 focus:bg-white/15 transition-all"
            />
            {search && (
              <button
                onClick={() => setSearch('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* ─── Tab bar ─────────────────────────────────────────────────────── */}
        <div className="flex-shrink-0 flex items-center gap-1 px-3 py-2.5 bg-slate-50 border-b border-slate-100 overflow-x-auto scrollbar-none">
          {TABS.map(t => {
            const count  = counts[t.key];
            const active = tab === t.key;
            const sev    = ['critical','warning','info'].includes(t.key) ? getSev(t.key) : null;
            return (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all ${
                  active
                    ? 'bg-slate-800 text-white shadow-sm'
                    : 'text-slate-500 hover:text-slate-700 hover:bg-slate-200/70'
                }`}
              >
                {sev && (
                  <span className={`h-1.5 w-1.5 rounded-full ${active ? 'bg-white/70' : sev.dot}`} />
                )}
                {t.label}
                {count > 0 && (
                  <span className={`ml-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-semibold ${
                    active
                      ? 'bg-white/20 text-white'
                      : t.key === 'unread'
                        ? 'bg-red-100 text-red-600'
                        : t.key === 'critical'
                          ? 'bg-red-100 text-red-600'
                          : t.key === 'warning'
                            ? 'bg-amber-100 text-amber-600'
                            : 'bg-slate-200 text-slate-500'
                  }`}>
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* ─── Notification list ────────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto">
          {isLoading ? (
            <LoadingSkeleton />
          ) : filtered.length === 0 ? (
            <EmptyState tab={tab} search={search} />
          ) : (
            <div className="pb-2">
              {Object.entries(grouped).map(([group, items]) => {
                if (!items.length) return null;
                return (
                  <div key={group}>
                    {/* Group label */}
                    <div className="flex items-center gap-2 px-4 py-2 mt-1">
                      <Clock className="h-3 w-3 text-slate-400 flex-shrink-0" />
                      <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400">{group}</span>
                      <div className="flex-1 h-px bg-gradient-to-r from-slate-200 to-transparent" />
                    </div>

                    {/* Cards */}
                    <div className="space-y-1.5 px-3">
                      {items.map(notif => (
                        <NotifCard
                          key={notif.id}
                          notif={notif}
                          onClick={() => handleClick(notif)}
                          onMarkRead={(e) => { e.stopPropagation(); markRead([notif.id]); }}
                          isPending={isPending}
                        />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* ─── Footer ──────────────────────────────────────────────────────── */}
        <div className="flex-shrink-0 px-5 py-2.5 border-t border-slate-100 bg-slate-50/80 flex items-center justify-between">
          <span className="text-[11px] text-slate-400">Refreshes every 30 s</span>
          <div className="flex items-center gap-1.5">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
            </span>
            <span className="text-[11px] text-slate-500 font-medium">Live</span>
          </div>
        </div>
      </div>

      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
        @keyframes slideInRight {
          from { transform: translateX(100%); }
          to   { transform: translateX(0); }
        }
        @keyframes ringBell {
          0%,100% { transform: rotate(0); }
          10%      { transform: rotate(14deg); }
          20%      { transform: rotate(-12deg); }
          30%      { transform: rotate(10deg); }
          40%      { transform: rotate(-8deg); }
          50%      { transform: rotate(6deg); }
          60%      { transform: rotate(-4deg); }
          70%      { transform: rotate(2deg); }
          80%      { transform: rotate(0); }
        }
        .scrollbar-none { scrollbar-width: none; }
        .scrollbar-none::-webkit-scrollbar { display: none; }
      `}</style>
    </>
  );
}

// ─── Notification card ────────────────────────────────────────────────────────
function NotifCard({ notif, onClick, onMarkRead, isPending }) {
  const sev    = getSev(notif.severity);
  const { Icon } = sev;
  const path   = getNavPath(notif);
  const isRead = notif.is_read;

  return (
    <div
      onClick={onClick}
      className={`group relative flex overflow-hidden rounded-xl border cursor-pointer transition-all duration-150 ${
        isRead
          ? 'bg-white border-slate-100 hover:border-slate-200 hover:shadow-sm'
          : `${sev.bg} ${sev.border} hover:shadow-lg ${sev.glow}`
      }`}
    >
      {/* Left severity strip */}
      <div className={`w-1 flex-shrink-0 self-stretch ${sev.strip}`} />

      {/* Body */}
      <div className="flex-1 px-3.5 py-3 min-w-0">
        <div className="flex items-start gap-2.5">

          {/* Icon bubble */}
          <div className={`mt-0.5 flex-shrink-0 h-8 w-8 rounded-xl flex items-center justify-center border ${
            isRead ? 'bg-slate-50 border-slate-100' : `${sev.bg} ${sev.border}`
          }`}>
            <Icon className={`h-4 w-4 ${isRead ? 'text-slate-400' : sev.color}`} />
          </div>

          <div className="flex-1 min-w-0">
            {/* Badges row */}
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-1.5 flex-wrap">
                {notif.agent_name && (
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-slate-800 text-white">
                    {notif.agent_name}
                  </span>
                )}
                <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium ${sev.badge}`}>
                  {sev.label}
                </span>
              </div>
              {/* Unread indicator */}
              {!isRead && (
                <span className={`flex-shrink-0 h-2 w-2 rounded-full ${sev.dot} shadow-sm`} />
              )}
            </div>

            {/* Message */}
            <p className={`text-sm leading-relaxed break-words ${
              isRead ? 'text-slate-400' : 'text-slate-700 font-medium'
            }`}>
              {notif.message}
            </p>

            {/* Footer: time + actions */}
            <div className="flex items-center justify-between mt-2">
              <span className="text-[11px] text-slate-400">
                {formatTimeAgo(notif.created_at || notif.timestamp)}
              </span>

              {/* Hover actions */}
              <div className="flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity duration-150">
                {!isRead && (
                  <button
                    onClick={onMarkRead}
                    disabled={isPending}
                    className="flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-medium text-slate-500 bg-white hover:bg-slate-100 border border-slate-200 hover:border-slate-300 transition-colors disabled:opacity-50"
                  >
                    <Check className="h-2.5 w-2.5" />
                    Read
                  </button>
                )}
                {path && (
                  <span className="flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-medium text-blue-600 bg-blue-50 border border-blue-100">
                    <ExternalLink className="h-2.5 w-2.5" />
                    View
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Loading skeleton ─────────────────────────────────────────────────────────
function LoadingSkeleton() {
  return (
    <div className="p-4 space-y-3">
      {[...Array(5)].map((_, i) => (
        <div key={i} className="flex gap-3 p-3 rounded-xl border border-slate-100 overflow-hidden">
          <div className="w-1 flex-shrink-0 bg-slate-100 rounded" />
          <div className="h-8 w-8 bg-slate-100 rounded-xl flex-shrink-0 animate-pulse" />
          <div className="flex-1 space-y-2">
            <div className="flex gap-2">
              <div className="h-4 w-20 bg-slate-100 rounded-full animate-pulse" />
              <div className="h-4 w-14 bg-slate-100 rounded-full animate-pulse" />
            </div>
            <div className="h-3.5 w-full bg-slate-100 rounded animate-pulse" />
            <div className="h-3.5 w-4/5 bg-slate-100 rounded animate-pulse" />
            <div className="h-3 w-16 bg-slate-100 rounded animate-pulse" />
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────
function EmptyState({ tab, search }) {
  if (search) {
    return (
      <div className="flex flex-col items-center justify-center h-full py-20 text-center px-10">
        <div className="h-14 w-14 rounded-2xl bg-slate-100 flex items-center justify-center mb-3">
          <Search className="h-6 w-6 text-slate-400" />
        </div>
        <p className="text-sm font-semibold text-slate-600">No results for "{search}"</p>
        <p className="text-xs text-slate-400 mt-1">Try a different search term</p>
      </div>
    );
  }

  const MAP = {
    all:      { Icon: Bell,          title: 'No notifications yet',   sub: 'Everything is running smoothly.' },
    critical: { Icon: AlertCircle,   title: 'No critical alerts',     sub: 'No critical issues detected.' },
    warning:  { Icon: AlertTriangle, title: 'No warnings',            sub: 'All systems within normal range.' },
    info:     { Icon: Info,          title: 'No info messages',       sub: 'No informational notifications.' },
    unread:   { Icon: CheckSquare,   title: 'All caught up!',         sub: 'No unread notifications.' },
  };

  const { Icon, title, sub } = MAP[tab] || MAP.all;

  return (
    <div className="flex flex-col items-center justify-center h-full py-20 text-center px-10">
      <div className="h-20 w-20 rounded-3xl bg-gradient-to-br from-slate-50 to-slate-100 border border-slate-100 flex items-center justify-center mb-5 shadow-inner">
        <Icon className="h-9 w-9 text-slate-300" />
      </div>
      <p className="text-base font-semibold text-slate-600">{title}</p>
      <p className="text-xs text-slate-400 mt-1.5">{sub}</p>
    </div>
  );
}
