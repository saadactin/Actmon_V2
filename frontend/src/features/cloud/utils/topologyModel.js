/**
 * Presentation vocabulary for the topology — one definition per edge kind,
 * resource type, category, provider and health state.
 *
 * The renderer, the legend, the tooltips and the filter dropdowns all read from
 * here, so the legend cannot claim a relationship the renderer does not draw.
 * The previous version defined edge styling in the page component and the
 * relationship semantics in the Python service, and the two had already
 * drifted — the page carried a style for an `unknown` kind the service never
 * emitted.
 *
 * ## Why type colours are literal hex and the chrome is not
 *
 * A node's colour has to mean the same resource type in every theme, so
 * TYPE_META and EDGE_STYLE are pinned hex, deliberately outside the token
 * system. The card *around* it is a different matter: it was also pinned
 * (`fill="#ffffff"`, text `#0f172a`), which made every node in the graph a
 * white rectangle with near-black text in dark mode — unreadable. Chrome now
 * uses the theme variables, which SVG resolves like any other CSS custom
 * property.
 */
import { UNKNOWN_COLOR, providerBadgeStyle, providerColor } from './providerTheme';

/* ── Edge styling ─────────────────────────────────────────────────────────── */
/* `dash` marks a relationship that is not observed traffic. A permission is
   the important case: it says "is allowed to reach", never "does reach". */
export const EDGE_STYLE = {
  contains: { color: '#14b8a6', label: 'Contains' },
  network: { color: '#0ea5e9', label: 'Network / subnet' },
  security: { color: '#eab308', label: 'Security group' },
  role: { color: '#94a3b8', label: 'Assumes role' },
  attached: { color: '#f97316', label: 'Storage attached' },
  'routes-to': { color: '#ec4899', label: 'Routes to' },
  dataflow: { color: '#10b981', label: 'Data flow / trigger', dash: '6,6' },
  permission: { color: '#8b5cf6', label: 'Can access (IAM)', dash: '2,5' },
  'managed-by': { color: '#a3a3a3', label: 'Managed by', dash: '4,4' },
  'encrypted-by': { color: '#7c3aed', label: 'Encrypted by' },
  protects: { color: '#f59e0b', label: 'Protects' },
  'peers-with': { color: '#06b6d4', label: 'Peers with' },
  unknown: { color: '#9ca3af', label: 'Other' },
};

export const edgeStyle = (type) => EDGE_STYLE[type] || EDGE_STYLE.unknown;

/* ── Resource type styling ────────────────────────────────────────────────── */
export const TYPE_META = {
  // ── AWS ──
  EC2Instance: { color: '#f59e0b', label: 'EC2 Instance' },
  S3Bucket: { color: '#3b82f6', label: 'S3 Bucket' },
  LambdaFunction: { color: '#a855f7', label: 'Lambda' },
  DynamoDBTable: { color: '#10b981', label: 'DynamoDB Table' },
  RDSInstance: { color: '#06b6d4', label: 'RDS Database' },
  AuroraCluster: { color: '#06b6d4', label: 'Aurora Cluster' },
  DocumentDBCluster: { color: '#06b6d4', label: 'DocumentDB Cluster' },
  NeptuneCluster: { color: '#06b6d4', label: 'Neptune Cluster' },
  RedshiftCluster: { color: '#06b6d4', label: 'Redshift Cluster' },
  ElastiCacheRedis: { color: '#f97316', label: 'ElastiCache (Redis)' },
  ElastiCacheMemcached: { color: '#f97316', label: 'ElastiCache (Memcached)' },
  EKSCluster: { color: '#6366f1', label: 'EKS Cluster' },
  LoadBalancer: { color: '#ec4899', label: 'Load Balancer' },
  NetworkLoadBalancer: { color: '#ec4899', label: 'Network Load Balancer' },
  SecurityGroup: { color: '#eab308', label: 'Security Group' },
  VPC: { color: '#14b8a6', label: 'VPC Network' },
  Subnet: { color: '#5eead4', label: 'Subnet' },
  SecurityList: { color: '#eab308', label: 'Security List' },
  RouteTable: { color: '#a3a3a3', label: 'Route Table' },
  DhcpOptions: { color: '#a3a3a3', label: 'DHCP Options' },
  IAMRole: { color: '#64748b', label: 'IAM Role' },
  EBSVolume: { color: '#3b82f6', label: 'EBS Volume' },
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
  AvailabilitySet: { color: '#0078D4', label: 'Availability Set' },
  // ── OCI ──
  ComputeInstance: { color: '#f59e0b', label: 'Compute Instance' },
  BlockVolume: { color: '#3b82f6', label: 'Block Volume' },
  BootVolume: { color: '#3b82f6', label: 'Boot Volume' },
  ObjectStorageBucket: { color: '#3b82f6', label: 'Object Storage' },
  FileSystem: { color: '#3b82f6', label: 'File System' },
  AutonomousDatabase: { color: '#10b981', label: 'Autonomous DB' },
  DbSystem: { color: '#0d9488', label: 'DB System' },
  MySQLDbSystem: { color: '#0d9488', label: 'MySQL DB System' },
  NoSQLTable: { color: '#10b981', label: 'NoSQL Table' },
  AnalyticsInstance: { color: '#0ea5e9', label: 'Analytics Instance' },
  WebAppFirewall: { color: '#eab308', label: 'Web App Firewall' },
  VirtualCircuit: { color: '#14b8a6', label: 'Virtual Circuit' },
  DrgAttachment: { color: '#14b8a6', label: 'DRG Attachment' },
  VCN: { color: '#14b8a6', label: 'Virtual Cloud Network' },
  Function: { color: '#a855f7', label: 'OCI Function' },
  OKECluster: { color: '#6366f1', label: 'OKE Cluster' },
  IAMGroup: { color: '#64748b', label: 'IAM Group' },
  IAMPolicy: { color: '#64748b', label: 'IAM Policy' },
  Compartment: { color: '#0078D4', label: 'Compartment' },
};

