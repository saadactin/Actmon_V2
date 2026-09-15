import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid,
} from 'recharts';

const DEFAULT_WINDOWS = [
  { label: '15 Min', value: 0.25 },
  { label: '1 Hour', value: 1 },
  { label: '3 Hour', value: 3 },
];

/**
 * "Activity Trends"-style line chart — title + inline colored-dot legend +
 * a real time-window <select> in the header, dashed gridlines, plain solid
 * lines with a tooltip. Deliberately NOT TrendChart's `line` style, which
 * draws each series' name directly on the chart instead of a header legend —
 * this matches the Figma reference's header-legend layout exactly. Shared so
 * every "gauge card(s) above, trend graph below" section on an engine
 * dashboard renders the identical chart, not a per-page copy.
 *
 * The window select is only meaningful when the caller passes `onWindowChange`
 * (i.e. it actually re-fetches a wider/narrower range) — without it, the
 * select still renders but changing it has no callback to act on, so callers
 * with a fixed-depth client-side buffer can omit the prop and get a
 * plain, inert display instead of a control that silently does nothing.
 */
export default function ActivityTrendChart({
  title, data, series, yDomain = [0, 100], height = 280,
  windowOptions = DEFAULT_WINDOWS, windowValue, onWindowChange,
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
        <p className="text-[15px] font-black text-slate-900 leading-tight">{title}</p>
        <div className="flex items-center gap-3">
          {series.map((s) => (
            <span key={s.key} className="inline-flex items-center gap-1.5 text-[12px] text-slate-500">
              <span className="w-2 h-2 rounded-full inline-block" style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
          {onWindowChange ? (
            <select
              value={windowValue}
              onChange={(e) => onWindowChange(Number(e.target.value))}
              className="h-7 px-2 rounded-lg border border-slate-200 text-[12px] font-semibold text-slate-600 bg-white"
            >
              {windowOptions.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
            </select>
          ) : (
            <span className="inline-flex items-center gap-1 h-7 px-2.5 rounded-lg border border-slate-200 text-[12px] font-semibold text-slate-500">
              {windowOptions.find((w) => w.value === windowValue)?.label || windowOptions[0]?.label}
            </span>
          )}
        </div>
      </div>
      {data.length < 2 ? (
        <div className="flex items-center justify-center text-[12px] text-slate-400" style={{ height }}>
          Trend appears after a couple of samples
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={height}>
          <LineChart data={data}>
            <CartesianGrid strokeDasharray="3 3" opacity={0.5} vertical={false} />
            <XAxis dataKey="t" tick={{ fontSize: 11, fill: '#94a3b8' }} tickLine={false} axisLine={{ stroke: '#e2e8f0' }} />
            <YAxis domain={yDomain} tick={{ fontSize: 11, fill: '#94a3b8' }} tickLine={false} axisLine={false} width={32} />
            <Tooltip />
            {series.map((s) => (
              <Line key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={s.color} strokeWidth={2} dot={false} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
