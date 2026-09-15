import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import Badge from '@/components/ui/Badge';
import Table from '@/components/ui/Table';
import {
  edgeStyle, formatCount, healthMeta, providerMeta, typeMeta,
} from '../utils/topologyModel';

/**
 * The list view — the same topology as rows instead of a canvas.
 *
 * This exists for two reasons and serves both equally.
 *
 * It is the accessible alternative required by section 83: an SVG graph
 * communicates through position, and position is not available to a screen
 * reader or to anyone who cannot visually parse a node diagram. Everything the
 * canvas says — which resources exist, how they connect, in which direction,
 * on what evidence — is here as text in a sortable table.
 *
 * It is also simply the better tool for some questions. "Which resources have
 * a wildcard grant" and "list every security relationship" are table
 * questions, and answering them by counting dots on a canvas is worse in every
 * way. Rows are windowed by the shared Table, so a few thousand of them stay
 * responsive.
 */
export default function TopologyList({
  nodes,
  edges,
  onSelectNode,
  onExplainEdge,
  selectedNodeId,
}) {
  // The shared Table windows its rows against a FIXED body height, and it is
  // the element that scrolls. Passing a made-up large height left the table's
  // own scroll container taller than its content, so it never scrolled, its
  // scrollTop stayed 0, and only the first screenful of rows was ever
  // rendered - row 300 of 492 was unreachable. So the real height is measured
  // and handed to it.
  const bodyRef = useRef(null);
  const [bodyHeight, setBodyHeight] = useState(520);

  useLayoutEffect(() => {
    const element = bodyRef.current;
    if (!element) return undefined;
    const measure = () => setBodyHeight(Math.max(240, element.clientHeight));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const [pane, setPane] = useState('resources');
  const [sort, setSort] = useState({ key: 'name', dir: 'asc' });
  const [edgeSort, setEdgeSort] = useState({ key: 'relationship', dir: 'asc' });

  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  /* ── Resources ────────────────────────────────────────────────────────── */
  const resourceColumns = [
    { key: 'name', label: 'Resource', sortable: true, width: '26%' },
    { key: 'type', label: 'Type', sortable: true, width: '15%' },
    { key: 'provider', label: 'Cloud', sortable: true, width: '9%' },
    { key: 'region', label: 'Region', sortable: true, width: '12%' },
    { key: 'health', label: 'Health', sortable: true, width: '11%' },
    { key: 'connections', label: 'Links', sortable: true, align: 'right', width: '7%' },
    { key: 'signals', label: 'Signals', width: '20%' },
  ];

  const sortedNodes = useMemo(() => {
    const value = (node) => {
      switch (sort.key) {
        case 'type': return typeMeta(node.type).label;
        case 'provider': return node.provider || '';
        case 'region': return node.region || '';
        case 'health': return node.health || '';
        case 'connections': return node.connection_count || 0;
        default: return (node.name || '').toLowerCase();
      }
    };
    const rows = [...nodes].sort((a, b) => {
      const av = value(a);
      const bv = value(b);
      if (av === bv) return (a.name || '').localeCompare(b.name || '');
      if (typeof av === 'number' && typeof bv === 'number') return av - bv;
      return String(av).localeCompare(String(bv));
    });
    return sort.dir === 'desc' ? rows.reverse() : rows;
  }, [nodes, sort]);

  const resourceRows = useMemo(() => sortedNodes.map((node) => {
    const meta = typeMeta(node.type);
    const health = healthMeta(node.health);
    const provider = providerMeta(node.provider);
    return {
      key: node.id,
      onClick: () => onSelectNode?.(node.id),
      sort: {
        name: (node.name || '').toLowerCase(),
        type: meta.label,
        provider: provider.label,
        region: node.region || '',
        health: node.health || '',
        connections: node.connection_count || 0,
      },
      cells: {
        name: (
          <span className="flex min-w-0 items-center gap-2">
            <span
              className={`shrink-0 rounded-sm ${selectedNodeId === node.id ? 'h-6 w-1.5' : 'h-4 w-1'}`}
              style={{ background: meta.color }}
            />
            <span className="min-w-0">
              <span className="block truncate font-medium text-fg">{node.name || '—'}</span>
              {node.provider_id && (
                <span className="block truncate font-mono text-[10.5px] text-subtle">{node.provider_id}</span>
              )}
            </span>
          </span>
        ),
        type: <span className="text-muted">{meta.label}</span>,
        provider: (
          <span className={`rounded border px-1.5 py-px text-[10px] font-bold ${provider.badge}`}>
            {provider.label}
          </span>
        ),
        region: <span className="text-muted">{node.region || '—'}</span>,
        health: (
          <span className="inline-flex items-center gap-1.5">
            {node.health && node.health !== 'Unknown' && (
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: health.color }} />
            )}
            <span className={node.health === 'Unknown' ? 'italic text-subtle' : 'text-muted'}>
              {health.label}
            </span>
          </span>
        ),
        connections: <span className="tabular-nums text-muted">{node.connection_count ?? 0}</span>,
        signals: (
          <span className="flex flex-wrap gap-1">
            {node.exposed && (
              <Badge tone="danger" size="sm">{`Public${node.exposure_severity ? ` · ${node.exposure_severity}` : ''}`}</Badge>
            )}
            {node.drift_count > 0 && (
              <Badge tone={node.significant_drift_count > 0 ? 'warning' : 'info'} size="sm">
                {`${node.drift_count} change${node.drift_count === 1 ? '' : 's'}`}
              </Badge>
            )}
            {node.event_count > 0 && (
              <Badge tone={node.high_risk_event_count > 0 ? 'danger' : 'neutral'} size="sm">
                {`${node.event_count} event${node.event_count === 1 ? '' : 's'}`}
              </Badge>
            )}
            {node.broad_access?.length > 0 && <Badge tone="warning" size="sm">Wildcard IAM</Badge>}
            {node.is_default && <Badge tone="neutral" size="sm">Default</Badge>}
            {node.is_synthetic && <Badge tone="neutral" size="sm">Container</Badge>}
            {node.matched === false && <Badge tone="neutral" size="sm">Context</Badge>}
            {selectedNodeId === node.id && <Badge tone="accent" size="sm">Selected</Badge>}
          </span>
        ),
      },
    };
  }), [sortedNodes, onSelectNode, selectedNodeId]);

  /* ── Relationships ────────────────────────────────────────────────────── */
  const edgeColumns = [
    { key: 'source', label: 'From', sortable: true, width: '24%' },
    { key: 'relationship', label: 'Relationship', sortable: true, width: '16%' },
    { key: 'target', label: 'To', sortable: true, width: '24%' },
    { key: 'evidence', label: 'Evidence', width: '28%' },
    { key: 'confidence', label: 'Confirmed', width: '8%' },
  ];

  const sortedEdges = useMemo(() => {
    const value = (edge) => {
      switch (edgeSort.key) {
        case 'source': return (nodeById.get(edge.source)?.name || '').toLowerCase();
        case 'target': return (nodeById.get(edge.target)?.name || '').toLowerCase();
        default: return edge.type || '';
      }
    };
    const rows = [...edges].sort((a, b) => String(value(a)).localeCompare(String(value(b))));
    return edgeSort.dir === 'desc' ? rows.reverse() : rows;
  }, [edges, edgeSort, nodeById]);

  const edgeRows = useMemo(() => sortedEdges.map((edge) => {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    const style = edgeStyle(edge.type);
    return {
      key: edge.id,
      onClick: () => onExplainEdge?.(edge.id),
      cells: {
        source: source ? (
          <span className="block truncate">
            <span className="font-medium text-fg">{source.name}</span>
            <span className="block truncate text-[10.5px] text-subtle">{typeMeta(source.type).label}</span>
          </span>
        ) : <span className="italic text-subtle">—</span>,
        relationship: (
          <span className="inline-flex flex-col gap-0.5">
            <span
              className="w-fit rounded px-1.5 py-px text-[10px] font-bold uppercase"
              style={{ color: style.color, background: `${style.color}22` }}
            >
              {style.label}
            </span>
            {edge.label && <span className="truncate text-[10.5px] text-subtle">{edge.label}</span>}
          </span>
        ),
        target: target ? (
          <span className="block truncate">
            <span className="font-medium text-fg">{target.name}</span>
            <span className="block truncate text-[10.5px] text-subtle">{typeMeta(target.type).label}</span>
          </span>
        ) : <span className="italic text-subtle">—</span>,
        evidence: (
          <span className="block truncate font-mono text-[10.5px] text-muted" title={edge.evidence?.value || ''}>
            {edge.evidence?.field || '—'}
          </span>
        ),
        confidence: edge.observed === false ? (
          <Badge tone="warning" size="sm">
            <span title="A capability granted by policy, not an observed access.">May access</span>
          </Badge>
        ) : (
          <Badge tone="success" size="sm">Yes</Badge>
        ),
      },
    };
  }), [sortedEdges, nodeById, onExplainEdge]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-card border border-border bg-surface">
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 pt-2">
        {[
          ['resources', `Resources (${formatCount(nodes.length)})`],
          ['relationships', `Relationships (${formatCount(edges.length)})`],
        ].map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setPane(id)}
            aria-current={pane === id}
            className={`rounded-t-control px-3 py-1.5 text-[12px] font-semibold transition-colors ${
              pane === id ? 'bg-sunken text-fg' : 'text-muted hover:text-fg'
            }`}
          >
            {label}
          </button>
        ))}
        <p className="ml-auto pr-2 text-[11px] text-subtle">
          {pane === 'resources'
            ? 'Select a row to open the resource.'
            : 'Select a row to see why the relationship exists.'}
        </p>
      </div>

      <div ref={bodyRef} className="min-h-0 flex-1 overflow-hidden">
        {pane === 'resources' ? (
          <Table
            columns={resourceColumns}
            rows={resourceRows}
            sort={sort}
            onSort={(key) => setSort((current) => ({
              key,
              dir: current.key === key && current.dir === 'asc' ? 'desc' : 'asc',
            }))}
            rowHeight={52}
            virtualize
            maxBodyHeight={bodyHeight}
            empty="No resources match the current filters."
          />
        ) : (
          <Table
            columns={edgeColumns}
            rows={edgeRows}
            sort={edgeSort}
            onSort={(key) => setEdgeSort((current) => ({
              key,
              dir: current.key === key && current.dir === 'asc' ? 'desc' : 'asc',
            }))}
            rowHeight={52}
            virtualize
            maxBodyHeight={bodyHeight}
            empty="No relationships in the current view."
          />
        )}
      </div>
    </div>
  );
}
