import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCloudAccounts } from '../hooks/useCloudAccounts';
import { useTopology } from '../hooks/useTopology';
import { useCloudStore } from '../state/cloudStore';
import { CloudProviderSelector } from '../components/CloudProviderSelector';
import {
  ArrowLeft, ZoomIn, ZoomOut, Maximize2, Search, ExternalLink, X,
  RefreshCw, Info
} from 'lucide-react';

// ── Type Metadata ──────────────────────────────────────────────────
const TYPE_META: Record<string, { icon: string; color: string; label: string }> = {
  EC2Instance:          { icon: '🖥️', color: '#f59e0b', label: 'EC2 Instance' },
  S3Bucket:             { icon: '🪣', color: '#3b82f6', label: 'S3 Bucket' },
  LambdaFunction:       { icon: 'λ',  color: '#a855f7', label: 'Lambda' },
  DynamoDBTable:        { icon: '🗄️', color: '#10b981', label: 'DynamoDB Table' },
  RDSInstance:          { icon: '💾', color: '#06b6d4', label: 'RDS Database' },
  EKSCluster:           { icon: '⚓', color: '#6366f1', label: 'EKS Cluster' },
  LoadBalancer:         { icon: '⚖️', color: '#ec4899', label: 'Load Balancer' },
  SecurityGroup:        { icon: '🛡️', color: '#eab308', label: 'Security Group' },
  VPC:                  { icon: '🌐', color: '#14b8a6', label: 'VPC Network' },
  IAMRole:              { icon: '👤', color: '#64748b', label: 'IAM Role' },
  APIGateway:           { icon: '🔌', color: '#ec4899', label: 'API Gateway' },
  BedrockModel:         { icon: '🤖', color: '#10b981', label: 'Bedrock Model' },
  BedrockAgent:         { icon: '🧠', color: '#ec4899', label: 'Bedrock Agent' },
  BedrockKnowledgeBase: { icon: '📚', color: '#3b82f6', label: 'Bedrock KB' },
};

const CARD_W = 200;
const CARD_H = 68;

