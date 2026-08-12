import { useState } from 'react';
import cn from '@/lib/cn';
import Icon from '@/components/ui/Icon';
import IconButton from '@/components/ui/IconButton';
import Popover from '@/components/ui/Popover';
import ChartBody from './ChartBody';
import { kindMeta, kindsFor, resolveKind, useChartKindStore } from './chartKinds';
import { useThemeStore } from '@/theme/themeStore';

/**
 * Container every chart lives in. It owns the two things no individual chart
 * should have to remember:
 *
 *   1. The chart-type picker. Each card offers the forms valid for its data
 *      family and remembers the user's pick (per card, in localStorage), so one
 *      dashboard can mix a donut here and a bar there.
 *   2. The table view. A chart may never be the only way to read a value, so
 *      every card can flip to a plain table of the same numbers.
 *
 * Both live behind one ⋮ button, so a card header carries a single affordance
 * however many forms its data supports.
 *
 * Data in, form chosen by the user:
 *   family        'flat' | 'breakdown' | 'ratio'   (see chartKinds.js)
 *   items / rows  the dataset for that family
 *   defaultKind   the form this card's layout was designed around; the picker
 *                 and the global Appearance preference still override it
 *   tableColumns  [{ key, label, align }]
 *   tableRows     [{ key, cells: { [columnKey]: value } }]
 *   children      optional content rendered ABOVE the chart (hero number, etc.)
 */
