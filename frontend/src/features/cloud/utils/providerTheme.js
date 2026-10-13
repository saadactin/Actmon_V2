/**
 * PROVIDER BRAND REGISTRY — one place that knows how each cloud presents itself.
 *
 * The same role `config/engines.js` + `engineColor()` play for the database
 * technologies: an engine is the same colour in the agents list, the databases
 * hub, every dashboard and every chart because exactly one module decides it.
 * Cloud had five copies of that decision — `CloudProviderSelector.PROVIDER_META`,
 * `topologyModel.PROVIDER_META`, `eventFormat.PROVIDER_BADGE_CLASSES`,
 * `ProviderLogo.PROVIDER_COLOR` and inline maps in the chooser, the accounts
 * list, the accounts page and the add-account form — which had already drifted
 * (AWS was `border-orange-200` in one and `border-orange-300` in another,
 * `text-orange-500`, `-600` and `-700` all appeared as "the AWS text colour").
 *
 * The brand hues stay pinned, exactly as the previous comments insisted: they are
 * external identity, not our palette, and `--chart-N` would repaint AWS blue on a
 * palette switch. What changes is how they are APPLIED.
 *
 * ── Why the Tailwind palette classes had to go ────────────────────────────────
 * `bg-orange-50 text-orange-700` is a light-theme swatch, not a colour: #fff7ed
 * is fixed, so on `dim`, `dark` and `midnight` (--surface #222b3c / #121a2e /
 * #0c0c0f) every provider badge rendered as a near-white chip burning a hole in
 * the card. The app ships four dark themes; a pinned light swatch is simply a bug
 * in three of them, and `styles/tokens.css` says so in its first paragraph —
 * components style themselves through tokens, "never with hard-coded values like
 * `bg-white` or `text-slate-900`".
 *
 * So the hue is pinned and the SURFACE is mixed against the live theme, which is
 * what `EngineDashboardHeader` already does for an engine's mark:
 *
 *     background: color-mix(in srgb, ${engine.color} 16%, transparent)
 *
 * A translucent tint composites over whatever surface it lands on, so it is a
 * pale wash on `light` and a deep one on `midnight` without either being told
 * about the other. Text mixes toward `var(--fg)` instead, so AWS orange darkens
 * to a readable ink on a white card and lightens on a black one while staying
 * recognisably orange.
 *
 * Colour is never the only signal: every call site renders the provider's name or
 * mark beside the tint, because "which cloud is this" must survive a colour-blind
 * reader and a greyscale print.
 */
import { providerKeyOf } from './providerScope';

/**
 * Official brand hues, and the only hard-coded colours this module allows.
 *
 * These are the values already drawn into the inline SVG marks in
 * `ProviderLogo.jsx` (AWS Smile orange, Azure's #0078D4, Oracle's #C74634), kept
 * here so the tile tint behind a logo cannot drift from the logo itself.
 */
export const PROVIDER_COLOR = {
  AWS: '#FF9900',
  Azure: '#0078D4',
  OCI: '#C74634',
};

/** Anything unrecognised uses the theme's own "we don't know" ink, not a hue. */
export const UNKNOWN_COLOR = 'var(--status-unknown)';

/**
 * Brand hue for a provider. Accepts a canonical key, the raw API value
 * ("Oracle" — see `providerKeyOf`) or anything else, which lands on neutral.
 */
export const providerColor = (provider) => PROVIDER_COLOR[providerKeyOf(provider)] ?? UNKNOWN_COLOR;

/** True when the provider is one we have a pinned brand hue for. */
export const isKnownProvider = (provider) => Boolean(PROVIDER_COLOR[providerKeyOf(provider)]);

/**
 * Inline style for a provider chip — tinted surface, brand-leaning ink, hairline
 * border. Pass to any `<Badge style={…}>`; `Badge` already forwards `style`, so
 * the shared component keeps its shape, padding, radius and font weight and only
 * its colours come from here.
 *
 * `strength` scales the whole treatment together for the few places that want a
 * louder chip (an active filter pill) without inventing a second colour set.
 */
export const providerBadgeStyle = (provider, strength = 1) => {
  const color = providerColor(provider);
  return {
    backgroundColor: `color-mix(in srgb, ${color} ${14 * strength}%, transparent)`,
    color: `color-mix(in srgb, ${color} 72%, var(--fg))`,
    borderColor: `color-mix(in srgb, ${color} ${32 * strength}%, transparent)`,
  };
};

/**
 * Brand-leaning ink for a provider's name.
 *
 * Mixed toward `var(--fg)` rather than used neat: #FF9900 on a white card is
 * barely legible and #C74634 on a black one is close to invisible, so the hue
 * is pulled toward whatever the theme's text colour is until it reads as text
 * that happens to be orange rather than as decoration.
 */
export const providerInkStyle = (provider) => ({
  color: `color-mix(in srgb, ${providerColor(provider)} 72%, var(--fg))`,
});

/**
 * Inline style for the square plate a provider logo sits on.
 *
 * Replaces `border border-border bg-white`, which pinned a white plate behind the
 * mark on every theme — the one shape on a midnight page that still glowed.
 * A tint of the provider's own hue reads as deliberate on all five themes and
 * matches how an engine's mark is plated on the database dashboards.
 */
export const providerTileStyle = (provider) => {
  const color = providerColor(provider);
  return {
    backgroundColor: `color-mix(in srgb, ${color} 12%, var(--surface))`,
    borderColor: `color-mix(in srgb, ${color} 26%, transparent)`,
  };
};

/** Just the tinted surface — for a bar, rail or hover wash that carries no text. */
export const providerWashStyle = (provider, pct = 10) => ({
  backgroundColor: `color-mix(in srgb, ${providerColor(provider)} ${pct}%, transparent)`,
});

/**
 * Accent bar / gradient for the provider tiles on the chooser.
 *
 * The chooser drew `bg-gradient-to-br from-orange-400 to-orange-600` per tile,
 * three more pinned light-palette ramps. Mixing the brand hue against the two
 * ends keeps the depth the gradient was there for without leaving the theme.
 */
export const providerAccentStyle = (provider) => {
  const color = providerColor(provider);
  return {
    backgroundImage: `linear-gradient(135deg, color-mix(in srgb, ${color} 86%, white) 0%, ${color} 55%, color-mix(in srgb, ${color} 80%, black) 100%)`,
  };
};
