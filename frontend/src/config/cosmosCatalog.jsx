import Badge from '@/components/ui/Badge';
import Icon from '@/components/ui/Icon';
import Tooltip from '@/components/ui/Tooltip';
import { fmtBytes, fmtDateTime, fmtNumber } from './dbCatalog';

/**
 * COSMOS DB CATALOGUE — what a Cosmos account, database and container look like,
 * plus the two things that make Cosmos different from every other engine here.
 *
 *   1. Reading costs money. Cosmos bills Request Units per operation, so a
 *      dashboard that polls is a dashboard that bills. The backend logs the RU
 *      charge of every call it makes, so `RU_CHARGED` marks the operations that
 *      must stay behind an explicit click and never go on a refetch interval.
 *
 *   2. Some facts are genuinely unavailable. The public SDK, with an endpoint and
 *      a key, cannot see per-partition distribution, index utilisation, average
 *      document size or a write count — those need Azure Monitor. `COSMOS_GAPS` is
 *      the registry of those facts *with the reason*, so the UI can say why a
 *      number is missing instead of printing a dash and looking broken.
 *
 * Both were scattered as inline strings across the production page. Centralised
 * here so the wording is written once and a new gap is one entry.
 */

/** The collector's own slow threshold. Overridden by `slow_query_threshold_ms`. */
export const COSMOS_SLOW_MS = 500;

/**
 * Every operation the backend logs, with what it actually does.
 *
 * `crossPartition` is the honest answer to "did this touch every physical
 * partition" — the production page hardcoded the same set inline. `ru` marks the
 * ones with a real data-plane cost; the rest are control-plane reads that are
 * effectively free.
 */
export const COSMOS_OPERATIONS = {
  list_databases: { label: 'List databases', ru: false, crossPartition: false },
  list_containers: { label: 'List containers', ru: false, crossPartition: false },
  container_details: {
    label: 'Read container',
    ru: false,
    crossPartition: false,
    hint: 'A single container.read() — storage and document count come from Cosmos\'s own response header.',
  },
  database_summary: { label: 'Database rollup', ru: false, crossPartition: false },
  test_connection: { label: 'Test connection', ru: false, crossPartition: false },
  browse_items: {
    label: 'Browse documents',
    ru: true,
    crossPartition: true,
    hint: 'A cross-partition SELECT — one page at a time, but it reaches every physical partition.',
  },
  document_stats: {
    label: 'Newest / oldest',
    ru: true,
    crossPartition: true,
    hint: 'Two TOP-1 queries ordered by _ts, which Cosmos indexes by default.',
  },
  document_count: {
    label: 'Exact count',
    ru: true,
    crossPartition: true,
    hint: 'SELECT VALUE COUNT(1) across every partition — the most expensive call here, so it is click-only.',
  },
  custom_query: {
    label: 'Ad-hoc query',
    ru: true,
    crossPartition: true,
    hint: 'A query you typed. Its cost depends entirely on what it asks for.',
  },
};

export function operationMeta(op) {
  return COSMOS_OPERATIONS[op] || { label: op || '—', ru: null, crossPartition: null };
}

/**
 * What a Cosmos HTTP status actually means.
 *
 * 429 is the one that matters and the one a bare number hides: it is not a fault,
 * it is the account refusing work because the provisioned RU/s ran out. Reading
 * "429" tells an operator nothing; reading "throttled — out of RU/s" tells them
 * exactly which knob to turn.
 */
