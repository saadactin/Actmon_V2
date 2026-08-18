/**
 * Help Center design tokens — the ONE place card sizes, content width, and
 * typography scale are defined. Components reference these constants
 * instead of scattering arbitrary Tailwind values (`h-[247px]`, `text-[13.2px]`)
 * across the codebase — change the scale once here, every card/heading
 * updates consistently.
 *
 * These sit ON TOP of the app-wide token system (styles/tokens.css) — colors,
 * radius, and spacing still come from the real CSS custom properties (var
 * (--accent), var(--radius-card), gap-lg, …), never redefined here. This
 * file only centralizes the Help-Center-specific SCALE decisions the brief
 * asked for (card heights, content width, heading sizes) that don't already
 * have an app-wide equivalent.
 */
export const LAYOUT = {
  contentMaxWidth: '1440px',
  sidebarWidth: '17rem', // 272px
};

/** Every size below is `calc(Xrem*var(--help-font-scale,1))` rather than a
 * bare rem/px value — `--help-font-scale` is set once, on the Help Center's
 * outer wrapper, by the reader's own text-size control (see fontScale.js)
 * and cascades to every element using these tokens, so "make it bigger" is
 * a real, live, user-controlled setting, not just a bigger fixed default.
 * Body and secondary body text are BOTH 1rem (16px) at the default scale —
 * no text in the Help Center reads smaller than that.
 *
 * These MUST be written out as literal strings (not built from a template/
 * helper function) — Tailwind's build-time scanner finds utility classes by
 * pattern-matching the literal text of source files, it does not evaluate
 * JS, so a dynamically-assembled class name here would silently produce no
 * CSS at all. */
export const TYPE = {
  hero: 'text-[calc(2.25rem*var(--help-font-scale,1))] sm:text-[calc(2.75rem*var(--help-font-scale,1))]',
  pageTitle: 'text-[calc(2rem*var(--help-font-scale,1))] sm:text-[calc(2.3rem*var(--help-font-scale,1))]',
  sectionTitle: 'text-[calc(1.3rem*var(--help-font-scale,1))]',
  cardTitle: 'text-[calc(1.2rem*var(--help-font-scale,1))]',
  cardTitleCompact: 'text-[calc(1.05rem*var(--help-font-scale,1))]',
  body: 'text-[calc(1rem*var(--help-font-scale,1))]',
  bodySecondary: 'text-[calc(1rem*var(--help-font-scale,1))]',
};

/** Card height bands — "large" for module/engine/category landing cards
 * (the primary navigation surface), "compact" for dense reference lists. */
export const CARD = {
  largeMinHeight: 'min-h-[320px]',
  mediumMinHeight: 'min-h-[190px]',
  radius: 'rounded-card',
  artworkHeightLarge: 'h-44',
  artworkHeightMedium: 'h-20',
};

export const MOTION = {
  fast: 'duration-150',
  normal: 'duration-200',
};
