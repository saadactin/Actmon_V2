import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Badge from '@/components/ui/Badge';
import Icon from '@/components/ui/Icon';
import Table, { EmptyState } from '@/components/ui/Table';
import { PageLoading } from '@/components/ui/Loading';
import CloudSection from '../CloudSection';
import { Stat } from './SecurityPanels';
import { useIncidents, useThreats } from '../../hooks/useSecurityCenter';
import { formatCount, formatDateTime, severityTone } from '../../utils/securityModel';

/**
 * Threat detections and correlated incidents.
 *
 * Two things on this page are deliberately prominent because they are the ones
 * a security product usually gets wrong.
 *
 * **Unavailable detectors are listed, not hidden.** `source_location` is empty
 * on every event collected here, so impossible-travel can never fire. A panel
 * that rendered that as part of a clean result would be lying by omission, so
 * the detector appears with its reason and the missing field named.
 *
 * **Nothing here accuses anyone.** A detection is a pattern match over recorded
 * events: `CreateUser` → `CreateAccessKey` → `AttachUserPolicy` is both the
 * canonical persistence sequence and ordinary onboarding. The row shows the
 * shape and the events; the operator supplies the judgement. The same applies
 * to incidents, which state the field they were joined on so a spurious
 * grouping can be recognised and dismissed.
 */

const SIGNAL_ICON = {
  finding: 'shield',
  detection: 'activity',
  attack_path: 'route',
  exposure: 'globe',
};

