import Input from '@/components/ui/Input';
import { Field, Section, Segmented } from '@/components/ui/Field';

const FORMATS = [
  { id: 'csv', label: 'CSV' },
  { id: 'xlsx', label: 'Excel' },
  { id: 'pdf', label: 'PDF' },
  { id: 'json', label: 'JSON' },
];

const DETAIL_LEVELS = [
  { id: 'executive', label: 'Executive' },
  { id: 'standard', label: 'Standard' },
  { id: 'detailed', label: 'Detailed' },
  { id: 'technical', label: 'Technical' },
];

const DATE_PRESETS = [
  { id: '1h', label: 'Last hour' },
  { id: '6h', label: 'Last 6 hours' },
  { id: '24h', label: 'Last 24 hours' },
  { id: '7d', label: 'Last 7 days' },
  { id: '30d', label: 'Last 30 days' },
  { id: '90d', label: 'Last 90 days' },
];

const DETAIL_HINT = {
  executive: 'Summary and key metrics only — no per-resource row tables.',
  standard: 'Summary plus full section tables.',
  detailed: 'Same as Standard in this release — per-resource rows, findings and measurements.',
  technical: 'Same as Detailed in this release — raw fields are already present in JSON/CSV/Excel.',
};

export default function ReportLayoutSettings({ layout, dateRange, onLayoutChange, onDateRangeChange }) {
  const setMetadata = (key, value) => onLayoutChange({
    ...layout,
    metadata: { ...layout.metadata, [key]: value || undefined },
  });

  return (
    <div className="space-y-5">
      <Section title="Format">
        <Segmented options={FORMATS} value={layout.format} onChange={(format) => onLayoutChange({ ...layout, format })} />
      </Section>

      <Section title="Detail Level">
        <Segmented
          options={DETAIL_LEVELS}
          value={layout.detail_level}
          onChange={(detail_level) => onLayoutChange({ ...layout, detail_level })}
        />
        <p className="mt-2 text-meta text-subtle">{DETAIL_HINT[layout.detail_level]}</p>
      </Section>

      <Section title="Reporting Period">
        <p className="mb-2 text-meta text-subtle">
          Applies to cost and anomaly data. Inventory and security are always a
          snapshot as of generation time.
        </p>
        <Segmented
          options={[...DATE_PRESETS, { id: 'custom', label: 'Custom' }]}
          value={dateRange.preset}
          onChange={(preset) => onDateRangeChange({ ...dateRange, preset })}
        />
        {dateRange.preset === 'custom' && (
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Start">
              <Input
                type="datetime-local"
                value={dateRange.start || ''}
                onChange={(e) => onDateRangeChange({ ...dateRange, start: e.target.value })}
              />
            </Field>
            <Field label="End">
              <Input
                type="datetime-local"
                value={dateRange.end || ''}
                onChange={(e) => onDateRangeChange({ ...dateRange, end: e.target.value })}
              />
            </Field>
          </div>
        )}
      </Section>

      <Section title="Report Details">
        <p className="mb-2 text-meta text-subtle">All fields optional.</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Title">
            <Input value={layout.metadata.title || ''} onChange={(e) => setMetadata('title', e.target.value)} placeholder="Resource Assessment Report" />
          </Field>
          <Field label="Subtitle">
            <Input value={layout.metadata.subtitle || ''} onChange={(e) => setMetadata('subtitle', e.target.value)} />
          </Field>
          <Field label="Organization">
            <Input value={layout.metadata.organization || ''} onChange={(e) => setMetadata('organization', e.target.value)} />
          </Field>
          <Field label="Prepared by">
            <Input value={layout.metadata.prepared_by || ''} onChange={(e) => setMetadata('prepared_by', e.target.value)} />
          </Field>
          <Field label="Confidentiality">
            <Input value={layout.metadata.confidentiality || ''} onChange={(e) => setMetadata('confidentiality', e.target.value)} placeholder="e.g. Internal, Confidential" />
          </Field>
          <Field label="Reference">
            <Input value={layout.metadata.reference || ''} onChange={(e) => setMetadata('reference', e.target.value)} placeholder="Ticket / request number" />
          </Field>
        </div>
      </Section>
    </div>
  );
}
