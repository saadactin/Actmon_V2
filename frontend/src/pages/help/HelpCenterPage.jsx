import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import cn from '@/lib/cn';
import PageHeader from '@/components/layout/PageHeader';
import Icon from '@/components/ui/Icon';
import { DOCS, MODULES, GS_TOPICS, TROUBLESHOOTING_TOPICS, CERT_TOPICS, FLOW } from './content';
import { useHelpSearchIndex, searchDocs } from './useHelpSearch';
import HomePage from './HomePage';
import SearchResultsPage from './SearchResultsPage';
import './helpArticle.css';

/**
 * Help Center — the ActMon documentation library.
 *
 * `?doc=<id>` selects an article; `?doc=home` (or no param) shows the
 * redesigned home page (HomePage.jsx); `?doc=search:<query>` shows the full
 * search-results page (SearchResultsPage.jsx). Everything else renders the
 * two-pane nav + article layout below.
 *
 * Article body HTML (content/*.js + helpContent.js) is static, trusted
 * content this team authored, rendered via dangerouslySetInnerHTML. Internal
 * cross-links inside that HTML use `onclick="go('topic-id')"` — `window.go`
 * is wired below so those resolve without every article needing its own
 * click handler wiring.
 */
export default function HelpCenterPage() {
  const [params, setParams] = useSearchParams();
  const activeId = params.get('doc') || 'home';
  const isHome = activeId === 'home';
  const isSearch = activeId.startsWith('search:');
  const searchQuery = isSearch ? activeId.slice('search:'.length) : '';
  const doc = !isHome && !isSearch ? (DOCS[activeId] || DOCS.home) : null;

  const [openGroups, setOpenGroups] = useState(() => new Set());

  const go = (id) => {
    if (id !== 'home' && !id.startsWith('search:') && !DOCS[id]) return;
    setParams((p) => { const n = new URLSearchParams(p); n.set('doc', id); return n; }, { replace: false });
    document.getElementById('help-main')?.scrollTo(0, 0);
  };

  // The article body still carries onclick="go('...')" — bind it globally so
  // those inline handlers resolve.
  useEffect(() => {
    window.go = go;
    return () => { delete window.go; };
  });

  useEffect(() => {
    if (activeId.startsWith('db-')) setOpenGroups((s) => new Set(s).add('mod-dashboard'));
    if (activeId.startsWith('agt-')) setOpenGroups((s) => new Set(s).add('mod-agents'));
    if (activeId.startsWith('dbm-') || activeId.startsWith('pg-')) setOpenGroups((s) => new Set(s).add('mod-databases'));
    if (activeId.startsWith('cld-')) setOpenGroups((s) => new Set(s).add('mod-cloud'));
    if (activeId.startsWith('inf-')) setOpenGroups((s) => new Set(s).add('mod-infrastructure'));
    if (activeId.startsWith('alt-')) setOpenGroups((s) => new Set(s).add('mod-alerts'));
    if (activeId.startsWith('ai-')) setOpenGroups((s) => new Set(s).add('mod-ai'));
    if (activeId.startsWith('adm-')) setOpenGroups((s) => new Set(s).add('mod-administration'));
    if (activeId.startsWith('set-')) setOpenGroups((s) => new Set(s).add('mod-settings'));
  }, [activeId]);

  const searchIndex = useHelpSearchIndex();
  const [query, setQuery] = useState('');
  const results = useMemo(() => searchDocs(searchIndex, query, 12), [query, searchIndex]);

  const flowIdx = FLOW.indexOf(activeId);
  const prevDoc = flowIdx > 0 ? DOCS[FLOW[flowIdx - 1]] : null;
  const nextDoc = flowIdx >= 0 && flowIdx < FLOW.length - 1 ? DOCS[FLOW[flowIdx + 1]] : null;

  // The header's height is dynamic (description can wrap, density/appearance
  // settings change it too), so it's measured rather than guessed — the
  // nav+content pane below is sized to exactly the space left under it, so
  // <main> itself never scrolls: only the sidebar and the article do.
  const headerRef = useRef(null);
  const [headerH, setHeaderH] = useState(0);
  useLayoutEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setHeaderH(entry.contentRect.height));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <>
      <div ref={headerRef}>
        <PageHeader
          icon="help"
          title="Help Center"
          description="ActMon product documentation — guides, procedures, reference, and troubleshooting for every implemented module."
          actions={(
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
          )}
        />
      </div>

      <div
        className="card mb-[calc(-1*var(--gap-lg))] flex min-h-0 overflow-hidden"
        style={{ height: `calc(100vh - var(--topnav-h) - ${headerH}px)` }}
      >
        <HelpSidebar activeId={activeId} openGroups={openGroups} setOpenGroups={setOpenGroups} go={go} />

        <main id="help-main" className="min-w-0 flex-1 overflow-y-auto px-6 py-6 md:px-8">
          {isHome ? (
            <HomePage go={go} />
          ) : isSearch ? (
            <SearchResultsPage query={searchQuery} go={go} />
          ) : (
            <>
              <HelpBreadcrumbs doc={doc} go={go} />
              <h1 className="mb-1.5 text-[1.75rem] leading-[1.2] font-semibold tracking-[-0.01em] text-fg">{doc.title}</h1>
              {doc.dek && <p className="mb-5 max-w-[70ch] text-[15px] text-muted">{doc.dek}</p>}
              {!doc.noMeta && <HelpMeta doc={doc} />}

              <article className="help-article" dangerouslySetInnerHTML={{ __html: doc.body }} />

              <RelatedTopics activeId={activeId} doc={doc} go={go} />
              <WasThisHelpful docId={activeId} />

              {(prevDoc || nextDoc) && (
                <div className="mt-11 flex justify-between gap-3.5 border-t border-border pt-5">
                  {prevDoc ? (
                    <button type="button" onClick={() => go(FLOW[flowIdx - 1])}
                      className="flex max-w-[44%] flex-col items-start gap-0.5 rounded-md border border-border bg-surface px-3.5 py-3 text-left transition-colors hover:border-accent hover:bg-accent-soft">
                      <span className="font-mono text-[9.5px] tracking-wide text-subtle uppercase">← Previous</span>
                      <span className="font-mono text-[13.5px] font-semibold text-fg">{prevDoc.title}</span>
                    </button>
                  ) : <span />}
                  {nextDoc ? (
                    <button type="button" onClick={() => go(FLOW[flowIdx + 1])}
                      className="ml-auto flex max-w-[44%] flex-col items-end gap-0.5 rounded-md border border-border bg-surface px-3.5 py-3 text-right transition-colors hover:border-accent hover:bg-accent-soft">
                      <span className="font-mono text-[9.5px] tracking-wide text-subtle uppercase">Next →</span>
                      <span className="font-mono text-[13.5px] font-semibold text-fg">{nextDoc.title}</span>
                    </button>
                  ) : <span />}
                </div>
              )}
            </>
          )}
        </main>
      </div>
    </>
  );
}

