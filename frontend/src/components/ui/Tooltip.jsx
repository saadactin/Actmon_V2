import { useCallback, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import cn from '@/lib/cn';

/**
 * Tooltip that renders into a portal with fixed positioning.
 *
 * The portal matters: the collapsed sidebar scrolls (`overflow-y: auto`), so an
 * in-flow tooltip would be clipped by the rail. Positioning is measured on hover
 * rather than tracked continuously — good enough for a hover affordance and it
 * costs nothing while idle.
 */
export default function Tooltip({
  label,
  children,
  side = 'right',
  delay = 250,
  disabled = false,
  className,
  /** Applied to the anchor. Needed when the anchor is itself a flex/grid item —
      the wrapper becomes the layout child, so sizing must land on it. */
  style,
}) {
  const [pos, setPos] = useState(null);
  const timer = useRef(null);
  const anchor = useRef(null);
  const id = useId();

  const show = useCallback(() => {
    if (disabled || !label) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const el = anchor.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const gap = 10;
      const next =
        side === 'right' ? { top: r.top + r.height / 2, left: r.right + gap, tx: '0, -50%' }
        : side === 'left' ? { top: r.top + r.height / 2, left: r.left - gap, tx: '-100%, -50%' }
        : side === 'top' ? { top: r.top - gap, left: r.left + r.width / 2, tx: '-50%, -100%' }
        : { top: r.bottom + gap, left: r.left + r.width / 2, tx: '-50%, 0' };
      setPos(next);
    }, delay);
  }, [delay, disabled, label, side]);

  const hide = useCallback(() => {
    clearTimeout(timer.current);
    setPos(null);
  }, []);

  return (
    <>
      <span
        ref={anchor}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        aria-describedby={pos ? id : undefined}
        /* inline-flex, not `contents` — a display:contents element has no box, so
           getBoundingClientRect() would return zeros and the tooltip would land
           in the top-left corner. */
        className={cn('inline-flex', className)}
        style={style}
      >
        {children}
      </span>

      {pos
        && createPortal(
          <div
            id={id}
            role="tooltip"
            className="pointer-events-none fixed z-[100] max-w-xs rounded-md bg-inverse px-2.5 py-1.5 text-xs font-medium whitespace-nowrap text-on-inverse shadow-lg anim-fade-in"
            style={{ top: pos.top, left: pos.left, transform: `translate(${pos.tx})` }}
          >
            {label}
          </div>,
          document.body,
        )}
    </>
  );
}
