/**
 * The Cost Intelligence chart set.
 *
 * Conventions applied throughout, so the charts read as one system:
 *
 *  - Categorical hues come from the app's `--chart-1..8` ramp in FIXED order
 *    and are never cycled. A ninth series folds into "Other" rather than
 *    reusing series 1's colour, which would make two things look like one.
 *  - One y-axis, never two. Two measures of different scale get two charts.
 *  - Every chart has a hover tooltip showing the EXACT amount, because the
 *    on-screen figure is compacted and the precise value must stay reachable.
 *  - A provider that returned nothing renders `ChartEmpty`, never an axis at
 *    zero — a flat line at ₹0 reads as "we spent nothing" rather than "we do
 *    not know".
 *  - Sequential (the calendar) is one hue light→dark. Diverging (the
 *    waterfall) is two hues with a neutral middle. No rainbows.
 */
import { useMemo } from 'react';
import cn from '@/lib/cn';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Line, ComposedChart,
  Pie, PieChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { ChartEmpty, ChartTooltip } from './CostPrimitives';
import {
  axisTick, compact, exact, formatDateShort, isMissing, NA, seriesColor, topNWithOther,
} from '../../utils/costFormat';

const GRID = 'var(--chart-grid)';
const AXIS = 'var(--chart-axis)';
const AXIS_STYLE = { fontSize: 11, fill: 'var(--fg-subtle)' };

/** Shared axis/grid setup so every time-series chart lines up visually. */
function timeAxes(currency) {
  return {
    grid: <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />,
    x: (
      <XAxis
        dataKey="date"
        tickFormatter={formatDateShort}
        tick={AXIS_STYLE}
        stroke={AXIS}
        tickLine={false}
        axisLine={{ stroke: GRID }}
        minTickGap={24}
      />
    ),
    y: (
      <YAxis
        tickFormatter={(v) => axisTick(v, currency)}
        tick={AXIS_STYLE}
        stroke={AXIS}
        tickLine={false}
        axisLine={false}
        width={52}
      />
    ),
  };
}

/**
 * Daily spend trend, one chart per currency.
 *
 * Splitting by currency rather than stacking them is not a styling choice:
 * stacking USD on INR would draw a shape whose height is a meaningless number.
 */
export function CostTrendChart({ series, currency, anomalies = [], height = 260, onWhy }) {
  const data = useMemo(
    () => (series || [])
      .filter((p) => !isMissing(p.amount))
      .map((p) => ({ date: p.date, amount: Number(p.amount) })),
    [series],
  );
  const anomalyDates = useMemo(
    () => new Set((anomalies || []).map((a) => a.date)),
    [anomalies],
  );

  if (!data.length) {
    return (
      <ChartEmpty
        height={height}
        reason="No stored billing facts for this period. Run a backfill, or check the provider diagnostics."
        onWhy={onWhy}
      />
    );
  }

  const axes = timeAxes(currency);
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="costTrendFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={seriesColor(0)} stopOpacity={0.28} />
            <stop offset="100%" stopColor={seriesColor(0)} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        {axes.grid}
        {axes.x}
        {axes.y}
        <Tooltip
          content={<ChartTooltip currency={currency} />}
          cursor={{ stroke: AXIS, strokeDasharray: '3 3' }}
        />
        {/* Anomalous days are marked on the axis itself, so a spike is
            identifiable without reading the tooltip. */}
        {[...anomalyDates].map((d) => (
          <ReferenceLine
            key={d}
            x={d}
            stroke="var(--danger)"
            strokeDasharray="2 2"
            strokeOpacity={0.7}
          />
        ))}
        <Area
          type="monotone"
          dataKey="amount"
          name={`Daily spend${currency ? ` (${currency})` : ''}`}
          stroke={seriesColor(0)}
          strokeWidth={2}
          fill="url(#costTrendFill)"
          dot={false}
          activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--surface)' }}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/**
 * Breakdown by any dimension. Horizontal bars rather than a pie whenever there
 * are more than about five slices — length is far easier to compare than angle,
 * and this chart exists to be compared, not admired.
 */
