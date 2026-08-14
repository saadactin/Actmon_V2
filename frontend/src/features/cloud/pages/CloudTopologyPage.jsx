import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { ZoomIn, ZoomOut } from 'lucide-react';
import { useTopology } from '../hooks/useTopology';
import { useCloudScope } from '../hooks/useCloudScope';
import CloudPageHeader from '../components/CloudPageHeader';
import CloudToolbar from '../components/CloudToolbar';
import CloudSection from '../components/CloudSection';
import Icon from '@/components/ui/Icon';
import IconButton from '@/components/ui/IconButton';
import Button from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Loading';

// ── Type Metadata ──────────────────────────────────────────────────
// NOTE: these are literal hex values, not theme tokens — they colour the
// SVG graph itself (nodes/edges/legend swatches) and must stay pixel-identical
// across themes so a node's colour always means the same resource type.
const TYPE_META = {
  // ── AWS ──
  EC2Instance: { color: '#f59e0b', label: 'EC2 Instance' },
  S3Bucket: { color: '#3b82f6', label: 'S3 Bucket' },
  LambdaFunction: { color: '#a855f7', label: 'Lambda' },
  DynamoDBTable: { color: '#10b981', label: 'DynamoDB Table' },
  RDSInstance: { color: '#06b6d4', label: 'RDS Database' },
  EKSCluster: { color: '#6366f1', label: 'EKS Cluster' },
  LoadBalancer: { color: '#ec4899', label: 'Load Balancer' },
  SecurityGroup: { color: '#eab308', label: 'Security Group' },
  VPC: { color: '#14b8a6', label: 'VPC Network' },
  IAMRole: { color: '#64748b', label: 'IAM Role' },
  APIGateway: { color: '#ec4899', label: 'API Gateway' },
  BedrockModel: { color: '#10b981', label: 'Bedrock Model' },
  BedrockAgent: { color: '#ec4899', label: 'Bedrock Agent' },
  BedrockKnowledgeBase: { color: '#3b82f6', label: 'Bedrock KB' },
  // ── Azure ──
  VirtualMachine: { color: '#0078D4', label: 'Virtual Machine' },
  StorageAccount: { color: '#3b82f6', label: 'Storage Account' },
  SQLDatabase: { color: '#10b981', label: 'SQL Database' },
  AKSCluster: { color: '#6366f1', label: 'AKS Cluster' },
  AppService: { color: '#a855f7', label: 'App Service' },
  FunctionApp: { color: '#a855f7', label: 'Function App' },
  VirtualNetwork: { color: '#14b8a6', label: 'Virtual Network' },
  NetworkSecurityGroup: { color: '#eab308', label: 'Network Security Group' },
  PublicIP: { color: '#06b6d4', label: 'Public IP' },
  NetworkInterface: { color: '#14b8a6', label: 'Network Interface' },
  ResourceGroup: { color: '#0078D4', label: 'Resource Group' },
  ManagedDisk: { color: '#06b6d4', label: 'Managed Disk' },
  KeyVault: { color: '#eab308', label: 'Key Vault' },
  CosmosDB: { color: '#10b981', label: 'Cosmos DB' },
  RedisCache: { color: '#ef4444', label: 'Redis Cache' },
  SQLServer: { color: '#10b981', label: 'SQL Server' },
  MySQLServer: { color: '#06b6d4', label: 'MySQL Server' },
  PostgreSQLServer: { color: '#3b82f6', label: 'PostgreSQL Server' },
  ContainerRegistry: { color: '#6366f1', label: 'Container Registry' },
  AppServicePlan: { color: '#a855f7', label: 'App Service Plan' },
  ApplicationGateway: { color: '#ec4899', label: 'App Gateway' },
  LogAnalytics: { color: '#0ea5e9', label: 'Log Analytics' },
  AppInsights: { color: '#0ea5e9', label: 'App Insights' },
  LogicApp: { color: '#a855f7', label: 'Logic App' },
  ManagedIdentity: { color: '#64748b', label: 'Managed Identity' },
  PrivateEndpoint: { color: '#14b8a6', label: 'Private Endpoint' },
  EventHub: { color: '#f59e0b', label: 'Event Hub' },
  ServiceBus: { color: '#f59e0b', label: 'Service Bus' },
  APIManagement: { color: '#ec4899', label: 'API Management' },
  VMScaleSet: { color: '#0078D4', label: 'VM Scale Set' },
  RecoveryVault: { color: '#0ea5e9', label: 'Recovery Vault' },
  // ── OCI ── (types as emitted by the OCI scanner)
  ComputeInstance: { color: '#f59e0b', label: 'Compute Instance' },
  BlockVolume: { color: '#3b82f6', label: 'Block Volume' },
  ObjectStorageBucket: { color: '#3b82f6', label: 'Object Storage' },
  AutonomousDatabase: { color: '#10b981', label: 'Autonomous DB' },
  VCN: { color: '#14b8a6', label: 'Virtual Cloud Network' },
  Function: { color: '#a855f7', label: 'OCI Function' },
  OKECluster: { color: '#6366f1', label: 'OKE Cluster' },
  IAMGroup: { color: '#64748b', label: 'IAM Group' },
  IAMPolicy: { color: '#64748b', label: 'IAM Policy' },
  // Synthetic grouping hub — one per OCI compartment (and reused label style
  // for Azure resource groups)
  Compartment: { color: '#0078D4', label: 'Compartment' },
};

