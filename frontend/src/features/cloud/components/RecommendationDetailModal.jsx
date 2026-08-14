import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  X, Sparkles, HelpCircle, Wrench, Calculator, ExternalLink,
  Terminal, MousePointerClick, AlertTriangle, Info,
} from 'lucide-react';

// ── Static "why / how" guidance, keyed by the backend rule name ───────────────
// The savings numbers come from the API (real OCI list prices); this file holds
// only the educational why/how content, which is stable per rule.
const RULE_GUIDES = {
  'Stopped OCI Compute Instance': {
    why: [
      'A STOPPED instance no longer bills for OCPUs or memory, so teams assume it is “free” — but its boot volume and every attached block volume keep billing at the full per-GB rate, indefinitely.',
      'Instances left stopped “just in case” are the single most common source of silent OCI storage spend: the compute line on the invoice drops to zero, which hides the storage that never does.',
      'If the workload is genuinely finished, the storage is pure waste. If it may be needed again, a boot-volume backup costs a fraction of keeping the live volume provisioned.',
    ],
    consoleSteps: [
      'Confirm the instance is truly idle: OCI Console → Compute → Instances → open the instance → Metrics, and check there has been no CPU/network activity while stopped.',
      'Back up first (safety): open the instance → Boot volume → Create Manual Backup. For attached block volumes, do the same under Storage → Block Volumes.',
      'Note any attached block volumes (instance → Attached block volumes) so you delete or reassign them deliberately — terminating the instance only deletes the boot volume.',
      'Terminate: instance → More actions → Terminate, and tick “Permanently delete the attached boot volume”.',
      'Delete any now-orphaned block volumes under Storage → Block Volumes to actually stop their charge.',
    ],
    cli: [
      { label: 'List the instance’s attached block volumes', cmd: 'oci compute volume-attachment list --compartment-id <compartment-ocid> --instance-id <instance-ocid>' },
      { label: 'Back up the boot volume before deleting', cmd: 'oci bv boot-volume-backup create --boot-volume-id <boot-volume-ocid> --type FULL' },
      { label: 'Terminate the instance and its boot volume', cmd: 'oci compute instance terminate --instance-id <instance-ocid> --preserve-boot-volume false' },
    ],
    docs: [
      { label: 'OCI: Terminating an Instance', url: 'https://docs.oracle.com/en-us/iaas/Content/Compute/Tasks/terminatinginstance.htm' },
      { label: 'OCI: Block Volume backups', url: 'https://docs.oracle.com/en-us/iaas/Content/Block/Concepts/blockvolumebackups.htm' },
    ],
  },
  'Stopped Autonomous Database': {
    why: [
      'A STOPPED Autonomous Database stops all ECPU/OCPU compute billing, but the provisioned storage keeps billing per GB every month until the database is terminated.',
      'Autonomous DBs provisioned for a project or POC and then stopped are a classic “forgotten storage” cost — the compute charge disappears, so nobody notices the storage that remains.',
      'If the data is still needed, a manual backup (or export to Object Storage, which is far cheaper per GB) preserves it at a fraction of the live-storage cost.',
    ],
    consoleSteps: [
      'Verify the database is no longer needed: OCI Console → Oracle Database → Autonomous Database → open it → check last-used / connections.',
      'Preserve the data: open the database → Backups → Create Manual Backup (or use Data Pump export to Object Storage for long-term, cheaper retention).',
      'Terminate: database → More actions → Terminate, then type the database name to confirm.',
      'If you only need it occasionally, consider that a stopped ADB still bills storage — terminating + restoring from backup on demand is usually cheaper than keeping it provisioned.',
    ],
    cli: [
      { label: 'Create a manual backup first', cmd: 'oci db autonomous-database-backup create --autonomous-database-id <adb-ocid> --display-name pre-terminate-backup' },
      { label: 'Terminate the Autonomous Database', cmd: 'oci db autonomous-database delete --autonomous-database-id <adb-ocid>' },
    ],
    docs: [
      { label: 'OCI: Terminate an Autonomous Database', url: 'https://docs.oracle.com/en-us/iaas/autonomous-database-serverless/doc/terminate-autonomous-database.html' },
      { label: 'OCI: Autonomous Database backups', url: 'https://docs.oracle.com/en-us/iaas/autonomous-database-serverless/doc/backup-restore.html' },
    ],
  },
  'Enable Autonomous Database Auto-Scaling': {
    why: [
      'With auto-scaling OFF, the database always bills for its full base ECPU/OCPU count, 24×7, even when it is idle overnight or on weekends.',
      'This is a right-sizing signal, not a guaranteed saving: turning auto-scaling ON lets OCI burst up to 3× base for peaks (billed per second only when used) — it does not lower the base charge.',
      'The real money is saved by matching the BASE capacity to actual demand: if the database is over-provisioned, lower the base ECPU count and let auto-scaling absorb the occasional spike, instead of paying peak capacity all month.',
    ],
    consoleSteps: [
      'Review utilization: OCI Console → Autonomous Database → open it → Performance Hub / Metrics, and look at CPU utilization over the last 2–4 weeks.',
      'If the base is rarely fully used, click “Manage resource allocation / Scale” and reduce the base ECPU count to match the typical (not peak) load.',
      'Enable auto-scaling in the same dialog so peaks up to 3× base are still handled automatically.',
      'Re-check the metrics after a week and adjust the base again if needed.',
    ],
    cli: [
      { label: 'Enable auto-scaling and set a right-sized base', cmd: 'oci db autonomous-database update --autonomous-database-id <adb-ocid> --is-auto-scaling-enabled true --compute-count <base-ecpus>' },
    ],
    docs: [
      { label: 'OCI: Auto-scaling for Autonomous Database', url: 'https://docs.oracle.com/en-us/iaas/autonomous-database-serverless/doc/autonomous-auto-scale.html' },
    ],
  },
  'Idle OKE Cluster (No Node Pools)': {
    why: [
      'An OKE cluster with zero node pools runs no workloads, yet an enhanced-tier cluster still bills a per-hour cluster-management fee for simply existing.',
      'These are usually left over from testing or a torn-down environment where the node pools were deleted but the cluster was not.',
    ],
    consoleSteps: [
      'OCI Console → Developer Services → Kubernetes Clusters (OKE) → open the cluster → confirm Node Pools is empty and nothing depends on the control plane.',
      'If unused, click Delete and confirm.',
      'If you need it only occasionally, recreating an OKE cluster is quick — deleting when idle avoids the standing management fee.',
    ],
    cli: [{ label: 'Delete the cluster', cmd: 'oci ce cluster delete --cluster-id <cluster-ocid>' }],
    docs: [{ label: 'OCI: Deleting a Cluster', url: 'https://docs.oracle.com/en-us/iaas/Content/ContEng/Tasks/contengdeletingcluster.htm' }],
  },
  'Idle OCI Load Balancer (No Backend Sets)': {
    why: [
      'A load balancer with no backend sets routes no traffic, but it still bills per hour for its provisioned shape/bandwidth as long as it exists.',
      'Orphaned LBs are common after backends are decommissioned but the LB in front of them is forgotten.',
    ],
    consoleSteps: [
      'OCI Console → Networking → Load Balancers → open it → confirm Backend Sets is empty and no DNS/clients still point at its IP.',
      'If unused, click Delete.',
    ],
    cli: [{ label: 'Delete the load balancer', cmd: 'oci lb load-balancer delete --load-balancer-id <lb-ocid>' }],
    docs: [{ label: 'OCI: Managing a Load Balancer', url: 'https://docs.oracle.com/en-us/iaas/Content/Balance/Tasks/managingloadbalancer.htm' }],
  },
  'Idle OCI API Gateway (No Deployments)': {
    why: [
      'An API Gateway with no deployments serves no APIs, but is still billed while it exists.',
      'Typically left over after the APIs it fronted were removed.',
    ],
    consoleSteps: [
      'OCI Console → Developer Services → API Management → Gateways → open it → confirm there are no active Deployments.',
      'If unused, click Delete.',
    ],
    cli: [{ label: 'Delete the gateway', cmd: 'oci api-gateway gateway delete --gateway-id <gateway-ocid>' }],
    docs: [{ label: 'OCI: Deleting an API Gateway', url: 'https://docs.oracle.com/en-us/iaas/Content/APIGateway/Tasks/apigatewaydeletinggateway.htm' }],
  },
};

