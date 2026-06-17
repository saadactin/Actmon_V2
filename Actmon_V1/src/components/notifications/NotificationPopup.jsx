import React, { useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Bell, BellRing, X, CheckSquare, AlertCircle, AlertTriangle,
  Info, ChevronRight, Layers, Check, ArrowUpRight,
} from 'lucide-react';
import { formatTimeAgo } from '../../utils/formatters';

// ─── Severity config ──────────────────────────────────────────────────────────
const SEV = {
  critical: {
    Icon: AlertCircle,
    color:   'text-red-500',
    bg:      'bg-red-50',
    border:  'border-red-200',
    strip:   'bg-red-500',
    badge:   'bg-red-100 text-red-700',
    dot:     'bg-red-500',
    label:   'Critical',
    hover:   'hover:bg-red-50/50',
  },
  warning: {
    Icon: AlertTriangle,
    color:   'text-amber-500',
    bg:      'bg-amber-50',
    border:  'border-amber-200',
    strip:   'bg-amber-400',
    badge:   'bg-amber-100 text-amber-700',
    dot:     'bg-amber-400',
    label:   'Warning',
    hover:   'hover:bg-amber-50/50',
  },
  info: {
    Icon: Info,
    color:   'text-blue-500',
    bg:      'bg-blue-50',
    border:  'border-blue-200',
    strip:   'bg-blue-500',
    badge:   'bg-blue-100 text-blue-700',
    dot:     'bg-blue-400',
    label:   'Info',
    hover:   'hover:bg-blue-50/30',
  },
};

function getSev(severity) {
  return SEV[(severity || 'info').toLowerCase()] || SEV.info;
}

function getNavPath(notif) {
  const agent = notif.agent_name;
  if (!agent) return null;
  const msg = (notif.message || '').toLowerCase();
  if (msg.includes('slow quer'))  return `/agents/${agent}?tab=sql`;
  if (msg.includes('error'))      return `/agents/${agent}?tab=errors`;
  return `/agents/${agent}`;
}

// ─── Component ────────────────────────────────────────────────────────────────
export default function NotificationPopup({
  notifications,
  unreadCount,
  markRead,
  markAllRead,
  isPending,
  onClose,
  onViewAll,
}) {
  const navigate  = useNavigate();
  const popupRef  = useRef(null);

  // Close when clicking outside
  useEffect(() => {
    const handler = (e) => {
      if (popupRef.current && !popupRef.current.contains(e.target)) onClose();
    };
    // 60ms delay so the opening click doesn't immediately re-close
    const t = setTimeout(() => document.addEventListener('mousedown', handler), 60);
    return () => { clearTimeout(t); document.removeEventListener('mousedown', handler); };
  }, [onClose]);

  const latest = notifications.slice(0, 5);
  const total  = notifications.length;

  const handleClick = (notif) => {
    if (!notif.is_read) markRead([notif.id]);
    const path = getNavPath(notif);
    if (path) { onClose(); navigate(path); }
  };

  return (
    <>
      {/* ── Caret arrow ── */}
      <div
        className="absolute -top-[7px] right-[13px] h-3.5 w-3.5 rotate-45 rounded-sm bg-slate-800 z-[51]"
        style={{ boxShadow: '-2px -2px 4px rgba(0,0,0,0.08)' }}
      />

      {/* ── Popup card ── */}
      <div
        ref={popupRef}
        className="absolute right-0 top-full mt-2 w-[390px] bg-white rounded-2xl overflow-hidden z-50"
        style={{
          boxShadow: '0 20px 60px rgba(0,0,0,0.18), 0 4px 16px rgba(0,0,0,0.10)',
          animation: 'popupIn 0.22s cubic-bezier(0.16,1,0.3,1)',
        }}
      >
        {/* ─── Header ─── */}
        <div className="bg-gradient-to-br from-slate-800 via-slate-800 to-slate-900 px-4 py-3.5 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="relative flex-shrink-0">
              <div className="h-9 w-9 rounded-xl bg-white/10 border border-white/10 flex items-center justify-center">
                {unreadCount > 0
                  ? <BellRing className="h-4 w-4 text-white" />
                  : <Bell className="h-4 w-4 text-white/70" />
                }
              </div>
              {unreadCount > 0 && (
                <span className="absolute -top-1 -right-1 h-4 min-w-4 px-0.5 flex items-center justify-center rounded-full bg-red-500 text-[9px] font-bold text-white">
                  {unreadCount > 9 ? '9+' : unreadCount}
                </span>
              )}
            </div>
            <div>
              <p className="text-sm font-semibold text-white leading-tight">Notifications</p>
              <p className="text-[10px] text-slate-400 mt-0.5">
                {unreadCount > 0 ? `${unreadCount} unread · ` : 'All read · '}{total} total
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1">
            {unreadCount > 0 && (
              <button
                onClick={markAllRead}
                disabled={isPending}
                className="flex items-center gap-1 px-2.5 py-1.5 text-[10px] font-medium text-slate-300 hover:text-white hover:bg-white/10 rounded-lg transition-colors disabled:opacity-50"
              >
                <CheckSquare className="h-3 w-3" />
                Mark all
              </button>
            )}
            <button
              onClick={onClose}
              className="h-7 w-7 flex items-center justify-center text-slate-400 hover:text-white hover:bg-white/10 rounded-lg transition-colors"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {/* ─── Notification rows ─── */}
        {latest.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <div className="h-14 w-14 rounded-2xl bg-slate-50 flex items-center justify-center mb-3">
              <Bell className="h-6 w-6 text-slate-200" />
            </div>
            <p className="text-sm font-semibold text-slate-500">All clear!</p>
            <p className="text-xs text-slate-400 mt-0.5">No notifications yet.</p>
          </div>
        ) : (
          <div className="divide-y divide-slate-50">
            {latest.map((notif, i) => (
              <PopupRow
                key={notif.id}
                notif={notif}
                onClick={() => handleClick(notif)}
                onMarkRead={(e) => { e.stopPropagation(); markRead([notif.id]); }}
                isPending={isPending}
                isFirst={i === 0}
              />
            ))}
          </div>
        )}

        {/* ─── Footer ─── */}
        {total > 0 && (
          <div className="border-t border-slate-100">
            <button
              onClick={onViewAll}
              className="w-full flex items-center justify-between px-4 py-3 text-xs font-semibold text-slate-600 hover:text-slate-900 hover:bg-slate-50 transition-colors group"
            >
              <div className="flex items-center gap-2">
                <Layers className="h-3.5 w-3.5 text-slate-400 group-hover:text-slate-600" />
                <span>See all {total} notifications</span>
              </div>
              <ChevronRight className="h-3.5 w-3.5 text-slate-400 group-hover:text-slate-600 group-hover:translate-x-0.5 transition-transform" />
            </button>
          </div>
        )}
      </div>

      <style>{`
        @keyframes popupIn {
          from { opacity: 0; transform: translateY(-8px) scale(0.96); }
          to   { opacity: 1; transform: translateY(0)   scale(1);    }
        }
      `}</style>
    </>
  );
}