export const COSMOS_STATUS_CODES = {
  400: { label: 'Bad request', tone: 'danger', why: 'The query or document was malformed — Cosmos rejected it before doing any work.' },
  401: { label: 'Unauthorized', tone: 'danger', why: 'The key was rejected. It may have been rotated, or the signature is malformed.' },
  403: { label: 'Forbidden', tone: 'danger', why: 'The key is valid but not permitted here — a read-only key on a write, or a firewall/VNet rule blocking this source IP.' },
  404: { label: 'Not found', tone: 'warning', why: 'The database, container or document does not exist. Often a name that changed, or a wrong partition key on a point read.' },
  408: { label: 'Request timeout', tone: 'warning', why: 'The operation exceeded Cosmos\'s server-side limit — usually a large cross-partition query.' },
  409: { label: 'Conflict', tone: 'warning', why: 'A document with that id already exists in that partition, or a unique-key constraint was violated.' },
  412: { label: 'Precondition failed', tone: 'warning', why: 'An optimistic-concurrency ETag no longer matched — someone else wrote first.' },
  413: { label: 'Entity too large', tone: 'danger', why: 'The document exceeds Cosmos\'s 2 MB per-item limit.' },
  429: {
    label: 'Throttled',
    tone: 'warning',
    why: 'The provisioned RU/s ran out, so Cosmos asked the caller to retry after a delay. Not a failure — a budget. '
      + 'Raise the throughput, switch to autoscale, or make the query cost less.',
  },
  449: { label: 'Retry with', tone: 'warning', why: 'A transient write conflict. Cosmos expects the caller to retry the whole operation.' },
  500: { label: 'Server error', tone: 'danger', why: 'An error inside the Cosmos service.' },
  503: { label: 'Service unavailable', tone: 'danger', why: 'The service or a region was briefly unreachable. Usually transient.' },
};

export function statusMeta(code) {
  if (code == null) return null;
  return COSMOS_STATUS_CODES[Number(code)]
    || { label: `HTTP ${code}`, tone: 'danger', why: 'An unrecognised status from the Cosmos service.' };
}

/**
 * Facts Cosmos does not expose to an endpoint-and-key connection.
 *
 * Each says what is missing, why, and what it would take — so the UI never has to
 * choose between an unexplained dash and a made-up number. `needs` is deliberately
 * concrete: "Azure Monitor" is actionable, "not available" is not.
 */
export const COSMOS_GAPS = {
  avg_document_size: {
    label: 'Average document size',
    why: 'Deriving it means reading every document — a full container scan with a real RU cost.',
    needs: 'A full scan, or Azure Monitor metrics',
  },
  largest_document: {
    label: 'Largest document',
    why: 'Same reason: Cosmos does not track a per-container maximum, so finding it means reading everything.',
    needs: 'A full scan',
  },
  partition_distribution: {
    label: 'Per-partition distribution',
    why: 'The public SDK does not expose physical partition key ranges, so how skewed the data is cannot be measured from here.',
    needs: 'Azure Monitor, or the portal\'s partition-key statistics',
  },
  write_counts: {
    label: 'Inserts / updates / deletes',
    why: 'ActMon only ever reads from a connected account, and Cosmos keeps no server-side write counter.',
    needs: 'The change feed, or Azure Monitor',
  },
  index_utilization: {
    label: 'Index utilisation',
    why: 'Per-query index metrics come back in a diagnostics header that the SDK only surfaces per execution — not as a container statistic.',
    needs: 'Query-level diagnostics, or Azure Monitor',
  },
  ru_savings_estimate: {
    label: 'Estimated RU savings',
    why: 'It would require replaying real queries against a changed index policy, which is not something to do against a live account.',
    needs: 'A test account and a replay of production queries',
  },
  missing_indexes: {
    label: 'Missing-index recommendations',
    why: 'Cosmos has no equivalent of a missing-index DMV — it indexes everything by default, so there is nothing to recommend from.',
    needs: 'Query diagnostics per statement',
  },
  unused_indexes: {
    label: 'Unused indexes',
    why: 'Cosmos does not record which index paths served which query.',
    needs: 'Query diagnostics per statement',
  },
  retrieved_vs_returned: {
    label: 'Retrieved vs returned documents',
    why: 'That ratio lives in the per-query diagnostics header, not in anything a monitor can read after the fact.',
    needs: 'Query-level diagnostics',
  },
  retry_count: {
    label: 'Retry count',
    why: 'The SDK retries throttled calls internally and reports only the final outcome.',
    needs: 'SDK diagnostics logging',
  },
};

