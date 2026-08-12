import Badge from '@/components/ui/Badge';
import Tooltip from '@/components/ui/Tooltip';
import { bandFor } from '@/components/charts/status';
import { fmtBytes, fmtDate, fmtDateTime, fmtNumber, ts } from './dbCatalog';

/**
 * CLICKHOUSE CATALOGUE — how a ClickHouse database, table and part count are
 * presented.
 *
 * ClickHouse does not fit the shared DATABASE/TABLE column sets: there is no owner,
 * no collation and no row-count estimate in the MySQL sense, but there are two
 * facts that dominate operating it and have no equivalent elsewhere —
 *
 *   parts per partition   the server refuses inserts once a partition holds too
 *                         many parts, so this is the number that becomes an outage
 *   compression ratio     the reason the sizes look the way they do; the collector
 *                         already computes it, so it belongs beside the size rather
 *                         than being left for someone to divide
 *
 * so it gets its own columns rather than borrowing ones that would read as blank.
 */

/**
 * Where a part count stops being healthy.
 *
 * ClickHouse's own defaults are `parts_to_delay_insert` (150) and
 * `parts_to_throw_insert` (300) per partition, but the collector reports a
 * `max_parts_threshold` of 3000 — clusters with heavy ingest routinely raise these.
 * This constant is the point at which the UI starts warning regardless of the
 * server's own limit; the limit itself always comes from the payload.
 */
export const MAX_PARTS_WARN = 300;

/** Pull one metric out of a [{metric|event, value}] list. */
export function metricValue(rows, name) {
  const hit = (rows || []).find((r) => (r.metric ?? r.event) === name);
  return hit ? Number(hit.value) || 0 : 0;
}

/** Table engines carry meaning: only the MergeTree family merges parts. */
const ENGINE_TONES = {
  MergeTree: 'accent',
  ReplacingMergeTree: 'accent',
  SummingMergeTree: 'accent',
  AggregatingMergeTree: 'accent',
  CollapsingMergeTree: 'accent',
  ReplicatedMergeTree: 'info',
  ReplicatedReplacingMergeTree: 'info',
  Distributed: 'warning',
  MaterializedView: 'info',
  View: 'neutral',
  Log: 'neutral',
  TinyLog: 'neutral',
  Memory: 'warning',
  Null: 'neutral',
};

const engineTone = (engine) => {
  const e = String(engine || '');
  if (ENGINE_TONES[e]) return ENGINE_TONES[e];
  if (e.includes('MergeTree')) return e.startsWith('Replicated') ? 'info' : 'accent';
  return 'neutral';
};

/** Compression as a ratio and a saving, with the raw sizes behind a tooltip. */
function CompressionCell({ row }) {
  const ratio = row.compression_ratio;
  if (ratio == null) return null;
  const pct = row.compression_ratio_pct;
  return (
    <Tooltip
      label={`${fmtBytes(row.uncompressed_bytes)} uncompressed → ${fmtBytes(row.compressed_bytes)} on disk`}
      side="top"
    >
      <span className="inline-flex items-center gap-1.5">
        <span className="font-mono font-semibold tabular-nums">{ratio}×</span>
        {pct > 0 && <span className="text-[11px] text-subtle">{pct}% saved</span>}
      </span>
    </Tooltip>
  );
}

/** Part count against the server's own insert threshold. */
function PartsCell({ count, threshold = 3000 }) {
  const parts = Number(count) || 0;
  if (!parts) return null;
  const pct = threshold > 0 ? Math.min(100, (parts / threshold) * 100) : 0;
  const band = bandFor(Math.max(pct, parts > MAX_PARTS_WARN ? 62 : 0));
  return (
    <Tooltip
      label={parts > MAX_PARTS_WARN
        ? `${fmtNumber(parts)} parts — high. ClickHouse delays and then refuses inserts as a partition fills with parts.`
        : `${fmtNumber(parts)} active parts`}
      side="top"
    >
      <span className="inline-flex items-center gap-1.5">
        <span className="font-mono tabular-nums">{fmtNumber(parts)}</span>
        {parts > MAX_PARTS_WARN && (
          <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: band.color }} />
        )}
      </span>
    </Tooltip>
  );
}

/* ── databases ───────────────────────────────────────────────────────────── */

export const CH_DATABASE_COLUMNS = [
  {
    key: 'name',
    label: 'Database',
    sortable: true,
    sortValue: (d) => d.name || '',
    render: (d) => (
      <span className="truncate-safe block max-w-[200px] font-semibold text-accent-text">{d.name}</span>
    ),
  },
  {
    key: 'engine',
    label: 'Engine',
    hint: 'Atomic is the modern default; Ordinary is the pre-20.10 layout and is deprecated.',
    sortable: true,
    sortValue: (d) => d.engine || '',
    render: (d) => (d.engine && d.engine !== '—'
      ? <Badge tone={d.engine === 'Ordinary' ? 'warning' : 'neutral'} size="xs">{d.engine}</Badge>
      : null),
  },
  {
    key: 'tables',
    label: 'Tables',
    align: 'right',
    sortable: true,
    sortValue: (d) => Number(d.tables || 0),
    render: (d) => <span className="font-mono">{d.tables || null}</span>,
  },
  {
    key: 'rows',
    label: 'Rows',
    align: 'right',
    sortable: true,
    sortValue: (d) => Number(d.row_count || 0),
    render: (d) => <span className="font-mono">{fmtNumber(d.row_count)}</span>,
  },
  {
    key: 'size',
    label: 'On disk',
    sortable: true,
    sortValue: (d) => Number(d.size_bytes || 0),
    render: (d, ctx) => {
      const bytes = Number(d.size_bytes || 0);
      const max = ctx?.maxSize || 0;
      const pct = max > 0 ? Math.min(100, (bytes / max) * 100) : 0;
      return (
        <span className="inline-flex items-center gap-2">
          <span className="font-mono whitespace-nowrap tabular-nums">{d.size_human || fmtBytes(bytes)}</span>
          <span className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-sunken">
            <span className="block h-full rounded-full bg-accent"
              style={{ width: `${Math.max(pct, bytes > 0 ? 2 : 0)}%` }} />
          </span>
        </span>
      );
    },
  },
  {
    key: 'path',
    label: 'Data path',
    sortable: true,
    sortValue: (d) => d.data_path || '',
    render: (d) => (d.data_path
      ? (
        <span title={d.data_path} className="truncate-safe block max-w-[240px] font-mono text-[11px] text-subtle">
          {d.data_path}
        </span>
      )
      : null),
  },
  {
    key: 'actions',
    label: 'Tables',
    align: 'right',
    render: (d, ctx) => (
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); ctx?.onOpen?.(d); }}
        className="h-control-sm rounded-control border border-border px-2.5 text-[12px] font-semibold text-muted transition-colors hover:bg-sunken hover:text-fg"
      >
        View tables
      </button>
    ),
  },
];

