import Button from '@/components/ui/Button';
import cn from '@/lib/cn';
import { useTabRefresh } from '../../hooks/useAccountRefresh';
import { SOURCE_PROVIDER } from '../../utils/tabRefreshModel';

/**
 * A tab's own refresh, beside its tab strip.
 *
 * Every tab gets this same button, named "Refresh <tab>", so the header's
 * "Refresh all" and the tab's refresh are the only two names anyone sees.
 * What each one does — provider re-read, re-assessment, or a re-read of the
 * stored data — is declared in `utils/tabRefreshModel.js`, and the caption
 * after a run says which of those happened.
 */
export default function TabRefreshButton({ accountId, tabKey, className }) {
  const { plan, run, pending, outcome } = useTabRefresh(accountId, tabKey);
  if (!accountId || !plan) return null;

  return (
    <div className={cn('flex shrink-0 items-center gap-2', className)}>
      {outcome && !pending && (
        <span
          className={cn(
            'hidden max-w-[22rem] truncate text-right text-meta sm:inline',
            outcome.ok ? 'text-muted' : 'text-danger',
          )}
          title={`${outcome.text} · ${new Date(outcome.at).toLocaleTimeString()}`}
        >
          {outcome.text}
        </span>
      )}
      {pending && !plan.background && plan.source === SOURCE_PROVIDER && (
        <span className="hidden text-meta text-accent-text sm:inline">
          Reading from the provider…
        </span>
      )}
      <Button
        variant="secondary"
        size="sm"
        icon="refresh"
        loading={pending}
        disabled={pending || plan.disabled}
        onClick={run}
        title={plan.title}
        data-tab-refresh={tabKey}
      >
        {plan.label}
      </Button>
    </div>
  );
}
