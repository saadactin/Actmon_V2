import Badge from '@/components/ui/Badge';
import Icon from '@/components/ui/Icon';
import Notice from '@/components/ui/Notice';
import { Section } from '@/components/ui/Field';
import { formatMoneyMap } from '../../utils/clientModel';
import {
  PREVIEW_COLUMNS, ROW_SECTIONS, SECTION_LABELS, cellText, changeText, coverageSentence, postureText,
} from '../../utils/reportModel';

const SEVERITY_TONE = { CRITICAL: 'danger', HIGH: 'danger', MEDIUM: 'warning', LOW: 'neutral', INFO: 'neutral' };

function SampleTable({ section, rows }) {
  const columns = PREVIEW_COLUMNS[section] || PREVIEW_COLUMNS.security;
  return (
    <div className="max-h-80 overflow-auto rounded-control border border-border">
      <table className="w-full border-collapse text-left text-meta">
        <thead className="sticky top-0 bg-sunken">
          <tr>
            {columns.map((c) => (
              <th key={c.key} className={`px-2.5 py-1.5 font-semibold text-muted ${c.align === 'right' ? 'text-right' : ''}`}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            // eslint-disable-next-line react/no-array-index-key -- sample rows have no stable id
            <tr key={i} className="border-t border-border align-top">
              {columns.map((c) => (
                <td key={c.key} className={`px-2.5 py-1.5 text-fg ${c.align === 'right' ? 'text-right tabular-nums' : ''}`}>
                  {c.key === 'severity' && row.severity
                    ? <Badge tone={SEVERITY_TONE[row.severity] || 'neutral'} size="xs">{row.severity}</Badge>
                    : cellText(row, c)}
                  {c.key === 'resource_name' && row.attribution === 'Account-level' && (
                    <Badge tone="outline" size="xs" className="ml-1.5">account-level</Badge>
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SectionRow({ section, value, coverage }) {
  const sentence = coverageSentence(section, coverage);
  const unavailable = coverage?.status === 'unavailable';
  return (
    <details className="rounded-control border border-border">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2">
        <span className="min-w-0">
          <span className="text-[13px] font-semibold text-fg">{SECTION_LABELS[section] || section}</span>
          {sentence && <span className="mt-0.5 block text-meta text-subtle">{sentence}</span>}
        </span>
        <Badge tone={unavailable ? 'danger' : value.total > 0 ? 'accent' : 'neutral'}>
          {unavailable ? 'unavailable' : `${value.total} row${value.total === 1 ? '' : 's'}`}
        </Badge>
      </summary>
      <div className="border-t border-border px-3 py-3">
        {value.rows.length > 0 ? (
          <>
            <SampleTable section={section} rows={value.rows} />
            {value.truncated && (
              <p className="mt-1.5 text-meta text-subtle">
                Showing the first {value.rows.length} of {value.total} rows — the file contains all of them.
              </p>
            )}
          </>
        ) : (
          <p className="text-meta text-subtle">No rows in this section.</p>
        )}
      </div>
    </details>
  );
}

const TREND_TONE = { better: 'success', worse: 'danger', unchanged: 'neutral', changed: 'neutral' };

/** "Since the last report": only figures both reports measured; a different
 *  scope is said to be not comparable rather than compared anyway. */
function SinceLast({ since }) {
  if (!since) return null;
  const when = since.previous_generated_at ? new Date(since.previous_generated_at).toLocaleString() : 'the last report';
  if (!since.comparable || !since.changes?.length) {
    return <p className="text-meta text-subtle">Since the last report ({when}): {since.reason}</p>;
  }
  return (
    <div className="space-y-1">
      <p className="text-meta font-semibold text-fg">Since the last report ({when})</p>
      <ul className="space-y-0.5 text-meta">
        {since.changes.map((c) => (
          <li key={c.metric} className="flex flex-wrap items-center gap-1.5">
            <span className="text-subtle">{c.metric}:</span>
            <span className="text-fg">{String(c.previous)} → {String(c.current)}</span>
            {c.trend !== 'changed' && <Badge tone={TREND_TONE[c.trend] || 'neutral'} size="xs">{c.trend}</Badge>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The account-level summary sections (posture, identity, activity): one
 *  line each, with the section's own warning when it could not be read or
 *  has nothing to say yet. */
function AccountViews({ sections }) {
  const lines = [];
  const p = sections.posture;
  if (p) {
    const fws = p.frameworks || [];
    lines.push(['posture', p.frameworks_status === 'unavailable'
      ? p.frameworks_error
      : `${postureText(p.score)} · ${fws.length} framework(s): ${fws.map((f) => `${f.framework} ${
        f.pass_rate === null || f.pass_rate === undefined ? 'not rated' : `${Math.round(f.pass_rate)}%`}`).join(', ')}`]);
  }
  const idn = sections.identity;
  if (idn) {
    lines.push(['identity', idn.status === 'unavailable' ? idn.error
      : idn.counts?.identities
        ? `${idn.counts.identities} identities · ${idn.counts.admin ?? '—'} admin · ${idn.counts.standing_admin ?? '—'} standing admin · ${idn.counts.mfa_gaps ?? '—'} without MFA`
        : idn.note]);
  }
  const a = sections.activity;
  if (a) {
    lines.push(['activity', a.status === 'unavailable' ? a.error
      : `${a.total_events ?? 0} events · ${a.high_risk_events ?? 0} high-risk · ${a.failed_events ?? 0} failed · ${a.distinct_actors ?? 0} actors${a.note ? ` — ${a.note}` : ''}`]);
  }
  if (!lines.length) return null;
  return (
    <Section title="Account Views">
      <dl className="space-y-1.5 text-meta">
        {lines.map(([key, text]) => (
          <div key={key} className="flex flex-wrap gap-x-2">
            <dt className="font-semibold text-fg">{SECTION_LABELS[key]}</dt>
            <dd className="text-subtle">{text}</dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

function freshnessLine(fresh) {
  if (!fresh) return null;
  const at = fresh.last_refreshed_at ? new Date(fresh.last_refreshed_at).toLocaleString() : 'never';
  return `Last refreshed ${at}${fresh.refresh_status ? ` (${fresh.refresh_status})` : ''} · billing data through ${
    fresh.billing_data_through || 'none stored'}`;
}

export default function ReportPreview({ isLoading, isFetching, isError, error, data }) {
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-8 text-[13px] text-muted">
        <Icon name="spinner" size={16} className="animate-spin" />
        Building preview...
      </div>
    );
  }

  if (isError) {
    const detail = error?.response?.data?.detail;
    return (
      <Notice tone="danger" title="Could not build a preview">
        {(typeof detail === 'string' && detail) || detail?.error?.message
          || (Array.isArray(detail) && detail.map((d) => d.msg).join('; '))
          || error?.message || 'Unknown error.'}
      </Notice>
    );
  }

  if (!data) return null;

  const { resolved_scope: resolvedScope, preview } = data;
  const sections = preview.sections || {};
  const coverage = preview.coverage || {};
  const fresh = preview.freshness;
  const period = preview.period;
  const summary = sections.executive_summary;
  const spend = sections.cost_summary;
  const rowSections = ROW_SECTIONS.filter((s) => s in sections);
  const detail = preview.layout?.detail_level;

  return (
    <div className={`space-y-5 ${isFetching ? 'opacity-70' : ''}`}>
      <Notice tone="info">
        {resolvedScope.resource_count} resource(s) in scope
        {period && <> · reporting period {period.start} to {period.end} ({period.timezone})</>}.
        {' '}Each section below previews up to 50 rows — the generated file contains every row.
      </Notice>

      {fresh?.warnings?.length > 0 && (
        <Notice tone="warning" title="This report will say its data is incomplete">
          <ul className="list-inside list-disc space-y-0.5">
            {fresh.warnings.map((w) => <li key={w}>{w}</li>)}
          </ul>
        </Notice>
      )}

      {preview.resources_missing?.length > 0 && (
        <Notice tone="warning">
          {preview.resources_missing.length} selected resource(s) no longer exist or
          belong to a different account and will be excluded.
        </Notice>
      )}

      {(summary || spend) && (
        <Section title="Summary">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-meta sm:grid-cols-4">
            {summary && (
              <>
                <div><dt className="text-subtle">Critical / high findings</dt><dd className="text-[13px] font-semibold text-fg">{summary.critical_or_high}</dd></div>
                {'account_level_findings' in summary && (
                  <div><dt className="text-subtle">Account-level findings</dt><dd className="text-[13px] font-semibold text-fg">{summary.account_level_findings}</dd></div>
                )}
              </>
            )}
            {summary?.billed_cost_of_resources_in_scope && (
              <div>
                <dt className="text-subtle">Billed cost in scope</dt>
                <dd className="text-[13px] font-semibold text-fg">{formatMoneyMap(summary.billed_cost_of_resources_in_scope)}</dd>
              </div>
            )}
            {spend?.spend_by_currency && (
              <div>
                <dt className="text-subtle">Account spend in period</dt>
                <dd className="text-[13px] font-semibold text-fg">
                  {formatMoneyMap(Object.fromEntries(Object.entries(spend.spend_by_currency).map(([c, v]) => [c, v.amount])))}
                </dd>
              </div>
            )}
            {summary?.posture && (
              <div>
                <dt className="text-subtle">Security posture</dt>
                <dd className="text-[13px] font-semibold text-fg">{postureText(summary.posture)}</dd>
              </div>
            )}
            {summary?.potential_monthly_savings && (
              <div>
                <dt className="text-subtle">Potential savings / month</dt>
                <dd className="text-[13px] font-semibold text-fg">
                  {formatMoneyMap(summary.potential_monthly_savings)}
                  {summary.savings_unpriced_findings > 0 && (
                    <span className="block text-meta font-normal text-subtle">
                      +{summary.savings_unpriced_findings} not quantified
                    </span>
                  )}
                </dd>
              </div>
            )}
          </dl>
          {Object.entries(summary?.spend_change?.by_currency || {}).map(([code, entry]) => (
            <p key={code} className="text-meta text-subtle">
              Spend vs the previous equal period ({code}): <span className="font-semibold text-fg">{changeText(entry, code)}</span>
              {' '}· {summary.spend_change.basis}
            </p>
          ))}
          {spend?.gap_note && <p className="text-meta text-subtle">{spend.gap_note}</p>}
          <SinceLast since={summary?.since_last_report} />
        </Section>
      )}

      <AccountViews sections={sections} />

      <Section title="Sections">
        {detail === 'executive' && (
          <p className="text-meta text-subtle">
            Executive detail level: the file contains summaries only, no per-resource rows.
          </p>
        )}
        <div className="space-y-2">
          {rowSections.map((key) => (
            <SectionRow key={key} section={key} value={sections[key]} coverage={coverage[key]} />
          ))}
        </div>
      </Section>

      {preview.notes?.length > 0 && (
        <Section title="Notes">
          <ul className="list-inside list-disc space-y-1 text-meta text-subtle">
            {preview.notes.map((note) => <li key={note}>{note}</li>)}
          </ul>
        </Section>
      )}

      {fresh && <p className="text-meta text-subtle">{freshnessLine(fresh)}</p>}
    </div>
  );
}
