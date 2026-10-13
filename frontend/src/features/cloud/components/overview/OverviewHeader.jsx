import Badge from '@/components/ui/Badge';
import Icon from '@/components/ui/Icon';
import CopyButton from '@/components/ui/CopyButton';
import { formatDateTime, relativeTime } from '../../utils/resourceModel';
import { compact } from '../../utils/costFormat';
import { FreshnessBadge, Kpi, Panel, PanelEmpty } from './OverviewPrimitives';

/**
 * Account identity, freshness, and the numbers worth knowing before scrolling.
 *
 * The identity block is deliberately provider-shaped. An OCI account has a
 * tenancy and a compartment tree; an Azure one has a subscription inside a
 * tenant; an AWS one has an account id and a home region. Flattening those into
 * one generic "Account ID" row would print the wrong label for two of the three
 * providers, and people navigate by these identifiers.
 */

// Region is deliberately absent. Discovery scans every region an account can
// reach, so a single "Region: ap-south-1" here described the region the
// credentials were configured in and nothing about where the resources are —
// on an account with 227 resources across several regions it was simply wrong,
// and it invited the reasonable conclusion that only one region was scanned.
// Where resources actually live is answered by the region distribution panel
// further down, which counts them.
const IDENTITY = {
  OCI: [
    ['Tenancy', (a) => a.tenant_id || a.tenant_or_region],
  ],
  Azure: [
    ['Subscription', (a) => a.subscription_id || a.account_identifier],
    ['Tenant', (a) => a.tenant_id || a.tenant_or_region],
  ],
  AWS: [
    ['Account', (a) => a.account_identifier || a.aws_account_id],
  ],
};

export function AccountIdentity({ account, freshness }) {
  const provider = account?.provider === 'Oracle' ? 'OCI' : account?.provider;
  const rows = (IDENTITY[provider] || IDENTITY.AWS)
    .map(([label, get]) => [label, get(account || {})])
    .filter(([, value]) => value);

  return (
    <div className="card flex flex-wrap items-start justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-[17px] font-bold text-fg">{account?.account_name || 'Account'}</h2>
          <Badge tone="neutral" size="sm">{provider || 'Unknown provider'}</Badge>
          {account?.environment && <Badge tone="accent" size="sm">{account.environment}</Badge>}
          {freshness && (
            <FreshnessBadge
              severity={freshness.severity}
              /* The header's "Last refreshed" formats its time with the same
                 function, so the two cannot read "1 hours" and "2 hours" for
                 one scan, as the server's floored label did beside it. */
              label={freshness.observed_at ? relativeTime(freshness.observed_at) : undefined}
              title={
                freshness.observed_at
                  ? `Inventory last observed ${formatDateTime(freshness.observed_at)}`
                  : 'This account has never completed a discovery sweep.'
              }
            />
          )}
        </div>

        <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1">
          {rows.map(([label, value]) => (
            <div key={label} className="flex min-w-0 items-baseline gap-1.5">
              <dt className="text-micro font-bold uppercase tracking-wider text-subtle">{label}</dt>
              <dd className="flex min-w-0 items-center gap-1 font-mono text-meta text-muted">
                <span className="max-w-[26rem] truncate" title={String(value)}>{String(value)}</span>
                <CopyButton text={String(value)} label="" variant="ghost" />
              </dd>
            </div>
          ))}
        </dl>
      </div>

      {/* No refresh button here: the account header above every tab has the
          one "Refresh all", which runs discovery and everything after it. */}
    </div>
  );
}

/**
 * The scan panel.
 *
 * Shows the last attempt and the last success separately, because when a scan
 * fails those are different runs and only one of them tells you how old the
 * inventory is. Added/changed/removed come from the drift log written by that
 * run — they are omitted entirely when the run predates change recording,
 * rather than printed as three zeros.
 */
