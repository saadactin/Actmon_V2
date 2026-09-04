import { useEffect, useState } from 'react';
import cn from '@/lib/cn';

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

// 5-frame mascot "story" — same character pulling the loading bar further
// each frame, ending on a "Complete!" beat, then looping. Pre-converted to
// WebP (was ~1.3MB/frame as PNG, ~55KB/frame as WebP — same look, a
// fraction of the weight for an asset that repeats while waiting).
const LOADER_FRAMES = [1, 2, 3, 4, 5].map((n) => encodeURI(`/loader annimation/loader${n}.webp`));
// Boundaries — which frame is showing for a given live percentage. The last
// one is 100 (not e.g. 95): the "Complete!" frame must switch in at the
// exact same instant the percentage number below it reads 100, or the two
// visibly disagree (image says done, number still climbing) for the last
// stretch of the climb.
const LOADER_THRESHOLDS = [22, 50, 77, 100];

function frameIndexForPct(pct) {
  for (let i = 0; i < LOADER_THRESHOLDS.length; i += 1) {
    if (pct < LOADER_THRESHOLDS[i]) return i;
  }
  return LOADER_THRESHOLDS.length;
}

function preloadLoaderFrames() {
  LOADER_FRAMES.forEach((src) => { const im = new Image(); im.src = src; });
}

function prefersReducedMotion() {
  if (typeof document === 'undefined') return false;
  return document.documentElement.getAttribute('data-motion') === 'reduced'
    || (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
}

const STORY_CLIMB_MS = 5200; // 6% -> 100%, easing off near the end
const STORY_HOLD_MS = 1600;  // linger on the "Complete!" beat before looping
const STORY_CYCLE_MS = STORY_CLIMB_MS + STORY_HOLD_MS;

/**
 * The mascot "story" — climbs from ~6% to 100% (easing off, not linear),
 * holds briefly on the frame-5 "Complete!" beat, then loops back to the
 * start. This is a repeating decorative loop, not a readout of the real
 * request's actual progress (there's no way to know that here) — the
 * caller's own `title`/`steps` text next to it is what stays honest about
 * what's actually happening; this is just company while it waits, the same
 * way a looping spinner GIF would be, except it periodically resolves into
 * its own little "done!" beat instead of spinning forever with no payoff.
 *
 * Frames are preloaded on mount so advancing through them never pops in
 * blank. Skipped down to a single static first frame under reduced motion.
 */
function LoaderStory({ className }) {
  const [pct, setPct] = useState(6);
  const [skip] = useState(prefersReducedMotion);

  useEffect(() => { preloadLoaderFrames(); }, []);

  useEffect(() => {
    if (skip) return undefined;
    let raf;
    let start = null;
    let lastShown = -1;
    const tick = (ts) => {
      if (start === null) start = ts;
      const elapsed = (ts - start) % STORY_CYCLE_MS;
      let next;
      if (elapsed < STORY_CLIMB_MS) {
        const t = elapsed / STORY_CLIMB_MS;
        const eased = 1 - (1 - t) ** 3;
        next = Math.round(6 + eased * (100 - 6));
      } else {
        next = 100;
      }
      if (next !== lastShown) {
        lastShown = next;
        setPct(next);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [skip]);

  const frameIdx = skip ? 0 : frameIndexForPct(pct);

  return (
    <div className={cn('mx-auto', className)}>
      <img
        src={LOADER_FRAMES[frameIdx]}
        alt=""
        aria-hidden="true"
        className="mx-auto mb-3 w-full max-w-[560px] rounded-2xl object-contain shadow-md"
      />
      {!skip && (
        <div className="mx-auto w-full max-w-[340px]" aria-hidden="true">
          <div className="h-2 w-full overflow-hidden rounded-full bg-border">
            <div
              className="h-full rounded-full"
              style={{
                width: `${pct}%`,
                background: pct >= 100 ? 'var(--success)' : 'var(--accent)',
                transition: 'width 120ms linear, background-color 200ms ease',
              }}
            />
          </div>
          <p className="mt-1 text-[11px] font-semibold text-muted">{pct}%</p>
        </div>
      )}
    </div>
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
  title = 'Loading…', subtitle, steps, stepSeconds = 1.4, className, minHeight = 460, illustration = true,
}) {
  const [stepIdx, setStepIdx] = useState(0);
  useEffect(() => {
    if (!steps || steps.length < 2) return undefined;
    const t = setInterval(() => setStepIdx((i) => (i + 1) % steps.length), stepSeconds * 1000);
    return () => clearInterval(t);
  }, [steps, stepSeconds]);

  return (
    <div
      className={cn('grid w-full place-items-center', className)}
      style={{ minHeight }}
      aria-live="polite"
    >
      <div className="text-center">
        {illustration ? (
          <LoaderStory className="mb-1" />
        ) : (
          <MonitorPulse size="lg" className="mx-auto" />
        )}
        <p className="mt-1 text-[15px] font-semibold text-fg">{title}</p>
        {steps?.length > 0 && (
          <p className="mt-1 flex items-center justify-center gap-2 text-[13px] text-muted transition-opacity">
            <MonitorBars />
            {steps[stepIdx]}
          </p>
        )}
        {!steps?.length && subtitle && (
          <p className="mt-1 flex items-center justify-center gap-2 text-[13px] text-muted">
            <MonitorBars />
            {subtitle}
          </p>
        )}
      </div>
    </div>
  );
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
