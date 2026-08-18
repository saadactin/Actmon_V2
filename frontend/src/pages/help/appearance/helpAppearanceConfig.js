/**
 * Help Center Appearance — the ONE config shape every Help Center card,
 * grid, and layout dimension reads from, instead of the hardcoded padding/
 * hue/grid-column values previously scattered across HomePage.jsx,
 * LandingPage.jsx, DatabaseLandingPage.jsx, helpContent.js (`ORC_HUES`), and
 * databaseCardsConfig.js.
 *
 * This module is the visually-authoritative source of "default" — the
 * backend (`help_center_appearance_model.py`) deliberately stores an empty
 * `{}` until an admin saves something, and deep-merges the request body onto
 * whatever's already stored. `DEFAULT_CONFIG` here is always deep-merged
 * UNDER the server's response (see HelpAppearanceContext.jsx), so a fresh
 * install with no saved row renders exactly this, and the two copies of
 * "what does default look like" can never drift apart — there's only one.
 */

export const DEFAULT_CONFIG = {
  preset: 'softEnterprise',
  mode: 'system', // 'light' | 'dark' | 'system'

  colors: {
    primaryAccent: '#2F6FED',
    secondaryAccent: '#7C5CFC',
    cardBg: null, // null = inherit var(--surface)
    cardBorder: null,
    cardTitle: null,
    cardDescription: null,
    cardFooter: null,
    iconBg: null,
    iconColor: null,
    hoverBg: null,
    hoverBorder: null,
  },

  // Seeded from ORC_HUES (helpContent.js) — which itself still exists,
  // feeding an older, unreachable-in-normal-navigation DOCS['home'] HTML
  // entry, and is left untouched as out of scope for this pass. The actual,
  // rendered HomePage.jsx/LandingPage.jsx/DatabaseLandingPage.jsx components
  // resolve colors from THIS map instead. 'mod-ai' previously had no entry
  // in ORC_HUES and silently fell back to gray (#94A3B8) — fixed here using
  // the value that was orphaned on ORC_HUES' dead 'mod-mlai' key.
  categoryColors: {
    'gs': '#0C7C8C',
    'mod-dashboard': '#2F6FED',
    'mod-agents': '#7C5CFC',
    'mod-databases': '#059669',
    'mod-cloud': '#0EA5E9',
    'mod-infrastructure': '#6366F1',
    'mod-alerts': '#F59E0B',
    'mod-ai': '#D946EF',
    'mod-administration': '#E11D48',
    'mod-settings': '#64748B',
    'mod-sales': '#F97316',
  },

  // Was the per-card `hue` field in databaseCardsConfig.js.
  engineColors: {
    postgresql: '#336791',
    mysql: '#00758F',
    oracle: '#F80000',
    mssql: '#A91D22',
    mongodb: '#00684A',
    clickhouse: '#D4B000',
    cosmosdb: '#7C5CFC',
    fundamentals: '#64748B',
  },

  cardSize: {
    preset: 'medium', // 'small' | 'medium' | 'large' | 'xl' | 'custom'
    custom: { width: null, minHeight: 220, padding: 20, gap: 16 },
  },

  // Dense, doc-portal-style grid — one shared density for every card grid
  // in the Help Center (Get Started, Browse ActMon, Database engines, and
  // every module's own landing page), not a different column count per
  // section.
  grid: {
    desktopColumns: 5,
    tabletColumns: 3,
    mobileColumns: 1,
    autoFit: false, // Phase 2
  },

  radius: { preset: 'md', customPx: null }, // 'none'|'sm'|'md'|'lg'|'xl'|'custom'
  shadow: { preset: 'sm', custom: null }, // 'none'|'sm'|'md'|'lg'|'custom'
  border: { enabled: true, widthPx: 1, opacity: 0.6, style: 'solid' },

  typography: {
    bodySize: 16,
    cardTitleSize: 19.2,
    descriptionSize: 16,
    footerSize: 13,
    sectionHeadingSize: 20.8,
    pageHeadingSize: 32,
    lineHeight: 1.5,
  },

  icon: {
    size: 20,
    containerShape: 'rounded', // 'square' | 'rounded' | 'circle'
    bgOpacity: 0.16,
    color: null, // null = inherit hue
  },

  // Every card image is full card width, edge-to-edge, at this ONE
  // configurable height — object-fit 'cover' crops to fill without
  // distorting or leaving empty space around a smaller source image, which
  // is what previously made engine logos look inconsistent card to card.
  image: {
    headerHeight: 120,
    objectFit: 'cover', // 'cover' | 'contain'
    radius: 0,
    containerBg: '#ffffff',
  },

  contentWidth: 'default', // 'narrow' | 'default' | 'wide' | 'full'

  sidebar: {
    width: 280,
    collapsedWidth: 56,
    bg: null,
    border: null,
    textSize: 14,
    headingSize: 11,
    itemSpacing: 2,
    activeColor: null,
    hoverColor: null,
  },

  pageBg: null,
  contentBg: null,
  headerBg: null,
};

/** Radius/shadow preset → concrete CSS value. 'custom' reads the sibling
 * `customPx`/`custom` field instead of this table. */