export function DiscoveryPanel({ discovery, isLoading, error, onOpenDiagnostic }) {
  const latest = discovery?.latest;
  const lastOk = discovery?.last_successful;
  const changes = discovery?.changes;
  const failed = discovery?.last_attempt_failed;

  const duration = lastOk?.duration_ms != null
    ? `${(lastOk.duration_ms / 1000).toFixed(1)}s`
    : null;

  return (
    /* Status only. Its "Run" button started a plain discovery — a subset of
       the header's Refresh all, under a different name. */
    <Panel
      title="Discovery"
      icon="refresh"
      loading={isLoading}
      error={error}
      dense
    >
      {!latest ? (
        <PanelEmpty>
          No discovery has ever been run for this account.
        </PanelEmpty>
      ) : (
        <div className="space-y-2">
          {failed && (
            <div className="flex items-start gap-2 rounded-control border border-danger bg-danger-soft px-3 py-2">
              <Icon name="alert" size={14} className="mt-0.5 shrink-0 text-danger" />
              <div className="min-w-0 text-meta leading-snug">
                <p className="font-semibold text-danger">The most recent scan failed</p>
                <p className="mt-0.5 text-muted">
                  {latest.error_detail
                    ? String(latest.error_detail).slice(0, 220)
                    : 'No error detail was recorded.'}
                </p>
                <p className="mt-0.5 text-muted">
                  The inventory below is from the last successful scan and may be out of date.
                </p>
                <button
                  type="button"
                  onClick={onOpenDiagnostic}
                  className="mt-1 font-semibold text-accent-text hover:underline"
                >
                  View diagnostic
                </button>
              </div>
            </div>
          )}

          <Row label="Status" value={(
            <Badge
              tone={latest.status === 'COMPLETED' ? 'success' : latest.status === 'FAILED' ? 'danger' : 'info'}
              size="xs"
            >
              {latest.status}
            </Badge>
          )}
          />
          <Row
            label="Last successful"
            value={lastOk?.completed_at
              ? `${relativeTime(lastOk.completed_at)}`
              : 'Never'}
            title={lastOk?.completed_at ? formatDateTime(lastOk.completed_at) : undefined}
          />
          {duration && <Row label="Duration" value={duration} />}
          {lastOk?.resources_found != null && (
            <Row label="Resources found" value={lastOk.resources_found.toLocaleString()} />
          )}

          {changes ? (
            <div className="flex flex-wrap gap-1.5 border-t border-border pt-2">
              {changes.CREATED > 0 && <Badge tone="success" size="xs">{`+${changes.CREATED} added`}</Badge>}
              {changes.MODIFIED > 0 && <Badge tone="info" size="xs">{`${changes.MODIFIED} changed`}</Badge>}
              {changes.DELETED > 0 && <Badge tone="warning" size="xs">{`-${changes.DELETED} removed`}</Badge>}
            </div>
          ) : (
            <p className="border-t border-border pt-2 text-meta leading-snug text-subtle">
              This run recorded no change entries. Change recording begins with
              the first sweep after drift capture was enabled, so an older run
              has nothing to report rather than nothing to show.
            </p>
          )}
        </div>
      )}
    </Panel>
  );
}

const Row = ({ label, value, title }) => (
  <div className="flex items-center justify-between gap-2 text-[12px]">
    <span className="text-muted">{label}</span>
    <span className="font-semibold text-fg" title={title}>{value}</span>
  </div>
);

/**
 * The KPI strip.
 *
 * Each tile is a link into the system that owns its number, carrying the filter
 * that produced it — so the count you clicked is the set you land on.
 */
export function OverviewKpis({
  summary, cost, region, posture, isLoading, costLoading, postureLoading,
  costError, postureError, onNavigate,
}) {
  const score = posture?.score;
  const bySeverity = posture?.findings_summary?.by_severity || {};

  // `total_monthly_cost_inr` is the account's native spend converted with a
  // live FX rate (see `cost_service.estimate_costs` / `fx_rate_service`), so
  // an AWS (USD) account and an OCI (INR) account read in the same unit here.
  const costValueInr = cost?.total_monthly_cost_inr;
  const costUnavailable = costValueInr === null || costValueInr === undefined;

  // 24px gutter and a 200px floor, so these line up with the Dashboard's and
  // Infra's stat rows; at the old 160px a 30px value had nowhere to go.
  return (
    <div className="grid gap-gutter-lg [grid-template-columns:repeat(auto-fit,minmax(200px,1fr))]">
      <Kpi
        label="Resources"
        icon="boxes"
        loading={isLoading}
        value={summary ? summary.resource_count.toLocaleString() : '—'}
        sub="Discovered in this account"
        onClick={() => onNavigate('resources')}
      />

      <Kpi
        label={region ? `Billed Spend — ${region}` : 'Billed Spend'}
        icon="report"
        loading={costLoading}
        unavailable={costUnavailable}
        value={costUnavailable ? 'NA' : compact(costValueInr, 'INR')}
        sub={costError ? 'Billing query failed' : cost?.note?.slice(0, 48) || 'Last 30 days'}
        title={
          costUnavailable
            ? 'The provider billing API returned no cost for this account. This is not a cost of zero.'
            : `${cost?.note || ''}`
        }
        onClick={() => onNavigate('cost')}
      />

      <Kpi
        label="Security"
        icon="shield"
        loading={postureLoading}
        unavailable={postureError || score?.score == null}
        tone={score?.grade === 'F' || score?.grade === 'D' ? 'danger' : score?.grade === 'C' ? 'warning' : 'success'}
        value={score?.score != null ? `${score.score} · ${score.grade}` : 'NA'}
        sub={
          postureError ? 'Posture unavailable'
            : bySeverity.CRITICAL || bySeverity.HIGH
              ? `${bySeverity.CRITICAL || 0} critical · ${bySeverity.HIGH || 0} high`
              : 'No critical or high findings'
        }
        onClick={() => onNavigate('security')}
      />

      <Kpi
        label="Stopped"
        icon="stop"
        loading={isLoading}
        value={summary ? summary.stopped_count.toLocaleString() : '—'}
        sub="Not running"
        onClick={() => onNavigate('resources', { status: 'STOPPED' })}
      />

      <Kpi
        label="Unattached"
        icon="plug"
        loading={isLoading}
        value={summary ? summary.unattached_count.toLocaleString() : '—'}
        sub="Storage with no host"
        onClick={() => onNavigate('resources', { attachment: 'UNATTACHED' })}
      />

      <Kpi
        label="Untagged"
        icon="bookmark"
        loading={isLoading}
        tone={summary?.untagged_count > 0 ? 'warning' : 'neutral'}
        value={summary ? summary.untagged_count.toLocaleString() : '—'}
        sub="No tags at all"
        onClick={() => onNavigate('resources', { has_tags: 'false' })}
      />
    </div>
  );
}

