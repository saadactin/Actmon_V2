/**
 * Shared trend-chart component used by every engine dashboard's time-series
 * panels (System Health, sessions-over-time, etc). Renders one of 7 templates
 * (area / line / bar / spark / pie / donut / scatter) driven by
 * DashboardAppearanceContext, or a specific one via `styleOverride` (used by
 * the Settings preview cards). `title`/`subtitle`/`caption` are opt-in chrome
 * (only shown when a caller passes them) — every existing dashboard keeps
 * rendering exactly as before unless it asks for the extra chrome.
 */
import React, { useId } from 'react';
import {
  ResponsiveContainer, AreaChart, Area, LineChart, Line, BarChart, Bar,
  XAxis, YAxis, Tooltip, CartesianGrid, PieChart, Pie, Cell,
  ScatterChart, Scatter, Legend, LabelList, ReferenceArea, ReferenceLine,
} from 'recharts';
import { useDashboardAppearance } from '../../context/DashboardAppearanceContext';

const DEFAULT_COLORS = ['#22c55e', '#3f6fd6', '#f59e0b', '#8b5cf6'];
// Compact axis labels for large values (e.g. document/request counts): 12500 -> "12.5k".
// Left alone below 1000, so the percentage-based gauges used everywhere else are unaffected.
function fmtAxisNum(v) {
  const abs = Math.abs(v);
  if (abs >= 1000) {
    const scaled = v / 1000;
    return `${Number.isInteger(scaled) ? scaled : scaled.toFixed(1)}k`;
  }
  return v;
}
// Picks a "nice" tick step (1/2/5 × a power of 10) for a given range instead
// of just dividing it into a fixed count — a 0-100 gauge gets steps of 10
// (0,10,20…100), a 0-50 one gets steps of 5, a 0-25 one gets steps of 5, a
// 0-10 one gets steps of 1 — whatever the actual [min,max] happens to be,
// rather than fixed fractions that produce ugly labels like 13/38/63/88.
function niceStep(range, targetTicks) {
  if (!(range > 0)) return 1;
  const rawStep = range / targetTicks;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  const niceNorm = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return niceNorm * mag;
}
// Generates tick VALUES (not just fractions) from min to max at the given
// step, always including the true max as the final tick even if it doesn't
// land exactly on a step boundary — matches how real axis scales behave.
function niceTicks(min, max, step) {
  const vals = [];
  for (let v = min; v < max - step * 1e-6; v += step) vals.push(v);
  vals.push(max);
  return vals;
}
// For one series, find the data index where it sits furthest from every
// OTHER series — that's where its inline label reads clearest, matching
// Highcharts' own series-label placement (which is why "Users" lands at its
// peak while "Average" lands elsewhere: each gets the point with the most
// clearance from the other line, not just the last sample).
function bestLabelIndex(seriesIdx, series, data) {
  if (series.length <= 1) return data.length - 1;
  const s = series[seriesIdx];
  let bestIdx = data.length - 1;
  let bestClearance = -Infinity;
  for (let i = 0; i < data.length; i++) {
    const v = Number(data[i][s.key]) || 0;
    let minDist = Infinity;
    series.forEach((s2, j) => {
      if (j === seriesIdx) return;
      minDist = Math.min(minDist, Math.abs(v - (Number(data[i][s2.key]) || 0)));
    });
    if (minDist > bestClearance) {
      bestClearance = minDist;
      bestIdx = i;
    }
  }
  return bestIdx;
}
// Draws a series' name directly on the chart at its clearest point, in the
// series' own color — replaces a separate legend row for Line style. Anchors
// away from the chart edge so long labels near the first/last sample don't
// get clipped by the plot area's boundary.
function seriesLabel(s, atIndex, dataLen) {
  return (props) => {
    if (props.index !== atIndex) return null;
    const nearRight = atIndex >= dataLen - 2;
    const nearLeft = atIndex <= 1;
    const anchor = nearRight ? 'end' : nearLeft ? 'start' : 'middle';
    const dx = nearRight ? -6 : nearLeft ? 6 : 0;
    return (
      <text x={props.x + dx} y={props.y} dy={-10} fill={s.color} fontSize={11} fontWeight="700" textAnchor={anchor}>
        {s.label}
      </text>
    );
  };
}
// Highcharts' own Pie/Donut demos give every slice a genuinely distinct hue
// (not a shaded single color) — this is that qualitative palette, cycled if
// there are more slices than colors.
const PIE_PALETTE = ['#38bdf8', '#4f46e5', '#22c55e', '#f97316', '#64748b', '#ec4899', '#eab308', '#14b8a6', '#ef4444', '#8b5cf6'];
// Picks white or dark text for a badge so it stays readable against that
// badge's own fill color, instead of a fixed dark/light split by dominance.
// Guards both color helpers below against a missing/malformed color — e.g. a
// widget whose data doesn't carry a `color` field at all (a chart style like
// Gantt or Pie applied to another style's generic sample data, which has no
// reason to include one). Without this, `undefined.replace(...)` crashed the
// whole page instead of just falling back to a neutral gray.
function normalizeHex(hex) {
  return typeof hex === 'string' && /^#[0-9a-fA-F]{6}$/.test(hex) ? hex : '#64748b';
}
function readableTextOn(hex) {
  const c = normalizeHex(hex).replace('#', '');
  const r = parseInt(c.substring(0, 2), 16), g = parseInt(c.substring(2, 4), 16), b = parseInt(c.substring(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? '#1e293b' : '#ffffff';
}
// A semi-transparent fill over a white page reads lighter than its raw hex —
// blend toward white first so the contrast check matches what's actually
// visible (a light color at low opacity should still get dark text).
function blendTowardWhite(hex, opacity) {
  const c = normalizeHex(hex).replace('#', '');
  const r = parseInt(c.substring(0, 2), 16), g = parseInt(c.substring(2, 4), 16), b = parseInt(c.substring(4, 6), 16);
  const mix = (v) => Math.round(v * opacity + 255 * (1 - opacity));
  const toHex = (v) => v.toString(16).padStart(2, '0');
  return `#${toHex(mix(r))}${toHex(mix(g))}${toHex(mix(b))}`;
}
// Highcharts' Pie/Donut demos draw two labels per slice: a rounded percentage
// "badge" filled in that slice's own color (text auto-contrasted), and the
// category name further out at the end of a connector line colored to match.
// Bound to `slices` (each already carrying its assigned palette color) so the
// badge/line match the actual wedge instead of a single shared color.
function renderPieLabel(slices) {
  return (props) => {
    const { cx, cy, midAngle, outerRadius, percent, name, index } = props;
    const RADIAN = Math.PI / 180;
    const cos = Math.cos(-midAngle * RADIAN), sin = Math.sin(-midAngle * RADIAN);
    const color = slices[index]?.color || '#3f6fd6';
    const nameR = outerRadius + 22;
    const nx = cx + nameR * cos, ny = cy + nameR * sin;
    const pct = Math.round(percent * 100);
    const dominant = percent >= 0.12;
    const badgeR = dominant ? outerRadius * 0.68 : outerRadius + 9;
    const bx = cx + badgeR * cos, by = cy + badgeR * sin;
    const badgeW = pct >= 10 ? 30 : 22;
    return (
      <g key={index}>
        <rect x={bx - badgeW / 2} y={by - 9} width={badgeW} height={18} rx={9} fill={color} />
        <text x={bx} y={by} textAnchor="middle" dominantBaseline="central" fontSize={10} fontWeight={800}
          fill={readableTextOn(color)}>{pct}%</text>
        <text x={nx} y={ny} textAnchor={nx > cx ? 'start' : 'end'} dominantBaseline="central" fontSize={11} fontWeight={700} fill="#334155">
          {name}
        </text>
      </g>
    );
  };
}
// Two-segment connector from the slice edge to the name label, colored to
// match the slice (Highcharts' leader lines pick up each slice's own hue).
function renderPieLabelLine(slices) {
  return (props) => {
    const { cx, cy, midAngle, outerRadius, index } = props;
    const RADIAN = Math.PI / 180;
    const cos = Math.cos(-midAngle * RADIAN), sin = Math.sin(-midAngle * RADIAN);
    const color = slices[index]?.color || '#94a3b8';
    const x1 = cx + outerRadius * cos, y1 = cy + outerRadius * sin;
    const x2 = cx + (outerRadius + 14) * cos, y2 = cy + (outerRadius + 14) * sin;
    const x3 = cx + (outerRadius + 22) * cos, y3 = cy + (outerRadius + 22) * sin;
    return <polyline points={`${x1},${y1} ${x2},${y2} ${x3},${y3}`} stroke={color} fill="none" strokeWidth={1} />;
  };
}
// Semi-circular dial gauge — mirrors Highcharts' own Gauge demo exactly
// (pane: startAngle -90 / endAngle 90 — a true 180° dome over the top),
// including its actual plotBand colors/thresholds. Highcharts sizes the pane
// as a true CIRCLE fit to the available height and centers it — it does NOT
// stretch into a wide ellipse, which is why the reference sits compact in
// the middle of a much wider card with empty space on either side. Rendered
// as plain SVG (Recharts has no dial primitive); `width`/`height` arrive via
// ResponsiveContainer cloning its child exactly like every other chart type
// here.
function GaugeDial({ width = 300, height = 200, value, min, max, unit }) {
  const cx = width / 2;
  // Ticks/tick-labels need real room and get dropped below that; the value
  // number is the one thing a tiny mini-card gauge still needs to be useful
  // (otherwise every card just shows an near-identical bare arc+needle with
  // no way to tell them apart), so it stays even at mini-card sizes, just
  // smaller. `r`'s floor scales down with the container too — a fixed 46px
  // minimum overflowed anything shorter than ~90px and got clipped.
  const showChrome = height >= 120;
  const showValue = height >= 40;
  const topPad = showChrome ? 20 : 4;
  const bottomPad = showChrome ? 40 : (showValue ? 16 : 2);
  const r = Math.max(18, Math.min(width / 2 - (showChrome ? 28 : 8), height - topPad - bottomPad));
  const cy = topPad + r;
  // Band/track thickness scales with the dial itself instead of a fixed
  // pixel width — otherwise a large dial ends up with a comically thin ring.
  const bandW = Math.max(10, Math.min(40, r * 0.13));
  const START = 180, END = 0, SWEEP = START - END; // exact flat semicircle — pivot sits level with the 0/max ticks
  const toRad = (d) => (d * Math.PI) / 180;
  const pointAt = (deg, radius) => ({ x: cx + radius * Math.cos(toRad(deg)), y: cy - radius * Math.sin(toRad(deg)) });
  const degFor = (v) => START - (Math.max(min, Math.min(max, v)) - min) / (max - min || 1) * SWEEP;
  const arcPath = (r0, d0, d1) => {
    const p0 = pointAt(d0, r0), p1 = pointAt(d1, r0);
    const large = Math.abs(d0 - d1) > 180 ? 1 : 0;
    return `M ${p0.x} ${p0.y} A ${r0} ${r0} 0 ${large} 1 ${p1.x} ${p1.y}`;
  };
  // Exact plotBands from the Highcharts demo (0-55% gray, 55-75% amber,
  // 75-100% green), scaled to whatever [min,max] this widget actually uses.
  const bands = [
    { from: 0, to: 0.55, fill: 'rgba(128,128,128,0.18)' },
    { from: 0.55, to: 0.75, fill: '#FFBF00' },
    { from: 0.75, to: 1, fill: '#00A96B' },
  ];
  // Nice round step for whatever [min,max] this widget actually uses — a
  // 0-100 gauge gets 0,10,20…100; a 0-50 one gets steps of 5; a 0-25 one
  // gets steps of 5; a 0-10 one gets steps of 1 — never a fixed fraction
  // count that produces labels like 13/38/63/88.
  const majorStep = niceStep(max - min, 10);
  const majorVals = niceTicks(min, max, majorStep);
  // 5 minor divisions per major interval — genuinely aligned with the value
  // scale (not just an arbitrary angular count), skipping positions that
  // coincide with a major tick since that gets its own longer mark.
  const minorStep = majorStep / 5;
  const minorVals = niceTicks(min, max, minorStep)
    .filter((v) => !majorVals.some((mv) => Math.abs(mv - v) < minorStep * 1e-6));
  // r is the band's centerline and bandW its full stroke width, so the
  // band's actual inner/outer edges are r ∓ bandW/2. The tick "scale" sits
  // INSIDE the tube — between the needle hub and the band's inner edge,
  // with a clear gap so it never touches the tube — while the number
  // labels sit on the far OUTSIDE of the tube, matching the reference
  // exactly (ticks are not the same ring as the labels).
  const bandInner = r - bandW / 2;
  const bandOuter = r + bandW / 2;
  const tickGap = 4;
  const tickLen = Math.max(6, bandW * 0.55);
  const valueDeg = degFor(value);
  const needleTip = pointAt(valueDeg, r - bandW - 4);
  const needleBaseL = pointAt(valueDeg + 90, 5);
  const needleBaseR = pointAt(valueDeg - 90, 5);
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <path d={arcPath(r, START, END)} stroke="rgba(128,128,128,0.1)" strokeWidth={bandW} fill="none" />
      {bands.map((b, i) => (
        <path key={i} d={arcPath(r, START - b.from * SWEEP, START - b.to * SWEEP)}
          stroke={b.fill} strokeWidth={bandW} fill="none" />
      ))}
      {showChrome && minorVals.map((v, i) => {
        const deg = degFor(v);
        const p0 = pointAt(deg, bandInner - tickGap - tickLen), p1 = pointAt(deg, bandInner - tickGap);
        // Darker than the pale-gray track (not just #cbd5e1) so ticks stay
        // equally visible over every band color — a light tick reads as
        // "missing" over the pale zone and "present" over the bright
        // yellow/green zones, which looks like uneven spacing even though
        // the positions themselves are exactly uniform.
        return <line key={i} x1={p0.x} y1={p0.y} x2={p1.x} y2={p1.y} stroke="#94a3b8" strokeWidth={Math.max(1, bandW * 0.045)} />;
      })}
      {showChrome && majorVals.map((v, i) => {
        const deg = degFor(v);
        // Major ticks get their own longer, darker mark (distinct from the
        // fine minor ring) plus the value label further out.
        const p0 = pointAt(deg, bandInner - tickGap - tickLen * 1.35), p1 = pointAt(deg, bandInner - tickGap);
        const labelP = pointAt(deg, bandOuter + 2 + tickLen + 12);
        return (
          <React.Fragment key={i}>
            <line x1={p0.x} y1={p0.y} x2={p1.x} y2={p1.y} stroke="#475569" strokeWidth={Math.max(1, bandW * 0.07)} />
            <text x={labelP.x} y={labelP.y} textAnchor="middle" dominantBaseline="central"
              fontSize={10} fontWeight={700} fill="#64748b">
              {fmtAxisNum(Math.round(v * 100) / 100)}
            </text>
          </React.Fragment>
        );
      })}
      <polygon points={`${needleTip.x},${needleTip.y} ${needleBaseL.x},${needleBaseL.y} ${needleBaseR.x},${needleBaseR.y}`}
        fill="#1e293b" />
      <circle cx={cx} cy={cy} r={9} fill="#1e293b" />
      <circle cx={cx} cy={cy} r={3.5} fill="#ffffff" />
      {showChrome && (
        <text x={cx} y={cy + 34} textAnchor="middle" fontSize={20} fontWeight={900} fill="#0f172a">
          {fmtAxisNum(typeof value === 'number' ? Math.round(value * 100) / 100 : value)}{unit || ''}
        </text>
      )}
    </svg>
  );
}
// Highcharts' Gantt-chart demo: a hierarchical task table (Title/Duration)
// on the left, a day-numbered timeline on the right with group "summary"
// bars (thin bracketed line + label), leaf task bars (solid, or split into a
// filled/unfilled shade for a percent-complete overlay), diamond milestone
// markers, and elbow dependency-connector arrows between tasks. Rendered as
// a real HTML table + plain SVG (Recharts has no Gantt primitive) — day
// numbers rather than real calendar dates, since no date library is wired
// into this component; that's an honest simplification, not a faked detail.
function GanttChart({ width = 600, height = 320, data }) {
  const tasks = data || [];
  if (tasks.length === 0) return <p className="text-center text-slate-400 text-xs py-12">No tasks yet</p>;
  // Gantt needs task rows (start/duration/isGroup), not a generic time
  // series or category breakdown — applying it to another style's sample
  // data (e.g. a mini preview card built for Line/Bar) has nothing to draw a
  // timeline from, so say so plainly instead of rendering garbled NaN bars.
  const looksLikeTasks = tasks.some((t) => t.isGroup || (typeof t.start === 'number' && typeof t.duration === 'number'));
  if (!looksLikeTasks) {
    return <p className="text-center text-slate-400 text-xs py-8 px-3">Gantt needs task data (start/duration/dependencies) — not applicable to this sample.</p>;
  }
  // A group row's own span is the min start → max end of the child rows that
  // immediately follow it (up to the next group row) — never hand-set, so it
  // can't drift out of sync with its children.
  const rows = tasks.map((t, i) => {
    if (!t.isGroup) return t;
    let start = Infinity, end = -Infinity;
    for (let j = i + 1; j < tasks.length && !tasks[j].isGroup; j++) {
      start = Math.min(start, tasks[j].start);
      end = Math.max(end, tasks[j].start + tasks[j].duration);
    }
    const s = start === Infinity ? 0 : start;
    return { ...t, start: s, duration: (end === -Infinity ? s : end) - s };
  });
  const byId = Object.fromEntries(rows.map((t) => [t.id, t]));
  const maxDay = Math.max(...rows.map((t) => t.start + t.duration), 1);
  const tableWidth = Math.min(230, Math.max(140, width * 0.32));
  const timelineWidth = Math.max(80, width - tableWidth);
  const headerH = 24;
  const rowH = Math.max(20, Math.min(30, (height - headerH) / rows.length));
  const plotW = timelineWidth - 16;
  const dayToX = (d) => 8 + (d / maxDay) * plotW;

  return (
    <div style={{ width, height, display: 'flex', overflow: 'hidden', fontSize: 11 }}>
      <div style={{ width: tableWidth, flexShrink: 0, borderRight: '1px solid #e2e8f0' }}>
        <div style={{ height: headerH, display: 'flex', alignItems: 'center', fontWeight: 700, color: '#94a3b8', fontSize: 10, textTransform: 'uppercase', borderBottom: '1px solid #e2e8f0', padding: '0 8px' }}>
          <span style={{ flex: 1 }}>Title</span><span style={{ width: 56, textAlign: 'right' }}>Duration</span>
        </div>
        {rows.map((t) => (
          <div key={t.id} style={{
            height: rowH, display: 'flex', alignItems: 'center', padding: '0 8px',
            paddingLeft: t.isGroup ? 8 : 20, fontWeight: t.isGroup ? 800 : 500,
            color: t.isGroup ? '#1e293b' : '#475569', borderBottom: '1px solid #f1f5f9',
          }}>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</span>
            <span style={{ width: 56, textAlign: 'right', color: '#94a3b8', fontWeight: 500 }}>
              {t.duration === 0 ? '—' : `${t.duration} day${t.duration === 1 ? '' : 's'}`}
            </span>
          </div>
        ))}
      </div>
      <div style={{ width: timelineWidth, flexShrink: 0 }}>
        <svg width={timelineWidth} height={height}>
          <defs>
            <marker id="ganttArrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
              <path d="M0,0 L6,3 L0,6 Z" fill="#94a3b8" />
            </marker>
          </defs>
          {Array.from({ length: Math.floor(maxDay) + 1 }, (_, d) => d).map((d) => (
            <text key={d} x={dayToX(d)} y={headerH - 8} textAnchor="middle" fontSize={9} fontWeight={700} fill="#94a3b8">Day {d}</text>
          ))}
          <line x1={0} y1={headerH} x2={timelineWidth} y2={headerH} stroke="#e2e8f0" />
          {rows.map((t, i) => {
            const cy = headerH + i * rowH + rowH / 2;
            if (t.isGroup) {
              const x1 = dayToX(t.start), x2 = dayToX(t.start + t.duration);
              return (
                <g key={t.id}>
                  <line x1={x1} y1={cy} x2={x2} y2={cy} stroke="#64748b" strokeWidth={2} />
                  <line x1={x1} y1={cy - 4} x2={x1} y2={cy + 4} stroke="#64748b" strokeWidth={2} />
                  <line x1={x2} y1={cy - 4} x2={x2} y2={cy + 4} stroke="#64748b" strokeWidth={2} />
                  <text x={x2 + 6} y={cy} dominantBaseline="central" fontSize={10} fontWeight={700} fill="#334155">{t.name}</text>
                </g>
              );
            }
            if (t.duration === 0) {
              const x = dayToX(t.start), s = 6;
              return (
                <g key={t.id}>
                  <rect x={x - s} y={cy - s} width={s * 2} height={s * 2} fill={t.color} transform={`rotate(45 ${x} ${cy})`} />
                  <text x={x + s + 6} y={cy} dominantBaseline="central" fontSize={10} fontWeight={700} fill="#334155">{t.name}</text>
                </g>
              );
            }
            const x1 = dayToX(t.start), x2 = dayToX(t.start + t.duration);
            const barH = Math.min(20, rowH * 0.6);
            const y = cy - barH / 2;
            if (typeof t.percent === 'number') {
              const light = blendTowardWhite(t.color, 0.35);
              const xp = x1 + (x2 - x1) * (t.percent / 100);
              return (
                <g key={t.id}>
                  <rect x={x1} y={y} width={x2 - x1} height={barH} rx={barH / 2} fill={light} />
                  <rect x={x1} y={y} width={Math.max(0, xp - x1)} height={barH} rx={barH / 2} fill={t.color} />
                  <text x={x1 + 8} y={cy} dominantBaseline="central" fontSize={10} fontWeight={700} fill={readableTextOn(t.color)}>{t.name}</text>
                  <text x={x2 - 8} y={cy} textAnchor="end" dominantBaseline="central" fontSize={10} fontWeight={700} fill={readableTextOn(light)}>{t.percent}%</text>
                </g>
              );
            }
            return (
              <g key={t.id}>
                <rect x={x1} y={y} width={x2 - x1} height={barH} rx={barH / 2} fill={t.color} />
                <text x={x1 + 8} y={cy} dominantBaseline="central" fontSize={10} fontWeight={700} fill={readableTextOn(t.color)}>{t.name}</text>
              </g>
            );
          })}
          {rows.map((t) => {
            if (!t.dependsOn || t.isGroup) return null;
            const src = byId[t.dependsOn];
            if (!src) return null;
            const srcIdx = rows.indexOf(src), dstIdx = rows.indexOf(t);
            const x1 = dayToX(src.start + src.duration), y1 = headerH + srcIdx * rowH + rowH / 2;
            const x2 = dayToX(t.start), y2 = headerH + dstIdx * rowH + rowH / 2;
            const midX = x1 + 10;
            return (
              <polyline key={`${t.id}-dep`} points={`${x1},${y1} ${midX},${y1} ${midX},${y2} ${x2 - 4},${y2}`}
                fill="none" stroke="#94a3b8" strokeWidth={1.2} markerEnd="url(#ganttArrow)" />
            );
          })}
        </svg>
      </div>
    </div>
  );
}
// Highcharts' Bubble-chart demo draws each point as a circle sized by a
// THIRD numeric dimension, with a short label inside the circle and a
// distinct color per point (not per series, since a bubble chart compares
// individual entities, not time-series lines). `zMax` normalizes radius so
// the largest bubble in view is a fixed max size regardless of the actual
// data's scale.
function renderBubble(sizeKey, labelKey, zMax) {
  return (props) => {
    const { cx, cy, payload } = props;
    const z = Number(payload?.[sizeKey]) || 0;
    const rad = 9 + Math.sqrt(Math.max(z, 0) / zMax) * 32;
    // Recharts' Scatter `shape` callback doesn't reliably pass the point's
    // array index, so picking a palette color via `props.index` silently
    // resolved to undefined for every bubble — an unfilled SVG <circle>
    // defaults to solid black, which is why every bubble rendered the same
    // dark color instead of a distinct hue. The color is attached directly
    // to each row (__bubbleColor) before it ever reaches this renderer.
    const color = payload?.__bubbleColor || '#3f6fd6';
    const label = labelKey ? payload?.[labelKey] : null;
    return (
      <g>
        <circle cx={cx} cy={cy} r={rad} fill={color} fillOpacity={0.72} stroke={color} strokeWidth={1.5} />
        {label && (
          <text x={cx} y={cy} textAnchor="middle" dominantBaseline="central" fontSize={Math.max(8, Math.min(11, rad * 0.5))}
            fontWeight={800} fill={readableTextOn(blendTowardWhite(color, 0.72))}>{label}</text>
        )}
      </g>
    );
  };
}
// Styles that actually render below. Anything else (heatmap, candle,
// choropleth, tiledmap, gantt) is listed in the Settings gallery as "not
// built yet" — this must refuse them too, so a stray/typo'd saved value can
// never silently fall through to a look nobody chose.
const BUILT_STYLES = new Set(['area', 'line', 'bar', 'barh', 'spark', 'pie', 'donut', 'scatter', 'gauge', 'bubble', 'gantt']);

export default function TrendChart({
  data, series, xKey = 't', height = 200, styleOverride,
  yDomain = [0, 100], showLegend = true, xLabel, yLabel,
  title, subtitle, caption, sizeKey, labelKey, xThreshold, yThreshold, zoneLabel,
}) {
  const { chartStyle } = useDashboardAppearance();
  const type = styleOverride || chartStyle;
  const compact = type === 'spark';
  const uid = useId();
  const resolvedSeries = (series || []).map((s, i) => ({ color: DEFAULT_COLORS[i % DEFAULT_COLORS.length], ...s }));

  if (!data || data.length === 0) {
    return <p className="text-center text-slate-400 text-xs py-12">No trend data yet</p>;
  }

  if (!BUILT_STYLES.has(type)) {
    return (
      <div className="flex items-center justify-center text-center px-4" style={{ height: compact ? Math.min(height, 60) : height }}>
        <p className="text-xs text-slate-400">This chart type isn't built yet.</p>
      </div>
    );
  }

  // Line style draws each series' name directly on the chart (see
  // seriesLabel above) instead of a legend row. Column (bar) style puts its
  // legend below the chart, centered — matching the reference layouts for
  // each of those two chart types.
  return (
    <div>
      {title && <p className={`text-[15px] font-black text-slate-900 leading-tight ${type === 'gauge' ? 'text-center' : ''}`}>{title}</p>}
      {subtitle && <p className={`text-[11.5px] text-slate-400 mb-2 ${type === 'gauge' ? 'text-center' : ''}`}>{subtitle}</p>}
      {showLegend && !compact && type !== 'line' && type !== 'bar' && type !== 'barh' && type !== 'gauge' && type !== 'bubble' && type !== 'gantt'
        && !((type === 'pie' || type === 'donut') && xKey !== 't') && (
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
        {renderChart(type, data, xKey, resolvedSeries, compact, yDomain, uid, xLabel, yLabel,
          { sizeKey, labelKey, xThreshold, yThreshold, zoneLabel })}
      </ResponsiveContainer>
      {showLegend && !compact && type === 'bar' && (
        <div className="flex items-center justify-center gap-4 mt-2 text-[11px] text-slate-500 dark:text-slate-400">
          {resolvedSeries.map((s) => (
            <span key={s.key} className="inline-flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
      )}
      {caption && (
        <div className="mt-3 rounded-md bg-emerald-50/60 border-l-2 border-emerald-300 px-3 py-2">
          <p className="text-[11.5px] italic text-slate-600 leading-snug">{caption}</p>
        </div>
      )}
    </div>
  );
}

function renderChart(type, data, xKey, series, compact, yDomain, uid, xLabel, yLabel, bubbleOpts = {}) {
  const sharedAxis = compact
    ? { hide: true }
    : { tick: { fontSize: 10 }, tickLine: false, axisLine: { stroke: '#cbd5e1' } };
  // Only set when the caller actually passes xLabel/yLabel — leaves every
  // existing dashboard's axes exactly as before unless it opts in.
  const yAxisLabel = compact || !yLabel ? undefined
    : { value: yLabel, angle: -90, position: 'insideLeft', offset: 8, style: { fontSize: 10, fill: '#94a3b8' } };
  const xAxisLabel = compact || !xLabel ? undefined
    : { value: xLabel, position: 'insideBottomRight', offset: -2, style: { fontSize: 10, fill: '#94a3b8' } };
  const bottomMargin = xLabel && !compact ? 16 : 0;

  if (type === 'gauge') {
    // A dial only ever reads one number, so a second series (if passed)
    // isn't plotted. For a genuine time series (xKey='t') that number is the
    // latest sample. For categorical data (Query Operations, Database Size
    // Distribution, etc. — many rows, not points in time) there's no
    // "latest" row, so it's the TOTAL across every category instead — the
    // only single figure that isn't an arbitrary pick of one row. The domain
    // is derived from that same number, so the needle can never peg against
    // a max sized for an unrelated value.
    const primary = series[0];
    const isCategorical = xKey !== 't';
    const value = isCategorical
      ? data.reduce((sum, d) => sum + (Number(d[primary.key]) || 0), 0)
      : (Number(data[data.length - 1]?.[primary.key]) || 0);
    const min = typeof yDomain?.[0] === 'number' ? yDomain[0] : 0;
    const max = typeof yDomain?.[1] === 'number' ? yDomain[1] : Math.max(value * 1.15, min + 1);
    const unit = yLabel === '%' ? '%' : (yLabel ? ` ${yLabel}` : '');
    return <GaugeDial value={value} min={min} max={max} unit={unit} />;
  }
  if (type === 'gantt') {
    // A project timeline is a fundamentally different shape than every other
    // style here (a hierarchical task list with start/duration/dependencies,
    // not a time series or category breakdown) — `data` rows are read
    // directly as tasks rather than through xKey/series.
    return <GanttChart data={data} />;
  }
  if (type === 'bubble') {
    // Highcharts' Bubble-chart demo: X vs Y position plus a third dimension
    // as circle size, each point individually colored and labeled — not a
    // time series, so xKey/series[0].key here mean "the X field" and "the Y
    // field" for each row, same convention scatter already uses.
    const { sizeKey, labelKey, xThreshold, yThreshold, zoneLabel } = bubbleOpts;
    const primary = series[0];
    const zVals = data.map((d) => Number(d[sizeKey]) || 0);
    const zMax = Math.max(...zVals, 1);
    const hasZone = typeof xThreshold === 'number' && typeof yThreshold === 'number';
    const xVals = data.map((d) => Number(d[xKey]) || 0);
    const yVals = data.map((d) => Number(d[primary.key]) || 0);
    // Rounded up to a whole number — an un-rounded *1.08/*1.15 padding factor
    // produced long floating-point axis labels like "49.68000000000001".
    const xMax = Math.ceil(Math.max(...xVals, xThreshold || 0) * 1.08);
    const yMaxDomain = typeof yDomain?.[1] === 'number' ? yDomain[1] : Math.ceil(Math.max(...yVals, yThreshold || 0) * 1.15);
    // Palette color attached per row (not derived from a render-prop index —
    // see renderBubble's comment for why that broke).
    const coloredData = data.map((d, i) => ({ ...d, __bubbleColor: PIE_PALETTE[i % PIE_PALETTE.length] }));
    return (
      <ScatterChart margin={{ top: 20, right: 24, bottom: bottomMargin, left: 4 }}>
        <CartesianGrid strokeDasharray="3 3" opacity={0.15} />
        <XAxis type="number" dataKey={xKey} domain={[0, xMax]} tickFormatter={fmtAxisNum} {...sharedAxis} label={xAxisLabel} />
        <YAxis type="number" dataKey={primary.key} domain={[0, yMaxDomain]} tickFormatter={fmtAxisNum} {...sharedAxis} width={yLabel ? 46 : 36} label={yAxisLabel} />
        {/* Recharts resolves a ReferenceArea/ReferenceLine's pixel position
            from the XAxis/YAxis elements' already-built scales — declaring
            them BEFORE the axes (as they were previously) left them with no
            scale to resolve against, so they silently rendered nothing at
            all. They must come after the axis elements in the tree. */}
        {hasZone && (
          <>
            {/* An L-shaped "safe" region (below the Y threshold across the
                full width, plus left of the X threshold for everything
                above that) — one uniform shade throughout, matching the
                reference. Two independent full-span bands would overlap in
                the bottom-left corner and stack into a visibly darker
                square there, which the reference doesn't have. */}
            <ReferenceArea x1={0} x2={xMax} y1={0} y2={yThreshold} fill="#22c55e" fillOpacity={0.18} ifOverflow="visible" />
            <ReferenceArea x1={0} x2={xThreshold} y1={yThreshold} y2={yMaxDomain} fill="#22c55e" fillOpacity={0.18} ifOverflow="visible" />
            <ReferenceLine x={xThreshold} stroke="#16a34a" strokeOpacity={0.5} strokeDasharray="4 4" ifOverflow="visible"
              label={zoneLabel ? { value: zoneLabel, position: 'insideTopLeft', fill: '#16a34a', fontSize: 11, fontStyle: 'italic' } : undefined} />
            <ReferenceLine y={yThreshold} stroke="#16a34a" strokeOpacity={0.5} strokeDasharray="4 4" ifOverflow="visible"
              label={zoneLabel ? { value: zoneLabel, position: 'insideBottomRight', fill: '#16a34a', fontSize: 11, fontStyle: 'italic' } : undefined} />
          </>
        )}
        <Tooltip cursor={{ strokeDasharray: '3 3' }} formatter={(v, n) => [v, n === primary.key ? primary.label : n]} />
        <Scatter data={coloredData} shape={renderBubble(sizeKey, labelKey, zMax)} />
      </ScatterChart>
    );
  }
  if (type === 'pie' || type === 'donut') {
    if (xKey === 't') {
      // Genuine time series (no meaningful category to slice by) — compare
      // series' TOTAL contribution across the plotted window instead, one
      // slice per series, using the same colors as every other chart style.
      const slices = series.map((s) => ({
        name: s.label,
        value: data.reduce((sum, d) => sum + (Number(d[s.key]) || 0), 0),
        color: s.color,
      })).filter((s) => s.value > 0);
      return (
        <PieChart>
          <Pie data={slices} dataKey="value" nameKey="name"
            innerRadius={compact ? 0 : (type === 'donut' ? '55%' : 0)}
            outerRadius={compact ? '90%' : '85%'} paddingAngle={2}>
            {slices.map((s, i) => <Cell key={i} fill={s.color} />)}
          </Pie>
          {!compact && <Tooltip />}
        </PieChart>
      );
    }
    // Categorical data (Query Operations, Database Size Distribution, Top
    // Wait Events, etc.) — one slice PER CATEGORY using the primary series'
    // value, matching Highcharts' own Pie/Donut demos: a distinct color per
    // slice, a percentage badge in that same color near each slice, and the
    // category name on a matching connector line outside the pie. A pie
    // only ever visualizes one metric, so a second series (if passed) isn't
    // plotted — there's no meaningful second slice per category.
    const primary = series[0];
    const slices = data
      .map((d) => ({ name: d[xKey], value: Number(d[primary.key]) || 0 }))
      .filter((s) => s.value > 0)
      .sort((a, b) => b.value - a.value)
      .map((s, i) => ({ ...s, color: PIE_PALETTE[i % PIE_PALETTE.length] }));
    return (
      <PieChart>
        <Pie data={slices} dataKey="value" nameKey="name"
          innerRadius={compact ? 0 : (type === 'donut' ? '42%' : 0)}
          outerRadius={compact ? '90%' : '65%'} paddingAngle={1.5}
          labelLine={!compact && renderPieLabelLine(slices)}
          label={!compact && renderPieLabel(slices)}>
          {slices.map((s, i) => <Cell key={i} fill={s.color} />)}
        </Pie>
        {!compact && <Tooltip formatter={(v) => [v, primary.label]} />}
      </PieChart>
    );
  }
  if (type === 'scatter') {
    // Two series → correlation view (series[0] on X, series[1] on Y). One
    // series → that series' value over time, plotted as unconnected points.
    const [xSeries, ySeries] = series.length >= 2 ? series : [null, series[0]];
    const xDataKey = xSeries ? xSeries.key : xKey;
    return (
      <ScatterChart margin={{ bottom: bottomMargin }}>
        {!compact && <CartesianGrid strokeDasharray="3 3" opacity={0.15} />}
        <XAxis dataKey={xDataKey} {...sharedAxis} type="number" name={xSeries?.label || 'Time'} label={xAxisLabel} />
        <YAxis dataKey={ySeries?.key} domain={yDomain} {...sharedAxis} width={yLabel ? 46 : 32} type="number" name={ySeries?.label} label={yAxisLabel} />
        {!compact && <Tooltip cursor={{ strokeDasharray: '3 3' }} />}
        <Scatter data={data} fill={ySeries?.color || '#3f6fd6'} />
      </ScatterChart>
    );
  }
  if (type === 'bar') {
    // Grouped/clustered columns per category — Recharts renders multiple
    // <Bar> children side by side automatically, matching the reference's
    // Corn-vs-Wheat clustered-column layout with no extra work needed.
    return (
      <BarChart data={data} margin={{ bottom: bottomMargin }}>
        {!compact && <CartesianGrid strokeDasharray="3 3" opacity={0.15} vertical={false} />}
        <XAxis dataKey={xKey} {...sharedAxis} label={xAxisLabel} />
        {!compact && <YAxis domain={yDomain} {...sharedAxis} width={yLabel ? 46 : 36} tickFormatter={fmtAxisNum} label={yAxisLabel} />}
        {!compact && <Tooltip />}
        {series.map((s) => <Bar key={s.key} dataKey={s.key} fill={s.color} radius={[2, 2, 0, 0]} />)}
      </BarChart>
    );
  }
  if (type === 'barh') {
    // Horizontal grouped bars — categories down the Y-axis, values on X.
    // Each bar gets its value labeled at its end, and the legend floats as a
    // bordered box inside the plot area (top-right) instead of a row above
    // or below — matching the reference's horizontal Bar chart exactly.
    return (
      <BarChart data={data} layout="vertical" margin={{ top: 8, right: 46, left: 8, bottom: bottomMargin }}>
        {!compact && <CartesianGrid strokeDasharray="3 3" opacity={0.15} horizontal={false} />}
        <XAxis type="number" domain={yDomain} {...sharedAxis} tickFormatter={fmtAxisNum} label={xAxisLabel} />
        <YAxis type="category" dataKey={xKey} {...sharedAxis} width={76} />
        {!compact && <Tooltip />}
        {!compact && (
          <Legend verticalAlign="top" align="right" iconType="circle" iconSize={8}
            wrapperStyle={{
              position: 'absolute', top: 6, right: 10, fontSize: 11,
              background: 'rgba(255,255,255,0.96)', border: '1px solid #e2e8f0',
              borderRadius: 6, padding: '6px 10px',
            }} />
        )}
        {series.map((s) => (
          <Bar key={s.key} dataKey={s.key} fill={s.color} radius={[0, 2, 2, 0]} name={s.label}>
            {!compact && <LabelList dataKey={s.key} position="right" style={{ fontSize: 10, fontWeight: 700, fill: '#334155' }} formatter={fmtAxisNum} />}
          </Bar>
        ))}
      </BarChart>
    );
  }
  if (type === 'spark') {
    return (
      <LineChart data={data}>
        <XAxis hide dataKey={xKey} />
        {series.map((s) => (
          <Line key={s.key} type="monotone" dataKey={s.key} stroke={s.color} strokeWidth={1.5} dot={false} />
        ))}
      </LineChart>
    );
  }
  if (type === 'line') {
    // Solid primary series + dashed comparison series(es), each labeled
    // directly on the chart at its clearest point — mirrors Highcharts' own
    // line-chart + series-label demo rather than a generic Recharts line.
    // Extra top margin gives label text room above a series' peak.
    return (
      <LineChart data={data} margin={{ top: 22, right: 12, left: 0, bottom: bottomMargin }}>
        <CartesianGrid strokeDasharray="3 3" opacity={0.15} vertical={false} />
        <XAxis dataKey={xKey} {...sharedAxis} label={xAxisLabel} />
        <YAxis domain={yDomain} {...sharedAxis} width={yLabel ? 46 : 36} tickFormatter={fmtAxisNum} label={yAxisLabel} />
        <Tooltip />
        {series.map((s, idx) => (
          <Line key={s.key} type="monotone" dataKey={s.key} stroke={s.color} strokeWidth={2}
            strokeDasharray={idx > 0 ? '5 4' : undefined} dot={false}
            label={seriesLabel(s, bestLabelIndex(idx, series, data), data.length)} />
        ))}
      </LineChart>
    );
  }
  // area (default)
  return (
    <AreaChart data={data} margin={{ bottom: bottomMargin }}>
      <defs>
        {series.map((s) => (
          <linearGradient key={s.key} id={`grad-${uid}-${s.key}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={s.color} stopOpacity={0.35} />
            <stop offset="100%" stopColor={s.color} stopOpacity={0} />
          </linearGradient>
        ))}
      </defs>
      {!compact && <CartesianGrid strokeDasharray="3 3" opacity={0.15} vertical={false} />}
      <XAxis dataKey={xKey} {...sharedAxis} label={xAxisLabel} />
      {!compact && <YAxis domain={yDomain} {...sharedAxis} width={yLabel ? 46 : 36} tickFormatter={fmtAxisNum} label={yAxisLabel} />}
      {!compact && <Tooltip />}
      {series.map((s) => (
        <Area key={s.key} type="monotone" dataKey={s.key} stroke={s.color} fill={`url(#grad-${uid}-${s.key})`} strokeWidth={2} />
      ))}
    </AreaChart>
  );
}
