/**
 * Per-card style resolution — the ONE place a category/engine hue turns into
 * concrete inline styles (icon chip background/color, accent top-border).
 * Everything else about a card's look (background, border, radius, shadow,
 * padding, hover state) comes from the `.hc-card` CSS class in helpCards.css,
 * which reads the `--hc-*` variables set once on the Help Center root by
 * applyHelpAppearance.js — components never hardcode those values.
 */
export function cardStyleVars(hue, config) {
  const iconBg = config?.colors?.iconBg || `color-mix(in srgb, ${hue} var(--hc-icon-bg-opacity, 16%), var(--surface))`;
  const iconColor = config?.colors?.iconColor || hue;
  return {
    cardStyle: hue ? { borderTop: `3px solid ${hue}` } : undefined,
    iconStyle: { background: iconBg, color: iconColor },
    accentColor: hue,
  };
}

/** Resolve a category tree-id ('mod-dashboard', 'gs', …) or engine slug
 * ('postgresql', …) to its configured hex, falling back to the shipped
 * default for anything the admin hasn't (yet) customized — e.g. a newly
 * added module/engine that predates the last save. */
export function resolveCategoryColor(config, id, DEFAULT_CONFIG) {
  return config.categoryColors?.[id] ?? DEFAULT_CONFIG.categoryColors?.[id] ?? '#94A3B8';
}

export function resolveEngineColor(config, slug, DEFAULT_CONFIG) {
  return config.engineColors?.[slug] ?? DEFAULT_CONFIG.engineColors?.[slug] ?? '#64748B';
}
