/**
 * CONNECTION FIELD CATALOGUE — what a database connection form asks for, per engine.
 *
 * Engine identity (label, emoji, colour, default port, dashboard route) already
 * lives in `config/servers.js` (`DATABASE_SERVICES`, `TECH_ROUTE`) and
 * `config/engines.js` (`engineMeta`) — this file only adds what's missing from
 * those: the actual field list a connection form renders. Keyed by the same
 * lowercase engine id `TECH_ROUTE` resolves to (`mysql`, `postgresql`, `oracle`,
 * `mssql`, `mongodb`, `clickhouse`) — MariaDB is not a separate key, it resolves
 * to `mysql` via `TECH_ROUTE.MariaDB`, same fields, same submission endpoint,
 * because `connection_master.db_type` is never anything but `"mysql"` for it
 * anywhere in this codebase.
 *
 * Field shape: `{ name, label, kind, required?, default?, options?, placeholder?,
 * hint?, mono? }`. `name` is exactly the request-body key each engine's
 * `*ConnectionCreate` backend schema expects (`connection_schema.py`) — nothing
 * here invents a field the backend can't accept.
 */

export const BASE_FIELDS = [
  { name: 'connection_name', label: 'Connection Name', placeholder: 'e.g. PROD-MySQL-01' },
  { name: 'host', label: 'Host', required: true, placeholder: '192.168.1.20' },
  { name: 'port', label: 'Port', kind: 'number', required: true },
  { name: 'username', label: 'Username', required: true },
  { name: 'password', label: 'Password', kind: 'password' },
  {
    name: 'database_name',
    label: 'Database Name',
    hint: 'Leave blank to test connectivity only, without selecting a specific database.',
  },
];

/** Extra fields per engine, appended after the base six. Only what that
 * engine's own `*ConnectionCreate` schema actually accepts. */
export const CONNECTION_EXTRA_FIELDS = {
  mysql: [],

  postgresql: [
    {
      name: 'ssl_mode',
      label: 'SSL Mode',
      kind: 'select',
      default: 'prefer',
      options: [
        { id: 'prefer', label: 'Prefer' },
        { id: 'disable', label: 'Disable' },
        { id: 'require', label: 'Require' },
      ],
    },
  ],

  oracle: [
    { name: 'service_name', label: 'Service Name', placeholder: 'ORCLPDB1' },
    { name: 'sid', label: 'SID', placeholder: 'ORCL' },
    {
      name: 'tns_descriptor',
      label: 'TNS Descriptor',
      kind: 'textarea',
      mono: true,
      hint: 'Optional. A full TNS connect descriptor, e.g. (DESCRIPTION=(ADDRESS=...)(CONNECT_DATA=...)).',
    },
    {
      name: 'oracle_connect_string',
      label: 'Full Connect String',
      kind: 'textarea',
      mono: true,
      hint: 'Optional override — a complete Oracle connect string, if Service Name/SID/TNS don’t apply.',
    },
  ],

  mssql: [
    {
      name: 'windows_authentication',
      label: 'Authentication',
      kind: 'select',
      default: 'false',
      options: [
        { id: 'false', label: 'SQL Server Authentication' },
        { id: 'true', label: 'Windows Authentication' },
      ],
      hint: 'Leave Username/Password blank when using Windows Authentication.',
    },
    { name: 'instance_name', label: 'Named Instance', placeholder: 'SQLEXPRESS' },
  ],

  mongodb: [
    {
      name: 'mongo_protocol',
      label: 'Protocol',
      kind: 'select',
      default: 'mongodb://',
      options: [
        { id: 'mongodb://', label: 'mongodb://' },
        { id: 'mongodb+srv://', label: 'mongodb+srv://' },
      ],
    },
    { name: 'auth_source', label: 'Auth Source', default: 'admin', placeholder: 'admin' },
    { name: 'replica_set', label: 'Replica Set', placeholder: 'ClusterReplicaSet' },
  ],

  clickhouse: [
    {
      name: 'clickhouse_protocol',
      label: 'Protocol',
      kind: 'select',
      default: 'native',
      options: [
        { id: 'native', label: 'Native (TCP)' },
        { id: 'http', label: 'HTTP' },
      ],
    },
  ],
};

/** Full field list for one engine, in display order. */
export function fieldsForEngine(engineKey) {
  return [...BASE_FIELDS, ...(CONNECTION_EXTRA_FIELDS[engineKey] || [])];
}

/** A fresh value object for one engine, seeded with each field's own default
 * (falling back to '') and the engine's default port where none is supplied. */
export function defaultsForEngine(engineKey, defaultPort) {
  const out = {
    connection_name: '', host: '', port: defaultPort ?? '', username: '', password: '', database_name: '',
  };
  (CONNECTION_EXTRA_FIELDS[engineKey] || []).forEach((f) => { out[f.name] = f.default ?? ''; });
  return out;
}

/** Required-field names for one engine — used for client-side validation before
 * the round trip, same reasoning as CosmosDBEditConnectionPage's validate(). */
export function requiredFieldsForEngine(engineKey) {
  return fieldsForEngine(engineKey).filter((f) => f.required).map((f) => f.name);
}

/** Build the exact request body each engine's create/test endpoint expects.
 *
 * The 6 base fields are always present — even blank — because the backend's
 * `BaseConnectionCreate` declares all of them as required `str`/`int` (a blank
 * string still satisfies that; an OMITTED key does not, and would 422). Every
 * per-engine extra field is genuinely `Optional` on the backend, so those are
 * only sent when filled in, letting the backend's own default apply otherwise. */
export function toConnectionPayload(engineKey, values, fallbackConnectionName) {
  const payload = {
    connection_name: values.connection_name || fallbackConnectionName || '',
    host: values.host || '',
    port: values.port ? Number(values.port) : undefined,
    username: values.username || '',
    password: values.password || '',
    database_name: values.database_name || '',
  };
  (CONNECTION_EXTRA_FIELDS[engineKey] || []).forEach((f) => {
    const raw = values[f.name];
    if (f.name === 'windows_authentication') { payload.windows_authentication = raw === 'true'; return; }
    if (raw === '' || raw === undefined || raw === null) return;
    payload[f.name] = raw;
  });
  return payload;
}