/**
 * A gap, rendered. Dashed rather than solid, so it reads as a deliberately empty
 * slot and not as a value that failed to load.
 */
export function GapTile({ id, label, className }) {
  const gap = COSMOS_GAPS[id] || { label: label || 'Not available', why: '', needs: '' };
  return (
    <div className={`rounded-card border border-dashed border-border bg-sunken px-3 py-2.5 ${className || ''}`}>
      <p className="flex items-center gap-1 truncate text-[10px] font-bold tracking-wide text-subtle uppercase">
        {label || gap.label}
        <Tooltip label={`${gap.why} Needs: ${gap.needs}.`} side="top">
          <Icon name="info" size={10} className="shrink-0" />
        </Tooltip>
      </p>
      <p className="mt-0.5 text-[12px] leading-snug text-subtle italic">Not available from this connection</p>
      {gap.needs && <p className="mt-0.5 text-[10px] leading-snug text-subtle">Needs {gap.needs.toLowerCase()}</p>}
    </div>
  );
}

/* ── throughput ──────────────────────────────────────────────────────────── */

/**
 * Provisioned throughput, or the honest absence of it.
 *
 * A null `throughput_ru` is not "unknown" — it means `get_throughput()` raised,
 * which on Cosmos means the account is serverless and has no offer to read. Saying
 * "Serverless" is the accurate reading; a dash would suggest a failure.
 */
export function throughputLabel({ throughput_ru: ru, is_autoscale: auto } = {}) {
  if (ru == null) return { value: 'Serverless', sub: 'billed per request, no provisioned floor' };
  return {
    value: `${fmtNumber(ru)} RU/s`,
    sub: auto ? 'autoscale maximum' : 'manually provisioned',
  };
}

/** `"db/container"`, as the backend records a call's target. */
export function parseTarget(detail) {
  if (!detail) return { database: null, container: null };
  const [database, container] = String(detail).split('/');
  return { database: database || null, container: container || null };
}

/* ── indexing ────────────────────────────────────────────────────────────── */

/**
 * The parts of an indexing policy, each with what it buys and what it costs.
 *
 * Written here rather than beside each list because it is explanatory copy, not
 * layout — and because the production page had the same four paragraphs inline in
 * four different places, which is how they drifted.
 */
export const INDEX_SECTIONS = [
  {
    id: 'includedPaths',
    label: 'Included paths',
    icon: 'check',
    tone: 'success',
    pick: (ip) => (ip.includedPaths || []).map((p) => p.path),
    benefit: 'Filtering and sorting on these is fast and cheap.',
    cost: 'Each indexed path adds storage and a little RU to every write.',
    empty: 'Nothing is explicitly included.',
  },
  {
    id: 'excludedPaths',
    label: 'Excluded paths',
    icon: 'close',
    tone: 'neutral',
    pick: (ip) => (ip.excludedPaths || []).map((p) => p.path),
    benefit: 'Saves storage and write cost on fields nothing ever filters by.',
    cost: 'A query that does filter on one of these must read every document.',
    empty: 'Nothing is excluded.',
  },
  {
    id: 'compositeIndexes',
    label: 'Composite indexes',
    icon: 'layers',
    tone: 'accent',
    pick: (ip) => (ip.compositeIndexes || []).map(
      (combo) => (combo || []).map((c) => `${c.path} ${c.order || 'asc'}`).join(', '),
    ),
    benefit: 'Needed to filter and sort on more than one field at once — a single-path index cannot serve that.',
    cost: 'Extra storage per document, per combination.',
    empty: 'None configured. A query that sorts on two fields at once will be slow without one.',
  },
  {
    id: 'spatialIndexes',
    label: 'Spatial indexes',
    icon: 'globe',
    tone: 'info',
    pick: (ip) => (ip.spatialIndexes || []).map((p) => p.path),
    benefit: 'Powers geography queries — "within this many kilometres".',
    cost: 'Only worth it if the application actually queries by location.',
    empty: 'None configured.',
  },
  {
    id: 'vectorIndexes',
    label: 'Vector indexes',
    icon: 'brain',
    tone: 'accent',
    pick: (ip) => (ip.vectorIndexes || []).map((p) => p.path),
    benefit: 'Powers similarity search over embeddings — semantic search, recommendations.',
    cost: 'Only relevant to AI workloads.',
    empty: 'None configured.',
  },
];

