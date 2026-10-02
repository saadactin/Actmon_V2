import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import Button from '@/components/ui/Button';
import Select from '@/components/ui/Select';
import Tabs from '@/components/ui/Tabs';
import CloudPageHeader from '../components/CloudPageHeader';
import AlertActivityFeed from '../components/alerts/AlertActivityFeed';
import {
  AlertsByCategory, AlertsByProvider, AlertsOverTime, NotificationOutcomes,
  TopRules,
} from '../components/alerts/AlertCharts';
import AlertDetailDrawer from '../components/alerts/AlertDetailDrawer';
import AlertHistory from '../components/alerts/AlertHistory';
import { DeliveryBanner } from '../components/alerts/AlertPrimitives';
import AlertRuleBuilder from '../components/alerts/AlertRuleBuilder';
import AlertRulesTable from '../components/alerts/AlertRulesTable';
import AlertSettingsPanel from '../components/alerts/AlertSettingsPanel';
import AlertSummaryStrip from '../components/alerts/AlertSummaryStrip';
import EmailSettingsPanel from '../components/alerts/EmailSettingsPanel';
import NoisyRulesPanel from '../components/alerts/NoisyRulesPanel';
import TemplatePicker from '../components/alerts/TemplatePicker';
import {
  useAddRecipient, useAlertAction, useAlertActivity, useAlertAnalytics,
  useAlertCapabilities, useAlertInstance, useAlertInstances, useAlertRules,
  useAlertSettings, useAlertSummary, useAlertTemplates, useApplyTemplates,
  useCreateRule, useDeleteRecipient, useDeleteRule, useDuplicateRule,
  useEmailSettings, useEnableEmailChannel, useNoisyRules, useRelatedSignals,
  useRulePreview, useRunEngineNow, useRunPrune, useSendTestEmail,
  useSetRecipientEnabled, useSetRuleEnabled, useSilenceAlert, useSilenceRule,
  useTestRule, useUpdateAlertSettings, useUpdateRule,
} from '../hooks/useAlerts';
import { seedFromLink, statesFor } from '../utils/alertModel';
import { slugForProvider } from '../utils/providerScope';

/**
 * The Alerts tab — the cloud notification control centre.
 *
 * Five sub-tabs, because the questions are genuinely separate: what is
 * happening (Dashboard), what is watched (Rules), what has happened (History),
 * whether anyone can be told (Email), and how long any of it is kept
 * (Settings).
 *
 * Each section loads and fails independently. Email and Settings in particular
 * reach across into notification tables the database service owns, and those
 * can be unreadable while rules and history are perfectly healthy — so a
 * failure there shows in that panel and nowhere else.
 *
 * Permissions come from the API rather than being assumed: every write endpoint
 * is gated server-side and a 403 is the authority. The `can*` flags below only
 * decide whether a control is shown.
 */

const SUB_TABS = [
  { id: 'dashboard', label: 'Dashboard', icon: 'chart-bar' },
  { id: 'rules', label: 'Alert Rules', icon: 'bell' },
  { id: 'history', label: 'Alert History', icon: 'history' },
  { id: 'email', label: 'Email Settings', icon: 'mail' },
  { id: 'settings', label: 'Retention', icon: 'settings' },
];

const WINDOW_OPTIONS = [
  { id: '7', label: 'Last 7 days' },
  { id: '30', label: 'Last 30 days' },
  { id: '90', label: 'Last 90 days' },
];