function DetectionRow({ detection }) {
  const [open, setOpen] = useState(false);
  const d = detection;
  return (
    <div className="rounded-control border border-border bg-raised">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start gap-2.5 p-3 text-left"
      >
        <Icon
          name={open ? 'chevron-down' : 'chevron-right'}
          size={14}
          className="mt-0.5 shrink-0 text-subtle"
        />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={severityTone(d.severity)}>{d.severity}</Badge>
            <span className="text-[13px] font-medium text-fg">{d.title}</span>
            {d.occurrences > 1 && (
              <Badge tone="outline" size="xs">{d.occurrences} occurrences</Badge>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-muted">
            <span className="flex items-center gap-1">
              <Icon name="user" size={11} />
              {d.actor_name || d.actor_id || 'unknown principal'}
              {d.actor_type && <span className="text-subtle">({d.actor_type})</span>}
            </span>
            <span>{formatCount(d.event_count)} events</span>
            <span>{formatDateTime(d.first_seen)} → {formatDateTime(d.last_seen)}</span>
          </div>
        </div>
      </button>

      {open && (
        <div className="space-y-3 border-t border-border p-3">
          <div className="rounded-control border border-info-soft bg-info-soft p-2.5 text-micro leading-relaxed text-info-fg">
            {d.not_an_accusation}
          </div>
          <div>
            <h4 className="mb-1 text-micro font-semibold uppercase tracking-wide text-subtle">
              Why this pattern is reported
            </h4>
            <p className="text-micro leading-relaxed text-muted">{d.rationale}</p>
          </div>
          <div>
            <h4 className="mb-1 text-micro font-semibold uppercase tracking-wide text-subtle">
              What to do
            </h4>
            <p className="text-micro leading-relaxed text-muted">{d.recommended_action}</p>
          </div>

          {d.evidence?.stages && (
            <div>
              <h4 className="mb-1.5 text-micro font-semibold uppercase tracking-wide text-subtle">
                Sequence
              </h4>
              <ol className="space-y-1">
                {d.evidence.stages.map((s) => (
                  <li key={s.key} className="flex flex-wrap items-center gap-2 text-micro">
                    <Badge tone="accent" size="xs">{s.label}</Badge>
                    <span className="font-mono text-fg">{s.event_name}</span>
                    <span className="text-subtle">{formatDateTime(s.at)}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}

          {d.evidence?.occurrence_windows?.length > 1 && (
            <div>
              <h4 className="mb-1.5 text-micro font-semibold uppercase tracking-wide text-subtle">
                Occurrences
              </h4>
              <ul className="space-y-0.5">
                {d.evidence.occurrence_windows.map((w) => (
                  <li key={w.first_seen} className="text-micro text-muted">
                    {formatDateTime(w.first_seen)} — {formatCount(w.event_count)} events
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div>
            <h4 className="mb-1.5 text-micro font-semibold uppercase tracking-wide text-subtle">
              Contributing events ({formatCount(d.events?.length || 0)} shown)
            </h4>
            <div className="overflow-x-auto">
              <Table
                columns={[
                  { key: 'when', label: 'When' },
                  { key: 'op', label: 'Operation' },
                  { key: 'status', label: 'Status' },
                  { key: 'resource', label: 'Resource' },
                  { key: 'ip', label: 'Source IP' },
                ]}
                rows={(d.events || []).map((e, i) => ({
                  key: e.event_id || `${i}`,
                  cells: {
                    when: <span className="text-micro">{formatDateTime(e.timestamp)}</span>,
                    op: <span className="font-mono text-micro">{e.event_name}</span>,
                    status: (
                      <Badge
                        tone={['Failed', 'Denied'].includes(e.status) ? 'danger' : 'neutral'}
                        size="xs"
                      >
                        {e.status || '—'}
                      </Badge>
                    ),
                    resource: <span className="text-micro">{e.resource_name || '—'}</span>,
                    ip: <span className="font-mono text-micro">{e.source_ip || '—'}</span>,
                  },
                }))}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function IncidentRow({ incident, onResource }) {
  const [open, setOpen] = useState(false);
  const i = incident;
  return (
    <div className="rounded-control border border-border bg-raised">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start gap-2.5 p-3 text-left"
      >
        <Icon
          name={open ? 'chevron-down' : 'chevron-right'}
          size={14}
          className="mt-0.5 shrink-0 text-subtle"
        />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={severityTone(i.severity)}>{i.severity}</Badge>
            <span className="text-[13px] font-medium text-fg">
              {i.subject_name || i.subject_id}
            </span>
            <span className="text-meta text-subtle">{i.subject_type}</span>
            {i.signal_kinds.map((k) => (
              <Badge key={k} tone="outline" size="xs">
                <Icon name={SIGNAL_ICON[k] || 'circle'} size={10} className="mr-0.5 inline" />
                {k.replace('_', ' ')}
              </Badge>
            ))}
          </div>
          <p className="text-meta text-muted">{i.summary}</p>
        </div>
      </button>

      {open && (
        <div className="space-y-3 border-t border-border p-3">
          <div className="rounded-control border border-info-soft bg-info-soft p-2.5 text-micro leading-relaxed text-info-fg">
            <p className="font-semibold">Grouped on: {i.correlation_basis}</p>
            <p className="mt-1">{i.correlation_meaning}</p>
            <p className="mt-1">{i.not_causal}</p>
          </div>

          {i.subject_kind === 'resource' && (
            <button
              type="button"
              onClick={() => onResource(i.subject_id)}
              className="inline-flex items-center gap-1 rounded-control border border-border px-2 py-1 text-micro text-muted transition-colors hover:border-accent hover:text-accent"
            >
              <Icon name="external" size={11} />
              Open resource
            </button>
          )}

          <div>
            <h4 className="mb-1.5 text-micro font-semibold uppercase tracking-wide text-subtle">
              {i.timeline_available ? 'Timeline' : 'Signals'}
            </h4>
            {!i.timeline_available && (
              <p className="mb-1.5 text-micro leading-relaxed text-warning-fg">
                {i.timeline_note}
              </p>
            )}
            <ul className="space-y-1.5">
              {(i.timeline_available ? i.timeline : i.signals).map((s, n) => (
                <li
                  key={`${s.kind}-${s.ref || n}`}
                  className="rounded-control border border-border bg-surface p-2"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={severityTone(s.severity)} size="xs">{s.severity}</Badge>
                    <Icon name={SIGNAL_ICON[s.kind] || 'circle'} size={11} className="text-subtle" />
                    <span className="text-micro font-medium text-fg">{s.title}</span>
                    {s.at && <span className="text-micro text-subtle">{formatDateTime(s.at)}</span>}
                  </div>
                  {s.detail && (
                    <p className="mt-0.5 font-mono text-micro text-subtle">{s.detail}</p>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

export default function ThreatsPanel({ accountId, enabled = true }) {
  const navigate = useNavigate();
  const threats = useThreats(accountId, 30, enabled);
  const incidents = useIncidents(accountId, 30, enabled);

  if (threats.isLoading || incidents.isLoading) {
    return <PageLoading title="Correlating events and findings…" minHeight={220} />;
  }
  if (threats.isError) {
    return (
      <CloudSection>
        <EmptyState
          icon="alert"
          title="Threat detection unavailable"
          body={threats.error?.response?.data?.detail
            || 'The request failed. This is a load error, not a clean result.'}
        />
      </CloudSection>
    );
  }

  const t = threats.data;
  const inc = incidents.data;
  if (!t) return null;

  const unavailable = (t.unavailable_detectors || [])
    .map((id) => ({ id, ...(t.availability?.[id] || {}) }));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3.5 lg:grid-cols-4">
        <Stat label="Detections" value={t.total} tone="bg-warning-soft text-warning-fg" icon="activity" />
        <Stat label="Incidents" value={inc?.total ?? '—'} tone="bg-danger-soft text-danger-fg" icon="layers" />
        <Stat label="Events analysed" value={t.events_considered} tone="bg-info-soft text-info-fg" icon="logs" />
        <Stat
          label="Detectors unavailable"
          value={unavailable.length}
          tone="bg-neutral-soft text-muted"
          icon="help"
        />
      </div>

      {/* ── What could not be detected at all ──────────────────────────────── */}
      {unavailable.length > 0 && (
        <div className="flex items-start gap-2 rounded-control border border-warning-soft bg-warning-soft p-3 text-xs text-warning-fg">
          <Icon name="help" size={15} className="mt-0.5 shrink-0" />
          <div className="min-w-0">
            <p className="font-semibold">
              {unavailable.length} detector
              {unavailable.length === 1 ? '' : 's'} could not run at all.
            </p>
            <ul className="mt-1 space-y-1">
              {unavailable.map((u) => (
                <li key={u.id} className="leading-relaxed">
                  <span className="font-medium">
                    {t.detectors?.find((d) => d.detector_id === u.id)?.title || u.id}
                  </span>
                  {' — '}{u.reason}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {t.events_without_actor > 0 && (
        <div className="flex items-start gap-2 rounded-control border border-info-soft bg-info-soft p-3 text-xs text-info-fg">
          <Icon name="info" size={15} className="mt-0.5 shrink-0" />
          <span className="leading-relaxed">{t.events_without_actor_note}</span>
        </div>
      )}

      {/* ── Incidents ──────────────────────────────────────────────────────── */}
      <CloudSection
        title={`Correlated incidents (${inc?.total ?? 0})`}
        description={inc?.method}
      >
        {!inc || inc.total === 0 ? (
          <EmptyState
            icon="shield-check"
            title="No correlated incident"
            body={inc?.empty_means
              || 'No subject carried two different kinds of signal.'}
          />
        ) : (
          <div className="space-y-2">
            {inc.incidents.map((i) => (
              <IncidentRow
                key={i.incident_id}
                incident={i}
                onResource={(id) => navigate(`/cloud/resources/${id}`)}
              />
            ))}
          </div>
        )}
      </CloudSection>

      {/* ── Detections ─────────────────────────────────────────────────────── */}
      <CloudSection
        title={`Behavioural detections (${t.total})`}
        description={`Patterns matched over ${formatCount(t.events_considered)} events in the last ${t.window_days} days. A detection is not an accusation.`}
      >
        {t.total === 0 ? (
          <EmptyState icon="shield-check" title="No pattern matched" body={t.empty_means} />
        ) : (
          <div className="space-y-2">
            {t.detections.map((d) => (
              <DetectionRow key={d.detection_id} detection={d} />
            ))}
          </div>
        )}
      </CloudSection>

      {/* ── The detector catalogue ─────────────────────────────────────────── */}
      <CloudSection
        title="Detectors"
        description="What this engine looks for, and what each one needs in order to run."
      >
        <div className="overflow-x-auto">
          <Table
            columns={[
              { key: 'name', label: 'Detector' },
              { key: 'sev', label: 'Severity' },
              { key: 'rule', label: 'Pattern' },
              { key: 'state', label: 'State' },
            ]}
            rows={(t.detectors || []).map((d) => {
              const a = t.availability?.[d.detector_id] || {};
              return {
                key: d.detector_id,
                cells: {
                  name: <span className="text-fg">{d.title}</span>,
                  sev: <Badge tone={severityTone(d.severity)} size="xs">{d.severity}</Badge>,
                  rule: (
                    <span className="text-micro text-subtle">
                      {d.kind === 'sequence'
                        ? `${d.stages.length} stages in order, within ${d.window_minutes} min`
                        : `${d.threshold}+ events within ${d.window_minutes} min`}
                    </span>
                  ),
                  state: a.available ? (
                    <Badge tone="success" size="xs">Available</Badge>
                  ) : (
                    <Badge tone="warning" size="xs" title={a.reason}>
                      Needs {(a.missing_fields || []).join(', ') || 'events'}
                    </Badge>
                  ),
                },
              };
            })}
          />
        </div>
      </CloudSection>
    </div>
  );
}