/** Unique keys come from a sibling policy, not the indexing policy. */
export function uniqueKeyPaths(details) {
  return (details?.unique_key_policy?.uniqueKeys || []).map((u) => (u.paths || []).join(', '));
}

/** What an indexing mode means in one sentence. */
export const INDEXING_MODE_NOTES = {
  consistent: 'Indexes update on every write, so query results are always current.',
  lazy: 'Indexes update in the background — a deprecated mode; results can lag writes.',
  none: 'Indexing is off. Documents can only be fetched by id and partition key, never filtered.',
};

/* ── tables ──────────────────────────────────────────────────────────────── */

/**
 * Databases. Every figure past the name comes from a separate per-database rollup
 * call, so a row can legitimately be still loading or unreachable while its
 * neighbours are fine — the status column is about that call, not about the
 * database.
 */
export const COSMOS_DATABASE_COLUMNS = [
  {
    key: 'name',
    label: 'Database',
    sortable: true,
    sortValue: (d) => d.id || '',
    render: (d) => <span className="font-semibold text-accent-text">{d.id}</span>,
  },
  {
    key: 'containers',
    label: 'Containers',
    align: 'right',
    sortable: true,
    sortValue: (d) => Number(d.summary?.container_count || 0),
    render: (d) => {
      const s = d.summary;
      if (!s) return null;
      return (
        <span className="inline-flex items-center gap-1.5">
          <span className="font-mono">{s.container_count}</span>
          {s.container_count_capped && (
            <Tooltip label="Rollups below cover the first 50 containers only." side="top">
              <Badge tone="warning" size="xs">50 sampled</Badge>
            </Tooltip>
          )}
        </span>
      );
    },
  },
  {
    key: 'documents',
    label: 'Documents',
    align: 'right',
    hint: 'Summed from each container\'s Cosmos usage header — an estimate Cosmos maintains, not a COUNT.',
    sortable: true,
    sortValue: (d) => Number(d.summary?.total_documents || 0),
    render: (d) => {
      const s = d.summary;
      if (!s) return null;
      return (
        <span className="inline-flex items-center gap-1">
          <span className="font-mono">{fmtNumber(s.total_documents)}</span>
          {s.total_documents_partial && (
            <Tooltip label="At least one container did not report a count, so this total is a floor." side="top">
              <span className="font-mono text-[11px] font-bold text-warning-fg">+</span>
            </Tooltip>
          )}
        </span>
      );
    },
  },
  {
    key: 'storage',
    label: 'Storage',
    align: 'right',
    sortable: true,
    sortValue: (d) => Number(d.summary?.storage_bytes || 0),
    render: (d) => (d.summary
      ? <span className="font-mono whitespace-nowrap tabular-nums">{fmtBytes(d.summary.storage_bytes)}</span>
      : null),
  },
  {
    key: 'throughput',
    label: 'Throughput',
    align: 'right',
    hint: 'Summed across containers. Zero means every container in this database is serverless.',
    sortable: true,
    sortValue: (d) => Number(d.summary?.throughput_ru || 0),
    render: (d) => {
      const s = d.summary;
      if (!s) return null;
      return s.throughput_ru
        ? <span className="font-mono whitespace-nowrap">{fmtNumber(s.throughput_ru)} RU/s</span>
        : <span className="text-[12px] text-muted">Serverless</span>;
    },
  },
  {
    key: 'status',
    label: 'Rollup',
    render: (d) => {
      if (d.loading) return <Badge tone="neutral" size="xs">Reading…</Badge>;
      if (d.error) {
        return (
          <Tooltip label={d.error} side="top">
            <Badge tone="danger" size="xs"><Icon name="alert" size={9} />Failed</Badge>
          </Tooltip>
        );
      }
      return d.summary
        ? <Badge tone="success" size="xs"><Icon name="check" size={9} />Reachable</Badge>
        : null;
    },
  },
  {
    key: 'activity',
    label: 'Last touched',
    hint: 'The last time ActMon itself called this database — not application traffic.',
    render: (d) => (d.lastActivity
      ? <span className="whitespace-nowrap text-[12px] text-muted">{fmtDateTime(d.lastActivity)}</span>
      : <span className="text-[12px] text-subtle">No recent calls</span>),
  },
];

