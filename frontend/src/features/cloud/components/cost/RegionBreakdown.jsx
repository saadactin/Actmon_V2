import Badge from '@/components/ui/Badge';
import Icon from '@/components/ui/Icon';
import cn from '@/lib/cn';

/**
 * Billed spend per region.
 *
 * Derived server-side from the same per-service rows the top-drivers list uses,
 * so the two breakdowns always add up to the same account total rather than
 * being two queries that can disagree.
 *
 * Two things it is careful about:
 *
 *   **Currencies are never mixed.** Rows are grouped per currency and a bar is
 *   only ever drawn against the largest amount in ITS OWN currency — comparing
 *   the length of a ₹ bar against a $ bar would be a picture of nothing.
 *
 *   **Unregioned spend is shown, not dropped.** Providers bill some charges
 *   (tax, support, cross-region data transfer) with no region attached. Hiding
 *   those would make the regions fail to add up to the account total and leave
 *   the reader hunting for the difference, so they get their own clearly
 *   labelled row that cannot be selected as a filter.
 */
/**
 * What a provider's own placeholder for "no region" should read as.
 *
 * AWS bills tax, support and some subscriptions against the literal string
 * "NoRegion". Printed verbatim beside `ap-south-1` it reads as a bug, so it is
 * relabelled — but it is still the provider's value, so it stays selectable
 * and is NOT merged with our own "Not reported" bucket, which means something
 * different (the provider gave us nothing at all).
 */
const REGION_ALIAS = {
  NoRegion: 'Not region-specific',
  global: 'Global',
};

const regionLabel = (r) => REGION_ALIAS[r] || r;

export default function RegionBreakdown({ rows = [], selected, onSelect }) {
  if (!rows.length) {
    return (
      <p className="rounded-control border border-dashed border-border px-3 py-6 text-center text-[12px] text-muted">
        No billed spend has been attributed to a region for this scope. That can
        mean the provider reports these charges without a region, or that
        billing data has not been read yet — the cost diagnostics say which.
      </p>
    );
  }

  // Regions with no billed spend are counted, not listed. AWS enables ~20
  // regions on an account and bills in two of them, so listing every one
  // produced eighteen rows of zero-length bar that buried the four that matter.
  // The count is still stated, because "these regions cost nothing" is a real
  // answer and silently dropping them would leave the reader wondering whether
  // the list was truncated.
  const spending = rows.filter((r) => Math.abs(r.monthly_cost || 0) > 0.005);
  const idle = rows.filter((r) => Math.abs(r.monthly_cost || 0) <= 0.005);

  const byCurrency = spending.reduce((acc, r) => {
    const key = r.currency || '—';
    (acc[key] ||= []).push(r);
    return acc;
  }, {});

  return (
    <div className="space-y-4">
      {Object.entries(byCurrency).map(([currency, group]) => {
        const max = Math.max(1, ...group.map((r) => Math.abs(r.monthly_cost || 0)));
        const total = group.reduce((s, r) => s + (r.monthly_cost || 0), 0);
        return (
          <div key={currency}>
            {Object.keys(byCurrency).length > 1 && (
              <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-muted">
                {currency}
              </p>
            )}
            <ul className="space-y-1">
              {group.map((r) => {
                const isSelected = selected === r.region;
                const share = total > 0 ? ((r.monthly_cost || 0) / total) * 100 : 0;
                return (
                  <li key={`${r.region}-${currency}`}>
                    <button
                      type="button"
                      // The unregioned bucket is not a place, so it cannot be
                      // used as a filter — the API would match nothing.
                      disabled={!r.reported}
                      onClick={() => r.reported && onSelect?.(r.region)}
                      title={r.reported
                        ? undefined
                        : 'The provider billed these charges without a region, so they cannot be filtered by one.'}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left transition-colors',
                        isSelected ? 'bg-accent-soft' : 'hover:bg-sunken',
                        !r.reported && 'cursor-default opacity-70 hover:bg-transparent',
                      )}
                    >
                      <Icon
                        name={r.reported ? 'globe' : 'dot'}
                        size={13}
                        className={cn('shrink-0',
                          isSelected ? 'text-accent-text' : 'text-subtle')}
                      />
                      <span className={cn(
                        'w-40 shrink-0 truncate text-[12px]',
                        isSelected ? 'font-semibold text-accent-text' : 'text-fg',
                      )}
                        title={r.region}
                      >
                        {regionLabel(r.region)}
                      </span>
                      <span className="h-2 flex-1 overflow-hidden rounded-full bg-sunken">
                        <span
                          className={cn('block h-full rounded-full transition-all',
                            isSelected ? 'bg-accent-text' : 'bg-accent')}
                          style={{ width: `${(Math.abs(r.monthly_cost || 0) / max) * 100}%` }}
                        />
                      </span>
                      <span className="w-12 shrink-0 text-right text-[11px] tabular-nums text-muted">
                        {share.toFixed(1)}%
                      </span>
                      <span className="w-28 shrink-0 text-right text-[12px] font-semibold tabular-nums text-fg">
                        {(r.monthly_cost ?? 0).toLocaleString(undefined, {
                          minimumFractionDigits: 2, maximumFractionDigits: 2,
                        })}
                        <span className="ml-1 text-[10px] font-normal text-subtle">
                          {r.currency || ''}
                        </span>
                      </span>
                      {isSelected && (
                        <Badge tone="accent" size="sm">Filtering</Badge>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2">
        {idle.length > 0 ? (
          <span className="text-[11px] text-subtle">
            {idle.length} other region{idle.length === 1 ? '' : 's'} enabled on
            this account billed nothing in this period.
          </span>
        ) : <span />}
        {selected && (
          <button
            type="button"
            onClick={() => onSelect?.(selected)}
            className="text-[11px] font-semibold text-accent-text hover:underline"
          >
            Clear region filter
          </button>
        )}
      </div>
    </div>
  );
}
