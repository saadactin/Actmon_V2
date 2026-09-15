import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
} from 'react';
import { ZoomIn, ZoomOut, Maximize2, Crosshair, Map as MapIcon } from 'lucide-react';
import Icon from '@/components/ui/Icon';
import IconButton from '@/components/ui/IconButton';
import { Spinner } from '@/components/ui/Loading';
import {
  CARD_H, CARD_W, MARGIN_Y, boundsOf, computeLayout, fitTo,
} from '../utils/topologyLayout';
import { clip, edgeStyle, healthMeta, providerMeta, typeMeta } from '../utils/topologyModel';

/**
 * The topology canvas.
 *
 * ## Only what is on screen is rendered
 *
 * A 1,600-node account is 1,600 SVG groups of five elements each, and React
 * reconciles all of them on every pan frame. So nodes and edges outside the
 * viewport (plus a margin) are culled before render. The cull is recomputed
 * from pan/zoom, which changes on drag — but the arithmetic is a bounds check
 * per node, which is nothing next to laying out the elements.
 *
 * ## Selection versus spotlight
 *
 * Unrelated nodes are dimmed, never hidden. This is deliberate and is kept
 * from the original implementation: hiding them would lose the context that
 * tells you where in the account you are looking, and a graph that changes
 * shape when you click it is disorienting.
 *
 * ## Dragging changes the view, not the graph
 *
 * A dragged position is an override stored per scope in localStorage and
 * applied on top of the computed layout. The nodes and edges are untouched, so
 * no amount of rearranging can make the topology assert something different.
 */
