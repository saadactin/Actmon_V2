/**
 * What each loading context is actually waiting for.
 *
 * The reference composition has six monitoring elements. Showing all six for
 * every wait would be a picture of work that is not happening — a page that
 * fetches database metrics is not "connecting to cloud services", and a panel
 * saying so is a false status, not decoration. So a variant declares only the
 * subsystems its operation genuinely touches, and the loader draws a platform,
 * a beam and a panel for exactly those.
 *
 * Each task's `id` is what the caller reports progress against, so the panel
 * on screen and the percentage underneath are driven by the same events.
 */

/** The emblems the scene can build, and the icon each panel uses. */
export const KINDS = {
  infrastructure: { icon: 'server', emblem: 'server' },
  oracleRac: { icon: 'database', emblem: 'database' },
  cloud: { icon: 'cloud', emblem: 'cloud' },
  agents: { icon: 'agent', emblem: 'server' },
  databases: { icon: 'database', emblem: 'database' },
  security: { icon: 'shield', emblem: 'security' },
  app: { icon: 'activity', emblem: 'server' },
};

/* Slot ids place each status panel in the left or right column; the 3D
   world picks its own geometry per context (cinematicScene.js). */
const L0 = 'slot-0'; const L1 = 'slot-1'; const L2 = 'slot-2';
const R0 = 'slot-3'; const R1 = 'slot-4'; const R2 = 'slot-5';

export const VARIANTS = {
  /** First load of the application.
     Two tasks, not six. `getMenu()` exists in the API layer but nothing calls
     it on boot — permissions are restored from local storage — so there is no
     third piece of work to report. Adding a request purely to give a third
     panel something to say would be inventing work to decorate a loader. */
  boot: {
    title: 'Initializing ACTMON…',
    tasks: [
      { id: 'boot:app', label: 'Starting the application…', slot: L0, kind: 'app', panel: 'Application', weight: 1 },
      { id: 'boot:auth', label: 'Authenticating…', slot: R0, kind: 'security', panel: 'Authentication', weight: 3 },
    ],
  },

  databases: {
    title: 'Collecting database metrics…',
    tasks: [{ id: 'db:metrics', label: 'Collecting database metrics…', slot: R1, kind: 'databases', panel: 'Databases', weight: 1 }],
  },

  oracleRac: {
    title: 'Fetching RAC instance details…',
    tasks: [
      { id: 'rac:instances', label: 'Fetching instance details…', slot: L1, kind: 'oracleRac', panel: 'Oracle', weight: 1 },
      { id: 'rac:metrics', label: 'Collecting database metrics…', slot: R1, kind: 'databases', panel: 'Database metrics', weight: 1 },
    ],
  },

  infrastructure: {
    title: 'Collecting server metrics…',
    tasks: [{ id: 'infra:hosts', label: 'Collecting server metrics…', slot: L0, kind: 'infrastructure', panel: 'Infrastructure', weight: 1 }],
  },

  cloud: {
    title: 'Connecting to cloud services…',
    tasks: [{ id: 'cloud:accounts', label: 'Connecting to cloud services…', slot: L2, kind: 'cloud', panel: 'Cloud', weight: 1 }],
  },

  agents: {
    title: 'Checking agent status…',
    tasks: [{ id: 'agents:status', label: 'Checking agent status…', slot: R0, kind: 'agents', panel: 'Agents', weight: 1 }],
  },

  security: {
    title: 'Validating access…',
    tasks: [{ id: 'security:access', label: 'Validating access…', slot: R2, kind: 'security', panel: 'Security', weight: 1 }],
  },

  /** A route's code chunk arriving. There is no measurable progress in a
   *  dynamic import, so this registers NO tasks: the bar runs indeterminate
   *  and shows no percentage. */
  route: { title: 'Loading…', tasks: [] },
};

/** The variant for a path, used by the route-level loader. Longest prefix
 *  wins, so /databases/oracle beats /databases. */
const ROUTE_PREFIXES = [
  ['/oracle-dashboard', 'oracleRac'],
  ['/databases', 'databases'],
  ['/diagnose', 'databases'],
  ['/connections', 'databases'],
  ...['mysql', 'postgresql', 'oracle', 'mssql', 'mongodb', 'clickhouse', 'cosmosdb']
    .flatMap((e) => [[`/${e}-dashboard`, 'databases'], [`/${e}-servers`, 'databases']])
    .filter(([p]) => p !== '/oracle-dashboard'),
  ['/cloud-dashboard', 'cloud'],
  ['/infra', 'infrastructure'],
  ['/cloud', 'cloud'],
  ['/agents', 'agents'],
  ['/administration', 'security'],
];

export function variantForPath(pathname) {
  const p = String(pathname || '');
  const hit = ROUTE_PREFIXES
    .filter(([prefix]) => p.startsWith(prefix))
    .sort((a, b) => b[0].length - a[0].length)[0];
  return hit ? hit[1] : 'route';
}

export function getVariant(name) {
  return VARIANTS[name] || VARIANTS.route;
}
