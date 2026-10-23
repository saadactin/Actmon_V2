import Switch from '@/components/ui/Switch';
import Notice from '@/components/ui/Notice';
import { Section } from '@/components/ui/Field';

const SECTIONS = [
  {
    key: 'executive_summary',
    label: 'Executive Summary',
    hint: 'Posture score, findings by severity, top risks with their fix, potential monthly savings, most expensive resources, and spend against the previous equal period — always worth including.',
  },
  { key: 'inventory', label: 'Resource Inventory', hint: 'Name, type, region, status, tags, environment, discovery timestamps.' },
  {
    key: 'security',
    label: 'Security Assessment',
    hint: 'Open findings from the Security Center. A whole-account report also includes account-level findings (e.g. subscription-wide access grants) that belong to no single resource.',
  },
  { key: 'utilization', label: 'Resource Utilization', hint: 'CPU/memory/disk/network telemetry over each metric\'s own collection window, where collected.' },
  { key: 'performance', label: 'Performance Analysis', hint: 'Constrained/bottlenecked resources from the Resource Intelligence engine.' },
  { key: 'recommendations', label: 'Recommendations', hint: 'Cost, storage, network and reliability advisories — kept separate from observed defects.' },
  {
    key: 'anomalies',
    label: 'Spend Anomalies',
    hint: 'Days in the reporting period when account-wide spend jumped above its trailing baseline. There is no per-resource anomaly engine — these are never attributed to one resource.',
  },
  {
    key: 'cost',
    label: 'Cost',
    hint: 'Each resource\'s latest billed cost (with currency and billing window), plus account spend and top services within the reporting period. No billed cost shows "Not available", never 0.',
  },
  {
    key: 'posture',
    label: 'Security Posture & Compliance',
    hint: 'The Security Center score (or why it is withheld) and per-framework control results — CIS, ISO 27001, RBI, SEBI and more. Unevaluated controls count as unknown, never passed.',
  },
  {
    key: 'identity',
    label: 'Identity & Access',
    hint: 'Administrators, standing admin, MFA gaps, dormant identities and the widest blast radius, from the last identity analysis. Account-wide.',
  },
  {
    key: 'certificates',
    label: 'Expiring Certificates & Secrets',
    hint: 'Everything expired or expiring within 30 days. Stores that could not be read are named — an empty list is only an all-clear when every store was read.',
  },
  {
    key: 'changes',
    label: 'Configuration Changes',
    hint: 'Every configuration change Config Drift detected during the reporting period, most recent first.',
  },
  {
    key: 'activity',
    label: 'Account Activity',
    hint: 'Event Log activity in the reporting period: failures, denials, deletions, high-risk events and the most active actors. Account-wide.',
  },
  { key: 'data_quality', label: 'Data Quality & Coverage', hint: 'When each source last refreshed, whether that refresh was partial, and how many resources each section had something to report on.' },
];

export default function ReportSectionSelector({ sections, onChange }) {
  const toggle = (key) => onChange({ ...sections, [key]: !sections[key] });

  return (
    <Section title="Report Sections">
      <div className="divide-y divide-border rounded-card border border-border">
        {SECTIONS.map((s) => (
          <div
            key={s.key}
            className="flex items-start justify-between gap-4 px-3.5 py-3"
          >
            <div className="min-w-0">
              <div className="text-[13px] font-semibold text-fg">{s.label}</div>
              <div className="mt-0.5 text-meta leading-snug text-subtle">{s.hint}</div>
            </div>
            <Switch
              label={s.label}
              checked={!!sections[s.key]}
              onChange={() => toggle(s.key)}
            />
          </div>
        ))}
      </div>
      {!Object.values(sections).some(Boolean) && (
        <Notice tone="warning" className="mt-3">
          Select at least one section — an empty report has nothing to generate.
        </Notice>
      )}
    </Section>
  );
}
