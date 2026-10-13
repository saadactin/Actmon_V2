import { useEffect, useRef, useState } from 'react';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Icon from '@/components/ui/Icon';
import cn from '@/lib/cn';
import { formatDateTime, relativeTime } from '../../utils/resourceModel';
import {
  busyView, isTerminal, lastRefreshedView, outcomeMessage,
} from '../../utils/refreshModel';
import {
  useAccountDataSync, useLatestRefresh, useRefreshStatus,
} from '../../hooks/useAccountRefresh';
import RefreshSettingsDrawer from '../overview/RefreshSettingsDrawer';
import RefreshAllButton from './RefreshAllButton';

/**
 * The account page's one refresh control, in the header above every tab.
 *
 * It used to live on the Overview alone, beside five other buttons elsewhere
 * that each refreshed a slice of the account. Now: one button, one name, one
 * "Last refreshed" line — the same on Resources, Cost, Security, Topology,
 * Drift, Events and Alerts — and every tab re-reads when the work finishes.
 *
 * Three things it refuses to do, unchanged from the Overview control it
 * replaced:
 *
 *   It never shows a percentage. The backend cannot know how far through a
 *   provider sweep it is, so progress is stage-based — "3 of 6 · Security".
 *
 *   It never reports success the API did not confirm. "Last refreshed" reads
 *   the backend's record; a sweep that read 218 of 272 scopes says Partial.
 *
 *   It never conflates last ATTEMPT with last SUCCESS. A failed 02:00 run
 *   leaves "Last refreshed" at the last run that worked, and says separately
 *   that the most recent attempt failed.
 */

const STATUS_META = {
  SUCCEEDED: { label: 'Successful', icon: 'check' },
  PARTIAL: { label: 'Partial', icon: 'alert' },
  FAILED: { label: 'Failed', icon: 'alert' },
  CANCELLED: { label: 'Cancelled', icon: 'ban' },
};

const COMPONENT_META = {
  PENDING: { icon: 'circle', className: 'text-subtle' },
  RUNNING: { icon: 'spinner', className: 'animate-spin text-accent-text' },
  SUCCEEDED: { icon: 'check', className: 'text-success-fg' },
  FAILED: { icon: 'close', className: 'text-danger' },
  SKIPPED: { icon: 'dot', className: 'text-subtle' },
};

export default function AccountRefreshBar({ account, accountId }) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [watching, setWatching] = useState(null);
  const [notice, setNotice] = useState(null);

  const latest = useLatestRefresh(accountId);
  const activeId = watching || latest.data?.current?.refresh_id || null;
  const status = useRefreshStatus(accountId, activeId);

  // Re-reads every tab when the account's data changes — for viewers who
  // cannot start a refresh (and so get no button) as much as for anyone else.
  useAccountDataSync(accountId, latest.data?.data_version);

  // A watched refresh reaching its end: say how it went. The data itself is
  // re-read by the sync above, keyed on the data version, so this no longer
  // decides whether the tabs update.
  const settled = useRef(null);
  useEffect(() => {
    const s = status.data;
    if (!s || !isTerminal(s.status) || settled.current === s.refresh_id) return;
    settled.current = s.refresh_id;
    setWatching(null);
    setNotice({ status: s.status, message: outcomeMessage(s) });
  }, [status.data]);

  const busy = busyView(latest.data, status.data);
  const last = lastRefreshedView(latest.data);
  const lastAttempt = latest.data?.last_attempt;
  const lastSuccess = latest.data?.last_success;
  const schedule = latest.data?.schedule;
  // Only worth calling out when the most recent attempt is NOT the run the
  // data came from — otherwise it is the same event described twice.
  const attemptFailed = lastAttempt?.status === 'FAILED'
    && lastAttempt.refresh_id !== lastSuccess?.refresh_id
    && (!last.at || Date.parse(lastAttempt.completed_at || lastAttempt.created_at)
      > Date.parse(last.at));

  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <RefreshAllButton
          accountId={accountId}
          onStarted={(id) => { settled.current = null; setNotice(null); setWatching(id); }}
          onBusy={(refusal) => {
            if (refusal.kind === 'refresh') setWatching(refusal.refreshId);
          }}
          onError={(err) => {
            const detail = err?.response?.data?.detail;
            setNotice({
              status: 'FAILED',
              message: (typeof detail === 'object' ? detail?.message : detail)
                || err?.message || 'The refresh could not be started.',
            });
          }}
        />
        <Button
          variant="ghost"
          size="sm"
          icon="settings"
          onClick={() => setSettingsOpen(true)}
          aria-label="Refresh settings and history"
          title="Auto refresh schedule and history"
        />
      </div>

      {/* Stage-based progress. Never a percentage — see the component note. */}
      {busy?.components && (
        <div className="flex max-w-md flex-wrap items-center justify-end gap-x-2 gap-y-1">
          {Object.entries(busy.components).map(([key, comp]) => {
            const meta = COMPONENT_META[comp.status] || COMPONENT_META.PENDING;
            return (
              <span
                key={key}
                title={comp.detail || `${comp.label}: ${String(comp.status).toLowerCase()}`}
                className="inline-flex items-center gap-1 text-micro text-muted"
              >
                <Icon name={meta.icon} size={10} className={meta.className} />
                {comp.label}
              </span>
            );
          })}
        </div>
      )}

      <div className="text-right text-meta leading-snug">
        {busy ? (
          <span className="text-accent-text">{busy.text}</span>
        ) : last.at ? (
          <span className="text-muted" title={last.detail || undefined}>
            Last refreshed {relativeTime(last.at)}
            <span className="text-subtle"> · {formatDateTime(last.at)}</span>
            {last.partial && (
              <Badge tone="warning" size="sm" className="ml-1">Partial</Badge>
            )}
          </span>
        ) : (
          <span className="text-subtle">Never refreshed</span>
        )}

        {attemptFailed && !busy && (
          <div className="text-danger" title={lastAttempt.error || undefined}>
            Last attempt {relativeTime(lastAttempt.completed_at || lastAttempt.created_at)} failed
          </div>
        )}

        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          className="block w-full text-right text-subtle hover:text-fg hover:underline"
        >
          Auto refresh: {schedule?.enabled
            ? (latest.data?.schedule_summary || 'On')
            : 'Off'}
        </button>
      </div>

      {notice && !busy && (
        <div className={cn(
          'flex max-w-xs items-start gap-1.5 rounded-control border px-2 py-1 text-meta leading-snug',
          notice.status === 'SUCCEEDED' ? 'border-success bg-success-soft'
            : notice.status === 'PARTIAL' ? 'border-warning bg-warning-soft'
              : 'border-danger bg-danger-soft',
        )}
        >
          <Icon
            name={STATUS_META[notice.status]?.icon || 'alert'}
            size={11}
            className="mt-0.5 shrink-0"
          />
          <span className="min-w-0 text-fg">
            {notice.message || 'Account refresh finished.'}
            <button
              type="button"
              onClick={() => { setSettingsOpen(true); setNotice(null); }}
              className="ml-1 font-semibold underline"
            >
              Details
            </button>
          </span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            aria-label="Dismiss"
            className="shrink-0 text-subtle hover:text-fg"
          >
            <Icon name="close" size={11} />
          </button>
        </div>
      )}

      <RefreshSettingsDrawer
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        account={account}
        accountId={accountId}
      />
    </div>
  );
}