export default function TopologyCanvas({
  nodes,
  edges,
  layout = 'architecture',
  selectedNodeId,
  selectedEdgeId,
  onSelectNode,
  onSelectEdge,
  onOpenNode,
  onExpandCluster,
  highlightPath,
  loading,
  emptyState,
  showMinimap = true,
  positionOverrides,
  onMoveNode,
  onResetPositions,
  fitSignal,
}) {
  const canvasRef = useRef(null);
  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  const [zoom, setZoom] = useState(0.8);
  const [pan, setPan] = useState({ x: 60, y: 56 });
  const [hoveredNodeId, setHoveredNodeId] = useState(null);
  const [hoveredEdgeId, setHoveredEdgeId] = useState(null);
  const [minimapOn, setMinimapOn] = useState(showMinimap);

  // Pan drag (background) and node drag are separate gestures with separate
  // state, so releasing one can never leave the other half-engaged.
  const [panning, setPanning] = useState(false);
  const panStart = useRef({ x: 0, y: 0, px: 0, py: 0 });
  const dragMoved = useRef(false);
  const nodeDrag = useRef(null);
  const [draggingNodeId, setDraggingNodeId] = useState(null);

  /* ── layout ─────────────────────────────────────────────────────────────── */
  const { positions, width, height, lanes } = useMemo(
    () => computeLayout({
      layout,
      nodes,
      edges,
      focusId: selectedNodeId,
      overrides: positionOverrides,
    }),
    [layout, nodes, edges, selectedNodeId, positionOverrides],
  );

  const nodeById = useMemo(() => {
    const map = new Map();
    nodes.forEach((n) => map.set(n.id, n));
    return map;
  }, [nodes]);

  /* ── viewport measurement ───────────────────────────────────────────────── */
  useLayoutEffect(() => {
    const element = canvasRef.current;
    if (!element) return undefined;
    const measure = () => setViewport({ w: element.clientWidth, h: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  /* ── zoom on wheel (non-passive so the page never scrolls) ──────────────── */
  useEffect(() => {
    const element = canvasRef.current;
    if (!element) return undefined;
    const onWheel = (event) => {
      event.preventDefault();
      const factor = 1.08;
      // Zoom about the pointer, not the origin, so the thing under the cursor
      // stays under the cursor — zooming to a corner is disorienting on a
      // graph this wide.
      const rect = element.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      setZoom((previous) => {
        const next = Math.max(0.08, Math.min(3, event.deltaY < 0 ? previous * factor : previous / factor));
        setPan((current) => ({
          x: px - ((px - current.x) * next) / previous,
          y: py - ((py - current.y) * next) / previous,
        }));
        return next;
      });
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, []);

  /* ── fit helpers ────────────────────────────────────────────────────────── */
  const fitAll = useCallback(() => {
    const bounds = boundsOf(positions);
    const result = fitTo(bounds, viewport.w, viewport.h);
    if (result) { setZoom(result.zoom); setPan(result.pan); }
  }, [positions, viewport]);

  const fitSelection = useCallback(() => {
    if (!selectedNodeId) { fitAll(); return; }
    const ids = [selectedNodeId];
    edges.forEach((edge) => {
      if (edge.source === selectedNodeId) ids.push(edge.target);
      if (edge.target === selectedNodeId) ids.push(edge.source);
    });
    const result = fitTo(boundsOf(positions, ids), viewport.w, viewport.h, { maxZoom: 1.1 });
    if (result) { setZoom(result.zoom); setPan(result.pan); }
  }, [selectedNodeId, edges, positions, viewport, fitAll]);

  // Fit once the graph and the viewport are both known, and whenever the
  // parent bumps `fitSignal` (layout change, scope change, "fit" button).
  const fitted = useRef(null);
  useEffect(() => {
    if (!viewport.w || !nodes.length) return;
    const key = `${fitSignal}|${layout}|${nodes.length}`;
    if (fitted.current === key) return;
    fitted.current = key;
    fitAll();
  }, [fitSignal, layout, nodes.length, viewport.w, fitAll]);

  const centreOn = useCallback((nodeId) => {
    const position = positions[nodeId];
    if (!position || !viewport.w) return;
    setPan({ x: viewport.w / 2 - position.x * zoom, y: viewport.h / 2 - position.y * zoom });
  }, [positions, viewport, zoom]);

  useEffect(() => {
    if (selectedNodeId && positions[selectedNodeId]) {
      const position = positions[selectedNodeId];
      const screenX = position.x * zoom + pan.x;
      const screenY = position.y * zoom + pan.y;
      // Only recentre when the selection is off screen. Recentring every
      // selection would yank the canvas when the user clicks a node they can
      // already see, which is most clicks.
      if (screenX < 0 || screenY < 0 || screenX > viewport.w || screenY > viewport.h) {
        centreOn(selectedNodeId);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedNodeId]);

  /* ── pointer handling ───────────────────────────────────────────────────── */
  const onBackgroundDown = useCallback((event) => {
    if (event.button !== 0) return;
    dragMoved.current = false;
    panStart.current = { x: event.clientX, y: event.clientY, px: pan.x, py: pan.y };
    setPanning(true);
  }, [pan]);

  const onPointerMove = useCallback((event) => {
    if (nodeDrag.current) {
      const dx = (event.clientX - nodeDrag.current.startX) / zoom;
      const dy = (event.clientY - nodeDrag.current.startY) / zoom;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) dragMoved.current = true;
      onMoveNode?.(nodeDrag.current.id, {
        x: nodeDrag.current.originX + dx,
        y: nodeDrag.current.originY + dy,
      });
      return;
    }
    if (panning) {
      const dx = event.clientX - panStart.current.x;
      const dy = event.clientY - panStart.current.y;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragMoved.current = true;
      setPan({ x: panStart.current.px + dx, y: panStart.current.py + dy });
    }
  }, [panning, zoom, onMoveNode]);

  const endGesture = useCallback(() => {
    setPanning(false);
    nodeDrag.current = null;
    setDraggingNodeId(null);
  }, []);

  const onNodeDown = useCallback((event, node) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    dragMoved.current = false;
    const position = positions[node.id];
    if (!position) return;
    nodeDrag.current = {
      id: node.id,
      startX: event.clientX,
      startY: event.clientY,
      originX: position.x,
      originY: position.y,
    };
    setDraggingNodeId(node.id);
  }, [positions]);

  const onNodeClick = useCallback((event, node) => {
    event.stopPropagation();
    // A click that moved the pointer was a drag, not a selection. This is the
    // original implementation's distinction and it is kept: without it, every
    // attempt to pan by grabbing a node also selected it.
    if (dragMoved.current) return;
    if (node.is_cluster) { onExpandCluster?.(node); return; }
    onSelectNode?.(selectedNodeId === node.id ? null : node.id);
  }, [selectedNodeId, onSelectNode, onExpandCluster]);

  /* ── highlight sets ─────────────────────────────────────────────────────── */
  const activeNodeId = hoveredNodeId || selectedNodeId;

  const spotlight = useMemo(() => {
    if (!activeNodeId) return null;
    const ids = new Set([activeNodeId]);
    edges.forEach((edge) => {
      if (edge.source === activeNodeId) ids.add(edge.target);
      if (edge.target === activeNodeId) ids.add(edge.source);
    });
    return ids;
  }, [activeNodeId, edges]);

  const pathNodeIds = useMemo(
    () => (highlightPath?.nodes ? new Set(highlightPath.nodes.map((n) => n.id ?? n)) : null),
    [highlightPath],
  );
  const pathEdgeIds = useMemo(
    () => (highlightPath?.edges ? new Set(highlightPath.edges.map((e) => e.id ?? e)) : null),
    [highlightPath],
  );

  const nodeOpacity = useCallback((node) => {
    if (pathNodeIds) return pathNodeIds.has(node.id) ? 1 : 0.1;
    if (node.matched === false) {
      // Context brought in by a filter: visible, so the matches keep their
      // relationships, but clearly not part of the result.
      return spotlight && !spotlight.has(node.id) ? 0.1 : 0.42;
    }
    if (!spotlight) return 1;
    return spotlight.has(node.id) ? 1 : 0.1;
  }, [spotlight, pathNodeIds]);

  const edgeOpacity = useCallback((edge) => {
    if (pathEdgeIds) return pathEdgeIds.has(edge.id) ? 1 : 0.06;
    if (!activeNodeId) return 0.75;
    return edge.source === activeNodeId || edge.target === activeNodeId ? 1 : 0.08;
  }, [activeNodeId, pathEdgeIds]);

  /* ── viewport culling ───────────────────────────────────────────────────── */
  const visible = useMemo(() => {
    if (!viewport.w || !viewport.h) return { nodes, edges };
    const margin = 400;
    const minX = (-pan.x - margin) / zoom;
    const maxX = (viewport.w - pan.x + margin) / zoom;
    const minY = (-pan.y - margin) / zoom;
    const maxY = (viewport.h - pan.y + margin) / zoom;

    const inView = new Set();
    const visibleNodes = [];
    nodes.forEach((node) => {
      const position = positions[node.id];
      if (!position) return;
      if (position.x < minX || position.x > maxX || position.y < minY || position.y > maxY) return;
      inView.add(node.id);
      visibleNodes.push(node);
    });
    // An edge is kept when EITHER end is on screen, so a line leading off the
    // canvas still shows there is something out there.
    const visibleEdges = edges.filter((edge) => inView.has(edge.source) || inView.has(edge.target));
    return { nodes: visibleNodes, edges: visibleEdges };
  }, [nodes, edges, positions, pan, zoom, viewport]);

  const culled = nodes.length - visible.nodes.length;

  /* ── keyboard navigation ────────────────────────────────────────────────── */
  const onKeyDown = useCallback((event) => {
    if (!nodes.length) return;
    const step = 60;
    if (event.key === 'ArrowLeft' && event.shiftKey) { setPan((p) => ({ ...p, x: p.x + step })); return; }
    if (event.key === 'ArrowRight' && event.shiftKey) { setPan((p) => ({ ...p, x: p.x - step })); return; }
    if (event.key === 'ArrowUp' && event.shiftKey) { setPan((p) => ({ ...p, y: p.y + step })); return; }
    if (event.key === 'ArrowDown' && event.shiftKey) { setPan((p) => ({ ...p, y: p.y - step })); return; }

    // Unshifted arrows move the selection to the nearest node in that
    // direction, which is how the graph is navigable without a mouse.
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault();
      const current = selectedNodeId ? positions[selectedNodeId] : null;
      if (!current) { onSelectNode?.(nodes[0].id); return; }
      const wanted = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
      let best = null;
      let bestScore = Infinity;
      nodes.forEach((node) => {
        if (node.id === selectedNodeId) return;
        const position = positions[node.id];
        if (!position) return;
        const dx = position.x - current.x;
        const dy = position.y - current.y;
        const along = dx * wanted[0] + dy * wanted[1];
        if (along <= 0) return;
        const across = Math.abs(dx * wanted[1] + dy * wanted[0]);
        const score = along + across * 2.5;
        if (score < bestScore) { bestScore = score; best = node.id; }
      });
      if (best) { onSelectNode?.(best); centreOn(best); }
      return;
    }
    if (event.key === 'Enter' && selectedNodeId) { onOpenNode?.(selectedNodeId); return; }
    if (event.key === 'Escape') { onSelectNode?.(null); onSelectEdge?.(null); return; }
    if (event.key === '+' || event.key === '=') { setZoom((z) => Math.min(3, z + 0.12)); return; }
    if (event.key === '-') { setZoom((z) => Math.max(0.08, z - 0.12)); return; }
    if (event.key === 'f') fitAll();
  }, [nodes, positions, selectedNodeId, onSelectNode, onSelectEdge, onOpenNode, centreOn, fitAll]);

  /* ── render ─────────────────────────────────────────────────────────────── */
  const cursor = draggingNodeId ? 'grabbing' : panning ? 'grabbing' : 'grab';

  return (
    <div
      ref={canvasRef}
      role="application"
      aria-label={
        `Topology graph: ${nodes.length} resources, ${edges.length} relationships. `
        + 'Arrow keys move the selection, shift and arrow keys pan, plus and minus zoom, '
        + 'f fits the graph, Enter opens the selected resource.'
      }
      tabIndex={0}
      // h-full is load-bearing: the SVG inside is absolutely positioned, so
      // without a height from here the container collapses to nothing and the
      // graph renders as a blank area of page.
      className="relative h-full min-h-0 w-full select-none overflow-hidden rounded-card border border-border bg-surface outline-none focus-visible:ring-2 focus-visible:ring-accent"
      style={{ cursor }}
      onMouseDown={onBackgroundDown}
      onMouseMove={onPointerMove}
      onMouseUp={endGesture}
      onMouseLeave={endGesture}
      onKeyDown={onKeyDown}
      onClick={(event) => {
        // A click on the background clears the selection, but only when it was
        // a click and not the end of a pan.
        if (event.target === event.currentTarget && !dragMoved.current) {
          onSelectNode?.(null);
          onSelectEdge?.(null);
        }
      }}
    >
      {/* Zoom / fit controls */}
      <div className="absolute bottom-5 left-4 z-10 flex flex-col items-center gap-1.5 rounded-control border border-border bg-surface p-1.5 shadow-md">
        <IconButton size="sm" label="Zoom in" onClick={() => setZoom((z) => Math.min(3, z + 0.12))}>
          <ZoomIn size={15} />
        </IconButton>
        <span className="text-center text-[11px] font-semibold leading-none text-muted">
          {Math.round(zoom * 100)}%
        </span>
        <IconButton size="sm" label="Zoom out" onClick={() => setZoom((z) => Math.max(0.08, z - 0.12))}>
          <ZoomOut size={15} />
        </IconButton>
        <div className="h-px w-full bg-border" />
        <IconButton size="sm" label="Fit to screen" onClick={fitAll}>
          <Maximize2 size={15} />
        </IconButton>
        <IconButton
          size="sm"
          label={selectedNodeId ? 'Fit to selection' : 'Select a resource to fit to it'}
          disabled={!selectedNodeId}
          onClick={fitSelection}
        >
          <Crosshair size={15} />
        </IconButton>
        <IconButton
          size="sm"
          label={minimapOn ? 'Hide mini map' : 'Show mini map'}
          onClick={() => setMinimapOn((v) => !v)}
        >
          <MapIcon size={15} />
        </IconButton>
        {positionOverrides && Object.keys(positionOverrides).length > 0 && (
          <IconButton
            size="sm"
            icon="refresh"
            label={`Reset ${Object.keys(positionOverrides).length} moved resource(s)`}
            onClick={onResetPositions}
          />
        )}
      </div>

      {/* Off-screen count — so a mostly-empty viewport is never mistaken for
          a mostly-empty account. */}
      {culled > 0 && !loading && (
        <div className="pointer-events-none absolute bottom-5 right-4 z-10 rounded-control border border-border bg-surface/95 px-2.5 py-1.5 text-[11px] text-muted shadow-sm">
          {culled.toLocaleString()} more off screen · press f to fit
        </div>
      )}

      {loading && (
        <div className="absolute inset-0 z-[8] flex flex-col items-center justify-center gap-3 bg-surface/70">
          <Spinner size="lg" />
          <span className="text-sm text-muted">Building topology graph…</span>
        </div>
      )}

      {!loading && nodes.length === 0 && emptyState}

      <svg
        width="100%"
        height="100%"
        style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
        aria-hidden="true"
      >
        <defs>
          <marker id="topo-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
            <polygon points="0 0, 8 4, 0 8" fill="currentColor" />
          </marker>
        </defs>

        <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`} style={{ pointerEvents: 'all' }}>
          {/* Band labels, in GRAPH coordinates so each one stays above the
              band it names at any zoom or pan. */}
          {lanes?.map((lane) => (
            <text
              key={lane.label}
              x={lane.orientation === 'row' ? 24 : lane.at}
              y={lane.orientation === 'row' ? lane.at - 34 : MARGIN_Y - 38}
              textAnchor={lane.orientation === 'row' ? 'start' : 'middle'}
              fill="var(--fg-subtle)"
              style={{ fontSize: 13, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase' }}
            >
              {`${lane.label} (${lane.count})`}
            </text>
          ))}

          {/* Edges */}
          {visible.edges.map((edge) => {
            const from = positions[edge.source];
            const to = positions[edge.target];
            if (!from || !to) return null;

            const style = edgeStyle(edge.type);
            const opacity = edgeOpacity(edge);
            const onPath = pathEdgeIds?.has(edge.id);
            const isSelected = selectedEdgeId === edge.id;
            const isHovered = hoveredEdgeId === edge.id;
            const emphasised = onPath || isSelected || isHovered;

            // A cubic curve with horizontal control points, so parallel edges
            // between the same columns separate visually instead of stacking.
            const x1 = from.x + (to.x >= from.x ? CARD_W / 2 : -CARD_W / 2);
            const x2 = to.x + (to.x >= from.x ? -CARD_W / 2 : CARD_W / 2);
            const mid = (x1 + x2) / 2;
            const d = `M ${x1} ${from.y} C ${mid} ${from.y}, ${mid} ${to.y}, ${x2} ${to.y}`;

            return (
              <g
                key={edge.id}
                style={{ opacity, transition: 'opacity .2s', color: style.color }}
                onMouseEnter={() => setHoveredEdgeId(edge.id)}
                onMouseLeave={() => setHoveredEdgeId(null)}
                onClick={(event) => {
                  event.stopPropagation();
                  if (dragMoved.current) return;
                  onSelectEdge?.(isSelected ? null : edge.id);
                }}
              >
                {/* A wide transparent hit area: a 2px line is unclickable. */}
                <path d={d} fill="none" stroke="transparent" strokeWidth={14} style={{ cursor: 'pointer' }} />
                {emphasised && (
                  <path d={d} fill="none" stroke={style.color} strokeWidth={10} strokeOpacity={0.25} style={{ filter: 'blur(5px)' }} />
                )}
                <path
                  d={d}
                  fill="none"
                  stroke={style.color}
                  strokeWidth={emphasised ? 3.2 : 1.8}
                  strokeDasharray={style.dash}
                  markerEnd="url(#topo-arrow)"
                  style={{ pointerEvents: 'none' }}
                />
              </g>
            );
          })}

          {/* Nodes */}
          {visible.nodes.map((node) => {
            const position = positions[node.id];
            if (!position) return null;

            const meta = typeMeta(node.type);
            const health = healthMeta(node.health);
            const provider = providerMeta(node.provider);
            const isSelected = selectedNodeId === node.id;
            const isHovered = hoveredNodeId === node.id;
            const opacity = nodeOpacity(node);
            const x = position.x - CARD_W / 2;
            const y = position.y - CARD_H / 2;
            const dashed = node.is_default || node.is_synthetic;

            return (
              <g
                key={node.id}
                transform={`translate(${x}, ${y})`}
                style={{ cursor: 'pointer', opacity, transition: draggingNodeId === node.id ? 'none' : 'opacity .2s' }}
                onMouseDown={(event) => onNodeDown(event, node)}
                onClick={(event) => onNodeClick(event, node)}
                onDoubleClick={(event) => { event.stopPropagation(); onOpenNode?.(node.id); }}
                onMouseEnter={() => setHoveredNodeId(node.id)}
                onMouseLeave={() => setHoveredNodeId(null)}
              >
                <title>
                  {[
                    `${meta.label} · ${node.name}`,
                    `${provider.label}${node.region ? ` · ${node.region}` : ''}`,
                    node.status ? `Status: ${node.status}` : 'Status: not reported',
                    `Health: ${health.label}`,
                    `Connections: ${node.connection_count ?? 0}`,
                    node.drift_count ? `Configuration changes: ${node.drift_count}` : null,
                    node.event_count ? `Audit events (30d): ${node.event_count}` : null,
                    node.exposed ? `Internet exposed (${node.exposure_severity})` : null,
                    node.is_cluster ? 'Click to expand this group' : null,
                  ].filter(Boolean).join('\n')}
                </title>

                {isSelected && (
                  <rect
                    x={-4} y={-4} width={CARD_W + 8} height={CARD_H + 8} rx={15}
                    fill="none" stroke={meta.color} strokeWidth={1.5} strokeOpacity={0.55}
                  />
                )}

                <rect
                  width={CARD_W}
                  height={CARD_H}
                  rx={12}
                  fill="var(--surface)"
                  stroke={isSelected ? meta.color : isHovered ? meta.color : 'var(--border)'}
                  strokeWidth={isSelected ? 2.5 : isHovered ? 2 : 1.4}
                  strokeDasharray={dashed ? '5,4' : undefined}
                />

                {/* Type accent */}
                <rect x={0} y={0} width={5} height={CARD_H} rx={2.5} fill={meta.color} />

                {/* Health dot — only drawn when the provider reported a status,
                    so an absent health is silence rather than a grey claim. */}
                {node.health && node.health !== 'Unknown' && (
                  <circle cx={CARD_W - 13} cy={14} r={4.5} fill={health.color} />
                )}

                <text x={17} y={23} fill="var(--fg)" style={{ fontSize: 12.5, fontWeight: 700 }}>
                  {clip(node.name, 22)}
                </text>
                <text x={17} y={39} fill={meta.color} style={{ fontSize: 10.5, fontWeight: 700 }}>
                  {clip(node.is_cluster ? `${node.cluster_container} · group` : meta.label, 26)}
                </text>
                <text x={17} y={54} fill="var(--fg-subtle)" style={{ fontSize: 9.5, fontWeight: 600 }}>
                  {clip([provider.label, node.region].filter(Boolean).join(' · '), 30)}
                </text>

                {/* Indicator pips. Text alternatives live in the <title> above
                    and in the resource panel — never colour alone. */}
                <g transform={`translate(${CARD_W - 11}, ${CARD_H - 12})`}>
                  {node.exposed && <circle cx={0} cy={0} r={4} fill="#dc2626" />}
                  {node.drift_count > 0 && <circle cx={-11} cy={0} r={4} fill="#d97706" />}
                  {node.event_count > 0 && <circle cx={-22} cy={0} r={4} fill="#0ea5e9" />}
                </g>

                {node.is_cluster && (
                  <text x={CARD_W - 17} y={23} textAnchor="end" fill="var(--fg-muted)" style={{ fontSize: 10, fontWeight: 800 }}>
                    +
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>

      {/* Mini map */}
      {minimapOn && nodes.length > 0 && (
        <MiniMap
          positions={positions}
          nodes={nodes}
          width={width}
          height={height}
          viewport={viewport}
          pan={pan}
          zoom={zoom}
          selectedNodeId={selectedNodeId}
          onJump={(graphX, graphY) => setPan({
            x: viewport.w / 2 - graphX * zoom,
            y: viewport.h / 2 - graphY * zoom,
          })}
        />
      )}
    </div>
  );
}

/**
 * The mini map.
 *
 * Draws every node as a 2px dot regardless of the cull, because its whole job
 * is to show what is off screen. At a few thousand dots this is cheap: no
 * text, no strokes, no event handlers per dot.
 */
function MiniMap({
  positions, nodes, width, height, viewport, pan, zoom, selectedNodeId, onJump,
}) {
  const boxW = 168;
  const boxH = Math.max(80, Math.min(150, Math.round((boxW * height) / Math.max(width, 1))));
  const scale = Math.min(boxW / Math.max(width, 1), boxH / Math.max(height, 1));

  // Where the viewport sits in graph space, projected onto the mini map.
  const viewX = -pan.x / zoom;
  const viewY = -pan.y / zoom;
  const viewW = viewport.w / zoom;
  const viewH = viewport.h / zoom;

  return (
    <div className="absolute bottom-5 right-4 z-10 overflow-hidden rounded-control border border-border bg-surface/95 shadow-md">
      <svg
        width={boxW}
        height={boxH}
        role="img"
        aria-label="Mini map. Click to move the viewport."
        style={{ display: 'block', cursor: 'crosshair' }}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          onJump((event.clientX - rect.left) / scale, (event.clientY - rect.top) / scale);
        }}
      >
        {nodes.map((node) => {
          const position = positions[node.id];
          if (!position) return null;
          return (
            <circle
              key={node.id}
              cx={position.x * scale}
              cy={position.y * scale}
              r={selectedNodeId === node.id ? 3 : 1.6}
              fill={selectedNodeId === node.id ? 'var(--fg)' : typeMeta(node.type).color}
              opacity={selectedNodeId === node.id ? 1 : 0.75}
            />
          );
        })}
        <rect
          x={viewX * scale}
          y={viewY * scale}
          width={Math.max(viewW * scale, 4)}
          height={Math.max(viewH * scale, 4)}
          fill="none"
          stroke="var(--fg-muted)"
          strokeWidth={1.5}
        />
      </svg>
    </div>
  );
}
