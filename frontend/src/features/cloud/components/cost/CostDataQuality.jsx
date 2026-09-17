/**
 * Data quality, provider status and freshness.
 *
 * Two rules this component exists to enforce:
 *
 *  - Billing health and inventory health are reported SEPARATELY. An account
 *    whose scan works fine but whose Cost Management calls are being throttled
 *    is not "healthy", and it is not "broken" either — merging the two states
 *    loses the only information that tells the user what to do.
 *  - Freshness is per dataset. Billing, per-resource cost and inventory refresh
 *    on independent schedules, so showing one timestamp for all three would be
 *    a convenient lie.
 */
import cn from '@/lib/cn';
import Badge from '@/components/ui/Badge';
import {
  AlertTriangle, CheckCircle2, Clock, HelpCircle, MinusCircle, XCircle,
} from 'lucide-react';
import { QUALITY_META, relativeTime } from '../../utils/costFormat';

const QUALITY_ICON = {
  good: CheckCircle2,
  partial: AlertTriangle,
  limited: MinusCircle,
  unavailable: XCircle,
};

/**
 * The page-level quality badge. Carries an icon and a word as well as a colour,
 * so the state is legible without colour vision.
 */
export function DataQualityBadge({ quality, onClick }) {
  const meta = QUALITY_META[quality] || QUALITY_META.good;
  const Icon = QUALITY_ICON[quality] || CheckCircle2;
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-control border border-border bg-surface px-2.5 py-1.5 text-[11.5px] font-semibold text-fg transition-colors hover:bg-sunken"
      title="Open cost diagnostics"
    >
      <span className="text-[10px] font-bold uppercase tracking-wider text-muted">
        Data quality
      </span>
      <Badge tone={meta.tone} size="xs">
        <Icon size={11} aria-hidden />
        {meta.label}
      </Badge>
    </button>
  );
}

/**
 * Per-provider health strip. Cost and inventory are shown as two independent
 * states on the same row — that separation is the point.
 */
export function ProviderStatusStrip({ quality, onDiagnostics }) {
  const freshness = quality?.freshness || {};
  const errorsByAccount = new Map(
    (quality?.errors || []).map((e) => [e.account_id, e]),
  );

  const entries = Object.entries(freshness);
  if (!entries.length) return null;

  return (
    <div className="flex flex-wrap gap-2">
      {entries.map(([accountId, info]) => {
        const error = errorsByAccount.get(accountId);
        const billingTone = error
          ? (error.terminal ? 'danger' : 'warning')
          : (info.billing?.stale ? 'warning' : 'success');
        const billingLabel = error
          ? (error.category === 'rate_limited' ? 'Rate limited'
            : error.category === 'permission' ? 'Permission denied'
            : error.category === 'credentials' ? 'Credentials'
            : 'Degraded')
          : (info.billing?.stale ? 'Stale' : 'Healthy');

        return (
          <button
            key={accountId}
            type="button"
            onClick={onDiagnostics}
            className="flex items-center gap-2.5 rounded-control border border-border bg-surface px-3 py-2 text-left transition-colors hover:bg-sunken"
          >
            <div className="min-w-0">
              <p className="truncate text-[12px] font-semibold text-fg">
                {info.account_name}
              </p>
              <p className="text-[10px] uppercase tracking-wider text-subtle">
                {info.provider}
              </p>
            </div>
            <div className="flex flex-col gap-1">
              <span className="flex items-center gap-1 text-[10px] text-muted">
                Billing
                <Badge tone={billingTone} size="xs">{billingLabel}</Badge>
              </span>
              <span className="flex items-center gap-1 text-[10px] text-muted">
                Inventory
                <Badge tone={info.inventory?.retrieved_at ? 'success' : 'neutral'} size="xs">
                  {info.inventory?.retrieved_at ? 'Scanned' : 'Never scanned'}
                </Badge>
              </span>
            </div>
          </button>
        );
      })}
    </div>
  );
}

/** Per-dataset freshness. Each row carries its own age; none is inferred from
 *  another. An unfetched dataset reads "Never", not "just now". */
