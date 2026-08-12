/**
 * APPEARANCE PRESETS — the single catalogue of everything a user can change.
 *
 * The Appearance panel is generated from these lists, and themeStore only ever
 * accepts keys that exist here. Adding a new theme / font / density = add an
 * entry below; no component changes anywhere.
 */

/* ─────────────────────────── Themes ──────────────────────────────────────
   `mode` tells the rest of the app whether we're on a dark base (used for
   choosing sidebar/topbar skins and chart grid strength). The actual colour
   values live in styles/tokens.css under [data-theme='…']. */
export const THEMES = [
  { id: 'light', label: 'Light', mode: 'light', swatch: ['#ffffff', '#f4f6fa', '#10192b'] },
  { id: 'paper', label: 'Paper', mode: 'light', swatch: ['#fffdf9', '#f6f3ee', '#221e18'] },
  { id: 'dim', label: 'Dim', mode: 'dark', swatch: ['#222b3c', '#1a2130', '#e6ebf4'] },
  { id: 'dark', label: 'Dark', mode: 'dark', swatch: ['#121a2e', '#0b1020', '#e8eefb'] },
  { id: 'midnight', label: 'Midnight', mode: 'dark', swatch: ['#0c0c0f', '#000000', '#f2f2f5'] },
  { id: 'system', label: 'Match system', mode: 'auto', swatch: ['#ffffff', '#0b1020', '#7a8699'] },
];

export const THEME_MODE = THEMES.reduce((acc, t) => ({ ...acc, [t.id]: t.mode }), {});

/* ─────────────────────────── Accents ─────────────────────────────────────
   Suggestions only — any hex is accepted (Appearance has a colour picker). */
export const ACCENTS = [
  { id: 'azure', label: 'Azure', value: '#3b6ef5' },
  { id: 'cobalt', label: 'Cobalt', value: '#0078d4' },
  { id: 'indigo', label: 'Indigo', value: '#5b53e8' },
  { id: 'violet', label: 'Violet', value: '#8b5cf6' },
  { id: 'teal', label: 'Teal', value: '#0d9488' },
  { id: 'emerald', label: 'Emerald', value: '#10a85f' },
  { id: 'amber', label: 'Amber', value: '#d97706' },
  { id: 'rose', label: 'Rose', value: '#e11d63' },
  { id: 'crimson', label: 'Crimson', value: '#c8323c' },
  { id: 'slate', label: 'Graphite', value: '#556070' },
];

/* ─────────────────────────── Typography ──────────────────────────────────
   Stacks only reference fonts that ship with Windows/macOS/Linux or are
   already installed — nothing loads over the network. */
export const FONTS = [
  {
    id: 'system',
    label: 'System UI',
    hint: 'Segoe UI · San Francisco',
    sans: "'Segoe UI Variable', 'Segoe UI', system-ui, -apple-system, Roboto, Helvetica, Arial, sans-serif",
  },
  {
    id: 'inter',
    label: 'Inter',
    hint: 'Neutral, tight',
    sans: "Inter, 'Inter var', 'Segoe UI Variable', system-ui, -apple-system, sans-serif",
  },
  {
    id: 'grotesk',
    label: 'Grotesk',
    hint: 'Geometric, wide',
    sans: "'Space Grotesk', 'Archivo', 'Segoe UI', system-ui, sans-serif",
  },
  {
    id: 'rounded',
    label: 'Rounded',
    hint: 'Friendly',
    sans: "ui-rounded, 'SF Pro Rounded', 'Nunito', 'Segoe UI Variable', system-ui, sans-serif",
  },
  {
    id: 'serif',
    label: 'Serif',
    hint: 'Editorial',
    sans: "ui-serif, Georgia, 'Iowan Old Style', 'Times New Roman', serif",
  },
  {
    id: 'mono',
    label: 'Monospace',
    hint: 'Terminal feel',
    sans: "ui-monospace, 'Cascadia Code', 'JetBrains Mono', Consolas, monospace",
  },
];

/** Heading font can differ from body — 'match' keeps them the same. */
export const DISPLAY_FONTS = [{ id: 'match', label: 'Same as body' }, ...FONTS];

