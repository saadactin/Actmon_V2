import cn from '@/lib/cn';
import Icon from './Icon';

/**
 * Numbered step indicator — same shape as the existing wizard stepper (circles,
 * connectors, done ticks), drawn from tokens so it follows the theme.
 */
export default function Steps({ steps, current, className }) {
  return (
    <ol className={cn('no-scrollbar flex items-center overflow-x-auto', className)}>
      {steps.map((label, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li key={label} className="flex min-w-0 shrink-0 items-center">
            <span className="flex items-center gap-2">
              <span
                className={cn(
                  'grid h-7 w-7 shrink-0 place-items-center rounded-full text-[11px] font-bold transition-colors',
                  done ? 'bg-success text-white'
                    : active ? 'bg-accent text-accent-fg'
                      : 'border border-strong bg-surface text-subtle',
                )}
              >
                {done ? <Icon name="check" size={13} strokeWidth={3} /> : i + 1}
              </span>
              <span
                className={cn(
                  'truncate-safe text-[12px] font-semibold whitespace-nowrap',
                  active ? 'text-fg' : done ? 'text-muted' : 'text-subtle',
                )}
              >
                {label}
              </span>
            </span>
            {i < steps.length - 1 && (
              <span
                className={cn('mx-2.5 h-px w-8 shrink-0', done ? 'bg-success' : 'bg-border')}
                aria-hidden="true"
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}
