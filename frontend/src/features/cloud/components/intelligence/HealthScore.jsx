import cn from '@/lib/cn';
import { healthText, healthTone } from '../../utils/intelligenceModel';

const BAR = {
  success: 'bg-success', warning: 'bg-warning', danger: 'bg-danger', neutral: 'bg-neutral-soft',
};
const TEXT = {
  success: 'text-success-fg', warning: 'text-warning-fg', danger: 'text-danger-fg', neutral: 'text-muted',
};

/**
 * Resource health, per dimension, only where a check decided something.
 * A dimension with no evidence reads N/A with the reason — never 100, which
 * would be the most flattering and least true number on the page.
 */
export default function HealthScore({ health }) {
  if (!health) {
    return <p className="text-[12px] text-muted">Health is shown once the resource has been analyzed.</p>;
  }
  const dims = Object.entries(health.dimensions || {});
  const overallTone = healthTone(health.overall);
  return (
    <div>
      <div className="mb-3 flex items-end justify-between gap-3">
        <div>
          <div className="text-meta font-semibold uppercase tracking-wider text-muted">Overall</div>
          <div className={cn('text-[26px] font-bold tabular-nums', TEXT[overallTone])}>
            {healthText(health.overall)}
            {health.overall !== null && health.overall !== undefined && (
              <span className="text-[13px] font-semibold text-muted"> / 100</span>
            )}
          </div>
        </div>
        <p className="max-w-[18rem] text-right text-meta leading-relaxed text-subtle" title={health.methodology}>
          {health.overall_reason || health.basis}
        </p>
      </div>
      <ul className="space-y-2">
        {dims.map(([key, d]) => {
          const tone = healthTone(d.score);
          return (
            <li key={key}>
              <div className="flex items-center gap-3 text-[12px]">
                <span className="w-28 shrink-0 text-fg">{d.label}</span>
                <span className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--chart-track)]">
                  {d.score !== null && d.score !== undefined && (
                    <span className={cn('block h-2 rounded-full', BAR[tone])} style={{ width: `${Math.max(3, d.score)}%` }} />
                  )}
                </span>
                <span className={cn('w-10 text-right font-bold tabular-nums', TEXT[tone])}>{healthText(d.score)}</span>
              </div>
              {d.score === null || d.score === undefined ? (
                <p className="ml-[7.75rem] mt-0.5 text-meta text-subtle">{d.reason}</p>
              ) : d.open_findings > 0 ? (
                <p className="ml-[7.75rem] mt-0.5 text-meta text-subtle">
                  {d.open_findings} open finding{d.open_findings === 1 ? '' : 's'} · {d.checks} check{d.checks === 1 ? '' : 's'}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
