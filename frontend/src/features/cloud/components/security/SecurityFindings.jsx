import { useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Drawer from '@/components/ui/Drawer';
import Icon from '@/components/ui/Icon';
import Select from '@/components/ui/Select';
import Table, { EmptyState } from '@/components/ui/Table';
import Textarea from '@/components/ui/Textarea';
import { PageLoading } from '@/components/ui/Loading';
import CloudFilterBar from '../CloudFilterBar';
import CloudSection from '../CloudSection';
import {
  categoryIcon, confidenceMeta, formatCount, formatDateTime, severityAccent,
  severityTone, STATUS_NEEDS_REASON, statusMeta, verdictMeta,
} from '../../utils/securityModel';
import { useFinding, useFindings, useSetFindingStatus } from '../../hooks/useSecurityCenter';

const PAGE_SIZE = 50;

const STATUS_OPTIONS = [
  { id: 'OPEN,IN_PROGRESS', label: 'Active' },
  { id: 'OPEN', label: 'Open' },
  { id: 'IN_PROGRESS', label: 'In progress' },
  { id: 'RESOLVED', label: 'Resolved' },
  { id: 'SUPPRESSED', label: 'Suppressed' },
  { id: 'ACCEPTED_RISK', label: 'Risk accepted' },
];

// Confirmed vs undetermined is the most important filter on this page, so it
// gets its own control rather than hiding inside a generic dropdown. An
// operator triaging real problems and an operator chasing collection gaps are
// doing two different jobs.
const VERDICT_OPTIONS = [
  { id: '', label: 'Confirmed and undetermined' },
  { id: 'VULNERABLE', label: 'Confirmed only' },
  { id: 'UNKNOWN,NOT_SCANNED', label: 'Undetermined only' },
];

/**
 * The Findings tab.
 *
 * Filtering, sorting and paging are all server-side. The old page fetched every
 * finding and filtered in the browser, which is why it worked on a 224-resource
 * AWS account and would not have on the 100,000-resource target.
 */
export default function SecurityFindings({ accountId, meta, initialFilters }) {
  const [status, setStatus] = useState(initialFilters?.status || 'OPEN,IN_PROGRESS');
  const [severity, setSeverity] = useState(initialFilters?.severity || '');
  const [category, setCategory] = useState(initialFilters?.category || '');
  const [verdict, setVerdict] = useState(initialFilters?.verdict || '');
  const [resourceType, setResourceType] = useState('');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState(null);

  const filters = useMemo(() => ({
    status, severity, category, verdict, resource_type: resourceType,
    search: search.trim() || undefined,
    framework: initialFilters?.framework,
    control_id: initialFilters?.control_id,
    rule_id: initialFilters?.rule_id,
    limit: PAGE_SIZE, offset,
  }), [status, severity, category, verdict, resourceType, search, offset, initialFilters]);

  const { data, isLoading, isError, error } = useFindings(accountId, filters);
  const facets = data?.facets || {};

  const reset = (setter) => (value) => { setter(value); setOffset(0); };

  const columns = [
    { key: 'severity', label: 'Severity', width: 108 },
    { key: 'title', label: 'Finding' },
    { key: 'resource', label: 'Resource' },
    { key: 'category', label: 'Category', width: 150 },
    { key: 'verdict', label: 'Verdict', width: 130 },
    { key: 'age', label: 'First seen', width: 130, align: 'right' },
  ];

  const rows = (data?.findings || []).map((f) => ({
    key: f.fingerprint,
    onClick: () => setSelected(f.fingerprint),
    cells: {
      severity: (
        <div className={`-ml-card flex items-center gap-2 border-l-4 pl-card ${severityAccent(f.severity)}`}>
          <Badge tone={severityTone(f.severity)}>{f.severity}</Badge>
        </div>
      ),
      title: (
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate-safe font-medium text-fg">{f.title}</span>
            {f.affected_count > 1 && (
              <Badge tone="outline" size="xs">{formatCount(f.affected_count)} resources</Badge>
            )}
            {!f.scores && (
              // Says outright that this finding does not move the score. Without
              // it, a reader comparing the finding count to the score concludes
              // the score is arbitrary.
              <Badge tone="neutral" size="xs">not scored</Badge>
            )}
          </div>
          <div className="mt-0.5 truncate-safe text-[11px] text-subtle">{f.rule_id}</div>
        </div>
      ),
      resource: f.resource_name
        ? (
          <div className="min-w-0">
            <div className="truncate-safe text-[13px] text-fg">{f.resource_name}</div>
            <div className="truncate-safe text-[11px] text-subtle">{f.resource_type}</div>
          </div>
        )
        : <span className="text-[11px] text-subtle">Account-wide</span>,
      category: (
        <span className="inline-flex items-center gap-1.5 text-[12px] text-muted">
          <Icon name={categoryIcon(f.category)} size={13} />
          {f.category}
        </span>
      ),
      verdict: <Badge tone={verdictMeta(f.verdict).tone}>{verdictMeta(f.verdict).label}</Badge>,
      age: <span className="text-[11px] text-muted">{formatDateTime(f.first_detected_at)}</span>,
    },
    sort: {
      severity: f.severity, title: f.title, resource: f.resource_name || '',
      category: f.category, verdict: f.verdict, age: f.first_detected_at || '',
    },
  }));

  return (
    <div className="space-y-4">
      <div className="card flex flex-wrap items-center gap-3 px-card py-3">
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-muted">
          <Icon name="filter" size={14} /> Filters
        </span>
        <CloudFilterBar
          className="flex-1"
          search={search}
          onSearchChange={(v) => { setSearch(v); setOffset(0); }}
          searchPlaceholder="Resource name, ARN, OCID, rule id, finding id…"
          filters={[
            { key: 'status', value: status, onChange: reset(setStatus),
              options: STATUS_OPTIONS },
            { key: 'verdict', value: verdict, onChange: reset(setVerdict),
              options: VERDICT_OPTIONS },
            // Facet counts come from the backend, so each dropdown offers only
            // what is actually present — a user cannot pick a combination that
            // is guaranteed to return nothing.
            { key: 'severity', value: severity, onChange: reset(setSeverity),
              options: [
                { id: '', label: 'All severities' },
                ...(facets.severities || []).map((x) => ({
                  id: x.value, label: `${x.value} (${x.count})`,
                })),
              ] },
            { key: 'category', value: category, onChange: reset(setCategory),
              options: [
                { id: '', label: 'All categories' },
                ...(facets.categories || []).map((x) => ({
                  id: x.value, label: `${x.value} (${x.count})`,
                })),
              ] },
            { key: 'rtype', value: resourceType, onChange: reset(setResourceType),
              options: [
                { id: '', label: 'All resource types' },
                ...(facets.resource_types || []).slice(0, 40).map((x) => ({
                  id: x.value, label: `${x.value} (${x.count})`,
                })),
              ] },
          ]}
        />
      </div>

      {isLoading && !data && <PageLoading title="Loading findings…" minHeight={240} />}

      {isError && (
        <CloudSection>
          <EmptyState
            icon="alert"
            title="Findings could not be loaded"
            body={error?.response?.data?.detail || error?.message
              || 'The request failed. This is a load error, not an empty result.'}
          />
        </CloudSection>
      )}

      {data && !isError && (
        <>
          <div className="flex items-center justify-between text-xs text-muted">
            <span>
              {formatCount(data.total)} finding{data.total === 1 ? '' : 's'} match
              {data.total > 0 && ` · showing ${offset + 1}–${offset + (data.findings?.length || 0)}`}
            </span>
            {data.note && <span className="italic">{data.note}</span>}
          </div>

          {rows.length === 0 ? (
            <CloudSection>
              <EmptyState
                icon="filter"
                title="No findings match these filters"
                body={
                  // "No findings" and "no findings matching a filter" are
                  // different statements, and the second must not be reported
                  // as the first (§75).
                  status.includes('OPEN')
                    ? 'Widen the filters, or check Coverage — an account with low coverage '
                      + 'has findings that could not be evaluated rather than none.'
                    : 'Try the Active status filter.'
                }
              />
            </CloudSection>
          ) : (
            <Table
              columns={columns}
              rows={rows}
              rowHeight={58}
              virtualize
              maxBodyHeight={620}
            />
          )}

          {data.total > PAGE_SIZE && (
            <div className="flex items-center justify-between">
              <Button
                size="sm"
                icon="chevron-left"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              >
                Previous
              </Button>
              <span className="text-xs text-muted">
                Page {Math.floor(offset / PAGE_SIZE) + 1} of {Math.ceil(data.total / PAGE_SIZE)}
              </span>
              <Button
                size="sm"
                iconRight="chevron-right"
                disabled={!data.has_more}
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                Next
              </Button>
            </div>
          )}
        </>
      )}

      <FindingDrawer
        accountId={accountId}
        findingKey={selected}
        onClose={() => setSelected(null)}
        meta={meta}
      />
    </div>
  );
}

/**
 * One finding, everything connected to it (§38).
 *
 * The sections are ordered as an investigation runs: what is wrong, why it
 * matters, what the provider actually reported, what it breaches, what it
 * produced, what happened when — and only then how to fix it.
 */
export function FindingDrawer({ accountId, findingKey, onClose, meta }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { data: f, isLoading } = useFinding(accountId, findingKey);
  const mutate = useSetFindingStatus();
  const [statusDraft, setStatusDraft] = useState(null);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState(null);

  const close = () => {
    setStatusDraft(null); setReason(''); setErr(null); onClose();
  };

  const apply = async () => {
    setErr(null);
    try {
      await mutate.mutateAsync({
        accountId, key: findingKey, status: statusDraft, reason: reason.trim() || undefined,
      });
      setStatusDraft(null); setReason('');
    } catch (e) {
      setErr(e?.response?.data?.detail || e?.message || 'The update failed.');
    }
  };

  if (!findingKey) return null;

  return (
    <Drawer
      open={!!findingKey}
      onClose={close}
      title={f?.title || 'Finding'}
      subtitle={f ? `${f.rule_id} · v${f.rule_version}` : undefined}
      width={640}
      footer={f && (
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={statusDraft || ''}
            onChange={(v) => { setStatusDraft(v || null); setErr(null); }}
            options={[
              { id: '', label: 'Change status…' },
              { id: 'IN_PROGRESS', label: 'Mark in progress' },
              { id: 'RESOLVED', label: 'Mark resolved' },
              { id: 'SUPPRESSED', label: 'Suppress' },
              { id: 'ACCEPTED_RISK', label: 'Accept risk' },
            ]}
          />
          {statusDraft && (
            <Button
              variant="primary"
              size="sm"
              loading={mutate.isPending}
              onClick={apply}
            >
              Apply
            </Button>
          )}
        </div>
      )}
    >
      {isLoading && <PageLoading title="Loading finding…" minHeight={200} />}
      {f && (
        <div className="space-y-5 text-sm">
          {statusDraft && (
            <div className="rounded-control border border-accent-soft bg-accent-soft p-3">
              <p className="text-xs font-semibold text-accent-text">
                {statusMeta(statusDraft).label}
              </p>
              {STATUS_NEEDS_REASON[statusDraft] && (
                <p className="mt-1 text-[11px] leading-relaxed text-accent-text">
                  {STATUS_NEEDS_REASON[statusDraft]}
                </p>
              )}
              <Textarea
                className="mt-2"
                rows={3}
                placeholder={STATUS_NEEDS_REASON[statusDraft]
                  ? 'Required — why is this being left in place?'
                  : 'Optional note'}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
              {err && <p className="mt-2 text-[11px] text-danger">{err}</p>}
            </div>
          )}

          {/* Status strip */}
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={severityTone(f.severity)}>{f.severity}</Badge>
            <Badge tone={verdictMeta(f.verdict).tone}>{verdictMeta(f.verdict).label}</Badge>
            <Badge tone={statusMeta(f.status).tone}>{statusMeta(f.status).label}</Badge>
            <Badge tone={confidenceMeta(f.confidence).tone}>
              Confidence: {confidenceMeta(f.confidence).label}
            </Badge>
            <Badge tone="outline">{f.category}</Badge>
            {!f.scores && <Badge tone="neutral">Does not affect score</Badge>}
          </div>

          {f.verdict !== 'VULNERABLE' && (
            <div className="rounded-control border border-warning-soft bg-warning-soft p-3 text-xs text-warning-fg">
              <p className="font-semibold">{verdictMeta(f.verdict).label}</p>
              <p className="mt-1 leading-relaxed">{verdictMeta(f.verdict).meaning}</p>
            </div>
          )}

          <Section title="What is wrong">
            <p className="leading-relaxed text-fg">{f.description}</p>
          </Section>

          {f.rationale && (
            <Section title="Why it matters">
              <p className="leading-relaxed text-muted">{f.rationale}</p>
            </Section>
          )}

          <Section title="Resource">
            <Rows
              rows={[
                ['Name', f.resource_name || 'Account-wide'],
                ['Type', f.resource_type],
                ['Provider id', f.resource_key],
                ['Region', f.region],
                ['Affected resources', f.affected_count > 1 ? formatCount(f.affected_count) : null],
              ]}
            />
            {f.related?.links?.resource && (
              <div className="mt-2 flex flex-wrap gap-2">
                <Button size="sm" icon="box"
                  onClick={() => navigate(f.related.links.resource)}>
                  Open resource
                </Button>
                {f.related.drift_changes > 0 && (
                  <Button size="sm" icon="history"
                    onClick={() => navigate(`/cloud/drift${f.related.links.drift}`)}>
                    {f.related.drift_changes} config change{f.related.drift_changes === 1 ? '' : 's'}
                  </Button>
                )}
                <Button size="sm" icon="logs"
                  onClick={() => navigate(`/cloud/events${f.related.links.events}`)}>
                  Audit events
                </Button>
                {/* Sibling tab of whichever account dashboard we are inside, so
                    the link works from any provider's route without this
                    component needing to know the provider slug. The topology
                    page consumes `?focus=` once and drops it. */}
                <Button size="sm" icon="route"
                  onClick={() => navigate(
                    `${location.pathname.replace(/\/[^/]*$/, '/topology')}`
                    + `${f.related.links.topology}`,
                  )}>
                  View in topology
                </Button>
              </div>
            )}
          </Section>

          {/* Evidence. The section that makes a finding defensible rather than
              merely readable — an analyst reads this to check the conclusion
              without trusting the engine. */}
          <Section title="Evidence">
            {f.evidence?._withheld ? (
              <p className="text-xs italic text-muted">{f.evidence._withheld}</p>
            ) : (
              <pre className="max-h-72 overflow-auto rounded-control border border-border bg-sunken p-3 text-[11px] leading-relaxed text-fg">
                {JSON.stringify(f.evidence ?? {}, null, 2)}
              </pre>
            )}
          </Section>

          {f.affected_sample?.length > 0 && (
            <Section title={`Affected resources (${f.affected_sample.length} shown)`}>
              <div className="max-h-56 overflow-auto rounded-control border border-border">
                {f.affected_sample.map((s) => (
                  <div key={s.resource_id || s.resource_key}
                    className="flex items-center justify-between border-b border-border px-2.5 py-1.5 text-[11px] last:border-0">
                    <span className="truncate-safe text-fg">{s.resource_name || s.resource_key}</span>
                    <span className="ml-2 shrink-0 text-subtle">{s.resource_type}</span>
                  </div>
                ))}
              </div>
            </Section>
          )}

          {f.compliance && Object.keys(f.compliance).length > 0 && (
            <Section title="Controls this breaches">
              <div className="space-y-2">
                {Object.entries(f.compliance).map(([framework, refs]) => (
                  <div key={framework} className="rounded-control border border-border p-2.5">
                    <div className="text-[11px] font-bold uppercase tracking-wider text-muted">
                      {framework}
                    </div>
                    <ul className="mt-1 space-y-0.5">
                      {refs.map((r) => (
                        <li key={r} className="text-[12px] text-fg">{r}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
              <p className="mt-2 text-[11px] italic leading-relaxed text-subtle">
                Informative cross-walks to the published control text, not a certified
                assessment.
              </p>
            </Section>
          )}

          {f.alerts?.length > 0 && (
            <Section title="Alerts from this finding">
              {f.alerts.map((a) => (
                <div key={a.id} className="mb-2 rounded-control border border-border p-2.5">
                  <div className="flex items-center gap-2">
                    <Badge tone={severityTone(a.severity)}>{a.severity}</Badge>
                    <span className="truncate-safe text-[12px] font-medium text-fg">
                      {a.policy_name || a.anomaly_type}
                    </span>
                    <Badge tone={a.state === 'OPEN' ? 'danger' : a.state === 'RESOLVED' ? 'success' : 'warning'}>
                      {a.state}
                    </Badge>
                  </div>
                  <div className="mt-1 text-[11px] text-subtle">
                    Seen {a.occurrence_count}× · notified {a.notification_count || 0}×
                    {a.notification_status ? ` · ${a.notification_status}` : ''}
                  </div>
                </div>
              ))}
            </Section>
          )}

          {f.timeline?.length > 0 && (
            <Section title="Timeline">
              <ol className="space-y-2">
                {f.timeline.map((e, i) => (
                  <li key={`${e.at}-${i}`} className="flex gap-2.5">
                    <Icon name="dot" size={12} className="mt-1 shrink-0 text-subtle" />
                    <div className="min-w-0">
                      <div className="text-[11px] font-semibold text-fg">
                        {e.event.replace(/_/g, ' ')}
                      </div>
                      <div className="text-[11px] text-subtle">{formatDateTime(e.at)}</div>
                      {e.detail && (
                        <div className="text-[11px] leading-relaxed text-muted">{e.detail}</div>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            </Section>
          )}

          <Section title="Freshness">
            <Rows
              rows={[
                ['First detected', formatDateTime(f.first_detected_at)],
                ['Last detected', formatDateTime(f.last_detected_at)],
                ['Seen in assessments', f.detection_count],
                ['Resource last discovered', formatDateTime(f.resource_last_discovered_at)],
                // Deliberately shows "Never" rather than reusing the assessment
                // timestamp: the assessment reads stored inventory, so nothing
                // here has been re-confirmed against the provider.
                ['Verified against provider', f.last_verified_at ? formatDateTime(f.last_verified_at) : 'Never — evaluated from stored inventory'],
              ]}
            />
          </Section>

          {f.rule?.version_changed_since && (
            <div className="rounded-control border border-info-soft bg-info-soft p-3 text-xs text-info-fg">
              This finding was produced by rule version {f.rule.finding_version}; the current
              version is {f.rule.current_version}. Its severity or logic may have changed
              since — re-run the assessment to refresh it.
            </div>
          )}

          <Section title="How to fix it">
            <pre className="whitespace-pre-wrap rounded-control border border-info-soft bg-info-soft p-3 text-[11px] leading-relaxed text-fg">
              {f.remediation}
            </pre>
          </Section>
        </div>
      )}
    </Drawer>
  );
}

function Section({ title, children }) {
  return (
    <div>
      <h4 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-muted">{title}</h4>
      {children}
    </div>
  );
}

function Rows({ rows }) {
  const visible = rows.filter(([, v]) => v !== null && v !== undefined && v !== '');
  if (!visible.length) return <p className="text-xs text-subtle">Not available.</p>;
  return (
    <dl className="divide-y divide-border overflow-hidden rounded-control border border-border">
      {visible.map(([label, value]) => (
        <div key={label} className="flex gap-3 px-2.5 py-1.5">
          <dt className="w-40 shrink-0 text-[11px] text-muted">{label}</dt>
          <dd className="min-w-0 break-words text-[12px] text-fg">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