/**
 * Containers. Metadata is free and always present; storage and document count need
 * a per-container read, so those are blank until a container is opened — stated as
 * "not read yet" rather than as a dash, because the difference matters when the
 * reason is cost.
 */
export const COSMOS_CONTAINER_COLUMNS = [
  {
    key: 'name',
    label: 'Container',
    sortable: true,
    sortValue: (c) => c.id || '',
    render: (c, ctx) => (
      <span className="flex items-center gap-1.5">
        <Icon name="boxes" size={12} className={ctx?.selected === c.id ? 'text-accent' : 'text-subtle'} />
        <span className="font-semibold text-accent-text">{c.id}</span>
      </span>
    ),
  },
  {
    key: 'partitionKey',
    label: 'Partition key',
    hint: 'The field Cosmos shards on. Every query that does not filter by it fans out to all partitions.',
    render: (c) => ((c.partition_key || []).length
      ? (
        <span className="font-mono text-[11px] text-muted">
          {(c.partition_key || []).join(', ')}
        </span>
      )
      : null),
  },
  {
    key: 'throughput',
    label: 'Throughput',
    align: 'right',
    sortable: true,
    sortValue: (c) => Number(c.throughput_ru || 0),
    render: (c) => {
      const t = throughputLabel(c);
      return (
        <Tooltip label={t.sub} side="top">
          <span className="font-mono whitespace-nowrap text-[12px]">{t.value}</span>
        </Tooltip>
      );
    },
  },
  {
    key: 'indexing',
    label: 'Indexing',
    render: (c) => {
      const mode = c.indexing_policy?.indexingMode;
      if (!mode) return null;
      return (
        <span className="flex flex-wrap items-center gap-1">
          <Badge tone={mode === 'none' ? 'warning' : 'accent'} size="xs">{mode}</Badge>
          <span className="text-[11px] text-muted">
            {c.indexing_policy?.automatic ? 'automatic' : 'manual'}
          </span>
        </span>
      );
    },
  },
  {
    key: 'ttl',
    label: 'TTL',
    hint: 'Documents are deleted this long after their last write. Off means kept forever.',
    render: (c) => (c.default_ttl != null
      ? <Badge tone="info" size="xs">{c.default_ttl === -1 ? 'per document' : `${fmtNumber(c.default_ttl)}s`}</Badge>
      : <span className="text-[12px] text-muted">Off</span>),
  },
  {
    key: 'storage',
    label: 'Storage',
    align: 'right',
    hint: 'Needs a per-container read, so it appears once the container is opened.',
    sortable: true,
    sortValue: (c) => Number(c.details?.data_size_bytes || 0),
    render: (c) => {
      if (c.detailsLoading) return <span className="text-[11px] text-subtle">reading…</span>;
      if (!c.details) return <span className="text-[11px] text-subtle">not read yet</span>;
      return (
        <span className="font-mono whitespace-nowrap tabular-nums">{fmtBytes(c.details.data_size_bytes)}</span>
      );
    },
  },
  {
    key: 'documents',
    label: 'Documents',
    align: 'right',
    sortable: true,
    sortValue: (c) => Number(c.details?.estimated_document_count || 0),
    render: (c) => {
      if (c.detailsLoading) return <span className="text-[11px] text-subtle">reading…</span>;
      if (!c.details) return <span className="text-[11px] text-subtle">not read yet</span>;
      return c.details.estimated_document_count != null
        ? <span className="font-mono">{fmtNumber(c.details.estimated_document_count)}</span>
        : (
          <Tooltip label="Cosmos returned -1 — it does not track a document count for this container." side="top">
            <span className="text-[11px] text-subtle">not tracked</span>
          </Tooltip>
        );
    },
  },
  {
    key: 'indexSize',
    label: 'Index size',
    align: 'right',
    hint: 'Collection size minus data size — an estimate, and the only way to see it from here.',
    render: (c) => {
      const size = indexSizeOf(c.details);
      if (c.detailsLoading) return <span className="text-[11px] text-subtle">reading…</span>;
      if (size == null) return null;
      return <span className="font-mono whitespace-nowrap text-[12px] text-muted">{fmtBytes(size)}</span>;
    },
  },
];

