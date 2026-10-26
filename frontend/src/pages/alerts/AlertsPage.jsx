import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import PageHeader from '@/components/layout/PageHeader';
import HeaderRefreshButton from '@/components/layout/HeaderRefreshButton';
import Icon from '@/components/ui/Icon';
import Tabs from '@/components/ui/Tabs';
import { useActiveAlerts, useAlertRules } from '@/hooks/useAlerts';
import { useMenuStore } from '@/hooks/useNavigation';
import { APP } from '@/config/app.config';
import ActiveAlerts from './ActiveAlerts';
import AlertRules from './AlertRules';
import NotificationHistoryPage from './NotificationHistoryPage';
import MaintenanceWindow from './MaintenanceWindow';
import AlertDetailPanel from './AlertDetailPanel';
import { useQuery } from '@tanstack/react-query';
import { Area, AreaChart, ResponsiveContainer } from 'recharts';
import { getAlertStats } from '@/api/alerts';

const TAB_PARAM = 'tab';
const REFRESH_SECONDS = 15; // matches useActiveAlerts' own refetchInterval

/**
 * Alerts.
 *
 * Two views because they answer two different questions: "what is wrong right
 * now" (Active) and "what would we be told about" (Rules). They're one page
 * because the answer to the first is usually a change to the second — the empty
 * state in Active links straight into Rules.
 *
 * The active tab is the landing view; the tab lives in the URL so a link can
 * point at either.
 */
