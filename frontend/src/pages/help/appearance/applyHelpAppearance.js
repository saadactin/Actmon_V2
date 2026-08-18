import { RADIUS_PX, SHADOW_CSS, CARD_SIZE_PRESETS } from './helpAppearanceConfig';

const px = (n) => (n === null || n === undefined ? undefined : `${n}px`);

function resolveRadius(radius) {
  if (!radius) return RADIUS_PX.md;
  if (radius.preset === 'custom') return px(radius.customPx) || RADIUS_PX.md;
  return RADIUS_PX[radius.preset] || RADIUS_PX.md;
}

function resolveShadow(shadow) {
  if (!shadow) return SHADOW_CSS.sm;
  if (shadow.preset === 'custom') return shadow.custom || SHADOW_CSS.sm;
  return SHADOW_CSS[shadow.preset] || SHADOW_CSS.sm;
}

function resolveCardSize(cardSize) {
  if (!cardSize) return CARD_SIZE_PRESETS.medium;
  if (cardSize.preset === 'custom') return cardSize.custom || CARD_SIZE_PRESETS.medium;
  return CARD_SIZE_PRESETS[cardSize.preset] || CARD_SIZE_PRESETS.medium;
}

function iconRadius(shape, size) {
  if (shape === 'circle') return '9999px';
  if (shape === 'square') return '0px';
  return px(Math.round((size || 20) * 0.5)); // 'rounded'
}

/** Resolve `config.mode` ('light'|'dark'|'system') against the browser's
 * prefers-color-scheme, for a `data-hc-mode` attribute consumers branch on. */
export function resolveHelpMode(mode) {
  if (mode === 'light' || mode === 'dark') return mode;
  if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches) {
    return 'dark';
  }
  return 'light';
}

/** Build the full `--hc-*` CSS custom property map for a resolved config
 * (already deep-merged via `resolveConfig()`). Consumers write this as an
 * inline `style` object — on the real Help Center root for the live app, or
 * on an isolated preview container for the appearance editor's live preview
 * (see HelpCenterAppearancePage.jsx) — never both at once for the same
 * config, so unsaved edits can't leak between the two. */
export function buildHelpAppearanceVars(config) {
  const size = resolveCardSize(config.cardSize);
  const vars = {
    '--hc-primary-accent': config.colors.primaryAccent,
    '--hc-secondary-accent': config.colors.secondaryAccent,
    '--hc-card-bg': config.colors.cardBg || 'var(--surface)',
    '--hc-card-border': config.colors.cardBorder || 'var(--border)',
    '--hc-card-title-color': config.colors.cardTitle || 'var(--fg)',
    '--hc-card-description-color': config.colors.cardDescription || 'var(--fg-muted)',
    '--hc-card-footer-color': config.colors.cardFooter || 'var(--fg-subtle)',
    // Explicit admin override only — when unset, each card instead tints its
    // icon from its OWN category/engine hue via cardStyleVars() (see
    // cardStyleVars.js), since a single flat variable can't hold one color
    // per card. Consumers check `colors.iconBg`/`colors.iconColor` directly
    // (not these two vars) to decide which behavior applies.
    '--hc-icon-bg': config.colors.iconBg || 'var(--accent-soft)',
    '--hc-icon-color': config.colors.iconColor || 'var(--accent)',
    '--hc-hover-bg': config.colors.hoverBg || 'var(--accent-soft)',
    '--hc-hover-border': config.colors.hoverBorder || 'var(--accent-border)',

    '--hc-card-width': size.width ? px(size.width) : 'auto',
    '--hc-card-min-height': px(size.minHeight),
    '--hc-card-padding': px(size.padding),
    '--hc-card-gap': px(size.gap),

    '--hc-grid-desktop-cols': String(config.grid.desktopColumns),
    '--hc-grid-tablet-cols': String(config.grid.tabletColumns),
    '--hc-grid-mobile-cols': String(config.grid.mobileColumns),

    '--hc-card-radius': resolveRadius(config.radius),
    '--hc-card-shadow': resolveShadow(config.shadow),
    '--hc-card-border-width': config.border.enabled ? px(config.border.widthPx) : '0px',
    '--hc-card-border-opacity': String(config.border.enabled ? config.border.opacity : 0),
    '--hc-card-border-style': config.border.style,

    '--hc-type-body': px(config.typography.bodySize),
    '--hc-type-card-title': px(config.typography.cardTitleSize),
    '--hc-type-description': px(config.typography.descriptionSize),
    '--hc-type-footer': px(config.typography.footerSize),
    '--hc-type-section-heading': px(config.typography.sectionHeadingSize),
    '--hc-type-page-heading': px(config.typography.pageHeadingSize),
    '--hc-line-height': String(config.typography.lineHeight),

    '--hc-icon-size': px(config.icon.size),
    '--hc-icon-radius': iconRadius(config.icon.containerShape, config.icon.size),
    '--hc-icon-bg-opacity': String(config.icon.bgOpacity),

    '--hc-image-header-height': px(config.image.headerHeight),
    '--hc-image-object-fit': config.image.objectFit,
    '--hc-image-radius': px(config.image.radius),
    '--hc-image-container-bg': config.image.containerBg,

    '--hc-content-max-width': config.contentWidth === 'custom' && config.contentWidthPx
      ? px(config.contentWidthPx)
      : { narrow: '960px', default: '1200px', wide: '1440px', full: '100%' }[config.contentWidth] || '1440px',

    '--hc-sidebar-width': px(config.sidebar.width),
    '--hc-sidebar-collapsed-width': px(config.sidebar.collapsedWidth),
    '--hc-sidebar-bg': config.sidebar.bg || 'var(--surface)',
    '--hc-sidebar-border': config.sidebar.border || 'var(--border)',
    '--hc-sidebar-text-size': px(config.sidebar.textSize),
    '--hc-sidebar-heading-size': px(config.sidebar.headingSize),
    '--hc-sidebar-item-spacing': px(config.sidebar.itemSpacing),
    '--hc-sidebar-active-color': config.sidebar.activeColor || 'var(--accent)',
    '--hc-sidebar-hover-color': config.sidebar.hoverColor || 'var(--accent-text)',

    '--hc-page-bg': config.pageBg || 'var(--bg)',
    '--hc-content-bg': config.contentBg || 'var(--surface)',
    '--hc-header-bg': config.headerBg || 'var(--surface)',
  };

  for (const [id, hex] of Object.entries(config.categoryColors || {})) {
    vars[`--hc-cat-${id.replace(/^mod-/, '').replace(/^db-cat-/, '')}`] = hex;
  }
  for (const [slug, hex] of Object.entries(config.engineColors || {})) {
    vars[`--hc-engine-${slug}`] = hex;
  }

  return vars;
}
