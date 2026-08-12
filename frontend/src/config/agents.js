/**
 * AGENTS — the module's single source of truth.
 *
 * The previous build scattered agent styling through the page: an engine-colour
 * map of raw hex, a status-colour map, per-status background/border/text triples
 * inline in a `statusInfo()` helper, hardcoded cluster-badge Tailwind classes and
 * literal CPU thresholds. None of it could follow the theme.
 *
 * Everything now lives here and refers to TOKENS, never hex:
 *   • engine colours use the validated categorical chart slots, assigned in the
 *     catalogue's own fixed order (slot order is the colourblind-safety
 *     mechanism, so it must not be reshuffled)
 *   • agent states carry a `tone` that maps to the shared status scale
 *   • thresholds and intervals are named constants
 *
 * The registration form's fields, defaults, options and payload are deliberately
 * unchanged from the existing module — see REGISTRATION.
 */

/* ── database engines ─────────────────────────────────────────────────────────
   `id` is what the API stores in db_type; `slot` is the categorical chart slot
   used for its accent. Order is fixed — adding an engine appends slot 7, 8, then
   folds into neutral rather than generating a 9th hue. */
export const DB_ENGINES = [
  { id: 'MySQL', match: ['mysql', 'mariadb'], label: 'MySQL', slot: 1 },
  { id: 'PostgreSQL', match: ['postgresql', 'postgres'], label: 'PostgreSQL', slot: 2 },
  { id: 'Oracle', match: ['oracle'], label: 'Oracle', slot: 3 },
  { id: 'MSSQL', match: ['mssql', 'sqlserver', 'sql server'], label: 'SQL Server', slot: 4 },
  { id: 'MongoDB', match: ['mongodb', 'mongo'], label: 'MongoDB', slot: 5 },
  { id: 'ClickHouse', match: ['clickhouse'], label: 'ClickHouse', slot: 6 },
  /* Cosmos DB is a cloud account rather than a host you install an agent on, so it
     is absent from the agent-registration catalogue — but it still needs an accent,
     because it appears in the databases hub and in every chart that splits by
     engine. Slot 7 is the last validated hue; an eighth engine folds into neutral
     rather than generating an unvalidated one. */
  { id: 'CosmosDB', match: ['cosmosdb', 'cosmos', 'azure cosmos'], label: 'Cosmos DB', slot: 7 },
];

/** Engine ids in the order the registration dropdown offers them (unchanged). */
export const DB_TYPE_OPTIONS = DB_ENGINES.map((e) => ({ id: e.id, label: e.id }));

export function engineOf(dbType) {
  const v = String(dbType || '').toLowerCase().trim();
  return DB_ENGINES.find((e) => e.match.includes(v))
    || { id: dbType || 'Unknown', label: dbType || 'Unknown', slot: null, match: [] };
}

/** Engine accent — a chart slot, or the neutral ink for anything unrecognised. */
export const engineColor = (dbType) => {
  const { slot } = engineOf(dbType);
  return slot ? `var(--chart-${slot})` : 'var(--status-unknown)';
};

/* ── OS + environment (registration dropdowns — unchanged) ─────────────────── */
export const OS_TYPES = ['Linux', 'Windows', 'macOS', 'Other'];
export const ENVIRONMENTS = ['Production', 'Staging', 'Development', 'Testing'];

/* ── agent state ──────────────────────────────────────────────────────────────
   `level` drives the KPI buckets and the row accent; `tone` picks the badge
   colours from the shared status scale. Both replace the old inline hex. */

/** Coarse bucket, matching the old statusLevel() exactly. */
export function statusLevel(status) {
  const v = String(status || '').toLowerCase();
  if (v === 'online' || v === 'healthy') return 'online';
  if (v === 'warning' || v === 'degraded') return 'warning';
  if (v === 'offline') return 'offline';
  if (v === 'error') return 'critical';
  return 'critical';
}

export const LEVEL_COLORS = {
  online: 'var(--status-good)',
  warning: 'var(--status-warning)',
  offline: 'var(--status-unknown)',
  critical: 'var(--status-critical)',
};

