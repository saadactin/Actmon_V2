/**
 * Shared indicator component used by every engine dashboard's Host Resources /
 * KPI cards. Renders one of 4 visual templates (ring / stat / donut / minimal)
 * driven by the user's saved DashboardAppearanceContext preference — change it
 * once in Settings, every dashboard updates. `styleOverride` forces a specific
 * template regardless of context (used by the Settings preview cards).
 */
import React, { useRef, useEffect, useReducer } from 'react';
import { ChevronRight } from 'lucide-react';
import { useDashboardAppearance } from '../../context/DashboardAppearanceContext';
import TrendChart from './TrendChart';

export const colorFor = (pct, colorFn) => {
  if (colorFn) return colorFn(pct);
  return pct == null ? '#94a3b8' : pct >= 85 ? '#ef4444' : pct >= 60 ? '#f59e0b' : '#22c55e';
};
const fmtPct = (v) => (v == null ? '—' : `${v}%`);

const GAUGE_START = 135;   // degrees; 270° sweep, gap centered at the bottom
const GAUGE_SWEEP = 270;
const GAUGE_BANDS = [
  { from: 0,  to: 60,  color: '#22c55e' },
  { from: 60, to: 85,  color: '#f59e0b' },
  { from: 85, to: 100, color: '#ef4444' },
];
function polarPoint(cx, cy, r, angleDeg) {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}
function gaugeArcPath(cx, cy, r, startAngle, endAngle) {
  const start = polarPoint(cx, cy, r, startAngle);
  const end = polarPoint(cx, cy, r, endAngle);
  const largeArc = endAngle - startAngle > 180 ? 1 : 0;
  return `M ${start.x},${start.y} A ${r},${r} 0 ${largeArc} 1 ${end.x},${end.y}`;
}
function sparkPath(vals, w, h, pad = 2) {
  if (!vals || vals.length < 2) return null;
  const max = Math.max(...vals, 1), min = Math.min(...vals);
  const range = max - min || 1;
  return vals.map((v, i) => {
    const x = pad + (i / (vals.length - 1)) * (w - pad * 2);
    const y = h - pad - ((v - min) / range) * (h - pad * 2);
    return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(' ');
}

function RingGauge({ icon: Icon, label, pct, sub, onClick, colorFn }) {
  const value = pct == null ? 0 : Math.max(0, Math.min(100, pct));
  const c = colorFor(pct, colorFn);
  const statusKey = pct == null ? null : pct >= 85 ? 'Critical' : pct >= 60 ? 'Elevated' : 'Normal';
  const cx = 100, cy = 100, r = 80;
  const valueAngle = GAUGE_START + (value / 100) * GAUGE_SWEEP;

  return (
    <button onClick={onClick}
      className="group relative w-full bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-4 text-left shadow-sm hover:shadow-xl hover:-translate-y-0.5 transition-all flex flex-col items-center gap-1.5">
      <div className="flex items-center justify-between w-full">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-black text-slate-400 uppercase tracking-wider">
          {Icon && <Icon size={14} />} {label}
        </span>
        {statusKey && (
          <span className="text-[9.5px] font-black px-2 py-0.5 rounded uppercase tracking-wide"
            style={{ background: `${c}1a`, color: c }}>{statusKey}</span>
        )}
      </div>

      <div className="relative" style={{ width: 148, height: 148 }}>
        <svg viewBox="0 0 200 200" className="w-full h-full">
          {GAUGE_BANDS.map((band) => {
            const a0 = GAUGE_START + (band.from / 100) * GAUGE_SWEEP;
            const a1 = GAUGE_START + (band.to / 100) * GAUGE_SWEEP;
            return <path key={band.from} d={gaugeArcPath(cx, cy, r, a0, a1)} fill="none" stroke={band.color} strokeWidth="13" opacity="0.25" />;
          })}
          <path d={gaugeArcPath(cx, cy, r, GAUGE_START, valueAngle)} fill="none" stroke={c} strokeWidth="13" strokeLinecap="round" />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center pt-1">
          <span className="font-mono tabular-nums text-[26px] font-black leading-none" style={{ color: c }}>{fmtPct(pct)}</span>
        </div>
      </div>

      {sub && <p className="text-[11px] text-slate-400 text-center -mt-1 px-2">{sub}</p>}
      {onClick && (
        <span className="text-[10.5px] font-bold text-indigo-600 opacity-0 group-hover:opacity-100 transition-opacity absolute bottom-3 right-3 flex items-center gap-1">
          drill in <ChevronRight size={11} />
        </span>
      )}
    </button>
  );
}

function StatTileGauge({ icon: Icon, label, pct, sub, onClick, colorFn, spark }) {
  const c = colorFor(pct, colorFn);
  const path = sparkPath(spark, 140, 28);
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag onClick={onClick}
      className="group relative w-full text-left bg-slate-50 dark:bg-slate-800/60 rounded-xl border-l-[3px] p-3.5 hover:shadow-md transition-shadow"
      style={{ borderLeftColor: c }}>
      <div className="flex items-center gap-1.5 text-[10px] font-black text-slate-400 uppercase tracking-wider mb-1.5">
        {Icon && <Icon size={12} />} {label}
      </div>
      <div className="font-mono tabular-nums text-2xl font-black leading-none" style={{ color: c }}>{fmtPct(pct)}</div>
      {path && (
        <svg width="100%" height="26" viewBox="0 0 140 28" preserveAspectRatio="none" className="mt-2 block">
          <path d={path} fill="none" stroke={c} strokeWidth="1.6" />
        </svg>
      )}
      {sub && <p className="text-[10.5px] text-slate-400 mt-1.5">{sub}</p>}
      {onClick && (
        <span className="text-[10px] font-bold text-indigo-600 opacity-0 group-hover:opacity-100 transition-opacity absolute top-3 right-3">
          <ChevronRight size={12} />
        </span>
      )}
    </Tag>
  );
}

function DonutGauge({ icon: Icon, label, pct, sub, onClick, colorFn }) {
  const value = pct == null ? 0 : Math.max(0, Math.min(100, pct));
  const c = colorFor(pct, colorFn);
  const size = 148, r = size * 0.36, cx = size / 2, cy = size / 2, circ = 2 * Math.PI * r;
  const dash = (value / 100) * circ;
  return (
    <button onClick={onClick}
      className="group relative w-full bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-4 text-left shadow-sm hover:shadow-xl hover:-translate-y-0.5 transition-all flex flex-col items-center gap-1.5">
      <span className="inline-flex items-center gap-1.5 text-[11px] font-black text-slate-400 uppercase tracking-wider self-start">
        {Icon && <Icon size={14} />} {label}
      </span>
      <div className="relative" style={{ width: size, height: size }}>
        <svg viewBox={`0 0 ${size} ${size}`} className="w-full h-full">
          <circle cx={cx} cy={cy} r={r} stroke="currentColor" className="text-slate-200 dark:text-slate-700" strokeWidth="10" fill="none" />
          <circle cx={cx} cy={cy} r={r} stroke={c} strokeWidth="10" fill="none" strokeLinecap="round"
            strokeDasharray={`${dash} ${circ}`} transform={`rotate(-90 ${cx} ${cy})`} />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="font-mono tabular-nums text-[24px] font-black leading-none" style={{ color: c }}>{fmtPct(pct)}</span>
        </div>
      </div>
      {sub && <p className="text-[11px] text-slate-400 text-center -mt-1 px-2">{sub}</p>}
      {onClick && (
        <span className="text-[10.5px] font-bold text-indigo-600 opacity-0 group-hover:opacity-100 transition-opacity absolute bottom-3 right-3 flex items-center gap-1">
          drill in <ChevronRight size={11} />
        </span>
      )}
    </button>
  );
}

function MinimalGauge({ icon: Icon, label, pct, sub, onClick, colorFn }) {
  const c = colorFor(pct, colorFn);
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag onClick={onClick} className="group relative w-full text-left p-3">
      <div className="flex items-center gap-1.5 mb-1.5">
        <span className="w-[7px] h-[7px] rounded-full flex-shrink-0" style={{ background: c }} />
        <span className="text-[10.5px] font-bold text-slate-500 dark:text-slate-400 inline-flex items-center gap-1">
          {Icon && <Icon size={12} />} {label}
        </span>
      </div>
      <div className="font-mono tabular-nums text-[26px] font-black leading-none" style={{ color: c }}>
        {pct == null ? '—' : pct}<span className="text-[13px] text-slate-400 dark:text-slate-500">%</span>
      </div>
      {sub && <p className="text-[10.5px] text-slate-400 mt-1">{sub}</p>}
      {onClick && (
        <span className="text-[10px] font-bold text-indigo-600 opacity-0 group-hover:opacity-100 transition-opacity absolute top-3 right-3">
          <ChevronRight size={12} />
        </span>
      )}
    </Tag>
  );
}

