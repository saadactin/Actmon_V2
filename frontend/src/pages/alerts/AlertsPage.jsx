import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import PageHeader from '@/components/layout/PageHeader';
import Icon from '@/components/ui/Icon';
import IconButton from '@/components/ui/IconButton';
import Tabs from '@/components/ui/Tabs';
import { useActiveAlerts, useAlertRules } from '@/hooks/useAlerts';
import { useMenuStore } from '@/hooks/useNavigation';
import { APP } from '@/config/app.config';
import ActiveAlerts from './ActiveAlerts';
import AlertRules from './AlertRules';
import NotificationHistoryPage from './NotificationHistoryPage';

const TAB_PARAM = 'tab';

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
  const tab = tabParam === 'rules' ? 'rules' : tabParam === 'history' ? 'history' : 'active';
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

  const [clock, setClock] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const busy = feed.isFetching || rulesApi.isFetching;
  const error = feed.error || rulesApi.error;

  return (
    <>
      <PageHeader
        title="Alerts"
        icon="alert"
        description="What's firing now, and the rules that decide it"
        actions={
          <div className="flex items-center gap-2">
            <span className="hidden text-right sm:block">
              <span className="block font-mono text-[13px] leading-none font-semibold text-fg tabular-nums">
                {clock.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}
              </span>
              <span className="mt-0.5 block text-[10px] text-subtle">refreshes every 15s</span>
            </span>
            <IconButton
              icon="refresh"
              label="Refresh now"
              onClick={() => { feed.refresh(); rulesApi.refresh(); }}
              iconClassName={busy ? 'animate-spin' : undefined}
            />
          </div>
        }
        tabs={
          <Tabs
            value={tab}
            onChange={setTab}
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
            ]}
          />
        }
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
    </>
  );
}