/* ── Agents-list reference palette ────────────────────────────────────────
   The Agents list pill filters and engine/status chips are specced to match
   a fixed reference design pixel-for-pixel, so they read from the pinned
   --agent-* tokens (tokens.css) instead of the theme-adaptive --chart-N /
   --status-* scale every other engine badge on this page uses. Scoped to
   this list only — nothing else in the app reads these. */
export const AGENT_LEVEL_COLORS = {
  online: 'var(--agent-green)',
  warning: 'var(--agent-amber)',
  offline: 'var(--agent-slate-400)',
  critical: 'var(--agent-red)',
};

/** Only these two engines carry a dedicated colour in the reference design —
    every other value (MySQL, ClickHouse, Cosmos DB, Oracle, MSSQL, MongoDB, …)
    reads as the same neutral grey there, so that's the fallback rather than
    an invented per-engine hue with no reference to confirm it against. */
const AGENT_ENGINE_COLORS = {
  postgresql: 'var(--agent-purple)',
  host: 'var(--agent-amber)',
};

/** Reference-matched engine accent for the Agents list. */
export function agentEngineColor(dbType) {
  const v = String(dbType || '').toLowerCase().trim();
  return AGENT_ENGINE_COLORS[v] || 'var(--agent-gray)';
}

/**
 * Readable state + explanation for one agent.
 *
 * Same decision tree and the same wording as the existing module — including the
 * service-alive / service-down heuristics on `last_error`, which distinguish "the
 * host's agent service is genuinely stopped" from "the check just didn't answer".
 * Getting that backwards is what used to label healthy hosts as stopped, so the
 * regexes are kept verbatim.
 */
export function agentState(agent) {
  const s = String(agent?.status || '').toLowerCase();

  if (s === 'online') {
    return { id: 'online', label: 'Online', tone: 'success', icon: 'check', tip: 'Agent is collecting metrics' };
  }

  if (s === 'error') {
    return {
      id: 'db-error',
      label: 'DB Error',
      tone: 'danger',
      icon: 'close',
      tip: agent.last_error
        ? `Why it failed:\n${agent.last_error}`
        : 'Collector cannot connect to the monitored database. Check credentials and network.',
    };
  }

  if (s === 'warning') {
    return {
      id: 'warning',
      label: 'Warning',
      tone: 'warning',
      icon: 'alert',
      tip: 'Metrics are collecting but thresholds exceeded',
    };
  }

  // Was reporting and went silent. Only claim "Service Stopped" when the backend
  // actually concluded the service is down — the two "alive" phrasings both mean
  // the host answered, so they must not match as down.
  if (s === 'offline' && agent.last_heartbeat) {
    const err = agent.last_error || '';
    const serviceAlive = /did not answer this check|is running \(it answered\)|is running\./i.test(err);
    const serviceDown = !serviceAlive
      && /is not running on|is not installed|reports '(inactive|stopped|failed)'/i.test(err);
    return {
      id: serviceDown ? 'service-stopped' : 'offline',
      label: serviceDown ? 'Service Stopped' : 'Offline',
      tone: 'danger',
      icon: 'close',
      tip: agent.last_error
        || 'Agent stopped reporting - it was uninstalled or the host is unreachable.',
    };
  }

  // Never reported yet.
  if (!agent.has_connection) {
    return {
      id: 'push-mode',
      label: 'Push Mode',
      tone: 'accent',
      icon: 'zap',
      tip: 'No DB connection linked. Agent starts collecting when an external script pushes data via POST /api/v1/agents/data.',
    };
  }

  return {
    id: 'waiting',
    label: 'Waiting…',
    tone: 'info',
    icon: 'spinner',
    tip: `Linked to a DB connection — collector will attempt every ${agent.collection_interval_sec || 60}s. If it stays here, the database may be unreachable.`,
  };
}

