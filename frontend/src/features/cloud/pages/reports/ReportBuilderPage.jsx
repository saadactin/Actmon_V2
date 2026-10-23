import { useMemo, useState } from 'react';
import Button from '@/components/ui/Button';
import Dialog from '@/components/ui/Dialog';
import Input from '@/components/ui/Input';
import Notice from '@/components/ui/Notice';
import Stepper from '@/components/ui/Stepper';
import Switch from '@/components/ui/Switch';
import { Field, Segmented, Select } from '@/components/ui/Field';
import { useWizardDraft, useWizardStep } from '@/hooks/useWizard';
import ReportScopeSelector from '../../components/reports/ReportScopeSelector';
import ReportSectionSelector from '../../components/reports/ReportSectionSelector';
import ReportLayoutSettings from '../../components/reports/ReportLayoutSettings';
import ReportPreview from '../../components/reports/ReportPreview';
import ReportHistoryPanel from '../../components/reports/ReportHistoryPanel';
import ReportSchedulesPanel from '../../components/reports/ReportSchedulesPanel';
import {
  useGenerateReport, useReportPreview, useReportTemplates, useSaveReportTemplate,
} from '../../hooks/useReports';
import {
  browserTimeZone, configFromDraft, customPeriodProblem, draftFromConfig, errorMessage,
  normalizeDraft, saveProblem,
} from '../../utils/reportModel';

const STEPS = [
  { n: 1, label: 'Scope' },
  { n: 2, label: 'Sections & Layout' },
  { n: 3, label: 'Preview & Generate' },
];

const VIEWS = [
  { id: 'build', label: 'Build report' },
  { id: 'history', label: 'History' },
  { id: 'schedules', label: 'Schedules' },
];

const DEFAULT_DRAFT = {
  scope: { mode: 'account', resource_ids: [], filters: {} },
  sections: {
    executive_summary: true, inventory: true, security: true, utilization: false,
    performance: false, anomalies: false, recommendations: false, cost: false,
    posture: false, identity: false, certificates: false, changes: false, activity: false,
    data_quality: true,
  },
  date_range: { preset: '30d', start: null, end: null, timezone: browserTimeZone() },
  layout: {
    format: 'csv', detail_level: 'standard', group_by: null, sort_by: null,
    metadata: {
      title: '', subtitle: '', organization: '', prepared_by: '',
      confidentiality: '', reference: '',
    },
  },
  keep: true,
  template_name: null,
};

function SaveTemplateDialog({ open, onClose, draft }) {
  const [name, setName] = useState(draft.template_name || '');
  const [description, setDescription] = useState('');
  const [error, setError] = useState(null);
  const save = useSaveReportTemplate();
  const problem = saveProblem(draft);

  const submit = async () => {
    setError(null);
    try {
      await save.mutateAsync({ template: { name, description, config: configFromDraft(draft) } });
      onClose(name);
    } catch (err) {
      setError(await errorMessage(err));
    }
  };

  return (
    <Dialog
      open={open}
      onClose={save.isPending ? undefined : () => onClose(null)}
      title="Save as template"
      icon="save"
      width={460}
      footer={(
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" disabled={save.isPending} onClick={() => onClose(null)}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} disabled={!!problem || !name.trim()} onClick={submit}>Save template</Button>
        </div>
      )}
    >
      <div className="space-y-3">
        <p className="text-meta text-subtle">
          Saves the scope (filters, not hand-picked resources), sections, period and layout. Templates
          are shared across every account.
        </p>
        {problem && <Notice tone="warning">{problem}</Notice>}
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Description"><Input value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        {error && <Notice tone="danger" title="Could not save">{error}</Notice>}
      </div>
    </Dialog>
  );
}

/**
 * The account Reports tab: Build (Scope -> Sections & Layout -> Preview ->
 * Generate), History, and Schedules. One account-scoped tab, same shape as
 * every other tab in CloudDashboard.jsx, rather than a standalone route.
 *
 * `preSelectedResourceIds`: when the operator arrived here from the
 * Resources table's "Build Report..." action with rows already selected.
 * Without it, "Selected resources" is not offered as a scope — there would
 * be nothing to select from on this page.
 */
