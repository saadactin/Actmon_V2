import { useEffect, useMemo, useState } from 'react';
import { pageCountOf, paginate } from '@/components/ui/Pagination';
import { useThemeStore } from '@/theme/themeStore';

/**
 * Page any list, in three lines.
 *
 * `ObjectTable` already pages the lists built on it, but the engine dashboards
 * carry many hand-written tables (locks, replication senders, process lists,
 * per-table statistics) that have no column catalogue and would be expensive to
 * rewrite. This gives those the same stepper, the same app-wide `rowsPerPage`
 * default and the same per-list override, without touching their markup:
 *
 *   const paged = usePaged(rows);
 *   …
 *   {paged.rows.map(…)}
 *   …
 *   <Pagination {...paged.props} unit="locks" />
 *
 * Paging state resets to a valid page when the list changes underneath it, so
 * filtering to fewer rows can never leave the view stranded on an empty page.
 */
export default function usePaged(items = [], { pageSize: pageSizeProp } = {}) {
  const [page, setPage] = useState(1);
  const [ownPageSize, setOwnPageSize] = useState(null);

  const appPageSize = useThemeStore((s) => s.rowsPerPage);
  const pageSize = ownPageSize ?? pageSizeProp ?? appPageSize;

  const total = items.length;
  const pageCount = pageCountOf(total, pageSize);

  // Clamp rather than reset: a list that merely shrinks keeps the reader's place.
  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);
  const safePage = Math.min(page, pageCount);

  const rows = useMemo(() => paginate(items, safePage, pageSize), [items, safePage, pageSize]);

  return {
    rows,
    page: safePage,
    pageCount,
    pageSize,
    total,
    setPage,
    setPageSize: setOwnPageSize,
    /** Spread straight onto <Pagination>; add `unit` to name the rows. */
    props: {
      page: safePage,
      pageCount,
      total,
      pageSize,
      onPage: setPage,
      onPageSize: setOwnPageSize,
    },
  };
}
