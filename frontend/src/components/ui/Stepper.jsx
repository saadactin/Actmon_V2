import cn from '@/lib/cn';
import Icon from './Icon';

/**
 * Numbered step indicator for wizard-style dialogs — shared by every
 * multi-step editor (notification templates, alert rules) so they all read
 * the same way. `steps` = [{ n, label }], 1-indexed; `step` = current n.
 */
export default function Stepper({ steps, step }) {
  return (
    <div className="mb-5 flex flex-wrap items-center gap-2">
      {steps.map((s, i) => (
        <div key={s.n} className="flex items-center gap-2">
          <span
            className={cn(
              'grid h-7 w-7 shrink-0 place-items-center rounded-full border text-[12px] font-bold',
              step === s.n
                ? 'border-accent bg-accent text-accent-fg'
                : step > s.n
                  ? 'border-accent-border bg-accent-soft text-accent-text'
                  : 'border-border text-subtle',
            )}
          >
            {step > s.n ? <Icon name="check" size={13} strokeWidth={3} /> : s.n}
          </span>
          <span className={cn('text-[12px] font-semibold whitespace-nowrap', step === s.n ? 'text-fg' : 'text-subtle')}>
            {s.label}
          </span>
          {i < steps.length - 1 && <span className="mx-1 h-px w-8 shrink-0 bg-border sm:w-14" />}
        </div>
      ))}
    </div>
  );
}