const FALLBACK_GUIDE = {
  why: ['This recommendation flags a configuration that commonly leads to avoidable spend. Review the affected resource and confirm whether it is still required.'],
  consoleSteps: ['Open the affected resource in the provider console and verify it is still needed.', 'Apply the change described in the recommendation, backing up first where relevant.'],
};

const symbolFor = (code) => (code ? ({ USD: '$', INR: '₹', EUR: '€', GBP: '£' }[code] ?? `${code} `) : '');

const fmt = (n) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const RecommendationDetailModal = ({ opt, onClose }) => {
  const navigate = useNavigate();

  // Close on Escape
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const guide = RULE_GUIDES[opt.rule] ?? FALLBACK_GUIDE;
  const sym = symbolFor(opt.savings_currency);
  const hasSavings = typeof opt.potential_savings === 'number';
  const breakdown = opt.savings_breakdown || [];
  const assumptions = opt.savings_assumptions || [];

  const sevStyle = (() => {
    switch ((opt.severity || '').toUpperCase()) {
      case 'CRITICAL':
      case 'HIGH': return 'bg-danger-soft text-danger-fg';
      case 'MEDIUM': return 'bg-warning-soft text-warning-fg';
      default: return 'bg-info-soft text-info-fg';
    }
  })();

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/45 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-surface w-full max-w-2xl max-h-[88vh] rounded-card shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4 px-6 py-5 border-b border-border shrink-0">
          <div className="min-w-0">
            <div className="flex items-center gap-2.5 flex-wrap">
              <h2 className="text-lg font-bold text-fg">{opt.rule}</h2>
              <span className={`rounded-full text-[11px] font-bold uppercase tracking-wide px-2.5 py-0.5 ${sevStyle}`}>
                {opt.severity} Severity
              </span>
            </div>
            <p className="text-sm text-muted mt-1">
              Target resource:{' '}
              <button
                onClick={() => navigate(`/cloud/resources/${opt.resource_id}`)}
                className="font-semibold text-accent-text hover:text-accent-hover inline-flex items-center gap-1"
              >
                {opt.affected_resource} <ExternalLink size={12} />
              </button>
            </p>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-control border border-border bg-surface text-muted hover:bg-sunken hover:text-fg flex items-center justify-center shrink-0"
            title="Close"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body (scrollable) */}
        <div className="overflow-y-auto px-6 py-5 space-y-6">

          {/* Savings headline */}
          <div className={`rounded-card border border-border p-5 ${hasSavings ? 'bg-success-soft' : 'bg-sunken'}`}>
            <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-subtle mb-1">
              <Sparkles size={14} className={hasSavings ? 'text-success-fg' : 'text-subtle'} />
              Estimated Monthly Saving
            </div>
            {hasSavings ? (
              <>
                <div className="text-3xl font-bold text-success-fg">{sym}{fmt(opt.potential_savings)}<span className="text-base font-semibold text-subtle">/mo</span></div>
                <div className="text-xs text-muted mt-0.5">≈ {sym}{fmt(opt.potential_savings * 12)}/year</div>
              </>
            ) : (
              <>
                <div className="text-2xl font-bold text-fg">Not quantified (NA)</div>
                <div className="text-xs text-muted mt-0.5">See the note below for why a rupee figure isn’t shown for this one.</div>
              </>
            )}
          </div>

          {/* Savings math */}
          {(breakdown.length > 0 || assumptions.length > 0) && (
            <section>
              <h3 className="flex items-center gap-2 text-sm font-bold text-fg uppercase tracking-wider mb-3">
                <Calculator size={16} className="text-accent" /> How the number is calculated
              </h3>
              {breakdown.length > 0 && (
                <div className="overflow-x-auto rounded-card border border-border mb-3">
                  <table className="w-full text-sm">
                    <thead className="bg-sunken text-[11px] uppercase tracking-wider text-subtle">
                      <tr>
                        <th className="text-left font-semibold px-3 py-2">Component</th>
                        <th className="text-right font-semibold px-3 py-2">Quantity</th>
                        <th className="text-right font-semibold px-3 py-2">Unit price</th>
                        <th className="text-right font-semibold px-3 py-2">Monthly</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {breakdown.map((b, i) => (
                        <tr key={i}>
                          <td className="px-3 py-2 text-fg">
                            {b.component}
                            {b.note && <div className="text-[11px] text-subtle">{b.note}</div>}
                          </td>
                          <td className="px-3 py-2 text-right text-muted whitespace-nowrap">{fmt(b.quantity)} <span className="text-subtle">{b.unit}</span></td>
                          <td className="px-3 py-2 text-right text-muted whitespace-nowrap">{sym}{b.unit_price}</td>
                          <td className="px-3 py-2 text-right font-semibold text-fg whitespace-nowrap">{sym}{fmt(b.monthly_cost)}</td>
                        </tr>
                      ))}
                    </tbody>
                    {hasSavings && (
                      <tfoot className="bg-success-soft border-t border-border">
                        <tr>
                          <td className="px-3 py-2 font-bold text-fg" colSpan={3}>Total saving</td>
                          <td className="px-3 py-2 text-right font-bold text-success-fg whitespace-nowrap">{sym}{fmt(opt.potential_savings)}/mo</td>
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>
              )}
              {assumptions.length > 0 && (
                <ul className="space-y-1.5">
                  {assumptions.map((a, i) => (
                    <li key={i} className="flex gap-2 text-xs text-muted">
                      <Info size={13} className="text-subtle shrink-0 mt-0.5" />
                      <span>{a}</span>
                    </li>
                  ))}
                </ul>
              )}
              {opt.savings_basis && (
                <p className="flex gap-2 text-[11px] text-muted mt-2 pt-2 border-t border-border">
                  <AlertTriangle size={13} className="text-warning shrink-0 mt-0.5" />
                  <span>{opt.savings_basis}</span>
                </p>
              )}
            </section>
          )}

          {/* Why */}
          <section>
            <h3 className="flex items-center gap-2 text-sm font-bold text-fg uppercase tracking-wider mb-3">
              <HelpCircle size={16} className="text-accent" /> Why do this
            </h3>
            <ul className="space-y-2">
              {guide.why.map((w, i) => (
                <li key={i} className="flex gap-2.5 text-sm text-muted leading-relaxed">
                  <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-accent shrink-0" />
                  <span>{w}</span>
                </li>
              ))}
            </ul>
          </section>

          {/* How */}
          <section>
            <h3 className="flex items-center gap-2 text-sm font-bold text-fg uppercase tracking-wider mb-3">
              <Wrench size={16} className="text-accent" /> How to do it
            </h3>

            <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-subtle mb-2">
              <MousePointerClick size={13} /> In the OCI Console
            </div>
            <ol className="space-y-2 mb-4">
              {guide.consoleSteps.map((s, i) => (
                <li key={i} className="flex gap-3 text-sm text-muted leading-relaxed">
                  <span className="shrink-0 w-5 h-5 rounded-full bg-accent-soft text-accent-text text-[11px] font-bold flex items-center justify-center mt-0.5">{i + 1}</span>
                  <span>{s}</span>
                </li>
              ))}
            </ol>

            {guide.cli && guide.cli.length > 0 && (
              <>
                <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-subtle mb-2">
                  <Terminal size={13} /> Or with the OCI CLI
                </div>
                <div className="space-y-2">
                  {guide.cli.map((c, i) => (
                    <div key={i}>
                      <div className="text-[11px] text-subtle mb-1">{c.label}</div>
                      <pre className="bg-inverse text-on-inverse text-xs rounded-control px-3 py-2 overflow-x-auto"><code>{c.cmd}</code></pre>
                    </div>
                  ))}
                  <p className="text-[11px] text-subtle">Replace <code className="font-mono">&lt;…-ocid&gt;</code> placeholders with the real OCIDs (Console → resource → OCID, or the Resource Details page).</p>
                </div>
              </>
            )}
          </section>

          {/* Docs */}
          {guide.docs && guide.docs.length > 0 && (
            <section className="pt-1">
              <div className="flex flex-wrap gap-2">
                {guide.docs.map((d, i) => (
                  <a
                    key={i}
                    href={d.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 text-xs font-semibold text-accent-text hover:text-accent-hover bg-accent-soft rounded-control px-3 py-1.5"
                  >
                    {d.label} <ExternalLink size={12} />
                  </a>
                ))}
              </div>
            </section>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 px-6 py-4 border-t border-border shrink-0 bg-raised">
          <p className="text-[11px] text-subtle">Savings are list-price estimates — verify against your OCI invoice before acting.</p>
          <button onClick={onClose} className="bg-inverse hover:opacity-90 text-on-inverse rounded-control px-4 py-2 text-sm font-semibold">
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
