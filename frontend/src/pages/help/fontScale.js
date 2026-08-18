import { useEffect, useState } from 'react';

/**
 * Help Center text-size control — a user-adjustable multiplier applied via
 * one CSS custom property (`--help-font-scale`) on the page's outer
 * wrapper, so every font-size in the Help Center that's expressed as
 * `calc(Xrem * var(--help-font-scale, 1))` (see designTokens.js's
 * `typeStyle()` and helpArticle.css) scales together. Persisted per browser
 * so the reader's preferred size sticks across visits, scoped to the Help
 * Center only — this never touches the rest of ActMon's typography.
 */
const STORAGE_KEY = 'actmon.help.fontScale';
export const FONT_SCALE_MIN = 0.85;
export const FONT_SCALE_MAX = 1.35;
export const FONT_SCALE_STEP = 0.05;
export const FONT_SCALE_DEFAULT = 1;

const clamp = (v) => Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, Math.round(v * 100) / 100));

function loadScale() {
  try {
    const raw = parseFloat(localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(raw) ? clamp(raw) : FONT_SCALE_DEFAULT;
  } catch {
    return FONT_SCALE_DEFAULT;
  }
}

export function useFontScale() {
  const [scale, setScale] = useState(loadScale);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, String(scale)); } catch { /* non-fatal */ }
  }, [scale]);

  return {
    scale,
    increase: () => setScale((s) => clamp(s + FONT_SCALE_STEP)),
    decrease: () => setScale((s) => clamp(s - FONT_SCALE_STEP)),
    reset: () => setScale(FONT_SCALE_DEFAULT),
    atMin: scale <= FONT_SCALE_MIN,
    atMax: scale >= FONT_SCALE_MAX,
  };
}
