import { useMemo, useState } from 'react';
import Badge from '@/components/ui/Badge';
import Icon from '@/components/ui/Icon';
import Table, { EmptyState, sortRows } from '@/components/ui/Table';
import {
  BUCKET_ORDER, bucketMeta, collectionMeta, daysLeftLabel, kindMeta,
} from '../../utils/clientModel';
import { formatCount, formatDateTime, providerLabel } from '../../utils/securityModel';
import CredentialDetailDrawer from './CredentialDetailDrawer';

// Rows are re-read after every collection, and a store that is replaced in
// full gives its objects new row ids — the provider's own id is what stays.
const keyOf = (o) => `${o.account_id}|${o.object_key}`;

/**
 * The certificate / secret / key inventory, shown the same way everywhere it
 * appears — the estate page, a client's page and an account's Security Center.
 *
 * Only metadata ever reaches the browser: names, dates, issuers, rotation
 * settings. Never a secret value or a private key.
 */

const formatDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
  });
};

/** Counts per expiry bucket. `byBucket` covers every tracked object, so the
 *  strip says so rather than implying it matches a filtered table below. */
export function BucketStrip({ byBucket, onSelect, active }) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      {BUCKET_ORDER.map((b) => {
        const meta = bucketMeta(b);
        const n = byBucket?.[b];
        const selected = active === b;
        return (
          <button
            key={b}
            type="button"
            onClick={onSelect ? () => onSelect(selected ? null : b) : undefined}
            disabled={!onSelect}
            className={`card px-3 py-2.5 text-left transition-colors ${
              onSelect ? 'hover:border-strong' : 'cursor-default'} ${
              selected ? 'border-accent' : ''}`}
          >
            <Badge tone={meta.tone} size="xs">{meta.label}</Badge>
            {/* The backend sends every bucket, so a missing map is "not loaded",
                shown as a dash rather than a count of zero. */}
            <div className="mt-1 text-2xl font-bold text-fg">{formatCount(byBucket ? (n ?? 0) : undefined)}</div>
          </button>
        );
      })}
    </div>
  );
}

function InUse({ row }) {
  if (row.in_use === true) {
    const n = (row.in_use_by || []).length;
    return (
      <span className="text-[12px] text-fg" title={(row.in_use_by || []).join('\n')}>
        In use{n ? ` · ${n}` : ''}
      </span>
    );
  }
  if (row.in_use === false) return <span className="text-[12px] text-muted">Not in use</span>;
  return <span className="text-[12px] text-subtle" title="The provider does not report usage for this store.">Unknown</span>;
}

function Renewal({ row }) {
  if (row.managed_renewal === true) {
    return (
      <span className="text-[12px] text-fg" title={row.renewal_status || undefined}>
        Auto-renews{row.renewal_status ? ` · ${row.renewal_status}` : ''}
      </span>
    );
  }
  if (row.rotation_enabled === true) {
    return (
      <span className="text-[12px] text-fg">
        Rotates{row.rotation_interval_days ? ` every ${row.rotation_interval_days} d` : ''}
      </span>
    );
  }
  if (row.managed_renewal === false || row.rotation_enabled === false) {
    return <span className="text-[12px] text-muted">Manual</span>;
  }
  return <span className="text-[12px] text-subtle">—</span>;
}

/**
 * The inventory table. Sorted soonest-expiry first by default (the backend's
 * order); objects with no expiry sort last whatever the direction. Clicking a
 * row opens everything known about the object and what to do about it.
 *
 * `onOpenFinding(fingerprint)` — given inside the Security Center, where a
 * finding drawer is at hand; elsewhere the drawer links to it instead.
 */
