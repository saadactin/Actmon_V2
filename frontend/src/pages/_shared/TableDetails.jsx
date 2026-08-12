import { useEffect, useState } from 'react';
import Dialog from '@/components/ui/Dialog';
import Tabs from '@/components/ui/Tabs';
import Table, { EmptyState } from '@/components/ui/Table';
import Badge from '@/components/ui/Badge';
import Icon from '@/components/ui/Icon';
import Notice from '@/components/ui/Notice';
import Button from '@/components/ui/Button';
import CopyButton from '@/components/ui/CopyButton';
import { PageLoading } from '@/components/ui/Loading';
import { Paged } from '@/components/ui/Pagination';
import { StatCell, SqlBlock, SqlCell } from './enginePanels';
import { fmtBytes, fmtNumber } from '@/config/dbCatalog';

/**
 * THE ActMon "Table Details" screen — one component every engine dashboard
 * opens when a user inspects a table (MySQL/PostgreSQL/SQL Server/Oracle) or
 * the closest equivalent object (MongoDB collections). Before this, each
 * engine had grown its own bespoke modal — different sizes, different tab
 * sets, different column headers, some missing pagination or an error state
 * entirely — so "inspect a table" looked and behaved like five different
 * products depending on which database you were looking at.
 *
 * This component owns ALL of the chrome (header, summary strip, tab bar,
 * loading/error/empty states, pagination) and knows NOTHING about any
 * specific engine. Every caller feeds it the same normalized shape — see
 * `EMPTY_SECTION` below — so the seven tabs (Columns, Indexes, Constraints,
 * Foreign Keys, Triggers, DDL, Sample Data) always appear in the same order
 * with the same headers, and a database that genuinely can't provide a
 * section (e.g. MongoDB has no foreign keys) shows an honest "Not supported
 * for this database" in that tab instead of the tab disappearing — the tab
 * bar itself must stay pixel-identical across every engine.
 *
 * Per-engine adapters that turn each backend's own response shape into this
 * contract live in `tableDetailsAdapters.js` next to this file.
 */

const TAB_DEFS = [
  { id: 'columns', label: 'Columns', icon: 'layers' },
  { id: 'indexes', label: 'Indexes', icon: 'key' },
  { id: 'constraints', label: 'Constraints', icon: 'link' },
  { id: 'foreign_keys', label: 'Foreign Keys', icon: 'branch' },
  { id: 'triggers', label: 'Triggers', icon: 'zap' },
  { id: 'ddl', label: 'DDL', icon: 'terminal' },
  { id: 'sample_data', label: 'Sample Data', icon: 'rows' },
];

/** A section the caller didn't populate reads as "not supported" rather than
    crashing on `.rows.length` — every tab can always be rendered. */
const EMPTY_SECTION = { supported: false };

function typeTone(dataType) {
  const t = String(dataType || '').toLowerCase();
  if (/int|numeric|decimal|float|double|real|number/.test(t)) return 'accent';
  if (/char|text|string|clob|nvarchar/.test(t)) return 'success';
  if (/date|time/.test(t)) return 'warning';
  if (/bool|bit/.test(t)) return 'info';
  if (/json|xml/.test(t)) return 'danger';
  return 'neutral';
}

const CONSTRAINT_TONE = {
  'PRIMARY KEY': 'warning',
  UNIQUE: 'accent',
  CHECK: 'info',
  DEFAULT: 'neutral',
  'FOREIGN KEY': 'danger',
};

function NotSupported({ reason }) {
  return (
    <div className="py-10">
      <EmptyState
        icon="info"
        title="Not supported for this database"
        body={reason || "This database technology doesn't expose this information."}
      />
    </div>
  );
}

