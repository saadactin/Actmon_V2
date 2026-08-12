import { useState } from 'react';
import cn from '@/lib/cn';
import Icon from './Icon';
import Select from './Select';
import { useThemeStore } from '@/theme/themeStore';

/**
 * The app's pager. One definition, so every long list steps through its rows the
 * same way and the page-size choice means the same thing everywhere.
 *
 *   page       1-based current page
 *   pageCount  total pages
 *   total      rows before paging, for the "showing x–y of z" line
 *
 * Page numbers are windowed rather than listed in full: a 5,000-row list would
 * otherwise render 200 buttons. The first and last page are always reachable, the
 * current page always sits inside the window, and gaps collapse to an ellipsis.
 */
export function pageWindow(page, pageCount, span = 1) {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, i) => i + 1);

  const pages = new Set([1, pageCount]);
  for (let p = page - span; p <= page + span; p += 1) {
    if (p > 1 && p < pageCount) pages.add(p);
  }
  // keep the window a stable width at both ends, so the control doesn't resize
  // as you step through
  if (page <= 3) [2, 3, 4].forEach((p) => p < pageCount && pages.add(p));
  if (page >= pageCount - 2) {
    [pageCount - 3, pageCount - 2, pageCount - 1].forEach((p) => p > 1 && pages.add(p));
  }

  const sorted = [...pages].sort((a, b) => a - b);
  const out = [];
  sorted.forEach((p, i) => {
    if (i > 0 && p - sorted[i - 1] > 1) out.push(`gap-${p}`);
    out.push(p);
  });
  return out;
}

/** Page-size choices. 'all' turns paging off for that list. */
export const PAGE_SIZES = [
  { id: '10', label: '10' },
  { id: '25', label: '25' },
  { id: '50', label: '50' },
  { id: '100', label: '100' },
  { id: 'all', label: 'All' },
];

export default function Pagination({
  page,
  pageCount,
  total,
  pageSize,
  onPage,
  onPageSize,
  className,
  /** What the rows are, for the count line: "of 134 tables". */
  unit = 'rows',
}) {
  const all = pageSize === 'all' || !Number(pageSize);
  const size = all ? total : Number(pageSize);
  const from = total === 0 ? 0 : (page - 1) * size + 1;
  const to = all ? total : Math.min(total, page * size);

  const step = (p) => onPage?.(Math.min(pageCount, Math.max(1, p)));

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-gutter-sm border-t border-border px-card py-2.5',
        className,
      )}
    >
      <p className="text-[12px] text-muted">
        {total === 0 ? `No ${unit}` : (
          <>
            <span className="font-semibold text-fg tabular-nums">{from}–{to}</span>
            {' of '}
            <span className="font-semibold text-fg tabular-nums">{total}</span>
            {` ${unit}`}
          </>
        )}
      </p>

      {onPageSize && (
        <label className="flex items-center gap-1.5 text-[12px] text-muted">
          <span className="hidden sm:inline">Per page</span>
          <Select
            value={String(pageSize)}
            onChange={onPageSize}
            options={PAGE_SIZES}
            width="auto"
            size="sm"
          />
        </label>
      )}

      {pageCount > 1 && (
        <nav className="ml-auto flex items-center gap-1" aria-label="Pagination">
          <Step icon="chevron-left" label="Previous page" disabled={page <= 1} onClick={() => step(page - 1)} />

          {pageWindow(page, pageCount).map((p) => (typeof p === 'number' ? (
            <button
              key={p}
              type="button"
              onClick={() => step(p)}
              aria-current={p === page ? 'page' : undefined}
              className={cn(
                'h-7 min-w-7 rounded-control px-2 text-[12px] font-semibold tabular-nums transition-colors',
                p === page
                  ? 'bg-accent text-accent-fg'
                  : 'border border-border text-muted hover:bg-sunken hover:text-fg',
              )}
            >
              {p}
            </button>
          ) : (
            <span key={p} className="px-1 text-[12px] text-subtle" aria-hidden="true">…</span>
          )))}

          <Step icon="chevron-right" label="Next page" disabled={page >= pageCount} onClick={() => step(page + 1)} />
        </nav>
      )}
    </div>
  );
}

function Step({ icon, label, disabled, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={cn(
        'grid h-7 w-7 place-items-center rounded-control border border-border text-muted transition-colors',
        'hover:bg-sunken hover:text-fg disabled:pointer-events-none disabled:opacity-40',
      )}
    >
      <Icon name={icon} size={14} />
    </button>
  );
}

/**
 * Page a list from inside conditional JSX.
 *
 * `usePaged` is the hook form, but most of the engine dashboards' tables are
 * rendered inside `{activeTab === 'x' && (() => { … })()}` branches, where a hook
 * call would be conditional and React would fault on the next tab switch. A
 * component owns its own state, so it can live anywhere:
 *
 *   <Paged rows={locks} unit="locks">
 *     {(rows, pager) => (<>
 *       <table>…{rows.map(…)}…</table>
 *       {pager}
 *     </>)}
 *   </Paged>
 *
 * The render function receives the current page's rows and the pager node, so the
 * caller decides where the pager sits relative to its table.
 */
export function Paged({ rows = [], unit = 'rows', pageSize: pageSizeProp, children }) {
  const [page, setPage] = usePagedState();
  const [ownPageSize, setOwnPageSize] = useState(null);
  const appPageSize = useThemeStore((s) => s.rowsPerPage);
  const pageSize = ownPageSize ?? pageSizeProp ?? appPageSize;

  const pageCount = pageCountOf(rows.length, pageSize);
  const safePage = Math.min(page, pageCount);
  const pageRows = paginate(rows, safePage, pageSize);

  const pager = rows.length > 0 ? (
    <Pagination
      page={safePage}
      pageCount={pageCount}
      total={rows.length}
      pageSize={pageSize}
      onPage={setPage}
      onPageSize={setOwnPageSize}
      unit={unit}
    />
  ) : null;

  return children(pageRows, pager);
}

/** Page number that never strands the reader past the end of a shrinking list. */
function usePagedState() {
  const [page, setPage] = useState(1);
  return [page, (p) => setPage(Math.max(1, p))];
}

/** Slice a list for the current page. `pageSize: 'all'` returns it untouched. */
export function paginate(rows, page, pageSize) {
  if (pageSize === 'all' || !Number(pageSize)) return rows;
  const size = Number(pageSize);
  return rows.slice((page - 1) * size, page * size);
}

/** How many pages a list needs. Always at least 1, so the pager can render. */
export function pageCountOf(total, pageSize) {
  if (pageSize === 'all' || !Number(pageSize)) return 1;
  return Math.max(1, Math.ceil(total / Number(pageSize)));
}