export const MONO_FONTS = [
  { id: 'cascadia', label: 'Cascadia Code', mono: "'Cascadia Code', ui-monospace, Consolas, monospace" },
  { id: 'jetbrains', label: 'JetBrains Mono', mono: "'JetBrains Mono', ui-monospace, Consolas, monospace" },
  { id: 'consolas', label: 'Consolas', mono: "Consolas, 'Courier New', ui-monospace, monospace" },
  { id: 'sfmono', label: 'SF Mono', mono: "'SF Mono', 'Menlo', ui-monospace, monospace" },
];

/** Root font-size — scales the ENTIRE interface because all sizes are rem-based.
    Superseded by the percentage-based FONT_SCALE_PRESETS below; kept only so
    old persisted values (the string ids below) can be migrated on load. */
export const FONT_SIZES = [
  { id: 'xs', label: 'Tiny', px: '14px' },
  { id: 'sm', label: 'Small', px: '15px' },
  { id: 'md', label: 'Default', px: '16px' },
  { id: 'lg', label: 'Large', px: '17px' },
  { id: 'xl', label: 'Largest', px: '19px' },
];

/** Legacy string id -> the nearest equivalent percentage, e.g. 'md' (16px on
    a 16px baseline) -> 100. Used once, on load, to migrate a value saved
    before the scale became percentage-based. */
export const FONT_SIZE_LEGACY_TO_PERCENT = { xs: 88, sm: 94, md: 100, lg: 106, xl: 119 };

/** Standard "Scale" options — same idea as Windows' Display > Scale, a
    percentage of the 16px baseline. 100 is the shipped default. */
export const FONT_SCALE_PRESETS = [75, 90, 100, 110, 125, 150, 175, 200];
export const FONT_SCALE_MIN = 60;
export const FONT_SCALE_MAX = 200;
export const FONT_SCALE_DEFAULT = 100;

export const FONT_WEIGHTS = [
  { id: 'light', label: 'Light', normal: 300, medium: 400, semibold: 500, bold: 600 },
  { id: 'regular', label: 'Regular', normal: 400, medium: 500, semibold: 600, bold: 700 },
  { id: 'strong', label: 'Strong', normal: 450, medium: 550, semibold: 650, bold: 800 },
];

/* ─────────────────────────── Geometry ────────────────────────────────────
   One radius scale, so every rounded-* utility in the app moves together. */
export const RADII = [
  { id: 'square', label: 'Square', scale: { xs: '0px', sm: '0px', md: '0px', lg: '0px', xl: '2px', '2xl': '2px' } },
  { id: 'sharp', label: 'Sharp', scale: { xs: '2px', sm: '3px', md: '4px', lg: '6px', xl: '8px', '2xl': '10px' } },
  { id: 'default', label: 'Default', scale: { xs: '3px', sm: '5px', md: '8px', lg: '12px', xl: '16px', '2xl': '22px' } },
  { id: 'round', label: 'Round', scale: { xs: '6px', sm: '9px', md: '12px', lg: '18px', xl: '24px', '2xl': '32px' } },
  { id: 'pill', label: 'Pill', scale: { xs: '8px', sm: '12px', md: '18px', lg: '24px', xl: '32px', '2xl': '40px' } },
];

/** Density drives every control height, row height and pad in one shot. */
export const DENSITIES = [
  {
    id: 'compact',
    label: 'Compact',
    hint: 'Most rows per screen',
    vars: {
      '--control-h': '30px', '--control-h-sm': '26px', '--control-h-lg': '36px',
      '--row-h': '34px', '--card-pad': '14px',
      '--gap': '10px', '--gap-sm': '6px', '--gap-lg': '16px',
      '--topbar-h': '48px', '--content-pad-x': '16px', '--density': '0.8',
    },
  },
  {
    id: 'cozy',
    label: 'Cozy',
    hint: 'Balanced',
    vars: {
      '--control-h': '34px', '--control-h-sm': '28px', '--control-h-lg': '40px',
      '--row-h': '40px', '--card-pad': '18px',
      '--gap': '14px', '--gap-sm': '8px', '--gap-lg': '20px',
      '--topbar-h': '54px', '--content-pad-x': '20px', '--density': '0.9',
    },
  },
  {
    id: 'comfortable',
    label: 'Comfortable',
    hint: 'Roomy, easiest to scan',
    vars: {
      '--control-h': '38px', '--control-h-sm': '32px', '--control-h-lg': '46px',
      '--row-h': '48px', '--card-pad': '22px',
      '--gap': '18px', '--gap-sm': '12px', '--gap-lg': '28px',
      '--topbar-h': '60px', '--content-pad-x': '26px', '--density': '1',
    },
  },
];