export const CloudTopologyPage = () => {
  const navigate = useNavigate();
  const { data: accounts } = useCloudAccounts();
  const selectedAccountId = useCloudStore(state => state.selectedAccountId);
  const setSelectedAccountId = useCloudStore(state => state.setSelectedAccountId);

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [currentAccountView, setCurrentAccountView] = useState<string>('ALL');

  // ── Zoom / Pan ─────────────────────────────────────────────────
  const [zoom, setZoom] = useState(0.85);
  const [pan, setPan] = useState({ x: 60, y: 56 });
  const [isDragging, setIsDragging] = useState(false);
  const dragMoved = useRef(false);
  const dragStart = useRef({ x: 0, y: 0, px: 0, py: 0 });
  const canvasRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!selectedAccountId && accounts && accounts.length > 0) {
      setSelectedAccountId(accounts[0].id);
    }
  }, [accounts, selectedAccountId, setSelectedAccountId]);

  const { data: topology, isLoading, refetch } = useTopology(currentAccountView);

  const nodes = topology?.nodes || [];
  const edges = topology?.edges || [];

  // ── Layout columns ─────────────────────────────────────────────
  const col1Types = ['VPC', 'SecurityGroup', 'IAMRole'];
  const col2Types = ['EC2Instance', 'LambdaFunction', 'EKSCluster', 'LoadBalancer', 'APIGateway'];

  const col1Nodes = nodes.filter((n: any) => col1Types.includes(n.type));
  const col2Nodes = nodes.filter((n: any) => col2Types.includes(n.type));
  const col3Nodes = nodes.filter((n: any) => !col1Types.includes(n.type) && !col2Types.includes(n.type));

  const maxNodes = Math.max(col1Nodes.length, col2Nodes.length, col3Nodes.length, 1);
  const canvasHeight = Math.max(700, maxNodes * 96 + 120);
  const canvasWidth  = Math.max(1300, 1300);

  const nodePositions: Record<string, { x: number; y: number }> = {};

  const spacingY = (arr: any[]) => (canvasHeight - 120) / Math.max(arr.length, 1);

  col1Nodes.forEach((n: any, i: number) => {
    nodePositions[n.id] = { x: 200, y: 80 + i * spacingY(col1Nodes) + spacingY(col1Nodes) / 2 };
  });
  col2Nodes.forEach((n: any, i: number) => {
    nodePositions[n.id] = { x: 650, y: 80 + i * spacingY(col2Nodes) + spacingY(col2Nodes) / 2 };
  });
  col3Nodes.forEach((n: any, i: number) => {
    nodePositions[n.id] = { x: 1100, y: 80 + i * spacingY(col3Nodes) + spacingY(col3Nodes) / 2 };
  });

  // ── Pan/Zoom handlers (canvas-only, no page scroll) ────────────
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    dragMoved.current = false;
    dragStart.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
    setIsDragging(true);
  }, [pan]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (isDragging) {
      const dx = e.clientX - dragStart.current.x;
      const dy = e.clientY - dragStart.current.y;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
        dragMoved.current = true;
      }
      setPan({
        x: dragStart.current.px + dx,
        y: dragStart.current.py + dy,
      });
    }
  }, [isDragging]);

  const handleMouseUp = useCallback(() => setIsDragging(false), []);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const factor = 1.08;
    setZoom(prev => Math.max(0.3, Math.min(3, e.deltaY < 0 ? prev * factor : prev / factor)));
  }, []);

  // Attach non-passive wheel listener to canvas div
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = 1.08;
      setZoom(prev => Math.max(0.3, Math.min(3, e.deltaY < 0 ? prev * factor : prev / factor)));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const resetView = () => { setZoom(0.85); setPan({ x: 60, y: 56 }); };

  // ── Highlighting ───────────────────────────────────────────────
  const getConnectedNodeIds = (nodeId: string | null) => {
    if (!nodeId) return new Set<string>();
    const ids = new Set<string>([nodeId]);
    edges.forEach((e: any) => {
      if (e.source === nodeId) ids.add(e.target);
      if (e.target === nodeId) ids.add(e.source);
    });
    return ids;
  };

  const activeNode = hoveredNodeId || selectedNodeId;
  const activeConnected = getConnectedNodeIds(activeNode);

  const isHighlighted = (id: string) => !activeNode || activeConnected.has(id);
  const isEdgeHighlighted = (e: any) =>
    !activeNode || e.source === activeNode || e.target === activeNode;

  const matchesSearch = (n: any) =>
    !searchQuery || n.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    n.type.toLowerCase().includes(searchQuery.toLowerCase());

  // ── Selected node detail ───────────────────────────────────────
  const selectedNode    = nodes.find((n: any) => n.id === selectedNodeId);
  const selectedNodeMeta = selectedNode
    ? TYPE_META[selectedNode.type] ?? { icon: '☁️', color: '#94a3b8', label: selectedNode.type }
    : null;

  const inbound  = selectedNodeId ? edges.filter((e: any) => e.target === selectedNodeId).map((e: any) => ({ edge: e, node: nodes.find((n: any) => n.id === e.source) })).filter(c => c.node) : [];
  const outbound = selectedNodeId ? edges.filter((e: any) => e.source === selectedNodeId).map((e: any) => ({ edge: e, node: nodes.find((n: any) => n.id === e.target) })).filter(c => c.node) : [];

  return (
    <div style={S.page}>
      {/* ── Header ──────────────────────────────────────────────── */}
      <div style={S.header}>
        <div>
          <button onClick={() => navigate('/cloud')} style={S.backBtn}>
            <ArrowLeft size={14} /> Cloud Control Center
          </button>
          <h1 style={S.title}>🕸️ Resource Topology Map</h1>
          <p style={S.subtitle}>Visual dependency graph · drag to pan · scroll to zoom</p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {/* Search */}
          <div style={S.searchBox}>
            <Search size={14} color="#64748b" />
            <input
              type="text"
              placeholder="Search resource…"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              style={S.searchInput}
            />
            {searchQuery && (
              <button onClick={() => setSearchQuery('')} style={S.clearBtn}><X size={12} /></button>
            )}
          </div>

          {/* Account picker */}
          {accounts && accounts.length > 0 && (
            <CloudProviderSelector
              accounts={accounts}
              mode="multi"
              selected={currentAccountView}
              onSelect={id => { setCurrentAccountView(id || 'ALL'); setSelectedNodeId(null); }}
            />
          )}

          {/* Refresh */}
          <button onClick={() => refetch()} style={S.iconBtn} title="Refresh">
            <RefreshCw size={15} />
          </button>
        </div>
      </div>

      {/* ── Legend ──────────────────────────────────────────────── */}
      <div style={S.legend}>
        {[
          { color: '#eab308', label: 'Security edge' },
          { color: '#10b981', label: 'Data flow' },
          { color: '#14b8a6', label: 'Contains' },
          { color: '#94a3b8', label: 'IAM role' },
          { color: 'rgba(148,163,184,0.4)', label: 'Default resource', dashed: true },
        ].map(l => (
          <div key={l.label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{
              width: 24, height: 2,
              background: l.color,
              borderTop: l.dashed ? `2px dashed ${l.color}` : undefined,
              opacity: 0.85,
            }} />
            <span style={{ color: '#64748b', fontSize: 11 }}>{l.label}</span>
          </div>
        ))}
        <div style={{ marginLeft: 'auto', color: '#475569', fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}>
          <Info size={11} />{nodes.length} nodes · {edges.length} edges
        </div>
      </div>

      {/* ── Main area ───────────────────────────────────────────── */}
      <div style={S.mainArea}>

        {/* Canvas */}
        <div
          ref={canvasRef}
          style={{
            ...S.canvas,
            cursor: isDragging ? 'grabbing' : 'grab',
            flex: selectedNode ? '1 1 0%' : '1 1 100%',
          }}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
        >
          {/* Column headers */}
          <div style={S.colHeaders}>
            <div style={S.colHeaderCell}>🛡️ Identity &amp; Network</div>
            <div style={S.colHeaderCell}>⚙️ Compute &amp; Logic</div>
            <div style={S.colHeaderCell}>🗄️ Storage &amp; Database</div>
          </div>

          {/* Zoom controls */}
          <div style={S.zoomControls}>
            <button onClick={() => setZoom(p => Math.min(3, p + 0.12))} style={S.zoomBtn} title="Zoom in"><ZoomIn size={15} /></button>
            <span style={{ color: '#475569', fontSize: 11, fontWeight: 700, textAlign: 'center', lineHeight: 1 }}>{Math.round(zoom * 100)}%</span>
            <button onClick={() => setZoom(p => Math.max(0.3, p - 0.12))} style={S.zoomBtn} title="Zoom out"><ZoomOut size={15} /></button>
            <div style={{ width: '100%', height: 1, background: 'rgba(255,255,255,0.06)' }} />
            <button onClick={resetView} style={S.zoomBtn} title="Reset view"><Maximize2 size={15} /></button>
          </div>

          {/* Node count badge */}
          {isLoading && (
            <div style={S.loadingOverlay}>
              <div style={S.spinner} />
              <span style={{ color: '#94a3b8', fontSize: 14, fontWeight: 500, marginTop: 12 }}>Building topology graph…</span>
            </div>
          )}

          {!isLoading && nodes.length === 0 && (
            <div style={S.loadingOverlay}>
              <span style={{ fontSize: 40 }}>🌐</span>
              <span style={{ color: '#94a3b8', fontSize: 14, marginTop: 10 }}>No topology data. Run a discovery scan first.</span>
            </div>
          )}

          {/* SVG Canvas */}
          <svg
            width="100%"
            height="100%"
            style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
            xmlns="http://www.w3.org/2000/svg"
          >
            <defs>
              <marker id="arrow" markerWidth="7" markerHeight="7" refX="5" refY="3.5" orient="auto">
                <polygon points="0 0, 7 3.5, 0 7" fill="rgba(255,255,255,0.15)" />
              </marker>
              <marker id="arrow-highlight" markerWidth="7" markerHeight="7" refX="5" refY="3.5" orient="auto">
                <polygon points="0 0, 7 3.5, 0 7" fill="rgba(255,255,255,0.6)" />
              </marker>
            </defs>

            <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`} style={{ pointerEvents: 'all' }}>

              {/* Edges */}
              {edges.map((edge: any) => {
                const sp = nodePositions[edge.source];
                const tp = nodePositions[edge.target];
                if (!sp || !tp) return null;

                const hl = isEdgeHighlighted(edge);
                const qm = !searchQuery || matchesSearch(nodes.find((n: any) => n.id === edge.source)) || matchesSearch(nodes.find((n: any) => n.id === edge.target));

                const x1 = sp.x + CARD_W / 2, y1 = sp.y;
                const x2 = tp.x - CARD_W / 2, y2 = tp.y;
                const mx = (x1 + x2) / 2;
                const d = `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;

                const colors: Record<string, string> = {
                  security: '#eab308',
                  dataflow: '#10b981',
                  contains: '#14b8a6',
                  role:     '#94a3b8',
                };
                const c = colors[edge.type] || '#ffffff';

                return (
                  <g key={edge.id} style={{ opacity: hl && qm ? 1 : 0.06, transition: 'opacity 0.25s' }}>
                    {hl && (
                      <path d={d} fill="none" stroke={c} strokeWidth="8" strokeOpacity="0.18"
                        style={{ filter: 'blur(4px)' }} />
                    )}
                    <path
                      d={d}
                      fill="none"
                      stroke={hl ? c : 'rgba(255,255,255,0.12)'}
                      strokeWidth={hl ? 2 : 1.2}
                      strokeDasharray={edge.type === 'dataflow' ? '5,5' : undefined}
                      markerEnd={hl ? 'url(#arrow-highlight)' : 'url(#arrow)'}
                      style={{ transition: 'stroke 0.2s, stroke-width 0.2s' }}
                    />
                  </g>
                );
              })}

              {/* Nodes */}
              {nodes.map((node: any) => {
                const pos = nodePositions[node.id];
                if (!pos) return null;

                const isDefault = node.is_default || node.name?.toLowerCase() === 'default';
                const meta = TYPE_META[node.type] ?? { icon: '☁️', color: '#94a3b8', label: node.type };
                const hl = isHighlighted(node.id);
                const qm = matchesSearch(node);
                const isSel = selectedNodeId === node.id;
                const isHov = hoveredNodeId === node.id;

                const x = pos.x - CARD_W / 2;
                const y = pos.y - CARD_H / 2;

                return (
                  <g
                    key={node.id}
                    data-node="true"
                    transform={`translate(${x}, ${y})`}
                    onClick={(e) => {
                  e.stopPropagation();
                  if (!dragMoved.current) {
                    setSelectedNodeId(isSel ? null : node.id);
                  }
                }}
                    onMouseEnter={() => setHoveredNodeId(node.id)}
                    onMouseLeave={() => setHoveredNodeId(null)}
                    style={{
                      cursor: 'pointer',
                      opacity: hl && qm ? 1 : 0.12,
                      transition: 'opacity 0.2s',
                    }}
                  >
                    {/* Selected glow */}
                    {isSel && (
                      <rect
                        x="-4" y="-4"
                        width={CARD_W + 8} height={CARD_H + 8}
                        rx="15"
                        fill="none"
                        stroke={meta.color}
                        strokeWidth="1.5"
                        strokeOpacity="0.5"
                        style={{ filter: `drop-shadow(0 0 8px ${meta.color}60)` }}
                      />
                    )}

                    {/* Card body */}
                    <rect
                      width={CARD_W} height={CARD_H} rx="12"
                      fill={isSel ? 'rgba(30,42,68,0.95)' : isDefault ? 'rgba(15,23,42,0.5)' : 'rgba(22,30,50,0.82)'}
                      stroke={isSel ? meta.color : isHov ? `${meta.color}cc` : isDefault ? 'rgba(148,163,184,0.2)' : 'rgba(255,255,255,0.07)'}
                      strokeWidth={isSel ? 2 : 1}
                      strokeDasharray={isDefault ? '5,4' : undefined}
                      style={{ transition: 'all 0.18s' }}
                    />

                    {/* Icon bg */}
                    <rect x="12" y="14" width="42" height="42" rx="9"
                      fill={isDefault ? 'rgba(100,116,139,0.08)' : `${meta.color}18`}
                      stroke={isDefault ? 'rgba(100,116,139,0.15)' : `${meta.color}30`}
                    />

                    {/* Icon */}
                    <text x="33" y="40" textAnchor="middle" dominantBaseline="middle"
                      style={{ fontSize: 18, fontFamily: 'Segoe UI Emoji, Apple Color Emoji, sans-serif', opacity: isDefault ? 0.55 : 1 }}>
                      {meta.icon}
                    </text>

                    {/* Name */}
                    <text x="64" y="26"
                      fill={isDefault ? '#94a3b8' : '#f1f5f9'}
                      style={{ fontSize: 12, fontWeight: 700, fontFamily: 'system-ui, sans-serif' }}>
                      {node.name.length > 17 ? `${node.name.slice(0, 16)}…` : node.name}
                    </text>

                    {/* Type label */}
                    <text x="64" y="42"
                      fill={isDefault ? '#475569' : meta.color}
                      style={{ fontSize: 10, fontWeight: 600, fontFamily: 'system-ui, sans-serif' }}>
                      {isDefault ? `${meta.label} · Default` : meta.label}
                    </text>

                    {/* Region */}
                    <text x="64" y="56"
                      fill="#475569"
                      style={{ fontSize: 9, fontFamily: 'monospace' }}>
                      📍 {node.region}
                    </text>

                    {/* Cost badge */}
                    {node.cost > 0 && (
                      <g transform={`translate(${CARD_W - 46}, ${CARD_H - 22})`}>
                        <rect width="42" height="16" rx="5" fill="rgba(16,185,129,0.1)" stroke="rgba(16,185,129,0.25)" strokeWidth="0.5" />
                        <text x="21" y="12" textAnchor="middle"
                          fill="#10b981"
                          style={{ fontSize: 9, fontWeight: 700, fontFamily: 'system-ui' }}>
                          ${node.cost.toFixed(0)}/mo
                        </text>
                      </g>
                    )}
                  </g>
                );
              })}
            </g>
          </svg>
        </div>

        {/* ── Detail Sidebar ───────────────────────────────────── */}
        {selectedNode && selectedNodeMeta && (
          <div style={S.sidebar}>
            {/* Sidebar header with × close */}
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 20 }}>
              <div style={{
                width: 46, height: 46, borderRadius: 11, display: 'flex', alignItems: 'center',
                justifyContent: 'center', fontSize: 22, flexShrink: 0,
                background: `${selectedNodeMeta.color}18`, border: `1.5px solid ${selectedNodeMeta.color}35`
              }}>
                {selectedNodeMeta.icon}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <h3 style={{ margin: 0, fontSize: 15, fontWeight: 800, color: '#f1f5f9', wordBreak: 'break-all', lineHeight: 1.3 }}>
                  {selectedNode.name}
                </h3>
                <span style={{ fontSize: 10, fontWeight: 700, color: selectedNodeMeta.color, textTransform: 'uppercase', letterSpacing: 0.6 }}>
                  {selectedNodeMeta.label}
                </span>
              </div>
              {/* Close button */}
              <button
                onClick={() => setSelectedNodeId(null)}
                style={S.closeBtn}
                title="Close details"
              >
                <X size={16} />
              </button>
            </div>

            {/* Meta rows */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1, marginBottom: 20, background: 'rgba(255,255,255,0.02)', borderRadius: 10, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.05)' }}>
              {[
                { label: 'Status', value: selectedNode.status?.toUpperCase() ?? 'N/A', color: '#10b981' },
                { label: 'Region', value: selectedNode.region },
                { label: 'Cloud Account', value: selectedNode.account_name },
                { label: 'Est. Cost', value: selectedNode.cost > 0 ? `$${Number(selectedNode.cost).toFixed(2)}/mo` : 'N/A' },
                { label: 'Resource ID', value: selectedNode.provider_id, mono: true },
              ].map((row, i) => (
                <div key={row.label} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
                  padding: '9px 14px',
                  background: i % 2 === 0 ? 'rgba(255,255,255,0.015)' : 'transparent',
                  gap: 10,
                }}>
                  <span style={{ color: '#64748b', fontSize: 11, flexShrink: 0 }}>{row.label}</span>
                  <span style={{
                    color: row.color ?? '#e2e8f0',
                    fontSize: 11,
                    fontFamily: row.mono ? 'monospace' : 'inherit',
                    wordBreak: 'break-all',
                    textAlign: 'right',
                    fontWeight: row.color ? 700 : 400,
                  }}>
                    {row.value}
                  </span>
                </div>
              ))}
            </div>

            {/* Connections */}
            <ConnectionList title="📥 Inputs" connections={inbound} onSelect={setSelectedNodeId} />
            <div style={{ marginTop: 12 }} />
            <ConnectionList title="📤 Outputs" connections={outbound} onSelect={setSelectedNodeId} />

            {/* CTA */}
            <button
              onClick={() => navigate(`/cloud/resources/${selectedNode.id}`)}
              style={S.detailsBtn}
            >
              View Full Resource Details <ExternalLink size={13} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