function HelpBreadcrumbs({ doc, go }) {
  const parts = doc.crumbs || [doc.title];
  return (
    <div className="mb-3 flex flex-wrap items-center gap-1.5 text-[11.5px] text-muted">
      {parts.map((p, i) => {
        const last = i === parts.length - 1;
        return (
          <span key={i} className="flex items-center gap-1.5">
            {i === 0 ? (
              <button type="button" onClick={() => go('home')} className="font-mono hover:text-accent-text hover:underline">{p}</button>
            ) : (
              <span className={cn('font-mono', last && 'text-fg')}>{p}</span>
            )}
            {!last && <span className="text-subtle">›</span>}
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

/** Same-chapter siblings (matched on crumbs[1], the module name) minus the
 * current article itself — a lightweight, always-available "related topics"
 * signal with no extra authoring required per article. */
function RelatedTopics({ activeId, doc, go }) {
  const related = useMemo(() => {
    const crumb = doc.crumbs && doc.crumbs[1];
    if (!crumb) return [];
    return Object.keys(DOCS)
      .filter((id) => id !== activeId && DOCS[id].crumbs && DOCS[id].crumbs[1] === crumb)
      .slice(0, 5)
      .map((id) => ({ id, title: DOCS[id].title }));
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

function HelpSidebar({ activeId, openGroups, setOpenGroups, go }) {
  const toggle = (id) => setOpenGroups((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  return (
    <nav className="w-64 shrink-0 overflow-y-auto border-r border-border bg-surface px-3 py-4">
      <button
        type="button"
        onClick={() => go('home')}
        className={cn(
          'mb-1 flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[12.5px] font-semibold transition-colors hover:bg-sunken',
          activeId === 'home' ? 'bg-accent-soft text-accent-text' : 'text-fg',
        )}
      >
        <Icon name="dashboard" size={13} />
        Help Center Home
      </button>

      <div className="px-2.5 pt-3 pb-1.5 font-mono text-[10.5px] tracking-wide text-subtle uppercase">Getting Started</div>
      {GS_TOPICS.map(([id, label]) => (
        <NavLink key={id} label={label} active={activeId === id} onClick={() => go(id)} />
      ))}

      <div className="px-2.5 pt-3.5 pb-1.5 font-mono text-[10.5px] tracking-wide text-subtle uppercase">Product Modules</div>
      {MODULES.filter((m) => m.id !== 'mod-profile').map((m) => (
        m.topics ? (
          <div key={m.id} className="mb-0.5">
            <button
              type="button"
              onClick={() => toggle(m.id)}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[12.5px] font-medium text-fg transition-colors hover:bg-sunken"
            >
              <Icon name={m.icon} size={13} className="shrink-0 text-accent-text" />
              <span className="flex-1 text-fg">{m.label}</span>
              <Icon name="chevron-right" size={11} className={cn('shrink-0 text-subtle transition-transform', openGroups.has(m.id) && 'rotate-90')} />
            </button>
            {openGroups.has(m.id) && (
              <div className="mt-0.5 ml-5 flex flex-col gap-0.5 border-l border-border pl-3.5">
                {m.topics.map(([id, label]) => (
                  <NavLink key={id} label={label} active={activeId === id} onClick={() => go(id)} small />
                ))}
              </div>
            )}
          </div>
        ) : (
          <button
            key={m.id}
            type="button"
            onClick={() => go(m.id)}
            className={cn(
              'flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[12.5px] font-medium transition-colors hover:bg-sunken',
              activeId === m.id ? 'bg-accent-soft text-accent-text' : 'text-fg',
            )}
          >
            <Icon name={m.icon} size={13} className="shrink-0 text-subtle" />
            <span className="flex-1">{m.label}</span>
            <span className="rounded-full border border-border px-1.5 py-px text-[9px] tracking-wide text-subtle">soon</span>
          </button>
        )
      ))}

      <div className="px-2.5 pt-3.5 pb-1.5 font-mono text-[10.5px] tracking-wide text-subtle uppercase">Troubleshooting</div>
      {TROUBLESHOOTING_TOPICS.map(([id, label]) => (
        <NavLink key={id} label={label} active={activeId === id} onClick={() => go(id)} />
      ))}

      <div className="mb-0.5">
        <button
          type="button"
          onClick={() => toggle('cert')}
          className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[12.5px] font-medium text-fg transition-colors hover:bg-sunken"
        >
          <Icon name="report" size={13} className="shrink-0 text-accent-text" />
          <span className="flex-1 text-fg">Certification Preparation</span>
          <Icon name="chevron-right" size={11} className={cn('shrink-0 text-subtle transition-transform', openGroups.has('cert') && 'rotate-90')} />
        </button>
        {openGroups.has('cert') && (
          <div className="mt-0.5 ml-5 flex flex-col gap-0.5 border-l border-border pl-3.5">
            {CERT_TOPICS.map(([id, label]) => (
              <NavLink key={id} label={label} active={activeId === id} onClick={() => go(id)} small />
            ))}
          </div>
        )}
      </div>
    </nav>
  );
}

function NavLink({ label, active, onClick, small }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left font-medium transition-colors hover:bg-sunken',
        small ? 'text-[12px]' : 'text-[12.5px]',
        active ? 'bg-accent-soft font-semibold text-accent-text' : 'text-muted',
      )}
    >
      <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', active ? 'bg-accent' : 'bg-subtle')} />
      {label}
    </button>
  );
}
