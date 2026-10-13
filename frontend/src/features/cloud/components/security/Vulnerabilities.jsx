import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Badge from '@/components/ui/Badge';
import Icon from '@/components/ui/Icon';
import Table, { EmptyState } from '@/components/ui/Table';
import { PageLoading } from '@/components/ui/Loading';
import CloudSection from '../CloudSection';
import { Stat } from './SecurityPanels';
import { useVulnerabilities } from '../../hooks/useSecurityCenter';
import { formatCount, formatPct, severityTone } from '../../utils/securityModel';

/**
 * Vulnerabilities — deliberately leading with what this product does NOT know.
 *
 * No CVE feed ships with ACTMON. The temptation in a panel like this is to
 * render an empty table and let it imply a clean bill, which is the most
 * damaging thing it could do: an operator who reads "0 vulnerabilities" stops
 * looking. So when `source_configured` is false the first thing on the page is
 * a banner saying nothing has been assessed, and the resource table is framed
 * as an inventory of what WOULD be assessed rather than as a result.
 *
 * What is real here is the identity half. The scanners now resolve an AMI, an
 * Azure image reference and an OCI image OCID into an operating system, so
 * `coverage` is a true measurement — and the reachability column beside each
 * resource is the thing that will decide which CVE matters first, the day a
 * feed is wired in.
 */

const STATUS_TONE = {
  resolved: 'success',
  opaque: 'warning',
  not_collected: 'danger',
  not_applicable: 'neutral',
};

const REACH_TONE = { EXPOSED: 'danger', PROTECTED: 'success', UNKNOWN: 'warning' };

