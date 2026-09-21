import { useEffect, useRef, useState } from 'react';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Icon from '@/components/ui/Icon';
import cn from '@/lib/cn';
import { relativeTime } from '../../utils/resourceModel';
import {
  componentProgress, isActive, isTerminal, outcomeMessage,
} from '../../utils/refreshModel';
import {
  useInvalidateAccountData, useLatestRefresh, useRefreshStatus, useStartRefresh,
} from '../../hooks/useAccountRefresh';
import RefreshSettingsDrawer from './RefreshSettingsDrawer';

/**
 * The account header's refresh control.
 *
 * Compact by design — a button, a status line and a link into the settings
 * drawer. The refresh itself is a backend job; this only starts it and watches
 * it, which is why navigating away or closing the tab does not stop it.
 *
 * Three things it refuses to do:
 *
 *   It never shows a percentage. The backend cannot know how far through a
 *   provider sweep it is, so progress is stage-based — "3 of 6 components" and
 *   the name of the one running — rather than an invented 64%.
 *
 *   It never reports success the API did not confirm. The button returns to
 *   its normal state on failure rather than keeping a green tick, and the
 *   status line reads from the backend record, not from "the POST returned".
 *
 *   It never conflates last ATTEMPT with last SUCCESS. A failed 02:00 run
 *   leaves "last refreshed" pointing at the last run that actually worked, and
 *   says separately that the most recent attempt failed.
 */

const STATUS_META = {
  SUCCEEDED: { tone: 'success', label: 'Successful', icon: 'check' },
  PARTIAL: { tone: 'warning', label: 'Partial', icon: 'alert' },
  FAILED: { tone: 'danger', label: 'Failed', icon: 'alert' },
  CANCELLED: { tone: 'neutral', label: 'Cancelled', icon: 'ban' },
  RUNNING: { tone: 'info', label: 'Running', icon: 'refresh' },
  QUEUED: { tone: 'info', label: 'Queued', icon: 'clock' },
};

const COMPONENT_META = {
  PENDING: { icon: 'circle', className: 'text-subtle' },
  RUNNING: { icon: 'spinner', className: 'animate-spin text-accent-text' },
  SUCCEEDED: { icon: 'check', className: 'text-success-fg' },
  FAILED: { icon: 'close', className: 'text-danger' },
  SKIPPED: { icon: 'dot', className: 'text-subtle' },
};

