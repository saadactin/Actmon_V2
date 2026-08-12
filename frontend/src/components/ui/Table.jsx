import cn from '@/lib/cn';
import Icon from './Icon';

/** Agents-list header cell — Figma: 18px/600/20px-lh white, always centered
    regardless of the column's own body alignment. Pulled out so the header
    <th> and its sort <button> share one definition instead of two ad hoc
    class strings. */
const DARK_HEADER_TEXT = 'text-[1.125rem] leading-[1.25rem] font-semibold text-center text-white';

/**
 * The app's data table.
 *
 *   columns  [{ key, label, align, width, sortable, sortKey }]
 *   rows     [{ key, cells: { [columnKey]: ReactNode }, sort: { [key]: primitive },
 *              onClick, tone, disabled }]
 *
 * `cells` is what's displayed; `sort` (optional) supplies the raw comparable value
 * for a column, so a cell can render "78%" or a badge while still sorting
 * numerically. Sorting and selection are controlled by the caller — the table
 * renders state, it doesn't own it.
 */
export default function Table({
  columns,
  rows,
  sort,
  onSort,
  selectable = false,
  selectedKeys = [],
  onSelectionChange,
  isSelectable = () => true,
  empty,
  loading = false,
  rowHeight,
  className,
  /** Opt-in dark header band (Agents list is specced to match a reference
      design with one) — every other table keeps the default light header. */
  darkHeader = false,
}) {
  const selectableRows = rows.filter(isSelectable);
  const allSelected = selectableRows.length > 0
    && selectableRows.every((r) => selectedKeys.includes(r.key));
  const someSelected = selectedKeys.length > 0 && !allSelected;

  const toggleAll = () => {
    onSelectionChange?.(allSelected ? [] : selectableRows.map((r) => r.key));
  };
  const toggleRow = (key) => {
    onSelectionChange?.(
      selectedKeys.includes(key)
        ? selectedKeys.filter((k) => k !== key)
        : [...selectedKeys, key],
    );
  };

  // No rows always explains itself. Gating this on `!loading` left a refetch
  // showing a headers-only table with a bare <tbody> and no message; dimming the
  // empty state is the same "hold the frame" treatment the rows get.
  if (!rows.length) {
    return (
      <div className={cn('px-card py-10 transition-opacity', loading && 'opacity-55')}>
        {empty}
      </div>
    );
  }

  return (
    <div
      className={cn(
        'overflow-x-auto',
        darkHeader && 'rounded-2xl bg-sunken p-3',
        loading && 'opacity-55 transition-opacity',
        className,
      )}
    >
      <table
        className={cn(
          'w-full text-[0.8125rem]',
          darkHeader ? 'border-separate border-spacing-x-0 border-spacing-y-2' : 'border-collapse',
        )}
      >
        <thead className={darkHeader ? 'bg-[var(--agent-slate-900)]' : undefined}>
          <tr className={cn(darkHeader ? 'h-[4.5rem] border-b-2 border-transparent' : 'border-b border-border')}>
            {selectable && (
              <th scope="col" className="w-9 py-2 pr-1 pl-card">
                <Checkbox checked={allSelected} indeterminate={someSelected} onChange={toggleAll} label="Select all" />
              </th>
            )}
            {columns.map((c, i) => {
              const key = c.sortKey || c.key;
              const isSorted = sort?.key === key;
              return (
                <th
                  key={c.key}
                  scope="col"
                  style={c.width ? { width: c.width } : undefined}
                  className={cn(
                    'whitespace-nowrap font-sans',
                    /* The dark-header variant (Agents list) is specced against
                       Figma exactly: 72px row height, 8px/16px padding, 8px
                       top-corner radius, 18px/600/normal-case labels, every
                       label centered regardless of its column's own body
                       alignment — scoped to darkHeader so every other table
                       keeps its existing small-uppercase look untouched. */
                    darkHeader
                      ? cn('py-2', DARK_HEADER_TEXT)
                      : cn('py-3 text-[0.625rem] font-bold tracking-wide uppercase text-subtle',
                        c.align === 'center' ? 'text-center' : c.align === 'right' ? 'text-right' : 'text-left'),
                    i === 0 && !selectable ? 'pl-card' : (darkHeader ? 'px-4' : 'px-2'),
                    i === columns.length - 1 && 'pr-card',
                    darkHeader && i === 0 && !selectable && 'rounded-tl-[0.5rem]',
                    darkHeader && i === columns.length - 1 && 'rounded-tr-[0.5rem]',
                  )}
                >
                  {c.sortable ? (
                    <button
                      type="button"
                      onClick={() => onSort?.(key)}
                      className={cn(
                        'inline-flex cursor-pointer items-center justify-center gap-1 font-sans transition-colors duration-200',
                        darkHeader ? 'hover:text-white/80' : 'hover:text-fg',
                        !darkHeader && c.align === 'right' && 'flex-row-reverse',
                        isSorted && !darkHeader && 'text-fg',
                      )}
                    >
                      {c.label}
                      <Icon
                        name="chevron-down"
                        size={11}
                        strokeWidth={1.9}
                        className={cn(
                          'transition-[transform,opacity]',
                          isSorted ? 'opacity-100' : 'opacity-30',
                          isSorted && sort.dir === 'asc' && 'rotate-180',
                        )}
                      />
                    </button>
                  ) : c.label}
                  {/* A column whose values are estimated or derived says so here,
                      in a native title — always in the DOM, so it reaches touch
                      and assistive tech, not only a hovering mouse. */}
                  {c.hint && (
                    <abbr title={c.hint} className="ml-1 cursor-help align-middle no-underline">
                      <Icon name="info" size={10} className="inline text-subtle" />
                    </abbr>
                  )}
                </th>
              );
            })}
          </tr>
        </thead>

        <tbody>
          {rows.map((row) => {
            const selected = selectedKeys.includes(row.key);
            return (
              <tr
                key={row.key}
                onClick={row.onClick}
                /* A clickable row has to be operable without a mouse. Making it
                   focusable and handling Enter / Space is the least-invasive way:
                   wrapping every first cell in a <button> would break the cell's
                   layout, and a hidden link per row would double the tab stops. */
                tabIndex={row.onClick ? 0 : undefined}
                role={row.onClick ? 'button' : undefined}
                onKeyDown={row.onClick ? (e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    row.onClick(e);
                  }
                } : undefined}
                style={rowHeight ? { height: rowHeight } : undefined}
                className={cn(
                  // `group` lets a cell reveal an affordance on row hover
                  // (the eye beside a name, an external-link arrow).
                  'group transition-colors',
                  /* darkHeader rows are separate floating cards (Figma), so
                     the border/background that separates ordinary rows lives
                     per-CELL below instead of on the row itself. */
                  !darkHeader && 'border-b border-border last:border-0',
                  !darkHeader && (selected ? 'bg-accent-softer' : 'hover:bg-sunken'),
                  row.onClick && 'cursor-pointer focus-visible:bg-sunken',
                )}
              >
                {selectable && (
                  <td className="py-2 pr-1 pl-card" onClick={(e) => e.stopPropagation()}>
                    {isSelectable(row) ? (
                      <Checkbox
                        checked={selected}
                        onChange={() => toggleRow(row.key)}
                        label={`Select ${row.key}`}
                      />
                    ) : (
                      <span className="block h-4 w-4" />
                    )}
                  </td>
                )}
                {columns.map((c, i) => (
                  <td
                    key={c.key}
                    className={cn(
                      'align-middle',
                      'py-2',
                      c.align === 'right' ? 'text-right tabular-nums'
                        : c.align === 'center' ? 'text-center tabular-nums' : 'text-left',
                      i === 0 && !selectable ? 'pl-card' : (darkHeader ? 'px-4' : 'px-2'),
                      i === columns.length - 1 && 'pr-card',
                      /* Each row is its own floating rounded card (Figma:
                         64px row, 8px radius, 0 2px 4px rgba(0,0,0,.08),
                         fixed white — not the theme-adaptive bg-surface, to
                         stay pixel-identical regardless of the viewer's
                         theme like the rest of this page's colours). A <tr>
                         can't be rounded or shadowed itself, so every cell
                         carries the card's chrome; border-spacing above
                         makes the 8px gap between rows. */
                      darkHeader && [
                        'shadow-[0_2px_4px_rgba(0,0,0,0.08)] transition-colors',
                        selected ? 'bg-accent-softer' : 'bg-[var(--agent-row-bg)] group-hover:bg-sunken',
                        i === 0 && !selectable && 'rounded-l-[0.5rem]',
                        i === columns.length - 1 && 'rounded-r-[0.5rem]',
                      ],
                    )}
                  >
                    {row.cells[c.key] ?? <span className="text-subtle">—</span>}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Checkbox styled from tokens — the native one can't be themed reliably. */
export function Checkbox({ checked, indeterminate, onChange, label, disabled }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={indeterminate ? 'mixed' : !!checked}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
      className={cn(
        'grid h-4 w-4 shrink-0 place-items-center rounded-xs border transition-colors',
        'disabled:pointer-events-none disabled:opacity-40',
        checked || indeterminate
          ? 'border-accent bg-accent text-accent-fg'
          : 'border-strong bg-surface hover:border-accent',
      )}
    >
      {indeterminate
        ? <span className="h-0.5 w-2 rounded-full bg-current" />
        : checked && <Icon name="check" size={11} strokeWidth={3.5} />}
    </button>
  );
}

/** Shared empty state for tables and lists. */
export function EmptyState({ icon = 'boxes', title, body, action }) {
  return (
    <div className="grid place-items-center gap-2 text-center">
      <span className="grid h-11 w-11 place-items-center rounded-full bg-sunken text-subtle">
        <Icon name={icon} size={21} />
      </span>
      <p className="text-[0.8125rem] font-semibold text-fg">{title}</p>
      {body && <p className="max-w-sm text-[0.75rem] text-muted">{body}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

/** Sort helper: returns a comparator for the current sort state. */
export function sortRows(rows, sort) {
  if (!sort?.key) return rows;
  const dir = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = a.sort?.[sort.key];
    const bv = b.sort?.[sort.key];
    if (av === bv) return 0;
    if (av === undefined || av === null) return 1; // blanks always last
    if (bv === undefined || bv === null) return -1;
    return (typeof av === 'number' && typeof bv === 'number'
      ? av - bv
      : String(av).localeCompare(String(bv))) * dir;
  });
}

/** Cycle a column through desc → asc on repeat clicks. */
export function nextSort(current, key) {
  if (current?.key !== key) return { key, dir: 'desc' };
  return { key, dir: current.dir === 'desc' ? 'asc' : 'desc' };
}
