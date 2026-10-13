import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import Button from '@/components/ui/Button';
import Icon from '@/components/ui/Icon';
import Table, { EmptyState } from '@/components/ui/Table';
import Tabs from '@/components/ui/Tabs';
import { PageLoading } from '@/components/ui/Loading';
import CloudSection from '../components/CloudSection';
import {
  CoverageNote, ExternalBadge, LastUsed, MfaBadge, PrivilegeBadge, ProviderBadge, Tile,
  WindowNote,
} from '../components/identity/IdentityPrimitives';
import IdentityDetailDrawer from '../components/identity/IdentityDetailDrawer';
import PermissionExplorer from '../components/identity/PermissionExplorer';
import TrustMapPanel from '../components/identity/TrustMapPanel';
import AccessRequestsPanel from '../components/identity/AccessRequestsPanel';
import { useIdentityOverview, useIdentityPrincipals } from '../hooks/useIdentity';

const PAGE_SIZE = 25;

const VIEWS = [
  { id: 'overview', label: 'Overview' },
  { id: 'identities', label: 'Identities' },
  { id: 'explorer', label: 'Permission Explorer' },
  { id: 'trust', label: 'External Trust' },
  { id: 'requests', label: 'Access Requests' },
];

/**
 * Identity & Access (CIEM).
 *
 * One workspace for "who can do what, to which resource, why, how often that
 * access is actually used, and what happens if the identity is compromised".
 *
 * The page is built around one discipline, visible in almost every component:
 * a number is never shown without the coverage that makes it meaningful.
 * `CoverageNote` sits above the tiles whenever principals could not be
 * assessed; the tiles themselves render a dash rather than a zero when a
 * figure is not knowable; and every usage count is accompanied by the window
 * it was counted over. "0 privileged identities" over an account whose RBAC
 * collection was refused would be the single most dangerous screen in the
 * product, and the layout is arranged so it cannot appear.
 *
 * Filters live in the URL, so a link to "every external principal with
 * administrative access" opens the same list for whoever receives it.
 */
export default function IdentityAccessPage({ accountId, embedded = false }) {
  const [params, setParams] = useSearchParams();
  const view = params.get('iview') || 'overview';
  const openId = params.get('identity') || null;
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');

  const filters = useMemo(() => ({
    privilege: params.get('privilege') || '',
    mfa: params.get('mfa') || '',
    external: params.get('external') || '',
    actor_class: params.get('actor') || '',
    capability: params.get('capability') || '',
    dormant_days: params.get('dormant') || '',
    standing_admin: params.get('standing') === '1' ? true : undefined,
    blast_band: params.get('blast') || '',
    high_impact_only: params.get('high') === '1' ? true : undefined,
  }), [params]);

  const overview = useIdentityOverview(accountId);
  const list = useIdentityPrincipals(accountId, {
    ...filters,
    q: search || undefined,
    page,
    page_size: PAGE_SIZE,
  });

  const setView = (next) => {
    const p = new URLSearchParams(params);
    p.set('iview', next);
    setParams(p, { replace: true });
  };

  const setFilter = (name, value) => {
    const p = new URLSearchParams(params);
    if (value === undefined || value === null || value === '') p.delete(name);
    else p.set(name, String(value));
    p.set('iview', 'identities');
    setParams(p, { replace: true });
    setPage(1);
  };

  const openIdentity = (id) => {
    const p = new URLSearchParams(params);
    if (id) p.set('identity', id); else p.delete('identity');
    setParams(p, { replace: true });
  };

  const clearFilters = () => {
    const p = new URLSearchParams(params);
    ['privilege', 'mfa', 'external', 'actor', 'capability', 'dormant', 'standing',
      'blast', 'high'].forEach((k) => p.delete(k));
    setParams(p, { replace: true });
    setSearch('');
    setPage(1);
  };

  const activeFilters = Object.entries(filters)
    .filter(([, v]) => v !== '' && v !== undefined).length;

  if (overview.isLoading) return <PageLoading title="Loading identity analysis…" />;

  const data = overview.data || {};
  const counts = data.counts || {};
  const analysis = data.analysis || {};
  const notRun = !analysis.status || analysis.status === 'NeverRun';

  return (
    <div className="space-y-4">
      <CoverageNote analysis={analysis} coverage={data.coverage} />

      <Tabs tabs={VIEWS} value={view} onChange={setView} />

      {view === 'overview' && (
        <OverviewView
          data={data}
          counts={counts}
          notRun={notRun}
          onFilter={setFilter}
        />
      )}

      {view === 'identities' && (
        <IdentitiesView
          list={list}
          search={search}
          setSearch={(v) => { setSearch(v); setPage(1); }}
          page={page}
          setPage={setPage}
          activeFilters={activeFilters}
          clearFilters={clearFilters}
          onOpen={openIdentity}
          notRun={notRun}
        />
      )}

      {view === 'explorer' && <PermissionExplorer accountId={accountId} />}
      {view === 'trust' && <TrustMapPanel accountId={accountId} onOpen={openIdentity} />}
      {view === 'requests' && <AccessRequestsPanel accountId={accountId} />}

      {openId && (
        <IdentityDetailDrawer
          accountId={accountId}
          identityId={openId}
          onClose={() => openIdentity(null)}
        />
      )}
    </div>
  );
}

