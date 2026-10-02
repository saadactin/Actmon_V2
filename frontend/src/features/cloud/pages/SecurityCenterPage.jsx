import { useCallback, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Icon from '@/components/ui/Icon';
import Tabs from '@/components/ui/Tabs';
import Table, { EmptyState } from '@/components/ui/Table';
import { PageLoading } from '@/components/ui/Loading';
import CloudPageHeader from '../components/CloudPageHeader';
import CloudSection from '../components/CloudSection';
import CloudToolbar from '../components/CloudToolbar';
import SecurityScoreCard from '../components/security/SecurityScoreCard';
import SecurityFindings, { FindingDrawer } from '../components/security/SecurityFindings';
import SecurityCompliance from '../components/security/SecurityCompliance';
import SecurityAlerts, { SecurityPolicies } from '../components/security/SecurityAlerts';
import SecurityCertificates from '../components/security/SecurityCertificates';
import TabRefreshButton from '../components/refresh/TabRefreshButton';
import {
  CoveragePanel, ExposurePanel, IdentityPanel, Stat, TrendsPanel,
} from '../components/security/SecurityPanels';
import { useCloudScope } from '../hooks/useCloudScope';
import {
  useDiagnostics, useScoreExplanation, useSecurityMeta, useSecurityOverview,
} from '../hooks/useSecurityCenter';
import RefreshAllButton from '../components/refresh/RefreshAllButton';
import {
  categoryIcon, coverageTone, dimensionLabel, formatAge, formatCount, formatDateTime,
  formatPct, severityTone,
} from '../utils/securityModel';

const TABS = [
  { id: 'overview', label: 'Overview', icon: 'dashboard' },
  { id: 'findings', label: 'Findings', icon: 'list' },
  { id: 'alerts', label: 'Alerts', icon: 'bell' },
  { id: 'compliance', label: 'Compliance', icon: 'report' },
  { id: 'exposure', label: 'Internet Exposure', icon: 'globe' },
  { id: 'identity', label: 'Identity & Access', icon: 'key' },
  { id: 'certificates', label: 'Certificates & Secrets', icon: 'lock' },
  { id: 'coverage', label: 'Coverage', icon: 'gauge' },
  { id: 'trends', label: 'Trends', icon: 'chart-line' },
];

/**
 * The Security Center.
 *
 * Replaces the Security, Compliance and Alerts tabs, which were three
 * independent computations over the same estate with nothing enforcing that
 * they agreed — and on live data they did not. Every tab here reads the same
 * canonical findings, so a CRITICAL on Overview, the control it breaches on
 * Compliance and the alert it produced are the same row seen three ways.
 */
export default function SecurityCenterPage({ embedded = false, accountId: accountIdProp }) {
  const navigate = useNavigate();
  const scope = useCloudScope();
  const accountId = accountIdProp || scope.accountId;
  const accounts = scope.scopedAccounts;

  // `?view=certificates` opens a tab directly — the estate Certificates page
  // links here. Only a known tab id is honoured.
  const [searchParams] = useSearchParams();
  const [tab, setTab] = useState(() => {
    const view = searchParams.get('view');
    return TABS.some((t) => t.id === view) ? view : 'overview';
  });
  const [findingFilters, setFindingFilters] = useState(null);
  // `?finding=<fingerprint>` opens that finding — the certificate drawer on
  // pages without a finding drawer of their own links here.
  const [drawerFinding, setDrawerFinding] = useState(() => searchParams.get('finding'));

  const { data: meta } = useSecurityMeta();
  const { data: overview, isLoading, isError, error } = useSecurityOverview(accountId);
  const { data: explanation } = useScoreExplanation(accountId, tab === 'overview');

  const canManage = useMemo(
    () => (meta?.rbac?.permissions || []).includes('security:manage_policies')
      // While RBAC enforcement is off the caller is unauthenticated but still
      // holds a role; the summary reports its permissions, so trust it rather
      // than hiding management behind a login that does not exist yet.
      || meta?.rbac?.rbac_enforced === false,
    [meta],
  );

  const openFindings = useCallback((filters) => {
    setFindingFilters(filters || null);
    setTab('findings');
  }, []);

  if (!accountId) {
    return (
      <CloudSection>
        <EmptyState
          icon="cloud"
          title="Select a cloud account"
          body="The Security Center assesses one account at a time. Pick one to begin."
        />
      </CloudSection>
    );
  }

  const score = overview?.score;
  const fresh = overview?.freshness;
  const findings = overview?.findings_summary;

  return (
    <>
      {/* Each sub-tab has its own "Refresh <tab>" beside the sub-tab strip:
          certificates and identity re-read the provider, the rest re-evaluate
          the stored inventory, and the caption says which happened. The
          header's "Refresh all" re-reads everything. */}
      {!embedded && (
        <CloudPageHeader
          backTo="/cloud"
          icon="shield"
          title="Security Center"
          actions={accounts?.length > 0 && (
            <CloudToolbar
              selectorProps={{
                accounts,
                mode: 'single',
                selected: accountId,
                onSelect: (id) => id && scope.setAccountScope(id),
              }}
            >
              <RefreshAllButton accountId={accountId} />
            </CloudToolbar>
          )}
        />
      )}

      <div className="mb-4 flex items-center gap-3">
        <Tabs tabs={TABS} value={tab} onChange={setTab} className="min-w-0 flex-1" />
        <TabRefreshButton accountId={accountId} tabKey={`security.${tab}`} />
      </div>

      {isError && (
        <CloudSection>
          <EmptyState
            icon="alert"
            title="Security Center unavailable"
            body={error?.response?.data?.detail || error?.message
              || 'The request failed. This is a load error, not a clean result.'}
          />
        </CloudSection>
      )}

      {!isError && tab === 'overview' && (
        isLoading ? <PageLoading title="Loading security posture…" /> : (
          <div className="space-y-5">
            {!embedded && <FreshnessLine freshness={fresh} />}

            {fresh?.inventory_stale && (
              <div className="flex items-start gap-2 rounded-control border border-warning-soft bg-warning-soft p-3 text-xs text-warning-fg">
                <Icon name="clock" size={15} className="mt-0.5 shrink-0" />
                <div>
                  <p className="font-semibold">
                    The inventory behind these findings is {formatAge(fresh.inventory_age_seconds)}.
                  </p>
                  <p className="mt-0.5 leading-relaxed">
                    {fresh.note} Refresh all, at the top of the page, re-reads it from the
                    provider and re-assesses.
                  </p>
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(240px,1fr)_3fr]">
              <SecurityScoreCard
                score={score}
                coveragePct={overview?.coverage_pct}
                explanation={explanation}
              />

              <div className="flex flex-col gap-4">
                {/* Confirmed and undetermined are separate rows on purpose.
                    Merging them is how an account with 49 unevaluated VMs
                    displays as having nothing wrong. */}
                <div>
                  <div className="mb-1.5 flex items-center gap-2">
                    <h3 className="text-[11px] font-bold uppercase tracking-wider text-muted">
                      Confirmed findings
                    </h3>
                    <Badge tone="neutral" size="xs">{formatCount(findings?.confirmed)}</Badge>
                  </div>
                  <div className="grid grid-cols-2 gap-3 xl:grid-cols-5">
                    {['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'].map((sev) => (
                      <button
                        key={sev}
                        type="button"
                        onClick={() => openFindings({ severity: sev, verdict: 'VULNERABLE' })}
                        className="card px-3 py-2.5 text-left transition-colors hover:border-strong"
                      >
                        <div className="text-[10px] font-bold uppercase tracking-wider text-muted">
                          {sev}
                        </div>
                        <div className="mt-0.5 text-2xl font-bold text-fg">
                          {findings?.by_severity?.[sev] ?? 0}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>

                {findings?.undetermined > 0 && (
                  <button
                    type="button"
                    onClick={() => openFindings({ verdict: 'UNKNOWN,NOT_SCANNED' })}
                    className="card flex items-center gap-3 px-card py-3 text-left transition-colors hover:border-strong"
                  >
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-warning-soft text-warning-fg">
                      <Icon name="help" size={18} />
                    </div>
                    <div className="min-w-0">
                      <div className="text-[13px] font-semibold text-fg">
                        {formatCount(findings.undetermined)} check
                        {findings.undetermined === 1 ? '' : 's'} could not be determined
                      </div>
                      <div className="text-[11px] leading-relaxed text-muted">
                        These are findings that are <em>missing</em>, not findings that are
                        absent. Coverage is {formatPct(overview?.coverage_pct, { nullLabel: 'unknown' })}.
                      </div>
                    </div>
                    <Icon name="chevron-right" size={16} className="ml-auto shrink-0 text-subtle" />
                  </button>
                )}

                <div className="grid grid-cols-2 gap-3.5 xl:grid-cols-4">
                  <ClickStat
                    label="Active alerts" value={overview?.alerts_summary?.active}
                    tone="bg-danger-soft text-danger-fg" icon="bell"
                    onClick={() => setTab('alerts')}
                  />
                  <ClickStat
                    label="Exposed resources" value={overview?.exposure_summary?.exposed_resources}
                    tone="bg-warning-soft text-warning-fg" icon="globe"
                    onClick={() => setTab('exposure')}
                    caption={overview?.exposure_summary?.undetermined_resources > 0
                      ? `+${overview.exposure_summary.undetermined_resources} unevaluated`
                      : undefined}
                  />
                  <ClickStat
                    label="Escalation paths" value={overview?.identity_summary?.escalation_paths}
                    tone="bg-danger-soft text-danger-fg" icon="key"
                    onClick={() => setTab('identity')}
                    caption={!overview?.identity_summary?.trustworthy
                      ? 'identity not collected' : undefined}
                  />
                  <ClickStat
                    label="Data coverage"
                    value={overview?.coverage_pct != null
                      ? `${Math.round(overview.coverage_pct)}%` : '—'}
                    tone="bg-info-soft text-info-fg" icon="gauge"
                    onClick={() => setTab('coverage')}
                    raw
                  />
                </div>
              </div>
            </div>

            {/* Critical issues panel (§37) */}
            <CloudSection
              title="Top risks"
              description="Confirmed findings only, worst first. Undetermined checks are on the Coverage tab, because they describe a gap in our data rather than a problem in the estate."
              action={(
                <Button size="sm" icon="list" onClick={() => openFindings(null)}>
                  All findings
                </Button>
              )}
            >
              {(overview?.top_risks || []).length === 0 ? (
                <EmptyState
                  icon={findings?.undetermined > 0 ? 'help' : 'shield-check'}
                  title={findings?.undetermined > 0
                    ? 'No confirmed risks — but the assessment is incomplete'
                    : 'No confirmed risks'}
                  body={findings?.undetermined > 0
                    ? `${findings.undetermined} check(s) could not be determined. Fix the `
                      + 'collection gaps on the Coverage tab before reading this as clean.'
                    : 'Every check that could run found no confirmed problem.'}
                />
              ) : (
                <Table
                  columns={[
                    { key: 'sev', label: 'Severity', width: 100 },
                    { key: 'what', label: 'Finding' },
                    { key: 'res', label: 'Resource' },
                    { key: 'cat', label: 'Category', width: 160 },
                  ]}
                  rows={overview.top_risks.map((f) => ({
                    key: f.fingerprint,
                    onClick: () => setDrawerFinding(f.fingerprint),
                    cells: {
                      sev: <Badge tone={severityTone(f.severity)}>{f.severity}</Badge>,
                      what: (
                        <div className="min-w-0">
                          <div className="truncate-safe text-[13px] font-medium text-fg">
                            {f.title}
                          </div>
                          {f.affected_count > 1 && (
                            <div className="text-[11px] text-subtle">
                              {formatCount(f.affected_count)} resources affected
                            </div>
                          )}
                        </div>
                      ),
                      res: (
                        <span className="truncate-safe text-[12px] text-muted">
                          {f.resource_name || 'Account-wide'}
                        </span>
                      ),
                      cat: (
                        <span className="inline-flex items-center gap-1.5 text-[12px] text-muted">
                          <Icon name={categoryIcon(f.category)} size={13} />
                          {f.category}
                        </span>
                      ),
                    },
                  }))}
                />
              )}
            </CloudSection>

            <ScanStatusPanel accountId={accountId} />
          </div>
        )
      )}

      {!isError && tab === 'findings' && (
        <SecurityFindings
          accountId={accountId}
          meta={meta}
          initialFilters={findingFilters}
        />
      )}

      {!isError && tab === 'alerts' && (
        <div className="space-y-6">
          <SecurityAlerts accountId={accountId} onOpenFinding={setDrawerFinding} />
          <CloudSection
            title="Alert policies"
          >
            <SecurityPolicies accountId={accountId} canManage={canManage} />
          </CloudSection>
        </div>
      )}

      {!isError && tab === 'compliance' && (
        <SecurityCompliance accountId={accountId} onOpenFindings={openFindings} />
      )}

      {!isError && tab === 'exposure' && <ExposurePanel accountId={accountId} />}
      {!isError && tab === 'identity' && <IdentityPanel accountId={accountId} />}
      {!isError && tab === 'certificates' && (
        <SecurityCertificates accountId={accountId} onOpenFinding={setDrawerFinding} />
      )}
      {!isError && tab === 'coverage' && <CoveragePanel accountId={accountId} />}
      {!isError && tab === 'trends' && <TrendsPanel accountId={accountId} />}

      <FindingDrawer
        accountId={accountId}
        findingKey={drawerFinding}
        onClose={() => setDrawerFinding(null)}
        meta={meta}
      />
    </>
  );
}

/**
 * The three timestamps, side by side and never conflated (§7).
 *
 * "Last verified against the provider" is deliberately shown as never for an
 * ordinary assessment: the engine reads stored inventory, so the strongest
 * honest claim is "evaluated". Reusing the assessment time here would be a
 * real-time claim over data that may be 70 days old.
 */
function FreshnessLine({ freshness }) {
  if (!freshness) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[11px] text-muted">
      <span className="inline-flex items-center gap-1.5">
        <Icon name="cloud" size={13} />
        Inventory collected{' '}
        <span className={freshness.inventory_stale ? 'font-semibold text-warning-fg' : 'text-fg'}>
          {formatAge(freshness.inventory_age_seconds)}
        </span>
      </span>
      <span className="inline-flex items-center gap-1.5">
        <Icon name="shield" size={13} />
        Last assessed{' '}
        <span className={freshness.assessment_stale ? 'font-semibold text-warning-fg' : 'text-fg'}>
          {formatAge(freshness.assessment_age_seconds)}
        </span>
      </span>
      <span className="inline-flex items-center gap-1.5" title={freshness.note}>
        <Icon name="info" size={13} />
        Verified against provider{' '}
        <span className="text-fg">
          {freshness.last_verified_against_provider
            ? formatDateTime(freshness.last_verified_against_provider)
            : 'never'}
        </span>
      </span>
    </div>
  );
}

/** Scan status per subsystem (§56). Never hides a coverage problem. */
function ScanStatusPanel({ accountId }) {
  const { data } = useDiagnostics(accountId, true);
  if (!data) return null;
  const rows = [
    ['Inventory', data.inventory?.status,
      [
        `${formatCount(data.inventory?.resources)} resources`,
        data.inventory?.scopes_attempted
          ? `${formatCount(data.inventory.scopes_read)} of `
            + `${formatCount(data.inventory.scopes_attempted)} scopes read`
          : null,
        formatDateTime(data.inventory?.last_discovery),
      ].filter(Boolean).join(' · ')],
    ['Security assessment', data.assessment?.status,
      `${data.assessment?.rules_applicable_to_this_inventory} of `
      + `${data.assessment?.rules_available} checks apply to this inventory`],
    ['Identity', data.identity?.status,
      data.identity?.note
        || (data.identity?.missing_permission
          ? `missing ${data.identity.missing_permission}`
          : `${data.identity?.grant_count ?? 0} grants`)],
  ];
  return (
    <CloudSection
      title="Scan status"
    >
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {rows.map(([label, status, detail]) => {
          const ok = ['Complete', 'COMPLETE', 'Collected'].includes(status);
          const partial = ['PARTIAL', 'Partial'].includes(status);
          const unknown = !status || status === 'Unknown';
          return (
            <div key={label} className="rounded-control border border-border p-3">
              <div className="flex items-center justify-between">
                <span className="text-[12px] font-semibold text-fg">{label}</span>
                <Badge tone={ok ? 'success' : partial ? 'warning' : unknown ? 'neutral' : 'danger'}>
                  {status || 'Unknown'}
                </Badge>
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-muted">{detail}</p>
            </div>
          );
        })}
      </div>
      {data.coverage && (
        <div className="mt-3 flex flex-wrap gap-2">
          {Object.entries(data.coverage).map(([dim, pct]) => (
            <Badge key={dim} tone={coverageTone(pct)}>
              {dimensionLabel(dim)}: {formatPct(pct, { nullLabel: 'n/a' })}
            </Badge>
          ))}
        </div>
      )}
    </CloudSection>
  );
}

function ClickStat({ label, value, tone, icon, onClick, caption, raw }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="card flex items-center gap-3.5 p-card text-left transition-colors hover:border-strong"
    >
      <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${tone}`}>
        <Icon name={icon} size={18} />
      </div>
      <div className="min-w-0">
        <div className="truncate-safe text-[11px] font-semibold uppercase tracking-wider text-muted">
          {label}
        </div>
        <div className="mt-0.5 text-2xl font-bold text-fg">
          {raw ? (value ?? '—') : formatCount(value)}
        </div>
        {caption && <div className="truncate-safe text-[10px] text-warning-fg">{caption}</div>}
      </div>
    </button>
  );
}
