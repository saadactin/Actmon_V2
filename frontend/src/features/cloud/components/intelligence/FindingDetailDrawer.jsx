import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import cn from '@/lib/cn';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Drawer from '@/components/ui/Drawer';
import Icon from '@/components/ui/Icon';
import Textarea from '@/components/ui/Textarea';
import { PageLoading } from '@/components/ui/Loading';
import { useIntelligenceFinding, useSetIntelligenceStatus } from '../../hooks/useIntelligence';
import { relativeTime } from '../../utils/resourceModel';
import { severityTone } from '../../utils/securityModel';
import {
  ACTION_ICON, ACTION_LABEL, PROVIDER_LABEL, RESOLUTION_LABEL, SIGNAL_META, categoryMeta,
  checkMeta, confidenceMeta, lastCheckText, needsReason, resolveLinks, safetyMeta, savingsView,
  statusActions, statusMeta, timelineView,
} from '../../utils/intelligenceModel';
import { compact } from '../../utils/costFormat';
import HealthScore from './HealthScore';
import { DrawerSection, KeyValues } from './IntelligencePrimitives';
import TelemetryCharts from './TelemetryCharts';

const IMPACT_LABEL = {
  cost: 'Cost', performance: 'Performance', availability: 'Availability',
  recovery: 'Recovery', compliance: 'Compliance',
};

/**
 * One finding, answering in order: what is wrong, why, on which resource, how
 * serious, the evidence, what to change, what it will do, what it is worth,
 * what could go wrong, whether it is safe, and what happened after.
 */