/* ─────────────────────────── Elevation / borders ─────────────────────────── */
export const SURFACE_STYLES = [
  { id: 'elevated', label: 'Elevated', hint: 'Soft shadows' },
  { id: 'outlined', label: 'Outlined', hint: 'Borders only, no shadow' },
  { id: 'flat', label: 'Flat', hint: 'No border, no shadow' },
];

/* ─────────────────────────── Sidebar skins ───────────────────────────────
   `build(ctx)` receives { accent, themeMode, tokens } and returns CSS vars, so
   a skin can adapt to the active theme instead of being a fixed colour set. */
export const SIDEBAR_VARIANTS = [
  { id: 'ink', label: 'Ink', hint: 'Dark rail in every theme' },
  { id: 'surface', label: 'Surface', hint: 'Matches cards' },
  { id: 'canvas', label: 'Canvas', hint: 'Blends into the page' },
  { id: 'accent', label: 'Accent', hint: 'Brand-coloured rail' },
  { id: 'gradient', label: 'Gradient', hint: 'Accent → ink fade' },
  { id: 'custom', label: 'Custom…', hint: 'Pick any colour' },
];

export const TOPBAR_VARIANTS = [
  { id: 'surface', label: 'Surface', hint: 'Matches cards' },
  { id: 'canvas', label: 'Canvas', hint: 'Same as page' },
  { id: 'glass', label: 'Glass', hint: 'Translucent + blur' },
  { id: 'ink', label: 'Ink', hint: 'Dark bar' },
  { id: 'accent', label: 'Accent', hint: 'Brand-coloured bar' },
  { id: 'custom', label: 'Custom…', hint: 'Pick any colour' },
];

/* ─────────────────────────── Layout ─────────────────────────────────────── */
export const NAV_STYLES = [
  { id: 'pill', label: 'Pill', hint: 'Rounded highlight' },
  { id: 'bar', label: 'Left bar', hint: 'Marker on the edge' },
  { id: 'block', label: 'Block', hint: 'Full-width fill' },
  { id: 'minimal', label: 'Minimal', hint: 'Text emphasis only' },
];

export const SIDEBAR_POSITIONS = [
  { id: 'left', label: 'Left' },
  { id: 'right', label: 'Right' },
];

export const CONTENT_WIDTHS = [
  { id: 'full', label: 'Full width', value: '100%' },
  { id: 'wide', label: 'Wide (1600)', value: '1600px' },
  { id: 'standard', label: 'Standard (1440)', value: '1440px' },
  { id: 'narrow', label: 'Narrow (1200)', value: '1200px' },
];

export const CONTRAST_LEVELS = [
  { id: 'normal', label: 'Normal' },
  { id: 'high', label: 'High contrast' },
];

export const MOTION_LEVELS = [
  { id: 'full', label: 'Full' },
  { id: 'system', label: 'Match system' },
  { id: 'reduced', label: 'Reduced' },
];

/* ─────────────────────────── Page header ─────────────────────────────────
   The band at the top of every page (title, description, actions). `plain` is
   the flat default; `solid` and `gradient` give it a surface of its own, and a
   texture can be laid over either.

   Because every utility in this app resolves through CSS variables, a coloured
   header only has to override those variables on its own subtree — the title,
   badges and buttons inside then adapt on their own. See styles/tokens.css. */
export const HEADER_STYLES = [
  { id: 'plain', label: 'Plain', hint: 'No background — the page surface shows through' },
  { id: 'solid', label: 'Solid', hint: 'One flat colour' },
  { id: 'gradient', label: 'Gradient', hint: 'Two-colour fade' },
];

/** `pair: null` means "derive from the accent", so it follows the brand colour. */
export const HEADER_GRADIENTS = [
  { id: 'accent', label: 'Accent', pair: null },
  { id: 'ocean', label: 'Ocean', pair: ['#0f2438', '#0e7490'] },
  { id: 'midnight', label: 'Midnight', pair: ['#0b1220', '#334155'] },
  { id: 'teal', label: 'Teal', pair: ['#0f172a', '#0f766e'] },
  { id: 'violet', label: 'Violet', pair: ['#312e81', '#7c3aed'] },
  { id: 'ember', label: 'Ember', pair: ['#7c2d12', '#c2410c'] },
  { id: 'slate', label: 'Slate', pair: ['#1e293b', '#475569'] },
];

