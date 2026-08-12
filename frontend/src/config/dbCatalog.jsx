import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Icon from '@/components/ui/Icon';
import Tooltip from '@/components/ui/Tooltip';
import { bandFor } from '@/components/charts/status';

/**
 * DATABASE CATALOGUE — one definition of how a schema or a table is presented.
 *
 * Every engine's "Databases" and "Tables" list renders from the column sets here,
 * so a column added once shows up everywhere and no two engines format a size or
 * a row count differently. Columns are data, not markup: each declares how to
 * sort itself and how to render one cell, and the shared <Table> does the rest.
 *
 * A column may be marked `optional` — those are the ones a user can hide; the
 * rest carry the row's identity and always show.
 */

/* ── formatters ──────────────────────────────────────────────────────────── */

export function fmtBytes(b) {
  const n = Number(b || 0);
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function fmtNumber(n) {
  const v = Number(n || 0);
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(v);
}

/**
 * A backend timestamp, parsed correctly.
 *
 * Python's `datetime.utcnow().isoformat()` — which is what every service in this
 * backend emits — produces `2026-08-04T10:15:00.123456` with no zone. JavaScript
 * parses a zoneless date-*time* as LOCAL time, so without this the whole app reads
 * UTC values as local ones and every timestamp is wrong by the viewer's offset
 * (5½ hours in IST). Appending `Z` is what makes them agree.
 *
 * Deliberately narrow: only the strict `T`-separated ISO form with no offset is
 * touched. A space-separated value (`2026-08-04 10:15:00`) comes from a monitored
 * server's own SQL clock — ClickHouse's `event_time`, Oracle's alert log — and is
 * in *that* machine's timezone, so assuming UTC there would introduce the very
 * error this is fixing.
 */
export function parseServerDate(value) {
  if (!value) return null;
  const s = String(value);
  const naiveIso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s);
  const d = new Date(naiveIso ? `${s}Z` : s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Absolute date — lists get compared across rows, so no "3 days ago" here. */
export function fmtDate(iso) {
  const d = parseServerDate(iso);
  if (!d) return null;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' });
}

export function fmtDateTime(iso) {
  const d = parseServerDate(iso);
  if (!d) return null;
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

/** Clock time only — for a trend axis, where the date is already implied. */
export function fmtClock(iso) {
  const d = parseServerDate(iso);
  if (!d) return null;
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** Unix seconds, as Cosmos stamps on every document in `_ts`. */
export function fmtEpochSeconds(seconds) {
  if (seconds == null) return null;
  const d = new Date(Number(seconds) * 1000);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

export const ts = (iso) => parseServerDate(iso)?.getTime() ?? null;

/* ── status ──────────────────────────────────────────────────────────────── */

/** Schema states the collectors report. Tone maps onto the fixed status scale. */
export const DB_STATUS = {
  active:       { label: 'Active',       tone: 'success', icon: 'check',  hint: 'Readable, with at least one table' },
  empty:        { label: 'Empty',        tone: 'neutral', icon: 'circle', hint: 'No tables are visible to the monitoring user' },
  idle:         { label: 'Idle',         tone: 'info',    icon: 'circle', hint: 'Readable, with no client connected right now' },
  inaccessible: { label: 'Inaccessible', tone: 'danger',  icon: 'alert',  hint: 'Connections are not allowed, or metadata could not be read' },
  readonly:     { label: 'Read-only',    tone: 'warning', icon: 'shield', hint: 'Writes are currently rejected' },
};

export function dbStatusMeta(status) {
  return DB_STATUS[String(status || '').toLowerCase()] || {
    label: status || 'Unknown', tone: 'neutral', icon: 'circle', hint: 'Not reported by this engine',
  };
}

/** Where a derived value came from, spelled out for the tooltip. */
const SOURCE_NOTES = {
  oldest_table: 'Approximate. MySQL does not record when a schema was created; '
    + 'this is the CREATE_TIME of its oldest table.',
  schema_privileges: 'Derived. MySQL has no schema owner; this user holds privileges granted on this schema.',
  object_definer: 'Derived. MySQL has no schema owner; this user DEFINERs most of the '
    + 'views, routines, triggers and events inside it.',
  /* PostgreSQL records the owner, so there is nothing to disclose — no marker. */
  pg_database: null,
  /* SQL Server records both facts directly (sys.databases.owner_sid /
     create_date), so these are authoritative too. Listed explicitly rather than
     left to fall through, so "no marker" is a decision and not an oversight. */
  mssql_owner_sid: null,
  mssql_create_date: null,
};

/** Value + a "why is this approximate" marker, shown only when one applies. */
function Derived({ children, source, unknownHint }) {
  if (children === null || children === undefined || children === '') {
    return (
      <Tooltip label={unknownHint} side="top">
        <span className="text-subtle">—</span>
      </Tooltip>
    );
  }
  if (!SOURCE_NOTES[source]) return children;
  return (
    <Tooltip label={SOURCE_NOTES[source]} side="top">
      <span className="inline-flex items-center gap-1">
        {children}
        <Icon name="info" size={10} className="shrink-0 text-subtle" />
      </span>
    </Tooltip>
  );
}

/** Value beside a bar showing its share of the largest row. */
function SizeBar({ label, value, max }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <span className="inline-flex items-center gap-2">
      <span className="font-mono tabular-nums whitespace-nowrap">{label}</span>
      <span className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-sunken">
        <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.max(pct, value > 0 ? 2 : 0)}%` }} />
      </span>
    </span>
  );
}

/* ── databases ───────────────────────────────────────────────────────────────
   `ctx` carries what a cell can't know on its own: { maxSize, onOpen }.        */

export const DATABASE_COLUMNS = [
  {
    key: 'name',
    label: 'Database Name',
    sortable: true,
    sortValue: (d) => d.name,
    render: (d) => (
      <span className="inline-flex items-center gap-1.5 font-semibold text-accent-text">
        <span className="truncate-safe max-w-[220px]">{d.name}</span>
        <Icon name="eye" size={11} className="shrink-0 text-subtle opacity-0 transition-opacity group-hover:opacity-100" />
      </span>
    ),
  },
  {
    key: 'status',
    label: 'Status',
    sortable: true,
    sortValue: (d) => d.status || '',
    render: (d) => {
      const m = dbStatusMeta(d.status);
      return (
        <Tooltip label={m.hint} side="top">
          <Badge tone={m.tone} size="xs">
            <Icon name={m.icon} size={9} />
            {m.label}
          </Badge>
        </Tooltip>
      );
    },
  },
  {
    key: 'tables',
    label: 'Tables',
    align: 'right',
    sortable: true,
    sortValue: (d) => Number(d.tables ?? d.tables_count ?? 0),
    render: (d) => <span className="font-mono">{d.tables ?? d.tables_count ?? 0}</span>,
  },
  {
    key: 'size',
    label: 'Size',
    sortable: true,
    sortValue: (d) => Number(d.size_bytes ?? (d.size_mb || 0) * 1048576),
    render: (d, ctx) => {
      const bytes = Number(d.size_bytes ?? (d.size_mb || 0) * 1048576);
      return <SizeBar label={d.size_human || fmtBytes(bytes)} value={bytes} max={ctx?.maxSize || 0} />;
    },
  },
  {
    key: 'created_on',
    label: 'Created On',
    hint: 'Approximate. MySQL does not record when a schema was created, so this is '
      + 'the creation time of its oldest table.',
    sortable: true,
    sortValue: (d) => ts(d.created_on),
    render: (d) => (
      <Derived
        source={d.created_on_source}
        unknownHint="Not available — the schema has no tables to date it from."
      >
        {fmtDate(d.created_on) && (
          <Tooltip label={fmtDateTime(d.created_on)} side="top">
            <span className="whitespace-nowrap tabular-nums">{fmtDate(d.created_on)}</span>
          </Tooltip>
        )}
      </Derived>
    ),
  },
  {
    key: 'owner',
    label: 'Owner',
    hint: 'Derived. MySQL has no schema owner, so this is the user holding privileges '
      + 'granted on the schema, or failing that the one defining most of its objects.',
    sortable: true,
    sortValue: (d) => d.owner || '',
    render: (d) => (
      <Derived
        source={d.owner_source}
        unknownHint="No owner recorded for this database."
      >
        {d.owner && <span className="truncate-safe max-w-[160px] font-mono text-[12px]">{d.owner}</span>}
      </Derived>
    ),
  },
  {
    key: 'encoding',
    /* MySQL calls it a character set, PostgreSQL an encoding. One column, both
       field names — an engine should not need its own copy of this. */
    label: 'Encoding / Collation',
    sortable: true,
    sortValue: (d) => `${d.charset ?? d.encoding ?? ''} ${d.collation || ''}`.trim(),
    render: (d) => {
      const enc = d.charset ?? d.encoding;
      if (!enc && !d.collation) return null;
      return (
        <span className="block leading-tight">
          <span className="block font-mono text-[12px] text-fg">{enc || '—'}</span>
          {d.collation && (
            <span className="truncate-safe block max-w-[190px] text-[11px] text-subtle">{d.collation}</span>
          )}
        </span>
      );
    },
  },
  {
    key: 'actions',
    label: 'Action',
    align: 'right',
    render: (d, ctx) => (
      <Button
        size="sm"
        variant="secondary"
        icon="table"
        onClick={(e) => { e.stopPropagation(); ctx?.onOpen?.(d); }}
      >
        View Tables
      </Button>
    ),
  },
];

/* ── tables ──────────────────────────────────────────────────────────────── */

/** Storage engines carry meaning (transactional vs not), so they get a tone. */
const ENGINE_TONES = { innodb: 'accent', myisam: 'warning', memory: 'info', csv: 'neutral', archive: 'neutral' };

export const TABLE_COLUMNS = [
  {
    key: 'database',
    label: 'Database',
    sortable: true,
    sortValue: (t) => t.database || '',
    render: (t) => <Badge tone="accent" size="xs">{t.database}</Badge>,
  },
  {
    key: 'name',
    label: 'Table',
    sortable: true,
    sortValue: (t) => t.name || '',
    render: (t) => (
      <span className="inline-flex items-center gap-1.5 font-semibold text-accent-text">
        <span className="truncate-safe max-w-[220px]">{t.name}</span>
        <Icon name="external" size={10} className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
      </span>
    ),
  },
  {
    key: 'engine',
    label: 'Engine',
    sortable: true,
    sortValue: (t) => t.engine || '',
    render: (t) => (t.engine
      ? <Badge tone={ENGINE_TONES[String(t.engine).toLowerCase()] || 'neutral'} size="xs">{t.engine}</Badge>
      : null),
  },
  {
    key: 'rows',
    label: 'Rows',
    hint: 'Engine estimate from information_schema, not an exact COUNT(*).',
    align: 'right',
    sortable: true,
    sortValue: (t) => Number(t.row_estimate || 0),
    render: (t) => (
      <Tooltip label="Engine estimate, not an exact count" side="top">
        <span className="font-mono">{fmtNumber(t.row_estimate)}</span>
      </Tooltip>
    ),
  },
  {
    key: 'data',
    label: 'Data',
    align: 'right',
    sortable: true,
    sortValue: (t) => Number(t.data_bytes || 0),
    render: (t) => <span className="font-mono text-[12px] text-muted">{fmtBytes(t.data_bytes)}</span>,
  },
  {
    key: 'indexes',
    label: 'Indexes',
    align: 'right',
    sortable: true,
    sortValue: (t) => Number(t.index_bytes || 0),
    render: (t) => <span className="font-mono text-[12px] text-muted">{fmtBytes(t.index_bytes)}</span>,
  },
  {
    key: 'total',
    label: 'Total Size',
    sortable: true,
    sortValue: (t) => Number(t.total_bytes || 0),
    render: (t, ctx) => (
      <SizeBar
        label={t.size_human || fmtBytes(t.total_bytes)}
        value={Number(t.total_bytes || 0)}
        max={ctx?.maxSize || 0}
      />
    ),
  },
  {
    key: 'updated',
    label: 'Last Updated',
    sortable: true,
    sortValue: (t) => ts(t.update_time),
    render: (t) => (fmtDate(t.update_time) ? (
      <Tooltip label={fmtDateTime(t.update_time)} side="top">
        <span className="whitespace-nowrap tabular-nums text-[12px] text-muted">{fmtDate(t.update_time)}</span>
      </Tooltip>
    ) : null),
  },
  {
    key: 'cols',
    label: 'Cols',
    align: 'right',
    sortable: true,
    sortValue: (t) => Number(t.col_count ?? -1),
    render: (t) => <span className="font-mono text-[12px] text-subtle">{t.col_count ?? null}</span>,
  },
  {
    key: 'idx',
    label: 'Idx',
    align: 'right',
    sortable: true,
    sortValue: (t) => Number(t.index_count ?? -1),
    render: (t) => <span className="font-mono text-[12px] text-subtle">{t.index_count ?? null}</span>,
  },
  {
    key: 'actions',
    label: 'Detail',
    align: 'right',
    render: (t, ctx) => (
      <Button
        size="sm"
        variant="secondary"
        iconRight="chevron-right"
        onClick={(e) => { e.stopPropagation(); ctx?.onOpen?.(t); }}
      >
        Inspect
      </Button>
    ),
  },
];

/**
 * Quick-sort presets for the tables list — the same shortcuts the list has always
 * offered, expressed as column sorts so a preset and a header click end up in the
 * same state instead of competing.
 */
export const TABLE_SORT_PRESETS = [
  { id: 'size',    label: 'By Size',          sort: { key: 'total',   dir: 'desc' } },
  { id: 'rows',    label: 'Most Rows',        sort: { key: 'rows',    dir: 'desc' } },
  { id: 'indexes', label: 'Most Indexes',     sort: { key: 'idx',     dir: 'desc' } },
  { id: 'updated', label: 'Recently Updated', sort: { key: 'updated', dir: 'desc' } },
  { id: 'name',    label: 'Name (A–Z)',       sort: { key: 'name',    dir: 'asc'  } },
];

/* ── engine extras ───────────────────────────────────────────────────────────
   The eight columns above are what every engine shows. An engine that exposes
   more gets it here rather than by forking the column set, so the shared columns
   stay identical everywhere and only the additions differ.                     */

export const PG_DATABASE_EXTRAS = [
  {
    key: 'connections',
    label: 'Conns',
    align: 'right',
    sortable: true,
    sortValue: (d) => Number(d.numbackends ?? -1),
    render: (d) => (d.numbackends == null ? null : (
      <Tooltip label={d.conn_limit > 0 ? `Limit ${d.conn_limit}` : 'No per-database limit'} side="top">
        <span className="font-mono">{d.numbackends}</span>
      </Tooltip>
    )),
  },
  {
    key: 'xact',
    label: 'Commits / Rollbacks',
    align: 'right',
    sortable: true,
    sortValue: (d) => Number(d.xact_commit || 0),
    render: (d) => (d.xact_commit == null ? null : (
      <span className="font-mono whitespace-nowrap">
        <span className="text-success-fg">{fmtNumber(d.xact_commit)}</span>
        <span className="text-subtle"> / </span>
        <span className={Number(d.xact_rollback) > 0 ? 'text-danger-fg' : 'text-subtle'}>
          {fmtNumber(d.xact_rollback)}
        </span>
      </span>
    )),
  },
];

/**
 * PostgreSQL's caveats differ from MySQL's, and the shared columns carry MySQL's
 * by default. `owner` is authoritative here (pg_database.datdba), so its caveat is
 * cleared; `created_on` is not approximate but absent, so it is reworded.
 */
export const PG_DATABASE_HINTS = {
  owner: null,
  created_on: 'Not recorded. PostgreSQL stores no creation time for a database.',
};

/* ── SQL Server ──────────────────────────────────────────────────────────────
   sys.databases.state_desc is a state machine, not a health flag, so it is mapped
   onto the shared status scale once here rather than in the dashboard. Anything
   that is not ONLINE is at best degraded — RECOVERY_PENDING and SUSPECT mean the
   database cannot be opened, so they read as danger, not as a neutral label.    */

export const MSSQL_DB_STATES = {
  ONLINE: 'active',
  RESTORING: 'inaccessible',
  RECOVERING: 'inaccessible',
  RECOVERY_PENDING: 'inaccessible',
  SUSPECT: 'inaccessible',
  EMERGENCY: 'inaccessible',
  OFFLINE: 'inaccessible',
  COPYING: 'readonly',
  OFFLINE_SECONDARY: 'inaccessible',
};

/** SQL Server records all of these, so none of MySQL's caveats apply. */
export const MSSQL_DATABASE_HINTS = {
  owner: null,       // SUSER_SNAME(owner_sid) — authoritative
  created_on: null,  // sys.databases.create_date — authoritative
};

export const MSSQL_DATABASE_EXTRAS = [
  {
    key: 'recovery',
    label: 'Recovery Model',
    hint: 'SIMPLE cannot be restored to a point in time — only to the last full or '
      + 'differential backup.',
    sortable: true,
    sortValue: (d) => d.recovery_model || '',
    render: (d) => (d.recovery_model
      ? (
        <Badge tone={d.recovery_model === 'SIMPLE' ? 'warning' : 'neutral'} size="xs">
          {d.recovery_model}
        </Badge>
      )
      : null),
  },
  {
    key: 'log_size',
    label: 'Log Size',
    align: 'right',
    sortable: true,
    sortValue: (d) => Number(d.log_bytes || 0),
    render: (d) => (d.log_bytes == null ? null : (
      <span className="font-mono text-[12px] text-muted">{fmtBytes(d.log_bytes)}</span>
    )),
  },
  {
    key: 'compat',
    label: 'Compat',
    align: 'right',
    hint: 'Compatibility level: 160 = SQL Server 2022, 150 = 2019, 140 = 2017, 130 = 2016.',
    sortable: true,
    sortValue: (d) => Number(d.compatibility_level || 0),
    render: (d) => (d.compatibility_level
      ? <span className="font-mono text-[12px] text-muted">{d.compatibility_level}</span>
      : null),
  },
];

/** Columns the SQL Server tables list adds to the shared set. */
export const MSSQL_TABLE_EXTRAS = {
  schema: {
    key: 'schema',
    label: 'Schema',
    sortable: true,
    sortValue: (t) => t.schema || '',
    render: (t) => <span className="font-mono text-[12px] text-muted">{t.schema || 'dbo'}</span>,
  },
  missing: {
    key: 'missing',
    label: 'Missing Idx',
    align: 'right',
    hint: 'Index candidates the query optimiser recorded for this table since the last restart.',
    sortable: true,
    sortValue: (t) => Number(t.missing_index_count || 0),
    render: (t) => (Number(t.missing_index_count) > 0
      ? <Badge tone="warning" size="xs">{t.missing_index_count}</Badge>
      : null),
  },
};

/* ── Oracle ──────────────────────────────────────────────────────────────────
   Oracle has no "database" in the MySQL sense: a connection is one database, and
   the things a DBA lists are SCHEMAS (owners) and TABLESPACES. So the Databases
   column set does not apply — tablespaces get their own, because "how full is it"
   is the question, and a tablespace at 100% stops accepting writes.             */

/** dba_tablespaces.status / contents, where the value carries meaning. */
export const ORACLE_TS_TONES = {
  ONLINE: 'success', OFFLINE: 'danger', READ_ONLY: 'warning', 'READ ONLY': 'warning',
};

export const TABLESPACE_COLUMNS = [
  {
    key: 'name',
    label: 'Tablespace',
    sortable: true,
    sortValue: (t) => t.tablespace_name || '',
    render: (t) => (
      <span className="truncate-safe block max-w-[200px] font-semibold text-accent-text">
        {t.tablespace_name}
      </span>
    ),
  },
  {
    key: 'status',
    label: 'Status',
    sortable: true,
    sortValue: (t) => t.status || '',
    render: (t) => (t.status
      ? <Badge tone={ORACLE_TS_TONES[t.status] || 'neutral'} size="xs">{t.status}</Badge>
      : null),
  },
  {
    key: 'contents',
    label: 'Type',
    sortable: true,
    sortValue: (t) => t.contents || '',
    render: (t) => (t.contents
      ? <Badge tone={t.contents === 'TEMPORARY' ? 'info' : t.contents === 'UNDO' ? 'warning' : 'neutral'} size="xs">
        {t.contents}
      </Badge>
      : null),
  },
  {
    key: 'used',
    /* The whole point of the tablespace list. A bar against 100% rather than
       against the largest row: 92% of a small tablespace is still an outage. */
    label: 'Used',
    sortable: true,
    sortValue: (t) => Number(t.used_pct || 0),
    render: (t) => {
      const pct = Number(t.used_pct) || 0;
      const band = bandFor(pct);
      return (
        <span className="inline-flex items-center gap-2">
          <span className="w-10 shrink-0 text-right font-mono font-semibold tabular-nums">{pct}%</span>
          <span className="h-1.5 w-20 shrink-0 overflow-hidden rounded-full bg-sunken">
            <span
              className="block h-full rounded-full"
              style={{ width: `${Math.max(pct, pct > 0 ? 2 : 0)}%`, background: band.color }}
            />
          </span>
        </span>
      );
    },
  },
  {
    key: 'used_mb',
    label: 'Used size',
    align: 'right',
    sortable: true,
    sortValue: (t) => Number(t.used_mb || 0),
    render: (t) => <span className="font-mono text-[12px]">{fmtBytes(Number(t.used_mb || 0) * 1048576)}</span>,
  },
  {
    key: 'free_mb',
    label: 'Free',
    align: 'right',
    sortable: true,
    sortValue: (t) => Number(t.free_mb || 0),
    render: (t) => <span className="font-mono text-[12px] text-muted">{fmtBytes(Number(t.free_mb || 0) * 1048576)}</span>,
  },
  {
    key: 'total_mb',
    label: 'Allocated',
    align: 'right',
    sortable: true,
    sortValue: (t) => Number(t.total_mb || 0),
    render: (t) => <span className="font-mono text-[12px]">{fmtBytes(Number(t.total_mb || 0) * 1048576)}</span>,
  },
  {
    key: 'management',
    label: 'Extents / Logging',
    sortable: true,
    sortValue: (t) => `${t.extent_management || ''} ${t.logging || ''}`,
    render: (t) => (
      <span className="block text-[11px] leading-tight text-muted">
        <span className="block">{t.extent_management || '—'}</span>
        {t.logging && <span className="block text-subtle">{t.logging}</span>}
      </span>
    ),
  },
];

/** Oracle's caveats for the shared TABLE columns. */
export const ORACLE_TABLE_HINTS = {
  rows: 'From dba_tables.num_rows — as of the last time statistics were gathered, '
    + 'not a live count. A table analysed long ago can be badly out of date.',
  updated: 'Last time optimiser statistics were gathered (last_analyzed), not the last DML.',
};

/** A dba_tables row → the shape TABLE_COLUMNS reads. */
export function oracleTableRow(t, owner) {
  const bytes = t.size_mb == null ? null : Number(t.size_mb) * 1048576;
  return {
    ...t,
    database: owner || t.owner || '',
    name: t.table_name || '',
    row_estimate: Number(t.num_rows || 0),
    /* Oracle reports one segment size, not a data/index split, so `total` is the
       only size column that can be filled — data and indexes are dropped for it. */
    total_bytes: bytes,
    size_human: bytes == null ? null : fmtBytes(bytes),
    update_time: t.last_analyzed || null,
    col_count: t.col_count ?? null,
    index_count: t.idx_count ?? null,
    status: t.status || null,
    partitioned: t.partitioned || null,
  };
}

/* ── row adapters ────────────────────────────────────────────────────────────
   Engines name the same fact differently. Normalising into the shared vocabulary
   here means the column set never has to learn a second field name — the reason
   the Encoding column already reads both `charset` and `encoding`.              */

/** sys.databases row → the shape DATABASE_COLUMNS reads. */
export function mssqlDatabaseRow(d, tableCounts = {}) {
  const agg = tableCounts[d.name] || { count: 0, bytes: 0 };
  return {
    ...d,
    name: d.name,
    status: d.is_read_only ? 'readonly' : (MSSQL_DB_STATES[d.state_desc] || d.state_desc),
    tables: agg.count,
    size_bytes: Number(d.size_mb || 0) * 1048576,
    log_bytes: d.log_size_mb == null ? null : Number(d.log_size_mb) * 1048576,
    created_on: d.create_date || null,
    created_on_source: 'mssql_create_date',
    owner: d.owner || null,
    owner_source: 'mssql_owner_sid',
    collation: d.collation_name || null,
    recovery_model: d.recovery_model_desc || d.recovery_model || null,
    compatibility_level: d.compatibility_level || null,
  };
}

/** A tables[] row → the shape TABLE_COLUMNS reads, keeping the raw row for drill-down. */
export function mssqlTableRow(t) {
  return {
    ...t,
    database: t.db_name || '',
    schema: t.schema_name || 'dbo',
    name: t.table_name || t.name || '',
    row_estimate: Number(t.row_count ?? t.rows ?? 0),
    data_bytes: Number(t.data_mb || 0) * 1048576,
    index_bytes: Number(t.index_mb || 0) * 1048576,
    total_bytes: Number(t.total_mb || 0) * 1048576,
    update_time: t.last_updated || t.modify_date || null,
    missing_index_count: Number(t.missing_index_count || 0),
  };
}

/** Replace or clear per-column hints for an engine whose caveats differ. */
export function withHints(columns, hints = {}) {
  return columns.map((c) => (c.key in hints ? { ...c, hint: hints[c.key] || undefined } : c));
}

/** Splice engine extras in ahead of the trailing action column. */
export function withExtras(columns, extras = []) {
  if (!extras.length) return columns;
  const last = columns[columns.length - 1];
  if (last?.key !== 'actions') return [...columns, ...extras];
  return [...columns.slice(0, -1), ...extras, last];
}

/**
 * Drop columns an engine cannot fill.
 *
 * Better than leaving them in: a column that can only ever render "—" tells the
 * reader the value is missing from this database, when in fact the engine never
 * reports it. Use this only where the fact genuinely does not exist — if the
 * collector simply isn't selecting it yet, fix the collector.
 */
export function withoutColumns(columns, keys = []) {
  const drop = new Set(keys);
  return columns.filter((c) => !drop.has(c.key));
}

/**
 * Compose an explicit column order from the shared set plus extras.
 * `order` is a list of keys or column objects, so an engine can place its own
 * columns anywhere instead of only before the action column.
 */
export function orderColumns(columns, order) {
  const byKey = new Map(columns.map((c) => [c.key, c]));
  return order.map((o) => (typeof o === 'string' ? byKey.get(o) : o)).filter(Boolean);
}

/* ── adapters ────────────────────────────────────────────────────────────── */

/** Turn items + columns into the row shape <Table> consumes. */
export function toRows(items, columns, ctx = {}) {
  return items.map((item, i) => ({
    key: String(ctx.keyOf ? ctx.keyOf(item, i) : (item.name ?? i)),
    cells: Object.fromEntries(columns.map((c) => [c.key, c.render(item, ctx)])),
    sort: Object.fromEntries(columns.filter((c) => c.sortValue).map((c) => [c.key, c.sortValue(item)])),
    onClick: ctx.onRowClick ? () => ctx.onRowClick(item) : undefined,
  }));
}

/** The largest size in a set, so every bar is drawn against the same scale. */
export function maxOf(items, pick) {
  return items.reduce((m, it) => Math.max(m, Number(pick(it) || 0)), 0);
}
