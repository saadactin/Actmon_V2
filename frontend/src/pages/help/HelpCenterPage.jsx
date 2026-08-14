import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import cn from '@/lib/cn';
import PageHeader from '@/components/layout/PageHeader';
import Icon from '@/components/ui/Icon';
import { DOCS, MODULES, GS_TOPICS, FLOW } from './helpContent';
import './helpArticle.css';

const textOf = (html) => {
  const d = document.createElement('div');
  d.innerHTML = html || '';
  return d.textContent.replace(/\s+/g, ' ').trim();
};

/**
 * Help Center — the ActMon documentation library, ported to real React.
 *
 * Content (helpContent.js) is unchanged from the original documentation
 * build; only the rendering shell is new — a two-pane nav + article layout
 * matching how every other module gets a PageHeader, instead of an embedded
 * standalone HTML page. Body HTML per topic is still static, trusted content
 * we authored, rendered via dangerouslySetInnerHTML.
 *
 * Internal links inside that HTML use `onclick="go('topic-id')"` (inherited
 * from the original build) — `window.go` is wired below so those keep
 * working without rewriting every one of the ~40 documentation pages.
 */
export default function HelpCenterPage() {
  const [params, setParams] = useSearchParams();
  const activeId = params.get('doc') || 'home';
  const doc = DOCS[activeId] || DOCS.home;

  // Nothing pre-expanded — a group only opens once the user is actually
  // reading a topic inside it (see the effect below) or clicks it themselves.
  const [openGroups, setOpenGroups] = useState(() => new Set());
  const [query, setQuery] = useState('');

  const go = (id) => {
    if (!DOCS[id]) return;
    setParams((p) => { const n = new URLSearchParams(p); n.set('doc', id); return n; }, { replace: false });
    document.getElementById('help-main')?.scrollTo(0, 0);
    setQuery('');
  };

  // The article body still carries onclick="go('...')" from the original
  // build — bind it globally so those inline handlers resolve.
  useEffect(() => {
    window.go = go;
    return () => { delete window.go; };
  });

  useEffect(() => {
    if (activeId.startsWith('db-')) setOpenGroups((s) => new Set(s).add('mod-dashboard'));
    if (activeId.startsWith('agt-')) setOpenGroups((s) => new Set(s).add('mod-agents'));
    if (activeId.startsWith('dbm-')) setOpenGroups((s) => new Set(s).add('mod-databases'));
  }, [activeId]);

  const searchIndex = useMemo(() => Object.keys(DOCS).map((id) => {
    const d = DOCS[id];
    const group = d.crumbs && d.crumbs.length > 1 ? d.crumbs[1] : 'Documentation';
    return { id, title: d.title, group, text: `${d.title} ${d.dek || ''} ${textOf(d.body)}`.toLowerCase() };
  }), []);
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return searchIndex.filter((r) => r.text.includes(q)).slice(0, 12);
  }, [query, searchIndex]);

  const flowIdx = FLOW.indexOf(activeId);
  const prevDoc = flowIdx > 0 ? DOCS[FLOW[flowIdx - 1]] : null;
  const nextDoc = flowIdx >= 0 && flowIdx < FLOW.length - 1 ? DOCS[FLOW[flowIdx + 1]] : null;

  // The header's height is dynamic (the description can wrap to two lines,
  // density/appearance settings change it too), so it's measured rather than
  // guessed — the nav+content pane below is then sized to exactly the space
  // left under it, with nothing to spare, so <main> itself never needs to
  // scroll: only the sidebar and the article scroll, independently.
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
          description="ActMon product documentation, guides, and reference — Dashboard, Agents, and Database chapters are complete; every other module is on the roadmap below."
          actions={(
            <div className="relative w-64">
              <Icon name="search" size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-subtle" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search documentation…"
                className="h-9 w-full rounded-control border border-border bg-sunken pl-8 pr-3 text-[12.5px] text-fg placeholder:text-subtle focus:border-accent-border focus:outline-none"
              />
              {results.length > 0 && (
                <div className="absolute top-[calc(100%+6px)] right-0 left-0 z-20 max-h-[60vh] overflow-y-auto rounded-md border border-border bg-surface p-1.5 shadow-lg">
                  {results.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => go(r.id)}
                      className="block w-full rounded-md px-2.5 py-2 text-left transition-colors hover:bg-sunken"
                    >
                      <div className="truncate-safe text-[10.5px] font-semibold tracking-wide text-subtle uppercase">{r.group}</div>
                      <div className="truncate-safe text-[13px] font-semibold text-fg">{r.title}</div>
                    </button>
                  ))}
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
          <HelpBreadcrumbs doc={doc} go={go} />
          <h1 className="mb-1.5 text-[1.75rem] leading-[1.2] font-semibold tracking-[-0.01em] text-fg">{doc.title}</h1>
          {doc.dek && <p className="mb-5 max-w-[70ch] text-[15px] text-muted">{doc.dek}</p>}
          {!doc.noMeta && <HelpMeta doc={doc} />}

          <article className="help-article" dangerouslySetInnerHTML={{ __html: doc.body }} />

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
    ['Last updated', '2026-08-11'],
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

function HelpSidebar({ activeId, openGroups, setOpenGroups, go }) {
  const toggle = (id) => setOpenGroups((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  return (
    <nav className="w-64 shrink-0 overflow-y-auto border-r border-border bg-surface px-3 py-4">
      <div className="px-2.5 pt-1 pb-1.5 font-mono text-[10.5px] tracking-wide text-subtle uppercase">Getting Started</div>
      {GS_TOPICS.map(([id, label]) => (
        <NavLink key={id} id={id} label={label} active={activeId === id} onClick={() => go(id)} />
      ))}

      <div className="px-2.5 pt-3.5 pb-1.5 font-mono text-[10.5px] tracking-wide text-subtle uppercase">Product Modules</div>
      {MODULES.map((m) => (
        m.topics ? (
          <div key={m.id} className="mb-0.5">
            <button
              type="button"
              onClick={() => toggle(m.id)}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[12.5px] font-medium text-fg transition-colors hover:bg-sunken"
            >
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
              <span className="flex-1 text-fg">{m.label}</span>
              <Icon name="chevron-right" size={11} className={cn('shrink-0 text-subtle transition-transform', openGroups.has(m.id) && 'rotate-90')} />
            </button>
            {openGroups.has(m.id) && (
              <div className="mt-0.5 ml-5 flex flex-col gap-0.5 border-l border-border pl-3.5">
                {m.topics.map(([id, label]) => (
                  <NavLink key={id} id={id} label={label} active={activeId === id} onClick={() => go(id)} small />
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
            <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', activeId === m.id ? 'bg-accent' : 'bg-subtle')} />
            <span className="flex-1">{m.label}</span>
            <span className="rounded-full border border-border px-1.5 py-px text-[9px] tracking-wide text-subtle">soon</span>
          </button>
        )
      ))}
    </nav>
  );
}

function NavLink({ id, label, active, onClick, small }) {
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
