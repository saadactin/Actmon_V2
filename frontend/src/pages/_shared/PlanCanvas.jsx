/**
 * Interactive execution-plan canvas.
 *
 * A plan is a tree whose shape IS the explanation: where rows are fetched,
 * where they are joined, and which branch carries the cost. The previous
 * diagram drew that shape but gave no way to read a step's detail, and a plan
 * of any size ran off the side of the page.
 *
 * WHAT THESE NUMBERS ARE. Everything on screen comes from `v$sql_plan`, which
 * is the optimizer's plan rather than a record of the run: COST, CARDINALITY,
 * BYTES, CPU_COST and IO_COST are estimates made BEFORE the statement
 * executed. Oracle keeps actual per-step figures in
 * `v$sql_plan_statistics_all`, and only when the statement ran under
 * STATISTICS_LEVEL=ALL or a gather_plan_statistics hint — this payload has
 * none of them. So no node shows an elapsed time or a share of runtime: there
 * is no honest source for either, and a figure captioned "Time" that is
 * really an estimate is worse than an empty row. Every estimate is labelled
 * as one, on the card and in the panel.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import Icon from '@/components/ui/Icon';
import { cn } from '@/lib/cn';

import {
  GAP_X, GAP_Y, NODE_H, NODE_W,
  buildPlanGraph, edgePath, fitScale, layoutTree,
} from './planLayout';
import './planCanvas.css';

const ZOOM_MIN = 0.2;
const ZOOM_MAX = 2.5;
const MINIMAP_W = 168;
const MINIMAP_H = 104;

const KINDS = [
  { id: 'operation', label: 'Operation' },
  { id: 'access', label: 'Access' },
  { id: 'join', label: 'Join' },
  { id: 'filter', label: 'Filter' },
  { id: 'sort', label: 'Sort / Group' },
];

const fmt = new Intl.NumberFormat();
const n = (v) => (v === null || v === undefined ? null : fmt.format(v));
const pctOf = (share) => (share == null ? null : `${(share * 100).toFixed(1)}%`);

/* ── one plan step ───────────────────────────────────────────────────── */

function PlanNodeCard({ placed, selected, onSelect }) {
  const d = placed.node;
  return (
    <button
      type="button"
      className="pc-node"
      data-kind={d.kind}
      data-severity={d.severity || undefined}
      data-selected={selected || undefined}
      style={{ left: placed.x, top: placed.y, width: placed.w, height: placed.h }}
      onClick={(e) => { e.stopPropagation(); onSelect(d.id); }}
      title={`${d.label}${d.objectName ? ` · ${d.objectName}` : ''}`}
    >
      <span className="flex items-center gap-1.5">
        <span className="pc-id">{d.id}</span>
        <span className="truncate-safe text-[11.5px] font-black leading-tight text-fg">{d.label}</span>
      </span>
      {d.objectName && (
        <span className="truncate-safe font-mono text-[10.5px] leading-tight text-muted">
          {d.objectOwner ? `${d.objectOwner}.` : ''}{d.objectName}
        </span>
      )}
      <span className="mt-auto flex items-center gap-2 text-[10px] font-semibold text-muted">
        <span>Cost {d.cost == null ? '—' : n(d.cost)}</span>
        <span>Rows {d.cardinality == null ? '—' : n(d.cardinality)}</span>
        {d.costShare != null && <span className="ml-auto tabular-nums">{pctOf(d.costShare)}</span>}
      </span>
    </button>
  );
}

/* ── details panel ───────────────────────────────────────────────────── */

function Row({ label, value, mono }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border py-1.5 last:border-0">
      <span className="shrink-0 text-[12px] text-muted">{label}</span>
      <span className={cn('min-w-0 break-words text-right text-[12px] font-semibold text-fg', mono && 'font-mono')}>
        {value === null || value === undefined || value === '' ? <span className="text-subtle">—</span> : value}
      </span>
    </div>
  );
}

