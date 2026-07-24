/**
 * Shared trend-chart component used by every engine dashboard's time-series
 * panels (System Health, sessions-over-time, etc). Renders one of 4 templates
 * (area / line / bar / spark) driven by DashboardAppearanceContext, or a
 * specific one via `styleOverride` (used by the Settings preview cards).
 */
import React, { useId } from 'react';
import {
  ResponsiveContainer, AreaChart, Area, LineChart, Line, BarChart, Bar,
  XAxis, YAxis, Tooltip, CartesianGrid,
} from 'recharts';
import { useDashboardAppearance } from '../../context/DashboardAppearanceContext';

const DEFAULT_COLORS = ['#22c55e', '#3f6fd6', '#f59e0b', '#8b5cf6'];

export default function TrendChart({
  data, series, xKey = 't', height = 200, styleOverride,
  yDomain = [0, 100], showLegend = true,
}) {
  const { chartStyle } = useDashboardAppearance();
  const type = styleOverride || chartStyle;
  const compact = type === 'spark';
  const uid = useId();
  const resolvedSeries = (series || []).map((s, i) => ({ color: DEFAULT_COLORS[i % DEFAULT_COLORS.length], ...s }));

  if (!data || data.length === 0) {
    return <p className="text-center text-slate-400 text-xs py-12">No trend data yet</p>;
  }

  return (
    <div>
      {showLegend && !compact && (
        <div className="flex items-center gap-4 mb-2 text-[11px] text-slate-500 dark:text-slate-400">
          {resolvedSeries.map((s) => (
            <span key={s.key} className="inline-flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
      )}
      <ResponsiveContainer width="100%" height={compact ? Math.min(height, 60) : height}>
        {renderChart(type, data, xKey, resolvedSeries, compact, yDomain, uid)}
      </ResponsiveContainer>
    </div>
  );
}

function renderChart(type, data, xKey, series, compact, yDomain, uid) {
  const sharedAxis = compact
    ? { hide: true }
    : { tick: { fontSize: 10 }, tickLine: false, axisLine: false };

  if (type === 'bar') {
    return (
      <BarChart data={data}>
        {!compact && <CartesianGrid strokeDasharray="3 3" opacity={0.15} vertical={false} />}
        <XAxis dataKey={xKey} {...sharedAxis} />
        {!compact && <YAxis domain={yDomain} {...sharedAxis} width={32} />}
        {!compact && <Tooltip />}
        {series.map((s) => <Bar key={s.key} dataKey={s.key} fill={s.color} radius={[2, 2, 0, 0]} />)}
      </BarChart>
    );
  }
  if (type === 'line' || type === 'spark') {
    return (
      <LineChart data={data}>
        {!compact && <CartesianGrid strokeDasharray="3 3" opacity={0.15} vertical={false} />}
        <XAxis dataKey={xKey} {...sharedAxis} />
        {!compact && <YAxis domain={yDomain} {...sharedAxis} width={32} />}
        {!compact && <Tooltip />}
        {series.map((s) => (
          <Line key={s.key} type="monotone" dataKey={s.key} stroke={s.color} strokeWidth={compact ? 1.5 : 2} dot={false} />
        ))}
      </LineChart>
    );
  }
  // area (default)
  return (
    <AreaChart data={data}>
      <defs>
        {series.map((s) => (
          <linearGradient key={s.key} id={`grad-${uid}-${s.key}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={s.color} stopOpacity={0.35} />
            <stop offset="100%" stopColor={s.color} stopOpacity={0} />
          </linearGradient>
        ))}
      </defs>
      {!compact && <CartesianGrid strokeDasharray="3 3" opacity={0.15} vertical={false} />}
      <XAxis dataKey={xKey} {...sharedAxis} />
      {!compact && <YAxis domain={yDomain} {...sharedAxis} width={32} />}
      {!compact && <Tooltip />}
      {series.map((s) => (
        <Area key={s.key} type="monotone" dataKey={s.key} stroke={s.color} fill={`url(#grad-${uid}-${s.key})`} strokeWidth={2} />
      ))}
    </AreaChart>
  );
}