// ── Overview ────────────────────────────────────────────────────────────────
function OverviewView({ data, counts, notRun, onFilter }) {
  const utilization = data.permission_utilization || {};
  const trust = data.trust || {};
  const capabilities = data.capabilities || [];
  const topBlast = data.top_blast_radius || [];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
        <Tile
          label="Identities" value={counts.identities ?? 0} icon="users"
          detail={counts.not_assessed
            ? `${counts.assessed} assessed, ${counts.not_assessed} not`
            : 'all assessed'}
          unknown={notRun}
          unknownReason="No analysis has run"
          onClick={() => onFilter('privilege', '')}
        />
        <Tile
          label="Privileged" value={counts.privileged ?? 0} icon="shield"
          tone="text-warning-fg"
          detail={`${counts.admin ?? 0} administrative`}
          unknown={notRun} unknownReason="No analysis has run"
          onClick={() => onFilter('privilege', 'ADMIN,PRIVILEGED')}
        />
        <Tile
          label="Standing admin" value={counts.standing_admin ?? 0} icon="lock"
          tone="text-danger-fg"
          detail="held continuously, not on request"
          unknown={notRun} unknownReason="No analysis has run"
          onClick={() => onFilter('standing', '1')}
        />
        <Tile
          label="MFA gaps" value={counts.mfa_gaps ?? 0} icon="key"
          tone="text-danger-fg"
          detail={counts.mfa_unknown
            ? `${counts.mfa_unknown} more unknown`
            : 'humans with no device'}
          unknown={notRun} unknownReason="No analysis has run"
          onClick={() => onFilter('mfa', 'DISABLED')}
        />
        <Tile
          label="External" value={counts.external ?? 0} icon="globe"
          detail={`${trust.external_account_count ?? 0} outside accounts`}
          unknown={notRun} unknownReason="No analysis has run"
          onClick={() => onFilter('external', 'EXTERNAL,ANONYMOUS')}
        />
        <Tile
          label="Stale credentials" value={counts.stale_credentials ?? 0} icon="clock"
          tone="text-warning-fg" detail="rotate, disable or delete"
          unknown={notRun} unknownReason="No analysis has run"
        />
        <Tile
          label="High blast radius" value={counts.high_blast_radius ?? 0} icon="zap"
          tone="text-danger-fg" detail="critical or high"
          unknown={notRun} unknownReason="No analysis has run"
          onClick={() => onFilter('blast', 'CRITICAL,HIGH')}
        />
        <Tile
          label="Not assessed" value={counts.not_assessed ?? 0} icon="help"
          tone="text-muted"
          detail="policies could not be read"
          unknown={notRun} unknownReason="No analysis has run"
          onClick={() => onFilter('privilege', 'UNKNOWN')}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <CloudSection
          title="Permission utilization"
          description="Granted statements against what was actually observed."
        >
          {utilization.percent === null || utilization.percent === undefined ? (
            <div className="text-[12px] text-muted">
              <p>No usage figure can be shown.</p>
              <p className="mt-1 text-meta text-subtle">
                {utilization.note
                  || 'Permission usage needs an audit trail. Without one, the absence '
                   + 'of an event is not evidence of anything.'}
              </p>
            </div>
          ) : (
            <>
              <div className="flex items-baseline gap-2">
                <span className="text-[26px] font-bold tabular-nums text-fg">
                  {utilization.percent}
                  %
                </span>
                <span className="text-[12px] text-muted">of granted statements exercised</span>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-neutral-soft">
                <div
                  className="h-full rounded-full bg-accent"
                  style={{ width: `${Math.min(100, utilization.percent)}%` }}
                />
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-[12px]">
                <div className="flex justify-between">
                  <dt className="text-muted">Observed</dt>
                  <dd className="font-semibold tabular-nums">{utilization.observed}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted">Not observed (high conf.)</dt>
                  <dd className="font-semibold tabular-nums">
                    {utilization.not_observed_high}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted">Not observed (low conf.)</dt>
                  <dd className="font-semibold tabular-nums">
                    {utilization.not_observed_low}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted">No usable data</dt>
                  <dd className="font-semibold tabular-nums">{utilization.unknown}</dd>
                </div>
              </dl>
              <WindowNote window={utilization.window} className="mt-2" />
            </>
          )}
        </CloudSection>

        <CloudSection
          title="High-impact capabilities"
          description="How many identities hold each of the dangerous capabilities."
        >
          {capabilities.length === 0 ? (
            <p className="text-[12px] text-muted">
              No capability analysis yet.
            </p>
          ) : (
            <ul className="space-y-1">
              {capabilities.filter((c) => c.high_impact).slice(0, 8).map((c) => (
                <li key={c.capability}>
                  <button
                    type="button"
                    onClick={() => onFilter('capability', c.capability)}
                    className="flex w-full items-center justify-between gap-3 rounded-control
                      px-2 py-1 text-left transition-colors hover:bg-sunken"
                  >
                    <span className="truncate-safe text-[12px] text-fg">
                      {c.capability.replace(/_/g, ' ').toLowerCase()}
                    </span>
                    <span className="shrink-0 text-[12px] font-bold tabular-nums text-warning-fg">
                      {c.identities}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CloudSection>
      </div>

      <CloudSection
        title="Largest blast radius"
        description="What each identity could reach if it were compromised — derived from
          evaluated permissions matched against the actual inventory."
      >
        {topBlast.length === 0 ? (
          <p className="text-[12px] text-muted">
            No blast-radius results. Either the analysis has not run, or the resource
            inventory was incomplete and every score was withheld rather than estimated.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {topBlast.map((b) => (
              <li key={b.identity_id} className="flex items-center gap-3 py-2">
                <span className="w-12 shrink-0 text-right text-[14px] font-bold tabular-nums text-danger-fg">
                  {b.score ?? '—'}
                </span>
                <span className="min-w-0 flex-1 truncate-safe text-[12px] text-fg">
                  {b.identity_name || b.identity_id}
                </span>
                <span className="shrink-0 text-meta text-muted">
                  {b.direct_resources}
                  {' direct · '}
                  {b.indirect_resources}
                  {' indirect'}
                </span>
                {!b.inventory_complete && (
                  <Icon
                    name="info" size={13} className="shrink-0 text-warning-fg"
                    title="The inventory was incomplete, so these counts are a floor."
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </CloudSection>
    </div>
  );
}

// ── Identities table ────────────────────────────────────────────────────────
function IdentitiesView({
  list, search, setSearch, page, setPage, activeFilters, clearFilters, onOpen, notRun,
}) {
  const data = list.data || {};
  const items = data.items || [];

  const columns = [
    { key: 'name', label: 'Identity' },
    { key: 'type', label: 'Type' },
    { key: 'privilege', label: 'Privilege' },
    { key: 'mfa', label: 'MFA' },
    { key: 'last_used', label: 'Last used' },
    { key: 'credentials', label: 'Creds', align: 'right' },
    { key: 'usage', label: 'Usage', align: 'right' },
    { key: 'blast', label: 'Blast', align: 'right' },
  ];

  const rows = items.map((it) => ({
    key: it.id,
    cells: {
      name: (
        <button
          type="button"
          onClick={() => onOpen(it.id)}
          className="flex min-w-0 items-center gap-1.5 text-left text-[12px] font-semibold
            text-accent-text hover:underline"
        >
          <span className="truncate-safe">
            {it.name || it.principal_name || it.provider_id}
          </span>
          <ExternalBadge state={it.external} />
        </button>
      ),
      type: (
        <span className="flex items-center gap-1.5">
          <ProviderBadge provider={it.provider} />
          <span className="truncate-safe text-meta text-muted">
            {(it.identity_type || '').replace(/_/g, ' ').toLowerCase()}
          </span>
        </span>
      ),
      privilege: (
        <span className="flex items-center gap-1">
          <PrivilegeBadge level={it.privilege_level} />
          {it.standing_admin && (
            <Icon
              name="lock" size={12} className="text-danger-fg"
              title="Standing administrative access"
            />
          )}
        </span>
      ),
      mfa: <MfaBadge state={it.mfa_state} />,
      last_used: (
        <span className="text-[12px]">
          <LastUsed at={it.last_used_at} source={it.last_used_source} />
        </span>
      ),
      credentials: (
        <span className="text-[12px] tabular-nums">
          {it.active_credential_count ?? 0}
          {it.credential_count > it.active_credential_count && (
            <span className="text-subtle">
              {` / ${it.credential_count}`}
            </span>
          )}
        </span>
      ),
      usage: it.usage && typeof it.usage.observed === 'number' ? (
        <span
          className="text-[12px] tabular-nums"
          title={`${it.usage.observed} observed, `
            + `${it.usage.not_observed_high} not observed (high confidence)`}
        >
          {it.usage.observed}
          <span className="text-subtle">
            {` / ${it.usage.observed + it.usage.not_observed_high
              + it.usage.not_observed_low + it.usage.unknown}`}
          </span>
        </span>
      ) : <span className="text-subtle">—</span>,
      blast: it.blast_radius?.score != null ? (
        <span
          className="text-[12px] font-semibold tabular-nums"
          title={it.blast_radius.inventory_complete
            ? undefined
            : 'The inventory was incomplete; this is a floor.'}
        >
          {it.blast_radius.score}
        </span>
      ) : (
        <span
          className="text-subtle"
          title="Withheld: the resource inventory was incomplete, so a score would be
            computed over an unknown fraction of the estate."
        >
          —
        </span>
      ),
    },
  }));

  return (
    <CloudSection
      title={`Identities${data.total ? ` (${data.total.toLocaleString()})` : ''}`}
      description="Every principal this platform holds, with what it can do and how much
        of that is being used."
      action={(
        <div className="flex items-center gap-2">
          {activeFilters > 0 && (
            <Button size="sm" variant="ghost" onClick={clearFilters}>
              {`Clear ${activeFilters} filter${activeFilters === 1 ? '' : 's'}`}
            </Button>
          )}
          <label className="relative block">
            <span className="sr-only">Search identities</span>
            <Icon
              name="search" size={13}
              className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-muted"
            />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name or id"
              className="w-56 rounded-control border border-border bg-surface py-1 pr-2 pl-7
                text-[12px] text-fg placeholder:text-subtle focus:border-accent focus:outline-none"
            />
          </label>
        </div>
      )}
      bodyClassName="p-0"
    >
      <Table
        columns={columns}
        rows={rows}
        loading={list.isLoading}
        rowHeight={44}
        virtualize
        empty={(
          <EmptyState
            icon="users"
            title={notRun ? 'No identity analysis has run' : 'No identities match'}
            body={notRun
              ? 'Use “Refresh identity & access” to collect the principal estate from '
                + 'the provider and evaluate it. Until then this is not a statement '
                + 'that the account has no identities.'
              : 'Adjust or clear the filters.'}
          />
        )}
      />
      {data.pages > 1 && (
        <div className="flex items-center justify-between gap-3 border-t border-border px-card py-2">
          <span className="text-meta text-muted">
            {`Page ${data.page} of ${data.pages}`}
          </span>
          <div className="flex gap-1">
            <Button
              size="sm" variant="secondary" disabled={page <= 1}
              onClick={() => setPage(page - 1)}
            >
              Previous
            </Button>
            <Button
              size="sm" variant="secondary" disabled={page >= data.pages}
              onClick={() => setPage(page + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </CloudSection>
  );
}