export default function FindingDetailDrawer({ accountId, accountRoute, source, findingKey, onClose }) {
  const navigate = useNavigate();
  const { data: f, isLoading, isError, error } = useIntelligenceFinding(accountId, source, findingKey);
  const mutate = useSetIntelligenceStatus(accountId);
  const [draft, setDraft] = useState(null);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState(null);

  if (!findingKey) return null;
  const close = () => { setDraft(null); setReason(''); setErr(null); onClose(); };
  const links = resolveLinks(f?.links, accountRoute);
  const go = (to) => { if (to) { close(); navigate(to); } };

  const apply = async () => {
    setErr(null);
    try {
      await mutate.mutateAsync({ source, key: findingKey, status: draft, reason: reason.trim() || undefined });
      setDraft(null);
      setReason('');
    } catch (e) {
      const d = e?.response?.data?.detail;
      setErr(e?.response?.status === 403
        ? 'Your role may not make this change.'
        : (typeof d === 'string' ? d : d?.message) || e?.message || 'The update failed.');
    }
  };

  const cat = categoryMeta(f?.category);
  const isSecurity = f?.source === 'security';

  return (
    <Drawer
      open={!!findingKey}
      onClose={close}
      width={820}
      icon={cat.icon}
      title={f?.title || 'Finding'}
      subtitle={f ? [f.resource?.name || 'Account-wide', f.resource?.type, PROVIDER_LABEL[f.provider] || f.provider,
        f.resource?.region].filter(Boolean).join(' · ') : undefined}
      footer={f && (
        <div className="space-y-2">
          {draft && (
            <div className="rounded-control border border-accent-soft bg-accent-soft p-2.5">
              <p className="text-[12px] font-semibold text-accent-text">{ACTION_LABEL[draft]}</p>
              <Textarea
                rows={2}
                className="mt-1.5"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={needsReason(draft) ? 'Required — why is this being left in place?' : 'Optional note'}
              />
              {err && <p className="mt-1.5 text-meta text-danger">{err}</p>}
              <div className="mt-2 flex gap-2">
                <Button size="sm" variant="primary" loading={mutate.isPending} onClick={apply}
                  disabled={needsReason(draft) && !reason.trim()}>
                  Confirm
                </Button>
                <Button size="sm" variant="ghost" onClick={() => { setDraft(null); setErr(null); }}>Cancel</Button>
              </div>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {links.resource && <Button size="sm" icon="box" onClick={() => go(links.resource)}>View resource</Button>}
            {links.cost && <Button size="sm" icon="trend" onClick={() => go(links.cost)}>View cost</Button>}
            {links.monitoring && (
              <Button size="sm" icon="activity" onClick={() => go(links.monitoring)}>View monitoring</Button>
            )}
            {links.alert && <Button size="sm" icon="bell" onClick={() => go(links.alert)}>Create alert</Button>}
            <span className="ml-auto flex flex-wrap gap-2">
              {statusActions(f.status_group).map((s) => (
                <Button key={s} size="sm" variant={s === 'ACKNOWLEDGED' ? 'primary' : 'secondary'}
                  icon={ACTION_ICON[s]} onClick={() => { setDraft(s); setErr(null); }}>
                  {ACTION_LABEL[s]}
                </Button>
              ))}
            </span>
          </div>
        </div>
      )}
    >
      {isLoading && <PageLoading title="Loading the analysis…" minHeight={240} />}
      {isError && (
        <p className="text-[12px] text-danger">
          {error?.response?.data?.detail || error?.message || 'The finding could not be loaded.'}
        </p>
      )}
      {f && (
        <div className="space-y-5 text-sm">
          <StatusStrip f={f} />

          <DrawerSection title="Why this was detected" icon="info">
            <p className="leading-relaxed text-fg">{f.description}</p>
            {f.rationale && <p className="mt-1.5 leading-relaxed text-muted">{f.rationale}</p>}
            {lastCheckText(f.last_check) && f.status_group !== 'RESOLVED' && (
              <p className="mt-1.5 text-meta italic text-subtle">{lastCheckText(f.last_check)}</p>
            )}
          </DrawerSection>

          {!isSecurity && (
            <DrawerSection title="Current and recommended configuration" icon="settings2">
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <div>
                  <p className="mb-1 text-meta font-semibold uppercase tracking-wider text-subtle">Current</p>
                  <KeyValues rows={Object.entries(f.current_configuration || {})} />
                </div>
                <div>
                  <p className="mb-1 text-meta font-semibold uppercase tracking-wider text-subtle">Recommended</p>
                  {f.recommended_configuration
                    ? <KeyValues rows={Object.entries(f.recommended_configuration)} />
                    : (
                      <p className="rounded-control border border-dashed border-border px-2.5 py-2 text-meta text-muted">
                        No exact configuration is named — the evidence does not support one. See the
                        recommendation below for why.
                      </p>
                    )}
                </div>
              </div>
            </DrawerSection>
          )}

          {!isSecurity && (f.evidence || []).length > 0 && (
            <DrawerSection title="Evidence" icon="list">
              <KeyValues rows={(f.evidence || []).map((e) => [
                e.label,
                e.display === 'N/A' || e.value === null || e.value === undefined
                  ? <span className="text-muted">N/A</span> : e.display,
                [e.detail, e.source].filter(Boolean).join(' · ') || null,
              ])} />
            </DrawerSection>
          )}

          {isSecurity && (
            <DrawerSection title="Evidence" icon="list">
              {f.evidence_raw?._withheld ? (
                <p className="text-[12px] italic text-muted">{f.evidence_raw._withheld}</p>
              ) : (
                <pre className="max-h-72 overflow-auto rounded-control border border-border bg-sunken p-3 text-meta leading-relaxed text-fg">
                  {JSON.stringify(f.evidence_raw ?? {}, null, 2)}
                </pre>
              )}
              {f.compliance_frameworks?.length > 0 && (
                <p className="mt-2 text-meta text-muted">
                  Cited by: {f.compliance_frameworks.join(', ')}
                </p>
              )}
            </DrawerSection>
          )}

          <DrawerSection title="Utilization — last 30 days" icon="chart-line">
            <TelemetryCharts rows={f.telemetry || []} />
          </DrawerSection>

          <DrawerSection title="Cost" icon="trend">
            <CostBlock cost={f.cost} />
          </DrawerSection>

          <DrawerSection title="Recommendation" icon="sparkles">
            <p className="leading-relaxed text-fg">{f.recommendation || 'No recommendation text.'}</p>
            {f.remediation && f.remediation !== f.recommendation && (
              <p className="mt-2 whitespace-pre-wrap rounded-control border border-info-soft bg-info-soft px-2.5 py-2 text-meta leading-relaxed text-fg">
                <span className="font-semibold">How: </span>{f.remediation}
              </p>
            )}
          </DrawerSection>

          {f.impact && Object.keys(f.impact).length > 0 && (
            <DrawerSection title="Expected impact" icon="activity">
              <KeyValues rows={Object.entries(f.impact).map(([k, v]) => [IMPACT_LABEL[k] || k, v])} />
            </DrawerSection>
          )}

          {!isSecurity && (
            <DrawerSection title="Savings" icon="trend">
              <SavingsBlock savings={f.savings} />
            </DrawerSection>
          )}

          {!isSecurity && f.safety && (
            <DrawerSection title="Can I safely apply this?" icon="shield-check">
              <SafetyBlock safety={f.safety} risk={f.risk} notes={f.risk_notes} />
            </DrawerSection>
          )}

          {!isSecurity && (
            <DrawerSection title="Data confidence" icon="gauge">
              <ConfidenceBlock f={f} />
            </DrawerSection>
          )}

          {f.health && (
            <DrawerSection title="Resource health" icon="diagnose">
              <HealthScore health={f.health} />
            </DrawerSection>
          )}

          {f.outcome && (
            <DrawerSection title="What happened after" icon="history">
              <OutcomeBlock outcome={f.outcome} />
            </DrawerSection>
          )}

          <DrawerSection title="Timeline" icon="clock">
            <Timeline f={f} />
          </DrawerSection>

          {links.drift && (
            <div className="flex flex-wrap gap-2 border-t border-border pt-3">
              <Button size="sm" variant="ghost" icon="history" onClick={() => go(links.drift)}>Config changes</Button>
              <Button size="sm" variant="ghost" icon="logs" onClick={() => go(links.events)}>Audit events</Button>
              <Button size="sm" variant="ghost" icon="route" onClick={() => go(links.topology)}>View in topology</Button>
            </div>
          )}
        </div>
      )}
    </Drawer>
  );
}

function StatusStrip({ f }) {
  const status = statusMeta(f.status_group);
  const cat = categoryMeta(f.category);
  const conf = confidenceMeta(f.confidence);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Badge tone={severityTone(f.severity)}>{f.severity}</Badge>
      <Badge tone="outline"><Icon name={cat.icon} size={11} />{cat.label}</Badge>
      {f.subcategory && <Badge tone="neutral" size="xs">{f.subcategory}</Badge>}
      {f.signal && SIGNAL_META[f.signal] && <Badge tone={SIGNAL_META[f.signal].tone} size="xs">{SIGNAL_META[f.signal].label}</Badge>}
      <Badge tone={status.tone}>{f.status_label || status.label}</Badge>
      <Badge tone={conf.tone}>Confidence: {conf.label}</Badge>
      {f.source === 'security'
        ? <Badge tone="neutral" size="xs">Security Center · {f.verdict_label || f.verdict}</Badge>
        : <Badge tone="neutral" size="xs">{f.rule_id} v{f.rule_version}</Badge>}
      {f.detection_count > 1 && <Badge tone="neutral" size="xs">seen in {f.detection_count} analyses</Badge>}
    </div>
  );
}

function CostBlock({ cost }) {
  if (!cost) return null;
  const b = cost.billed;
  return (
    <div className="space-y-1.5 text-[12px]">
      {b ? (
        <p className="text-fg">
          Billed <span className="font-bold tabular-nums">{compact(b.amount, b.currency)}</span> over the last{' '}
          {b.period_days} days
          <span className="block text-meta text-subtle">{b.source}{b.service ? ` · ${b.service}` : ''}
            {b.fetched_at ? ` · fetched ${relativeTime(b.fetched_at)}` : ''}</span>
        </p>
      ) : (
        <p><span className="font-semibold text-muted">N/A. </span><span className="text-muted">{cost.reason}</span></p>
      )}
      {cost.daily_reason && <p className="text-meta text-subtle">30-day cost chart: N/A. {cost.daily_reason}</p>}
    </div>
  );
}

function SavingsBlock({ savings }) {
  const s = savings || {};
  const view = savingsView(s);
  return (
    <div className="space-y-2">
      <div className="flex items-baseline gap-2">
        <span className={cn('text-[20px] font-bold tabular-nums', view.priced ? 'text-fg' : 'text-muted')}>
          {view.text}
        </span>
        <span className="text-meta text-subtle">{view.priced ? `from the ${view.sub}` : 'not quantified'}</span>
      </div>
      {!view.priced && <p className="text-[12px] leading-relaxed text-muted">{view.reason}</p>}
      {view.priced && s.basis && <p className="text-meta leading-relaxed text-muted">{s.basis}</p>}
      {(s.breakdown || []).length > 0 && (
        <div className="overflow-hidden rounded-control border border-border">
          <table className="w-full text-meta">
            <tbody>
              {s.breakdown.map((l, i) => (
                <tr key={`${l.component}-${i}`} className="border-t border-border first:border-t-0">
                  <td className="px-2.5 py-1 text-muted">{l.component}</td>
                  <td className="px-2 py-1 text-right tabular-nums text-subtle">
                    {l.quantity !== undefined ? `${l.quantity} ${l.unit || ''}` : ''}
                    {l.unit_price !== undefined ? ` × ${l.unit_price}` : ''}
                  </td>
                  <td className="px-2.5 py-1 text-right tabular-nums text-fg">
                    {l.monthly_cost !== undefined ? `${l.monthly_cost.toLocaleString()} /mo`
                      : l.hourly_cost !== undefined ? `${l.hourly_cost} /h` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {(s.assumptions || []).length > 0 && (
        <ul className="list-disc space-y-0.5 pl-4 text-meta text-muted">
          {s.assumptions.map((a) => <li key={a}>{a}</li>)}
        </ul>
      )}
    </div>
  );
}

function SafetyBlock({ safety, risk, notes }) {
  const meta = safetyMeta(safety.verdict);
  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={meta.tone}><Icon name={meta.icon} size={11} />{meta.label}</Badge>
        <Badge tone={risk === 'HIGH' ? 'danger' : risk === 'MEDIUM' ? 'warning' : 'success'}>Risk: {risk}</Badge>
        {safety.reversible === false && <Badge tone="danger" size="xs">Not reversible</Badge>}
        {safety.reversible === true && <Badge tone="success" size="xs">Reversible</Badge>}
      </div>
      {(safety.checks || []).length > 0 && (
        <ul className="space-y-1">
          {safety.checks.map((c) => {
            const m = checkMeta(c.state);
            return (
              <li key={c.label} className="flex items-start gap-2 text-[12px]">
                <Badge tone={m.tone} size="xs"><Icon name={m.icon} size={10} />{m.label}</Badge>
                <span className="min-w-0 text-fg">
                  {c.label}
                  {c.detail && <span className="block text-meta text-subtle">{c.detail}</span>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {(notes || []).length > 0 && (
        <ul className="list-disc space-y-0.5 pl-4 text-meta text-muted">
          {notes.map((n) => <li key={n}>{n}</li>)}
        </ul>
      )}
      {(safety.preconditions || []).length > 0 && (
        <div>
          <p className="text-meta font-semibold uppercase tracking-wider text-subtle">Before applying</p>
          <ul className="mt-0.5 list-disc space-y-0.5 pl-4 text-meta text-fg">
            {safety.preconditions.map((p) => <li key={p}>{p}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

function ConfidenceBlock({ f }) {
  const conf = confidenceMeta(f.confidence);
  return (
    <div className="space-y-2">
      <p className="text-[12px] text-fg">
        <span className="font-bold">{conf.label}</span>
        {f.confidence_label ? <span className="text-muted"> — {f.confidence_label.split('—')[1] || ''}</span> : null}
      </p>
      {(f.confidence_reasons || []).length > 0 && (
        <ul className="list-disc space-y-0.5 pl-4 text-meta text-muted">
          {f.confidence_reasons.map((r) => <li key={r}>{r}</li>)}
        </ul>
      )}
      <p className="text-meta font-semibold uppercase tracking-wider text-subtle">Based on</p>
      <ul className="space-y-1">
        {(f.data_sources || []).map((d) => (
          <li key={d.key} className="flex items-start gap-2 text-[12px]">
            <Icon name={d.available ? 'check' : 'close'} size={13}
              className={cn('mt-0.5 shrink-0', d.available ? 'text-success-fg' : 'text-danger-fg')} />
            <span className="min-w-0">
              <span className={d.available ? 'text-fg' : 'text-muted'}>{d.label}</span>
              {!d.required && <span className="text-subtle"> (optional)</span>}
              {d.detail && <span className="block text-meta text-subtle">{d.detail}</span>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function OutcomeBlock({ outcome: o }) {
  return (
    <div className="space-y-2 text-[12px]">
      <p className="font-semibold text-fg">{RESOLUTION_LABEL[o.kind] || o.kind}</p>
      <p className="text-muted">{o.detail}</p>
      <p className="text-meta text-subtle">
        {o.at ? new Date(o.at).toLocaleString() : ''}{o.by ? ` · by ${o.by}` : ''}
        {o.resource_state ? ` · resource now: ${o.resource_state}` : ''}
      </p>
      {o.note && <p className="text-meta italic text-muted">{o.note}</p>}
      {(o.config_changes || []).length > 0 && (
        <div>
          <p className="text-meta font-semibold uppercase tracking-wider text-subtle">What changed</p>
          <ul className="mt-0.5 space-y-0.5">
            {o.config_changes.map((c, i) => (
              <li key={`${c.at}-${i}`} className="text-meta text-fg">
                <span className="text-subtle">{relativeTime(c.at)}: </span>
                {c.summary || `${c.field}: ${c.old ?? '—'} → ${c.new ?? '—'}`}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="rounded-control border border-border bg-sunken px-2.5 py-2 text-meta leading-relaxed text-fg">
        {o.realized}
      </p>
    </div>
  );
}

function Timeline({ f }) {
  const items = f.source === 'security'
    ? (f.security?.timeline || []).map((e) => ({ at: e.at, label: String(e.event || '').replace(/_/g, ' '), detail: e.detail }))
    : timelineView(f.history);
  if (!items.length) return <p className="text-[12px] text-muted">No recorded history.</p>;
  return (
    <ol className="space-y-2">
      {items.map((e, i) => (
        <li key={`${e.at}-${i}`} className="flex gap-2.5">
          <Icon name="dot" size={12} className="mt-1 shrink-0 text-subtle" />
          <div className="min-w-0">
            <div className="text-[12px] font-semibold capitalize text-fg">{e.label}{e.by ? ` · ${e.by}` : ''}</div>
            <div className="text-meta text-subtle">{e.at ? new Date(e.at).toLocaleString() : ''}</div>
            {e.detail && <div className="text-meta leading-relaxed text-muted">{e.detail}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}
