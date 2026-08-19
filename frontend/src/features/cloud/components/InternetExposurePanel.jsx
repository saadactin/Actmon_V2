import { Globe, ShieldAlert, HelpCircle, ExternalLink } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useInternetExposure } from '../hooks/useSecurity';
import CloudSection from './CloudSection';
import Badge from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/Table';
import { PageLoading } from '@/components/ui/Loading';

const SEVERITY_TONE = { CRITICAL: 'danger', HIGH: 'danger', MEDIUM: 'warning', INFO: 'neutral' };
const SEVERITY_ACCENT = { CRITICAL: 'border-l-danger', HIGH: 'border-l-danger', MEDIUM: 'border-l-warning', INFO: 'border-l-border' };

function portLabel(hit) {
  if (hit.port_range) return `${hit.port_range[0]}-${hit.port_range[1]} (${hit.service})`;
  if (hit.port == null) return hit.service || 'all ports';
  return hit.service ? `${hit.port} (${hit.service})` : `port ${hit.port}`;
}

/**
 * "Has a public IP" and "has a permissive rule" are both nearly meaningless on
 * their own — this shows only the AND of the two: a resource that is actually
 * reachable from the internet, on which ports, through which named rule. See
 * Backend/cloud/app/services/exposure_service.py for exactly how each
 * provider's rule format is evaluated and this panel's stated limitations
 * (Azure partial-range deny overlap, OCI Security Lists not scanned).
 */
export default function InternetExposurePanel({ accountId }) {
  const navigate = useNavigate();
  const { data, isLoading, isError } = useInternetExposure(accountId);

  if (isLoading) return <PageLoading title="Tracing internet-reachable paths…" minHeight={200} />;
  if (isError || !data) {
    return (
      <CloudSection>
        <EmptyState icon="alert-triangle" title="Exposure analysis unavailable"
          body="Could not compute internet exposure for this account." />
      </CloudSection>
    );
  }

  const { exposed_resources: exposed, total_checked, unknown_coverage, by_severity } = data;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3.5 sm:grid-cols-4">
        {[
          { label: 'Internet-Exposed', count: exposed.length, tone: 'bg-danger-soft text-danger-fg', icon: <ShieldAlert size={18} /> },
          { label: 'Critical', count: by_severity.CRITICAL || 0, tone: 'bg-danger-soft text-danger-fg', icon: <ShieldAlert size={18} /> },
          { label: 'Public IPs Checked', count: total_checked, tone: 'bg-info-soft text-info-fg', icon: <Globe size={18} /> },
          { label: 'Unknown Coverage', count: unknown_coverage, tone: 'bg-warning-soft text-warning-fg', icon: <HelpCircle size={18} /> },
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

      {unknown_coverage > 0 && (
        <div className="flex items-start gap-2 rounded-control border border-warning-soft bg-warning-soft p-3 text-xs text-warning-fg">
          <HelpCircle size={14} className="mt-0.5 shrink-0" />
          <span>
            {unknown_coverage} public resource{unknown_coverage !== 1 ? 's' : ''} could not be evaluated — no
            security group/NSG is attached, so the true exposure is unknown rather than assumed safe. For OCI, this
            usually means the subnet relies on a Security List, which is not yet scanned.
          </span>
        </div>
      )}

      {exposed.length === 0 ? (
        <CloudSection>
          <EmptyState icon="shield-check" title="No internet exposure found"
            body="No public-IP resource with a world-open rule was found." />
        </CloudSection>
      ) : (
        <div className="flex flex-col gap-3">
          {exposed.map((e) => (
            <div key={e.resource_id} className={`card border-l-4 px-card py-4 ${SEVERITY_ACCENT[e.severity] || 'border-l-border'}`}>
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <h4 className="text-[15px] font-semibold text-fg">{e.resource_name}</h4>
                    <Badge tone={SEVERITY_TONE[e.severity] || 'neutral'}>{e.severity}</Badge>
                    <Badge tone="neutral">{e.resource_type}</Badge>
                  </div>
                  <p className="mt-1.5 text-xs text-subtle">
                    Public IP <span className="font-mono">{e.public_ip}</span>
                    {e.via.length > 0 && <> · via {e.via.join(', ')}</>}
                  </p>
                  <div className="mt-2.5 flex flex-wrap gap-1.5">
                    {e.open_ports.map((hit, i) => (
                      <span
                        key={i}
                        className="rounded-md px-2 py-0.5 text-[11px] font-semibold"
                        style={{
                          color: hit.severity === 'CRITICAL' ? 'var(--danger-fg)' : hit.severity === 'INFO' ? 'var(--muted)' : 'var(--warning-fg)',
                          background: hit.severity === 'CRITICAL' ? 'var(--danger-soft)' : hit.severity === 'INFO' ? 'var(--neutral-soft)' : 'var(--warning-soft)',
                        }}
                      >
                        {portLabel(hit)}
                      </span>
                    ))}
                  </div>
                  {e.confidence !== 'high' && (
                    <p className="mt-2 text-[11px] italic text-subtle">Confidence: {e.confidence}</p>
                  )}
                </div>
                <button
                  onClick={() => navigate(`/cloud/resources/${e.resource_id}`)}
                  className="shrink-0 inline-flex items-center gap-1 text-sm font-semibold text-accent-text hover:text-accent-hover"
                >
                  View <ExternalLink size={12} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
