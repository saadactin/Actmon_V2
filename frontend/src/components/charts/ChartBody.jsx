import BarList from './BarList';
import ColumnChart from './ColumnChart';
import PieChart from './PieChart';
import StackedBar, { StackedBarList } from './StackedBar';
import Meter from './Meter';
import Gauge from './Gauge';
import Legend, { colorOf } from './Legend';
import { bandFor } from './status';
import LineChart from './LineChart';

/**
 * Renders one dataset in whichever form the user picked.
 *
 * Four families, because the data genuinely differs:
 *
 *   flat       one value per category      → bar · column · single stack · donut · pie
 *   breakdown  category × status segments  → stacked bar/column · grouped column ·
 *                                            totals bar · donut · pie (of totals)
 *   ratio      values against a 0–100 cap  → meters · gauges · columns · bars
 *   trend      one value per moment in time → area · line · column · step · sparkline
 *
 * Every form keeps the same guarantees regardless of which one is chosen: a
 * legend for two or more series, visible values (never tooltip-only), 2px surface
 * gaps between touching fills, and 4px rounded data-ends.
 */
export default function ChartBody({ family, kind, items = [], rows = [], chartProps = {} }) {
  if (family === 'ratio') return <RatioBody kind={kind} items={items} {...chartProps} />;
  if (family === 'breakdown') return <BreakdownBody kind={kind} rows={rows} {...chartProps} />;
  if (family === 'trend') return <LineChart kind={kind} data={items} {...chartProps} />;
  return <FlatBody kind={kind} items={items} {...chartProps} />;
}

/* ── flat: one value per category ───────────────────────────────────────── */
function FlatBody({
  kind, items, unit = '', format, emptyLabel, labelWidth, max,
  /** 'side' sits the legend beside the ring, 'below' centres it underneath. */
  legend = 'side',
  /** Small caption inside a donut's hole, e.g. "2 Hosts". Omitted → empty hole. */
  centerLabel,
  /** false prints each value inline instead of reading it off a shared gridded
      scale — for categories whose counts aren't commensurable (ports vs.
      filesystems), where one shared axis would make the small ones invisible. */
  showAxis,
  /** Bar/column thickness override — a card with only a handful of rows and
      real vertical room to spare can afford chunkier marks than the default. */
  thickness,
}) {
  const coloured = items.map((it, i) => ({ ...it, color: colorOf(it, i) }));

  switch (kind) {
    case 'pie':
    case 'donut':
      return (
        <PieChart
          items={coloured}
          donut={kind === 'donut'}
          unit={unit}
          emptyLabel={emptyLabel}
          legend={legend}
          centerLabel={centerLabel}
        />
      );
    case 'column':
      return (
        <ColumnChart
          items={coloured} unit={unit} format={format} max={max} emptyLabel={emptyLabel}
          {...(showAxis === false ? { showAxis: false } : {})}
          {...(thickness ? { barWidth: thickness } : {})}
        />
      );
    case 'stacked':
      return <StackedBar segments={coloured} unit={unit} height={14} emptyLabel={emptyLabel} />;
    case 'bar':
    default:
      return (
        <BarList
          items={coloured}
          unit={unit}
          max={max}
          format={format}
          labelWidth={labelWidth}
          emptyLabel={emptyLabel}
          {...(showAxis === false ? { showAxis: false } : {})}
          {...(thickness ? { thickness } : {})}
        />
      );
  }
}

