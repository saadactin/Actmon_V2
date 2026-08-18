import Icon from '@/components/ui/Icon';
import { PhotoBand } from '../Illustration';
import { useHelpAppearance } from './HelpAppearanceContext';
import { cardStyleVars } from './cardStyleVars';

/**
 * The ONE image treatment for every Help Center card — full card width,
 * edge-to-edge, at the configurable `--hc-image-header-height` (default
 * 120px), object-fit `cover` by default (configurable) so a smaller or
 * differently-shaped source image fills the space without distortion or
 * leftover white space around it (the defect that made database-engine
 * logos look inconsistent card to card). Built on the existing `PhotoBand`
 * rather than a bare `<img>` so the `hue` tint that differentiates a photo
 * reused across several cards (see Illustration.jsx) still applies — only
 * the sizing/fit is now centralized here instead of a per-caller className.
 * Exported standalone as well as used internally by `DocumentationCard`,
 * per the "DocumentationCard + CardImage" pairing.
 */
export function CardImage({ src, alt = '', hue, config: configProp }) {
  const ctx = useHelpAppearance();
  const config = configProp || ctx.config;
  if (!src) return null;
  return (
    <PhotoBand
      src={src}
      alt={alt}
      hue={hue}
      fit={config.image.objectFit}
      className="hc-image-header w-full shrink-0 transition-transform duration-300 group-hover:scale-[1.03]"
    />
  );
}

/**
 * The ONE card shape for the entire Help Center — Get Started tiles, Browse
 * ActMon module tiles, every module's own landing-page children (Dashboard,
 * Agents, Cloud, Infrastructure, Alerts, AI Assistant, Administration,
 * Settings), and the Database engine grid all render through this single
 * component instead of four near-duplicate ones (ImageCard/ModuleCard/
 * ChildCard/EngineCard). Every visual property — background, border,
 * radius, shadow, padding, min-height, hover state, typography, image
 * height/fit, icon size — comes from the `--hc-*` variables set on the Help
 * Center root by `applyHelpAppearance.js` (or an isolated preview
 * container), which the admin-configurable Help Center Appearance settings
 * page controls. No per-page hardcoded visual values.
 *
 * Content shape is intentionally a superset covering every caller rather
 * than a family of variants: `image`/`icon` are both optional (a card shows
 * whichever it has, or neither), `meta`/`features`/`footerLeft`/
 * `footerRight` are optional pieces every caller mixes and matches.
 */
export default function DocumentationCard({
  onClick,
  disabled = false,
  image,
  imageAlt,
  hue,
  // Defaults to `hue` (tints the image so a photo reused across several
  // cards still reads as visually distinct). Pass `null` explicitly for a
  // card with its OWN dedicated, deliberately-chosen photo, which should
  // show in its real colors — matches the original ModuleCard's
  // `dedicated` behavior for HomePage.jsx's FIXED_PHOTO entries.
  imageHue = hue,
  icon,
  title,
  meta,
  description,
  features,
  footerLeft,
  footerRight,
  // Shown, without the top border/link footer row, in place of
  // footerLeft/footerRight — for a disabled/coming-soon card that has an
  // explanatory note instead of a real destination to link to.
  disabledNote,
  className = '',
  // Optional override — every real page omits this and reads the LIVE
  // saved config via context. The appearance editor's live preview passes
  // its unsaved DRAFT here instead, so the same real component can render
  // "what this would look like" without touching the actual app state.
  config: configProp,
}) {
  const ctx = useHelpAppearance();
  const config = configProp || ctx.config;
  const { cardStyle, iconStyle } = cardStyleVars(hue, config);
  const hasHeaderRow = Boolean(icon || meta);
  const hasFooterRow = !disabledNote && Boolean(footerLeft || footerRight);

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`hc-card group flex h-full flex-col overflow-hidden text-left ${disabled ? 'cursor-default opacity-70' : ''} ${className}`}
      // A hue top-border accent is skipped when there's an image (must sit
      // truly edge-to-edge at the card's top, not below a colored strip)
      // and for disabled/coming-soon cards (no real destination to accent).
      style={{ padding: 0, ...(image || disabled ? undefined : cardStyle) }}
    >
      <CardImage src={image} alt={imageAlt || title} hue={disabled ? 'var(--border-strong)' : imageHue} config={configProp} />

      <div className="flex flex-1 flex-col gap-2" style={{ padding: 'var(--hc-card-padding)' }}>
        {hasHeaderRow ? (
          <div className="flex items-center gap-2.5">
            {icon && (
              <span className="hc-icon" style={disabled ? { background: 'var(--surface-sunken)', color: 'var(--fg-subtle)' } : iconStyle}>
                <Icon name={icon} size={18} />
              </span>
            )}
            <span className="hc-card-title min-w-0 flex-1 truncate-safe font-semibold">{title}</span>
            {meta && <span className="shrink-0 font-mono text-[10px] whitespace-nowrap text-subtle">{meta}</span>}
          </div>
        ) : (
          title && <span className="hc-card-title font-semibold">{title}</span>
        )}

        {description && <p className="hc-card-description">{description}</p>}

        {features && features.length > 0 && (
          <ul className="flex flex-col gap-1.5">
            {features.map((f) => (
              <li key={f} className="hc-card-description flex items-start gap-2">
                <Icon name="check" size={13} className="mt-[3px] shrink-0" style={{ color: hue }} />
                {f}
              </li>
            ))}
          </ul>
        )}

        {disabledNote && <p className="hc-card-footer mt-auto italic">{disabledNote}</p>}

        {hasFooterRow && (
          <div className="mt-auto flex items-center justify-between border-t border-border pt-3">
            <span className="hc-card-footer font-mono">{footerLeft}</span>
            <span className="hc-card-footer flex items-center gap-1 font-mono font-bold" style={{ color: hue || 'var(--accent-text)' }}>
              {footerRight}
              {footerRight && <Icon name="chevron-right" size={12} className="transition-transform group-hover:translate-x-0.5" />}
            </span>
          </div>
        )}
      </div>
    </button>
  );
}
