import Icon from '@/components/ui/Icon';
import { useHelpSearchIndex, searchDocs } from './useHelpSearch';

/**
 * Dedicated search results view — reached by pressing Enter in either search
 * box, or clicking "See all N results" under a dropdown. Shows every match
 * (not capped to a handful), each with title, category/module, and a short
 * description, per requirement: title/category/short-description/module.
 */
export default function SearchResultsPage({ query, go }) {
  const index = useHelpSearchIndex();
  const results = searchDocs(index, query);

  return (
    <div>
      <h1 className="mb-1.5 text-[1.75rem] leading-[1.2] font-semibold tracking-[-0.01em] text-fg">
        Search results
      </h1>
      <p className="mb-6 text-[15px] text-muted">
        {results.length === 0
          ? <>No documentation matches <b className="text-fg">&ldquo;{query}&rdquo;</b>.</>
          : <>{results.length} result{results.length !== 1 ? 's' : ''} for <b className="text-fg">&ldquo;{query}&rdquo;</b></>}
      </p>

      {results.length === 0 ? (
        <div className="card flex flex-col items-center gap-3 px-6 py-14 text-center">
          <Icon name="search" size={28} className="text-subtle" />
          <p className="max-w-[42ch] text-[13.5px] text-muted">
            Try a different word, or browse the module list from the Help Center home page.
          </p>
          <button
            type="button"
            onClick={() => go('home')}
            className="mt-1 rounded-control bg-accent px-4 py-2 text-[13px] font-semibold text-on-accent transition-colors hover:bg-accent-hover"
          >
            Back to Help Center home
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {results.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => go(r.id)}
              className="card flex flex-col gap-1 px-4 py-3 text-left transition-colors hover:border-accent hover:bg-accent-soft"
            >
              <div className="flex items-center gap-2">
                <span className="rounded-full border border-border px-2 py-0.5 font-mono text-[9.5px] tracking-wide text-subtle uppercase">
                  {r.module}
                </span>
                <span className="truncate-safe text-[14.5px] font-semibold text-fg">{r.title}</span>
              </div>
              {r.dek && <p className="truncate-safe max-w-[70ch] text-[12.5px] text-muted">{r.dek}</p>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