// ─── Single notification row ──────────────────────────────────────────────────
function PopupRow({ notif, onClick, onMarkRead, isPending, isFirst }) {
  const sev    = getSev(notif.severity);
  const { Icon } = sev;
  const isRead = notif.is_read;

  return (
    <div
      onClick={onClick}
      className={`group relative flex cursor-pointer transition-colors duration-100 ${
        isRead
          ? 'bg-white hover:bg-slate-50'
          : `bg-gradient-to-r from-white to-white ${sev.hover}`
      }`}
    >
      {/* Severity strip */}
      <div className={`w-[3px] flex-shrink-0 self-stretch ${sev.strip} opacity-90`} />

      {/* Main content */}
      <div className="flex items-start gap-3 px-3.5 py-3 flex-1 min-w-0">

        {/* Icon */}
        <div className={`flex-shrink-0 mt-0.5 h-7 w-7 rounded-lg flex items-center justify-center border ${
          isRead ? 'bg-slate-50 border-slate-100' : `${sev.bg} ${sev.border}`
        }`}>
          <Icon className={`h-3.5 w-3.5 ${isRead ? 'text-slate-300' : sev.color}`} />
        </div>

        {/* Text block */}
        <div className="flex-1 min-w-0">
          {/* Top row: agent + severity + time */}
          <div className="flex items-center justify-between gap-2 mb-0.5">
            <div className="flex items-center gap-1.5 min-w-0">
              {notif.agent_name && (
                <span className={`text-[10px] font-bold truncate max-w-[90px] ${isRead ? 'text-slate-400' : 'text-slate-700'}`}>
                  {notif.agent_name}
                </span>
              )}
              <span className={`flex-shrink-0 text-[9px] font-semibold px-1.5 py-0.5 rounded-full ${
                isRead ? 'bg-slate-100 text-slate-400' : sev.badge
              }`}>
                {sev.label}
              </span>
            </div>
            <span className="flex-shrink-0 text-[10px] text-slate-400">
              {formatTimeAgo(notif.created_at || notif.timestamp)}
            </span>
          </div>

          {/* Message */}
          <p className={`text-[12px] leading-relaxed line-clamp-2 ${
            isRead ? 'text-slate-400' : 'text-slate-700 font-medium'
          }`}>
            {notif.message}
          </p>
        </div>

        {/* Right: unread dot or mark-read */}
        <div className="flex-shrink-0 flex flex-col items-end gap-1 mt-0.5">
          {!isRead ? (
            <>
              <span className={`h-2 w-2 rounded-full ${sev.dot}`} />
              <button
                onClick={onMarkRead}
                disabled={isPending}
                className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-medium text-slate-500 bg-white hover:bg-slate-100 border border-slate-200 disabled:opacity-30"
              >
                <Check className="h-2.5 w-2.5" />
              </button>
            </>
          ) : (
            <ArrowUpRight className="h-3.5 w-3.5 text-slate-200 opacity-0 group-hover:opacity-100 transition-opacity" />
          )}
        </div>
      </div>
    </div>
  );
}
