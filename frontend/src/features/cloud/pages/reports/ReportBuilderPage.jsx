import { useMemo, useState } from 'react';
import Button from '@/components/ui/Button';
import Notice from '@/components/ui/Notice';
import Stepper from '@/components/ui/Stepper';
import { useWizardDraft, useWizardStep } from '@/hooks/useWizard';
import ReportScopeSelector from '../../components/reports/ReportScopeSelector';
import ReportSectionSelector from '../../components/reports/ReportSectionSelector';
import ReportLayoutSettings from '../../components/reports/ReportLayoutSettings';
import ReportPreview from '../../components/reports/ReportPreview';
import { useReportPreview, useGenerateReport } from '../../hooks/useReports';

const STEPS = [
  { n: 1, label: 'Scope' },
  { n: 2, label: 'Sections & Layout' },
  { n: 3, label: 'Preview & Generate' },
];

const DEFAULT_DRAFT = {
  scope: { mode: 'account', resource_ids: [], filters: {} },
  sections: {
    executive_summary: true, inventory: true, security: true, utilization: false,
    performance: false, anomalies: false, recommendations: false, cost: false,
    data_quality: true,
  },
  date_range: { preset: '30d', start: null, end: null, timezone: 'UTC' },
  layout: {
    format: 'csv', detail_level: 'standard', group_by: null, sort_by: null,
    metadata: {
      title: '', subtitle: '', organization: '', prepared_by: '',
      confidentiality: '', reference: '',
    },
  },
};

/**
 * Scope -> Sections & Layout -> Preview -> Generate. One account-scoped tab,
 * same shape as every other tab in CloudDashboard.jsx, rather than a
 * standalone /reports/create route.
 *
 * `preSelectedResourceIds`: when the operator arrived here from the
 * Resources table's "Build Report..." action with rows already selected.
 * Without it, "Selected resources" is not offered as a scope — there would
 * be nothing to select from on this page.
 */
export default function ReportBuilderPage({ accountId, preSelectedResourceIds = [] }) {
  const [step, goToStep] = useWizardStep({ max: 2 });
  const [draft, setDraft, clearDraft] = useWizardDraft(`report-builder:${accountId}`, DEFAULT_DRAFT);
  const [generateError, setGenerateError] = useState(null);
  const [lastDownload, setLastDownload] = useState(null);

  const scope = useMemo(() => (
    draft.scope.mode === 'resources'
      ? { ...draft.scope, resource_ids: preSelectedResourceIds }
      : draft.scope
  ), [draft.scope, preSelectedResourceIds]);

  const request = useMemo(() => {
    if (!accountId) return null;
    if (scope.mode === 'resources' && scope.resource_ids.length === 0) return null;
    return {
      account_id: accountId,
      scope,
      sections: draft.sections,
      date_range: draft.date_range,
      layout: draft.layout,
    };
  }, [accountId, scope, draft.sections, draft.date_range, draft.layout]);

  const previewQuery = useReportPreview(request, { enabled: step === 2 });
  const generateMutation = useGenerateReport();

  const hasAnySection = Object.values(draft.sections).some(Boolean);
  const canAdvanceFromScope = scope.mode !== 'resources' || scope.resource_ids.length > 0;

  const handleGenerate = async () => {
    setGenerateError(null);
    try {
      const result = await generateMutation.mutateAsync(request);
      setLastDownload(result);
    } catch (err) {
      setGenerateError(err?.response?.data?.detail?.error?.message || err?.response?.data?.detail || err.message);
    }
  };

  const handleStartOver = () => {
    clearDraft();
    setLastDownload(null);
    setGenerateError(null);
    goToStep(0);
  };

  return (
    <div className="mx-auto max-w-4xl px-card py-6">
      <Stepper steps={STEPS} step={step + 1} />

      {step === 0 && (
        <ReportScopeSelector
          scope={draft.scope}
          onChange={(next) => setDraft((d) => ({ ...d, scope: next }))}
          preSelectedIds={preSelectedResourceIds}
        />
      )}

      {step === 1 && (
        <div className="space-y-6">
          <ReportSectionSelector
            sections={draft.sections}
            onChange={(next) => setDraft((d) => ({ ...d, sections: next }))}
          />
          <ReportLayoutSettings
            layout={draft.layout}
            dateRange={draft.date_range}
            onLayoutChange={(next) => setDraft((d) => ({ ...d, layout: next }))}
            onDateRangeChange={(next) => setDraft((d) => ({ ...d, date_range: next }))}
          />
        </div>
      )}

      {step === 2 && (
        <div className="space-y-5">
          <ReportPreview
            isLoading={previewQuery.isLoading}
            isError={previewQuery.isError}
            error={previewQuery.error}
            data={previewQuery.data}
          />

          {generateError && (
            <Notice tone="danger" title="Report generation failed">{String(generateError)}</Notice>
          )}
          {lastDownload && (
            <Notice tone="success">
              Downloaded {lastDownload.filename}
              {lastDownload.resourcesResolved != null && ` (${lastDownload.resourcesResolved} resource(s))`}.
            </Notice>
          )}
        </div>
      )}

      <div className="mt-6 flex items-center justify-between border-t border-border pt-4">
        <Button variant="ghost" onClick={handleStartOver}>Start over</Button>
        <div className="flex items-center gap-2">
          {step > 0 && (
            <Button variant="secondary" onClick={() => goToStep(step - 1)}>Back</Button>
          )}
          {step === 0 && (
            <Button variant="primary" disabled={!canAdvanceFromScope} onClick={() => goToStep(1)}>
              Next: Sections & Layout
            </Button>
          )}
          {step === 1 && (
            <Button variant="primary" disabled={!hasAnySection} onClick={() => goToStep(2)}>
              Next: Preview
            </Button>
          )}
          {step === 2 && (
            <Button
              variant="primary"
              icon="download"
              loading={generateMutation.isPending}
              disabled={!request || previewQuery.isError}
              onClick={handleGenerate}
            >
              Generate &amp; Download
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
