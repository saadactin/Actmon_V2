/**
 * ENGINE REGISTRY — one place that knows how each database technology presents
 * itself: label, mark, tagline and accent colour.
 *
 * The identity data (id / name / subtitle / emoji / port) is reused from the setup
 * wizard's `techConfig`, which is the existing catalogue — importing it rather than
 * retyping the list keeps a single source of truth. The colour comes from
 * `config/agents.js`, so an engine is the same colour in the agents list, the
 * databases hub, the dashboards and every chart.
 *
 * Add an engine once here and every engine dashboard header picks it up.
 */
import { TECHS } from '@/pages/agents/setup/techConfig';
import { engineColor } from './agents';

/** Route prefix for each engine's dashboard and its sub-pages. */
const ROUTE_PREFIX = {
  mysql: 'mysql-dashboard',
  postgresql: 'postgresql-dashboard',
  oracle: 'oracle-dashboard',
  mssql: 'mssql-dashboard',
  mongodb: 'mongodb-dashboard',
  clickhouse: 'clickhouse-dashboard',
  cosmosdb: 'cosmosdb-dashboard',
};

/**
 * Engines the agent-setup catalogue does not carry.
 *
 * `TECHS` is the list of technologies you can point a host agent at, and Cosmos DB
 * is not one — it is a cloud account reached over HTTPS with an endpoint and a key,
 * with nothing to install. It still needs an identity here, because it has a
 * dashboard and appears in the databases hub. Putting it in TECHS instead would
 * offer it in the agent wizard, where there is nothing for it to do.
 */
const EXTRA_ENGINES = [
  {
    id: 'cosmosdb',
    name: 'Cosmos DB',
    subtitle: 'Azure Cosmos DB (NoSQL API)',
    emoji: '🌌',
    port: 443,
    /** Cloud-managed: no host, no agent, no service to start or stop. */
    cloud: true,
  },
];

/**
 * The sub-pages each engine's dashboard links to from its header.
 *
 * Per engine, not one shared list: the six MySQL-shaped links were being offered
 * for every technology, so an engine without an index-analysis or self-heal page
 * still advertised one and the link went to a Not-found. `path` is appended to the
 * engine's route prefix + connection id.
 */
const DEFAULT_QUICK_LINKS = [
  { path: 'slow-queries', label: 'Slow Queries', icon: 'trend' },
  { path: 'error-logs', label: 'Error Logs', icon: 'logs' },
  { path: 'error-analysis', label: 'AI Analysis', icon: 'brain' },
  { path: 'index-analysis', label: 'Indexes', icon: 'layers' },
  { path: 'self-heal', label: 'Self-Heal', icon: 'wrench' },
  { path: 'reports', label: 'Reports', icon: 'report' },
];

const QUICK_LINKS = {
  /* Slow Queries / Error Logs / Indexes moved into the main tab strip
     (see `config/mysqlDashboardNav.js`) — AI Analysis and Self-Heal are no
     longer top-level entry points at all (AI now lives inside Query
     Analysis; Self-Heal's route still exists but isn't advertised here).
     Only Reports remains a genuine "sub-page that isn't a tab." */
  mysql: [
    { path: 'reports', label: 'Reports', icon: 'report' },
  ],
  postgresql: [
    { path: 'slow-queries', label: 'Slow Queries', icon: 'trend' },
    { path: 'error-logs', label: 'Error Logs', icon: 'logs' },
    { path: 'index-analysis', label: 'Indexes', icon: 'layers' },
    { path: 'reports', label: 'Reports', icon: 'report' },
  ],
  /* Slow Queries / Error Logs / Indexes / Wait Analysis moved into the main
     tab strip (see `config/mssqlDashboardNav.js`) — Slow Queries was already
     a tab, so keeping it here too was a straight duplicate. Reports is the
     only genuine "sub-page that isn't a tab" left. */
  mssql: [
    { path: 'reports', label: 'Reports', icon: 'report' },
  ],
  oracle: [
    { path: 'live-queries', label: 'Live Queries', icon: 'activity' },
    { path: 'slow-queries', label: 'Slow SQL', icon: 'trend' },
    { path: 'error-logs', label: 'Alert Log', icon: 'logs' },
    { path: 'index-analysis', label: 'Indexes', icon: 'layers' },
    { path: 'storage-health', label: 'Storage Health', icon: 'database' },
    { path: 'reports', label: 'Reports', icon: 'report' },
  ],
  mongodb: [
    { path: 'slow-queries', label: 'Slow Queries', icon: 'trend' },
    { path: 'error-logs', label: 'Error Logs', icon: 'logs' },
    { path: 'collection-analysis', label: 'Collections', icon: 'layers' },
  ],
  /* ClickHouse has no reports or self-heal page — its own sub-pages are these. */
  clickhouse: [
    { path: 'slow-queries', label: 'Slow Queries', icon: 'trend' },
    { path: 'error-logs', label: 'Error Logs', icon: 'logs' },
    { path: 'table-analysis', label: 'Tables & Parts', icon: 'layers' },
  ],
  /* Cosmos DB's equivalents are tabs on its own dashboard, not separate routes, so
     it advertises none — a header full of links back to itself would be noise. */
  cosmosdb: [],
};

const FALLBACK = { id: 'unknown', name: 'Database', subtitle: '', emoji: '🗄️', port: null };

/** Everything the UI needs to present one engine. */
export function engineMeta(techId) {
  const tech = TECHS.find((t) => t.id === techId)
    || EXTRA_ENGINES.find((t) => t.id === techId)
    || FALLBACK;
  return {
    ...tech,
    color: engineColor(tech.name),
    routePrefix: ROUTE_PREFIX[tech.id] || `${tech.id}-dashboard`,
  };
}

/** Header quick links resolved to real hrefs for one connection. */
export function engineQuickLinks(techId, connectionId) {
  const { routePrefix, id } = engineMeta(techId);
  const links = QUICK_LINKS[id] ?? DEFAULT_QUICK_LINKS;
  return links.map((l) => ({
    ...l,
    to: `/${routePrefix}/${connectionId}/${l.path}`,
  }));
}

export { TECHS as ENGINES, EXTRA_ENGINES, DEFAULT_QUICK_LINKS as ENGINE_QUICK_LINKS };
