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
        actions={<HeaderRefreshButton seconds={countdown} onClick={refreshNow} spinning={busy} />}
      />

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

      {tab === 'active' && <ActiveAlerts feed={feed} onOpenRules={() => setTab('rules')} />}
      {tab === 'rules' && <AlertRules rules={rulesApi} />}
      {tab === 'history' && <NotificationHistoryPage />}
      {tab === 'maintenance' && <MaintenanceWindow />}
    </>
  );
}
