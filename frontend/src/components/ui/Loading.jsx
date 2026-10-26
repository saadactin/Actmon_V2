import { useEffect, useRef, useState } from 'react';
import cn from '@/lib/cn';
import Actmon3DLoader from '@/components/loader/Actmon3DLoader';
import { variantForPath } from '@/components/loader/loaderVariants';

/**
 * LOADING STATES — one definition, so waiting looks the same everywhere.
 *
 * These pages had grown ~100 hand-rolled spinner blocks, and the full-page ones
 * painted their own dark gradient slab (`linear-gradient(135deg,#0f172a …)`) with
 * light text on it. In a light theme that reads as a broken page rather than a
 * page that is loading, and it ignores the operator's theme, accent and density
 * completely.
 *
 * Everything here is token-driven, so a loading state inherits the current theme
 * and accent like the rest of the app.
 *
 *   <Spinner />                       the primitive
 *   <MonitorPulse />                  radar-ping loader (compact spots)
 *   <PageLoading title subtitle />    a whole page or tab with nothing to show yet
 *                                     — shows the mascot illustration by default
 *   <InlineLoading label />           a panel, table or card area
 */

const SIZES = { sm: 'h-4 w-4 border-2', md: 'h-6 w-6 border-2', lg: 'h-10 w-10 border-[3px]' };

/** Ring spinner. The track is the border colour, the head is the accent. */
export function Spinner({ size = 'md', className }) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={cn(
        'inline-block animate-spin rounded-full border-border',
        SIZES[size] || SIZES.md,
        className,
      )}
      style={{ borderTopColor: 'var(--accent)' }}
    />
  );
}

const PULSE_PX = { sm: 26, md: 36, lg: 52 };

/**
 * "Radar ping" loader — two expanding rings radiating from a steady,
 * heartbeat-pulsing centre dot. Used by PageLoading/InlineLoading in place
 * of the plain ring Spinner so a real, multi-second wait on live telemetry
 * reads as "actively monitoring" rather than "frozen." See the
 * `monitor-ping`/`monitor-heartbeat` keyframes in styles/index.css for the
 * reduced-motion rest state.
 */
export function MonitorPulse({ size = 'md', className }) {
  const px = PULSE_PX[size] || PULSE_PX.md;
  const dot = Math.round(px * 0.34);
  return (
    <span
      role="status"
      aria-label="Loading"
      className={cn('relative inline-grid shrink-0 place-items-center', className)}
      style={{ width: px, height: px }}
    >
      <span className="monitor-ring absolute inset-0 rounded-full border-2" style={{ borderColor: 'var(--accent)' }} />
      <span className="monitor-ring monitor-ring-delay absolute inset-0 rounded-full border-2" style={{ borderColor: 'var(--accent)' }} />
      <span className="monitor-dot rounded-full" style={{ width: dot, height: dot, background: 'var(--accent)' }} />
    </span>
  );
}

/** Tiny "live metrics" equalizer — 3 bars ticking at staggered offsets, a
 * small visual cue that something is actively working behind the label. */
export function MonitorBars({ className }) {
  return (
    <span className={cn('inline-flex items-end gap-[3px]', className)} style={{ height: 13 }} aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="monitor-bar w-[3px] rounded-full"
          style={{ height: '100%', background: 'var(--accent)', animationDelay: `${i * 0.16}s` }}
        />
      ))}
    </span>
  );
}

/**
 * A page or tab that has nothing to render yet.
 *
 * Sits in the content flow on the page background — it does NOT take over the
 * viewport. A loader that covers the screen hides the chrome the operator uses to
 * navigate away, which is the wrong thing to do while they wait.
 */
/**
 * `steps`: an optional array of short strings describing what's actually
 * happening while this waits (e.g. the real things being fetched in
 * parallel behind it) — cycled one at a time so a genuinely multi-second
 * wait reads as visible progress instead of one frozen message. Purely
 * cosmetic pacing (it doesn't track real completion of each step), so only
 * pass steps that are all true for the whole duration of the wait — never
 * imply something finished that hasn't.
 *
 * `illustration`: shows the mascot loading illustration above the text
 * instead of the plain radar pulse. On by default — pass `illustration={false}`
 * for the rare spot too tight for it (e.g. inside a small modal).
 */