export const typeMeta = (type) => TYPE_META[type] || { color: '#94a3b8', label: type || 'Unknown' };

/* ── Categories ───────────────────────────────────────────────────────────── */
/* The column a node lands in, and the category filter's options. Mirrors
   app/topology/model.py's NODE_CATEGORY groupings. */
export const CATEGORY_META = {
  Network: { color: '#0ea5e9', icon: 'network' },
  Compute: { color: '#f59e0b', icon: 'server' },
  Storage: { color: '#3b82f6', icon: 'database' },
  Database: { color: '#10b981', icon: 'database' },
  Identity: { color: '#64748b', icon: 'user' },
  Security: { color: '#eab308', icon: 'shield' },
  Container: { color: '#6366f1', icon: 'box' },
  Application: { color: '#a855f7', icon: 'layers' },
  Integration: { color: '#ec4899', icon: 'route' },
  Monitoring: { color: '#0ea5e9', icon: 'activity' },
  Analytics: { color: '#0ea5e9', icon: 'chart-bar' },
  'AI / ML': { color: '#10b981', icon: 'sparkles' },
  Organization: { color: '#0078D4', icon: 'folder' },
  Other: { color: '#94a3b8', icon: 'box' },
};

export const CATEGORY_ORDER = [
  'Organization', 'Network', 'Security', 'Identity', 'Compute', 'Container',
  'Application', 'Integration', 'Storage', 'Database', 'Analytics', 'AI / ML',
  'Monitoring', 'Other',
];

/* ── Providers ────────────────────────────────────────────────────────────── */
/* Brand colours stay pinned (external identity) but are applied through
   `utils/providerTheme`, which mixes them against the live theme instead of
   shipping the fixed light-palette swatches this map used to carry — those
   rendered as near-white chips on the three dark themes. The provider NAME is
   always rendered as text beside any colour, because colour alone is not an
   accessible way to say which cloud a resource is in. */
export const PROVIDER_META = {
  AWS: { color: providerColor('AWS'), badgeStyle: providerBadgeStyle('AWS'), label: 'AWS' },
  Azure: { color: providerColor('Azure'), badgeStyle: providerBadgeStyle('Azure'), label: 'Azure' },
  OCI: { color: providerColor('OCI'), badgeStyle: providerBadgeStyle('OCI'), label: 'OCI' },
  Oracle: { color: providerColor('OCI'), badgeStyle: providerBadgeStyle('OCI'), label: 'OCI' },
  Unknown: { color: UNKNOWN_COLOR, badgeStyle: providerBadgeStyle(null), label: 'Unknown' },
};

export const providerMeta = (provider) => PROVIDER_META[provider] || PROVIDER_META.Unknown;

/* ── Health ───────────────────────────────────────────────────────────────── */
/* Unknown is a first-class state, not a soft failure. A resource whose status
   the provider did not report has an unknown health, and saying so is the
   whole point — "it exists so it must be fine" is the inference the backend
   refuses to make and the UI must not undo. */
/* Health is OUR vocabulary, not a vendor's, so unlike the provider hues above it
   belongs to the theme: these read from the fixed status scale in tokens.css
   (`--status-*`), the same five steps the agents list, the infra hosts and every
   gauge grade against. The hexes that used to sit here (#16a34a, #dc2626, …)
   were a sixth, private opinion about what "Failed" looks like. */
export const HEALTH_META = {
  Healthy: { tone: 'success', color: 'var(--status-good)', label: 'Healthy' },
  Warning: { tone: 'warning', color: 'var(--status-warning)', label: 'In transition' },
  Degraded: { tone: 'warning', color: 'var(--status-serious)', label: 'Degraded' },
  Failed: { tone: 'danger', color: 'var(--status-critical)', label: 'Failed' },
  Stopped: { tone: 'neutral', color: 'var(--status-unknown)', label: 'Stopped' },
  Unknown: { tone: 'neutral', color: 'var(--status-unknown)', label: 'Not reported' },
};

export const healthMeta = (health) => HEALTH_META[health] || HEALTH_META.Unknown;

export const HEALTH_OPTIONS = [
  { id: '', label: 'Any health' },
  ...Object.keys(HEALTH_META).map((id) => ({ id, label: HEALTH_META[id].label })),
];

