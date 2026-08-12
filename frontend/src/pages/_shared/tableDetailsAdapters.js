/**
 * Per-engine adapters for the shared `<TableDetailsDialog>` (see
 * `TableDetails.jsx`). Each backend endpoint kept its own historical response
 * shape — rewriting all of them to agree on the wire would have meant
 * touching every existing consumer of those endpoints, not just this dialog.
 * Instead each adapter is a pure function translating that engine's raw JSON
 * into the one normalized contract the dialog renders from. Adding a new
 * engine means adding one function here, never touching TableDetails.jsx.
 */

/** MySQL — `GET .../tables/{table}` (detail) + `.../tables/{table}/data` (sample). */
export function adaptMysqlTableDetails(detail, sample) {
  if (!detail || detail.status !== 'success') return null;
  const si = detail.status_info || {};
  const indexByName = Object.fromEntries((detail.indexes || []).map((ix) => [ix.name, ix]));
  // The backend catches failures PER SECTION rather than failing the whole
  // request — a permission-denied on, say, `information_schema.TRIGGERS`
  // shouldn't blank out columns/indexes too. Surface that specific reason
  // instead of a generic "no triggers" empty state.
  const errs = detail.errors || {};
  const failed = (key) => errs[key] ? { supported: false, reason: errs[key] } : null;

  return {
    summary: {
      row_count: si.TABLE_ROWS ?? null,
      total_bytes: si.DATA_LENGTH != null && si.INDEX_LENGTH != null
        ? Number(si.DATA_LENGTH) + Number(si.INDEX_LENGTH) : null,
      data_bytes: si.DATA_LENGTH ?? null,
      index_bytes: si.INDEX_LENGTH ?? null,
      column_count: (detail.columns || []).length,
      index_count: (detail.indexes || []).length,
    },
    columns: failed('columns') || {
      supported: true,
      rows: (detail.columns || []).map((c) => ({
        position: c.position,
        name: c.name,
        type: c.type,
        nullable: c.nullable === 'YES',
        default: c.default_value,
        key: c.key_type === 'PRI' ? 'PRIMARY' : c.key_type === 'UNI' ? 'UNIQUE' : null,
        extra: c.extra || null,
        comment: c.comment || null,
      })),
    },
    indexes: failed('indexes') || {
      supported: true,
      rows: (detail.indexes || []).map((ix) => ({
        name: ix.name,
        type: ix.type,
        unique: !!ix.unique,
        primary: ix.name === 'PRIMARY',
        columns: (ix.columns || []).map((c) => c.name).join(', '),
        size_bytes: null,
        uses: ix.cardinality ?? null,
      })),
    },
    constraints: failed('constraints') || {
      supported: true,
      // FOREIGN KEY entries are also modeled here by MySQL, but the Foreign
      // Keys tab already shows them with full referenced-table detail — kept
      // here too they'd be a bare, columnless duplicate row.
      rows: (detail.constraints || []).filter((c) => c.type !== 'FOREIGN KEY').map((c) => ({
        type: c.type,
        name: c.name,
        // PK/UNIQUE constraints share their name with the supporting index in
        // MySQL — reuse that index's column list rather than leaving this blank.
        columns: (indexByName[c.name]?.columns || []).map((x) => x.name).join(', ') || null,
        definition: null,
      })),
    },
    foreign_keys: failed('foreign_keys') || {
      supported: true,
      rows: (detail.foreign_keys || []).map((fk) => ({
        name: fk.name,
        column: fk.column_name,
        ref_schema: fk.ref_schema,
        ref_table: fk.ref_table,
        ref_column: fk.ref_column,
        on_update: fk.on_update,
        on_delete: fk.on_delete,
      })),
    },
    triggers: failed('triggers') || {
      supported: true,
      rows: (detail.triggers || []).map((t) => ({
        name: t.name,
        timing: t.timing,
        event: t.event,
        definer: t.definer,
        body: t.body,
      })),
    },
    ddl: failed('ddl') || { supported: true, text: detail.ddl || '' },
    sample_data: sample?.status === 'error'
      ? { supported: false, reason: sample.error }
      : {
        supported: true,
        columns: sample?.col_names || [],
        rows: sample?.data || [],
        returned: sample?.returned ?? 0,
        total_rows: sample?.total_rows ?? null,
      },
  };
}