export default function AlertsPage() {
  const [params, setParams] = useSearchParams();
  const tabParam = params.get(TAB_PARAM);
  const tab = ['rules', 'history', 'maintenance'].includes(tabParam) ? tabParam : 'active';
  const setTab = (id) => {
    const next = new URLSearchParams(params);
    if (id === 'active') next.delete(TAB_PARAM);
    else next.set(TAB_PARAM, id);
    setParams(next, { replace: true });
  };

  // The open alert lives in the URL (?alert=<id>): Back / Close keep the list's filters and page, and the link is shareable.
  const openAlertId = params.get('alert');
  const setOpenAlert = (id) => {
    const next = new URLSearchParams(params);
    if (id) next.set('alert', String(id)); else next.delete('alert');
    setParams(next, { replace: false });
  };

  const feed = useActiveAlerts();
  const rulesApi = useAlertRules();
  const setBadge = useMenuStore((s) => s.setBadge);

  // Surface the firing count on the sidebar's Alerts row.
  useEffect(() => {
    setBadge('alerts', feed.summary.total || undefined);
  }, [feed.summary.total, setBadge]);

  // Same countdown-pill pattern as Agents/Dashboard/Infrastructure — ticks
  // down to 0 and resets on every refresh, manual or automatic.
  const [countdown, setCountdown] = useState(REFRESH_SECONDS);
  useEffect(() => {
    const t = setInterval(() => setCountdown((c) => (c <= 1 ? REFRESH_SECONDS : c - 1)), 1000);
    return () => clearInterval(t);
  }, []);
  const refreshNow = () => { feed.refresh(); rulesApi.refresh(); setCountdown(REFRESH_SECONDS); };

  const busy = feed.isFetching || rulesApi.isFetching;
  const error = feed.error || rulesApi.error;

  return (
    <>
      <PageHeader
        title="Alerts"
        icon="alert"
        hideBreadcrumbs
        description="What's firing now, and the rules that decide it"
        actions={(
          <div className="flex items-center gap-3">
            <HeaderRefreshButton seconds={countdown} onClick={refreshNow} spinning={busy} />
            <span className="card inline-flex items-center gap-2.5 px-3.5 py-2 text-[12px] leading-tight">
              <span className={feed.error ? 'h-2.5 w-2.5 rounded-full bg-[#ef4444]' : 'h-2.5 w-2.5 rounded-full bg-[#22c55e]'} />
              <span><span className="block text-muted">Last Updated</span>
                <b className="text-fg">{feed.dataUpdatedAt ? new Date(feed.dataUpdatedAt).toLocaleString(undefined, { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}</b></span>
            </span>
          </div>
        )}
      />

      <SummaryCards summary={feed.summary} loading={feed.isLoading} />

      {/* Below the header, not inside it — PageHeader's own `tabs` slot renders
          them inside the coloured band; moved out to a plain strip underneath. */}
      <Tabs
        value={tab}
        onChange={setTab}
        className="mb-gutter"
        tabs={[
          {
            id: 'active',
            label: 'Active',
            icon: 'bell-ring',
            count: feed.summary.total,
            tone: feed.summary.critical ? 'danger' : feed.summary.total ? 'warning' : 'neutral',
          },
          {
            id: 'rules',
            label: 'Rules',
            icon: 'settings',
            count: rulesApi.stats.total,
            tone: 'neutral',
          },
          {
            id: 'history',
            label: 'Notification History',
            icon: 'history',
          },
          {
            id: 'maintenance',
            label: 'Maintenance Window',
            icon: 'clipboard',
          },
        ]}
      />

      {error && (
        <div className="card mb-gutter flex items-start gap-3 px-card py-3">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-danger-soft text-danger-fg">
            <Icon name="alert" size={16} />
          </span>
          <div className="min-w-0">
            <p className="text-[13px] font-bold text-fg">
              {error.offline ? 'Backend unreachable' : 'Could not load alerts'}
            </p>
            <p className="mt-0.5 text-[12px] text-muted">
              {error.offline ? `No response from ${APP.apiBase}. Start the backend, then refresh.` : error.message}
            </p>
          </div>
        </div>
      )}

      {tab === 'active' && <ActiveAlerts feed={feed} onOpenRules={() => setTab('rules')} openAlertId={openAlertId} onOpenAlert={setOpenAlert} />}
      {tab === 'rules' && <AlertRules rules={rulesApi} />}
      {tab === 'history' && <NotificationHistoryPage />}
      {tab === 'maintenance' && <MaintenanceWindow />}
      {openAlertId && <AlertDetailPanel alertId={openAlertId} onClose={() => setOpenAlert(null)} onSelect={setOpenAlert} />}
    </>
  );
}


/* ── the five header cards ─────────────────────────────────────────────────────────────────────────
   Counts are what is firing NOW (the live feed). The % arrow compares alerts RAISED in the last 24 h with the
   24 h before (stored collector events), and the sparkline is that hourly series. There is no stored
   "resolved" event, so the fifth card is what really exists: alerts raised in 24 h that were acknowledged. */
const CARD_STYLE = {
  total: { icon: 'alert', ring: 'bg-[#fee2e2] text-[#dc2626]', solid: '#ef4444', tint: 'from-[#fff1f1]' },
  critical: { icon: 'close', ring: 'bg-[#ffedd5] text-[#ea580c]', solid: '#f97316', tint: 'from-[#fff6ef]' },
  warning: { icon: 'alert', ring: 'bg-[#fef3c7] text-[#d97706]', solid: '#f59e0b', tint: 'from-[#fffaf0]' },
  info: { icon: 'info', ring: 'bg-[#dbeafe] text-[#2563eb]', solid: '#3b82f6', tint: 'from-[#f3f7ff]' },
  acked: { icon: 'check', ring: 'bg-[#dcfce7] text-[#16a34a]', solid: '#22c55e', tint: 'from-[#f1fbf4]' },
};
function pctChange(cur, prev) {
  if (cur == null || prev == null) return null;
  if (prev === 0) return cur === 0 ? 0 : 100;
  return Math.round((100 * (cur - prev)) / prev);
}
function SummaryCards({ summary, loading }) {
  const statsQ = useQuery({ queryKey: ['alerts', 'stats', 24], queryFn: () => getAlertStats(24), refetchInterval: 60_000 });
  const st = statsQ.data;
  const ser = (k) => (st?.series || []).map((p) => ({ v: k === 'total' ? p.critical + p.warning + p.info : p[k] }));
  const cards = [
    ['total', summary.total, 'Active Alerts', 'Currently firing', pctChange(st?.current.total, st?.previous.total)],
    ['critical', summary.critical, 'Critical', 'Immediate attention', pctChange(st?.current.critical, st?.previous.critical)],
    ['warning', summary.warning, 'Warning', 'Needs review', pctChange(st?.current.warning, st?.previous.warning)],
    ['info', summary.info, 'Info', 'Informational', pctChange(st?.current.info, st?.previous.info)],
    ['acked', st?.acknowledged, 'Acknowledged (24h)', 'Raised in 24 h and acknowledged', pctChange(st?.acknowledged, st?.acknowledged_previous)],
  ];
  return (
    <div className="mb-gutter grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5">
      {cards.map(([k, value, label, sub, ch]) => {
        const c = CARD_STYLE[k];
        return (
          <div key={k} className={`card relative overflow-hidden bg-gradient-to-br ${c.tint} to-[var(--surface,#fff)] px-5 py-4`}>
            <div className="flex items-start gap-4">
              <span className={`grid h-14 w-14 shrink-0 place-items-center rounded-full ${c.ring}`}><Icon name={c.icon} size={26} /></span>
              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-2">
                  <div className="text-[26px] font-bold leading-none text-fg tabular-nums">{loading && value == null ? '…' : (value ?? '—')}</div>
                  {ch != null && (
                    <span className={`text-[14px] font-semibold ${ch > 0 ? 'text-[#dc2626]' : ch < 0 ? 'text-[#16a34a]' : 'text-muted'}`} title="Raised in the last 24 h vs the 24 h before">
                      {ch > 0 ? '↑' : ch < 0 ? '↓' : '→'} {Math.abs(ch)}%
                    </span>
                  )}
                </div>
                <div className="mt-1 text-[14px] font-medium text-fg">{label}</div>
                <div className="mt-2 text-[13px] text-muted">{sub}</div>
              </div>
            </div>
            <div className="pointer-events-none absolute bottom-0 right-0 h-10 w-1/2 opacity-60">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={ser(k === 'acked' ? 'info' : k)} margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
                  <Area type="monotone" dataKey="v" stroke={c.solid} strokeWidth={1.5} fill={c.solid} fillOpacity={0.15} dot={false} isAnimationActive={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
        );
      })}
    </div>
  );
}