// ── Connection list sub-component ─────────────────────────────────
function ConnectionList({ title, connections, onSelect }: {
  title: string;
  connections: Array<{ edge: any; node: any }>;
  onSelect: (id: string) => void;
}) {
  return (
    <div style={{ marginBottom: 4 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>
        {title} <span style={{ color: '#334155', fontWeight: 600 }}>({connections.length})</span>
      </div>
      {connections.length === 0
        ? <div style={{ color: '#334155', fontSize: 12, fontStyle: 'italic', paddingLeft: 4 }}>None</div>
        : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {connections.map((c, i) => {
              const m = TYPE_META[c.node.type] ?? { icon: '☁️', color: '#94a3b8' };
              return (
                <div
                  key={i}
                  onClick={() => onSelect(c.node.id)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '7px 10px',
                    background: 'rgba(255,255,255,0.025)',
                    border: '1px solid rgba(255,255,255,0.05)',
                    borderRadius: 8, cursor: 'pointer',
                    transition: 'background 0.15s',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.05)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.025)')}
                >
                  <span style={{ fontSize: 14, flexShrink: 0 }}>{m.icon}</span>
                  <span style={{ color: '#94a3b8', fontSize: 11, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {c.node.name}
                  </span>
                  <span style={{ fontSize: 9, color: m.color, background: `${m.color}15`, padding: '2px 7px', borderRadius: 5, fontWeight: 700, flexShrink: 0 }}>
                    {c.edge.type}
                  </span>
                </div>
              );
            })}
          </div>
        )
      }
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────
const S: Record<string, React.CSSProperties> = {
  page: {
    height: '100vh',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    background: 'linear-gradient(160deg, #0d1117 0%, #0f1923 55%, #0d1117 100%)',
    padding: '24px 28px 0',
    fontFamily: "'Inter', -apple-system, sans-serif",
    boxSizing: 'border-box',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 12,
    flexShrink: 0,
  },
  backBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '5px 12px',
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: 7,
    color: '#94a3b8',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
    marginBottom: 6,
  },
  title: {
    margin: '0 0 2px',
    fontSize: 26,
    fontWeight: 800,
    color: '#f1f5f9',
    letterSpacing: -0.5,
  },
  subtitle: {
    margin: 0,
    color: '#475569',
    fontSize: 13,
  },
  searchBox: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    background: 'rgba(255,255,255,0.03)',
    border: '1px solid rgba(255,255,255,0.09)',
    borderRadius: 9,
    padding: '7px 12px',
    width: 210,
  },
  searchInput: {
    background: 'none',
    border: 'none',
    outline: 'none',
    color: '#e2e8f0',
    fontSize: 13,
    width: '100%',
    fontFamily: 'inherit',
  },
  clearBtn: {
    background: 'none',
    border: 'none',
    color: '#475569',
    cursor: 'pointer',
    padding: 0,
    display: 'flex',
    alignItems: 'center',
  },
  select: {
    background: 'rgba(15,23,42,0.8)',
    border: '1px solid rgba(255,255,255,0.09)',
    borderRadius: 9,
    color: '#e2e8f0',
    fontSize: 13,
    padding: '7px 12px',
    fontFamily: 'inherit',
    outline: 'none',
    cursor: 'pointer',
  },
  iconBtn: {
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid rgba(255,255,255,0.09)',
    borderRadius: 9,
    color: '#94a3b8',
    padding: '7px 10px',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
  },
  legend: {
    display: 'flex',
    alignItems: 'center',
    gap: 20,
    padding: '8px 14px',
    background: 'rgba(255,255,255,0.02)',
    border: '1px solid rgba(255,255,255,0.05)',
    borderRadius: 10,
    marginBottom: 14,
    flexShrink: 0,
    flexWrap: 'wrap',
  },
  mainArea: {
    display: 'flex',
    gap: 16,
    flex: 1,
    minHeight: 0,
    paddingBottom: 24,
  },
  canvas: {
    position: 'relative',
    background: 'rgba(10,15,30,0.5)',
    border: '1px solid rgba(255,255,255,0.06)',
    borderRadius: 16,
    overflow: 'hidden',
    minHeight: 0,
    userSelect: 'none',
    transition: 'flex 0.3s ease',
  },
  colHeaders: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 46,
    display: 'flex',
    alignItems: 'center',
    background: 'rgba(0,0,0,0.28)',
    borderBottom: '1px solid rgba(255,255,255,0.04)',
    pointerEvents: 'none',
    zIndex: 5,
  },
  colHeaderCell: {
    flex: 1,
    textAlign: 'center',
    fontSize: 11,
    fontWeight: 700,
    textTransform: 'uppercase',
    color: '#64748b',
    letterSpacing: 0.8,
  },
  zoomControls: {
    position: 'absolute',
    bottom: 20,
    left: 16,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 4,
    background: 'rgba(12,18,36,0.92)',
    border: '1px solid rgba(255,255,255,0.07)',
    borderRadius: 10,
    padding: '6px 4px',
    zIndex: 10,
  },
  zoomBtn: {
    width: 30,
    height: 30,
    borderRadius: 6,
    border: 'none',
    background: 'transparent',
    color: '#94a3b8',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    transition: 'all 0.15s',
  },
  loadingOverlay: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 8,
  },
  spinner: {
    width: 40,
    height: 40,
    borderRadius: '50%',
    border: '3px solid rgba(96,165,250,0.15)',
    borderTopColor: '#60a5fa',
    animation: 'spin 0.9s linear infinite',
  },
  sidebar: {
    width: 310,
    flexShrink: 0,
    background: 'linear-gradient(175deg, rgba(18,26,46,0.98) 0%, rgba(10,15,30,0.99) 100%)',
    border: '1px solid rgba(255,255,255,0.07)',
    borderRadius: 16,
    padding: '20px 18px',
    display: 'flex',
    flexDirection: 'column',
    gap: 0,
    overflowY: 'auto',
    boxShadow: '-8px 0 28px rgba(0,0,0,0.4)',
  },
  closeBtn: {
    width: 28,
    height: 28,
    borderRadius: 7,
    border: '1px solid rgba(255,255,255,0.08)',
    background: 'rgba(255,255,255,0.04)',
    color: '#64748b',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    flexShrink: 0,
    transition: 'all 0.15s',
  },
  detailsBtn: {
    marginTop: 18,
    width: '100%',
    padding: '11px',
    borderRadius: 10,
    border: 'none',
    background: 'rgba(96,165,250,0.12)',
    color: '#60a5fa',
    fontSize: 13,
    fontWeight: 700,
    cursor: 'pointer',
    fontFamily: 'inherit',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    transition: 'background 0.15s',
  },
};
