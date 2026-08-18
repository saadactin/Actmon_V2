import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import cn from '@/lib/cn';
import PageHeader from '@/components/layout/PageHeader';
import Icon from '@/components/ui/Icon';
import { DOCS, TREE, findNode, pathTo, flattenLeaves } from './content';
import { useHelpSearchIndex, searchDocs } from './useHelpSearch';
import ResizableSidebar from '@/components/layout/ResizableSidebar';
import IconButton from '@/components/ui/IconButton';
import HomePage from './HomePage';
import SearchResultsPage from './SearchResultsPage';
import LandingPage from './LandingPage';
import DatabaseLandingPage from './DatabaseLandingPage';
import { useFontScale } from './fontScale';
import { HelpAppearanceProvider, useHelpAppearance } from './appearance/HelpAppearanceContext';
import { buildHelpAppearanceVars, resolveHelpMode } from './appearance/applyHelpAppearance';
import './helpArticle.css';
import './appearance/helpCards.css';

/**
 * Help Center — progressive-disclosure documentation library.
 *
 * `?doc=home` → the redesigned home page. `?doc=search:<query>` → full
 * search results. Anything else is looked up in the documentation TREE
 * (content/tree.js), the single source of truth for hierarchy:
 *   - a LANDING node (has children) renders LandingPage — a grid of ONLY
 *     that node's direct children, never the whole subtree.
 *   - a LEAF node (has `.doc`) renders the actual article, `DOCS[doc]`.
 *
 * The sidebar is context-sensitive, not a fully-expanded tree: it shows the
 * children of the DEEPEST landing-node ancestor of the current page (see
 * `sidebarContext`), so drilling into Database → PostgreSQL → Replication &
 * Patroni HA narrows the sidebar to exactly that category's own articles,
 * matching how the breadcrumb/main content narrows too — not a fixed,
 * always-fully-expanded module tree.
 */
export default function HelpCenterPage() {
  return (
    <HelpAppearanceProvider>
      <HelpCenterPageInner />
    </HelpAppearanceProvider>
  );
}