/* ── View modes and layouts ───────────────────────────────────────────────── */
export const VIEW_MODES = [
  { id: 'infrastructure', label: 'Infrastructure' },
  { id: 'network', label: 'Network' },
  { id: 'security', label: 'Security' },
  { id: 'dataflow', label: 'Data flow' },
  { id: 'identity', label: 'Identity' },
];

export const LAYOUTS = [
  { id: 'architecture', label: 'Architecture', hint: 'Network → Compute → Storage, in three columns' },
  { id: 'hierarchical', label: 'Hierarchical', hint: 'Containers above what they contain' },
  { id: 'radial', label: 'Radial', hint: 'Selected resource at the centre, neighbours in rings' },
  { id: 'dependency', label: 'Dependency', hint: 'Upstream on the left, downstream on the right' },
];

export const HOP_OPTIONS = [
  { id: '1', label: '1 hop' },
  { id: '2', label: '2 hops' },
  { id: '3', label: '3 hops' },
  { id: '99', label: 'All' },
];

/* ── Small formatters ─────────────────────────────────────────────────────── */

export const formatCount = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString());

/** A percentage that is honest about not existing. `null` means "nothing to
    measure", which must not render as 0% or 100%. */
export const formatPct = (value) => (value === null || value === undefined ? 'Not applicable' : `${value}%`);

export function formatMoment(iso) {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const day = String(date.getDate()).padStart(2, '0');
  const month = date.toLocaleString('en-GB', { month: 'short' });
  const time = date.toLocaleTimeString('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit' });
  return `${day}-${month}-${date.getFullYear()} ${time}`;
}

export function formatAge(seconds) {
  if (seconds === null || seconds === undefined) return null;
  if (seconds < 60) return 'just now';
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Truncate for an SVG label, which cannot wrap or ellipsize itself. */
export const clip = (text, max) => {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};

/* ── Isolation and reference reasons ──────────────────────────────────────── */
/* Short labels for the backend's reason keys. The long explanation comes from
   the API so there is exactly one wording of it. */
export const ISOLATION_LABEL = {
  wildcard_permission: 'Wildcard IAM grant',
  references_unresolved: 'References something undiscovered',
  no_relationship_fields: 'No relationship data collected',
  standalone_resource: 'Genuinely standalone',
  empty_container: 'Empty container',
};

export const REFERENCE_CLASS_LABEL = {
  missing_target: 'Target not discovered',
  unsupported_type: 'Resource type not collected',
};

/* ── Node badges ──────────────────────────────────────────────────────────── */
/**
 * The indicator chips a node carries, derived only from fields the API sent.
 *
 * Every badge is backed by a real measurement: drift comes from the
 * append-only change log, events from the audit trail, exposure from the
 * exposure engine's evaluation of the security groups actually attached. There
 * is no badge that means "probably".
 */
export function nodeBadges(node) {
  const badges = [];
  if (node.exposed) {
    badges.push({
      id: 'exposed',
      label: node.exposure_severity ? `Public (${node.exposure_severity})` : 'Public',
      tone: node.exposure_severity === 'CRITICAL' || node.exposure_severity === 'HIGH' ? 'danger' : 'warning',
      title: `Reachable from the internet on ${(node.exposure_open_ports || []).length || 'one or more'} world-open port(s).`,
    });
  }
  if (node.significant_drift_count > 0) {
    badges.push({
      id: 'drift',
      label: `${node.significant_drift_count} significant change${node.significant_drift_count === 1 ? '' : 's'}`,
      tone: 'warning',
      title: 'High or critical severity configuration changes recorded for this resource.',
    });
  } else if (node.drift_count > 0) {
    badges.push({
      id: 'drift',
      label: `${node.drift_count} change${node.drift_count === 1 ? '' : 's'}`,
      tone: 'info',
      title: 'Configuration changes recorded for this resource.',
    });
  }
  if (node.high_risk_event_count > 0) {
    badges.push({
      id: 'events',
      label: `${node.high_risk_event_count} high-risk event${node.high_risk_event_count === 1 ? '' : 's'}`,
      tone: 'danger',
      title: `Audit events at HIGH or CRITICAL risk in the last ${node.event_window_days || 30} days.`,
    });
  } else if (node.event_count > 0) {
    badges.push({
      id: 'events',
      label: `${node.event_count} event${node.event_count === 1 ? '' : 's'}`,
      tone: 'neutral',
      title: `Audit events in the last ${node.event_window_days || 30} days.`,
    });
  }
  if (node.broad_access?.length) {
    badges.push({
      id: 'broad',
      label: 'Wildcard IAM grant',
      tone: 'warning',
      title: 'Its identity grants access with a wildcard, so no per-resource edge can be drawn.',
    });
  }
  if (node.is_default) {
    badges.push({
      id: 'default',
      label: 'Provider default',
      tone: 'neutral',
      title: 'Created by the cloud provider rather than by your team.',
    });
  }
  if (node.is_synthetic) {
    badges.push({
      id: 'synthetic',
      label: 'Container',
      tone: 'neutral',
      title: 'An organizational grouping derived from the resource identifier, not a resource the provider returned.',
    });
  }
  return badges;
}