export default function ReportBuilderPage({ accountId, preSelectedResourceIds = [] }) {
  const [view, setView] = useState('build');
  const [step, goToStep] = useWizardStep({ max: 2 });
  const [savedDraft, setDraft, clearDraft] = useWizardDraft(`report-builder:${accountId}`, DEFAULT_DRAFT);
  // A draft saved by an older version of this form (an hourly preset, the
  // removed "technical" level) is mapped forward, not sent and refused.
  const draft = useMemo(() => normalizeDraft(savedDraft), [savedDraft]);
  const [generateError, setGenerateError] = useState(null);
  const [lastDownload, setLastDownload] = useState(null);
  const [saving, setSaving] = useState(false);
  const [templateNote, setTemplateNote] = useState(null);
  const templates = useReportTemplates();

  const scope = useMemo(() => (
    draft.scope.mode === 'resources'
      ? { ...draft.scope, resource_ids: preSelectedResourceIds }
      : draft.scope
  ), [draft.scope, preSelectedResourceIds]);

  const periodProblem = customPeriodProblem(draft.date_range);

  const request = useMemo(() => {
    if (!accountId) return null;
    if (scope.mode === 'resources' && scope.resource_ids.length === 0) return null;
    if (periodProblem) return null;
    return {
      account_id: accountId,
      scope,
      sections: draft.sections,
      date_range: draft.date_range,
      layout: draft.layout,
      keep: draft.keep !== false,
      template_name: draft.template_name || null,
    };
  }, [accountId, scope, draft, periodProblem]);

  // The preview does not depend on keep/template_name; leaving them out of
  // its key stops a checkbox from refetching a multi-second build.
  const previewRequest = useMemo(() => (request ? {
    account_id: request.account_id, scope: request.scope, sections: request.sections,
    date_range: request.date_range, layout: request.layout,
  } : null), [request]);
  const previewQuery = useReportPreview(previewRequest, { enabled: view === 'build' && step === 2 });
  const generateMutation = useGenerateReport();

  const hasAnySection = Object.values(draft.sections).some(Boolean);
  const canAdvanceFromScope = scope.mode !== 'resources' || scope.resource_ids.length > 0;

  const applyTemplate = (id) => {
    const t = (templates.data?.templates || []).find((x) => x.id === id);
    if (!t) return;
    setDraft({ ...draftFromConfig(t.config, DEFAULT_DRAFT), keep: true, template_name: t.name });
    setTemplateNote(`Applied "${t.name}". Adjust anything before generating.`);
    goToStep(0);
  };

  const handleGenerate = async () => {
    setGenerateError(null);
    try {
      const result = await generateMutation.mutateAsync(request);
      setLastDownload(result);
    } catch (err) {
      setGenerateError(await errorMessage(err));
    }
  };

  const handleStartOver = () => {
    clearDraft();
    setDraft(DEFAULT_DRAFT);
    setLastDownload(null);
    setGenerateError(null);
    setTemplateNote(null);
    goToStep(0);
  };

  const templateOptions = (templates.data?.templates || []).map((t) => ({
    id: t.id, label: t.name, group: t.builtin ? 'Built-in templates' : 'Saved templates',
  }));

  return (
    <div className="mx-auto max-w-4xl space-y-5 px-card py-6">
      <Segmented options={VIEWS} value={view} onChange={setView} />

      {view === 'history' && <ReportHistoryPanel accountId={accountId} />}
      {view === 'schedules' && <ReportSchedulesPanel accountId={accountId} draft={draft} />}

      {view === 'build' && (
        <>
          <div className="flex flex-wrap items-end gap-3 rounded-control border border-border px-3 py-2.5">
            <Field label="Start from a template" className="min-w-[240px] flex-1">
              <Select
                options={templateOptions}
                value=""
                placeholder={templates.isLoading ? 'Loading…' : 'Choose a template…'}
                onChange={applyTemplate}
              />
            </Field>
            <Button variant="secondary" icon="save" onClick={() => setSaving(true)}>Save as template</Button>
          </div>
          {draft.template_name && (
            <p className="text-meta text-subtle">Based on template: <span className="font-semibold text-fg">{draft.template_name}</span></p>
          )}
          {templateNote && <Notice tone="success">{templateNote}</Notice>}

          <Stepper steps={STEPS} step={step + 1} />

          {step === 0 && (
            <ReportScopeSelector
              accountId={accountId}
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
                periodProblem={periodProblem}
                onLayoutChange={(next) => setDraft((d) => ({ ...d, layout: next }))}
                onDateRangeChange={(next) => setDraft((d) => ({ ...d, date_range: next }))}
              />
            </div>
          )}

          {step === 2 && (
            <div className="space-y-5">
              <ReportPreview
                isLoading={previewQuery.isLoading}
                isFetching={previewQuery.isFetching}
                isError={previewQuery.isError}
                error={previewQuery.error}
                data={previewQuery.data}
              />
              <Field
                label="Keep a copy in report history"
                inline
                hint="Lets you download it again later, and is what the next report compares against."
              >
                <Switch
                  label="Keep a copy in report history"
                  checked={draft.keep !== false}
                  onChange={() => setDraft((d) => ({ ...d, keep: d.keep === false }))}
                />
              </Field>

              {generateError && (
                <Notice tone="danger" title="Report generation failed">{String(generateError)}</Notice>
              )}
              {lastDownload && (
                <Notice tone="success">
                  Downloaded {lastDownload.filename}
                  {lastDownload.resourcesResolved != null && ` (${lastDownload.resourcesResolved} resource(s))`}
                  {lastDownload.reportId ? ' and kept in history.' : '.'}
                </Notice>
              )}
            </div>
          )}

          <div className="flex items-center justify-between border-t border-border pt-4">
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
                <Button variant="primary" disabled={!hasAnySection || !!periodProblem} onClick={() => goToStep(2)}>
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

          {saving && (
            <SaveTemplateDialog
              open
              draft={draft}
              onClose={(name) => {
                setSaving(false);
                if (name) {
                  setDraft((d) => ({ ...d, template_name: name }));
                  setTemplateNote(`Saved as template "${name}".`);
                }
              }}
            />
          )}
        </>
      )}
    </div>
  );
}
