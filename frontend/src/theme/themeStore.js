import { create } from 'zustand';
import {
  THEMES, THEME_MODE, ACCENTS, FONTS, MONO_FONTS, FONT_WEIGHTS,
  FONT_SIZE_LEGACY_TO_PERCENT, FONT_SCALE_DEFAULT, FONT_SCALE_MIN, FONT_SCALE_MAX,
  RADII, DENSITIES, SURFACE_STYLES, NAV_STYLES, CONTENT_WIDTHS, CHART_PALETTES,
  HEADER_GRADIENTS, HEADER_STYLES, HEADER_TEXTURES, HEADER_TEXTURE_LEVELS,
  byId,
} from './presets';

/** Clamp to a sane range; a pre-percentage string id (saved before "Scale"
    became a percentage) maps to its nearest equivalent, anything else
    unreadable falls back to the default. */
export function normalizeFontScale(value) {
  const n = Number(value);
  if (Number.isFinite(n)) return Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, Math.round(n)));
  return FONT_SIZE_LEGACY_TO_PERCENT[value] ?? FONT_SCALE_DEFAULT;
}
import { alpha, contrast, ensureContrast, isDarkColor, isValidHex, readableOn, shade } from './color';

/** The dark ink `readableOn` falls back to — kept in sync so header text matches. */
const INK = '#0b1020';

const STORAGE_KEY = 'actmon.appearance'; // keep in sync with the boot script in index.html

/* ══════════════════════════════════════════════════════════════════════════
   DEFAULTS — the shipped look. Every key here is user-changeable.
   ══════════════════════════════════════════════════════════════════════════ */
export const DEFAULT_APPEARANCE = {
  /* colour */
  theme: 'light',
  accent: '#3b6ef5',
  chartPalette: 'default',
  /** Global nudge for which chart form to use; per-card picks override it. */
  chartStyle: 'recommended',

  /* typography */
  font: 'system',
  displayFont: 'match',
  monoFont: 'cascadia',
  /** Percentage of the 16px baseline — same idea as an OS display scale
      setting. See FONT_SCALE_PRESETS in presets.js for the standard options. */
  fontSize: FONT_SCALE_DEFAULT,
  fontWeight: 'regular',

  /* shape & spacing */
  radius: 'default',
  density: 'cozy',
  surfaceStyle: 'elevated',

  /* page header */
  headerStyle: 'plain',        // plain | solid | gradient
  headerColor: '#12182a',      // used when headerStyle === 'solid'
  headerGradient: 'accent',    // preset id; 'accent' derives from the accent
  headerAngle: '135deg',
  headerTexture: 'none',
  headerTextureLevel: 'subtle',
  /** Off (the default) pins the header so it stays put while the page scrolls. */
  headerScroll: false,

  /* lists */
  /** Default rows per page for every list; a list may still override it. */
  rowsPerPage: '10',

  /* chrome */
  sidebarVariant: 'ink',
  sidebarColor: '#12182a', // only used when sidebarVariant === 'custom'
  topbarVariant: 'surface',
  topbarColor: '#ffffff', // only used when topbarVariant === 'custom'
  navStyle: 'pill',

  /* layout */
  sidebarPosition: 'left',
  sidebarWidth: 260,
  contentWidth: 'full',
  showNavLabels: true,
  showBreadcrumbs: true,
  stickyTopbar: true,

  /* accessibility */
  contrast: 'normal',
  motion: 'full',
};

/* ══════════════════════════════════════════════════════════════════════════
   TOKEN BUILDERS
   ══════════════════════════════════════════════════════════════════════════ */

