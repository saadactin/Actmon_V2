import { useEffect, useMemo, useState } from 'react';
import cn from '@/lib/cn';
import Badge from '@/components/ui/Badge';
import Icon from '@/components/ui/Icon';
import IconButton from '@/components/ui/IconButton';
import Input from '@/components/ui/Input';
import Pagination, { pageCountOf, paginate } from '@/components/ui/Pagination';
import Select from '@/components/ui/Select';
import Table, { EmptyState, nextSort, sortRows } from '@/components/ui/Table';
import { maxOf, toRows } from '@/config/dbCatalog';
import { useThemeStore } from '@/theme/themeStore';

/**
 * The app's list panel for database objects — schemas, tables, anything with a
 * column set in `config/dbCatalog`.
 *
 * It owns the parts every such list needs and nothing else: a titled panel, a
 * one-line control strip (search, an optional scope filter, extra actions), a
 * card/table view switch, and the shared sortable <Table>. Columns come from the
 * catalogue, so the MySQL Databases tab and any other engine's list are the same
 * component with different arguments.
 *
 * Long lists are paged rather than dumped: 134 tables in one scroll is not a
 * list anyone reads. The default page size is the `rowsPerPage` appearance
 * setting, so it is one choice for the whole app; `pageSize` overrides it for a
 * list that needs to differ.
 *
 *   items      raw objects from the API
 *   columns    a column set from config/dbCatalog
 *   searchOn   fields the search box matches against
 *   sizeOf     how to read a row's size, so all bars share one scale
 *   unit       what the rows are, for the "1–25 of 134 tables" line
 */
export default function ObjectTable({
  title,
  icon = 'database',
  columns,
  items = [],
  loading = false,
  searchOn = ['name'],
  searchPlaceholder = 'Search…',
  filter,                 // { value, onChange, options, width }
  actions,
  defaultSort,
  /** Pass `sort` + `onSort` to drive sorting from outside (sort-preset buttons);
      omit both and the panel keeps its own sort state. */
  sort: sortProp,
  onSort: onSortProp,
  sizeOf = (d) => d.size_bytes ?? d.total_bytes ?? 0,
  keyOf,
  onOpen,
  onRowClick,
  emptyTitle = 'Nothing to show',
  emptyBody,
  views = ['table', 'cards'],
  note,
  /** A second header row, for controls that would crowd the one-line strip
      (sort presets, for instance). */
  toolbar,
  /** Rows per page. Omit to follow the app-wide `rowsPerPage` setting. */
  pageSize: pageSizeProp,
  unit = 'rows',
}) {
  const [search, setSearch] = useState('');
  const [ownSort, setOwnSort] = useState(defaultSort || null);
  const [view, setView] = useState(views[0]);
  const [page, setPage] = useState(1);

  /* The app-wide default, overridable per list and then per session by the pager's
     own control — so a user can page 100 tables at a time here without changing
     every other list. */
  const appPageSize = useThemeStore((st) => st.rowsPerPage);
  const [ownPageSize, setOwnPageSize] = useState(null);
  const pageSize = ownPageSize ?? pageSizeProp ?? appPageSize;

  const controlled = sortProp !== undefined;
  const sort = controlled ? sortProp : ownSort;
  const setSort = controlled
    ? (key) => onSortProp?.(nextSort(sort, key))
    : (key) => setOwnSort((cur) => nextSort(cur, key));

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter((it) => searchOn.some((f) => String(it[f] ?? '').toLowerCase().includes(q)));
  }, [items, search, searchOn]);

  const ctx = useMemo(
    () => ({ maxSize: maxOf(items, sizeOf), onOpen, onRowClick, keyOf }),
    [items, sizeOf, onOpen, onRowClick, keyOf],
  );

  /* Sort once, carrying each row's source item with it, so the table and the card
     view show the same rows in the same order on the same page. */
  const ordered = useMemo(() => {
    const built = toRows(filtered, columns, ctx);
    const itemByKey = new Map(built.map((row, i) => [row.key, filtered[i]]));
    return sortRows(built, sort).map((row) => ({ row, item: itemByKey.get(row.key) }));
  }, [filtered, columns, ctx, sort]);

  const pageCount = pageCountOf(ordered.length, pageSize);
  /* Searching, filtering or resizing the page changes which rows exist, so the
     page the user was on may no longer be there. Clamp rather than reset to 1, so
     a list that merely shrinks a little keeps their position. */
  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);
  const safePage = Math.min(page, pageCount);
  const paged = paginate(ordered, safePage, pageSize);
  const pageRows = paged.map((p) => p.row);
  const pageItems = paged.map((p) => p.item);

  const empty = (
    <EmptyState
      icon={icon}
      title={search ? 'No matches' : emptyTitle}
      body={search ? `Nothing matches “${search}”.` : emptyBody}
    />
  );

  return (
    <section className="card overflow-hidden">
      {/* header: identity on the left, every control on ONE line to the right */}
      <div
        className={cn(
          'flex flex-wrap items-center gap-gutter-sm px-card py-2.5',
          !toolbar && 'border-b border-border',
        )}
      >
        <h3 className="flex items-center gap-2 text-[13px] font-bold text-fg">
          <Icon name={icon} size={14} className="text-subtle" />
          {title}
        </h3>
        <Badge tone="accent" size="xs">
          {filtered.length === items.length ? items.length : `${filtered.length} / ${items.length}`}
        </Badge>
        {note && (
          <span className="hidden items-center gap-1 text-[11px] text-subtle sm:inline-flex">
            <Icon name="info" size={11} />
            {note}
          </span>
        )}

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {filter && (
            <Select
              value={filter.value}
              onChange={filter.onChange}
              options={filter.options}
              width="auto"
              size="sm"
            />
          )}
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onClear={() => setSearch('')}
            placeholder={searchPlaceholder}
            icon="search"
            size="sm"
            wrapperClassName="w-40"
          />
          {actions}
          {views.length > 1 && (
            <span className="flex items-center gap-0.5 rounded-control border border-border p-0.5">
              {views.map((v) => (
                <IconButton
                  key={v}
                  icon={v === 'cards' ? 'boxes' : 'rows'}
                  label={`${v} view`}
                  size="sm"
                  active={view === v}
                  onClick={() => setView(v)}
                />
              ))}
            </span>
          )}
        </div>
      </div>

      {toolbar && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-card pb-2.5">
          {toolbar}
        </div>
      )}

      {view === 'cards' ? (
        <CardGrid items={pageItems} columns={columns} ctx={ctx} loading={loading} empty={empty} />
      ) : (
        <Table
          columns={columns}
          rows={pageRows}
          sort={sort}
          onSort={setSort}
          loading={loading}
          empty={empty}
        />
      )}

      {/* The pager renders whenever there are rows, so the count line ("1–25 of
          134 tables") and the page-size control are always available — not only
          once a list happens to spill past one page. */}
      {ordered.length > 0 && (
        <Pagination
          page={safePage}
          pageCount={pageCount}
          total={ordered.length}
          pageSize={pageSize}
          onPage={setPage}
          onPageSize={setOwnPageSize}
          unit={unit}
        />
      )}
    </section>
  );
}