function HelpCenterPageInner() {
  const [params, setParams] = useSearchParams();
  const activeId = params.get('doc') || 'home';
  const isHome = activeId === 'home';
  const isSearch = activeId.startsWith('search:');
  const searchQuery = isSearch ? activeId.slice('search:'.length) : '';

  const treeNode = !isHome && !isSearch ? findNode(activeId) : null;
  const isLandingPage = !!(treeNode && treeNode.children && treeNode.children.length);
  const doc = treeNode && treeNode.doc ? DOCS[treeNode.doc] : (!isHome && !isSearch && !treeNode ? DOCS[activeId] : null);

  const go = (id) => {
    if (id === 'home' || id.startsWith('search:') || findNode(id) || DOCS[id]) {
      setParams((p) => { const n = new URLSearchParams(p); n.set('doc', id); return n; }, { replace: false });
      document.getElementById('help-main')?.scrollTo(0, 0);
    }
  };

  // Article body HTML still carries onclick="go('...')" for cross-links —
  // bind it globally so those inline handlers resolve.
  useEffect(() => {
    window.go = go;
    return () => { delete window.go; };
  });

  const searchIndex = useHelpSearchIndex();
  const [query, setQuery] = useState('');
  const results = useMemo(() => searchDocs(searchIndex, query, 12), [query, searchIndex]);

  // Prev/Next walks the leaf articles of the CURRENT category only (its
  // section's own reading order), not the entire documentation — jumping
  // from the last Patroni article should offer the next category, not an
  // arbitrary unrelated topic three modules away. We find the deepest
  // landing ancestor's leaves and locate the current doc within them.
  const trail = !isHome && !isSearch ? pathTo(activeId) : null;
  const sidebarContext = useMemo(() => deepestLandingAncestor(trail), [trail]);
  const sectionLeaves = useMemo(() => (sidebarContext ? flattenLeaves(sidebarContext) : []), [sidebarContext]);
  const flowId = treeNode?.doc || activeId;
  const flowIdx = sectionLeaves.indexOf(flowId);
  const prevDoc = flowIdx > 0 ? DOCS[sectionLeaves[flowIdx - 1]] : null;
  const nextDoc = flowIdx >= 0 && flowIdx < sectionLeaves.length - 1 ? DOCS[sectionLeaves[flowIdx + 1]] : null;
  const prevId = flowIdx > 0 ? sectionLeaves[flowIdx - 1] : null;
  const nextId = flowIdx >= 0 && flowIdx < sectionLeaves.length - 1 ? sectionLeaves[flowIdx + 1] : null;

  // Header height is measured (description can wrap, density settings
  // change it), so the nav+content pane below is sized to exactly the
  // space left — only the sidebar and article scroll, <main> itself never
  // does.
  const headerRef = useRef(null);
  const [headerH, setHeaderH] = useState(0);
  useLayoutEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setHeaderH(entry.contentRect.height));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fontScale = useFontScale();
  const { config } = useHelpAppearance();

  return (
    <div
      data-hc-mode={resolveHelpMode(config.mode)}
      style={{ '--help-font-scale': fontScale.scale, ...buildHelpAppearanceVars(config) }}
    >
      <div ref={headerRef}>
        <PageHeader
          icon="help"
          title="Help Center"
          description="ActMon product documentation — guides, procedures, reference, and troubleshooting for every implemented module."
          actions={(
            <div className="flex items-center gap-2.5">
              <TextSizeControl fontScale={fontScale} />
              <div className="relative w-64">
                <Icon name="search" size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-subtle" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && query.trim()) { go(`search:${query.trim()}`); setQuery(''); } }}
                  placeholder="Search documentation…"
                  className="h-9 w-full rounded-control border border-border bg-sunken pl-8 pr-3 text-[12.5px] text-fg placeholder:text-subtle focus:border-accent-border focus:outline-none"
                />
                {results.length > 0 && (
                  <div className="absolute top-[calc(100%+6px)] right-0 left-0 z-20 max-h-[60vh] overflow-y-auto rounded-md border border-border bg-surface p-1.5 shadow-lg">
                    {results.map((r) => (
                      <button
                        key={r.id}
                        type="button"
                        onClick={() => { go(r.id); setQuery(''); }}
                        className="block w-full rounded-md px-2.5 py-2 text-left transition-colors hover:bg-sunken"
                      >
                        <div className="truncate-safe text-[10.5px] font-semibold tracking-wide text-subtle uppercase">{r.module}</div>
                        <div className="truncate-safe text-[13px] font-semibold text-fg">{r.title}</div>
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() => { go(`search:${query.trim()}`); setQuery(''); }}
                      className="mt-0.5 block w-full rounded-md px-2.5 py-2 text-left font-mono text-[11px] font-bold text-accent-text hover:bg-accent-soft"
                    >
                      See all results →
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
        />
      </div>

      <div
        className="card mb-[calc(-1*var(--gap-lg))] flex min-h-0 overflow-hidden"
        style={{ height: `calc(100vh - var(--topnav-h) - ${headerH}px)` }}
      >
        <ResizableSidebar
          defaultWidth={config.sidebar.width}
          minWidth={220}
          maxWidth={450}
          collapsedWidth={config.sidebar.collapsedWidth}
          storageKey="actmon.help.sidebar"
          collapsedContent={<CollapsedHelpRail go={go} />}
        >
          <HelpSidebar activeId={activeId} isHome={isHome} context={sidebarContext} go={go} />
        </ResizableSidebar>

        <main id="help-main" className="min-w-0 flex-1 overflow-y-auto px-6 py-6 md:px-8">
          {isHome ? (
            <HomePage go={go} />
          ) : isSearch ? (
            <SearchResultsPage query={searchQuery} go={go} />
          ) : isLandingPage ? (
            <>
              <TreeBreadcrumbs activeId={activeId} go={go} />
              {treeNode.id === 'mod-databases'
                ? <DatabaseLandingPage node={treeNode} go={go} />
                : <LandingPage node={treeNode} go={go} />}
            </>
          ) : doc ? (
            <>
              <TreeBreadcrumbs activeId={activeId} go={go} />
              <div className="flex gap-8 2xl:gap-10">
                <article className="min-w-0 flex-1">
                  <h1 className="mb-1.5 text-[calc(1.75rem*var(--help-font-scale,1))] leading-[1.2] font-semibold tracking-[-0.01em] text-fg">{doc.title}</h1>
                  {doc.dek && <p className="mb-5 max-w-[70ch] text-[calc(1rem*var(--help-font-scale,1))] text-muted">{doc.dek}</p>}
                  {!doc.noMeta && <HelpMeta doc={doc} />}

                  <ArticleBody body={doc.body} />

                  <RelatedTopics activeId={flowId} doc={doc} go={go} />
                  <WasThisHelpful docId={activeId} />

                  {(prevDoc || nextDoc) && (
                    <div className="mt-11 flex justify-between gap-3.5 border-t border-border pt-5">
                      {prevDoc ? (
                        <button type="button" onClick={() => go(prevId)}
                          className="flex max-w-[44%] flex-col items-start gap-0.5 rounded-md border border-border bg-surface px-3.5 py-3 text-left transition-colors hover:border-accent hover:bg-accent-soft">
                          <span className="font-mono text-[9.5px] tracking-wide text-subtle uppercase">← Previous</span>
                          <span className="font-mono text-[13.5px] font-semibold text-fg">{prevDoc.title}</span>
                        </button>
                      ) : <span />}
                      {nextDoc ? (
                        <button type="button" onClick={() => go(nextId)}
                          className="ml-auto flex max-w-[44%] flex-col items-end gap-0.5 rounded-md border border-border bg-surface px-3.5 py-3 text-right transition-colors hover:border-accent hover:bg-accent-soft">
                          <span className="font-mono text-[9.5px] tracking-wide text-subtle uppercase">Next →</span>
                          <span className="font-mono text-[13.5px] font-semibold text-fg">{nextDoc.title}</span>
                        </button>
                      ) : <span />}
                    </div>
                  )}
                </article>
                <OnThisPage bodyKey={activeId} />
              </div>
            </>
          ) : (
            <HomePage go={go} />
          )}
        </main>
      </div>
    </div>
  );
}

/** The reader's own text-size control — persisted (see fontScale.js),
 * scoped to the Help Center only via `--help-font-scale`, which every
 * TYPE-token size (designTokens.js) and every `.help-article` rule
 * (helpArticle.css) is expressed in terms of. */
function TextSizeControl({ fontScale }) {
  return (
    <div className="flex items-center gap-0.5 rounded-control border border-border bg-sunken p-0.5">
      <button
        type="button"
        onClick={fontScale.decrease}
        disabled={fontScale.atMin}
        title="Decrease text size"
        aria-label="Decrease text size"
        className="grid h-8 w-8 place-items-center rounded-[calc(var(--radius-control)-2px)] text-fg transition-colors hover:bg-surface disabled:pointer-events-none disabled:opacity-35"
      >
        <span className="text-[11px] font-bold">A</span>
      </button>
      <button
        type="button"
        onClick={fontScale.reset}
        title="Reset text size"
        aria-label="Reset text size"
        className="min-w-[2.75rem] rounded-[calc(var(--radius-control)-2px)] px-1 py-1.5 text-center font-mono text-[10.5px] font-semibold text-muted transition-colors hover:bg-surface hover:text-fg"
      >
        {Math.round(fontScale.scale * 100)}%
      </button>
      <button
        type="button"
        onClick={fontScale.increase}
        disabled={fontScale.atMax}
        title="Increase text size"
        aria-label="Increase text size"
        className="grid h-8 w-8 place-items-center rounded-[calc(var(--radius-control)-2px)] text-fg transition-colors hover:bg-surface disabled:pointer-events-none disabled:opacity-35"
      >
        <span className="text-[15px] font-bold">A</span>
      </button>
    </div>
  );
}

/** Walks a root→node ancestor trail and returns the DEEPEST entry that is
 * itself a landing node (has children) — including the current node if it
 * is one. This is what the sidebar and prev/next both key off: the
 * currently-relevant "shelf" of siblings, not the whole tree. */
function deepestLandingAncestor(trail) {
  if (!trail) return null;
  for (let i = trail.length - 1; i >= 0; i--) {
    if (trail[i].children && trail[i].children.length) return trail[i];
  }
  return trail[1] || null;
}

function TreeBreadcrumbs({ activeId, go }) {
  const trail = pathTo(activeId) || [];
  return (
    <div className="mb-3 flex flex-wrap items-center gap-1.5 text-[11.5px] text-muted">
      <button type="button" onClick={() => go('home')} className="font-mono hover:text-accent-text hover:underline">ActMon Documentation</button>
      {trail.slice(1).map((n, i) => {
        const last = i === trail.length - 2;
        return (
          <span key={n.id} className="flex items-center gap-1.5">
            <span className="text-subtle">›</span>
            {last ? (
              <span className="font-mono text-fg">{n.title}</span>
            ) : (
              <button type="button" onClick={() => go(n.id)} className="font-mono hover:text-accent-text hover:underline">{n.title}</button>
            )}
          </span>
        );
      })}
    </div>
  );
}

function HelpMeta({ doc }) {
  const fields = [
    ['Module', doc.module || '—'],
    ['Doc version', '1.0'],
    ['Status', doc.status || 'Planned'],
    ['Applicable ActMon version', 'Not identified in the current implementation'],
  ];
  return (
    <div className="mb-2 flex flex-wrap gap-x-5 gap-y-2 rounded-md border border-border bg-sunken px-3.5 py-3 text-[11px] text-muted">
      {fields.map(([label, value]) => (
        <div key={label} className="flex flex-col gap-0.5">
          <span className="text-[9.5px] tracking-wide uppercase">{label}</span>
          <b className="font-semibold text-fg">{value}</b>
        </div>
      ))}
    </div>
  );
}

const SECTION_HUES = ['#2F6FED', '#059669', '#F59E0B', '#7C5CFC', '#0EA5E9', '#E11D48', '#0C7C8C', '#DB2777'];

/** Splits raw article HTML on top-level <h2>...</h2> boundaries into
 * {heading, html} chunks. Every real chapter file in content/ authors
 * sections as literal `<h2>Heading</h2><p>...</p>...` markup (verified
 * across the codebase), so a plain regex split is reliable here — no HTML
 * parser needed. Rare intro content before the first heading gets
 * heading:null and renders plainly, above the section cards. */
function splitSections(html) {
  const re = /<h2>([\s\S]*?)<\/h2>/g;
  const sections = [];
  let lastIndex = 0;
  let heading = null;
  let match = re.exec(html);
  while (match) {
    const chunk = html.slice(lastIndex, match.index);
    if (heading !== null || chunk.trim()) sections.push({ heading, html: chunk });
    heading = match[1];
    lastIndex = re.lastIndex;
    match = re.exec(html);
  }
  sections.push({ heading, html: html.slice(lastIndex) });
  return sections;
}

/** Renders an article as a stack of colorful section cards — one per <h2> in
 * the source, cycling a fixed hue palette — instead of plain sequential
 * prose with a thin divider line. Applies uniformly to every article in
 * every module, since it's driven by the existing <h2> structure already in
 * every chapter file, not per-article markup. Each heading keeps a stable
 * slug id so `OnThisPage`'s jump-links still work exactly as before. */
function ArticleBody({ body }) {
  const sections = useMemo(() => splitSections(body), [body]);
  let colorIdx = 0;
  return (
    <div className="help-article flex flex-col gap-4">
      {sections.map((s, i) => {
        if (s.heading === null) {
          return s.html.trim() ? <div key={i} dangerouslySetInnerHTML={{ __html: s.html }} /> : null;
        }
        const hue = SECTION_HUES[colorIdx % SECTION_HUES.length];
        colorIdx += 1;
        const id = `${slugify(s.heading)}-${i}`;
        return (
          <section key={i} className="overflow-hidden rounded-card border border-border" style={{ borderLeft: `4px solid ${hue}` }}>
            <div className="flex items-center gap-2.5 px-5 pt-4 pb-2.5" style={{ background: `color-mix(in srgb, ${hue} 8%, var(--surface))` }}>
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: hue }} />
              <h2
                id={id}
                className="text-[calc(1.2rem*var(--help-font-scale,1))] font-bold text-fg"
                style={{ fontFamily: 'var(--font-mono)', border: 'none', margin: 0, padding: 0 }}
              >
                {s.heading}
              </h2>
            </div>
            <div className="px-5 pt-2.5 pb-4" dangerouslySetInnerHTML={{ __html: s.html }} />
          </section>
        );
      })}
    </div>
  );
}

function slugify(text) {
  return (text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'section';
}

/** "On this page" — the right rail, built from the article's own live <h2>
 * headings. Only renders when there are at least 2, and only for articles
 * (never landing pages) — this is what fills the width a 70ch-capped
 * reading column otherwise leaves empty on a wide viewport, with something
 * actually useful rather than a stray blank column. */
function OnThisPage({ bodyKey }) {
  const [headings, setHeadings] = useState([]);
  const [activeHeading, setActiveHeading] = useState(null);

  useEffect(() => {
    // Reads synchronously (no rAF) — ArticleBody's own effect, which stamps
    // ids onto these same <h2> elements, is a preceding sibling in render
    // order and so already ran by the time this effect fires in the same
    // commit; the headings are in the DOM immediately anyway since they
    // come from dangerouslySetInnerHTML, not a later render pass.
    const els = Array.from(document.querySelectorAll('#help-main .help-article h2'));
    setHeadings(els.map((h) => ({ id: h.id, text: h.textContent })));
    setActiveHeading(els[0]?.id || null);
  }, [bodyKey]);

  useEffect(() => {
    const main = document.getElementById('help-main');
    if (!main || headings.length === 0) return undefined;
    const onScroll = () => {
      const tops = headings.map((h) => document.getElementById(h.id)?.getBoundingClientRect().top ?? Infinity);
      let current = headings[0]?.id;
      tops.forEach((top, i) => { if (top - 90 <= 0) current = headings[i].id; });
      setActiveHeading(current);
    };
    main.addEventListener('scroll', onScroll, { passive: true });
    return () => main.removeEventListener('scroll', onScroll);
  }, [headings]);

  if (headings.length < 2) return null;
  return (
    <aside className="hidden w-52 shrink-0 xl:block">
      <div className="sticky top-0">
        <div className="mb-2 font-mono text-[10.5px] font-bold tracking-wide text-subtle uppercase">On this page</div>
        <ul className="flex flex-col gap-1 border-l border-border pl-3">
          {headings.map((h) => (
            <li key={h.id}>
              <button
                type="button"
                onClick={() => document.getElementById(h.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                className={cn(
                  'truncate-safe block w-full text-left text-[12px] transition-colors hover:text-accent-text',
                  activeHeading === h.id ? 'font-semibold text-accent-text' : 'text-muted',
                )}
              >
                {h.text}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}

/** Same-category siblings (matched via the tree, not string-prefix
 * guessing) minus the current article. */
function RelatedTopics({ activeId, doc, go }) {
  const related = useMemo(() => {
    const trail = pathTo(activeId);
    const parent = deepestLandingAncestor(trail);
    if (!parent) return [];
    return flattenLeaves(parent)
      .filter((id) => id !== activeId)
      .slice(0, 5)
      .map((id) => ({ id, title: DOCS[id]?.title }));
  }, [activeId, doc]);

  if (related.length === 0) return null;
  return (
    <div className="mt-9 border-t border-border pt-5">
      <h2 className="mb-2.5 font-mono text-[11px] font-bold tracking-wide text-subtle uppercase">Related topics</h2>
      <div className="flex flex-wrap gap-2">
        {related.map((r) => (
          <button
            key={r.id}
            type="button"
            onClick={() => go(r.id)}
            className="rounded-full border border-border bg-surface px-3 py-1.5 text-[12px] font-medium text-muted transition-colors hover:border-accent hover:text-accent-text"
          >
            {r.title}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Purely local feedback (no backend endpoint exists for this) — resets per
 * article since it's keyed by docId, and never claims to have "sent"
 * anything beyond the on-screen thank-you. */
function WasThisHelpful({ docId }) {
  const [answer, setAnswer] = useState(null);
  useEffect(() => setAnswer(null), [docId]);
  return (
    <div className="mt-8 flex items-center gap-3 rounded-md border border-border bg-sunken px-4 py-3">
      {answer ? (
        <p className="text-[12.5px] text-muted">
          {answer === 'yes' ? 'Thanks for the feedback.' : 'Thanks — noted for the next revision of this topic.'}
        </p>
      ) : (
        <>
          <span className="text-[12.5px] font-medium text-fg">Was this helpful?</span>
          <button type="button" onClick={() => setAnswer('yes')}
            className="flex items-center gap-1 rounded-control border border-border bg-surface px-2.5 py-1 text-[12px] font-medium text-muted transition-colors hover:border-accent hover:text-accent-text">
            <Icon name="check" size={12} /> Yes
          </button>
          <button type="button" onClick={() => setAnswer('no')}
            className="flex items-center gap-1 rounded-control border border-border bg-surface px-2.5 py-1 text-[12px] font-medium text-muted transition-colors hover:border-danger hover:text-danger-fg">
            <Icon name="close" size={12} /> No
          </button>
        </>
      )}
    </div>
  );
}

/** Context-sensitive sidebar: shows the top-level tree on Home, and — once
 * inside a section — ONLY the deepest landing ancestor's own children
 * (e.g. inside PostgreSQL, shows PostgreSQL's categories; inside a
 * category, shows that category's articles), never the whole expanded
 * tree at once. "Help Center Home" is always present as the way back out. */
function HelpSidebar({ activeId, isHome, context, go }) {
  return (
    <nav className="h-full w-full overflow-y-auto border-r border-border bg-surface px-3 py-4">
      <button
        type="button"
        onClick={() => go('home')}
        className={cn(
          'mb-2 flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[15px] font-semibold transition-colors hover:bg-sunken',
          isHome ? 'bg-accent-soft text-accent-text' : 'text-fg',
        )}
      >
        <Icon name="dashboard" size={14} />
        Help Center Home
      </button>

      {isHome ? (
        <TopLevelList activeId={activeId} go={go} />
      ) : context ? (
        <div>
          <div className="px-2.5 pt-2 pb-1.5 font-mono text-[11px] tracking-wide text-subtle uppercase">{context.title}</div>
          {context.dek && <p className="mb-2 px-2.5 text-[13px] leading-snug text-subtle">{context.dek}</p>}
          <div className="flex flex-col gap-0.5">
            {(context.children || []).map((child) => (
              <SidebarRow key={child.id} node={child} activeId={activeId} go={go} />
            ))}
          </div>
        </div>
      ) : null}
    </nav>
  );
}

/** The collapsed Help Center rail — a narrow icon strip so navigation isn't
 * fully hidden, just reduced to "home" + a hint to expand for the full
 * tree. Matches the same collapsed-rail pattern the AI sidebar uses (see
 * AiAssistantPage.jsx's CollapsedRail) — one shared visual language for
 * "this panel is collapsed," not two different ones. */
function CollapsedHelpRail({ go }) {
  return (
    <div className="flex h-full flex-col items-center gap-1.5 border-r border-border bg-surface py-2.5">
      <IconButton icon="dashboard" label="Help Center Home" size="sm" onClick={() => go('home')} />
    </div>
  );
}

function SidebarRow({ node, activeId, go }) {
  if (node.comingSoon) {
    return (
      <div className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[14px] text-subtle">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-border" />
        {node.title}
        <span className="ml-auto rounded-full border border-border px-1.5 py-px text-[9px] tracking-wide uppercase">soon</span>
      </div>
    );
  }
  const targetId = node.doc || node.id;
  const active = activeId === targetId;
  return (
    <button
      type="button"
      onClick={() => go(targetId)}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[14px] font-medium transition-colors hover:bg-sunken',
        active ? 'bg-accent-soft font-semibold text-accent-text' : 'text-muted',
      )}
    >
      <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', active ? 'bg-accent' : 'bg-subtle')} />
      {node.title}
    </button>
  );
}

/** The Home-page-only view: every top-level section as a single, collapsed
 * row (Getting Started's 5 topics stay flat since that section is already
 * small) — this is deliberately NOT the fully-expanded tree the old
 * sidebar rendered; clicking a module row navigates to that module's OWN
 * landing page, where its own children then become the sidebar context. */
function TopLevelList({ activeId, go }) {
  const gsNode = TREE.children.find((n) => n.id === 'mod-getting-started');
  const rest = TREE.children.filter((n) => n.id !== 'mod-getting-started');
  return (
    <div className="flex flex-col gap-0.5">
      <div className="px-2.5 pt-1 pb-1.5 font-mono text-[10.5px] tracking-wide text-subtle uppercase">Getting Started</div>
      {(gsNode?.children || []).map((child) => (
        <SidebarRow key={child.id} node={child} activeId={activeId} go={go} />
      ))}
      <div className="px-2.5 pt-3.5 pb-1.5 font-mono text-[10.5px] tracking-wide text-subtle uppercase">Sections</div>
      {rest.map((n) => (
        <SidebarRow key={n.id} node={n} activeId={activeId} go={go} />
      ))}
    </div>
  );
}