/* ── tables ──────────────────────────────────────────────────────────────── */

export const CH_TABLE_COLUMNS = [
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
      <span className="truncate-safe block max-w-[200px] font-semibold text-accent-text">{t.name}</span>
    ),
  },
  {
    key: 'engine',
    label: 'Engine',
    hint: 'Only the MergeTree family stores parts and merges them; a Distributed table holds no data itself.',
    sortable: true,
    sortValue: (t) => t.engine || '',
    render: (t) => (t.engine ? <Badge tone={engineTone(t.engine)} size="xs">{t.engine}</Badge> : null),
  },
  {
    key: 'rows',
    label: 'Rows',
    align: 'right',
    sortable: true,
    sortValue: (t) => Number(t.row_count || 0),
    render: (t) => <span className="font-mono">{fmtNumber(t.row_count)}</span>,
  },
  {
    key: 'total',
    label: 'On disk',
    sortable: true,
    sortValue: (t) => Number(t.total_bytes || 0),
    render: (t, ctx) => {
      const bytes = Number(t.total_bytes || 0);
      const max = ctx?.maxSize || 0;
      const pct = max > 0 ? Math.min(100, (bytes / max) * 100) : 0;
      return (
        <span className="inline-flex items-center gap-2">
          <span className="font-mono whitespace-nowrap tabular-nums">{t.size_human || fmtBytes(bytes)}</span>
          <span className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-sunken">
            <span className="block h-full rounded-full bg-accent"
              style={{ width: `${Math.max(pct, bytes > 0 ? 2 : 0)}%` }} />
          </span>
        </span>
      );
    },
  },
  {
    key: 'compression',
    label: 'Compression',
    align: 'right',
    hint: 'Uncompressed size divided by compressed size, from system.parts.',
    sortable: true,
    sortValue: (t) => Number(t.compression_ratio || 0),
    render: (t) => <CompressionCell row={t} />,
  },
  {
    key: 'parts',
    label: 'Parts',
    align: 'right',
    hint: 'Active parts. A partition that accumulates too many stops accepting inserts.',
    sortable: true,
    sortValue: (t) => Number(t.parts_count || 0),
    render: (t) => <PartsCell count={t.parts_count} />,
  },
  {
    key: 'partitions',
    label: 'Partitions',
    align: 'right',
    sortable: true,
    sortValue: (t) => Number(t.partitions_count || 0),
    render: (t) => <span className="font-mono text-[12px] text-muted">{t.partitions_count || null}</span>,
  },
  {
    key: 'updated',
    label: 'Metadata changed',
    hint: 'When the table definition last changed — not when data was last written.',
    sortable: true,
    sortValue: (t) => ts(t.last_modified),
    render: (t) => (fmtDate(t.last_modified)
      ? (
        <Tooltip label={fmtDateTime(t.last_modified)} side="top">
          <span className="whitespace-nowrap tabular-nums text-[12px] text-muted">{fmtDate(t.last_modified)}</span>
        </Tooltip>
      )
      : null),
  },
];

/* ── row adapters ────────────────────────────────────────────────────────────
   The dashboard payload and the /ch-tables payload name the same fields
   differently (`total_rows`/`total_bytes` vs `rows`/`bytes`), so both are read
   here rather than teaching every column two names.                            */

/** A system.tables row → the shape CH_TABLE_COLUMNS reads. */
export function chTableRow(t) {
  const bytes = Number(t.bytes ?? t.total_bytes ?? 0);
  return {
    ...t,
    database: t.database || '',
    name: t.name || '',
    row_count: Number(t.rows ?? t.total_rows ?? 0),
    total_bytes: bytes,
    size_human: t.size_pretty || fmtBytes(bytes),
    compressed_bytes: Number(t.compressed_bytes || 0),
    uncompressed_bytes: Number(t.uncompressed_bytes || 0),
    compression_ratio: t.compression_ratio ?? null,
    compression_ratio_pct: Number(t.compression_ratio_pct || 0),
    parts_count: Number(t.parts_count || 0),
    partitions_count: Number(t.partitions_count || 0),
    last_modified: t.last_modified || null,
  };
}

/** A system.databases row → the shape CH_DATABASE_COLUMNS reads. */
export function chDatabaseRow(d) {
  const bytes = Number(d.total_bytes || 0);
  return {
    ...d,
    name: d.name || '',
    tables: Number(d.table_count || 0),
    row_count: Number(d.total_rows || 0),
    size_bytes: bytes,
    size_human: d.size_pretty || fmtBytes(bytes),
  };
}