export function PageLoading({
  title = 'Loading…', subtitle, steps, stepSeconds = 1.4, className, minHeight, illustration = true,
  variant, delayMs = 220, done = false, failed = false, nodes,
}) {
  /* Waits shorter than this never show the composition: a 3D scene flashing
     up for a 100 ms request is flicker, not feedback. The space is held, so
     the layout does not jump when it does appear. */
  const [shown, setShown] = useState(delayMs <= 0);
  useEffect(() => {
    if (delayMs <= 0) return undefined;
    const t = setTimeout(() => setShown(true), delayMs);
    return () => clearTimeout(t);
  }, [delayMs]);

  if (!illustration) {
    return <CompactPageLoading {...{ title, subtitle, steps, stepSeconds, className, minHeight: minHeight ?? 460 }} />;
  }

  /* Inside the content area only — the nav, page header, tabs and instance
     picker above stay visible and usable. The context (database, cloud,
     infrastructure…) follows the route, so only the subsystems this page
     actually queries are drawn. No task is registered, so the bar is
     indeterminate and no percentage is shown. */
  const ctx = variant || variantForPath(typeof window !== 'undefined' ? window.location.pathname : '');
  return (
    <div className={cn('w-full', className)} aria-live="polite" aria-busy="true">
      {shown
        ? (
          <Actmon3DLoader variant={ctx} title={title} fullscreen={false} minHeight={minHeight}
            done={done} failed={failed} nodes={nodes} />
        )
        : <div style={{ height: minHeight ?? 'clamp(440px, calc(100vh - 290px), 720px)' }} />}
      {shown && (steps?.length || subtitle) && (
        <p className="mt-2 flex items-center justify-center gap-2 text-[13px] text-muted">
          <MonitorBars />
          <CyclingStep steps={steps} subtitle={subtitle} stepSeconds={stepSeconds} />
        </p>
      )}
    </div>
  );
}

/**
 * Keeps a page's loader mounted for the short reveal (stage 10) after its
 * request SUCCEEDS — and only then.
 *
 *   const reveal = useLoaderReveal(isLoading, { ok: !error });
 *   if (reveal.show) return <PageLoading done={reveal.done} … />;
 *
 * No reveal when the request failed (the page's error UI appears at once),
 * and none when the loader never became visible (a fast request) — so a
 * quick load is never held back to play an animation.
 */
export function useLoaderReveal(loading, { ok = true, ms = 520, delayMs = 220 } = {}) {
  const startedAt = useRef(loading ? Date.now() : null);
  const [prev, setPrev] = useState(loading);
  const [exiting, setExiting] = useState(false);

  // Derived during render (not in an effect), so the dashboard never paints
  // for one frame before the reveal starts.
  if (prev !== loading) {
    setPrev(loading);
    if (loading) startedAt.current = Date.now();
    else if (ok && startedAt.current && Date.now() - startedAt.current > delayMs) setExiting(true);
  }

  useEffect(() => {
    if (!exiting) return undefined;
    const t = setTimeout(() => setExiting(false), ms);
    return () => clearTimeout(t);
  }, [exiting, ms]);

  return { show: loading || exiting, done: !loading && exiting };
}

/** The radar-pulse version, for the few places too tight for the composition
 *  (a small modal, a popover). Its own component so PageLoading's branch above
 *  does not sit in front of this one's hooks. */
function CompactPageLoading({ title, subtitle, steps, stepSeconds, className, minHeight }) {
  return (
    <div
      className={cn('grid w-full place-items-center', className)}
      style={{ minHeight }}
      aria-live="polite"
    >
      <div className="text-center">
        <MonitorPulse size="lg" className="mx-auto" />
        <p className="mt-1 text-[15px] font-semibold text-fg">{title}</p>
        {(steps?.length > 0 || subtitle) && (
          <p className="mt-1 flex items-center justify-center gap-2 text-[13px] text-muted">
            <MonitorBars />
            <CyclingStep steps={steps} subtitle={subtitle} stepSeconds={stepSeconds} />
          </p>
        )}
      </div>
    </div>
  );
}

/** The optional "what is happening" line. Its own component because the hook
 *  that cycles it cannot live after PageLoading's early return. */
function CyclingStep({ steps, subtitle, stepSeconds = 1.4 }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (!steps || steps.length < 2) return undefined;
    const t = setInterval(() => setI((x) => (x + 1) % steps.length), stepSeconds * 1000);
    return () => clearInterval(t);
  }, [steps, stepSeconds]);
  return <>{steps?.length ? steps[i % steps.length] : subtitle}</>;
}

/** A panel, table or card that is filling in. Compact, no layout jump. */
export function InlineLoading({ label = 'Loading…', className, size = 'sm' }) {
  return (
    <div className={cn('flex items-center justify-center gap-2.5 py-8', className)} aria-live="polite">
      <MonitorPulse size={size === 'lg' ? 'lg' : 'md'} />
      <span className="text-[13px] text-muted">{label}</span>
      <MonitorBars />
    </div>
  );
}

export default PageLoading;