/* Graph display mode — instead of a snapshot indicator, shows this metric's
   own recent history as a trend chart (in whichever chart style is active).
   `history` is a rolling in-memory buffer the parent <Gauge> accumulates from
   live `pct` updates; `historyOverride` lets previews (Settings gallery) supply
   fixed sample data instead of waiting for real re-renders to build history. */
function GraphGauge({ icon: Icon, label, pct, sub, colorFn, history, chartStyleOverride }) {
  const c = colorFor(pct, colorFn);
  const data = history.length >= 2 ? history : [{ t: 0, v: pct ?? 0 }, { t: 1, v: pct ?? 0 }];
  return (
    <div className="w-full bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-4 shadow-sm">
      <div className="flex items-center justify-between mb-2">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-black text-slate-400 uppercase tracking-wider">
          {Icon && <Icon size={14} />} {label}
        </span>
        <span className="font-mono tabular-nums text-lg font-black" style={{ color: c }}>{fmtPct(pct)}</span>
      </div>
      <TrendChart data={data} xKey="t" height={72} showLegend={false} yDomain={[0, 100]}
        styleOverride={chartStyleOverride}
        series={[{ key: 'v', label, color: c }]} />
      {sub && <p className="text-[10.5px] text-slate-400 mt-1.5">{sub}</p>}
      {history.length < 3 && <p className="text-[10px] text-slate-300 mt-1">Building history…</p>}
    </div>
  );
}

const RENDERERS = { ring: RingGauge, stat: StatTileGauge, donut: DonutGauge, minimal: MinimalGauge };
const MAX_HISTORY = 30;

export default function Gauge({ styleOverride, displayModeOverride, historyOverride, chartStyleOverride, ...props }) {
  const { indicatorStyle, displayMode } = useDashboardAppearance();
  const mode = displayModeOverride || displayMode;
  const historyRef = useRef([]);
  const [, bump] = useReducer((x) => x + 1, 0);

  useEffect(() => {
    if (historyOverride || props.pct == null) return;
    const arr = historyRef.current;
    const lastVal = arr.length ? arr[arr.length - 1].v : undefined;
    if (lastVal === props.pct) return;
    arr.push({ t: arr.length, v: props.pct });
    if (arr.length > MAX_HISTORY) arr.shift();
    bump();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.pct, historyOverride]);

  if (mode === 'graph') {
    return <GraphGauge {...props} history={historyOverride || historyRef.current} chartStyleOverride={chartStyleOverride} />;
  }
  const Renderer = RENDERERS[styleOverride || indicatorStyle] || RingGauge;
  return <Renderer {...props} />;
}
