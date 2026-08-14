/**
 * ADD-SERVER catalogue.
 *
 * Same option lists, values and order as the existing Add OS Server page — the
 * strings are what the API stores, so they are copied exactly. Only the colours
 * changed: per-item Tailwind palette classes became semantic tones, and database
 * services reuse the validated engine slots from config/agents.js.
 */
import { engineColor } from './agents';

/** Order and labels exactly as the existing page offers them. */
export const OPERATING_SYSTEMS = [
  { name: 'Linux', icon: '🐧' },
  { name: 'Ubuntu', icon: '🟠' },
  { name: 'Windows', icon: '🪟' },
  { name: 'CentOS', icon: '⚫' },
  { name: 'Oracle Linux', icon: '🔴' },
  { name: 'RedHat', icon: '🎩' },
];

/** `name` is stored in database_services — do not rename. */
export const DATABASE_SERVICES = [
  { name: 'MySQL', engine: 'MySQL' },
  { name: 'MariaDB', engine: 'MySQL' },
  { name: 'PostgreSQL', engine: 'PostgreSQL' },
  { name: 'Oracle', engine: 'Oracle' },
  { name: 'MongoDB', engine: 'MongoDB' },
  { name: 'MSSQL', engine: 'MSSQL' },
  { name: 'ClickHouse', engine: 'ClickHouse' },
];

export const serviceColor = (name) => {
  const svc = DATABASE_SERVICES.find((s) => s.name === name);
  return engineColor(svc?.engine || name);
};

/** `value` is stored in node_type. `tone` replaces the old per-type colour classes. */
export const NODE_TYPES = [
  { value: 'Standalone', label: 'Standalone', icon: '○', desc: 'Single server, no HA', tone: 'neutral' },
  { value: 'Primary', label: 'Primary', icon: '★', desc: 'Replication primary / source', tone: 'success' },
  { value: 'Secondary', label: 'Secondary', icon: '◎', desc: 'Replication replica', tone: 'info' },
  { value: 'Master', label: 'Master', icon: '▲', desc: 'Legacy master node', tone: 'success' },
  { value: 'Slave', label: 'Slave', icon: '▽', desc: 'Legacy replica', tone: 'info' },
  { value: 'Galera Node', label: 'Galera Node', icon: '⬡', desc: 'Galera / PXC multi-primary', tone: 'accent' },
  { value: 'Arbiter', label: 'Arbiter', icon: '◇', desc: 'Quorum / tiebreaker, no data', tone: 'warning' },
  { value: 'Cluster Node', label: 'Cluster Node', icon: '⬡', desc: 'Generic cluster member', tone: 'neutral' },
];

export const ENVIRONMENTS = ['Production', 'UAT', 'Development', 'Testing'];

/** Form defaults — identical to the existing page's useForm defaultValues. */
export const SERVER_FORM_DEFAULTS = {
  ssh_port: 22,
  environment: 'Production',
  node_type: 'Standalone',
  monitoring_enabled: true,
  auto_discovery: true,
};

/** Wizard steps. The agent path stops at Connection and hands off to Add Data. */
export const SSH_STEPS = [
  'Connection', 'Operating System', 'Server Identity', 'SSH Access', 'Node Role', 'Services',
  'Add Connection', 'Review',
];
export const AGENT_STEPS = ['Connection'];

/**
 * First selected DB service → the servers route to land on after registering.
 * Same mapping the existing page uses.
 */
export const TECH_ROUTE = {
  MySQL: 'mysql',
  MariaDB: 'mysql',
  PostgreSQL: 'postgresql',
  Oracle: 'oracle',
  MSSQL: 'mssql',
  MongoDB: 'mongodb',
  ClickHouse: 'clickhouse',
};

/** Build the exact createOsServer payload the existing page sends. */
export function toServerPayload({ data, selectedOs, selectedDbs, collector }) {
  const payload = {
    server_name: data.server_name,
    hostname: data.hostname || data.ip_address,
    ip_address: data.ip_address,
    os_type: selectedOs,
    environment: data.environment,
    node_type: data.node_type,
    cluster_name: data.cluster_name || null,
    database_services: selectedDbs,
    monitoring_enabled: data.monitoring_enabled === true || data.monitoring_enabled === 'true',
    auto_discovery: data.auto_discovery === true || data.auto_discovery === 'true',
    collector,
  };
  if (collector === 'ssh') {
    payload.ssh_port = Number(data.ssh_port) || 22;
    payload.ssh_username = data.ssh_username;
    payload.ssh_password = data.ssh_password;
  }
  return payload;
}