/* ── connection form ─────────────────────────────────────────────────────── */

/**
 * Only the SQL (Core) API is implemented. The others are listed because the
 * account you are connecting to may well use one, and "not in the list" reads as
 * "not supported by Cosmos" rather than "not supported by ActMon yet".
 */
export const COSMOS_API_TYPES = [
  { id: 'sql', label: 'SQL (Core) API' },
  { id: 'mongodb', label: 'MongoDB API — not yet supported', disabled: true },
  { id: 'cassandra', label: 'Cassandra API — not yet supported', disabled: true },
  { id: 'gremlin', label: 'Gremlin API — not yet supported', disabled: true },
  { id: 'table', label: 'Table API — not yet supported', disabled: true },
];

/** Cosmos's five consistency levels, weakest guarantee last. */
export const COSMOS_CONSISTENCY_LEVELS = [
  { id: '', label: 'Account default' },
  { id: 'Strong', label: 'Strong — every read sees the latest write' },
  { id: 'BoundedStaleness', label: 'Bounded staleness — reads lag by a bounded amount' },
  { id: 'Session', label: 'Session — a client always sees its own writes (Cosmos default)' },
  { id: 'ConsistentPrefix', label: 'Consistent prefix — reads never see writes out of order' },
  { id: 'Eventual', label: 'Eventual — cheapest, no ordering guarantee' },
];

/**
 * The connection form, as data.
 *
 * `name` is the API field, which is also the form field — the production page
 * mapped 16 camelCase form names onto 16 snake_case API names by hand, in two
 * separate places, and they had already drifted. One name each removes the
 * mapping entirely.
 *
 * `secret: true` means "blank keeps whatever is saved", which is the only safe
 * behaviour for an edit form that never receives the current value back.
 */