export default function VulnerabilitiesPanel({ accountId, enabled = true }) {
  const navigate = useNavigate();
  const { data, isLoading, isError, error } = useVulnerabilities(accountId, enabled);
  const [onlyReachable, setOnlyReachable] = useState(false);

  const rows = useMemo(() => {
    const all = data?.resources || [];
    return onlyReachable ? all.filter((r) => r.internet_reachable) : all;
  }, [data, onlyReachable]);

  if (isLoading) return <PageLoading title="Reading software identity…" minHeight={220} />;
  if (isError) {
    return (
      <CloudSection>
        <EmptyState
          icon="alert"
          title="Vulnerability view unavailable"
          body={error?.response?.data?.detail
            || 'The request failed. This is a load error, not a clean result.'}
        />
      </CloudSection>
    );
  }
  if (!data) return null;

  const cov = data.coverage || {};
  const byStatus = cov.by_status || {};
  const reachable = (data.resources || []).filter((r) => r.internet_reachable).length;

  return (
    <div className="space-y-4">
      {/* ── The banner that stops an empty table being read as a clean one ── */}
      {!data.source_configured && (
        <div className="flex items-start gap-2 rounded-control border border-warning-soft bg-warning-soft p-3 text-xs text-warning-fg">
          <Icon name="alert" size={15} className="mt-0.5 shrink-0" />
          <div>
            <p className="font-semibold">
              No vulnerability source is configured — nothing below has been assessed.
            </p>
            <p className="mt-1 leading-relaxed">{data.source?.unavailable_reason}</p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3.5 lg:grid-cols-4">
        <Stat
          label="OS identified"
          value={cov.resolved}
          tone="bg-success-soft text-success-fg"
          icon="check"
        />
        <Stat
          label="Compute resources"
          value={cov.versionable_resources}
          tone="bg-info-soft text-info-fg"
          icon="server"
        />
        <Stat
          label="Internet reachable"
          value={reachable}
          tone="bg-danger-soft text-danger-fg"
          icon="globe"
        />
        <Stat
          label="CVEs matched"
          value={data.source_configured ? data.vulnerabilities_found : 'Not assessed'}
          tone="bg-neutral-soft text-muted"
          icon="shield"
        />
      </div>

      <CloudSection
        title="Operating-system identification"
        description="Resolved from AMI metadata, Azure image references and OCI image OCIDs — not from resource names."
      >
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            {Object.entries(byStatus).map(([status, n]) => (
              <Badge key={status} tone={STATUS_TONE[status] || 'neutral'} size="xs">
                {cov.status_labels?.[status] || status}: {formatCount(n)}
              </Badge>
            ))}
          </div>
          <p className="text-micro leading-relaxed text-subtle">
            {cov.resolved_pct === null
              ? 'This account has no compute resources whose software could be versioned, so there is no coverage figure to report.'
              : `${formatPct(cov.resolved_pct)} of versionable compute resources have an identifiable operating system. Resources that cannot be identified are listed below with the reason — a custom image genuinely cannot be resolved from inventory, while uncollected metadata is a gap that can be closed.`}
          </p>
        </div>
      </CloudSection>

      <CloudSection
        title={`Compute resources (${rows.length})`}
        description={
          data.source_configured
            ? 'Assessed against the configured vulnerability source.'
            : 'What would be assessed once a vulnerability source is configured. The reachability column is what will decide the order of work.'
        }
        action={
          <button
            type="button"
            onClick={() => setOnlyReachable((v) => !v)}
            className={`rounded-control border px-2 py-1 text-micro transition-colors ${
              onlyReachable
                ? 'border-accent bg-accent-soft text-accent-text'
                : 'border-border text-muted hover:border-accent hover:text-accent'
            }`}
          >
            {onlyReachable ? 'Showing internet-reachable only' : 'Internet-reachable only'}
          </button>
        }
      >
        {rows.length === 0 ? (
          <EmptyState
            icon="server"
            title={onlyReachable ? 'No internet-reachable compute resources' : 'No compute resources'}
            body={
              onlyReachable
                ? 'No compute resource in this account was confirmed reachable from the internet.'
                : 'This account has no resources whose software could be versioned.'
            }
          />
        ) : (
          <Table
            columns={[
              { key: 'resource', label: 'Resource' },
              { key: 'os', label: 'Operating system' },
              { key: 'reach', label: 'Internet reachable' },
              { key: 'path', label: 'Attack path' },
              { key: 'cves', label: 'CVEs' },
            ]}
            rows={rows.map((r) => ({
              key: r.resource_id,
              onClick: () => navigate(`/cloud/resources/${r.resource_id}`),
              cells: {
                resource: (
                  <div>
                    <div className="text-fg">{r.resource_name || r.resource_id}</div>
                    <div className="text-micro text-subtle">{r.identity?.resource_type}</div>
                  </div>
                ),
                os: r.identity?.status === 'resolved' ? (
                  <span className="text-fg">{r.identity.identifier}</span>
                ) : (
                  <Badge tone={STATUS_TONE[r.identity?.status] || 'neutral'} size="xs">
                    {r.identity?.status_label}
                  </Badge>
                ),
                reach: (
                  <span className="flex flex-wrap items-center gap-1.5">
                    <Badge
                      tone={REACH_TONE[r.reachability_verdict] || 'neutral'}
                      size="xs"
                      title={r.context_note}
                    >
                      {r.reachability_known ? r.reachability_verdict : 'Not determined'}
                    </Badge>
                    {(r.open_ports || []).length > 0 && (
                      <span className="text-micro text-subtle">
                        {r.open_ports.map((p) => p.label).join(', ')}
                      </span>
                    )}
                  </span>
                ),
                path: r.on_attack_path ? (
                  <Badge tone="danger" size="xs">
                    {(r.attack_path_ids || []).length} path
                    {(r.attack_path_ids || []).length === 1 ? '' : 's'}
                  </Badge>
                ) : (
                  <span className="text-micro text-subtle">—</span>
                ),
                cves: data.source_configured ? (
                  r.vulnerability_count > 0 ? (
                    <Badge tone={severityTone(r.worst_severity)}>
                      {r.vulnerability_count} ({r.worst_severity})
                    </Badge>
                  ) : (
                    <span className="text-micro text-subtle">None found</span>
                  )
                ) : (
                  <span className="text-micro italic text-subtle">Not assessed</span>
                ),
              },
            }))}
          />
        )}
      </CloudSection>

      <CloudSection
        title="Adding a vulnerability source"
        description="What exists, and what is still required."
      >
        <div className="space-y-2 text-micro leading-relaxed text-subtle">
          <p>
            The inventory half is in place: every compute resource above has been
            resolved as far as its provider allows, and each row already carries the
            reachability verdict and attack paths that decide which finding matters
            first. What is missing is a source of CVE records to match against.
          </p>
          <p>
            A source plugs in as a <span className="font-mono text-fg">VulnerabilityProvider</span>{' '}
            implementation — NVD, OSV or a vendor feed — and nothing else changes. No
            re-scan is needed, because the software identity is already collected.
          </p>
          <div className="flex flex-wrap gap-1.5 pt-1">
            {(data.providers || []).map((p) => (
              <Badge key={p.name} tone={p.configured ? 'success' : 'neutral'} size="xs">
                {p.name}: {p.configured ? 'configured' : 'not configured'}
              </Badge>
            ))}
          </div>
        </div>
      </CloudSection>
    </div>
  );
}
