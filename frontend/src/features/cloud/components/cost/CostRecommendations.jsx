/**
 * The Optimize tab: savings summary, category rollup and the ranked list.
 *
 * The savings header is three separate figures on purpose. "Potential savings:
 * X" as one number is the single easiest place for this product to mislead,
 * because it silently merges a saving priced from a provider's own price list
 * with one somebody guessed, and drops everything that could not be priced at
 * all. Verified, estimated and unquantified stay apart, and each currency
 * stays apart from the others.
 */
import { useState } from 'react';
import cn from '@/lib/cn';
import Badge from '@/components/ui/Badge';
import CloudSection from '../CloudSection';
import {
  AlertTriangle, CheckCircle2, ChevronRight, CircleDashed, Gauge, Info,
  PiggyBank, ShieldQuestion,
} from 'lucide-react';
import { compact, exact, isMissing } from '../../utils/costFormat';

const CONFIDENCE_TONE = { HIGH: 'success', MEDIUM: 'warning', LOW: 'neutral' };
const SEVERITY_TONE = {
  CRITICAL: 'danger', HIGH: 'danger', MEDIUM: 'warning', LOW: 'info',
};
const STATE_TONE = {
  NEW: 'accent', REVIEWED: 'info', ACCEPTED: 'info',
  IN_PROGRESS: 'warning', IMPLEMENTED: 'success', DISMISSED: 'neutral',
};

/** Verified / estimated / unquantified — never one merged number. */
export function SavingsSummary({ summary }) {
  if (!summary) return null;
  const verified = Object.entries(summary.verified_by_currency || {});
  const estimated = Object.entries(summary.estimated_by_currency || {});

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
      <div className="rounded-card border border-border bg-surface p-3.5">
        <p className="flex items-center gap-1.5 text-[10.5px] font-bold uppercase tracking-wider text-muted">
          <CheckCircle2 size={12} className="text-success-fg" aria-hidden />
          Verified savings
        </p>
        {verified.length ? (
          <div className="mt-1.5 space-y-0.5">
            {verified.map(([code, value]) => (
              <p key={code} className="text-[19px] font-bold tabular-nums text-fg"
                 title={exact(value, code)}>
                {compact(value, code)}
              </p>
            ))}
          </div>
        ) : (
          <p className="mt-1.5 text-[19px] font-bold text-muted">NA</p>
        )}
        <p className="mt-1 text-[10.5px] text-subtle">
          priced from a provider price list
        </p>
      </div>

      <div className="rounded-card border border-border bg-surface p-3.5">
        <p className="flex items-center gap-1.5 text-[10.5px] font-bold uppercase tracking-wider text-muted">
          <Gauge size={12} className="text-warning-fg" aria-hidden />
          Estimated savings
        </p>
        {estimated.length ? (
          <div className="mt-1.5 space-y-0.5">
            {estimated.map(([code, value]) => (
              <p key={code} className="text-[19px] font-bold tabular-nums text-fg"
                 title={exact(value, code)}>
                {compact(value, code)}
              </p>
            ))}
          </div>
        ) : (
          <p className="mt-1.5 text-[19px] font-bold text-muted">NA</p>
        )}
        <p className="mt-1 text-[10.5px] text-subtle">
          priced by another basis
        </p>
      </div>

      <div className="rounded-card border border-border bg-surface p-3.5">
        <p className="flex items-center gap-1.5 text-[10.5px] font-bold uppercase tracking-wider text-muted">
          <ShieldQuestion size={12} className="text-subtle" aria-hidden />
          Unquantified
        </p>
        <p className="mt-1.5 text-[19px] font-bold tabular-nums text-fg">
          {summary.unquantified_count ?? 0}
        </p>
        <p className="mt-1 text-[10.5px] text-subtle">
          real opportunities that cannot be priced
        </p>
      </div>
    </div>
  );
}