export default function AccountRefreshControl({ account, accountId }) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [watching, setWatching] = useState(null);
  const [notice, setNotice] = useState(null);

  const latest = useLatestRefresh(accountId);
  const start = useStartRefresh(accountId);
  const invalidate = useInvalidateAccountData(accountId);

  const running = latest.data?.current;
  const activeId = watching || running?.refresh_id || null;
  const status = useRefreshStatus(accountId, activeId);
  const live = status.data || running;

  // When a watched refresh reaches a terminal state, make the rest of the
  // account's data stale so the page updates itself. This is the whole reason
  // the user does not have to press F5 — and it is deliberately fired ONCE per
  // refresh, tracked by id, rather than on every poll.
  const settled = useRef(null);
  useEffect(() => {
    const s = status.data;
    if (!s || !isTerminal(s.status)) return;
    if (settled.current === s.refresh_id) return;
    settled.current = s.refresh_id;
    // A FAILED or CANCELLED run wrote nothing, so there is nothing to make
    // stale — invalidating there would throw away good cached data and
    // refetch it for no reason. PARTIAL does invalidate: some components did
    // update.
    if (s.status !== 'FAILED' && s.status !== 'CANCELLED') invalidate();
    setWatching(null);
    setNotice({ status: s.status, message: outcomeMessage(s) });
  }, [status.data, invalidate]);

  const isRunning = !!live && isActive(live.status);
  const progress = isRunning ? componentProgress(live.components) : null;

  const onRefresh = () => {
    setNotice(null);
    start.mutate({}, {
      onSuccess: (data) => { settled.current = null; setWatching(data.refresh_id); },
      onError: (err) => {
        const detail = err?.response?.data?.detail;
        // 409 is not an error to apologise for — the account IS refreshing,
        // just not because of this click. Latch onto the running job instead.
        if (err?.response?.status === 409 && detail?.refresh?.refresh_id) {
          setWatching(detail.refresh.refresh_id);
          return;
        }
        setNotice({ status: 'FAILED', message: detail?.message || detail
          || err?.message || 'The refresh could not be started.' });
      },
    });
  };

  const lastSuccess = latest.data?.last_success;
  const lastAttempt = latest.data?.last_attempt;
  const schedule = latest.data?.schedule;
  // Only worth calling out when the most recent attempt is NOT the most recent
  // success — otherwise it is the same event described twice.
  const attemptFailed = lastAttempt
    && lastAttempt.refresh_id !== lastSuccess?.refresh_id
    && ['FAILED', 'PARTIAL'].includes(lastAttempt.status);

  return (
    <div className="flex shrink-0 flex-col items-end gap-1.5">
      <div className="flex items-center gap-2">
        <Button
          variant={isRunning ? 'secondary' : 'primary'}
          size="sm"
          icon="refresh"
          loading={isRunning || start.isPending}
          disabled={isRunning || start.isPending}
          onClick={onRefresh}
          aria-label="Refresh cloud account data"
          title={isRunning
            ? 'A refresh is already running for this account.'
            : 'Re-read this account from the provider: inventory, drift, cost, security and events.'}
        >
          {isRunning ? 'Refreshing…' : 'Refresh Account'}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          icon="settings"
          onClick={() => setSettingsOpen(true)}
          aria-label="Refresh settings and history"
        />
      </div>

      {/* Stage-based progress. Never a percentage — see the component note. */}
      {isRunning && live?.components && (
        <div className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
          {Object.entries(live.components).map(([key, comp]) => {
            const meta = COMPONENT_META[comp.status] || COMPONENT_META.PENDING;
            return (
              <span
                key={key}
                title={comp.detail || `${comp.label}: ${comp.status.toLowerCase()}`}
                className="inline-flex items-center gap-1 text-[10px] text-muted"
              >
                <Icon name={meta.icon} size={10} className={meta.className} />
                {comp.label}
              </span>
            );
          })}
        </div>
      )}

      <div className="text-right text-[11px] leading-snug">
        {isRunning ? (
          <span className="text-accent-text">
            {/* Stages, not a percentage. "4 of 6 · Cost data" is something the
                backend actually knows; "64%" would be invented. */}
            {progress?.total
              ? `${progress.done} of ${progress.total}${progress.running ? ` · ${progress.running}` : ''}`
              : 'Refreshing this account…'}
          </span>
        ) : lastSuccess?.completed_at ? (
          <span className="text-muted">
            Last refreshed {relativeTime(lastSuccess.completed_at)}
            {lastSuccess.status === 'PARTIAL' && (
              <Badge tone="warning" size="sm" className="ml-1">Partial</Badge>
            )}
          </span>
        ) : (
          <span className="text-subtle">Never refreshed</span>
        )}

        {/* The last attempt, ONLY when it differs from the last success. This
            is what stops a failed 02:00 run from being hidden behind a
            reassuring "last refreshed Tuesday". */}
        {attemptFailed && (
          <div className="text-danger">
            Last attempt {relativeTime(lastAttempt.completed_at
              || lastAttempt.created_at)} {STATUS_META[lastAttempt.status]?.label
              ?.toLowerCase() || lastAttempt.status.toLowerCase()}
          </div>
        )}

        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          className="text-subtle hover:text-fg hover:underline"
        >
          Auto refresh: {schedule?.enabled
            ? (latest.data?.schedule_summary || describeLocal(schedule))
            : 'Off'}
        </button>
      </div>

      {notice && !isRunning && (
        <div className={cn(
          'flex max-w-xs items-start gap-1.5 rounded-control border px-2 py-1 text-[11px] leading-snug',
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

/** Fallback description when the header payload has no pre-rendered summary.
 *  The authoritative sentence comes from the backend so the two cannot
 *  disagree about what a schedule means. */
function describeLocal(schedule) {
  if (!schedule?.enabled) return 'Off';
  if (schedule.frequency_type === 'interval') {
    const h = schedule.interval_hours || 24;
    return `Every ${h} hour${h === 1 ? '' : 's'}`;
  }
  if (schedule.frequency_type === 'weekly') return 'Weekly';
  return `Daily at ${schedule.time_of_day}`;
}