/* ── cluster / role badge (was hardcoded Tailwind colour classes) ──────────── */
export function clusterBadge(agent) {
  const desc = String(agent?.description || '').toLowerCase();
  if (desc.includes('galera')) return { label: 'GALERA', tone: 'accent' };
  if (desc.includes('replica')) return { label: 'REPLICA', tone: 'info' };
  if (desc.includes('cluster')) return { label: 'CLUSTER', tone: 'info' };
  if (desc.includes('primary') || desc.includes('master')) return { label: 'PRIMARY', tone: 'warning' };
  return { label: engineOf(agent?.db_type).id.toUpperCase(), tone: 'neutral' };
}

/* ── thresholds & timings (were literals inside the page) ─────────────────── */
export const THRESHOLDS = {
  /** Utilisation bands for the CPU / memory meters on an agent card. */
  utilisationWarning: 60,
  utilisationHigh: 80,
};

export const TIMING = {
  /** Seconds between automatic list refreshes. */
  refreshSeconds: 10,
  /** How long a sync result stays on screen. */
  syncMessageMs: 6000,
};

/* ── list controls ────────────────────────────────────────────────────────── */
export const VIEW_MODES = [
  { id: 'grid', label: 'Grid', icon: 'boxes' },
  { id: 'list', label: 'List', icon: 'rows' },
];

/** Same sort choices the existing list offers. */
export const SORT_OPTIONS = [
  { id: 'name:asc', label: 'Name A→Z' },
  { id: 'name:desc', label: 'Name Z→A' },
  { id: 'agent_host_cpu:desc', label: 'Host CPU High→Low' },
  { id: 'agent_host_cpu:asc', label: 'Host CPU Low→High' },
  { id: 'active_sessions:desc', label: 'Sessions High→Low' },
  { id: 'last_heartbeat:desc', label: 'Last Seen' },
];

export const STATUS_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'online', label: 'Online' },
  { id: 'warning', label: 'Warning' },
  { id: 'critical', label: 'Critical' },
  { id: 'offline', label: 'Offline' },
];

/** The four KPI cards, which double as status filters. */
export const STAT_CARDS = [
  { key: 'all', label: 'Total Agents', icon: 'agent', tone: 'accent', filter: 'all' },
  { key: 'online', label: 'Online', icon: 'check', tone: 'good', filter: 'online' },
  { key: 'issues', label: 'Issues', icon: 'alert', tone: 'warning', filter: 'issues' },
  { key: 'offline', label: 'Offline', icon: 'close', tone: 'neutral', filter: 'offline' },
];

/** Persisted view preference (same key as the existing build, so it carries over). */
export const VIEW_STORAGE_KEY = 'actmon_agents_view';

/* ══════════════════════════════════════════════════════════════════════════════
   REGISTRATION — deliberately unchanged.

   Same fields in the same order, same defaults, same option lists, same
   validation (name required, trimmed) and the same request payload: blank
   hostname / ip_address / description are sent as `undefined` so the backend
   stores NULL rather than an empty string, and the interval is parsed with a
   fallback of 60. Only the styling is different.
   ══════════════════════════════════════════════════════════════════════════════ */
export const REGISTRATION = {
  defaults: {
    agent_name: '',
    db_type: 'MySQL',
    hostname: '',
    ip_address: '',
    os_type: 'Linux',
    environment: 'Production',
    description: '',
    collection_interval_sec: 60,
  },

  interval: { min: 10, max: 3600, fallback: 60 },

  /** The note shown under the form, unchanged. */
  note: 'The agent will be registered as offline until it starts sending heartbeats via the collector script.',

  /** Build the exact request body the existing form sends. */
  toPayload(form) {
    const trimmed = (v) => (String(v ?? '').trim() || undefined);
    return {
      ...form,
      agent_name: String(form.agent_name || '').trim(),
      hostname: trimmed(form.hostname),
      ip_address: trimmed(form.ip_address),
      description: trimmed(form.description),
      collection_interval_sec:
        parseInt(form.collection_interval_sec, 10) || REGISTRATION.interval.fallback,
    };
  },
};
