/**
 * Colour maths for the theme engine.
 *
 * The user picks ONE accent hex; everything else (hover, active, soft fills,
 * borders, readable text-on-accent) is derived here so any colour they choose
 * stays legible in every theme instead of us shipping hand-tuned palettes.
 */

const clamp255 = (n) => Math.min(255, Math.max(0, Math.round(n)));

export function hexToRgb(hex) {
  let h = String(hex || '').trim().replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length !== 6 || /[^0-9a-f]/i.test(h)) return [59, 110, 245]; // fall back to default accent
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex(r, g, b) {
  return `#${[r, g, b].map((c) => clamp255(c).toString(16).padStart(2, '0')).join('')}`;
}

export const isValidHex = (hex) => /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(hex || '').trim());

/** rgba() string from a hex + alpha — used for soft fills that must sit on any theme. */
export function alpha(hex, a) {
  const [r, g, b] = hexToRgb(hex);
  return `rgb(${r} ${g} ${b} / ${a})`;
}

/** Move a colour toward black (pct < 0) or white (pct > 0). pct is -1..1. */
export function shade(hex, pct) {
  const [r, g, b] = hexToRgb(hex);
  const f = (c) => (pct < 0 ? c * (1 + pct) : c + (255 - c) * pct);
  return rgbToHex(f(r), f(g), f(b));
}

/** Linear blend of two hex colours. t=0 → a, t=1 → b. */
export function mix(a, b, t) {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  return rgbToHex(r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t);
}

/** WCAG relative luminance (0 = black, 1 = white). */
export function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two colours (1 → identical, 21 → black on white). */
export function contrast(a, b) {
  const l1 = luminance(a);
  const l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

export const isDarkColor = (hex) => luminance(hex) < 0.4;

/** Pick black or white text for a background — whichever contrasts more. */
export function readableOn(bgHex, dark = '#0b1020', light = '#ffffff') {
  return contrast(bgHex, light) >= contrast(bgHex, dark) ? light : dark;
}

/**
 * Nudge `color` lighter/darker until it clears `target` contrast against `bg`.
 * Used for accent-as-TEXT: a mid-blue accent is fine as a button fill but often
 * fails AA as a label on white, so we darken it just for that role.
 */
export function ensureContrast(color, bg, target = 4.5) {
  if (contrast(color, bg) >= target) return color;
  const towardWhite = luminance(bg) < 0.5;
  let out = color;
  for (let i = 1; i <= 20; i += 1) {
    out = shade(color, (towardWhite ? 1 : -1) * (i * 0.05));
    if (contrast(out, bg) >= target) return out;
  }
  return out;
}