export default function ChartCard({
  cardId,
  family,
  items,
  rows,
  chartProps,
  defaultKind,
  title,
  /** Small grey aside on the title line, e.g. "(Top 5)". */
  titleNote,
  icon,
  subtitle,
  action,
  tableColumns,
  tableRows,
  footer,
  loading = false,
  className,
  children,
}) {
  const [asTable, setAsTable] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  const chosen = useChartKindStore((s) => s.chosen);
  const setKind = useChartKindStore((s) => s.setKind);
  const resetKind = useChartKindStore((s) => s.reset);
  const preference = useThemeStore((s) => s.chartStyle);

  const canTable = Boolean(tableColumns?.length && tableRows?.length);
  const options = kindsFor(family);
  const kind = resolveKind({ cardId, family, chosen, preference, defaultKind });
  const current = kindMeta(family, kind);
  const isOverridden = Boolean(chosen[cardId]);
  const hasMenu = options.length > 1 || canTable;

  return (
    <section className={cn('card flex flex-col', className)}>
      {/* No rule under the header: the card's own edge already separates it, and a
          second line inside a 20px-padded card reads as a seam. */}
      <header className="flex items-start gap-2 px-card pt-card pb-3">
        <div className="min-w-0 flex-1">
          <h2 className="flex items-baseline gap-2 text-[17px] leading-tight font-bold text-fg">
            {icon && <Icon name={icon} size={16} className="shrink-0 self-center text-subtle" />}
            {/* truncate-safe: chart titles carry descenders ("Busiest", "engine")
                and the h2's tight line-height would clip them */}
            <span className="truncate-safe">{title}</span>
            {titleNote && (
              <span className="shrink-0 text-[13px] font-normal text-subtle">{titleNote}</span>
            )}
          </h2>
          {subtitle && <p className="truncate-safe mt-0.5 text-[11px] text-subtle">{subtitle}</p>}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {action}

          {hasMenu && (
            <div className="relative">
              <IconButton
                icon="more-vertical"
                label="Card options"
                size="sm"
                active={pickerOpen}
                onClick={() => setPickerOpen((v) => !v)}
              />
              <Popover open={pickerOpen} onClose={() => setPickerOpen(false)} width={232}>
                {options.length > 1 && (
                  <>
                    <div className="border-b border-border px-3 py-2 text-[11px] font-bold tracking-wide text-subtle uppercase">
                      Chart type
                    </div>
                    <div className="p-1.5">
                      {options.map((opt) => (
                        <button
                          key={opt.id}
                          type="button"
                          onClick={() => { setKind(cardId, opt.id); setAsTable(false); setPickerOpen(false); }}
                          className={cn(
                            'flex w-full items-start gap-2.5 rounded-control px-2 py-1.5 text-left transition-colors',
                            !asTable && opt.id === kind ? 'bg-accent-soft' : 'hover:bg-sunken',
                          )}
                        >
                          <Icon
                            name={opt.icon}
                            size={15}
                            className={cn('mt-0.5 shrink-0', !asTable && opt.id === kind ? 'text-accent-text' : 'text-subtle')}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-1.5">
                              <span className="truncate text-[12px] font-semibold text-fg">{opt.label}</span>
                              {/* the recommended form stays labelled, so choosing
                                  another one is an informed trade-off */}
                              {opt.recommended && (
                                <span className="shrink-0 rounded-full bg-success-soft px-1.5 text-[9px] font-bold text-success-fg">
                                  BEST
                                </span>
                              )}
                            </span>
                            {opt.hint && <span className="mt-0.5 block text-[10px] leading-snug text-subtle">{opt.hint}</span>}
                          </span>
                          {!asTable && opt.id === kind && <Icon name="check" size={13} className="mt-0.5 shrink-0 text-accent-text" />}
                        </button>
                      ))}
                    </div>
                  </>
                )}

                {/* The table twin sits in the same menu as the forms, because to a
                    reader it is simply another way to look at this card. */}
                {canTable && (
                  <div className={cn('p-1.5', options.length > 1 && 'border-t border-border')}>
                    <button
                      type="button"
                      onClick={() => { setAsTable((v) => !v); setPickerOpen(false); }}
                      className={cn(
                        'flex w-full items-start gap-2.5 rounded-control px-2 py-1.5 text-left transition-colors',
                        asTable ? 'bg-accent-soft' : 'hover:bg-sunken',
                      )}
                    >
                      <Icon name="table" size={15} className={cn('mt-0.5 shrink-0', asTable ? 'text-accent-text' : 'text-subtle')} />
                      <span className="min-w-0 flex-1">
                        <span className="truncate text-[12px] font-semibold text-fg">Data table</span>
                        <span className="mt-0.5 block text-[10px] leading-snug text-subtle">Read the same numbers as text</span>
                      </span>
                      {asTable && <Icon name="check" size={13} className="mt-0.5 shrink-0 text-accent-text" />}
                    </button>
                  </div>
                )}

                {isOverridden && (
                  <div className="border-t border-border p-1.5">
                    <button
                      type="button"
                      onClick={() => { resetKind(cardId); setPickerOpen(false); }}
                      className="flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-[12px] font-semibold text-muted transition-colors hover:bg-sunken hover:text-fg"
                    >
                      <Icon name="refresh" size={13} />
                      Use the default
                    </button>
                  </div>
                )}
              </Popover>
            </div>
          )}
        </div>
      </header>

      {/* Refetch keeps the frame: dim the previous render, never a skeleton. */}
      <div
        className={cn(
          'flex-1 px-card pt-1 pb-card transition-opacity duration-[var(--dur-normal)]',
          loading && 'opacity-55',
        )}
      >
        {asTable ? (
          <DataTable columns={tableColumns} rows={tableRows} />
        ) : (
          <>
            {children}
            {family && (
              <ChartBody family={family} kind={kind} items={items} rows={rows} chartProps={chartProps} />
            )}
          </>
        )}
      </div>

      {footer && <div className="border-t border-border px-card py-2.5">{footer}</div>}
    </section>
  );
}

/** The table twin. tabular-nums is correct here — these digits align in columns. */
function DataTable({ columns, rows }) {
  return (
    <div className="-mx-1 overflow-x-auto">
      <table className="w-full text-[12px]">
        <thead>
          <tr className="border-b border-border">
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                className={cn(
                  'px-1.5 py-1.5 text-[10px] font-bold tracking-wide text-subtle uppercase',
                  c.align === 'right' ? 'text-right' : 'text-left',
                )}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-b border-border last:border-0">
              {columns.map((c) => (
                <td
                  key={c.key}
                  className={cn(
                    'px-1.5 py-1.5',
                    c.align === 'right' ? 'text-right tabular-nums text-fg' : 'text-muted',
                  )}
                >
                  {r.cells[c.key] ?? '—'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
