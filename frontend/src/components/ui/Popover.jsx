import { useEffect, useRef } from 'react';
import cn from '@/lib/cn';

/**
 * Anchored dropdown panel with click-away and Escape handling.
 *
 * Deliberately unstyled beyond the surface tokens so callers decide the content.
 * Wrap it in a `relative` parent; `align` picks which edge it hangs off.
 */
export default function Popover({
  open,
  onClose,
  align = 'right',
  /** 'bottom' hangs below the trigger, 'top' above it (for bottom-anchored triggers). */
  side = 'bottom',
  width = 300,
  className,
  children,
}) {
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose?.();
    };
    document.addEventListener('keydown', onKey);
    // `mousedown` (not click) so the panel closes before a re-render swallows the event
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      ref={ref}
      role="dialog"
      className={cn(
        'absolute z-50 overflow-hidden rounded-xl border border-border bg-surface shadow-lg anim-pop-in',
        align === 'right' ? 'right-0' : 'left-0',
        className,
      )}
      /* Offsets live in `style`, not utilities — a caller passing `top-auto`
         via className can't reliably beat an arbitrary-value utility, since CSS
         order decides the winner rather than class-attribute order. */
      style={
        side === 'top'
          ? { width, bottom: 'calc(100% + 8px)' }
          : { width, top: 'calc(100% + 8px)' }
      }
    >
      {children}
    </div>
  );
}
