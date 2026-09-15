import { useEffect, useRef, useState } from 'react';

const easeOutCubic = (t) => 1 - (1 - t) ** 3;

/**
 * Animates a displayed number counting up from 0 (or its previous value) to
 * `value` whenever `value` changes — the animated-counter effect used across
 * the dashboard's KPI tiles and gauges.
 *
 * Respects `prefers-reduced-motion`: jumps straight to the final value with
 * no animation rather than skip the feature outright, since the number is
 * still the whole point of the tile.
 */
export default function useCountUp(value, { duration = 900 } = {}) {
  const target = Number.isFinite(value) ? value : 0;
  const [display, setDisplay] = useState(target);
  const fromRef = useRef(target);
  const rafRef = useRef(null);

  useEffect(() => {
    const reduceMotion = typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion) { setDisplay(target); fromRef.current = target; return undefined; }

    const from = fromRef.current;
    if (from === target) return undefined;

    let start = null;
    function frame(ts) {
      if (start === null) start = ts;
      const p = Math.min(1, (ts - start) / Math.max(duration, 1));
      setDisplay(from + (target - from) * easeOutCubic(p));
      if (p < 1) { rafRef.current = requestAnimationFrame(frame); } else { fromRef.current = target; setDisplay(target); }
    }
    rafRef.current = requestAnimationFrame(frame);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, duration]);

  return display;
}
