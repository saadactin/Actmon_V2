import { useState } from 'react';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Drawer from '@/components/ui/Drawer';
import Icon from '@/components/ui/Icon';
import Table, { EmptyState } from '@/components/ui/Table';
import { PageLoading } from '@/components/ui/Loading';
import CloudSection from '../CloudSection';
import {
  controlStateMeta, formatCount, formatPct, severityTone,
} from '../../utils/securityModel';
import { useCompliance } from '../../hooks/useSecurityCenter';

/**
 * The Compliance tab.
 *
 * Two numbers per framework, always shown together, because either alone
 * misleads:
 *
 *   Control pass rate    — of the controls we assessed, how many passed.
 *   Assessment coverage  — of the controls in the catalog, how many we assessed.
 *
 * "8 of 9 assessed controls passing, covering 30% of the catalog" is a true and
 * useful statement. "89% compliant" from the same data is not, which is why the
 * word compliant does not appear anywhere in this file.
 *
 * The previous version showed `NA` for every score. That was honest but not a
 * destination — and its three framework tiles rendered identical violation
 * counts, because it counted findings rather than controls and every mapped
 * category happened to exist in all three frameworks.
 */
export default function SecurityCompliance({ accountId, onOpenFindings }) {
  const [framework, setFramework] = useState(null);
  const [control, setControl] = useState(null);
  const { data, isLoading, isError } = useCompliance(accountId);

  if (isLoading) return <PageLoading title="Building control assessment…" minHeight={240} />;
  if (isError || !data) {
    return (
      <CloudSection>
        <EmptyState icon="alert" title="Compliance view unavailable"
          body="The request failed. This is a load error, not a passing result." />
      </CloudSection>
    );
  }

  const frameworks = Object.values(data.frameworks || {});
  const controls = (data.controls || []).filter(
    (c) => !framework || c.framework === framework,
  );

  return (
    <div className="space-y-5">
      {/* Framework tiles. Clicking one filters the control list. */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {frameworks.map((fw) => {
          const active = framework === fw.framework;
          return (
            <button
              key={fw.framework}
              type="button"
              onClick={() => setFramework(active ? null : fw.framework)}
              className={`card px-card py-4 text-left transition-colors ${
                active ? 'border-accent ring-1 ring-accent' : 'hover:border-strong'
              }`}
              aria-pressed={active}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-[15px] font-semibold text-fg">{fw.label}</div>
                  <div className="truncate-safe text-[11px] text-subtle">{fw.full_name}</div>
                </div>
                {fw.controls_failed > 0 && (
                  <Badge tone="danger">{fw.controls_failed} failed</Badge>
                )}
              </div>

              <div className="mt-3 grid grid-cols-2 gap-3">
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-wider text-muted">
                    Assessed controls passing
                  </div>
                  <div className="mt-0.5 text-xl font-bold text-fg">
                    {formatPct(fw.control_pass_rate, { nullLabel: 'None assessed' })}
                  </div>
                  <div className="text-[11px] text-subtle">
                    {fw.controls_passed} of {fw.controls_assessed}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-wider text-muted">
                    Catalog assessed
                  </div>
                  <div className="mt-0.5 text-xl font-bold text-fg">
                    {formatPct(fw.assessment_coverage, { nullLabel: '—' })}
                  </div>
                  <div className="text-[11px] text-subtle">
                    {fw.controls_assessed} of {fw.controls_declared}
                  </div>
                </div>
              </div>

              <div className="mt-3 flex flex-wrap gap-1.5">
                <Badge tone="danger" size="xs">{fw.controls_failed} fail</Badge>
                <Badge tone="warning" size="xs">{fw.controls_partial} partial</Badge>
                <Badge tone="warning" size="xs">{fw.controls_unknown} no evidence</Badge>
                <Badge tone="success" size="xs">{fw.controls_passed} pass</Badge>
                <Badge tone="outline" size="xs">{fw.controls_not_evaluated} not evaluated</Badge>
                <Badge tone="neutral" size="xs">{fw.controls_not_applicable} n/a</Badge>
              </div>
            </button>
          );
        })}
      </div>

      {/* The honesty note. Not a footnote — it is the difference between this
          view and a compliance claim. */}
      <div className="flex items-start gap-2 rounded-control border border-info-soft bg-info-soft p-3 text-xs text-info-fg">
        <Icon name="info" size={15} className="mt-0.5 shrink-0" />
        <p className="leading-relaxed">{data.note}</p>
      </div>

      {data.trend?.available && (
        <CloudSection title="Change since the previous assessment">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            {Object.entries(data.trend.frameworks).map(([fw, t]) => (
              <div key={fw} className="rounded-control border border-border p-3">
                <div className="flex items-center justify-between">
                  <span className="text-[12px] font-semibold text-fg">{fw}</span>
                  <Badge tone={t.direction === 'improved' ? 'success'
                    : t.direction === 'regressed' ? 'danger' : 'neutral'}>
                    {t.direction}
                  </Badge>
                </div>
                <div className="mt-1.5 text-[11px] text-muted">
                  Failed controls: {t.controls_failed_before} → {t.controls_failed_now}
                </div>
                {t.note && (
                  <p className="mt-1 text-[11px] italic leading-relaxed text-subtle">{t.note}</p>
                )}
              </div>
            ))}
          </div>
        </CloudSection>
      )}

      <CloudSection
        title={framework ? `${framework} controls` : 'All controls'}
        description="Worst first. Click a control to see the findings that decided it."
        action={framework && (
          <Button size="sm" icon="close" onClick={() => setFramework(null)}>
            Clear filter
          </Button>
        )}
      >
        <Table
          columns={[
            { key: 'state', label: 'State', width: 160 },
            { key: 'control', label: 'Control' },
            { key: 'findings', label: 'Findings', width: 100, align: 'right' },
            { key: 'resources', label: 'Resources', width: 100, align: 'right' },
          ]}
          rows={controls.map((c) => ({
            key: `${c.framework}:${c.control_id}`,
            onClick: () => setControl(c),
            cells: {
              state: (
                <div className="flex items-center gap-2">
                  <Badge tone={controlStateMeta(c.state).tone}>
                    {controlStateMeta(c.state).label}
                  </Badge>
                </div>
              ),
              control: (
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[11px] text-subtle">{c.framework}</span>
                    <span className="truncate-safe text-[13px] font-medium text-fg">
                      {c.control_id} {c.title}
                    </span>
                  </div>
                  <div className="line-clamp-1 text-[11px] text-subtle">{c.reason}</div>
                </div>
              ),
              findings: c.finding_count
                ? <span className="text-[12px] text-fg">{formatCount(c.finding_count)}</span>
                : <span className="text-[11px] text-subtle">—</span>,
              resources: c.affected_resources
                ? <span className="text-[12px] text-fg">{formatCount(c.affected_resources)}</span>
                : <span className="text-[11px] text-subtle">—</span>,
            },
            sort: {
              state: c.state, control: `${c.framework} ${c.control_id}`,
              findings: c.finding_count, resources: c.affected_resources,
            },
          }))}
          rowHeight={58}
          virtualize
          maxBodyHeight={560}
        />
      </CloudSection>

      <CloudSection
        title={`Control violations (${data.total_violations})`}
        description="One row per finding that breaches at least one control, with every framework that cites it. A finding appears once, not once per framework."
      >
        {data.violations?.length === 0 ? (
          <EmptyState
            icon={data.undetermined_findings > 0 ? 'help' : 'shield-check'}
            title={data.undetermined_findings > 0
              ? 'No confirmed control violations — but the assessment is incomplete'
              : 'No control violations'}
            body={data.undetermined_findings > 0
              ? `${data.undetermined_findings} check result(s) could not be determined, so `
                + 'this is not a passing result. See Coverage.'
              : `${data.advisory_findings} advisory finding(s) are recorded on the Findings `
                + 'tab; they are hygiene rather than control violations.'}
          />
        ) : (
          <div className="space-y-3">
            {data.violations.slice(0, 100).map((v) => (
              <div key={v.fingerprint} className="rounded-control border border-border px-card py-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={severityTone(v.severity)}>{v.severity}</Badge>
                      <span className="text-[13px] font-semibold text-fg">{v.title}</span>
                      <Badge tone="outline" size="xs">{v.category}</Badge>
                    </div>
                    <div className="mt-1 text-[11px] text-muted">{v.affected_resource}</div>
                  </div>
                  {onOpenFindings && (
                    <Button size="sm" icon="external"
                      onClick={() => onOpenFindings({ rule_id: v.rule_id })}>
                      Findings
                    </Button>
                  )}
                </div>
                <div className="mt-2 flex flex-wrap gap-3">
                  {Object.entries(v.controls || {}).map(([fw, refs]) => (
                    <div key={fw} className="min-w-0">
                      <div className="text-[10px] font-bold uppercase tracking-wider text-muted">
                        {fw}
                      </div>
                      {refs.map((r) => (
                        <div key={r} className="text-[11px] text-fg">{r}</div>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            ))}
            {data.violations.length > 100 && (
              <p className="text-xs italic text-muted">
                Showing the 100 most severe of {data.violations.length}. Use the Findings tab
                to page through them all.
              </p>
            )}
          </div>
        )}
      </CloudSection>

      <ControlDrawer
        control={control}
        onClose={() => setControl(null)}
        onOpenFindings={onOpenFindings}
      />
    </div>
  );
}

function ControlDrawer({ control, onClose, onOpenFindings }) {
  if (!control) return null;
  const meta = controlStateMeta(control.state);
  return (
    <Drawer
      open={!!control}
      onClose={onClose}
      title={`${control.control_id} ${control.title}`}
      subtitle={control.framework}
      width={560}
    >
      <div className="space-y-5 text-sm">
        <div className="flex items-center gap-2">
          <Badge tone={meta.tone}>{meta.label}</Badge>
          {control.worst_severity && (
            <Badge tone={severityTone(control.worst_severity)}>
              worst {control.worst_severity}
            </Badge>
          )}
        </div>

        <div>
          <h4 className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-muted">
            What the control requires
          </h4>
          <p className="leading-relaxed text-fg">{control.requirement}</p>
        </div>

        <div>
          <h4 className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-muted">
            Why this state
          </h4>
          <p className="leading-relaxed text-muted">{control.reason}</p>
          <p className="mt-1.5 text-[11px] italic leading-relaxed text-subtle">
            {control.state_meaning}
          </p>
        </div>

        <div>
          <h4 className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-muted">
            Checks covering it
          </h4>
          {control.rules?.length === 0 ? (
            <p className="text-xs text-muted">
              No check in this build assesses this control. It is listed on purpose, so the
              gap is visible rather than hidden — and it is never counted as passed.
            </p>
          ) : (
            <ul className="space-y-1">
              {control.rules.map((r) => (
                <li key={r} className="flex items-center gap-2 text-[12px]">
                  <Icon
                    name={control.rules_that_ran?.includes(r) ? 'check' : 'circle'}
                    size={12}
                    className={control.rules_that_ran?.includes(r) ? 'text-success' : 'text-subtle'}
                  />
                  <span className="font-mono text-fg">{r}</span>
                  {!control.rules_that_ran?.includes(r) && (
                    <span className="text-[11px] text-subtle">(did not run)</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="grid grid-cols-3 gap-3">
          <Metric label="Findings" value={control.finding_count} />
          <Metric label="Failing" value={control.failing_findings} />
          <Metric label="Undetermined" value={control.undetermined_findings} />
        </div>

        {onOpenFindings && control.rules?.length > 0 && (
          <Button
            variant="primary"
            icon="list"
            onClick={() => {
              onOpenFindings({ framework: control.framework, control_id: control.control_id });
              onClose();
            }}
          >
            Show the findings for this control
          </Button>
        )}
      </div>
    </Drawer>
  );
}

function Metric({ label, value }) {
  return (
    <div className="rounded-control border border-border p-2.5 text-center">
      <div className="text-[10px] font-bold uppercase tracking-wider text-muted">{label}</div>
      <div className="mt-0.5 text-lg font-bold text-fg">{formatCount(value)}</div>
    </div>
  );
}
