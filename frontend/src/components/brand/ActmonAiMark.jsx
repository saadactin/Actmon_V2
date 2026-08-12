import cn from '@/lib/cn';
import { APP } from '@/config/app.config';

/**
 * ACTMON AI — the assistant's mark.
 *
 * Drawn inline rather than shipped as a file so it needs no request and cannot
 * flash-then-appear beside a chat message. A deployment that wants the exact
 * Figma export instead sets `VITE_APP_AI_LOGO` (or drops the file at
 * public/actmon-ai.svg and points the env var at /actmon-ai.svg) — the asset then
 * wins and this drawing is the fallback.
 *
 * Size and shadow come from the spec: an 80px box, and a 16px-blur glow in
 * #814BA1 at 60% with no offset. The glow is a `filter: drop-shadow` rather than
 * a box-shadow so it follows the owl's silhouette instead of squaring off around
 * a transparent bounding box.
 */

/** 0 0 · blur 16 · #814BA1 @ 60% — scaled with the mark so it stays proportional. */
const glowFor = (size) => `drop-shadow(0 0 ${(16 / 80) * size}px rgb(129 75 161 / 0.6))`;

export default function ActmonAiMark({
  size = 80,
  glow = true,
  /** Blink + gaze. Off for anywhere a still frame is captured (PDF reports). */
  animated = true,
  className,
  title = 'ActMon AI',
}) {
  const asset = APP.aiLogoUrl;

  return (
    <span
      className={cn('inline-grid shrink-0 place-items-center', className)}
      style={{ width: size, height: size, filter: glow ? glowFor(size) : undefined }}
    >
      {asset ? (
        <img src={asset} alt={title} width={size} height={size} className="h-full w-full object-contain" />
      ) : (
        <OwlDrawing title={title} animated={animated} />
      )}
    </span>
  );
}

function OwlDrawing({ title, animated }) {
  const eye = animated ? 'owl-eye' : undefined;
  const gaze = animated ? 'owl-gaze' : undefined;
  return (
    <svg viewBox="0 0 80 80" className="h-full w-full" role="img" aria-label={title}>
      <defs>
        {/* the belly's chevron rows, so the pattern is one definition not twelve paths */}
        <g id="actmon-ai-chevron">
          <path d="M0 0 3.2 3.4 6.4 0" fill="none" stroke="#B07BD8" strokeWidth="2.1" strokeLinecap="round" />
        </g>
      </defs>

      {/* ── moon ── */}
      <circle cx="40" cy="38" r="29" fill="#FCE06A" />
      <circle cx="55" cy="21" r="4.6" fill="#F7CE49" />
      <circle cx="62" cy="34" r="3.1" fill="#F7CE49" />
      <circle cx="52" cy="46" r="2.3" fill="#F7CE49" />
      <circle cx="30" cy="17" r="2.6" fill="#F7CE49" />

      {/* ── wings, behind the body ── */}
      <path d="M23 40c-6 2-9 8-8 15 .4 3 2 5 4 5 3 0 5-3 6-7Z" fill="#A768D2" />
      <path d="M57 40c6 2 9 8 8 15-.4 3-2 5-4 5-3 0-5-3-6-7Z" fill="#A768D2" />

      {/* ── body ── */}
      <path
        d="M40 24c-10.4 0-18 7.4-18 18v9c0 10 8 18 18 18s18-8 18-18v-9c0-10.6-7.6-18-18-18Z"
        fill="#7E3FAE"
      />

      {/* belly, a shade up from the body so the chevrons have something to sit on */}
      <path
        d="M40 44c-7 0-12 5-12 12v3c0 6.6 5.4 12 12 12s12-5.4 12-12v-3c0-7-5-12-12-12Z"
        fill="#8F4CC0"
      />

      {/* ── brow / crest ── */}
      <path
        d="M20 20c0 12 9 20 20 20s20-8 20-20c0 0-8 7-20 7s-20-7-20-7Z"
        fill="#6B3496"
      />

      {/* ── eyes ──
          Grouped per eye so a blink squashes the white and the pupil together,
          and the pupil sits in its own group so it can drift inside the eye.
          Both eyes share one timing: owls blink together, not alternately. */}
      <g className={eye}>
        <circle cx="30.5" cy="35" r="9.4" fill="#FFFFFF" />
        <g className={gaze}>
          <circle cx="31.4" cy="35.6" r="4.7" fill="#14315C" />
          <circle cx="29.6" cy="33.8" r="1.5" fill="#FFFFFF" />
        </g>
      </g>
      <g className={eye}>
        <circle cx="49.5" cy="35" r="9.4" fill="#FFFFFF" />
        <g className={gaze}>
          <circle cx="48.6" cy="35.6" r="4.7" fill="#14315C" />
          <circle cx="46.8" cy="33.8" r="1.5" fill="#FFFFFF" />
        </g>
      </g>

      {/* ── beak ── */}
      <path d="M40 39.5 44.6 43.4 40 48.6 35.4 43.4Z" fill="#FF9F1C" />

      {/* ── belly chevrons ── */}
      <g>
        <use href="#actmon-ai-chevron" x="33" y="52" />
        <use href="#actmon-ai-chevron" x="41" y="52" />
        <use href="#actmon-ai-chevron" x="29" y="58" />
        <use href="#actmon-ai-chevron" x="37" y="58" />
        <use href="#actmon-ai-chevron" x="45" y="58" />
        <use href="#actmon-ai-chevron" x="33" y="64" />
        <use href="#actmon-ai-chevron" x="41" y="64" />
      </g>
    </svg>
  );
}
