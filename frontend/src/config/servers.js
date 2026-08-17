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

/**
 * Per-engine Node Role / Database Topology option lists — the Node Role step
 * only shows the options relevant to the database service(s) actually
 * selected/detected in the Services step (never Oracle RAC/Data Guard for a
 * MySQL host, never Galera for an Oracle host). Values not already in
 * NODE_TYPES (e.g. 'Patroni Cluster') are still just plain strings stored in
 * the existing free-text os_servers.node_type column — no schema change.
 */
export const MYSQL_NODE_TYPES = [
  { value: 'Standalone', label: 'Standalone', icon: '○', desc: 'Single server, no HA', tone: 'neutral' },
  { value: 'Primary', label: 'Primary / Source', icon: '★', desc: 'Replication primary / source', tone: 'success' },
  { value: 'Secondary', label: 'Secondary / Replica', icon: '◎', desc: 'Replication replica', tone: 'info' },
  { value: 'Galera Node', label: 'Galera Node', icon: '⬡', desc: 'Galera / PXC multi-primary', tone: 'accent' },
  { value: 'Cluster Node', label: 'Cluster Node', icon: '⬡', desc: 'Generic cluster member', tone: 'neutral' },
  { value: 'Arbiter', label: 'Arbiter', icon: '◇', desc: 'Quorum / tiebreaker, no data', tone: 'warning' },
];

export const POSTGRESQL_NODE_TYPES = [
  { value: 'Standalone', label: 'Standalone', icon: '○', desc: 'Single server, no HA', tone: 'neutral' },
  { value: 'Primary', label: 'Primary', icon: '★', desc: 'Streaming replication primary', tone: 'success' },
  { value: 'Secondary', label: 'Replica / Standby', icon: '◎', desc: 'Streaming replication standby', tone: 'info' },
  { value: 'Patroni Cluster', label: 'Patroni Cluster', icon: '⬡', desc: 'Patroni-managed HA cluster member', tone: 'accent' },
  { value: 'Cluster Node', label: 'Cluster Node', icon: '⬡', desc: 'Generic cluster member', tone: 'neutral' },
];

/**
 * Oracle's topology is NOT stored in node_type/cluster_name — it lives on the
 * connection itself (ConnectionMaster.oracle_deployment_type / oracle_role),
 * reusing the topology service and Auto Detect endpoint already built for the
 * Oracle dashboard. Each manual option maps to a (deployment_type, role) pair
 * the existing PUT /connections/oracle/{id}/deployment-type accepts.
 */
export const ORACLE_MANUAL_TOPOLOGY = [
  { id: 'standalone', label: 'Standalone Oracle', deployment_type: 'standalone', role: null, icon: '○', tone: 'neutral' },
  { id: 'rac', label: 'Oracle RAC', deployment_type: 'rac', role: null, icon: '⬡', tone: 'accent' },
  { id: 'dg_primary', label: 'Data Guard Primary', deployment_type: 'data_guard', role: 'primary', icon: '★', tone: 'success' },
  { id: 'dg_standby', label: 'Data Guard Standby', deployment_type: 'data_guard', role: 'standby', icon: '◎', tone: 'info' },
  { id: 'rac_dg_primary', label: 'RAC + Data Guard Primary', deployment_type: 'rac_dg', role: 'primary', icon: '★', tone: 'success' },
  { id: 'rac_dg_standby', label: 'RAC + Data Guard Standby', deployment_type: 'rac_dg', role: 'standby', icon: '◎', tone: 'info' },
];

/**
 * Which per-engine topology list applies when several services are selected
 * at once — Oracle's topology is the most consequential to surface correctly,
 * then PostgreSQL, then MySQL/MariaDB; anything else (or nothing recognized)
 * falls back to the generic NODE_TYPES list, unchanged from today.
 */
export function topologyEngineFor(selectedDbs = []) {
  if (selectedDbs.includes('Oracle')) return 'oracle';
  if (selectedDbs.includes('PostgreSQL')) return 'postgresql';
  if (selectedDbs.includes('MySQL') || selectedDbs.includes('MariaDB')) return 'mysql';
  return 'generic';
}

export const ENVIRONMENTS = ['Production', 'UAT', 'Development', 'Testing'];

/** Form defaults — identical to the existing page's useForm defaultValues. */
export const SERVER_FORM_DEFAULTS = {
  ssh_port: 22,
  environment: 'Production',
  node_type: 'Standalone',
  monitoring_enabled: true,
  auto_discovery: true,
};

/**
 * Wizard steps. The agent path stops at Connection and hands off to Add Data.
 *
 * Services comes BEFORE Node Role: the Node Role / Database Topology step's
 * options depend on which database technology was selected/detected in
 * Services (Oracle RAC/Data Guard vs. MySQL replication roles vs. PostgreSQL
 * roles), so the engine has to be known first.
 */
export const SSH_STEPS = [
  'Connection', 'Operating System', 'Server Identity', 'SSH Access', 'Services', 'Node Role',
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