/**
 * The same columns as cards. Rendering from one column set means the card view
 * can never show a different set of facts than the table — the first column is
 * the card's heading, a trailing `actions` column its footer, the rest become
 * label/value pairs.
 */
function CardGrid({ items, columns, ctx, loading, empty }) {
  if (!items.length) {
    return <div className={cn('px-card py-10 transition-opacity', loading && 'opacity-55')}>{empty}</div>;
  }

  const [head, ...rest] = columns;
  const actions = rest.at(-1)?.key === 'actions' ? rest.pop() : null;

  return (
    <div
      className={cn(
        'grid gap-gutter-sm p-card transition-opacity sm:grid-cols-2 xl:grid-cols-3',
        loading && 'opacity-55',
      )}
    >
      {items.map((item, i) => (
        <article
          key={String(ctx.keyOf ? ctx.keyOf(item, i) : (item.name ?? i))}
          onClick={ctx.onRowClick ? () => ctx.onRowClick(item) : undefined}
          className={cn(
            'group rounded-card border border-border bg-surface p-3 transition-colors',
            ctx.onRowClick && 'cursor-pointer hover:border-strong hover:bg-sunken',
          )}
        >
          <div className="mb-2 text-[13px]">{head.render(item, ctx)}</div>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5">
            {rest.map((c) => (
              <div key={c.key} className="min-w-0">
                <dt className="text-[10px] font-bold tracking-wide text-subtle uppercase">{c.label}</dt>
                <dd className="text-[12px] text-fg">
                  {c.render(item, ctx) ?? <span className="text-subtle">—</span>}
                </dd>
              </div>
            ))}
          </dl>
          {actions && <div className="mt-2.5 flex justify-end">{actions.render(item, ctx)}</div>}
        </article>
      ))}
    </div>
  );
}
