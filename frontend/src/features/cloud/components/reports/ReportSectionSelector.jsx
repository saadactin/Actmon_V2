import Switch from '@/components/ui/Switch';
import Notice from '@/components/ui/Notice';
import { Section } from '@/components/ui/Field';

const SECTIONS = [
  { key: 'executive_summary', label: 'Executive Summary', hint: 'Resource count, severity breakdown, key findings — always worth including.' },
  { key: 'inventory', label: 'Resource Inventory', hint: 'Name, type, region, status, tags, environment, discovery timestamps.' },
  { key: 'security', label: 'Security Assessment', hint: 'Open findings from the Security Center — the canonical finding source.' },
  { key: 'utilization', label: 'Resource Utilization', hint: 'CPU/memory/disk/network telemetry, where collected. Shows "not collected" rather than a guess.' },
  { key: 'performance', label: 'Performance Analysis', hint: 'Constrained/bottlenecked resources from the Resource Intelligence engine.' },
  { key: 'recommendations', label: 'Recommendations', hint: 'Cost, storage, network and reliability advisories — kept separate from observed defects.' },
  {
    key: 'anomalies',
    label: 'Detected Anomalies',
    hint: 'Account-wide cost-spend anomaly detection. There is no per-resource anomaly engine in this product — every row here is labelled account-wide, not attributed to one resource.',
  },
  { key: 'cost', label: 'Cost', hint: 'Stored actual billing data only. A resource with no recorded cost shows "Not available", never 0.' },
  { key: 'data_quality', label: 'Data Quality & Coverage', hint: 'What was available, unavailable, or never checked — so missing data is visible, not silent.' },
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