function SectionTable({ columns, rows, empty }) {
  return (
    <Paged rows={rows} unit="rows">
      {(pageRows, pager) => (
        <>
          <Table
            columns={columns}
            rows={pageRows.map((r, i) => ({ key: r.__key ?? i, cells: r.__cells }))}
            empty={<EmptyState icon="boxes" title={empty || 'Nothing here'} />}
          />
          {pager}
        </>
      )}
    </Paged>
  );
}

function ColumnsTab({ section }) {
  if (!section.supported) return <NotSupported reason={section.reason} />;
  const columns = [
    { key: 'pos', label: '#', width: 40 },
    { key: 'name', label: 'Column' },
    { key: 'type', label: 'Type' },
    { key: 'nullable', label: 'Nullable' },
    { key: 'key', label: 'Key' },
    { key: 'default', label: 'Default' },
    { key: 'comment', label: 'Comment' },
  ];
  const rows = (section.rows || []).map((c, i) => ({
    __key: `${c.position ?? i}-${c.name}`,
    __cells: {
      pos: <span className="text-muted">{c.position ?? i + 1}</span>,
      name: (
        <span className="flex items-center gap-1.5">
          <span className="font-mono font-semibold text-fg">{c.name}</span>
          {c.extra && <Badge tone="neutral" size="xs">{c.extra}</Badge>}
        </span>
      ),
      type: <Badge tone={typeTone(c.type)} size="xs">{c.type}</Badge>,
      nullable: c.nullable
        ? <span className="text-muted">NULL</span>
        : <span className="font-semibold text-fg">NOT NULL</span>,
      key: c.key ? <Badge tone={c.key === 'PRIMARY' ? 'warning' : 'accent'} size="xs">{c.key === 'PRIMARY' ? 'PK' : 'UQ'}</Badge> : null,
      default: c.default != null && c.default !== ''
        ? <span className="truncate-safe block max-w-[160px] font-mono text-muted" title={String(c.default)}>{String(c.default)}</span>
        : <span className="text-subtle">—</span>,
      comment: c.comment
        ? <span className="truncate-safe block max-w-[200px] text-muted italic" title={c.comment}>{c.comment}</span>
        : <span className="text-subtle">—</span>,
    },
  }));
  return <SectionTable columns={columns} rows={rows} empty="No column data available" />;
}

function IndexesTab({ section }) {
  if (!section.supported) return <NotSupported reason={section.reason} />;
  const columns = [
    { key: 'name', label: 'Index' },
    { key: 'type', label: 'Type' },
    { key: 'unique', label: 'Unique' },
    { key: 'columns', label: 'Columns' },
    { key: 'size', label: 'Size', align: 'right' },
    { key: 'uses', label: 'Uses', align: 'right' },
  ];
  const rows = (section.rows || []).map((ix, i) => ({
    __key: ix.name || i,
    __cells: {
      name: (
        <span className="flex items-center gap-1.5">
          <span className="font-mono font-semibold text-fg">{ix.name || '(unnamed)'}</span>
          {ix.primary && <Badge tone="warning" size="xs">PK</Badge>}
          {!ix.primary && ix.unique && <Badge tone="accent" size="xs">Unique</Badge>}
        </span>
      ),
      type: ix.type || <span className="text-subtle">—</span>,
      unique: ix.unique ? <Icon name="check" size={13} className="inline text-success-fg" /> : <span className="text-subtle">—</span>,
      columns: <span className="truncate-safe block max-w-[220px] font-mono text-muted">{ix.columns || '—'}</span>,
      size: ix.size_bytes != null ? fmtBytes(ix.size_bytes) : <span className="text-subtle">—</span>,
      uses: ix.uses != null ? fmtNumber(ix.uses) : <span className="text-subtle">—</span>,
    },
  }));
  return <SectionTable columns={columns} rows={rows} empty="No indexes on this table" />;
}