/** Savings by category. Bars are per-currency so nothing is summed across. */
export function SavingsByCategory({ categories }) {
  if (!categories?.length) return null;
  const maxCount = Math.max(...categories.map((c) => c.count), 1);
  return (
    <ul className="space-y-1.5">
      {categories.map((c) => (
        <li key={c.category} className="flex items-center gap-3 text-[12px]">
          <span className="w-44 shrink-0 truncate text-fg">{c.category}</span>
          <span className="h-2 flex-1 rounded-full bg-[var(--chart-track)]">
            <span
              className="block h-2 rounded-full bg-[var(--chart-3)]"
              style={{ width: `${Math.max(3, (c.count / maxCount) * 100)}%` }}
            />
          </span>
          <span className="w-8 text-right tabular-nums text-muted">{c.count}</span>
          <span className="w-32 text-right tabular-nums text-fg">
            {Object.entries(c.savings_by_currency || {}).length
              ? Object.entries(c.savings_by_currency)
                .map(([code, v]) => compact(v, code)).join(' · ')
              : <span className="text-subtle">NA</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** One recommendation row, expandable into its full actionability block. */
function RecommendationRow({ r, onOpen }) {
  const [open, setOpen] = useState(false);
  const act = r.actionability || {};
  return (
    <li className={cn(
      'rounded-card border border-border bg-surface border-l-4',
      r.severity === 'CRITICAL' || r.severity === 'HIGH' ? 'border-l-danger'
        : r.severity === 'MEDIUM' ? 'border-l-warning' : 'border-l-info',
      r.state === 'DISMISSED' && 'opacity-60',
    )}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-start gap-3 p-3 text-left"
      >
        <span className="flex w-10 shrink-0 flex-col items-center">
          <span className="text-[15px] font-bold tabular-nums text-fg">
            {r.priority_score}
          </span>
          <span className="text-[9px] uppercase tracking-wide text-subtle">score</span>
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="text-[13px] font-semibold text-fg">{r.title}</span>
            <Badge tone={SEVERITY_TONE[r.severity] || 'info'} size="xs">{r.severity}</Badge>
            <Badge tone={CONFIDENCE_TONE[r.confidence] || 'neutral'} size="xs">
              {r.confidence} confidence
            </Badge>
            <Badge tone="outline" size="xs">{r.category}</Badge>
            {r.state && r.state !== 'NEW' && (
              <Badge tone={STATE_TONE[r.state] || 'neutral'} size="xs">{r.state}</Badge>
            )}
          </span>
          <span className="mt-0.5 block text-[11.5px] leading-relaxed text-muted">
            {r.description}
          </span>
          <span className="mt-1 block text-[10.5px] text-subtle">
            {r.affected_resource} · effort {r.effort} · risk {r.risk}
          </span>
        </span>

        <span className="shrink-0 text-right">
          <span className="block text-[14px] font-bold tabular-nums text-fg">
            {isMissing(r.potential_savings)
              ? <span className="text-muted">NA</span>
              : compact(r.potential_savings, r.savings_currency)}
          </span>
          <span className="block text-[10px] text-subtle">
            {isMissing(r.potential_savings) ? 'not priceable' : 'per month'}
          </span>
        </span>
        <ChevronRight
          size={15}
          className={cn('mt-1 shrink-0 text-subtle transition-transform',
            open && 'rotate-90')}
          aria-hidden
        />
      </button>

      {open && (
        <div className="space-y-3 border-t border-border px-3 py-3">
          <dl className="space-y-2 text-[11.5px] leading-relaxed">
            {[['Why', act.why], ['What to change', act.action],
              ['Expected impact', act.expected_impact], ['Risk', act.risk],
              ['How', act.how]].map(([label, value]) => (
              <div key={label}>
                <dt className="font-bold uppercase tracking-wider text-[10px] text-muted">
                  {label}
                </dt>
                <dd className="text-fg">
                  {value || <span className="text-subtle">Not documented for this rule.</span>}
                </dd>
              </div>
            ))}
          </dl>

          {/* The calculation, when there is one. A savings figure with no
              visible arithmetic is a number to be taken on faith. */}
          {(r.savings_breakdown || []).length > 0 && (
            <div className="rounded-control border border-border bg-sunken p-2.5">
              <p className="mb-1 text-[10px] font-bold uppercase tracking-wider text-muted">
                Calculation
              </p>
              <ul className="space-y-0.5 text-[11.5px] tabular-nums text-fg">
                {r.savings_breakdown.map((line, i) => (
                  <li key={i} className="flex justify-between gap-3">
                    <span className="text-muted">{line.label || line.description}</span>
                    <span>{exact(line.amount ?? line.cost, r.savings_currency)}</span>
                  </li>
                ))}
              </ul>
              {r.savings_source && (
                <p className="mt-1.5 border-t border-border pt-1.5 text-[10.5px] text-subtle">
                  {r.savings_source}
                </p>
              )}
            </div>
          )}

          {(r.savings_assumptions || []).length > 0 && (
            <div>
              <p className="mb-1 text-[10px] font-bold uppercase tracking-wider text-muted">
                Assumptions
              </p>
              <ul className="list-disc space-y-0.5 pl-4 text-[11.5px] text-muted">
                {r.savings_assumptions.map((a, i) => <li key={i}>{a}</li>)}
              </ul>
            </div>
          )}

          <div className="rounded-control border border-border bg-sunken p-2.5 text-[11px] text-muted">
            <p className="flex items-center gap-1.5 font-semibold text-fg">
              <Info size={11} aria-hidden /> Utilization
            </p>
            <p className="mt-0.5 leading-relaxed">{r.utilization?.reason}</p>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 text-[10.5px] text-subtle">
            <span>Last checked {new Date(r.last_verified).toLocaleString('en-GB')}</span>
            <span title={r.priority_formula} className="cursor-help underline decoration-dotted">
              How is the score calculated?
            </span>
          </div>
        </div>
      )}
    </li>
  );
}

export default function CostRecommendations({
  recommendations, savingsSummary, savingsByCategory,
}) {
  const [showClosed, setShowClosed] = useState(false);
  const rows = (recommendations || []).filter(
    (r) => showClosed || !['DISMISSED', 'IMPLEMENTED'].includes(r.state),
  );

  return (
    <div className="space-y-4">
      <SavingsSummary summary={savingsSummary} />

      {savingsSummary?.note && (
        <p className="rounded-control border border-border bg-sunken p-2.5 text-[11px] leading-relaxed text-muted">
          <Info size={11} className="mr-1 inline align-[-1px]" aria-hidden />
          {savingsSummary.note}
        </p>
      )}

      {savingsByCategory?.length > 0 && (
        <CloudSection title="Opportunities by category">
          <SavingsByCategory categories={savingsByCategory} />
        </CloudSection>
      )}

      <CloudSection
        title="Ranked opportunities"
        description="Ordered by a published score combining savings, confidence, effort, risk and severity — not by severity alone"
        action={(
          <label className="flex items-center gap-1.5 text-[11.5px] text-muted">
            <input
              type="checkbox"
              checked={showClosed}
              onChange={(e) => setShowClosed(e.target.checked)}
              className="accent-[var(--accent)]"
            />
            Show dismissed &amp; implemented
          </label>
        )}
      >
        {rows.length ? (
          <ul className="space-y-2">
            {rows.map((r) => (
              <RecommendationRow key={r.recommendation_id || r.id} r={r} />
            ))}
          </ul>
        ) : (
          <div className="rounded-control border border-dashed border-border bg-sunken p-6 text-center">
            <PiggyBank size={20} className="mx-auto mb-2 text-subtle" aria-hidden />
            <p className="text-[13px] font-medium text-fg">
              No open optimization opportunities
            </p>
            <p className="mt-1 text-[11.5px] text-muted">
              Nothing in the current inventory matches an optimization rule.
            </p>
          </div>
        )}
      </CloudSection>
    </div>
  );
}