export function resolveThemeId(theme) {
  if (theme !== 'system') return theme;
  if (typeof window === 'undefined') return 'light';
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

/** Fixed ink colour per theme so the dark rail still reads as "one shade deeper". */
const INK_BY_THEME = {
  light: '#12182a',
  paper: '#221e18',
  dim: '#131a27',
  dark: '#070c18',
  midnight: '#000000',
};

function accentTokens(accentHex, themeMode) {
  const accent = isValidHex(accentHex) ? (accentHex.startsWith('#') ? accentHex : `#${accentHex}`) : DEFAULT_APPEARANCE.accent;
  const dark = themeMode === 'dark';
  return {
    '--accent': accent,
    '--accent-hover': shade(accent, dark ? 0.12 : -0.1),
    '--accent-active': shade(accent, dark ? 0.22 : -0.2),
    '--accent-soft': alpha(accent, dark ? 0.2 : 0.11),
    '--accent-softer': alpha(accent, dark ? 0.1 : 0.055),
    '--accent-border': alpha(accent, dark ? 0.4 : 0.3),
    '--accent-fg': readableOn(accent),
    // accent used as TEXT on the page background — nudged until it passes AA
    '--accent-text': ensureContrast(accent, dark ? '#111827' : '#ffffff', 4.5),
    '--ring': accent,
  };
}

function sidebarTokens({ variant, customColor, accent, themeId, themeMode }) {
  const inkBase = INK_BY_THEME[themeId] || INK_BY_THEME.light;

  // Shared shape for a dark rail (ink / accent / gradient / dark custom)
  const onDark = (bg, image = 'none') => ({
    '--sidebar-bg': bg,
    '--sidebar-bg-image': image,
    '--sidebar-fg': '#eef2f9',
    '--sidebar-fg-muted': alpha('#eef2f9', 0.62),
    '--sidebar-hover': alpha('#ffffff', 0.08),
    '--sidebar-active-bg': alpha(accent, 0.22),
    '--sidebar-active-fg': '#ffffff',
    '--sidebar-active-marker': accent,
    '--sidebar-border': alpha('#ffffff', 0.09),
    '--sidebar-section-fg': alpha('#eef2f9', 0.42),
  });

  // Shared shape for a light rail that follows the theme's own surfaces
  const onTheme = (bg, hover) => ({
    '--sidebar-bg': bg,
    '--sidebar-bg-image': 'none',
    '--sidebar-fg': 'var(--fg)',
    '--sidebar-fg-muted': 'var(--fg-muted)',
    '--sidebar-hover': hover,
    '--sidebar-active-bg': 'var(--accent-soft)',
    '--sidebar-active-fg': 'var(--accent-text)',
    '--sidebar-active-marker': accent,
    '--sidebar-border': 'var(--border)',
    '--sidebar-section-fg': 'var(--fg-subtle)',
  });

  switch (variant) {
    case 'surface':
      return onTheme('var(--surface)', 'var(--surface-sunken)');
    case 'canvas':
      return onTheme('var(--bg)', 'var(--surface)');
    case 'accent': {
      // A light accent would swallow white text — darken it for the rail only.
      const base = isDarkColor(accent) ? accent : shade(accent, -0.45);
      return onDark(base);
    }
    case 'gradient': {
      const top = isDarkColor(accent) ? accent : shade(accent, -0.35);
      return onDark(top, `linear-gradient(170deg, ${top} 0%, ${shade(top, -0.55)} 62%, ${inkBase} 100%)`);
    }
    case 'custom': {
      const hex = isValidHex(customColor) ? customColor : inkBase;
      if (isDarkColor(hex)) return onDark(hex);
      // Light custom colour → dark text, tinted hover/active
      return {
        '--sidebar-bg': hex,
        '--sidebar-bg-image': 'none',
        '--sidebar-fg': readableOn(hex),
        '--sidebar-fg-muted': alpha(readableOn(hex), 0.66),
        '--sidebar-hover': alpha('#000000', 0.06),
        '--sidebar-active-bg': alpha(accent, 0.16),
        '--sidebar-active-fg': ensureContrast(accent, hex, 4.5),
        '--sidebar-active-marker': accent,
        '--sidebar-border': alpha('#000000', 0.1),
        '--sidebar-section-fg': alpha(readableOn(hex), 0.45),
      };
    }
    case 'ink':
    default:
      return onDark(themeMode === 'dark' ? inkBase : INK_BY_THEME.light);
  }
}

function topbarTokens({ variant, customColor, accent, themeId }) {
  const inkBase = INK_BY_THEME[themeId] || INK_BY_THEME.light;

  switch (variant) {
    case 'canvas':
      return {
        '--topbar-bg': 'var(--bg)',
        '--topbar-fg': 'var(--fg)',
        '--topbar-fg-muted': 'var(--fg-muted)',
        '--topbar-border': 'var(--border)',
        '--topbar-blur': '0px',
      };
    case 'glass':
      return {
        '--topbar-bg': 'color-mix(in srgb, var(--surface) 74%, transparent)',
        '--topbar-fg': 'var(--fg)',
        '--topbar-fg-muted': 'var(--fg-muted)',
        '--topbar-border': 'var(--border)',
        '--topbar-blur': '14px',
      };
    case 'ink':
      return {
        '--topbar-bg': inkBase,
        '--topbar-fg': '#eef2f9',
        '--topbar-fg-muted': alpha('#eef2f9', 0.62),
        '--topbar-border': alpha('#ffffff', 0.09),
        '--topbar-blur': '0px',
      };
    case 'accent': {
      const base = isDarkColor(accent) ? accent : shade(accent, -0.3);
      return {
        '--topbar-bg': base,
        '--topbar-fg': readableOn(base),
        '--topbar-fg-muted': alpha(readableOn(base), 0.72),
        '--topbar-border': alpha('#000000', 0.16),
        '--topbar-blur': '0px',
      };
    }
    case 'custom': {
      const hex = isValidHex(customColor) ? customColor : '#ffffff';
      const fg = readableOn(hex);
      return {
        '--topbar-bg': hex,
        '--topbar-fg': fg,
        '--topbar-fg-muted': alpha(fg, 0.68),
        '--topbar-border': alpha(fg, 0.14),
        '--topbar-blur': '0px',
      };
    }
    case 'surface':
    default:
      return {
        '--topbar-bg': 'var(--surface)',
        '--topbar-fg': 'var(--fg)',
        '--topbar-fg-muted': 'var(--fg-muted)',
        '--topbar-border': 'var(--border)',
        '--topbar-blur': '0px',
      };
  }
}

/**
 * Series colours for the active palette, stepped for the current mode.
 *
 * The accent deliberately does NOT feed this: series colour encodes identity and
 * has to stay colourblind-safe as an ordered set, which an arbitrary user-picked
 * hex can't guarantee. The accent owns the UI chrome; charts own their palette.
 */
function chartTokens(paletteId, themeMode) {
  const palette = byId(CHART_PALETTES, paletteId);
  const steps = themeMode === 'dark' ? palette.dark : palette.light;
  const out = {};
  steps.forEach((hex, i) => { out[`--chart-${i + 1}`] = hex; });
  return out;
}

/**
 * Page-header surface.
 *
 * A coloured header can't just set its own background: the title, badges and
 * buttons inside it are styled with the app's normal token utilities, which assume
 * a page surface. So this returns the header's own palette AND the overrides that
 * get scoped to the header subtree in tokens.css — inside a dark header, `--fg`
 * becomes the header's foreground, `--border` becomes a translucent white, and
 * every utility follows without any component knowing.
 */
function headerTokens(a, accent, themeMode) {
  const style = byId(HEADER_STYLES, a.headerStyle).id;

  if (style === 'plain') {
    return {
      '--header-bg': 'transparent',
      '--header-bg-image': 'none',
      '--header-fg': 'var(--fg)',
      '--header-fg-muted': 'var(--fg-muted)',
      '--header-fg-subtle': 'var(--fg-subtle)',
      '--header-border': 'var(--border)',
      '--header-surface': 'var(--surface)',
      '--header-sunken': 'var(--surface-sunken)',
      '--header-texture': 'none',
      '--header-texture-size': 'auto',
      '--header-texture-opacity': '0',
      '--header-pad': '0px',
    };
  }

  /* Resolve the colour stop(s) the text will sit on. A gradient has two, and the
     title crosses both, so BOTH have to be legible — checking only the first stop
     would pass a dark→bright fade whose right-hand end is unreadable. */
  let stops;
  const angle = a.headerAngle || '135deg';
  const isGradient = style === 'gradient';
  if (isGradient) {
    const preset = byId(HEADER_GRADIENTS, a.headerGradient);
    // `pair: null` → derive from the accent so the header follows the brand.
    stops = preset.pair || [shade(accent, themeMode === 'dark' ? -0.45 : -0.3), accent];
  } else {
    stops = [isValidHex(a.headerColor) ? a.headerColor : '#12182a'];
  }

  /* Pick whichever ink is legible against the WORST stop, then — if neither
     clears 4.5:1 — walk the band's lightness until it does. A mid-tone hue can
     leave both inks short (#3b6ef5 tops out at 4.44:1 against white), so the
     colour has to give a little; the hue is kept, only its lightness moves. */
  const worstAgainst = (ink, cols) => Math.min(...cols.map((c) => contrast(ink, c)));
  const seed = stops;
  let fg = worstAgainst('#ffffff', seed) >= worstAgainst(INK, seed) ? '#ffffff' : INK;
  if (worstAgainst(fg, stops) < 4.5) {
    const dir = fg === '#ffffff' ? -1 : 1; // white ink → darken the band, and vice versa
    for (let i = 1; i <= 20; i += 1) {
      stops = seed.map((c) => shade(c, dir * i * 0.04));
      if (worstAgainst(fg, stops) >= 4.5) break;
    }
  }

  const base = stops[0];
  const image = isGradient
    ? `linear-gradient(${angle}, ${stops[0]} 0%, ${stops[1]} 100%)`
    : 'none';
  const onDark = fg === '#ffffff';
  const texture = byId(HEADER_TEXTURES, a.headerTexture);
  const level = byId(HEADER_TEXTURE_LEVELS, a.headerTextureLevel);

  return {
    '--header-bg': base,
    '--header-bg-image': image,
    '--header-fg': fg,
    '--header-fg-muted': alpha(fg, 0.75),
    '--header-fg-subtle': alpha(fg, 0.6),
    '--header-border': alpha(fg, 0.18),
    '--header-surface': alpha(fg, onDark ? 0.1 : 0.06),
    '--header-sunken': alpha(fg, onDark ? 0.16 : 0.1),
    '--header-texture': texture.image,
    '--header-texture-size': texture.size || 'auto',
    '--header-texture-opacity': texture.id === 'none' ? '0' : String(level.opacity),
    /* A coloured band needs breathing room; a plain one already has the page's. */
    '--header-pad': 'var(--card-pad)',
  };
}

/**
 * Turn an appearance object into the complete CSS-variable map.
 * Exported so tests / previews can compute tokens without touching the DOM.
 */
export function buildTokens(a) {
  const themeId = resolveThemeId(a.theme);
  const themeMode = THEME_MODE[themeId] === 'dark' ? 'dark' : 'light';

  const accentVars = accentTokens(a.accent, themeMode);
  const accent = accentVars['--accent'];

  const font = byId(FONTS, a.font);
  const display = a.displayFont === 'match' ? font : byId(FONTS, a.displayFont);
  const mono = byId(MONO_FONTS, a.monoFont);
  const fontScale = normalizeFontScale(a.fontSize);
  const weight = byId(FONT_WEIGHTS, a.fontWeight, 1);
  const radius = byId(RADII, a.radius, 2);
  const density = byId(DENSITIES, a.density, 1);
  const width = byId(CONTENT_WIDTHS, a.contentWidth);

  return {
    ...accentVars,
    ...density.vars, // density first — explicit overrides below can win
    ...sidebarTokens({
      variant: a.sidebarVariant, customColor: a.sidebarColor, accent, themeId, themeMode,
    }),
    ...topbarTokens({ variant: a.topbarVariant, customColor: a.topbarColor, accent, themeId }),
    ...chartTokens(a.chartPalette, themeMode),
    ...headerTokens(a, accent, themeMode),

    /* typography */
    '--font-sans': font.sans,
    '--font-display': display.sans,
    '--font-mono': mono.mono,
    '--font-size-root': `${(16 * fontScale / 100).toFixed(2)}px`,
    '--font-weight-normal': String(weight.normal),
    '--font-weight-medium': String(weight.medium),
    '--font-weight-semibold': String(weight.semibold),
    '--font-weight-bold': String(weight.bold),

    /* geometry */
    '--radius-xs': radius.scale.xs,
    '--radius-sm': radius.scale.sm,
    '--radius-md': radius.scale.md,
    '--radius-lg': radius.scale.lg,
    '--radius-xl': radius.scale.xl,
    '--radius-2xl': radius.scale['2xl'],
    '--radius-card': radius.scale.lg,
    '--radius-control': radius.scale.md,

    /* layout */
    '--sidebar-w': `${a.sidebarWidth}px`,
    '--content-max': width.value,
  };
}

/** The <html> data-* attributes that CSS branches on. */
export function buildAttributes(a) {
  return {
    'data-theme': resolveThemeId(a.theme),
    'data-theme-pref': a.theme,
    'data-contrast': a.contrast,
    'data-motion': a.motion,
    'data-density': byId(DENSITIES, a.density, 1).id,
    'data-surface': byId(SURFACE_STYLES, a.surfaceStyle).id,
    'data-nav': byId(NAV_STYLES, a.navStyle).id,
    'data-header': byId(HEADER_STYLES, a.headerStyle).id,
    // 'off' pins the header; see the PAGE HEADER PINNING block in tokens.css
    'data-header-scroll': a.headerScroll ? 'on' : 'off',
    'data-radius': byId(RADII, a.radius, 2).id,
  };
}

/** Write an appearance object to the document. Cheap enough to call on every change. */
export function applyAppearance(a) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;

  const tokens = buildTokens(a);
  for (const [key, value] of Object.entries(tokens)) root.style.setProperty(key, value);

  const attrs = buildAttributes(a);
  for (const [key, value] of Object.entries(attrs)) root.setAttribute(key, value);
}