export const COSMOS_CONNECTION_FIELDS = [
  {
    group: 'Account',
    fields: [
      { name: 'connection_name', label: 'Connection name', required: true, placeholder: 'Production Cosmos' },
      {
        name: 'account_name',
        label: 'Account name',
        hint: 'Optional when the endpoint is given — it is only used for display.',
      },
      {
        name: 'endpoint',
        label: 'Endpoint URL',
        required: true,
        placeholder: 'https://my-account.documents.azure.com:443/',
        hint: 'From the Keys blade in the Azure portal.',
      },
      { name: 'api_type', label: 'API type', kind: 'select', options: COSMOS_API_TYPES, default: 'sql' },
    ],
  },
  {
    group: 'Keys',
    note: 'Keys are stored encrypted and never returned by the API, so these are blank on load. '
      + 'Leave them blank to keep the keys already saved.',
    fields: [
      { name: 'primary_key', label: 'Primary key', kind: 'password', secret: true, placeholder: 'Leave blank to keep the saved key' },
      {
        name: 'secondary_key',
        label: 'Secondary key',
        kind: 'password',
        secret: true,
        placeholder: 'Leave blank to keep the saved key',
        hint: 'Optional. Useful during a key rotation.',
      },
    ],
  },
  {
    group: 'Default target',
    note: 'The database and container the dashboard opens on. Every other one on the account '
      + 'stays browsable from the Containers tab.',
    fields: [
      { name: 'database_name', label: 'Database', required: true },
      { name: 'container_name', label: 'Container', required: true },
      {
        name: 'partition_key',
        label: 'Partition key',
        placeholder: '/id',
        hint: 'For display only — Cosmos owns the real value and it cannot be changed after creation.',
      },
    ],
  },
  {
    group: 'Behaviour',
    fields: [
      {
        name: 'consistency_level',
        label: 'Consistency level',
        kind: 'select',
        options: COSMOS_CONSISTENCY_LEVELS,
        hint: 'A stronger level costs more RU per read. Session is Cosmos\'s own default.',
      },
      { name: 'preferred_region', label: 'Preferred region', placeholder: 'Central India' },
      { name: 'connection_timeout_sec', label: 'Timeout (seconds)', kind: 'number', default: 30 },
      {
        name: 'ssl_enabled',
        label: 'TLS',
        kind: 'select',
        options: [
          { id: 'true', label: 'Enabled (recommended)' },
          { id: 'false', label: 'Disabled' },
        ],
        default: 'true',
        hint: 'Cosmos only accepts TLS connections — disabling this will fail.',
      },
    ],
  },
  {
    group: 'Azure metadata',
    note: 'Recorded for your own reference. ActMon does not call the Azure control plane.',
    fields: [
      { name: 'resource_group', label: 'Resource group', placeholder: 'my-resource-group' },
      { name: 'subscription_id', label: 'Subscription ID', placeholder: '00000000-0000-0000-0000-000000000000' },
      { name: 'proxy', label: 'Proxy', placeholder: 'http://proxy.internal:8080' },
      { name: 'custom_headers', label: 'Custom headers', kind: 'textarea', mono: true, placeholder: '{"x-ms-…": "…"}' },
      { name: 'description', label: 'Description', kind: 'textarea', full: true },
    ],
  },
];

/** Every field, flattened — for building an initial form state or a payload. */
export const COSMOS_CONNECTION_FIELD_LIST = COSMOS_CONNECTION_FIELDS.flatMap((g) => g.fields);

/** A connection row → form state. Secrets stay blank; they are never returned. */
export function connectionToForm(c = {}) {
  const out = {};
  COSMOS_CONNECTION_FIELD_LIST.forEach((f) => {
    if (f.secret) { out[f.name] = ''; return; }
    if (f.name === 'ssl_enabled') { out[f.name] = c.ssl_enabled === false ? 'false' : 'true'; return; }
    out[f.name] = c[f.name] ?? f.default ?? '';
  });
  return out;
}

/**
 * Form state → update payload. Empty optional fields are omitted rather than sent
 * as `""` — for a secret that is what preserves the saved key, and for the rest it
 * keeps a blank box from overwriting a stored value with an empty string.
 */
export function formToPayload(form) {
  const out = {};
  COSMOS_CONNECTION_FIELD_LIST.forEach((f) => {
    const raw = form[f.name];
    if (f.name === 'ssl_enabled') { out.ssl_enabled = raw !== 'false'; return; }
    if (raw === '' || raw == null) {
      if (f.required) out[f.name] = raw;   // let the server reject it with a real message
      return;
    }
    out[f.name] = f.kind === 'number' ? Number(raw) : raw;
  });
  return out;
}

/** Index size, or null when the two sizes it is derived from are not both present. */
export function indexSizeOf(details) {
  if (!details) return null;
  const total = details.collection_size_bytes;
  const data = details.data_size_bytes;
  if (total == null || data == null) return null;
  return Math.max(total - data, 0);
}