function DetailsPanel({ node, planCost, onClose }) {
  const [tab, setTab] = useState('details');
  useEffect(() => { setTab('details'); }, [node?.id]);

  if (!node) {
    return (
      <aside className="rounded-2xl border border-border bg-surface p-card">
        <h4 className="text-[14px] font-black text-fg">Operation details</h4>
        <p className="mt-1.5 text-[12px] text-muted">
          Select a step in the diagram to see everything <code className="font-mono">v$sql_plan</code> reports for it.
        </p>
      </aside>
    );
  }

  const TABS = [
    { id: 'details', label: 'Details' },
    { id: 'predicate', label: 'Predicate' },
    { id: 'columns', label: 'Columns' },
    { id: 'statistics', label: 'Statistics' },
  ];

  return (
    <aside className="flex min-h-0 flex-col rounded-2xl border border-border bg-surface">
      <header className="flex items-start gap-2 border-b border-border px-card py-3">
        <div className="min-w-0 flex-1">
          <h4 className="text-[14px] font-black text-fg">Operation details</h4>
          <p className="mt-0.5 text-[11px] text-subtle">Step {node.id} of this execution plan</p>
        </div>
        {onClose && (
          <button type="button" onClick={onClose} aria-label="Clear selection"
            className="shrink-0 rounded-control p-1 text-muted hover:bg-sunken hover:text-fg">
            <Icon name="close" size={14} />
          </button>
        )}
      </header>

      <div className="flex items-center gap-2 border-b border-border px-card py-2.5">
        <span className="pc-id" data-kind={node.kind} style={{ background: 'var(--border-strong)' }}>{node.id}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate-safe text-[13px] font-black text-fg">{node.label}</span>
          {node.objectName && (
            <span className="block truncate-safe font-mono text-[11px] text-muted">
              {node.objectOwner ? `${node.objectOwner}.` : ''}{node.objectName}
            </span>
          )}
        </span>
        {node.severity && (
          <span className={cn(
            'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold capitalize',
            node.severity === 'critical' ? 'bg-danger-soft text-danger-fg' : 'bg-warning-soft text-warning-fg',
          )}>
            {node.severity}
          </span>
        )}
      </div>

      <nav className="flex gap-1 border-b border-border px-card py-1.5">
        {TABS.map((t) => (
          <button key={t.id} type="button" onClick={() => setTab(t.id)}
            className={cn(
              'rounded-control px-2.5 py-1 text-[12px] font-semibold transition-colors',
              tab === t.id ? 'bg-accent-soft text-accent-text' : 'text-muted hover:bg-sunken',
            )}>
            {t.label}
          </button>
        ))}
      </nav>

      <div className="min-h-0 flex-1 overflow-auto px-card py-2.5">
        {tab === 'details' && (
          <>
            <Row label="Operation id" value={node.id} />
            <Row label="Operation" value={node.operation || null} />
            <Row label="Options" value={node.options || null} />
            <Row label="Object name" value={node.objectName} mono />
            <Row label="Object owner" value={node.objectOwner} mono />
            <Row label="Object type" value={node.objectType} />
            <Row label="Depth" value={node.depth} />
            <Row label="Parent step" value={node.parentId === null ? null : node.parentId} />
            <Row label="Child steps" value={node.children.length || null} />
          </>
        )}

        {tab === 'predicate' && (
          <>
            {!node.accessPredicates && !node.filterPredicates ? (
              <p className="text-[12px] text-muted">
                This step reports no access or filter predicate. That is normal for
                steps that do not test a condition — a sort or a join's parent, for
                instance — and is not a gap in the data.
              </p>
            ) : (
              <>
                <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-subtle">Access predicate</p>
                <pre className="mb-3 overflow-auto rounded-control bg-sunken p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words text-fg">
                  {node.accessPredicates || '—'}
                </pre>
                <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-subtle">Filter predicate</p>
                <pre className="overflow-auto rounded-control bg-sunken p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words text-fg">
                  {node.filterPredicates || '—'}
                </pre>
              </>
            )}
          </>
        )}

        {tab === 'columns' && (
          /* v$sql_plan has a PROJECTION column, but this endpoint does not
             select it, so there is nothing to show. Saying so beats an empty
             panel that looks like a step with no columns. */
          <p className="text-[12px] text-muted">
            Per-step column projection is not part of this plan payload. It lives in
            <code className="mx-1 font-mono">v$sql_plan.projection</code>, which this
            endpoint does not read — so nothing is shown here rather than something
            inferred.
            {node.objectName && (
              <>
                {' '}The object this step touches is{' '}
                <span className="font-mono text-fg">
                  {node.objectOwner ? `${node.objectOwner}.` : ''}{node.objectName}
                </span>.
              </>
            )}
          </p>
        )}

        {tab === 'statistics' && (
          <>
            <p className="mb-2 rounded-control bg-sunken px-2.5 py-2 text-[11px] leading-snug text-muted">
              Every figure below is the optimizer&rsquo;s <strong>estimate</strong>, made
              before the statement ran. Actual per-step rows and timings live in
              <code className="mx-1 font-mono">v$sql_plan_statistics_all</code> and exist only
              when the statement ran with <code className="font-mono">STATISTICS_LEVEL=ALL</code>
              {' '}or a <code className="font-mono">gather_plan_statistics</code> hint. None are
              in this payload, so none are shown.
            </p>
            <Row label="Cost (estimated)" value={n(node.cost)} />
            <Row label="Share of plan cost" value={pctOf(node.costShare)} />
            <Row label="Cardinality (estimated rows)" value={n(node.cardinality)} />
            <Row label="Bytes (estimated)" value={n(node.bytes)} />
            <Row label="CPU cost (estimated)" value={n(node.cpuCost)} />
            <Row label="IO cost (estimated)" value={n(node.ioCost)} />
            <Row label="Plan total cost" value={n(planCost)} />
            <p className="mt-2 text-[11px] leading-snug text-subtle">
              Oracle&rsquo;s COST is cumulative: a step&rsquo;s cost already contains its
              children&rsquo;s. The share above therefore reads as &ldquo;how much of the
              plan this branch accounts for&rdquo;, not &ldquo;what this one step added&rdquo;.
            </p>
          </>
        )}
      </div>
    </aside>
  );
}