/** SQL Server — `GET /drilldown/mssql/{connId}/table-detail?db_name=&schema=&table=`. */
export function adaptMssqlTableDetails(raw) {
  if (!raw) return null;
  const s = raw.stats || {};
  const errs = raw.errors || {};
  const failed = (key) => (errs[key] ? { supported: false, reason: errs[key] } : null);
  const mb = (v) => (v != null ? Math.round(Number(v) * 1024 * 1024) : null);

  return {
    summary: {
      row_count: s.row_count ?? null,
      total_bytes: mb(s.total_mb),
      data_bytes: mb(s.data_mb),
      index_bytes: mb(s.index_mb),
      column_count: (raw.columns || []).length,
      index_count: (raw.indexes || []).length,
    },
    columns: failed('columns') || {
      supported: true,
      rows: (raw.columns || []).map((c) => ({
        position: c.column_id,
        name: c.name,
        type: c.length != null ? `${c.data_type}(${c.length})` : c.data_type,
        nullable: !!c.is_nullable,
        default: c.default_def,
        key: c.is_pk ? 'PRIMARY' : null,
        extra: c.is_identity ? 'identity' : null,
        comment: null,
      })),
    },
    indexes: failed('indexes') || {
      supported: true,
      rows: (raw.indexes || []).map((ix) => ({
        name: ix.index_name,
        type: (ix.type_desc || '').replace(/_INDEX$/i, ''),
        unique: !!ix.is_unique,
        primary: !!ix.is_primary_key,
        columns: ix.key_columns || '',
        size_bytes: null,
        uses: (ix.seeks ?? 0) + (ix.scans ?? 0) + (ix.lookups ?? 0),
      })),
    },
    constraints: failed('constraints') || {
      supported: true,
      rows: (raw.constraints || []).map((c) => ({
        type: c.type,
        name: c.name,
        columns: c.columns || null,
        definition: c.definition || null,
      })),
    },
    foreign_keys: failed('foreign_keys') || {
      supported: true,
      rows: (raw.foreign_keys || []).map((fk) => ({
        name: fk.name,
        column: fk.column,
        ref_schema: fk.ref_schema,
        ref_table: fk.ref_table,
        ref_column: fk.ref_column,
        on_update: fk.on_update,
        on_delete: fk.on_delete,
      })),
    },
    triggers: failed('triggers') || {
      supported: true,
      rows: (raw.triggers || []).map((t) => ({
        name: t.name,
        timing: t.timing,
        event: t.event,
        definer: t.definer,
        body: t.body,
      })),
    },
    ddl: failed('ddl') || { supported: true, text: raw.ddl || '' },
    sample_data: failed('sample_data') || {
      supported: true,
      columns: raw.sample_columns || [],
      rows: raw.sample_rows || [],
      returned: raw.sample_returned ?? 0,
      total_rows: s.row_count ?? null,
    },
  };
}

/** PostgreSQL — `GET .../table-structure?database=&schema=&table=`. */
export function adaptPostgresTableDetails(raw) {
  if (!raw || raw.status !== 'success') return null;
  const meta = raw.table_meta || {};
  // Unlike MySQL's `errors: {}` dict, this endpoint collects a flat list of
  // "section: message" strings — normalize lookups the same way regardless.
  const errs = raw.errors || [];
  const errorFor = (section) => errs.find((e) => e.startsWith(`${section}:`));
  const failed = (section) => {
    const e = errorFor(section);
    return e ? { supported: false, reason: e.slice(section.length + 1).trim() } : null;
  };

  return {
    summary: {
      row_count: raw.row_count ?? null,
      total_bytes: meta.total_bytes ?? null,
      data_bytes: meta.heap_bytes ?? null,
      index_bytes: meta.indexes_bytes ?? null,
      column_count: (raw.columns || []).length,
      index_count: (raw.indexes || []).length,
    },
    columns: failed('columns') || {
      supported: true,
      rows: (raw.columns || []).map((c) => ({
        position: c.ordinal_position,
        name: c.column_name,
        type: c.data_type,
        nullable: c.is_nullable === 'YES',
        default: c.column_default,
        key: null, // Postgres surfaces PK/UNIQUE via the Indexes/Constraints tabs, not per-column here
        extra: c.is_identity === 'YES' ? `identity (${(c.identity_generation || '').toLowerCase()})` : null,
        comment: c.column_comment || null,
      })),
    },
    indexes: failed('indexes') || {
      supported: true,
      rows: (raw.indexes || []).map((ix) => ({
        name: ix.index_name,
        type: (ix.index_def || '').match(/USING (\w+)/i)?.[1] || null,
        unique: !!ix.is_unique,
        primary: !!ix.is_primary,
        columns: ix.columns || '',
        size_bytes: ix.index_bytes ?? null,
        uses: ix.idx_scan ?? null,
      })),
    },
    constraints: failed('constraints') || {
      supported: true,
      rows: (raw.constraints || []).filter((c) => c.constraint_type !== 'FOREIGN KEY').map((c) => ({
        type: c.constraint_type,
        name: c.constraint_name,
        columns: c.columns || null,
        definition: null,
      })),
    },
    foreign_keys: failed('constraints') || {
      supported: true,
      rows: (raw.constraints || []).filter((c) => c.constraint_type === 'FOREIGN KEY').map((c) => ({
        name: c.constraint_name,
        column: c.columns,
        ref_schema: c.foreign_schema,
        ref_table: c.foreign_table,
        ref_column: c.foreign_column,
        on_update: c.update_rule,
        on_delete: c.delete_rule,
      })),
    },
    triggers: failed('triggers') || {
      supported: true,
      rows: (raw.triggers || []).map((t) => ({
        name: t.trigger_name,
        timing: t.action_timing,
        event: t.event_manipulation,
        definer: null,
        body: t.action_statement,
      })),
    },
    ddl: failed('ddl') || { supported: true, text: raw.ddl || '' },
    sample_data: failed('sample_data') || {
      supported: true,
      columns: raw.sample_columns || [],
      rows: raw.sample_rows || [],
      returned: raw.sample_returned ?? 0,
      total_rows: raw.row_count ?? null,
    },
  };
}

