/**
 * The Overview KPI row, and the per-provider cards an ALL view needs.
 *
 * The multi-currency rule is enforced here rather than in the page: when the
 * scope spans currencies there IS no single total, so the headline shows NA
 * with the currencies named, and the real figures appear as one card per
 * currency underneath. Nothing is ever converted — this product has no FX
 * source, and a converted headline would be a number nobody can reconcile
 * against an invoice.
 */
import cn from '@/lib/cn';
import Badge from '@/components/ui/Badge';
import {
  Activity, AlertTriangle, CalendarClock, Coins, Database, Gauge, PiggyBank,
  TrendingUp, Wallet,
} from 'lucide-react';
import { Amount, ChangeChip, Provenance } from './CostPrimitives';
import { compact, exact, isMissing, percent } from '../../utils/costFormat';

function Kpi({ icon: Icon, label, children, footer, tone = 'neutral', span }) {
  return (
    <div className={cn(
      'rounded-card border border-border bg-surface p-3.5',
      span && 'sm:col-span-2',
    )}>
      <div className="mb-2 flex items-center gap-2">
        <span className={cn(
          'flex h-6 w-6 items-center justify-center rounded-control',
          tone === 'danger' ? 'bg-danger-soft text-danger-fg'
            : tone === 'warning' ? 'bg-warning-soft text-warning-fg'
            : tone === 'success' ? 'bg-success-soft text-success-fg'
            : 'bg-accent-soft text-accent-text',
        )}>
          <Icon size={13} aria-hidden />
        </span>
        <p className="text-[10.5px] font-bold uppercase tracking-wider text-muted">
          {label}
        </p>
      </div>
      {children}
      {footer && <div className="mt-1.5">{footer}</div>}
    </div>
  );
}

/**
 * The headline spend figure for the scope.
 *
 * `totals` is the backend's per-currency breakdown. One currency -> a real
 * total. More than one -> NA plus the reason, because adding USD to INR is not
 * arithmetic, it is a category error.
 */