/* ── breakdown: category × segments ─────────────────────────────────────── */
function BreakdownBody({ kind, rows, unit = '', format = (v) => v, emptyLabel, labelWidth, legend = true }) {
  // Legend comes from the first row's segments — every row shares the same series.
  const legendItems = (rows[0]?.segments || []).map((s) => ({
    key: s.key,
    label: s.label,
    status: s.status,
    color: s.color,
    value: rows.reduce((sum, r) => sum + (r.segments.find((x) => x.key === s.key)?.value || 0), 0),
  }));

  const totals = rows.map((r) => ({ key: r.key, label: r.label, value: r.total, onClick: r.onClick }));

  const body = (() => {
    switch (kind) {
      case 'pie':
      case 'donut':
        // A pie of TOTALS — the status split can't be expressed radially without
        // a sunburst, so the legend below still reports it.
        return (
          <PieChart
            items={totals.map((t, i) => ({ ...t, color: `var(--chart-${(i % 8) + 1})` }))}
            donut={kind === 'donut'}
            unit={unit}
            format={format}
            emptyLabel={emptyLabel}
          />
        );
      case 'bar':
        return (
          <BarList
            items={totals.map((t) => ({ ...t, color: 'var(--chart-1)' }))}
            labelWidth={labelWidth}
            unit={unit}
            format={format}
            emptyLabel={emptyLabel}
          />
        );
      case 'stackedColumn':
        return <ColumnChart items={rows} mode="stacked" unit={unit} format={format} emptyLabel={emptyLabel} />;
      case 'groupedColumn':
        return <ColumnChart items={rows} mode="grouped" unit={unit} format={format} emptyLabel={emptyLabel} />;
      case 'stackedBar':
      default:
        return <StackedBarList rows={rows} labelWidth={labelWidth} format={format} emptyLabel={emptyLabel} />;
    }
  })();

  // Totals-only forms drop the split, so the legend is the only place it survives.
  const needsLegend = legend && legendItems.length > 1;
  const isTotalsOnly = kind === 'bar' || kind === 'pie' || kind === 'donut';

  return (
    <>
      {body}
      {needsLegend && rows.length > 0 && (
        <div className="mt-3 space-y-1">
          <Legend items={legendItems} format={format} />
          {isTotalsOnly && (
            <p className="text-[10px] text-subtle">
              This form shows totals only — counts above are across all rows.
            </p>
          )}
        </div>
      )}
    </>
  );
}

/* ── ratio: measured against a fixed 100% ───────────────────────────────── */
function RatioBody({ kind, items, hint, size }) {
  // Utilisation means good→critical, so every form here wears the status band —
  // not a series slot — UNLESS the item already names its own colour: a metric
  // like availability is inverted (high is good), and forcing bandFor on it would
  // paint 100% "critical" red. An explicit colour is the caller overriding the
  // default judgement, not styling.
  const banded = items.map((it) => ({ ...it, color: it.color || bandFor(it.value).color }));
  // A row of three rings (CPU/RAM/disk) needs the smaller size to stay side by
  // side; a single ring has the whole card to itself, so it can fill more of it.
  const ringSize = size || (items.length > 1 ? 132 : 176);

  switch (kind) {
    case 'gauge':
      // Rings carry the name, the row underneath carries the number. Splitting them
      // keeps each ring's hole legible at this size, where a percentage and a label
      // stacked inside it both end up too small to read.
      return (
        <div className="flex h-full flex-col justify-center gap-4">
          <div className="flex flex-wrap items-start justify-around gap-3">
            {items.map((it) => (
              <Gauge key={it.key} label={it.label} value={it.value} color={it.color} size={ringSize} showValue={false} />
            ))}
          </div>
          <div className="flex flex-wrap items-center justify-center gap-x-7 gap-y-2">
            {items.map((it) => {
              const tint = it.color || bandFor(it.value).color;
              return (
                <span
                  key={it.key}
                  className="flex items-center gap-1.5 text-[13px] font-semibold tabular-nums"
                  style={{ color: tint }}
                >
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: tint }} />
                  {Number.isFinite(it.value) ? `${Math.round(it.value)}%` : '—'}
                </span>
              );
            })}
          </div>
        </div>
      );
    // column/bar/meter have no natural notion of "fill the card" the way a
    // fixed-height plot or a flex list does — without an explicit centering
    // wrapper they sit at the top of whatever height the card ends up (e.g. the
    // overview's min-height cards), leaving a dead gap below instead of using it.
    case 'column':
      return (
        <div className="flex h-full flex-col justify-center">
          <ColumnChart items={banded} max={100} unit="%" format={(v) => Math.round(v)} height={130} />
        </div>
      );
    case 'bar':
      return (
        <div className="flex h-full flex-col justify-center">
          <BarList items={banded} max={100} unit="%" format={(v) => Math.round(v)} labelWidth={70} />
        </div>
      );
    case 'meter':
    default:
      return (
        <div className="flex h-full flex-col justify-center gap-4">
          {items.map((it) => (
            <Meter key={it.key} label={it.label} value={it.value} icon={it.icon} hint={it.hint ?? hint} color={it.color} />
          ))}
        </div>
      );
  }
}