/** Oracle — `GET .../oracle-table-detail?owner=&table=`. Already shaped close
    to the common contract — mostly a pass-through plus the `failed()` guard
    for per-section errors. */
export function adaptOracleTableDetails(raw) {
  if (!raw || raw.status !== 'success') return null;
  const errs = raw.errors || {};
  const failed = (key) => (errs[key] ? { supported: false, reason: errs[key] } : null);

  return {
    summary: raw.summary || {},
    columns: failed('columns') || { supported: true, rows: raw.columns || [] },
    indexes: failed('indexes') || { supported: true, rows: raw.indexes || [] },
    constraints: failed('constraints') || { supported: true, rows: raw.constraints || [] },
    foreign_keys: failed('foreign_keys') || { supported: true, rows: raw.foreign_keys || [] },
    triggers: failed('triggers') || { supported: true, rows: raw.triggers || [] },
    ddl: failed('ddl') || { supported: true, text: raw.ddl || '' },
    sample_data: failed('sample_data') || {
      supported: true,
      columns: raw.sample_columns || [],
      rows: raw.sample_rows || [],
      returned: raw.sample_returned ?? 0,
      total_rows: raw.summary?.row_count ?? null,
    },
  };
}

/** MongoDB — `GET .../mongo-collection-detail/{db}/{collection}`.
    A document store has no columns/constraints/foreign keys/triggers in the
    relational sense — those tabs render an honest "Not supported" rather
    than an empty grid pretending the concept applies. Columns is filled in
    from the schema INFERRED by sampling documents (there is no catalog to
    read it from), and DDL becomes the collection's JSON-Schema validator
    when one is set, since that's the closest MongoDB concept to a table
    definition. */
export function adaptMongoCollectionDetails(detail) {
  if (!detail || detail.status !== 'success') return null;
  const stats = detail.stats || {};
  const sampleCount = detail.sample_count || 0;
  const fields = Object.entries(detail.schema_fields || {});

  const dominantType = (types) => Object.entries(types || {}).sort((a, b) => b[1] - a[1])[0]?.[0] || 'mixed';

  const docs = detail.sample_documents || [];
  const sampleColumns = [...new Set(docs.flatMap((d) => Object.keys(d)))];
  const stringifyCell = (v) => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'object') return JSON.stringify(v);
    return v;
  };

  return {
    summary: {
      row_count: stats.count ?? null,
      total_bytes: stats.storageSize ?? null,
      data_bytes: stats.size ?? null,
      index_bytes: stats.totalIndexSize ?? null,
      column_count: fields.length,
      index_count: (detail.indexes || []).length,
    },
    columns: {
      supported: true,
      rows: fields.map(([path, info], i) => ({
        position: i + 1,
        name: path,
        type: dominantType(info.types),
        nullable: info.count < sampleCount,
        default: null,
        key: path === '_id' ? 'PRIMARY' : null,
        comment: sampleCount ? `present in ${info.count}/${sampleCount} sampled docs` : null,
      })),
    },
    indexes: {
      supported: true,
      rows: (detail.indexes || []).map((ix) => ({
        name: ix.name,
        type: ix.name === '_id_' ? 'default' : (ix.expireAfterSeconds != null ? 'TTL' : 'index'),
        unique: !!ix.unique,
        primary: ix.name === '_id_',
        columns: Object.entries(ix.key || {}).map(([k, dir]) => `${k}:${dir}`).join(', '),
        size_bytes: null,
        uses: null,
      })),
    },
    constraints: {
      supported: false,
      reason: "MongoDB collections don't enforce schema constraints — see Columns for the field types inferred from sampled documents.",
    },
    foreign_keys: {
      supported: false,
      reason: 'MongoDB has no foreign keys — related data is embedded or referenced by application convention, not enforced by the database.',
    },
    triggers: {
      supported: false,
      reason: 'MongoDB has no triggers. Change Streams can react to writes outside the database, but are not a per-collection object to list here.',
    },
    ddl: detail.validator
      ? { supported: true, text: `// JSON Schema validator\n${detail.validator}` }
      : { supported: false, reason: 'This collection has no JSON Schema validator defined.' },
    sample_data: {
      supported: true,
      columns: sampleColumns,
      rows: docs.map((d) => Object.fromEntries(sampleColumns.map((c) => [c, stringifyCell(d[c])]))),
      returned: docs.length,
      total_rows: stats.count ?? null,
    },
  };
}