/* ── the canvas ──────────────────────────────────────────────────────── */

/**
 * @param selectedId / onSelect  optional, for when the selection is shared —
 *   the Execution Plan page keeps one selection across its diagram and its
 *   table, so clicking a row highlights the node and vice versa. Left out, the
 *   canvas keeps its own.
 */
export default function PlanCanvas({ rows, selectedId, onSelect }) {
  const stageRef = useRef(null);
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  const [ownSelected, setOwnSelected] = useState(null);
  const controlled = onSelect !== undefined;
  const selected = controlled ? selectedId : ownSelected;
  const setSelected = controlled ? onSelect : setOwnSelected;
  const [panning, setPanning] = useState(false);
  const dragRef = useRef(null);
  const fittedRef = useRef(false);

  const graph = useMemo(() => buildPlanGraph(rows), [rows]);
  const layout = useMemo(
    () => (graph ? layoutTree(graph.root, { nodeW: NODE_W, nodeH: NODE_H, gapX: GAP_X, gapY: GAP_Y })
      : { nodes: [], edges: [], width: 0, height: 0 }),
    [graph],
  );
  const placedById = useMemo(
    () => new Map(layout.nodes.map((p) => [p.node.id, p])),
    [layout],
  );

  const fit = useCallback(() => {
    const el = stageRef.current;
    if (!el || !layout.width) return;
    const box = el.getBoundingClientRect();
    const scale = fitScale(layout, { width: box.width, height: box.height }, { pad: 28, max: 1 });
    setView({
      scale,
      x: (box.width - layout.width * scale) / 2,
      y: (box.height - layout.height * scale) / 2,
    });
  }, [layout]);

  const centre = useCallback(() => {
    const el = stageRef.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    setView((v) => ({
      ...v,
      x: (box.width - layout.width * v.scale) / 2,
      y: (box.height - layout.height * v.scale) / 2,
    }));
  }, [layout]);

  // Fit once the stage has a real size, so the plan is never clipped on load.
  useLayoutEffect(() => {
    fittedRef.current = false;
  }, [layout]);
  useLayoutEffect(() => {
    if (fittedRef.current || !layout.width) return;
    const el = stageRef.current;
    if (!el || !el.getBoundingClientRect().width) return;
    fittedRef.current = true;
    fit();
  });

  // Refit on resize, but only the zoom-to-fit case — a user who has zoomed in
  // should not have it taken away by a window resize.
  useEffect(() => {
    const el = stageRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => { if (fittedRef.current) centre(); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [centre]);

  const zoomBy = useCallback((factor, originX, originY) => {
    const el = stageRef.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    const ox = originX ?? box.width / 2;
    const oy = originY ?? box.height / 2;
    setView((v) => {
      const scale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v.scale * factor));
      if (scale === v.scale) return v;
      // Keep the point under the cursor fixed while the scale changes.
      const k = scale / v.scale;
      return { scale, x: ox - (ox - v.x) * k, y: oy - (oy - v.y) * k };
    });
  }, []);

  // Wheel zoom. Registered natively because React's onWheel is passive, and a
  // passive listener cannot preventDefault — so the page would scroll too.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return undefined;
    const onWheel = (e) => {
      if (e.ctrlKey || e.metaKey || !e.deltaX) {
        e.preventDefault();
        const box = el.getBoundingClientRect();
        zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - box.left, e.clientY - box.top);
      } else {
        // A trackpad's two-finger swipe pans rather than zooms.
        e.preventDefault();
        setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomBy]);

  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    dragRef.current = { px: e.clientX, py: e.clientY, x: view.x, y: view.y };
    setPanning(true);
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    setView((v) => ({ ...v, x: d.x + (e.clientX - d.px), y: d.y + (e.clientY - d.py) }));
  };
  const endPan = (e) => {
    dragRef.current = null;
    setPanning(false);
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  if (!graph) {
    return (
      <p className="text-[12px] text-subtle">
        Nothing to diagram — <code className="font-mono">v$sql_plan</code> returned no rows for this
        sql_id. It may have aged out of the shared pool.
      </p>
    );
  }

  const selectedNode = selected == null ? null : graph.byId.get(selected);
  const miniScale = Math.min(
    (MINIMAP_W - 8) / Math.max(layout.width, 1),
    (MINIMAP_H - 8) / Math.max(layout.height, 1),
  );
  const stageBox = stageRef.current?.getBoundingClientRect();

  return (
    <div className="pc-wrap">
      <div
        ref={stageRef}
        className="pc-stage"
        data-panning={panning}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPan}
        onPointerCancel={endPan}
        onClick={() => setSelected(null)}
      >
        {/* ── toolbar ── */}
        <div className="pc-toolbar flex items-center gap-0.5 px-1 py-1" onPointerDown={(e) => e.stopPropagation()}>
          {[
            { icon: 'plus', label: 'Zoom in', fn: () => zoomBy(1.2) },
            { icon: 'minus', label: 'Zoom out', fn: () => zoomBy(1 / 1.2) },
          ].map((b) => (
            <button key={b.label} type="button" onClick={b.fn} aria-label={b.label} title={b.label}
              className="grid h-7 w-7 place-items-center rounded-control text-muted hover:bg-sunken hover:text-fg">
              <Icon name={b.icon} size={14} />
            </button>
          ))}
          <span className="min-w-[48px] px-1 text-center text-[11px] font-bold tabular-nums text-fg">
            {Math.round(view.scale * 100)}%
          </span>
          {[
            { icon: 'expand', label: 'Fit', fn: fit },
            { icon: 'restart', label: 'Reset', fn: () => { fittedRef.current = true; fit(); setSelected(null); } },
            { icon: 'crosshair', label: 'Centre', fn: centre },
          ].map((b) => (
            <button key={b.label} type="button" onClick={b.fn} title={b.label}
              className="flex h-7 items-center gap-1 rounded-control px-2 text-[11px] font-semibold text-muted hover:bg-sunken hover:text-fg">
              <Icon name={b.icon} size={13} />
              {b.label}
            </button>
          ))}
        </div>

        {/* Said once, where it is read once — rather than stamped on all
            fourteen cards, which is what pushed the object name into the
            metrics row. */}
        <p className="pc-caption" onPointerDown={(e) => e.stopPropagation()}>
          Cost and row counts are optimizer <strong>estimates</strong> from v$sql_plan, not measurements
        </p>

        {/* ── legend ── */}
        <div className="pc-legend flex flex-wrap items-center gap-x-3 gap-y-1 px-2.5 py-1.5" onPointerDown={(e) => e.stopPropagation()}>
          {KINDS.map((k) => (
            <span key={k.id} className="flex items-center gap-1.5 text-[10.5px] font-semibold text-muted">
              <span className="pc-swatch" data-kind={k.id} />
              {k.label}
            </span>
          ))}
          {[['warning', 'Warning'], ['critical', 'Critical']].map(([sev, label]) => (
            <span key={sev} className="flex items-center gap-1.5 text-[10.5px] font-semibold text-muted">
              <span className="pc-swatch" data-severity={sev} />
              {label}
            </span>
          ))}
        </div>

        {/* ── the plan ── */}
        <div
          className="pc-canvas"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`, width: layout.width, height: layout.height }}
        >
          <svg className="pc-edges" width={layout.width} height={layout.height} aria-hidden="true">
            {layout.edges.map((e) => {
              const p = placedById.get(e.from);
              const c = placedById.get(e.to);
              if (!p || !c) return null;
              return (
                <path
                  key={`${e.from}-${e.to}`}
                  className="pc-edge"
                  data-severity={c.node.severity || undefined}
                  d={edgePath(p, c)}
                />
              );
            })}
          </svg>
          {layout.nodes.map((p) => (
            <PlanNodeCard
              key={p.node.id}
              placed={p}
              selected={p.node.id === selected}
              onSelect={setSelected}
            />
          ))}
        </div>

        {/* ── minimap ── */}
        {layout.nodes.length > 4 && (
          <div
            className="pc-minimap"
            style={{ width: MINIMAP_W, height: MINIMAP_H }}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              const box = e.currentTarget.getBoundingClientRect();
              const stage = stageRef.current?.getBoundingClientRect();
              if (!stage) return;
              // Centre the stage on the point clicked in the minimap.
              const cx = (e.clientX - box.left - 4) / miniScale;
              const cy = (e.clientY - box.top - 4) / miniScale;
              setView((v) => ({ ...v, x: stage.width / 2 - cx * v.scale, y: stage.height / 2 - cy * v.scale }));
            }}
          >
            {layout.nodes.map((p) => (
              <span
                key={p.node.id}
                className="pc-mini-node"
                data-severity={p.node.severity || undefined}
                style={{
                  left: 4 + p.x * miniScale,
                  top: 4 + p.y * miniScale,
                  width: Math.max(2, p.w * miniScale),
                  height: Math.max(2, p.h * miniScale),
                }}
              />
            ))}
            {stageBox && (
              <span
                className="pc-mini-view"
                style={{
                  left: 4 + (-view.x / view.scale) * miniScale,
                  top: 4 + (-view.y / view.scale) * miniScale,
                  width: (stageBox.width / view.scale) * miniScale,
                  height: (stageBox.height / view.scale) * miniScale,
                }}
              />
            )}
          </div>
        )}
      </div>

      <DetailsPanel node={selectedNode} planCost={graph.planCost} onClose={() => setSelected(null)} />
    </div>
  );
}