export default function AlertsPage({ embedded = false, accountId, account }) {
  const navigate = useNavigate();
  const [tab, setTab] = useState('dashboard');
  const [builderOpen, setBuilderOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [seedTemplate, setSeedTemplate] = useState(null);
  const [openAlertId, setOpenAlertId] = useState(null);
  const [wantRelated, setWantRelated] = useState(false);
  const [filters, setFilters] = useState({});
  const [ruleFilters, setRuleFilters] = useState({});
  const [testingRule, setTestingRule] = useState(null);
  const [testResult, setTestResult] = useState(null);
  const [serverErrors, setServerErrors] = useState(null);
  const [actionNote, setActionNote] = useState(null);
  const [days, setDays] = useState('30');
  const [draft, setDraft] = useState(null);

  // ── Reads ──────────────────────────────────────────────────────────────
  const summary = useAlertSummary(accountId);
  const capabilities = useAlertCapabilities(accountId);
  const email = useEmailSettings(accountId);
  const activity = useAlertActivity(accountId, 30);
  const templates = useAlertTemplates(accountId);
  const analytics = useAlertAnalytics(accountId, Number(days));
  const noisy = useNoisyRules(accountId, 7);
  const settings = useAlertSettings(accountId);

  const ruleQuery = useMemo(() => ({
    category: ruleFilters.category || undefined,
    severity: ruleFilters.severity || undefined,
    enabled: ruleFilters.enabled ? ruleFilters.enabled === 'true' : undefined,
    notifies: ruleFilters.notifies ? ruleFilters.notifies === 'true' : undefined,
    q: ruleFilters.q || undefined,
  }), [ruleFilters]);
  const rules = useAlertRules(accountId, ruleQuery);

  const instanceFilters = useMemo(() => ({
    state: statesFor(filters.stateKey),
    severity: filters.severity || undefined,
    category: filters.category || undefined,
    ruleId: filters.ruleId || undefined,
    days: filters.days ? Number(filters.days) : undefined,
    q: filters.q || undefined,
  }), [filters]);
  const instances = useAlertInstances(accountId, instanceFilters);
  const openAlert = useAlertInstance(accountId, openAlertId);
  const related = useRelatedSignals(accountId, openAlertId, { enabled: wantRelated });
  const preview = useRulePreview(accountId, draft, { enabled: builderOpen });

  // ── Writes ─────────────────────────────────────────────────────────────
  const createRule = useCreateRule(accountId);
  const updateRule = useUpdateRule(accountId);
  const setEnabled = useSetRuleEnabled(accountId);
  const removeRule = useDeleteRule(accountId);
  const duplicate = useDuplicateRule(accountId);
  const silence = useSilenceRule(accountId);
  const silenceAlert = useSilenceAlert(accountId);
  const testRule = useTestRule(accountId);
  const alertAction = useAlertAction(accountId);
  const addRecipient = useAddRecipient(accountId);
  const toggleRecipient = useSetRecipientEnabled(accountId);
  const removeRecipient = useDeleteRecipient(accountId);
  const enableChannel = useEnableEmailChannel(accountId);
  const sendTest = useSendTestEmail(accountId);
  const runNow = useRunEngineNow(accountId);
  const applyTemplates = useApplyTemplates(accountId);
  const saveSettings = useUpdateAlertSettings(accountId);
  const prune = useRunPrune(accountId);

  const forbidden = (m) => m.error?.response?.status === 403;
  const canManage = !forbidden(createRule) && !forbidden(setEnabled);
  const canTest = !forbidden(testRule) && !forbidden(sendTest);
  const canTriage = !forbidden(alertAction) && !forbidden(silence);

  const delivery = email.data?.delivery || summary.data?.delivery;

  const goToTab = useCallback((cloudTab) => {
    const slug = slugForProvider(account?.provider);
    if (!slug || !accountId) return;
    navigate(`/cloud/${slug}-accounts/${accountId}/${cloudTab}`);
  }, [account?.provider, accountId, navigate]);

  const openBuilder = ({ rule = null, template = null } = {}) => {
    setEditing(rule);
    setSeedTemplate(template);
    setServerErrors(null);
    setDraft(null);
    setBuilderOpen(true);
  };

  // "Create alert" from a finding lands here as ?newRule=<condition>&config=…:
  // open the builder seeded with it once the catalog is loaded, then drop the
  // parameters so a reload does not open it again.
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    const condition = searchParams.get('newRule');
    if (!condition || !capabilities.data) return;
    const seed = seedFromLink(condition, searchParams.get('config'), capabilities.data);
    const next = new URLSearchParams(searchParams);
    next.delete('newRule');
    next.delete('config');
    setSearchParams(next, { replace: true });
    if (seed) {
      setTab('rules');
      openBuilder({ template: seed });
    }
  }, [searchParams, capabilities.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const closeBuilder = () => {
    setBuilderOpen(false);
    setEditing(null);
    setSeedTemplate(null);
    setServerErrors(null);
    setDraft(null);
  };

  const submitRule = (payload) => {
    setServerErrors(null);
    const onError = (err) => {
      const detail = err?.response?.data?.detail;
      setServerErrors(detail?.errors
        || { form: detail?.message || detail || err?.message || 'Could not save.' });
    };
    if (editing) {
      updateRule.mutate({ ruleId: editing.id, payload },
        { onSuccess: closeBuilder, onError });
    } else {
      createRule.mutate(payload, { onSuccess: closeBuilder, onError });
    }
  };

  const onTest = (ruleId) => {
    setTestingRule(ruleId);
    setTestResult(null);
    testRule.mutate(ruleId, {
      onSuccess: (data) => setTestResult(data),
      onSettled: () => setTestingRule(null),
    });
  };

  const openAlertRow = (id) => {
    setActionNote(null);
    setWantRelated(false);
    setOpenAlertId(id);
  };

  const body = (
    <div className="space-y-4">
      <AlertSummaryStrip
        summary={summary.data}
        loading={summary.isLoading}
        error={summary.error}
        onFilter={(what) => {
          if (what === 'rules' || what === 'inconclusive') setTab('rules');
          else if (what === 'email') setTab('email');
          else { setTab('history'); setFilters({}); }
        }}
      />

      {/* Shown on every sub-tab except Email: a rule created while delivery is
          broken will record alerts and tell nobody, and the moment to learn
          that is while creating it. */}
      {tab !== 'email' && (
        <DeliveryBanner
          delivery={delivery}
          onFix={canManage ? () => enableChannel.mutate() : undefined}
          fixing={enableChannel.isPending}
        />
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Tabs tabs={SUB_TABS} value={tab} onChange={setTab} />
        <div className="flex items-center gap-2">
          {tab === 'dashboard' && (
            <Select size="sm" width="auto" value={days} options={WINDOW_OPTIONS}
                    onChange={setDays} />
          )}
          {canManage && (
            // Not a refresh, and deliberately not labelled like one: it runs
            // the alert rules over the data already collected. Refresh all, in
            // the account header, is what re-reads the provider.
            <Button
              size="sm" variant="ghost" icon="zap"
              loading={runNow.isPending}
              onClick={() => runNow.mutate()}
              title="Evaluate the alert rules that are due now, over the data already collected, instead of waiting for the next evaluation tick. It does not re-read the provider — Refresh all does."
            >
              Run alert rules now
            </Button>
          )}
          {canManage && (tab === 'rules' || tab === 'dashboard') && (
            <>
              <Button variant="secondary" icon="bookmark"
                      onClick={() => setTemplatesOpen(true)}>
                Templates
              </Button>
              <Button variant="primary" icon="plus" onClick={() => openBuilder()}>
                Create alert
              </Button>
            </>
          )}
        </div>
      </div>

      {tab === 'dashboard' && (
        <div className="space-y-4">
          <AlertsOverTime data={analytics.data} loading={analytics.isLoading}
                          error={analytics.error} days={Number(days)} />
          <div className="grid gap-4 lg:grid-cols-2">
            <AlertsByCategory
              data={analytics.data} loading={analytics.isLoading}
              error={analytics.error}
              onSelect={(category) => { setFilters({ category }); setTab('history'); }}
            />
            <NotificationOutcomes data={analytics.data} loading={analytics.isLoading}
                                  error={analytics.error} />
            <TopRules
              data={analytics.data} loading={analytics.isLoading}
              error={analytics.error}
              onSelect={(ruleId) => { setFilters({ ruleId }); setTab('history'); }}
            />
            <AlertsByProvider data={analytics.data} loading={analytics.isLoading}
                              error={analytics.error} />
          </div>
          <NoisyRulesPanel
            data={noisy.data} loading={noisy.isLoading} error={noisy.error}
            days={7}
            onOpenRule={(ruleId) => { setFilters({ ruleId }); setTab('history'); }}
            onSilence={canTriage
              ? (ruleId) => silence.mutate({ ruleId, seconds: 21600, silence: true })
              : undefined}
          />
        </div>
      )}

      {tab === 'rules' && (
        <div className="space-y-4">
          <AlertRulesTable
            rules={rules.data?.rules || []}
            facets={rules.data?.facets}
            loading={rules.isLoading}
            canManage={canManage}
            canTest={canTest}
            canTriage={canTriage}
            filters={ruleFilters}
            onFilters={setRuleFilters}
            onCreate={() => openBuilder()}
            onTemplates={() => setTemplatesOpen(true)}
            onEdit={(rule) => openBuilder({ rule })}
            onToggle={(ruleId, enabled) => setEnabled.mutate({ ruleId, enabled })}
            onDelete={(ruleId) => removeRule.mutate(ruleId)}
            onDuplicate={(ruleId) => duplicate.mutate(ruleId)}
            onSilence={(args) => silence.mutate(args)}
            onViewHistory={(ruleId) => { setFilters({ ruleId }); setTab('history'); }}
            onTest={onTest}
            testing={testingRule}
            testResult={testResult}
            onClearTest={() => setTestResult(null)}
          />

          <section className="card p-4">
            <h3 className="mb-2 text-[13px] font-bold text-fg">Recent alert activity</h3>
            <p className="mb-2 text-[11px] leading-snug text-muted">
              What the alerting system itself did — rules changed, alerts
              triggered and resolved, every notification attempt. Provider
              activity (who changed a cloud resource) stays in the Event Log tab.
            </p>
            <AlertActivityFeed data={activity.data} loading={activity.isLoading}
                               error={activity.error} limit={12} />
          </section>
        </div>
      )}

      {tab === 'history' && (
        <AlertHistory
          data={instances.data}
          loading={instances.isLoading}
          error={instances.error}
          filters={filters}
          onFilters={setFilters}
          onOpen={openAlertRow}
        />
      )}

      {tab === 'email' && (
        <EmailSettingsPanel
          data={email.data}
          loading={email.isLoading}
          error={email.error}
          canManage={canManage}
          canTest={canTest}
          onAdd={(payload) => addRecipient.mutate(payload)}
          adding={addRecipient.isPending}
          addError={addRecipient.error?.response?.data?.detail?.errors?.email
            || addRecipient.error?.response?.data?.detail?.message}
          onToggle={(args) => toggleRecipient.mutate(args)}
          onDelete={(id) => removeRecipient.mutate(id)}
          onEnableChannel={() => enableChannel.mutate()}
          enabling={enableChannel.isPending}
          onTest={(recipients) => sendTest.mutate(recipients)}
          testing={sendTest.isPending}
          testResult={sendTest.data}
        />
      )}

      {tab === 'settings' && (
        <AlertSettingsPanel
          data={settings.data}
          loading={settings.isLoading}
          error={settings.error}
          canManage={canManage}
          onSave={(payload) => saveSettings.mutate(payload)}
          saving={saveSettings.isPending}
          saveError={saveSettings.error}
          onPrune={(dryRun) => prune.mutate(dryRun)}
          pruning={prune.isPending}
          pruneResult={prune.data}
        />
      )}

      <AlertRuleBuilder
        open={builderOpen}
        onClose={closeBuilder}
        capabilities={capabilities.data}
        capabilitiesLoading={capabilities.isLoading}
        existing={editing}
        template={seedTemplate}
        accountRecipients={email.data?.recipients || []}
        onSubmit={submitRule}
        submitting={createRule.isPending || updateRule.isPending}
        serverErrors={serverErrors}
        preview={preview.data}
        previewLoading={preview.isFetching}
        onDraftChange={setDraft}
        onBrowseTemplates={() => { closeBuilder(); setTemplatesOpen(true); }}
      />

      <TemplatePicker
        open={templatesOpen}
        onClose={() => setTemplatesOpen(false)}
        data={templates.data}
        loading={templates.isLoading}
        applying={applyTemplates.isPending}
        result={applyTemplates.data}
        onUse={(template) => { setTemplatesOpen(false); openBuilder({ template }); }}
        onApplyRecommended={(keys) => applyTemplates.mutate(keys)}
      />

      <AlertDetailDrawer
        open={!!openAlertId}
        onClose={() => { setOpenAlertId(null); setActionNote(null); setWantRelated(false); }}
        alert={openAlert.data}
        loading={openAlert.isLoading}
        canTriage={canTriage}
        acting={alertAction.isPending}
        actionNote={actionNote}
        related={related.data}
        relatedLoading={related.isFetching}
        relatedError={related.error}
        onLoadRelated={() => setWantRelated(true)}
        onOpenTab={goToTab}
        onSilence={(args) => silenceAlert.mutate(args)}
        onAction={(args) => alertAction.mutate(args, {
          // The server's note is surfaced rather than swallowed: a manually
          // resolved alert whose condition is still true WILL re-open, and
          // that looks like a bug unless somebody says so.
          onSuccess: (data) => setActionNote(data?.note || null),
        })}
      />
    </div>
  );

  if (embedded) return <div className="p-4">{body}</div>;

  return (
    <>
      <CloudPageHeader
        title="Alerts"
        description={account?.account_name
          ? `Monitor cloud conditions and notify the right people · ${account.account_name}`
          : 'Monitor cloud conditions and notify the right people'}
      />
      <div className="p-4">{body}</div>
    </>
  );
}

export { AlertsPage };
