import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Badge from '@/components/ui/Badge';
import Icon from '@/components/ui/Icon';
import Table, { EmptyState } from '@/components/ui/Table';
import { PageLoading } from '@/components/ui/Loading';
import CloudSection from '../CloudSection';
import { Stat } from './SecurityPanels';
import { useRansomware } from '../../hooks/useSecurityCenter';
import { formatCount } from '../../utils/securityModel';

/**
 * Ransomware resilience — a configuration review, and the page says so twice.
 *
 * The heading, the banner and the API field all call this a resilience posture
 * rather than ransomware protection, because nothing here inspects a file, a
 * process or a signature. Letting a customer believe otherwise would be the
 * single most damaging thing this view could do.
 *
 * The other deliberate choice is the absence of a score. Four of the seven
 * controls — immutable retention, MFA delete, backup, restore testing — are
 * collected by no scanner on any provider, and they are the ones that most
 * decide how a real incident ends. Averaging the three that ARE assessed into
 * a percentage would produce a reassuring number built mostly from silence.
 * The counts are shown instead, with NOT_ASSESSED styled as a gap rather than
 * as a pass.
 */

const STATE_TONE = {
  FAILING: 'danger',
  UNDETERMINED: 'warning',
  NOT_ASSESSED: 'neutral',
  HOLDING: 'success',
};

const STATE_ICON = {
  FAILING: 'close',
  UNDETERMINED: 'help',
  NOT_ASSESSED: 'ban',
  HOLDING: 'check',
};

