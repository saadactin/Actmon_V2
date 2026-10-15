import Badge from '@/components/ui/Badge';
import Icon from '@/components/ui/Icon';
import Notice from '@/components/ui/Notice';
import { Section } from '@/components/ui/Field';

const SECTION_LABELS = {
  executive_summary: 'Executive Summary', inventory: 'Resource Inventory',
  security: 'Security Assessment', utilization: 'Resource Utilization',
  performance: 'Performance Analysis', recommendations: 'Recommendations',
  anomalies: 'Detected Anomalies (Account-Wide)', cost: 'Cost', data_quality: 'Data Quality',
};

export default function ReportPreview({ isLoading, isError, error, data }) {
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-8 text-[13px] text-muted">
        <Icon name="spinner" size={16} className="animate-spin" />
        Building preview...
      </div>
    );
  }

  if (isError) {
    return (
      <Notice tone="danger" title="Could not build a preview">
        {error?.response?.data?.detail?.error?.message || error?.message || 'Unknown error.'}
      </Notice>
    );
  }

  if (!data) return null;

  const { resolved_scope: resolvedScope, preview } = data;
  const sectionEntries = Object.entries(preview.sections || {});

  return (
    <div className="space-y-5">
      <Notice tone="info">
        {resolvedScope.resource_count} resource(s) resolved for this scope.
        This preview samples up to 50 rows per section — the generated file
        will contain every matching row.
      </Notice>

      {preview.resources_missing?.length > 0 && (
        <Notice tone="warning">
          {preview.resources_missing.length} selected resource(s) no longer exist or
          belong to a different account and will be excluded.
        </Notice>
      )}

      <Section title="Sections">
        <div className="space-y-2">
          {sectionEntries.map(([key, value]) => {
            const isList = value && typeof value === 'object' && 'rows' in value;
            const count = isList ? value.total : null;
            return (
              <div key={key} className="flex items-center justify-between rounded-control border border-border px-3 py-2">
                <span className="text-[13px] font-semibold text-fg">{SECTION_LABELS[key] || key}</span>
                {isList ? (
                  <Badge tone={count > 0 ? 'accent' : 'neutral'}>
                    {count} row{count === 1 ? '' : 's'}{value.truncated ? ' (sampled)' : ''}
                  </Badge>
                ) : (
                  <Badge tone="outline">summary</Badge>
                )}
              </div>
            );
          })}
        </div>
      </Section>

      {preview.notes?.length > 0 && (
        <Section title="Notes">
          <ul className="list-inside list-disc space-y-1 text-meta text-subtle">
            {preview.notes.map((note) => <li key={note}>{note}</li>)}
          </ul>
        </Section>
      )}
    </div>
  );
}
