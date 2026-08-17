import { useMemo, useState } from 'react';
import Icon from '@/components/ui/Icon';
import { GS_TOPICS, GS_BLURBS, HOME_CATEGORIES, HOME_BANNERS, CERT_TOPICS } from './content';
import { useHelpSearchIndex, searchDocs } from './useHelpSearch';

const SUGGESTIONS = [
  'replication lag', 'restart patroni', 'agent offline', 'slow query', 'database health',
];

const POPULAR_TOPICS = [
  ['dbm-add-server', 'Add a database server'],
  ['agt-registration-deploy', 'Install the ActMon Agent'],
  ['db-health', 'Check database health'],
  ['pg-replication-concepts', 'Understand replication'],
  ['dbm-slow-queries', 'Investigate slow queries'],
  ['dbm-error-logs', 'View error logs'],
  ['alt-rule-wizard', 'Configure alerts'],
  ['ai-diagnosis-page', 'Diagnose database problems'],
  ['pg-patroni-actions', 'Perform recovery actions'],
];

const TROUBLESHOOTING_LINKS = [
  ['agt-troubleshooting', 'Agent Offline'],
  ['tsh-connection-failed', 'Database Connection Failed'],
  ['pg-ha-troubleshooting', 'Replication Lag'],
  ['pg-ha-troubleshooting', 'PostgreSQL Replica Not Streaming'],
  ['pg-ha-troubleshooting', 'Patroni Warning'],
  ['inf-troubleshooting', 'High CPU'],
  ['inf-troubleshooting', 'High Memory'],
  ['inf-troubleshooting', 'Disk Space Issue'],
  ['dbm-slow-queries', 'Slow Query'],
  ['tsh-authentication-failure', 'Authentication Failure'],
];

