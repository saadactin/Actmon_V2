import Input from '@/components/ui/Input';
import Notice from '@/components/ui/Notice';
import { Field, Section, Segmented, Select } from '@/components/ui/Field';
import {
  DETAIL_LEVELS, GROUP_BY_OPTIONS, PERIOD_PRESETS, SORT_BY_OPTIONS,
} from '../../utils/reportModel';

const FORMATS = [
  { id: 'csv', label: 'CSV' },
  { id: 'xlsx', label: 'Excel' },
  { id: 'pdf', label: 'PDF' },
  { id: 'json', label: 'JSON' },
];

export default function ReportLayoutSettings({
  layout, dateRange, periodProblem, onLayoutChange, onDateRangeChange,
}) {
  const setMetadata = (key, value) => onLayoutChange({
    ...layout,
    metadata: { ...layout.metadata, [key]: value || undefined },
  });
  const detail = DETAIL_LEVELS.find((d) => d.id === layout.detail_level) || DETAIL_LEVELS[1];

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
        <p className="mt-2 text-meta text-subtle">{detail.hint} Applies to every format.</p>
      </Section>

      <Section title="Order">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Group rows by" hint="PDF sections get a sub-heading per group; files are ordered by it.">
            <Select
              options={GROUP_BY_OPTIONS}
              value={layout.group_by || ''}
              onChange={(group_by) => onLayoutChange({ ...layout, group_by: group_by || null })}
            />
          </Field>
          <Field label="Sort rows by" hint="Sections without that field keep their own order.">
            <Select
              options={SORT_BY_OPTIONS}
              value={layout.sort_by || ''}
              onChange={(sort_by) => onLayoutChange({ ...layout, sort_by: sort_by || null })}
            />
          </Field>
        </div>
      </Section>

      <Section title="Reporting Period">
        <p className="mb-2 text-meta text-subtle">
          Applies to account spend and spend anomalies. Inventory, findings and
          per-resource billed cost are the current state as of the last refresh.
          Days end at midnight in {dateRange.timezone}.
        </p>
        <Segmented
          options={PERIOD_PRESETS}
          value={dateRange.preset}
          onChange={(preset) => onDateRangeChange({ ...dateRange, preset })}
        />
        {dateRange.preset === 'custom' && (
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="First day">
              <Input
                type="date"
                value={dateRange.start || ''}
                onChange={(e) => onDateRangeChange({ ...dateRange, start: e.target.value || null })}
              />
            </Field>
            <Field label="Last day">
              <Input
                type="date"
                value={dateRange.end || ''}
                onChange={(e) => onDateRangeChange({ ...dateRange, end: e.target.value || null })}
              />
            </Field>
          </div>
        )}
        {periodProblem && (
          <Notice tone="warning" className="mt-3">{periodProblem}</Notice>
        )}
      </Section>

      <Section title="Report Details">
        <p className="mb-2 text-meta text-subtle">All fields optional. Shown on the PDF cover and in every file's metadata.</p>
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
