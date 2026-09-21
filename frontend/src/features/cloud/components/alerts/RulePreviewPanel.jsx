import Badge from '@/components/ui/Badge';
import Icon from '@/components/ui/Icon';
import cn from '@/lib/cn';
import { ResultBadge } from './AlertPrimitives';

/**
 * The live WHEN / THEN / SEND preview.
 *
 * This exists to answer one question before anyone saves anything: *what
 * exactly will cause this email to arrive?* It is evaluated server-side
 * against real data as the user edits, so what it reports is not a
 * paraphrase of the form — it is the same evaluation the engine will run.
 *
 * Three things it is careful about:
 *
 *   An incomplete rule is "not ready yet", not an error. Half a threshold is
 *   an ordinary moment in typing, and a red panel there trains people to
 *   ignore red panels.
 *
 *   "Would fire now" and "would not fire now" are both useful and neither is
 *   a verdict on the rule. A rule that does not fire today is usually the
 *   correct one; a rule that fires the instant it is created usually wants a
 *   higher threshold. The wording says which is which without judging.
 *
 *   A rule that reaches nobody says so in the SEND line rather than leaving
 *   it blank — silence there reads as "fine".
 */
export default function RulePreviewPanel({ data, loading, error, className }) {
  if (error) {
    return (
      <div className={cn('rounded-control border border-border p-3', className)}>
        <p className="flex items-start gap-1.5 text-[11px] leading-snug text-muted">
          <Icon name="info" size={12} className="mt-0.5 shrink-0 text-subtle" />
          The preview could not be evaluated just now. This does not prevent you
          saving the rule — it only means this panel cannot show what it would
          do yet.
        </p>
      </div>
    );
  }

  if (!data && loading) {
    return (
      <div className={cn('space-y-2 rounded-control border border-border p-3', className)}>
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-4 animate-pulse rounded bg-sunken" />
        ))}
      </div>
    );
  }

  if (!data) return null;

  if (!data.ready) {
    return (
      <div className={cn('rounded-control border border-dashed border-border p-3',
        className)}
      >
        <p className="text-[11px] leading-snug text-muted">
          {data.reason || 'Finish the condition to see what this rule would do.'}
        </p>
        {data.supported === false && (
          <p className="mt-1.5 flex gap-1.5 text-[11px] leading-snug text-warning-fg">
            <Icon name="alert" size={12} className="mt-0.5 shrink-0" />
            This condition cannot be evaluated for this account.
          </p>
        )}
      </div>
    );
  }

  const s = data.summary || {};
  const fires = data.would_trigger;

  return (
    <div className={cn('rounded-control border border-border bg-sunken',
      loading && 'opacity-60 transition-opacity', className)}
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <span className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-subtle">
          <Icon name="eye" size={12} />
          Alert preview
        </span>
        {loading && (
          <Icon name="spinner" size={12} className="animate-spin text-subtle" />
        )}
      </div>

      <dl className="space-y-2 px-3 py-2.5">
        {[
          ['When', s.when],
          ['Then', s.then],
          ['Send', s.send],
          ['Cooldown', s.cooldown],
          ['On resolve', s.on_resolve],
        ].filter(([, v]) => v).map(([k, v]) => (
          <div key={k} className="flex gap-3">
            <dt className="w-20 shrink-0 text-[10px] font-bold uppercase tracking-wider text-subtle">
              {k}
            </dt>
            <dd className={cn(
              'min-w-0 text-[12px] leading-snug',
              k === 'Send' && !data.recipients?.to?.length
                ? 'text-warning-fg' : 'text-fg',
            )}
            >
              {v}
            </dd>
          </div>
        ))}
      </dl>

      {/* What the condition is doing RIGHT NOW, against real data. */}
      <div className="border-t border-border px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <ResultBadge state={data.result} />
          <span className="text-[12px] font-semibold text-fg">
            {fires
              ? 'This rule would fire right now'
              : data.result === 'NOT_TRIGGERED'
                ? 'This rule would not fire right now'
                : 'This rule cannot be evaluated right now'}
          </span>
        </div>

        <dl className="mt-1.5 flex flex-wrap gap-x-5 gap-y-1 text-[12px]">
          <div className="flex gap-1.5">
            <dt className="text-muted">Observed</dt>
            <dd className="font-semibold text-fg">
              {data.explain?.observed_label ?? 'NA'}
            </dd>
          </div>
          <div className="flex gap-1.5">
            <dt className="text-muted">Threshold</dt>
            <dd className="font-semibold text-fg">
              {data.explain?.threshold_label ?? 'NA'}
            </dd>
          </div>
        </dl>

        {data.explain?.detail && (
          <p className="mt-1.5 text-[11px] leading-snug text-muted">
            {data.explain.detail}
          </p>
        )}

        {/* The §50 line: how many things match, when the evaluator returned
            examples. Absent rather than "0 resources" when it did not — a
            count the evaluator never produced is not a zero. */}
        {!!data.samples?.length && (
          <div className="mt-2 border-t border-border pt-2">
            <p className="mb-1 text-[11px] text-muted">
              Currently matching{' '}
              <span className="font-semibold text-fg">
                {data.samples.length}
              </span>{' '}
              {data.samples.length === 1 ? 'item' : 'items'}
              {data.samples.length >= 5 ? ' (showing the first five)' : ''}:
            </p>
            <ul className="space-y-0.5">
              {data.samples.slice(0, 5).map((x, i) => (
                // eslint-disable-next-line react/no-array-index-key
                <li key={`${x.name}-${i}`} className="truncate text-[11px] text-fg">
                  {x.name}
                  {x.type && <span className="text-subtle"> · {x.type}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}

        {fires && (
          <p className="mt-2 flex gap-1.5 text-[11px] leading-snug text-muted">
            <Icon name="info" size={11} className="mt-0.5 shrink-0 text-subtle" />
            Saving this enabled will open an alert on the next evaluation. If
            that is not what you want, raise the threshold or add a minimum
            duration.
          </p>
        )}

        {data.warning && (
          <p className="mt-2 flex gap-1.5 text-[11px] leading-snug text-warning-fg">
            <Icon name="alert" size={11} className="mt-0.5 shrink-0" />
            {data.warning}
          </p>
        )}
      </div>

      <p className="border-t border-border px-3 py-1.5 text-[10px] text-subtle">
        Evaluated against live data. Nothing has been created or sent.
      </p>
    </div>
  );
}
