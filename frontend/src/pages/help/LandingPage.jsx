import { leafCount } from './content/tree';
import { TYPE } from './designTokens';
import { useHelpAppearance } from './appearance/HelpAppearanceContext';
import { DEFAULT_CONFIG } from './appearance/helpAppearanceConfig';
import { resolveCategoryColor } from './appearance/cardStyleVars';
import DocumentationCard from './appearance/DocumentationCard';

/**
 * Renders ONE level of the documentation tree as a grid of large cards —
 * never the full descendant list. This is what makes navigation
 * progressive: clicking PostgreSQL shows its own ~6 category cards; clicking
 * a category shows that category's actual articles. Every level uses this
 * same component, so the pattern (and its fix, if one is ever needed) is
 * consistent everywhere instead of hand-built per page.
 *
 * The Database module's own top-level page is the one exception — it has a
 * real image and feature list per engine, so it uses the purpose-built
 * `DatabaseLandingPage` instead (see HelpCenterPage.jsx's routing).
 */
export default function LandingPage({ node, go }) {
  const { config } = useHelpAppearance();
  return (
    <div>
      <h1 className={`mb-1.5 font-semibold tracking-[-0.01em] text-fg ${TYPE.pageTitle}`}>{node.title}</h1>
      {node.dek && <p className="mb-6 max-w-[75ch] text-muted">{node.dek}</p>}

      <div className="hc-grid">
        {(node.children || []).map((child) => {
          const isLeaf = !!child.doc;
          const count = isLeaf ? null : leafCount(child);
          return (
            <DocumentationCard
              key={child.id}
              onClick={() => go(child.doc || child.id)}
              disabled={child.comingSoon}
              hue={resolveCategoryColor(config, child.id, DEFAULT_CONFIG)}
              icon={child.comingSoon ? 'clock' : (isLeaf ? 'report' : 'database')}
              title={child.title}
              meta={child.comingSoon ? 'Soon' : undefined}
              description={child.comingSoon ? undefined : child.dek}
              disabledNote={child.comingSoon ? child.dek : undefined}
              footerLeft={child.comingSoon ? undefined : (isLeaf ? 'Article' : `${count} topic${count !== 1 ? 's' : ''}`)}
              footerRight={child.comingSoon ? undefined : (isLeaf ? 'Read article' : 'Explore')}
            />
          );
        })}
      </div>
    </div>
  );
}