export default function RansomwarePanel({ accountId, enabled = true }) {
  const navigate = useNavigate();
  const { data, isLoading, isError, error } = useRansomware(accountId, enabled);
  const [onlyFailing, setOnlyFailing] = useState(true);

  const rows = useMemo(() => {
    const all = data?.resources || [];
    return onlyFailing ? all.filter((r) => r.failing > 0) : all;
  }, [data, onlyFailing]);

  if (isLoading) return <PageLoading title="Reading recovery controls…" minHeight={220} />;
  if (isError) {
    return (
      <CloudSection>
        <EmptyState
          icon="alert"
          title="Resilience posture unavailable"
          body={error?.response?.data?.detail
            || 'The request failed. This is a load error, not a clean result.'}
        />
      </CloudSection>
    );
  }
  if (!data) return null;

  const controls = data.controls || [];
  const totals = data.control_totals || {};

  return (
    <div className="space-y-4">
      {/* ── What this is ───────────────────────────────────────────────────── */}
      <div className="flex items-start gap-2 rounded-control border border-info-soft bg-info-soft p-3 text-xs text-info-fg">
        <Icon name="info" size={15} className="mt-0.5 shrink-0" />
        <div>
          <p className="font-semibold">This is a configuration review, not malware detection.</p>
          <p className="mt-1 leading-relaxed">{data.disclaimer}</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3.5 lg:grid-cols-4">
        <Stat label="Data stores" value={data.data_stores} tone="bg-info-soft text-info-fg" icon="database" />
        <Stat
          label="With a failing control"
          value={data.stores_with_a_failing_control}
          tone="bg-danger-soft text-danger-fg"
          icon="alert"
        />
        <Stat
          label="Controls assessed"
          value={data.assessable_controls}
          tone="bg-success-soft text-success-fg"
          icon="check"
        />
        <Stat
          label="Controls not assessable"
          value={data.unassessable_controls}
          tone="bg-warning-soft text-warning-fg"
          icon="ban"
        />
      </div>

      {/* ── Why there is no score ──────────────────────────────────────────── */}
      <div className="flex items-start gap-2 rounded-control border border-warning-soft bg-warning-soft p-3 text-xs text-warning-fg">
        <Icon name="help" size={15} className="mt-0.5 shrink-0" />
        <div>
          <p className="font-semibold">No resilience score is produced.</p>
          <p className="mt-1 leading-relaxed">{data.no_score_note}</p>
        </div>
      </div>

      {/* ── Control summary ────────────────────────────────────────────────── */}
      <CloudSection
        title="Recovery controls"
        description="Each control, what it defends against, and how many data stores it holds on."
      >
        <div className="space-y-2.5">
          {controls.map((c) => {
            const t = totals[c.control_id] || {};
            const assessable = (c.assessed_by || []).length > 0;
            return (
              <div
                key={c.control_id}
                className={`rounded-control border p-3 ${
                  assessable ? 'border-border bg-raised' : 'border-warning-soft bg-warning-soft/30'
                }`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] font-medium text-fg">{c.title}</span>
                  {!assessable && (
                    <Badge tone="warning" size="xs">Not assessable</Badge>
                  )}
                  {(data.state_order || []).map((s) => (
                    t[s] ? (
                      <Badge key={s} tone={STATE_TONE[s]} size="xs">
                        <Icon name={STATE_ICON[s]} size={10} className="mr-0.5 inline" />
                        {data.state_labels?.[s]}: {formatCount(t[s])}
                      </Badge>
                    ) : null
                  ))}
                </div>
                <p className="mt-1.5 text-micro leading-relaxed text-muted">{c.why}</p>
                {c.not_assessable_reason && (
                  <p className="mt-1.5 border-l-2 border-warning-soft pl-2 text-micro leading-relaxed text-warning-fg">
                    {c.not_assessable_reason}
                  </p>
                )}
                {assessable && (
                  <p className="mt-1.5 text-micro text-subtle">
                    Assessed by: {c.assessed_by.join(', ')}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </CloudSection>

      {/* ── Per data store ─────────────────────────────────────────────────── */}
      <CloudSection
        title={`Data stores (${rows.length}${onlyFailing ? ` of ${data.data_stores}` : ''})`}
        description="A failing control is actionable today. 'Not assessed' is a gap in what this product can see — it is not a pass."
        action={
          <button
            type="button"
            onClick={() => setOnlyFailing((v) => !v)}
            className={`rounded-control border px-2 py-1 text-micro transition-colors ${
              onlyFailing
                ? 'border-accent bg-accent-soft text-accent-text'
                : 'border-border text-muted hover:border-accent hover:text-accent'
            }`}
          >
            {onlyFailing ? 'Showing failing only' : 'Show failing only'}
          </button>
        }
      >
        {rows.length === 0 ? (
          <EmptyState
            icon={data.data_stores ? 'shield-check' : 'database'}
            title={data.data_stores ? 'No data store has a failing control' : 'No data stores'}
            body={
              data.data_stores
                ? `None of the ${data.data_stores} data store(s) fails an assessed control. `
                  + `${data.unassessable_controls} control(s) could not be assessed at all, so this is not a complete bill of health.`
                : 'This account has no storage or database resources.'
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <Table
              columns={[
                { key: 'resource', label: 'Data store' },
                ...controls.map((c) => ({ key: c.control_id, label: c.title })),
              ]}
              rows={rows.map((r) => ({
                key: r.resource_id || r.resource_key,
                onClick: r.resource_id
                  ? () => navigate(`/cloud/resources/${r.resource_id}`)
                  : undefined,
                cells: {
                  resource: (
                    <div>
                      <div className="text-fg">{r.resource_name || r.resource_key}</div>
                      <div className="text-micro text-subtle">{r.resource_type}</div>
                    </div>
                  ),
                  ...Object.fromEntries(controls.map((c) => {
                    const st = r.controls[c.control_id] || {};
                    return [c.control_id, (
                      <Badge
                        tone={STATE_TONE[st.state] || 'neutral'}
                        size="xs"
                        title={st.reason || st.label}
                      >
                        <Icon name={STATE_ICON[st.state] || 'circle'} size={10} className="mr-0.5 inline" />
                        {st.label}
                      </Badge>
                    )];
                  })),
                },
              }))}
            />
          </div>
        )}
      </CloudSection>
    </div>
  );
}