export function CostBreakdownBars({ rows, currency, dimension = 'service', height = 260, onSelect, onWhy }) {
  const { items, other } = useMemo(
    () => topNWithOther(
      (rows || []).filter((r) => !isMissing(r.amount)).map((r) => ({
        name: r[dimension] || r.name || 'Unknown',
        amount: Number(r.amount),
      })),
    ),
    [rows, dimension],
  );
  const data = other ? [...items, other] : items;
  const total = data.reduce((s, d) => s + d.amount, 0);

  if (!data.length) {
    return <ChartEmpty height={height} onWhy={onWhy} reason="Nothing was billed under this dimension for the selected period." />;
  }

  return (
    <div>
      <ResponsiveContainer width="100%" height={height}>
        <BarChart
          data={data}
          layout="vertical"
          margin={{ top: 4, right: 56, left: 4, bottom: 4 }}
          barCategoryGap={6}
        >
          <CartesianGrid stroke={GRID} strokeDasharray="3 3" horizontal={false} />
          <XAxis
            type="number"
            tickFormatter={(v) => axisTick(v, currency)}
            tick={AXIS_STYLE}
            stroke={AXIS}
            tickLine={false}
            axisLine={{ stroke: GRID }}
          />
          <YAxis
            type="category"
            dataKey="name"
            tick={AXIS_STYLE}
            stroke={AXIS}
            tickLine={false}
            axisLine={false}
            width={132}
          />
          <Tooltip
            content={<ChartTooltip currency={currency} />}
            cursor={{ fill: 'var(--chart-track)', fillOpacity: 0.5 }}
          />
          <Bar
            dataKey="amount"
            name={dimension}
            radius={[0, 4, 4, 0]}
            onClick={(d) => onSelect?.(d?.name)}
            cursor={onSelect ? 'pointer' : 'default'}
          >
            {data.map((d, i) => (
              <Cell
                key={d.name}
                fill={d.name === 'Other' ? 'var(--chart-track)' : seriesColor(i)}
                stroke="var(--surface)"
                strokeWidth={2}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>

      {/* A table view of the same numbers. The palette validator warns that
          some ramp steps fall below 3:1 against the surface, and the required
          relief is visible values — not colour alone. */}
      <table className="mt-2 w-full text-left text-[11.5px]">
        <caption className="sr-only">Exact cost by {dimension}</caption>
        <tbody>
          {data.map((d, i) => (
            <tr key={d.name} className="border-b border-border/50 last:border-0">
              <td className="py-1 pr-2 w-4">
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ background: d.name === 'Other' ? 'var(--chart-track)' : seriesColor(i) }}
                  aria-hidden
                />
              </td>
              <th scope="row" className="py-1 pr-2 font-medium text-fg">
                {d.name}
                {d.name === 'Other' && d.count ? (
                  <span className="ml-1 text-subtle">({d.count} more)</span>
                ) : null}
              </th>
              <td className="py-1 pr-2 text-right tabular-nums text-muted">
                {total ? `${((d.amount / total) * 100).toFixed(1)}%` : '—'}
              </td>
              <td className="py-1 text-right font-semibold tabular-nums text-fg">
                {exact(d.amount, currency)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Donut for cost-component share. Kept to five slices — the component model
 *  is deliberately small, so a donut is legible here where it would not be for
 *  services. */
export function CostComponentDonut({ rows, currency, height = 230, onWhy }) {
  const data = useMemo(
    () => (rows || [])
      .filter((r) => !isMissing(r.amount))
      .map((r) => ({ name: r.cost_component || 'Other', amount: Number(r.amount) })),
    [rows],
  );
  if (!data.length) return <ChartEmpty height={height} onWhy={onWhy} />;
  const total = data.reduce((s, d) => s + d.amount, 0);

  return (
    <div className="flex flex-wrap items-center gap-4">
      <ResponsiveContainer width={height} height={height}>
        <PieChart>
          <Pie
            data={data}
            dataKey="amount"
            nameKey="name"
            innerRadius="58%"
            outerRadius="86%"
            paddingAngle={2}
            stroke="var(--surface)"
            strokeWidth={2}
          >
            {data.map((d, i) => <Cell key={d.name} fill={seriesColor(i)} />)}
          </Pie>
          <Tooltip content={<ChartTooltip currency={currency} />} />
        </PieChart>
      </ResponsiveContainer>
      <ul className="min-w-[180px] flex-1 space-y-1">
        {data.map((d, i) => (
          <li key={d.name} className="flex items-center gap-2 text-[12px]">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-sm"
              style={{ background: seriesColor(i) }}
              aria-hidden
            />
            <span className="text-muted">{d.name}</span>
            <span className="ml-auto tabular-nums text-subtle">
              {total ? `${((d.amount / total) * 100).toFixed(1)}%` : ''}
            </span>
            <span className="w-24 text-right font-semibold tabular-nums text-fg">
              {compact(d.amount, currency)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Cost-change waterfall. Diverging by design: increases in one hue, decreases
 * in another, with the neutral surface between them. The bars are floating —
 * each starts where the previous ended — so the chart reads as an account of
 * how the total moved rather than a row of unrelated magnitudes.
 */
export function CostWaterfall({ movements, currency, before, after, height = 280, onWhy }) {
  const data = useMemo(() => {
    if (!movements?.length) return [];
    let running = before || 0;
    const rows = [{
      name: 'Previous', base: 0, value: running, kind: 'total',
    }];
    movements.forEach((m) => {
      const delta = Number(m.delta);
      const base = delta >= 0 ? running : running + delta;
      rows.push({
        name: m.service || m.region || m.provider || m.name || 'Unknown',
        base,
        value: Math.abs(delta),
        delta,
        kind: delta >= 0 ? 'increase' : 'decrease',
      });
      running += delta;
    });
    rows.push({ name: 'Current', base: 0, value: after ?? running, kind: 'total' });
    return rows;
  }, [movements, before, after]);

  if (!data.length) {
    return (
      <ChartEmpty
        height={height}
        title="No comparison data"
        reason="A waterfall needs two comparable periods of stored history."
        onWhy={onWhy}
      />
    );
  }

  const COLORS = {
    increase: 'var(--chart-2)',   // warm pole
    decrease: 'var(--chart-3)',   // cool pole
    total: 'var(--chart-7)',
  };

  return (
    <div>
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 40 }}>
          <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="name"
            tick={{ ...AXIS_STYLE, fontSize: 10 }}
            stroke={AXIS}
            tickLine={false}
            axisLine={{ stroke: GRID }}
            angle={-35}
            textAnchor="end"
            height={60}
            interval={0}
          />
          <YAxis
            tickFormatter={(v) => axisTick(v, currency)}
            tick={AXIS_STYLE}
            stroke={AXIS}
            tickLine={false}
            axisLine={false}
            width={52}
          />
          <Tooltip
            cursor={{ fill: 'var(--chart-track)', fillOpacity: 0.4 }}
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              const row = payload[0]?.payload;
              if (!row) return null;
              return (
                <div className="rounded-control border border-border bg-surface p-2.5 shadow-lg">
                  <p className="text-[11px] font-bold text-fg">{label}</p>
                  <p className="mt-1 text-[11px] text-muted">
                    {row.kind === 'total' ? 'Period total' : 'Change'}
                    <span className="ml-2 font-semibold tabular-nums text-fg">
                      {row.kind === 'total'
                        ? exact(row.value, currency)
                        : `${row.delta > 0 ? '+' : ''}${exact(row.delta, currency)}`}
                    </span>
                  </p>
                </div>
              );
            }}
          />
          {/* invisible base lifts each bar to where the running total sits */}
          <Bar dataKey="base" stackId="w" fill="transparent" isAnimationActive={false} />
          <Bar dataKey="value" stackId="w" radius={[4, 4, 0, 0]}>
            {data.map((d) => (
              <Cell key={d.name} fill={COLORS[d.kind]} stroke="var(--surface)" strokeWidth={2} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      <div className="mt-1 flex flex-wrap gap-3 text-[11px] text-muted">
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm" style={{ background: COLORS.increase }} aria-hidden />
          Increase
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm" style={{ background: COLORS.decrease }} aria-hidden />
          Decrease
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm" style={{ background: COLORS.total }} aria-hidden />
          Period total
        </span>
      </div>
    </div>
  );
}

/**
 * Forecast: measured days and projected days on ONE axis, distinguished by a
 * dashed stroke and a reference line at "today" rather than by a second scale.
 * The projection is visibly a different kind of thing from the actual.
 */
export function CostForecastChart({ series, forecast, currency, height = 260, onWhy }) {
  const data = useMemo(() => {
    const actual = (series || [])
      .filter((p) => !isMissing(p.amount))
      .map((p) => ({ date: p.date, actual: Number(p.amount) }));
    if (!actual.length || !forecast?.available) return actual;

    const rate = forecast.daily_average;
    const last = actual[actual.length - 1];
    const projected = [{ date: last.date, projected: last.actual }];
    const start = new Date(last.date);
    for (let i = 1; i <= (forecast.current_month?.days_remaining || 0); i += 1) {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      projected.push({ date: d.toISOString().slice(0, 10), projected: rate });
    }
    return [...actual, ...projected.slice(1)];
  }, [series, forecast]);

  if (!data.length) {
    return <ChartEmpty height={height} onWhy={onWhy} reason="No stored history to project from." />;
  }

  const axes = timeAxes(currency);
  const boundary = (series || []).filter((p) => !isMissing(p.amount)).slice(-1)[0]?.date;

  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        {axes.grid}
        {axes.x}
        {axes.y}
        <Tooltip content={<ChartTooltip currency={currency} />} />
        <Legend
          wrapperStyle={{ fontSize: 11, paddingTop: 6 }}
          iconType="plainline"
        />
        {boundary && (
          <ReferenceLine
            x={boundary}
            stroke={AXIS}
            strokeDasharray="4 4"
            label={{ value: 'today', position: 'insideTopRight', fontSize: 10, fill: 'var(--fg-subtle)' }}
          />
        )}
        <Area
          type="monotone"
          dataKey="actual"
          name="Actual"
          stroke={seriesColor(0)}
          strokeWidth={2}
          fill={seriesColor(0)}
          fillOpacity={0.12}
          dot={false}
        />
        <Line
          type="monotone"
          dataKey="projected"
          name="Run-rate projection"
          stroke={seriesColor(3)}
          strokeWidth={2}
          strokeDasharray="5 4"
          dot={false}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

/**
 * Calendar heatmap. Sequential: ONE hue, light→dark by intensity. Days with no
 * stored fact are rendered as an empty outline, never as the lightest shade —
 * "no data" and "nearly no spend" must not look the same.
 */
export function CostCalendarHeatmap({ days, currency, onSelectDay }) {
  // Computed BEFORE any early return: hooks must run in the same order on
  // every render, and an early return above a useMemo throws the moment the
  // data arrives and the component re-renders past it.
  const byWeek = useMemo(() => {
    const weeks = [];
    let current = [];
    (days || []).forEach((day) => {
      const dow = new Date(day.date).getDay();
      if (!current.length) {
        for (let i = 0; i < dow; i += 1) current.push(null);
      }
      current.push(day);
      if (current.length === 7) {
        weeks.push(current);
        current = [];
      }
    });
    if (current.length) weeks.push([...current, ...Array(7 - current.length).fill(null)]);
    return weeks;
  }, [days]);

  const stats = useMemo(() => {
    const priced = (days || []).filter((d) => !isMissing(d.amount));
    const total = priced.reduce((s, d) => s + Number(d.amount), 0);
    const top = priced.reduce((best, d) => (best && best.amount >= d.amount ? best : d), null);
    return {
      priced: priced.length,
      total,
      average: priced.length ? total / priced.length : null,
      top,
      anomalous: (days || []).filter((d) => d.anomalous).length,
    };
  }, [days]);

  if (!days?.length) {
    return <ChartEmpty height={160} reason="No stored billing facts for this period." />;
  }

  // Cells sized to the range: a month gets cells big enough to read at a
  // glance instead of a 100px-wide sliver in a 900px card; a year still fits.
  const weeks = byWeek.length;
  const cell = weeks <= 6 ? 34 : weeks <= 14 ? 24 : weeks <= 27 ? 18 : 14;
  const box = { width: cell, height: cell };
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  return (
    <div>
      <div className="flex flex-wrap items-start gap-6">
        <div className="flex gap-1 overflow-x-auto pb-1">
          <div className="flex flex-col gap-1 pr-1" aria-hidden>
            {WEEKDAYS.map((d, i) => (
              <span key={d} className="flex items-center text-[10px] text-subtle" style={{ height: cell }}>
                {cell >= 18 || i % 2 === 1 ? d : ''}
              </span>
            ))}
          </div>
          {byWeek.map((week, wi) => (
            <div key={wi} className="flex flex-col gap-1">
              {week.map((day, di) => {
                if (!day) return <span key={di} style={box} aria-hidden />;
                const missing = isMissing(day.amount);
                return (
                  <button
                    key={day.date}
                    type="button"
                    onClick={() => onSelectDay?.(day)}
                    title={`${day.date} — ${exact(day.amount, currency)}${day.anomalous ? ' (anomalous)' : ''}`}
                    aria-label={`${day.date}, ${missing ? 'no data' : exact(day.amount, currency)}`}
                    className={cn(
                      'rounded-[3px] transition-transform hover:scale-110',
                      missing && 'border border-dashed border-border',
                      day.anomalous && 'ring-2 ring-danger ring-offset-1 ring-offset-[var(--surface)]',
                    )}
                    style={missing ? box : {
                      ...box,
                      // single hue, opacity carries magnitude
                      background: seriesColor(0),
                      opacity: 0.18 + 0.82 * (day.intensity ?? 0),
                    }}
                  />
                );
              })}
            </div>
          ))}
        </div>

        {/* The same days, summarised — the numbers a reader otherwise hovers
            every cell for. Missing days are left out, never counted as 0. */}
        <dl className="grid min-w-[180px] flex-1 grid-cols-2 gap-x-6 gap-y-3 text-[12px]">
          <div>
            <dt className="text-[10px] font-bold uppercase tracking-wider text-muted">Highest day</dt>
            <dd className="mt-0.5 font-semibold text-fg">
              {stats.top ? exact(stats.top.amount, currency) : NA}
            </dd>
            {stats.top && <dd className="text-[11px] text-subtle">{stats.top.date}</dd>}
          </div>
          <div>
            <dt className="text-[10px] font-bold uppercase tracking-wider text-muted">Daily average</dt>
            <dd className="mt-0.5 font-semibold text-fg">{exact(stats.average, currency)}</dd>
            <dd className="text-[11px] text-subtle">over days with data</dd>
          </div>
          <div>
            <dt className="text-[10px] font-bold uppercase tracking-wider text-muted">Days with data</dt>
            <dd className="mt-0.5 font-semibold text-fg">{stats.priced} of {days.length}</dd>
          </div>
          <div>
            <dt className="text-[10px] font-bold uppercase tracking-wider text-muted">Anomalous days</dt>
            <dd className={cn('mt-0.5 font-semibold', stats.anomalous ? 'text-danger-fg' : 'text-fg')}>
              {stats.anomalous}
            </dd>
          </div>
        </dl>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-muted">
        <span className="flex items-center gap-1">
          Less
          {[0.18, 0.4, 0.6, 0.8, 1].map((o) => (
            <span key={o} className="h-3 w-3 rounded-[3px]"
                  style={{ background: seriesColor(0), opacity: o }} aria-hidden />
          ))}
          More
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-3 w-3 rounded-[3px] border border-dashed border-border" aria-hidden />
          No stored data
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-3 w-3 rounded-[3px] ring-2 ring-danger" aria-hidden />
          Anomalous
        </span>
      </div>
    </div>
  );
}