export const HEADER_ANGLES = [
  { id: '90deg', label: '→' },
  { id: '135deg', label: '↘' },
  { id: '180deg', label: '↓' },
  { id: '45deg', label: '↗' },
];

/**
 * Texture overlays — pure CSS, no assets. Each is a `background-image` laid over
 * the header colour at a configurable opacity.
 */
export const HEADER_TEXTURES = [
  { id: 'none', label: 'None', image: 'none' },
  {
    id: 'grid',
    label: 'Grid',
    image: 'linear-gradient(currentColor 1px, transparent 1px), linear-gradient(90deg, currentColor 1px, transparent 1px)',
    size: '28px 28px',
  },
  {
    id: 'dots',
    label: 'Dots',
    image: 'radial-gradient(currentColor 1px, transparent 1px)',
    size: '16px 16px',
  },
  {
    id: 'diagonal',
    label: 'Diagonal',
    image: 'repeating-linear-gradient(45deg, currentColor 0 1px, transparent 1px 10px)',
    size: 'auto',
  },
  {
    id: 'rings',
    label: 'Rings',
    image: 'radial-gradient(circle at 90% 0%, currentColor 0 1px, transparent 1px 60px)',
    size: '120px 120px',
  },
];

export const HEADER_TEXTURE_LEVELS = [
  { id: 'subtle', label: 'Subtle', opacity: 0.05 },
  { id: 'medium', label: 'Medium', opacity: 0.1 },
  { id: 'strong', label: 'Strong', opacity: 0.18 },
];

/* ─────────────────────────── Chart series palettes ───────────────────────────
   Categorical palettes encode SERIES IDENTITY, so they are not free-form: the
   slot order is the colourblind-safety mechanism. Both entries below are the
   same eight validated hues in a different order, with per-mode steps (the dark
   column is the same hues re-stepped for a dark surface, not a second palette).

   Verified with the dataviz validator against this app's real surfaces
   (light #ffffff, dim #222b3c — the lightest surface in each mode, i.e. the
   worst case for contrast):

     default  light: adjacent CVD ΔE 9.1 · normal-vision 19.6  → all checks PASS
              dark:  adjacent CVD ΔE 8.4 · normal-vision 19.3  → all checks PASS
     warm     light: adjacent CVD ΔE 6.9 · normal-vision 31.3  → PASS (CVD in the
              dark:  adjacent CVD ΔE 6.5 · normal-vision 24.6     6–8 floor band)

   The `warm` order sits in the CVD floor band, which is legal only alongside
   secondary encoding — every chart here ships a legend, direct labels and 2px
   surface gaps, so that condition is met. A third ordering (cool-first) was
   tested and FAILED both gates, so it is not offered.

   Three light steps (aqua, yellow, magenta) and dark green fall below 3:1 on
   their surface; the relief rule applies and is satisfied by the visible value
   labels plus the table view on every chart card.

   Do not add a palette without re-running:
     node scripts/validate_palette.js "<hexes>" --mode light --surface "#ffffff"
     node scripts/validate_palette.js "<hexes>" --mode dark  --surface "#222b3c"
   ──────────────────────────────────────────────────────────────────────────── */
export const CHART_PALETTES = [
  {
    id: 'default',
    label: 'Default',
    hint: 'Blue-led, fully validated',
    //      blue       orange     aqua       yellow     magenta    green      violet     red
    light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'],
    dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
  },
  {
    id: 'warm',
    label: 'Warm',
    hint: 'Orange-led, same hues',
    //      orange     blue       yellow     violet     aqua       red        green      magenta
    light: ['#eb6834', '#2a78d6', '#eda100', '#4a3aa7', '#1baf7a', '#e34948', '#008300', '#e87ba4'],
    dark: ['#d95926', '#3987e5', '#c98500', '#9085e9', '#199e70', '#e66767', '#008300', '#d55181'],
  },
];

/* Convenience lookups */
export const byId = (list, id, fallbackIndex = 0) =>
  list.find((x) => x.id === id) || list[fallbackIndex];