function ConstraintsTab({ section }) {
  if (!section.supported) return <NotSupported reason={section.reason} />;
  const columns = [
    { key: 'type', label: 'Type' },
    { key: 'name', label: 'Name' },
    { key: 'columns', label: 'Columns' },
    { key: 'definition', label: 'Definition' },
  ];
  const rows = (section.rows || []).map((c, i) => ({
    __key: c.name || i,
    __cells: {
      type: <Badge tone={CONSTRAINT_TONE[c.type] || 'neutral'} size="xs">{c.type}</Badge>,
      name: <span className="font-mono text-fg">{c.name}</span>,
      columns: <span className="truncate-safe block max-w-[200px] font-mono text-muted">{c.columns || '—'}</span>,
      definition: c.definition
        ? <span className="truncate-safe block max-w-[260px] font-mono text-muted" title={c.definition}>{c.definition}</span>
        : <span className="text-subtle">—</span>,
    },
  }));
  return <SectionTable columns={columns} rows={rows} empty="No constraints on this table" />;
}

function ForeignKeysTab({ section }) {
  if (!section.supported) return <NotSupported reason={section.reason} />;
  const columns = [
    { key: 'name', label: 'Name' },
    { key: 'column', label: 'Column' },
    { key: 'references', label: 'References' },
    { key: 'on_update', label: 'On Update' },
    { key: 'on_delete', label: 'On Delete' },
  ];
  const rows = (section.rows || []).map((fk, i) => ({
    __key: fk.name || i,
    __cells: {
      name: <span className="font-mono text-fg">{fk.name}</span>,
      column: <span className="font-mono text-muted">{fk.column}</span>,
      references: (
        <span className="font-mono text-accent-text">
          {[fk.ref_schema, fk.ref_table, fk.ref_column].filter(Boolean).join('.')}
        </span>
      ),
      on_update: fk.on_update || <span className="text-subtle">—</span>,
      on_delete: fk.on_delete || <span className="text-subtle">—</span>,
    },
  }));
  return <SectionTable columns={columns} rows={rows} empty="No foreign keys on this table" />;
}

function TriggersTab({ section }) {
  if (!section.supported) return <NotSupported reason={section.reason} />;
  const columns = [
    { key: 'name', label: 'Name' },
    { key: 'timing', label: 'Timing / Event' },
    { key: 'definer', label: 'Definer' },
    { key: 'body', label: 'Body' },
  ];
  const rows = (section.rows || []).map((t, i) => ({
    __key: t.name || i,
    __cells: {
      name: <span className="font-mono font-semibold text-fg">{t.name}</span>,
      timing: <Badge tone="info" size="xs">{[t.timing, t.event].filter(Boolean).join(' ')}</Badge>,
      definer: t.definer ? <span className="text-muted">{t.definer}</span> : <span className="text-subtle">—</span>,
      body: <SqlCell sql={t.body} max={80} />,
    },
  }));
  return <SectionTable columns={columns} rows={rows} empty="No triggers defined" />;
}

function DdlTab({ section }) {
  if (!section.supported) return <NotSupported reason={section.reason} />;
  const text = section.text || '';
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-bold tracking-wide text-subtle uppercase">CREATE TABLE statement</span>
        <CopyButton text={text} label="Copy DDL" />
      </div>
      {text ? <SqlBlock sql={text} className="max-h-[440px]" /> : (
        <EmptyState icon="terminal" title="DDL unavailable" body="The backend could not produce a definition for this table." />
      )}
    </div>
  );
}

function SampleDataTab({ section }) {
  if (!section.supported) return <NotSupported reason={section.reason} />;
  const cols = section.columns || [];
  const columns = cols.map((c) => ({ key: c, label: c }));
  const rows = (section.rows || []).map((row, i) => ({
    __key: i,
    __cells: Object.fromEntries(cols.map((c) => {
      const v = row[c];
      if (v === null || v === undefined) {
        return [c, <span className="text-subtle italic">NULL</span>];
      }
      const s = String(v);
      return [c, (
        <span className="truncate-safe block max-w-[220px] font-mono" title={s.length > 40 ? s : undefined}>
          {s.length > 40 ? `${s.slice(0, 40)}…` : s}
        </span>
      )];
    })),
  }));
  return (
    <div className="space-y-2">
      <p className="text-[11px] text-subtle">
        Showing {section.returned ?? rows.length} of {section.total_rows != null ? fmtNumber(section.total_rows) : '—'} rows
      </p>
      <SectionTable columns={columns} rows={rows} empty="This table has no rows" />
    </div>
  );
}