export function FreshnessPanel({ quality }) {
  const freshness = quality?.freshness || {};
  const entries = Object.entries(freshness);
  if (!entries.length) {
    return (
      <p className="text-[12px] text-muted">
        No freshness information — no cost data has been fetched for this scope yet.
      </p>
    );
  }

  const DATASETS = [
    ['billing', 'Billing data'],
    ['daily_trend', 'Daily trend'],
    ['resource_cost', 'Resource-cost mapping'],
    ['inventory', 'Inventory'],
  ];

  return (
    <div className="space-y-3">
      {entries.map(([accountId, info]) => (
        <div key={accountId} className="rounded-control border border-border bg-sunken p-3">
          <p className="mb-2 text-[12px] font-semibold text-fg">
            {info.account_name}
            <span className="ml-1.5 text-[10px] uppercase tracking-wider text-subtle">
              {info.provider}
            </span>
          </p>
          <dl className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {DATASETS.map(([key, label]) => {
              const row = info[key] || {};
              const never = !row.retrieved_at;
              return (
                <div key={key} className="flex items-center justify-between gap-2">
                  <dt className="text-[11.5px] text-muted">{label}</dt>
                  <dd className="flex items-center gap-1.5 text-[11.5px] font-medium text-fg">
                    <Clock size={11} className="text-subtle" aria-hidden />
                    {never ? (
                      <span className="text-muted">Never</span>
                    ) : (
                      <span title={row.retrieved_at}>{relativeTime(row.retrieved_at)}</span>
                    )}
                    {row.stale && <Badge tone="warning" size="xs">Stale</Badge>}
                  </dd>
                </div>
              );
            })}
          </dl>
        </div>
      ))}
    </div>
  );
}

/**
 * Capability matrix — what each provider in scope can and cannot answer, with
 * the reason. This is what stops a user concluding that AWS costs nothing
 * per-resource when the truth is that Cost Explorer cannot report it.
 */
export function CapabilityMatrix({ capabilities }) {
  const perProvider = capabilities?.per_provider || {};
  const providers = Object.keys(perProvider);
  if (!providers.length) return null;

  const DIMENSIONS = [
    ['service', 'Service breakdown'],
    ['region', 'Region breakdown'],
    ['resource', 'Per-resource cost'],
    ['daily_trend', 'Daily trend'],
    ['daily_region', 'Region on daily rows'],
    ['usage_type', 'Usage type'],
    ['tags', 'Tag allocation'],
    ['forecast_api', 'Provider forecast API'],
    ['budget_api', 'Provider budget API'],
  ];

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[520px] text-left text-[12px]">
        <caption className="sr-only">
          What each cloud provider’s billing integration can answer
        </caption>
        <thead>
          <tr className="border-b border-border">
            <th scope="col" className="py-2 pr-3 font-semibold text-muted">Capability</th>
            {providers.map((p) => (
              <th key={p} scope="col" className="px-3 py-2 font-semibold text-muted">{p}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {DIMENSIONS.map(([key, label]) => (
            <tr key={key} className="border-b border-border/60 last:border-0">
              <th scope="row" className="py-2 pr-3 font-medium text-fg">{label}</th>
              {providers.map((p) => {
                const cap = perProvider[p];
                const yes = cap?.[key];
                const reason = cap?.unsupported_reasons?.[key];
                return (
                  <td key={p} className="px-3 py-2">
                    <span
                      className={cn(
                        'inline-flex items-center gap-1 text-[11.5px] font-semibold',
                        yes ? 'text-success-fg' : 'text-muted',
                      )}
                      title={reason || undefined}
                    >
                      {yes ? <CheckCircle2 size={12} aria-hidden />
                        : <MinusCircle size={12} aria-hidden />}
                      {yes ? 'Yes' : 'No'}
                      {!yes && reason && <HelpCircle size={10} className="text-subtle" aria-hidden />}
                    </span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-[11px] text-subtle">
        “No” means this integration cannot produce the value — it is never shown
        as zero. Hover a “No” for the reason and what would change it.
      </p>
    </div>
  );
}
