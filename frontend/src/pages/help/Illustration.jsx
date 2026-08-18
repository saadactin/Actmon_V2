/**
 * Generated illustration bands for image-led cards — never a stock photo.
 * Each variant is a small, theme-aware SVG pattern (dots/nodes/lines) over a
 * hue-tinted gradient, built from the card's own accent color so it always
 * matches whichever theme/appearance settings are active. Reused across the
 * Get Started, Database Monitoring, Operations, and Certification sections
 * instead of hand-drawing one bespoke image per card.
 */
const PATTERNS = {
  /** Connected nodes — replication/topology, agents, architecture. */
  nodes: (id) => (
    <>
      <circle cx="18%" cy="30%" r="4" fill={`url(#${id}-dot)`} />
      <circle cx="42%" cy="65%" r="4" fill={`url(#${id}-dot)`} />
      <circle cx="70%" cy="25%" r="5" fill={`url(#${id}-dot)`} />
      <circle cx="85%" cy="60%" r="3.5" fill={`url(#${id}-dot)`} />
      <path d="M 18% 30% L 42% 65% L 70% 25% L 85% 60%" stroke={`url(#${id}-line)`} strokeWidth="1.5" fill="none" strokeDasharray="3 4" />
    </>
  ),
  /** Grid of small server/host boxes — infrastructure. */
  grid: (id) => (
    <>
      {[0, 1, 2, 3].map((r) => [0, 1, 2, 3, 4].map((c) => (
        <rect key={`${r}-${c}`} x={`${8 + c * 19}%`} y={`${18 + r * 22}%`} width="10%" height="12%" rx="2"
          fill={`url(#${id}-dot)`} opacity={0.35 + ((r + c) % 3) * 0.18} />
      )))}
    </>
  ),
  /** Rising wave — performance/metrics/charts. */
  wave: (id) => (
    <path d="M 0 75 Q 15 55, 28 62 T 55 45 T 78 55 T 100 30" stroke={`url(#${id}-line)`} strokeWidth="2.5" fill="none" vectorEffect="non-scaling-stroke" transform="scale(1,1)" />
  ),
  /** Shield outline — alerts/security/administration. */
  shield: (id) => (
    <path d="M50 12 L78 24 V50 C78 68 66 80 50 88 C34 80 22 68 22 50 V24 Z" stroke={`url(#${id}-line)`} strokeWidth="2" fill="none" />
  ),
  /** Flowing pipeline — agents/operations. */
  flow: (id) => (
    <>
      <circle cx="14%" cy="50%" r="4.5" fill={`url(#${id}-dot)`} />
      <path d="M 14% 50% H 40%" stroke={`url(#${id}-line)`} strokeWidth="2" />
      <rect x="40%" y="38%" width="20%" height="24%" rx="4" fill="none" stroke={`url(#${id}-line)`} strokeWidth="2" />
      <path d="M 60% 50% H 86%" stroke={`url(#${id}-line)`} strokeWidth="2" />
      <circle cx="86%" cy="50%" r="4.5" fill={`url(#${id}-dot)`} />
    </>
  ),
  /** Concentric rings — certification/learning/progress. */
  rings: (id) => (
    <>
      <circle cx="50%" cy="50%" r="34%" stroke={`url(#${id}-line)`} strokeWidth="1.5" fill="none" opacity="0.5" />
      <circle cx="50%" cy="50%" r="22%" stroke={`url(#${id}-line)`} strokeWidth="1.5" fill="none" opacity="0.75" />
      <circle cx="50%" cy="50%" r="10%" fill={`url(#${id}-dot)`} />
    </>
  ),
};

import { useRef } from 'react';

let uid = 0;

/** A hue-tinted gradient band with a generated geometric pattern on top —
 * the "illustration" for an image-led card. Height is controlled by the
 * parent via className (e.g. `h-28`). */
export default function Illustration({ hue = 'var(--accent)', pattern = 'nodes', className = '' }) {
  const id = useIdOnce();
  const draw = PATTERNS[pattern] || PATTERNS.nodes;
  // `relative` only when the caller hasn't already asked for `absolute` —
  // both are the `position` property, so naively always including `relative`
  // fights an `absolute` passed in via `className` (a real bug this exact
  // line once had: a caller positioning the whole band as a background layer
  // via `absolute inset-0` silently lost to this component's own hardcoded
  // `relative`, so the "background" rendered in normal document flow
  // instead — position wars must be resolved in JS, not left to whichever
  // utility happens to win the CSS cascade).
  const position = /\babsolute\b/.test(className) ? '' : 'relative';
  return (
    <div className={`${position} overflow-hidden ${className}`} style={{ background: `linear-gradient(135deg, color-mix(in srgb, ${hue} 22%, var(--surface-sunken)), var(--surface-sunken))` }}>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 h-full w-full">
        <defs>
          <radialGradient id={`${id}-dot`}><stop offset="0%" stopColor={hue} stopOpacity="0.9" /><stop offset="100%" stopColor={hue} stopOpacity="0.5" /></radialGradient>
          <linearGradient id={`${id}-line`} x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stopColor={hue} stopOpacity="0.7" /><stop offset="100%" stopColor={hue} stopOpacity="0.25" /></linearGradient>
        </defs>
        {draw(id)}
      </svg>
    </div>
  );
}

/** A real illustration image — decorative only, never a stand-in for a
 * product screenshot. `overlay` adds a theme-aware scrim so text can sit on
 * top of it without a fixed dark/light assumption. `hue`, when given, tints
 * the photo with that card's own brand color (a `color-mix` wash, same
 * technique the generated `Illustration` uses for its gradient) — this is
 * what lets a handful of real photos cover many differently-branded cards
 * (e.g. every database engine) without every card looking like an identical
 * repeated image; the color is what actually differentiates them, the photo
 * is shared texture underneath. */
export function PhotoBand({ src, alt = '', className = '', overlay = false, objectPosition, hue, fit = 'cover' }) {
  const position = /\babsolute\b/.test(className) ? '' : 'relative';
  return (
    <div className={`${position} overflow-hidden ${className}`}>
      <img src={src} alt={alt} className={`h-full w-full object-${fit}`} style={objectPosition ? { objectPosition } : undefined} />
      {hue && (
        <div className="absolute inset-0 mix-blend-multiply" style={{ background: `color-mix(in srgb, ${hue} 55%, transparent)` }} />
      )}
      {overlay && (
        <div className="absolute inset-0 bg-surface/80" />
      )}
    </div>
  );
}

function useIdOnce() {
  // Stable per-MOUNT id for gradient defs (assigned once via useRef, not
  // regenerated on every re-render) — a fresh id per render would still be
  // valid SVG but would force React to re-reconcile the whole <defs> tree
  // for no reason on every unrelated state update elsewhere on the page.
  const ref = useRef(null);
  if (ref.current === null) ref.current = `illus-${(uid += 1)}`;
  return ref.current;
}
