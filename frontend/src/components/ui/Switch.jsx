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
        'relative shrink-0 overflow-hidden rounded-full outline-none transition-colors duration-[var(--dur-fast)]',
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
          // `left-0.5` is load-bearing, not decorative: this span has no
          // sibling and no explicit `left`/`right` of its own otherwise, so
          // its horizontal start position falls back to CSS's "static
          // position" — which is relative to the BUTTON's content box, not
          // its padding/border box. A `<button>` gets a few px of default
          // UA-stylesheet padding that Tailwind's preflight does not zero
          // out, so without an explicit `left`, that default padding shifted
          // the thumb's whole coordinate system rightward by that amount —
          // fine (if asymmetric) when unchecked, but enough to push the
          // thumb's right edge past the track's own right edge once checked,
          // where `overflow-hidden` then sliced the circle in half. Anchoring
          // explicitly at `left-0.5` removes that ambiguity: the translate
          // distances below are now relative to a fixed, known start point
          // regardless of any browser's default button padding.
          'absolute top-0.5 left-0.5 rounded-full bg-white shadow-sm transition-transform duration-[var(--dur-fast)]',
          big ? 'h-4 w-4' : 'h-3 w-3',
          checked
            // rem, not px: the track/thumb sizes above are rem-based and scale
            // with the app's Appearance → Font Size setting. A fixed px slide
            // distance stays put while the track scales around it, so at any
            // scale other than 100% the thumb lands outside the track's right
            // edge once checked. These are the distance from the thumb's
            // `left-0.5` anchor to its checked position, leaving the same
            // 2px margin on the right as `left-0.5` leaves on the left:
            // track − thumb − 2×margin = 36−16−4=16px (1rem) for the default
            // size, 28−12−4=12px (0.75rem) for the small size.
            ? big ? 'translate-x-4' : 'translate-x-3'
            : 'translate-x-0',
        )}
      />
    </button>
  );
}