/* ══════════════════════════════════════════════════════════════════════════
   STORE
   ══════════════════════════════════════════════════════════════════════════ */

function loadPersisted() {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_APPEARANCE };
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    // Only accept keys we know about — a stale/hand-edited blob can't poison state.
    const clean = {};
    for (const key of Object.keys(DEFAULT_APPEARANCE)) {
      if (raw[key] !== undefined) clean[key] = raw[key];
    }
    const merged = { ...DEFAULT_APPEARANCE, ...clean };
    // Migrate a scale saved before it became a percentage (a string id like 'md').
    merged.fontSize = normalizeFontScale(merged.fontSize);
    return merged;
  } catch {
    return { ...DEFAULT_APPEARANCE };
  }
}

function persist(a) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(a));
  } catch {
    /* private mode / quota — appearance just won't survive a reload */
  }
}

export const useThemeStore = create((set, get) => ({
  ...loadPersisted(),

  /** Change one or many appearance keys — persists and repaints in one step. */
  update: (patch) => {
    const next = { ...get(), ...patch };
    persist(pick(next));
    applyAppearance(next);
    set(patch);
  },

  setTheme: (theme) => get().update({ theme }),
  setAccent: (accent) => get().update({ accent }),

  /** Light ⇄ dark quick toggle for the topbar button. */
  toggleTheme: () => {
    const current = resolveThemeId(get().theme);
    const isDark = THEME_MODE[current] === 'dark';
    get().update({ theme: isDark ? 'light' : 'dark' });
  },

  reset: () => {
    persist(DEFAULT_APPEARANCE);
    applyAppearance(DEFAULT_APPEARANCE);
    set({ ...DEFAULT_APPEARANCE });
  },

  /** Serialisable appearance only (drops the action functions). */
  export: () => pick(get()),

  /** Load a whole appearance object (e.g. from the server or a shared preset). */
  import: (obj) => {
    const clean = {};
    for (const key of Object.keys(DEFAULT_APPEARANCE)) {
      if (obj?.[key] !== undefined) clean[key] = obj[key];
    }
    get().update(clean);
  },
}));

function pick(state) {
  const out = {};
  for (const key of Object.keys(DEFAULT_APPEARANCE)) out[key] = state[key];
  return out;
}

/** Convenience selector — true when the resolved theme is a dark one. */
export const useIsDark = () =>
  useThemeStore((s) => THEME_MODE[resolveThemeId(s.theme)] === 'dark');

export { THEMES, STORAGE_KEY };
