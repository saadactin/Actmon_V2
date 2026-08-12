import cn from '@/lib/cn';

/** On/off switch. */
export default function Switch({ checked, onChange, label, disabled, size = 'md' }) {
  const big = size === 'md';
  return (
    <button
      type="button"
      role="switch"
      aria-checked={!!checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange?.(!checked)}
      className={cn(
        'relative shrink-0 rounded-full outline-none transition-colors duration-[var(--dur-fast)]',
        // A tight, zero-offset ring instead of the app-wide `outline` (which
        // sits 2px outside the element with no background of its own) — that
        // gap was reading as a thin pale halo hugging the pill after a click
        // left it focused.
        'focus-visible:ring-2 focus-visible:ring-[var(--accent)]',
        'disabled:pointer-events-none disabled:opacity-50',
        big ? 'h-5 w-9' : 'h-4 w-7',
        checked ? 'bg-accent' : 'bg-strong',
      )}
    >
      <span
        className={cn(
          'absolute top-0.5 rounded-full bg-white shadow-sm transition-transform duration-[var(--dur-fast)]',
          big ? 'h-4 w-4' : 'h-3 w-3',
          checked
            ? big ? 'translate-x-[18px]' : 'translate-x-[14px]'
            : 'translate-x-0.5',
        )}
      />
    </button>
  );
}