export default function HomePage({ go }) {
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);
  const index = useHelpSearchIndex();
  const results = useMemo(() => searchDocs(index, query, 8), [index, query]);

  const submitSearch = () => {
    if (query.trim()) go(`search:${query.trim()}`);
  };

  return (
    <div className="pb-4">
      {/* ── Hero ─────────────────────────────────────────────────────── */}
      <section className="card relative mb-gutter-lg overflow-visible bg-gradient-to-br from-accent-soft via-surface to-surface px-8 py-12 text-center sm:px-14">
        <h1 className="mx-auto max-w-[36ch] text-[2rem] leading-[1.15] font-bold tracking-[-0.015em] text-fg sm:text-[2.375rem]">
          ActMon Documentation
        </h1>
        <p className="mx-auto mt-3 max-w-[62ch] text-[15px] leading-relaxed text-muted">
          Find monitoring guides, database administration procedures, troubleshooting steps, recovery workflows,
          and ActMon operational references.
        </p>

        <div className="relative mx-auto mt-7 max-w-[560px]">
          <Icon name="search" size={17} className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-subtle" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setTimeout(() => setFocused(false), 120)}
            onKeyDown={(e) => { if (e.key === 'Enter') submitSearch(); }}
            placeholder="Search the ActMon documentation…"
            className="h-13 w-full rounded-full border border-border bg-surface pl-11 pr-5 text-[14.5px] text-fg shadow-sm placeholder:text-subtle focus:border-accent-border focus:outline-none"
            style={{ height: '3.1rem' }}
          />
          {focused && query.trim() && (
            <div className="absolute top-[calc(100%+8px)] right-0 left-0 z-30 max-h-[60vh] overflow-y-auto rounded-lg border border-border bg-surface p-1.5 text-left shadow-lg">
              {results.length === 0 ? (
                <p className="px-3 py-3 text-[12.5px] text-subtle">No matches yet — try a different word.</p>
              ) : results.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onMouseDown={() => go(r.id)}
                  className="block w-full rounded-md px-3 py-2 text-left transition-colors hover:bg-sunken"
                >
                  <div className="truncate-safe font-mono text-[10px] font-semibold tracking-wide text-subtle uppercase">{r.module}</div>
                  <div className="truncate-safe text-[13.5px] font-semibold text-fg">{r.title}</div>
                </button>
              ))}
              <button
                type="button"
                onMouseDown={submitSearch}
                className="mt-1 block w-full rounded-md px-3 py-2 text-left font-mono text-[11.5px] font-semibold text-accent-text hover:bg-accent-soft"
              >
                See all results for &ldquo;{query.trim()}&rdquo; →
              </button>
            </div>
          )}
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          <span className="text-[11.5px] text-subtle">Try:</span>
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => { setQuery(s); go(`search:${s}`); }}
              className="rounded-full border border-border bg-surface px-3 py-1 text-[11.5px] text-muted transition-colors hover:border-accent hover:text-accent-text"
            >
              {s}
            </button>
          ))}
        </div>
      </section>

      {/* ── Getting Started ──────────────────────────────────────────── */}
      <SectionHeading title="Getting Started" desc="Five short topics before the full module chapters." />
      <div className="mb-gutter-lg grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {GS_TOPICS.map(([id, lbl]) => (
          <button
            key={id}
            type="button"
            onClick={() => go(id)}
            className="card flex flex-col gap-1.5 px-4 py-3.5 text-left transition-colors hover:border-accent hover:bg-accent-soft"
          >
            <span className="font-mono text-[13px] font-semibold text-fg">{lbl}</span>
            <span className="text-[12px] leading-snug text-muted">{GS_BLURBS[id]}</span>
          </button>
        ))}
      </div>

      {/* ── Browse by module ─────────────────────────────────────────── */}
      <SectionHeading title="Browse by module" desc="Every module ActMon's own navigation bar links to — documented where a chapter exists, honestly marked Coming Soon where it doesn't." />
      <div className="mb-gutter-lg grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
        {HOME_CATEGORIES.map((cat) => (
          <div
            key={cat.id}
            className="card flex flex-col gap-2.5 px-4.5 py-4"
            style={{ borderTop: `3px solid ${cat.available ? cat.hue : 'var(--border)'}` }}
          >
            <div className="flex items-center gap-2.5">
              <span
                className="grid h-8 w-8 shrink-0 place-items-center rounded-md"
                style={{ background: cat.available ? `color-mix(in srgb, ${cat.hue} 16%, var(--surface))` : 'var(--surface-sunken)', color: cat.available ? cat.hue : 'var(--fg-subtle)' }}
              >
                <Icon name={cat.icon} size={17} />
              </span>
              <span className="text-[14.5px] font-semibold text-fg">{cat.label}</span>
              {!cat.available && (
                <span className="ml-auto rounded-full border border-border px-2 py-0.5 text-[9.5px] tracking-wide text-subtle uppercase">Soon</span>
              )}
            </div>
            {cat.available ? (
              <>
                <ul className="flex flex-col gap-1">
                  {cat.links.map((l) => (
                    <li key={l.id}>
                      <button type="button" onClick={() => go(l.id)} className="text-left text-[12.5px] text-muted transition-colors hover:text-accent-text hover:underline">
                        {l.label}
                      </button>
                    </li>
                  ))}
                </ul>
                <button type="button" onClick={() => go(cat.seeAll)} className="mt-auto pt-1 text-left font-mono text-[11px] font-bold text-accent-text hover:underline">
                  See all {cat.label} topics →
                </button>
              </>
            ) : (
              <p className="text-[12px] text-subtle italic">Documentation coming in a future phase.</p>
            )}
          </div>
        ))}
      </div>

      {/* ── Popular topics ───────────────────────────────────────────── */}
      <SectionHeading title="Popular topics" />
      <div className="mb-gutter-lg grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {POPULAR_TOPICS.map(([id, lbl]) => (
          <button
            key={lbl}
            type="button"
            onClick={() => go(id)}
            className="card flex items-center gap-2.5 px-3.5 py-2.5 text-left transition-colors hover:border-accent hover:bg-accent-soft"
          >
            <Icon name="report" size={14} className="shrink-0 text-accent-text" />
            <span className="truncate-safe text-[13px] font-medium text-fg">{lbl}</span>
          </button>
        ))}
      </div>

      {/* ── Troubleshooting ──────────────────────────────────────────── */}
      <SectionHeading title="Troubleshooting" desc="Common problems, indexed by symptom." />
      <div className="mb-gutter-lg grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {TROUBLESHOOTING_LINKS.map(([id, lbl]) => (
          <button
            key={lbl}
            type="button"
            onClick={() => go(id)}
            className="card flex items-center gap-2.5 px-3.5 py-2.5 text-left transition-colors hover:border-danger hover:bg-danger-soft"
          >
            <Icon name="wrench" size={14} className="shrink-0 text-danger-fg" />
            <span className="truncate-safe text-[13px] font-medium text-fg">{lbl}</span>
          </button>
        ))}
        <button
          type="button"
          onClick={() => go('tsh-hub')}
          className="card flex items-center justify-center gap-2 px-3.5 py-2.5 text-left font-mono text-[12px] font-bold text-accent-text transition-colors hover:bg-accent-soft"
        >
          View the full Troubleshooting Knowledge Base →
        </button>
      </div>

      {/* ── Learning / Certification ─────────────────────────────────── */}
      <SectionHeading title="Learning & Certification Preparation" desc="This documentation organized into an 11-stage learning path." />
      <div className="card flex flex-col gap-4 px-5 py-5">
        <div className="flex flex-wrap gap-2">
          {CERT_TOPICS.slice(1).map(([id, lbl], i) => (
            <button
              key={id}
              type="button"
              onClick={() => go(id)}
              className="flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1.5 text-[12px] font-medium text-muted transition-colors hover:border-accent hover:text-accent-text"
            >
              <span className="grid h-4 w-4 place-items-center rounded-full bg-accent-soft font-mono text-[9px] font-bold text-accent-text">{i + 1}</span>
              {lbl.replace(/^\d+\.\s*/, '')}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => go('cert-overview')}
          className="self-start rounded-control bg-accent px-4 py-2 text-[13px] font-semibold text-accent-fg transition-colors hover:bg-accent-hover"
        >
          Start Certification Preparation →
        </button>
      </div>

      {/* ── Explore banners ──────────────────────────────────────────── */}
      <SectionHeading title="Explore the documentation" />
      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
        {HOME_BANNERS.map((b) => (
          <button
            key={b.title}
            type="button"
            onClick={() => go(b.go)}
            className="card flex flex-col gap-1.5 px-4 py-3.5 text-left transition-colors"
            style={{ '--hue': b.hue }}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = b.hue; }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = ''; }}
          >
            <span className="font-mono text-[9.5px] font-bold tracking-wide uppercase" style={{ color: b.hue }}>{b.eyebrow}</span>
            <span className="font-mono text-[13.5px] font-semibold text-fg">{b.title}</span>
            <span className="text-[12px] leading-snug text-muted">{b.desc}</span>
            <span className="mt-auto pt-1 font-mono text-[11px] font-bold" style={{ color: b.hue }}>Read more →</span>
          </button>
        ))}
      </div>

      <p className="mt-8 max-w-[70ch] border-t border-border pt-5 text-[12px] leading-relaxed text-subtle">
        This documentation is written directly from the current ActMon implementation — its actual pages, routes,
        and behavior — rather than from a specification. Where a capability is not yet present in the running
        application, this documentation says so explicitly instead of describing it as available.
      </p>
    </div>
  );
}

function SectionHeading({ title, desc }) {
  return (
    <div className="mt-2 mb-3.5">
      <h2 className="font-mono text-[1.05rem] font-semibold text-fg">{title}</h2>
      {desc && <p className="mt-0.5 text-[13px] text-muted">{desc}</p>}
    </div>
  );
}
