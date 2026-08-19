import { KeyRound, ShieldAlert, Info, ExternalLink } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useIamReview } from '../hooks/useSecurity';
import CloudSection from './CloudSection';
import Badge from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/Table';
import { PageLoading } from '@/components/ui/Loading';

const SEVERITY_TONE = { CRITICAL: 'danger', HIGH: 'danger', MEDIUM: 'warning' };
const SEVERITY_ACCENT = { CRITICAL: 'border-l-danger', HIGH: 'border-l-danger', MEDIUM: 'border-l-warning' };

/**
 * Ranks identities (AWS IAM roles, OCI IAM policies) by how much they can
 * reach versus how narrowly they were scoped — wildcard grants like
 * `dynamodb:full` on `Resource: "*"`, and OCI policy statements like
 * `manage all-resources in tenancy`. See
 * Backend/cloud/app/services/iam_review_service.py.
 *
 * Azure renders its own explicit "not scanned" state rather than an empty,
 * falsely-reassuring list — RBAC role assignments aren't collected yet.
 */
export default function IamAccessReviewPanel({ accountId }) {
  const navigate = useNavigate();
  const { data, isLoading, isError } = useIamReview(accountId);

  if (isLoading) return <PageLoading title="Reviewing IAM grants…" minHeight={200} />;
  if (isError || !data) {
    return (
      <CloudSection>
        <EmptyState icon="alert-triangle" title="IAM review unavailable"
          body="Could not compute the IAM access review for this account." />
      </CloudSection>
    );
  }

  if (data.not_scanned) {
    return (
      <CloudSection>
        <div className="flex flex-col items-center gap-3 py-10 px-5 text-center">
          <span className="grid h-14 w-14 place-items-center rounded-full bg-neutral-soft text-muted">
            <Info size={26} />
          </span>
          <h3 className="text-[15px] font-semibold text-fg">Not Yet Available for {data.provider}</h3>
          <p className="max-w-sm text-sm text-muted">{data.reason}</p>
        </div>
      </CloudSection>
    );
  }

  const { findings, total_identities_reviewed, total_flagged, escalation_risk_count, by_severity } = data;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3.5 sm:grid-cols-4">
        {[
          { label: 'Identities Reviewed', count: total_identities_reviewed, tone: 'bg-info-soft text-info-fg', icon: <KeyRound size={18} /> },
          { label: 'Over-Permissioned', count: total_flagged, tone: 'bg-warning-soft text-warning-fg', icon: <ShieldAlert size={18} /> },
          { label: 'Critical', count: by_severity.CRITICAL || 0, tone: 'bg-danger-soft text-danger-fg', icon: <ShieldAlert size={18} /> },
          { label: 'Can Escalate Privileges', count: escalation_risk_count, tone: 'bg-danger-soft text-danger-fg', icon: <ShieldAlert size={18} /> },
        ].map((s) => (
          <div key={s.label} className="card flex items-center gap-3 p-card">
            <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${s.tone}`}>{s.icon}</div>
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-muted">{s.label}</div>
              <div className="text-xl font-bold text-fg">{s.count}</div>
            </div>
          </div>
        ))}
      </div>

      {findings.length === 0 ? (
        <CloudSection>
          <EmptyState icon="shield-check" title="No over-permissioned identities found"
            body={`All ${total_identities_reviewed} identit${total_identities_reviewed === 1 ? 'y' : 'ies'} reviewed are scoped to specific resources or read-only access.`} />
        </CloudSection>
      ) : (
        <div className="flex flex-col gap-3">
          {findings.map((f) => (
            <div key={f.id} className={`card border-l-4 px-card py-4 ${SEVERITY_ACCENT[f.severity] || 'border-l-border'}`}>
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <h4 className="text-[15px] font-semibold text-fg">{f.name}</h4>
                    <Badge tone={SEVERITY_TONE[f.severity] || 'neutral'}>{f.severity}</Badge>
                    {f.can_escalate_privileges && <Badge tone="danger">Privilege Escalation</Badge>}
                  </div>
                  <p className="mt-1.5 text-sm text-muted">{f.reason}</p>

                  {/* AWS shape: a flat wildcard-grant list. */}
                  {f.wildcard_grants && (
                    <div className="mt-2.5 flex flex-wrap gap-1.5">
                      {f.wildcard_grants.map((g) => (
                        <span key={g} className="rounded-md bg-warning-soft px-2 py-0.5 text-[11px] font-semibold text-warning-fg">
                          {g}
                        </span>
                      ))}
                      {f.concrete_grant_count > 0 && (
                        <span className="rounded-md bg-neutral-soft px-2 py-0.5 text-[11px] text-muted">
                          +{f.concrete_grant_count} scoped grant{f.concrete_grant_count !== 1 ? 's' : ''}
                        </span>
                      )}
                    </div>
                  )}

                  {/* OCI shape: the specific policy statements that triggered this. */}
                  {f.statements && (
                    <div className="mt-2.5 flex flex-col gap-1">
                      {f.statements.map((s, i) => (
                        <code key={i} className="rounded-control bg-sunken px-2 py-1 text-[11px] text-fg">
                          {s.raw}
                        </code>
                      ))}
                    </div>
                  )}
                </div>
                {f.account_id && (
                  <button
                    onClick={() => navigate(`/cloud/resources/${f.id}`)}
                    className="shrink-0 inline-flex items-center gap-1 text-sm font-semibold text-accent-text hover:text-accent-hover"
                  >
                    View <ExternalLink size={12} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
