import { useEffect, useState } from 'react';

/**
 * Development-only layout diagnostics: viewport, effective zoom, breakpoint,
 * and anything spilling past the right edge.
 *
 * Browser zoom shrinks the viewport in CSS pixels, so "it breaks at 150%" is a
 * width problem, and this shows the width you are actually laying out at.
 * Off by default; `?rdebug=1` turns it on (remembered), `?rdebug=0` off.
 * Never rendered in a production build — AppShell gates it on
 * `import.meta.env.DEV`, and Vite strips the branch.
 *
 * The same checks run headless across every page and zoom level in
 * `frontend/tests/zoom_audit.mjs`.
 */
const KEY = 'actmon.debug.responsive';

// Tailwind v4's default breakpoints — what `sm:` … `2xl:` resolve against.
const BREAKPOINTS = [['2xl', 1536], ['xl', 1280], ['lg', 1024], ['md', 768], ['sm', 640]];
const breakpointOf = (w) => (BREAKPOINTS.find(([, min]) => w >= min) || ['base'])[0];

function readEnabled() {
  try {
    const p = new URLSearchParams(window.location.search).get('rdebug');
    if (p === '1') localStorage.setItem(KEY, '1');
    if (p === '0') localStorage.removeItem(KEY);
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

/** Visible elements past the right edge with no scrolling ancestor to reach them. */
function findOffenders() {
  const vw = document.documentElement.clientWidth;
  const main = document.querySelector('main');
  const out = [];
  for (const el of document.querySelectorAll('main *')) {
    if (el.tagName !== 'svg' && el.closest('svg')) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || r.right <= vw + 1 || r.left >= vw) continue;
    let a = el.parentElement;
    let rescued = false;
    while (a && a !== main) {
      const o = getComputedStyle(a).overflowX;
      if (o === 'auto' || o === 'scroll') { rescued = true; break; }
      a = a.parentElement;
    }
    if (rescued || out.some((o) => o.contains(el))) continue;
    out.push(el);
  }
  return out;
}

export default function ResponsiveDebug() {
  const [enabled] = useState(readEnabled);
  const [info, setInfo] = useState(null);
  const [highlight, setHighlight] = useState(false);

  useEffect(() => {
    if (!enabled) return undefined;
    let marked = [];
    const measure = () => {
      const main = document.querySelector('main');
      const offenders = findOffenders();
      marked.forEach((el) => { el.style.outline = ''; });
      marked = highlight ? offenders : [];
      marked.forEach((el) => { el.style.outline = '2px solid #e11d48'; });
      setInfo({
        w: document.documentElement.clientWidth,
        h: window.innerHeight,
        dpr: window.devicePixelRatio,
        overflow: main ? Math.max(0, main.scrollWidth - main.clientWidth) : 0,
        offenders: offenders.length,
      });
    };
    measure();
    const id = setInterval(measure, 1500);
    window.addEventListener('resize', measure);
    return () => {
      clearInterval(id);
      window.removeEventListener('resize', measure);
      marked.forEach((el) => { el.style.outline = ''; });
    };
  }, [enabled, highlight]);

  if (!enabled || !info) return null;
  const bad = info.overflow > 1 || info.offenders > 0;

  return (
    <div
      className="fixed bottom-2 left-2 z-[100] rounded-control border border-border bg-surface px-3 py-2 font-mono text-meta text-fg shadow-lg"
      role="status"
      aria-label="Responsive debug"
    >
      <div className="font-bold">Responsive debug</div>
      <div>Viewport {info.w} × {info.h} · {info.dpr.toFixed(2)}× · {breakpointOf(info.w)}</div>
      <div className={bad ? 'text-danger-fg' : 'text-success-fg'}>
        Horizontal overflow {info.overflow ? `${info.overflow}px` : 'none'} · outside viewport {info.offenders}
      </div>
      <label className="mt-1 flex items-center gap-1.5">
        <input type="checkbox" checked={highlight} onChange={(e) => setHighlight(e.target.checked)} />
        outline offenders
      </label>
    </div>
  );
}