export function SpendHeadline({ totals, period, source, change, onWhy }) {
  const mixed = totals?.mixed;
  const currencies = totals?.currencies || [];

  return (
    <div className="rounded-card border border-border bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10.5px] font-bold uppercase tracking-wider text-muted">
            Total spend
            {period?.days ? ` — last ${period.days} days` : ''}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-2.5">
            {mixed ? (
              <Amount value={null} size="xl" reason={totals?.na_reason} />
            ) : (
              <Amount
                value={totals?.amount}
                currency={totals?.currency}
                size="xl"
                reason={totals?.na_reason}
              />
            )}
            {change && <ChangeChip change={change} />}
          </div>
          <Provenance
            className="mt-1.5"
            source={source}
            period={period}
            currency={mixed ? null : totals?.currency}
          />
        </div>

        {mixed && (
          <div className="rounded-control border border-warning/30 bg-warning-soft px-3 py-2">
            <p className="flex items-center gap-1.5 text-[11px] font-bold text-warning-fg">
              <AlertTriangle size={12} aria-hidden />
              Multiple billing currencies
            </p>
            <p className="mt-0.5 max-w-xs text-[11px] leading-relaxed text-warning-fg/90">
              {currencies.join(', ')} are billed separately and are never added
              together. Per-currency totals are shown below.
            </p>
          </div>
        )}
      </div>

      {/* One real figure per currency. This is what the user actually reads
          when the headline has to say NA. With a single currency it would only
          repeat the headline figure, in a band of its own. */}
      {currencies.length > 1 && (
        <div className="mt-3 flex flex-wrap gap-2 border-t border-border pt-3">
          {currencies.map((code) => (
            <div
              key={code}
              className="rounded-control border border-border bg-sunken px-3 py-2"
            >
              <p className="text-[10px] font-bold uppercase tracking-wider text-subtle">
                {code}
              </p>
              <p
                className="mt-0.5 text-[15px] font-bold tabular-nums text-fg"
                title={exact(totals.by_currency?.[code], code)}
              >
                {compact(totals.by_currency?.[code], code)}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Per-provider cards. Required for an ALL view (spec 121): each cloud's spend
 * shown in its own currency, never summed into one figure.
 */
export function ProviderSpendCards({ byService }) {
  const byProvider = new Map();
  (byService || []).forEach((row) => {
    const key = row.provider || 'Unknown';
    const entry = byProvider.get(key) || { provider: key, currencies: new Map() };
    if (!isMissing(row.monthly_cost)) {
      const code = row.currency || 'UNKNOWN';
      entry.currencies.set(code, (entry.currencies.get(code) || 0) + Number(row.monthly_cost));
    }
    byProvider.set(key, entry);
  });

  const providers = [...byProvider.values()];
  if (!providers.length) return null;

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {providers.map((p) => (
        <div key={p.provider} className="rounded-card border border-border bg-surface p-3.5">
          <p className="text-[11px] font-bold uppercase tracking-wider text-muted">
            {p.provider}
          </p>
          <div className="mt-1.5 space-y-1">
            {[...p.currencies.entries()].map(([code, value]) => (
              <p
                key={code}
                className="text-[18px] font-bold tabular-nums text-fg"
                title={exact(value, code)}
              >
                {compact(value, code)}
              </p>
            ))}
            {!p.currencies.size && <Amount value={null} size="lg" />}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * The KPI strip. Every tile either shows a real figure or NA with a reason —
 * none of them fall back to zero when data is missing.
 */
export default function CostKpiCards({
  totals, forecast, coverage, quality, savings, savingsCurrency,
  optimizationCount, unmatchedCount, monthOverMonth,
}) {
  const currency = totals?.currency;
  const fc = forecast?.by_currency?.[currency] || null;
  const mom = monthOverMonth?.by_currency?.[currency]?.change || null;

  const dailyAverage = fc?.available ? fc.daily_average : null;
  const projected = fc?.available ? fc.current_month?.projected_total : null;
  const mtd = fc?.available ? fc.current_month?.month_to_date_actual : null;

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Kpi icon={Activity} label="Daily average">
        <Amount
          value={dailyAverage}
          currency={currency}
          size="lg"
          reason={fc?.reason || 'Needs stored billing history.'}
        />
        {fc?.available && (
          <p className="mt-1 text-[10.5px] text-subtle">
            over {fc.observed_days} observed days
          </p>
        )}
      </Kpi>

      <Kpi icon={CalendarClock} label="Month to date">
        <Amount value={mtd} currency={currency} size="lg"
                reason={fc?.reason || 'Needs stored billing history.'} />
        {fc?.available && (
          <p className="mt-1 text-[10.5px] text-subtle">
            {fc.current_month.days_elapsed} of{' '}
            {fc.current_month.days_elapsed + fc.current_month.days_remaining} days
          </p>
        )}
      </Kpi>

      <Kpi icon={TrendingUp} label="Projected month" tone="warning">
        <Amount value={projected} currency={currency} size="lg"
                reason={fc?.reason || 'Needs stored billing history.'} />
        {fc?.available ? (
          <p className="mt-1 flex items-center gap-1 text-[10.5px] text-subtle">
            Run-rate projection
            <Badge tone={fc.confidence === 'high' ? 'success'
              : fc.confidence === 'low' ? 'danger' : 'warning'} size="xs">
              {fc.confidence} confidence
            </Badge>
          </p>
        ) : (
          <p className="mt-1 text-[10.5px] text-subtle">Run-rate projection</p>
        )}
      </Kpi>

      <Kpi icon={PiggyBank} label="Potential savings" tone="success">
        <Amount
          value={savings}
          currency={savingsCurrency || currency}
          size="lg"
          reason="No savings could be priced from a provider price list."
        />
        <p className="mt-1 text-[10.5px] text-subtle">
          {optimizationCount || 0} opportunities
          {!isMissing(savings) && ' · priced from list rates'}
        </p>
      </Kpi>

      <Kpi icon={Coins} label="Month over month">
        {mom ? (
          <>
            <div className="flex items-center gap-2">
              <Amount value={mom.to_amount} currency={currency} size="lg" />
              <ChangeChip change={mom.percent} />
            </div>
            <p className="mt-1 text-[10.5px] text-subtle">
              {mom.from_month} → {mom.to_month}
              {mom.to_is_projection && ' (projected)'}
            </p>
          </>
        ) : (
          <>
            <Amount value={null} size="lg"
                    reason="Two complete months of stored history are needed." />
            <p className="mt-1 text-[10.5px] text-subtle">Needs 60 days of history</p>
          </>
        )}
      </Kpi>

      <Kpi icon={Database} label="History stored">
        <p className="text-[20px] font-bold tabular-nums text-fg">
          {coverage?.days_covered ?? 0}
          <span className="ml-1 text-[12px] font-medium text-muted">days</span>
        </p>
        <p className="mt-1 text-[10.5px] text-subtle">
          {coverage?.records?.toLocaleString() ?? 0} billing facts
        </p>
      </Kpi>

      <Kpi icon={Wallet} label="Unmatched records"
           tone={unmatchedCount ? 'warning' : 'neutral'}>
        <p className="text-[20px] font-bold tabular-nums text-fg">
          {unmatchedCount ?? 0}
        </p>
        <p className="mt-1 text-[10.5px] text-subtle">
          billed but not in inventory
        </p>
      </Kpi>

      <Kpi icon={Gauge} label="Data coverage"
           tone={quality?.quality === 'good' ? 'success'
             : quality?.quality === 'unavailable' ? 'danger' : 'warning'}>
        <p className="text-[20px] font-bold tabular-nums text-fg">
          {coverage?.has_history
            ? percent((coverage.records - coverage.provisional_records)
              / Math.max(1, coverage.records) * 100, 0)
            : '—'}
        </p>
        <p className="mt-1 text-[10.5px] text-subtle">
          settled vs provisional facts
        </p>
      </Kpi>
    </div>
  );
}