const TAB_CONTENT = {
  columns: ColumnsTab,
  indexes: IndexesTab,
  constraints: ConstraintsTab,
  foreign_keys: ForeignKeysTab,
  triggers: TriggersTab,
  ddl: DdlTab,
  sample_data: SampleDataTab,
};

export default function TableDetailsDialog({
  open,
  onClose,
  breadcrumb,
  data,
  isLoading,
  isError,
  errorMessage,
  onRetry,
}) {
  const [tab, setTab] = useState('columns');
  const tableKey = breadcrumb ? `${breadcrumb.database}.${breadcrumb.schema || ''}.${breadcrumb.table}` : null;

  useEffect(() => {
    if (open) setTab('columns');
  }, [open, tableKey]);

  if (!open) return null;

  const s = data?.summary || {};
  const sections = {
    columns: data?.columns || EMPTY_SECTION,
    indexes: data?.indexes || EMPTY_SECTION,
    constraints: data?.constraints || EMPTY_SECTION,
    foreign_keys: data?.foreign_keys || EMPTY_SECTION,
    triggers: data?.triggers || EMPTY_SECTION,
    ddl: data?.ddl || EMPTY_SECTION,
    sample_data: data?.sample_data || EMPTY_SECTION,
  };
  const tabsWithCounts = TAB_DEFS.map((t) => ({
    ...t,
    count: sections[t.id]?.supported ? (sections[t.id].rows?.length ?? undefined) : undefined,
  }));

  const Content = TAB_CONTENT[tab];

  return (
    <Dialog
      open={open}
      onClose={onClose}
      icon="table"
      title={breadcrumb?.table || 'Table details'}
      subtitle={breadcrumb ? [breadcrumb.database, breadcrumb.schema].filter(Boolean).join(' / ') : undefined}
      size="full"
      width="min(1200px, 96vw)"
    >
      {isLoading ? (
        <PageLoading title="Loading table details…" minHeight={360} />
      ) : isError ? (
        <div className="py-6">
          <Notice tone="danger" title="Could not load table details.">
            {errorMessage || 'The backend returned an error. Check that the connection is active and the credentials have the required read permissions.'}
          </Notice>
          {onRetry && (
            <Button variant="secondary" icon="refresh" onClick={onRetry}>Retry</Button>
          )}
        </div>
      ) : (
        <div className="flex h-full flex-col">
          <div className="mb-4 grid grid-cols-2 gap-gutter-sm sm:grid-cols-3 lg:grid-cols-6">
            <StatCell label="Rows" value={s.row_count != null ? fmtNumber(s.row_count) : null} />
            <StatCell label="Total Size" value={s.total_bytes != null ? fmtBytes(s.total_bytes) : null} />
            <StatCell label="Data Size" value={s.data_bytes != null ? fmtBytes(s.data_bytes) : null} />
            <StatCell label="Index Size" value={s.index_bytes != null ? fmtBytes(s.index_bytes) : null} />
            <StatCell label="Columns" value={s.column_count ?? sections.columns.rows?.length ?? null} />
            <StatCell label="Indexes" value={s.index_count ?? sections.indexes.rows?.length ?? null} />
          </div>

          <Tabs tabs={tabsWithCounts} value={tab} onChange={setTab} className="mb-4" />

          <div className="min-h-0 flex-1">
            <Content section={sections[tab]} />
          </div>
        </div>
      )}
    </Dialog>
  );
}
