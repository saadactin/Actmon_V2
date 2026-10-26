/**
 * Database instances = one row per (host, database technology).
 *
 * The single definition behind the Monitoring Overview's "Database Server" card and
 * the Database Servers page's cross-technology list (/databases?status=…), so the
 * number on the card is always the number of rows the list shows.
 *
 * Source: GET /os-servers/ → host.db_instances (the backend already returns one
 * entry per db_type per host, including services it detected but has no instance
 * record for, with status "Unknown"), and GET /os-servers/live-status → per-host
 * db_services { db_type: status }, the live poller's port check. The live value
 * wins over the stored one — the same merge DatabaseServersPage.mergeNode applies —
 * except for a 'rac-peer' host, which the poller cannot reach.
 */

/** Engines with a Database Servers page, in display order. MariaDB reports under MySQL. */
export const DB_ENGINES = [
  { id: 'mysql', label: 'MySQL' },
  { id: 'postgresql', label: 'PostgreSQL' },
  { id: 'oracle', label: 'Oracle' },
  { id: 'mssql', label: 'SQL Server' },
  { id: 'mongodb', label: 'MongoDB' },
  { id: 'clickhouse', label: 'ClickHouse' },
];

export const engineOf = (dbType) => {
  const t = String(dbType || '').toLowerCase();
  return t === 'mariadb' ? 'mysql' : t;
};

/**
 * An instance's status on one scale. The DB status strings the backend writes are
 * Running / Degraded / Stopped / Unknown (os_server_service._db_status_summary and
 * the per-instance column).
 *   Running → online · Degraded/Warning → warning · Stopped/Down/Offline → offline
 *   anything else (Unknown, empty) → unknown — counted on its own, never guessed
 */
export function instanceLevel(status) {
  const v = String(status || '').toLowerCase();
  if (['running', 'online', 'up', 'connected', 'active'].includes(v)) return 'online';
  if (['degraded', 'warning', 'warn'].includes(v)) return 'warning';
  if (['stopped', 'down', 'offline', 'disconnected', 'failed', 'error', 'inactive'].includes(v)) return 'offline';
  return 'unknown';
}

/**
 * hosts: GET /os-servers/ rows; liveRows: GET /os-servers/live-status `data` array.
 * allowedEngines: optional Set of engine ids the viewer may see (RBAC); default all.
 */
export function buildDbInstances(hosts, liveRows, allowedEngines) {
  const live = {};
  for (const r of (Array.isArray(liveRows) ? liveRows : [])) live[r.id] = r;
  const known = new Set(DB_ENGINES.map((e) => e.id));
  const rows = [];
  for (const h of (Array.isArray(hosts) ? hosts : [])) {
    const l = h.collector === 'rac-peer' ? null : live[h.id];
    const osStatus = l?.os_status ?? h.status;
    const seen = new Set();
    for (const inst of (h.db_instances || [])) {
      const engine = engineOf(inst.db_type);
      if (!known.has(engine)) continue;
      if (allowedEngines && !allowedEngines.has(engine)) continue;
      // One row per host + technology (a MariaDB and a MySQL entry on one host are the same technology).
      if (seen.has(engine)) continue;
      seen.add(engine);
      const liveStatus = l?.db_services?.[inst.db_type] ?? l?.db_services?.[engine];
      const status = liveStatus || inst.status || 'Unknown';
      rows.push({
        key: `${h.id}:${engine}`,
        hostId: h.id,
        serverName: h.server_name || h.hostname || h.ip_address || `Host #${h.id}`,
        hostname: h.hostname || '',
        ip: h.ip_address || '',
        os: h.os_type || null,
        environment: h.environment || null,
        osStatus,
        engine,
        engineLabel: DB_ENGINES.find((e) => e.id === engine)?.label || engine,
        dbType: inst.db_type,
        port: inst.port ?? null,
        connectionId: inst.connection_id ?? null,
        status,
        level: instanceLevel(status),
      });
    }
  }
  const order = Object.fromEntries(DB_ENGINES.map((e, i) => [e.id, i]));
  rows.sort((a, b) => (order[a.engine] - order[b.engine]) || a.serverName.localeCompare(b.serverName));
  return rows;
}

export function tallyInstances(rows) {
  const out = { total: rows.length, online: 0, warning: 0, offline: 0, unknown: 0 };
  for (const r of rows) out[r.level] += 1;
  return out;
}