const CARD_W = 200;
const CARD_H = 68;

export const CloudTopologyPage = ({ embedded = false }) => {
  const navigate = useNavigate();
  // Scope-aware (see useCloudScope) — topology stays on the chosen provider.
  const scope = useCloudScope();
  const accounts = scope.scopedAccounts;
  const selectedAccountId = scope.accountId;
  const setSelectedAccountId = scope.setAccountScope;

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedNodeId, setSelectedNodeId] = useState(null);
  const [hoveredNodeId, setHoveredNodeId] = useState(null);
  const [accountView, setAccountView] = useState('ALL');

  // ── Zoom / Pan ─────────────────────────────────────────────────
  const [zoom, setZoom] = useState(0.85);
  const [pan, setPan] = useState({ x: 60, y: 56 });
  const [isDragging, setIsDragging] = useState(false);
  const dragMoved = useRef(false);
  const dragStart = useRef({ x: 0, y: 0, px: 0, py: 0 });
  const canvasRef = useRef(null);

  // 'ALL' must not cross provider boundaries while a provider is scoped.
  const currentAccountView = accountView === 'ALL'
    ? (scope.isScoped ? (selectedAccountId ?? 'ALL') : 'ALL')
    : accountView;
  const setCurrentAccountView = setAccountView;

  const { data: topology, isLoading, refetch } = useTopology(currentAccountView);

  const nodes = topology?.nodes || [];
  const edges = topology?.edges || [];

  // ── Layout columns ─────────────────────────────────────────────
  // Identity & Network — firewalls, networks, roles (AWS + Azure + OCI)
  const col1Types = [
    'VPC', 'SecurityGroup', 'IAMRole',
    'VirtualNetwork', 'NetworkSecurityGroup', 'PublicIP', 'NetworkInterface',
    'VCN', 'ResourceGroup', 'Compartment', 'IAMGroup', 'IAMPolicy',
    'LoadBalancer', 'ApplicationGateway', 'PrivateEndpoint', 'ManagedIdentity',
    'NATGateway', 'DNSZone', 'Bastion', 'RouteTable',
  ];
  // Compute & Logic — VMs, functions, clusters, gateways (AWS + Azure + OCI)
  const col2Types = [
    'EC2Instance', 'LambdaFunction', 'EKSCluster', 'APIGateway',
    'VirtualMachine', 'AKSCluster', 'AppService', 'FunctionApp',
    'Instance', 'ComputeInstance', 'Function', 'OKECluster',
    'VMScaleSet', 'AppServicePlan', 'LogicApp', 'APIManagement',
    'ContainerRegistry',
  ];
  // Storage & Database — everything else (StorageAccount, SQLDatabase, buckets, tables…)

  const col1Nodes = nodes.filter((n) => col1Types.includes(n.type));
  const col2Nodes = nodes.filter((n) => col2Types.includes(n.type));
  const col3Nodes = nodes.filter((n) => !col1Types.includes(n.type) && !col2Types.includes(n.type));

  const maxNodes = Math.max(col1Nodes.length, col2Nodes.length, col3Nodes.length, 1);
  const canvasHeight = Math.max(700, maxNodes * 96 + 120);

  const nodePositions = {};

  const spacingY = (arr) => (canvasHeight - 120) / Math.max(arr.length, 1);

  col1Nodes.forEach((n, i) => {
    nodePositions[n.id] = { x: 200, y: 80 + i * spacingY(col1Nodes) + spacingY(col1Nodes) / 2 };
  });
  col2Nodes.forEach((n, i) => {
    nodePositions[n.id] = { x: 650, y: 80 + i * spacingY(col2Nodes) + spacingY(col2Nodes) / 2 };
  });
  col3Nodes.forEach((n, i) => {
    nodePositions[n.id] = { x: 1100, y: 80 + i * spacingY(col3Nodes) + spacingY(col3Nodes) / 2 };
  });

  // ── Pan/Zoom handlers (canvas-only, no page scroll) ────────────
  const handleMouseDown = useCallback((e) => {
    dragMoved.current = false;
    dragStart.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
    setIsDragging(true);
  }, [pan]);

  const handleMouseMove = useCallback((e) => {
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

  // Attach non-passive wheel listener to canvas div
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return undefined;
    const onWheel = (e) => {
      e.preventDefault();
      const factor = 1.08;
      setZoom((prev) => Math.max(0.3, Math.min(3, e.deltaY < 0 ? prev * factor : prev / factor)));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const resetView = () => { setZoom(0.85); setPan({ x: 60, y: 56 }); };

  // ── Highlighting ───────────────────────────────────────────────
  const getConnectedNodeIds = (nodeId) => {
    if (!nodeId) return new Set();
    const ids = new Set([nodeId]);
    edges.forEach((e) => {
      if (e.source === nodeId) ids.add(e.target);
      if (e.target === nodeId) ids.add(e.source);
    });
    return ids;
  };

  const activeNode = hoveredNodeId || selectedNodeId;
  const activeConnected = getConnectedNodeIds(activeNode);

  const isHighlighted = (id) => !activeNode || activeConnected.has(id);
  const isEdgeHighlighted = (e) => !activeNode || e.source === activeNode || e.target === activeNode;

  const matchesSearch = (n) => !searchQuery || n.name.toLowerCase().includes(searchQuery.toLowerCase())
    || n.type.toLowerCase().includes(searchQuery.toLowerCase());

  // ── Selected node detail ───────────────────────────────────────
  const selectedNode = nodes.find((n) => n.id === selectedNodeId);
  const selectedNodeMeta = selectedNode
    ? TYPE_META[selectedNode.type] ?? { color: '#94a3b8', label: selectedNode.type }
    : null;

  const inbound = selectedNodeId ? edges.filter((e) => e.target === selectedNodeId).map((e) => ({ edge: e, node: nodes.find((n) => n.id === e.source) })).filter((c) => c.node) : [];
  const outbound = selectedNodeId ? edges.filter((e) => e.source === selectedNodeId).map((e) => ({ edge: e, node: nodes.find((n) => n.id === e.target) })).filter((c) => c.node) : [];

  return (
    <div className="flex flex-col bg-bg">
      {/* ── Header ──────────────────────────────────────────────── */}
      {embedded ? (
        <div className="mb-4 flex shrink-0 items-center justify-end gap-2">
          <div className="flex h-control w-[210px] items-center gap-2 rounded-control border border-border bg-surface px-3 focus-within:ring-2 focus-within:ring-accent">
            <Icon name="search" size={14} className="shrink-0 text-subtle" />
            <input
              type="text"
              placeholder="Search resource…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-transparent border-none outline-none text-sm text-fg placeholder:text-subtle"
            />
            {searchQuery && (
              <button type="button" onClick={() => setSearchQuery('')} className="text-subtle hover:text-fg flex items-center shrink-0">
                <Icon name="close" size={12} />
              </button>
            )}
          </div>
          <IconButton icon="refresh" label="Refresh" onClick={() => refetch()} />
        </div>
      ) : (
        <CloudPageHeader
          className="shrink-0"
          backTo="/cloud"
          icon="network"
          title="Resource Topology Map"
          description="Visual dependency graph · drag to pan · scroll to zoom"
          actions={(
            <CloudToolbar
              selectorProps={accounts && accounts.length > 0 ? {
                accounts,
                mode: 'multi',
                selected: currentAccountView,
                onSelect: (id) => { setCurrentAccountView(id || 'ALL'); setSelectedNodeId(null); },
              } : undefined}
            >
              {/* Search */}
              <div className="flex h-control w-[210px] items-center gap-2 rounded-control border border-border bg-surface px-3 focus-within:ring-2 focus-within:ring-accent">
                <Icon name="search" size={14} className="shrink-0 text-subtle" />
                <input
                  type="text"
                  placeholder="Search resource…"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full bg-transparent border-none outline-none text-sm text-fg placeholder:text-subtle"
                />
                {searchQuery && (
                  <button type="button" onClick={() => setSearchQuery('')} className="text-subtle hover:text-fg flex items-center shrink-0">
                    <Icon name="close" size={12} />
                  </button>
                )}
              </div>

              {/* Refresh */}
              <IconButton icon="refresh" label="Refresh" onClick={() => refetch()} />
            </CloudToolbar>
          )}
        />
      )}

      {/* ── Legend ──────────────────────────────────────────────── */}
      <CloudSection className="mb-3 shrink-0" bodyClassName="flex items-center gap-4 flex-wrap">
        {[
          { color: '#eab308', label: 'Security edge' },
          { color: '#10b981', label: 'Data flow' },
          { color: '#14b8a6', label: 'Contains' },
          { color: '#9ca3af', label: 'IAM role' },
          { color: '#d1d5db', label: 'Default resource' },
        ].map((l) => (
          <div key={l.label} className="inline-flex items-center gap-1.5 text-xs text-muted">
            <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: l.color }} />
            {l.label}
          </div>
        ))}
        <div className="ml-auto inline-flex items-center gap-1.5 text-xs text-subtle">
          <Icon name="info" size={12} />
          {nodes.length} nodes · {edges.length} edges
        </div>
      </CloudSection>

      {/* ── Main area ─────────────────────────────────────────────
          Explicit height (not flex-1 off a viewport-height ancestor): this
          page renders inside AppShell's own scroll container, not a
          dedicated full-height shell, so sizing off 100vh here would
          overflow by the top-nav/tab-bar/header's height and force a
          second, outer scrollbar. */}
      <div className="flex gap-4 pb-6 h-[calc(100vh-19rem)] min-h-[420px]">

        {/* Canvas */}
        <div
          ref={canvasRef}
          className="relative rounded-card border border-border bg-surface overflow-hidden min-h-0 select-none transition-[flex] duration-300"
          style={{
            cursor: isDragging ? 'grabbing' : 'grab',
            flex: selectedNode ? '1 1 0%' : '1 1 100%',
          }}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
        >
          {/* Column headers */}
          <div className="absolute top-0 left-0 right-0 h-11 flex items-center bg-surface/95 border-b border-border pointer-events-none z-[5]">
            <div className="flex-1 text-center text-xs font-semibold uppercase tracking-wider text-muted">Identity &amp; Network</div>
            <div className="flex-1 text-center text-xs font-semibold uppercase tracking-wider text-muted">Compute &amp; Logic</div>
            <div className="flex-1 text-center text-xs font-semibold uppercase tracking-wider text-muted">Storage &amp; Database</div>
          </div>

          {/* Zoom controls */}
          <div className="absolute bottom-5 left-4 z-10 flex flex-col items-center gap-1.5 bg-surface border border-border rounded-control shadow-md p-1.5">
            <IconButton size="sm" label="Zoom in" onClick={() => setZoom((p) => Math.min(3, p + 0.12))}>
              <ZoomIn size={15} />
            </IconButton>
            <span className="text-[11px] font-semibold text-muted text-center leading-none">{Math.round(zoom * 100)}%</span>
            <IconButton size="sm" label="Zoom out" onClick={() => setZoom((p) => Math.max(0.3, p - 0.12))}>
              <ZoomOut size={15} />
            </IconButton>
            <div className="w-full h-px bg-border" />
            <IconButton size="sm" icon="expand" label="Reset view" onClick={resetView} />
          </div>

          {/* Loading state */}
          {isLoading && (
            <div className="absolute inset-0 z-[8] flex flex-col items-center justify-center gap-3">
              <Spinner size="lg" />
              <span className="text-sm text-muted">Building topology graph…</span>
            </div>
          )}

          {/* Empty state */}
          {!isLoading && nodes.length === 0 && (
            <div className="absolute inset-0 z-[8] flex flex-col items-center justify-center text-center px-6">
              <span className="p-3 rounded-full bg-sunken text-subtle mb-3">
                <Icon name="network" size={24} />
              </span>
              <h3 className="text-base font-semibold text-fg">No topology data</h3>
              <p className="text-sm text-muted mt-1">Run a discovery scan to build the dependency graph.</p>
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
              <marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
                <polygon points="0 0, 8 4, 0 8" fill="#94a3b8" />
              </marker>
              <marker id="arrow-highlight" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto">
                <polygon points="0 0, 9 4.5, 0 9" fill="currentColor" />
              </marker>
            </defs>

            <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`} style={{ pointerEvents: 'all' }}>

              {/* Edges */}
              {edges.map((edge) => {
                const sp = nodePositions[edge.source];
                const tp = nodePositions[edge.target];
                if (!sp || !tp) return null;

                const hl = isEdgeHighlighted(edge);
                const qm = !searchQuery || matchesSearch(nodes.find((n) => n.id === edge.source)) || matchesSearch(nodes.find((n) => n.id === edge.target));

                const x1 = sp.x + CARD_W / 2; const y1 = sp.y;
                const x2 = tp.x - CARD_W / 2; const y2 = tp.y;
                const mx = (x1 + x2) / 2;
                const d = `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;

                const colors = {
                  security: '#eab308',
                  dataflow: '#10b981',
                  contains: '#14b8a6',
                  role: '#94a3b8',
                };
                const c = colors[edge.type] || '#9ca3af';

                return (
                  <g key={edge.id} style={{ opacity: hl && qm ? 1 : 0.15, transition: 'opacity 0.25s' }}>
                    {hl && (
                      <path d={d} fill="none" stroke={c} strokeWidth="10" strokeOpacity="0.25"
                        style={{ filter: 'blur(6px)' }} />
                    )}
                    <path
                      d={d}
                      fill="none"
                      stroke={hl ? c : '#cbd5e1'}
                      strokeWidth={hl ? 3 : 2}
                      strokeDasharray={edge.type === 'dataflow' ? '6,6' : undefined}
                      markerEnd={hl ? 'url(#arrow-highlight)' : 'url(#arrow)'}
                      style={{ transition: 'stroke 0.2s, stroke-width 0.2s' }}
                    />
                  </g>
                );
              })}

              {/* Nodes */}
              {nodes.map((node) => {
                const pos = nodePositions[node.id];
                if (!pos) return null;

                const isDefault = node.is_default || node.name?.toLowerCase() === 'default';
                const meta = TYPE_META[node.type] ?? { color: '#94a3b8', label: node.type };
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
                      fill={isSel ? '#ffffff' : isDefault ? '#fafafa' : '#ffffff'}
                      stroke={isSel ? meta.color : isHov ? `${meta.color}aa` : isDefault ? '#cbd5e1' : '#e2e8f0'}
                      strokeWidth={isSel ? 3 : isHov ? 2 : 1.5}
                      strokeDasharray={isDefault ? '5,4' : undefined}
                      style={{
                        transition: 'all 0.18s',
                        filter: isSel ? `drop-shadow(0 4px 12px ${meta.color}40)` : isHov ? 'drop-shadow(0 2px 8px rgba(0,0,0,0.1))' : 'drop-shadow(0 1px 3px rgba(0,0,0,0.06))',
                      }}
                    />

                    {/* Category color accent bar (not an icon) */}
                    <rect x="0" y="0" width="5" height={CARD_H} rx="2.5"
                      fill={isDefault ? '#cbd5e1' : meta.color}
                    />

                    {/* Name */}
                    <text x="18" y="26"
                      fill={isDefault ? '#64748b' : '#0f172a'}
                      style={{ fontSize: 13, fontWeight: 800, fontFamily: 'system-ui, sans-serif' }}>
                      {node.name.length > 20 ? `${node.name.slice(0, 19)}…` : node.name}
                    </text>

                    {/* Type label */}
                    <text x="18" y="42"
                      fill={isDefault ? '#64748b' : meta.color}
                      style={{ fontSize: 11, fontWeight: 700, fontFamily: 'system-ui, sans-serif' }}>
                      {isDefault ? `${meta.label} · Default` : meta.label}
                    </text>

                    {/* Region */}
                    <text x="18" y="56"
                      fill="#64748b"
                      style={{ fontSize: 10, fontFamily: 'system-ui', fontWeight: 600 }}>
                      {node.region}
                    </text>

                    {/* Cost badge — only when a real billed cost exists (null = no billing data) */}
                    {typeof node.cost === 'number' && node.cost > 0 && (
                      <g transform={`translate(${CARD_W - 50}, ${CARD_H - 24})`}>
                        <rect width="46" height="18" rx="6" fill="#dcfce7" stroke="#86efac" strokeWidth="1.5" />
                        <text x="23" y="13" textAnchor="middle"
                          fill="#166534"
                          style={{ fontSize: 10, fontWeight: 800, fontFamily: 'system-ui' }}>
                          {node.cost.toFixed(0)}/mo
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
          <div className="w-80 shrink-0 rounded-card border border-border bg-surface p-5 flex flex-col overflow-y-auto">
            {/* Sidebar header with close */}
            <div className="flex items-start gap-3 mb-5">
              <div
                className="w-1.5 self-stretch min-h-10 rounded-full shrink-0"
                style={{ background: selectedNodeMeta.color }}
              />
              <div className="flex-1 min-w-0">
                <h3 className="text-[15px] font-semibold text-fg break-all leading-snug">
                  {selectedNode.name}
                </h3>
                <span className="text-[10px] font-bold uppercase tracking-wide" style={{ color: selectedNodeMeta.color }}>
                  {selectedNodeMeta.label}
                </span>
              </div>
              {/* Close button */}
              <IconButton icon="close" label="Close details" size="sm" onClick={() => setSelectedNodeId(null)} />
            </div>

            {/* Meta rows */}
            <dl className="border border-border rounded-control divide-y divide-border overflow-hidden mb-5">
              {[
                // status is null for types with no real status (buckets, IAM roles, ResourceGroup hubs…) → neutral N/A
                { label: 'Status', value: selectedNode.status?.toUpperCase() ?? 'N/A', accent: !!selectedNode.status },
                { label: 'Region', value: selectedNode.region || 'N/A' },
                { label: 'Cloud Account', value: selectedNode.account_name || 'N/A' },
                // cost is real billed spend when present; no currency field on topology nodes, so no '$' assertion
                { label: 'Monthly Cost', value: typeof selectedNode.cost === 'number' && selectedNode.cost > 0 ? `${Number(selectedNode.cost).toFixed(2)}/mo` : 'N/A' },
                { label: 'Resource ID', value: selectedNode.provider_id || 'N/A', mono: true },
              ].map((row) => (
                <div key={row.label} className="flex items-start justify-between gap-3 px-3.5 py-2.5">
                  <dt className="text-xs text-muted uppercase font-semibold shrink-0">{row.label}</dt>
                  <dd className={`text-right break-all ${
                    row.accent
                      ? 'text-sm font-semibold text-success-fg'
                      : row.mono
                        ? 'text-xs font-mono text-fg'
                        : 'text-sm text-fg'
                  }`}>
                    {row.value}
                  </dd>
                </div>
              ))}
            </dl>

            {/* Connections */}
            <ConnectionList title="Inputs" connections={inbound} onSelect={setSelectedNodeId} />
            <div className="mt-3" />
            <ConnectionList title="Outputs" connections={outbound} onSelect={setSelectedNodeId} />

            {/* CTA */}
            <Button
              variant="primary"
              className="mt-4 w-full"
              iconRight="external"
              onClick={() => navigate(`/cloud/resources/${selectedNode.id}`)}
            >
              View Full Resource Details
            </Button>
          </div>
        )}
      </div>
    </div>
  );
};

// ── Connection list sub-component ─────────────────────────────────
function ConnectionList({ title, connections, onSelect }) {
  return (
    <div className="mb-2">
      <div className="text-xs font-semibold text-muted uppercase tracking-wide mb-2">
        {title} <span className="text-subtle">({connections.length})</span>
      </div>
      {connections.length === 0
        ? <div className="text-sm text-subtle italic pl-1">None</div>
        : (
          <div className="flex flex-col gap-1.5">
            {connections.map((c, i) => {
              const m = TYPE_META[c.node.type] ?? { color: '#94a3b8' };
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => onSelect(c.node.id)}
                  className="w-full flex items-center gap-2.5 px-3 py-2 bg-surface border border-border rounded-control text-left cursor-pointer hover:bg-accent-soft hover:border-strong transition-colors"
                >
                  <span className="w-1 h-6 rounded-sm shrink-0" style={{ background: m.color }} />
                  <span className="flex-1 text-sm font-medium text-fg truncate">
                    {c.node.name}
                  </span>
                  <span
                    className="text-[10px] font-bold px-2 py-0.5 rounded-md shrink-0"
                    style={{ color: m.color, background: `${m.color}20` }}
                  >
                    {c.edge.type}
                  </span>
                </button>
              );
            })}
          </div>
        )}
    </div>
  );
}