export const RADIUS_PX = { none: '0px', sm: '6px', md: '10px', lg: '14px', xl: '20px' };
export const SHADOW_CSS = {
  none: 'none',
  sm: '0 1px 2px rgba(15, 23, 42, 0.06)',
  md: '0 4px 12px rgba(15, 23, 42, 0.10)',
  lg: '0 10px 28px rgba(15, 23, 42, 0.16)',
};

/** Card-size preset → concrete dimensions. 'custom' reads `cardSize.custom`. */
export const CARD_SIZE_PRESETS = {
  small: { width: null, minHeight: 170, padding: 16, gap: 12 },
  medium: { width: null, minHeight: 220, padding: 20, gap: 16 },
  large: { width: null, minHeight: 280, padding: 24, gap: 20 },
  xl: { width: null, minHeight: 340, padding: 28, gap: 24 },
};

/**
 * Named theme presets — each a PARTIAL object deep-merged onto DEFAULT_CONFIG
 * (only what differs from the default needs to be listed). `softEnterprise`
 * and `enterprise` are fully tuned this pass, along with `minimal`. The
 * remaining 4 (modern/glass/highContrast/softPastel) are structurally
 * correct but intentionally rough — a real design pass is Phase 2 follow-up
 * work, not part of this implementation.
 */
export const PRESETS = {
  softEnterprise: {}, // this IS the default shape, kept as an explicit no-op entry
  enterprise: {
    colors: { primaryAccent: '#1D4ED8', secondaryAccent: '#4338CA', cardBorder: '#CBD5E1' },
    radius: { preset: 'sm', customPx: null },
    shadow: { preset: 'none', custom: null },
    border: { enabled: true, widthPx: 1, opacity: 1, style: 'solid' },
  },
  minimal: {
    colors: { primaryAccent: '#334155', secondaryAccent: '#64748B' },
    radius: { preset: 'md', customPx: null },
    shadow: { preset: 'none', custom: null },
    border: { enabled: false, widthPx: 1, opacity: 1, style: 'solid' },
  },
  // Phase 2: needs a real design pass — structurally correct, colors approximate.
  modern: {
    colors: { primaryAccent: '#6366F1', secondaryAccent: '#EC4899' },
    radius: { preset: 'xl', customPx: null },
    shadow: { preset: 'md', custom: null },
    border: { enabled: false, widthPx: 1, opacity: 1, style: 'solid' },
  },
  // Phase 2: needs a real design pass.
  glass: {
    colors: { primaryAccent: '#0EA5E9', secondaryAccent: '#38BDF8',
      cardBg: 'color-mix(in srgb, var(--surface) 72%, transparent)' },
    radius: { preset: 'lg', customPx: null },
    shadow: { preset: 'lg', custom: null },
    border: { enabled: true, widthPx: 1, opacity: 0.4, style: 'solid' },
  },
  // Phase 2: needs a real design pass.
  highContrast: {
    colors: { primaryAccent: '#1D4ED8', secondaryAccent: '#B91C1C',
      cardTitle: 'var(--fg)', cardDescription: 'var(--fg)' },
    radius: { preset: 'sm', customPx: null },
    shadow: { preset: 'none', custom: null },
    border: { enabled: true, widthPx: 2, opacity: 1, style: 'solid' },
  },
  // Phase 2: needs a real design pass.
  softPastel: {
    colors: { primaryAccent: '#2F6FED', secondaryAccent: '#7C5CFC' },
    radius: { preset: 'lg', customPx: null },
    shadow: { preset: 'sm', custom: null },
    border: { enabled: true, widthPx: 1, opacity: 0.4, style: 'solid' },
  },
};

export const PRESET_LABELS = {
  softEnterprise: 'Soft Enterprise / Pastel',
  enterprise: 'Enterprise',
  minimal: 'Minimal',
  modern: 'Modern',
  glass: 'Glass',
  highContrast: 'High Contrast',
  softPastel: 'Soft Pastel',
};

/** Deep-merge `override` onto `base`, returning a NEW object. Mirrors the
 * backend's own `_deep_merge` (help_center_appearance_routes.py) so both
 * sides resolve "partial config" the same way. */
export function deepMerge(base, override) {
  const result = { ...base };
  for (const key of Object.keys(override || {})) {
    const value = override[key];
    if (value && typeof value === 'object' && !Array.isArray(value) &&
        result[key] && typeof result[key] === 'object' && !Array.isArray(result[key])) {
      result[key] = deepMerge(result[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/** Resolve a saved server config into a full, renderable config: DEFAULT_CONFIG,
 * then the preset's partial (if `preset` names one), then the server's own
 * explicit field overrides on top (so a user's individual tweaks always win
 * over the preset they started from). */
export function resolveConfig(serverConfig) {
  const preset = serverConfig?.preset && PRESETS[serverConfig.preset] ? serverConfig.preset : 'softEnterprise';
  const withPreset = deepMerge(DEFAULT_CONFIG, PRESETS[preset] || {});
  return deepMerge(withPreset, serverConfig || {});
}
