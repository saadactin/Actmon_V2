import { findNode, leafCount } from './content/tree';
import { TYPE } from './designTokens';
import { DB_ENGINE_CARDS, DB_FUNDAMENTALS_CARD } from './databaseCardsConfig';
import { useHelpAppearance } from './appearance/HelpAppearanceContext';
import { DEFAULT_CONFIG } from './appearance/helpAppearanceConfig';
import { resolveEngineColor } from './appearance/cardStyleVars';
import DocumentationCard from './appearance/DocumentationCard';

/**
 * The Database module's landing page — every one of its 7 engines has a
 * real image and a short feature list, sourced from `databaseCardsConfig.js`
 * and rendered through the SAME `DocumentationCard` every other Help Center
 * grid uses (Get Started, Browse ActMon, every module's own landing page) —
 * not a bespoke per-engine layout. The image header height/fit is fully
 * centralized (`--hc-image-header-height`/`--hc-image-object-fit`, set via
 * Help Center Appearance) — this is what fixes the actual defect: PostgreSQL's
 * logo, MySQL's banner, and Oracle's banner previously had different
 * effective sizes because nothing constrained the image area to one shared,
 * configurable height and fit.
 */
export default function DatabaseLandingPage({ node, go }) {
  const { config } = useHelpAppearance();
  const cards = [...DB_ENGINE_CARDS, DB_FUNDAMENTALS_CARD];

  return (
    <div>
      <h1 className={`mb-1.5 font-semibold tracking-[-0.01em] text-fg ${TYPE.pageTitle}`}>{node.title}</h1>
      {node.dek && <p className="mb-6 max-w-[75ch] text-muted">{node.dek}</p>}

      <div className="hc-grid">
        {cards.map((cfg) => {
          const treeNode = findNode(cfg.treeId);
          const count = treeNode ? leafCount(treeNode) : 0;
          const hue = resolveEngineColor(config, cfg.engineSlug, DEFAULT_CONFIG);
          return (
            <DocumentationCard
              key={cfg.treeId}
              onClick={() => go(cfg.treeId)}
              image={cfg.image}
              imageAlt={cfg.title}
              hue={hue}
              title={cfg.title}
              description={cfg.description}
              features={cfg.features}
              footerLeft={`${count} topic${count !== 1 ? 's' : ''}`}
              footerRight="Explore"
            />
          );
        })}
      </div>
    </div>
  );
}
