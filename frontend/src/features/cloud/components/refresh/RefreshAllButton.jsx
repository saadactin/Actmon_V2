import { useState } from 'react';
import Button from '@/components/ui/Button';
import { usePermissions } from '@/hooks/usePermissions';
import { useRefreshAll } from '../../hooks/useAccountRefresh';
import {
  REFRESH_ALL_BUSY_LABEL, REFRESH_ALL_LABEL, REFRESH_ALL_TITLE,
} from '../../utils/refreshModel';

/**
 * Re-reads the whole account from its provider.
 *
 * It replaced six buttons with six names — Refresh Account, Run Discovery
 * Scan, Run, Run assessment, Collect now and Retry — each refreshing a
 * different slice of the same account, so nobody could tell which one made
 * which tab current. This starts the account refresh, which does all of it in
 * one provider pass: resources, cost, security (with certificates and
 * identity), drift and events. The only other refresh is each tab's own
 * "Refresh <tab>" (TabRefreshButton), declared in utils/tabRefreshModel.js.
 *
 * Wherever it is rendered it also keeps that account's tabs in sync
 * (`useRefreshAll` → `useAccountDataSync`), so the data re-reads when the
 * work finishes regardless of which tab, browser or schedule started it.
 *
 * Disabled while the account is busy — a refresh or a plain discovery scan —
 * because the backend refuses a second sweep either way.
 */
export default function RefreshAllButton({
  accountId,
  size = 'sm',
  variant = 'primary',
  iconOnly = false,
  onStarted,
  onBusy,
  onError,
}) {
  const { canHere } = usePermissions();
  const { busy, scanRunning, run } = useRefreshAll(accountId);
  const [error, setError] = useState(null);

  // Starting a refresh changes state → requires Execute on this page.
  if (!accountId || !canHere('execute')) return null;

  const onClick = (e) => {
    // Rows in the account list navigate on click; this must not.
    e?.stopPropagation?.();
    setError(null);
    run({
      onStarted,
      onBusy,
      onError: (err) => {
        if (onError) { onError(err); return; }
        const detail = err?.response?.data?.detail;
        setError((typeof detail === 'object' ? detail?.message : detail)
          || err?.message || 'The refresh could not be started.');
      },
    });
  };

  const title = busy
    ? (scanRunning
      ? 'A discovery scan is already running for this account. It updates the same data.'
      : 'A refresh is already running for this account.')
    : REFRESH_ALL_TITLE;

  return (
    <span className="inline-flex flex-col items-end gap-0.5">
      <Button
        variant={busy ? 'secondary' : variant}
        size={size}
        icon="refresh"
        loading={busy}
        disabled={busy}
        onClick={onClick}
        aria-label={iconOnly ? REFRESH_ALL_LABEL : undefined}
        title={title}
      >
        {iconOnly ? null : (busy ? REFRESH_ALL_BUSY_LABEL : REFRESH_ALL_LABEL)}
      </Button>
      {error && (
        <span className="max-w-[16rem] text-right text-[10px] leading-snug text-danger">
          {error}
        </span>
      )}
    </span>
  );
}