export function CertificateTable({
  objects, showAccount = false, loading = false, empty, onOpenFinding,
}) {
  const [sort, setSort] = useState({ key: 'days', dir: 'asc' });
  const [selectedKey, setSelectedKey] = useState(null);
  const selected = selectedKey ? (objects || []).find((o) => keyOf(o) === selectedKey) : null;
  const onSort = (key) => setSort((s) => ({
    key, dir: s.key === key && s.dir === 'asc' ? 'desc' : 'asc',
  }));

  const rows = useMemo(() => sortRows((objects || []).map((o) => {
    const meta = bucketMeta(o.bucket);
    const kind = kindMeta(o.kind);
    return {
      key: o.id,
      onClick: () => setSelectedKey(keyOf(o)),
      sort: {
        days: o.days_left, name: (o.name || o.object_key || '').toLowerCase(),
        account: (o.account_name || '').toLowerCase(), kind: o.kind,
      },
      cells: {
        expires: (
          <div className="min-w-0">
            <Badge tone={meta.tone}>{meta.label}</Badge>
            <div className="mt-0.5 text-[11px] text-muted">
              {o.expires_at ? `${formatDate(o.expires_at)} · ${daysLeftLabel(o.days_left)}` : 'No expiry set'}
            </div>
          </div>
        ),
        name: (
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="truncate-safe text-[13px] font-medium text-fg">
                {o.name || o.object_key}
              </span>
              {o.enabled === false && <Badge tone="outline" size="xs">Disabled</Badge>}
            </div>
            {(o.subject || (o.dns_names || []).length > 0) && (
              <div className="truncate-safe text-[11px] text-subtle" title={(o.dns_names || []).join(', ')}>
                {o.subject || (o.dns_names || []).slice(0, 3).join(', ')}
              </div>
            )}
          </div>
        ),
        kind: (
          <span className="inline-flex items-center gap-1.5 text-[12px] text-muted">
            <Icon name={kind.icon} size={13} />
            {kind.label}
          </span>
        ),
        account: (
          <div className="min-w-0">
            <div className="truncate-safe text-[12px] text-fg">{o.account_name || '—'}</div>
            <div className="text-[11px] text-subtle">{providerLabel(o.provider)}</div>
          </div>
        ),
        store: (
          <div className="min-w-0">
            <div className="truncate-safe text-[12px] text-fg">{o.source_label || o.source}</div>
            <div className="truncate-safe text-[11px] text-subtle">
              {[o.container_name, o.region].filter(Boolean).join(' · ') || '—'}
            </div>
          </div>
        ),
        use: <InUse row={o} />,
        renewal: <Renewal row={o} />,
        open: <Icon name="chevron-right" size={15} className="text-subtle" />,
      },
    };
  }), sort), [objects, sort]);

  const columns = [
    { key: 'expires', label: 'Expires', width: 190, sortable: true, sortKey: 'days' },
    { key: 'name', label: 'Name', sortable: true },
    { key: 'kind', label: 'Kind', width: 120, sortable: true },
    ...(showAccount ? [{ key: 'account', label: 'Account', width: 180, sortable: true }] : []),
    { key: 'store', label: 'Store', width: 220 },
    {
      key: 'use', label: 'In use', width: 110,
      hint: 'Whether the provider reports something using it. Unknown where the store does not say.',
    },
    { key: 'renewal', label: 'Renewal', width: 140 },
    { key: 'open', label: '', width: 36, align: 'right' },
  ];

  return (
    <>
      <Table
        columns={columns}
        rows={rows}
        sort={sort}
        onSort={onSort}
        loading={loading}
        empty={empty || (
          <EmptyState icon="lock" title="Nothing in this view" body="No certificate, secret or key matches these filters." />
        )}
      />
      <CredentialDetailDrawer
        object={selected}
        missing={!!selectedKey && !selected}
        onClose={() => setSelectedKey(null)}
        onOpenFinding={onOpenFinding}
      />
    </>
  );
}

/**
 * Every store that was (or could not be) read, one row per scope. A failed
 * scope keeps its last known objects, and this is where that is visible.
 */
export function SourcesTable({ sources }) {
  const rows = (sources || []).map((s) => {
    const meta = collectionMeta(s.status);
    return {
      key: s.id,
      cells: {
        store: (
          <div className="min-w-0">
            <div className="truncate-safe text-[12px] font-medium text-fg">{s.source_label || s.source}</div>
            <div className="truncate-safe text-[11px] text-subtle">{s.scope_label || s.scope}</div>
          </div>
        ),
        status: <Badge tone={meta.tone}>{meta.label}</Badge>,
        items: (
          <span className="text-[12px] text-fg">
            {s.item_count === null || s.item_count === undefined ? '—' : formatCount(s.item_count)}
          </span>
        ),
        read: (
          <div className="text-[11px] text-muted">
            <div>Last success: {formatDateTime(s.last_success_at)}</div>
            <div>Last attempt: {formatDateTime(s.last_attempt_at)}</div>
          </div>
        ),
        detail: (
          <div className="min-w-0 text-[11px] leading-relaxed text-muted">
            {s.missing_permission && (
              <div>Missing permission: <span className="font-mono text-fg">{s.missing_permission}</span></div>
            )}
            {s.error_detail && <div className="line-clamp-2" title={s.error_detail}>{s.error_detail}</div>}
            {s.remediation && <div className="text-fg">{s.remediation}</div>}
            {!s.missing_permission && !s.error_detail && !s.remediation && '—'}
          </div>
        ),
      },
    };
  });
  return (
    <Table
      columns={[
        { key: 'store', label: 'Store / scope' },
        { key: 'status', label: 'Status', width: 170 },
        { key: 'items', label: 'Objects', width: 80, align: 'right' },
        { key: 'read', label: 'Read', width: 220 },
        { key: 'detail', label: 'Detail' },
      ]}
      rows={rows}
      empty={<EmptyState icon="lock" title="No store has been read yet" body="Every refresh reads them — use Refresh all at the top of the account page." />}
    />
  );
}
