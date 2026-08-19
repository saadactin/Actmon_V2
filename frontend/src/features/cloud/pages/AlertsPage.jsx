import { useState, useEffect, useCallback } from 'react';
import { ShieldAlert, AlertTriangle, CheckCircle2, Repeat } from 'lucide-react';
import { useCloudScope } from '../hooks/useCloudScope';
import CloudPageHeader from '../components/CloudPageHeader';
import Badge from '@/components/ui/Badge';
import { PageLoading } from '@/components/ui/Loading';
import { EmptyState } from '@/components/ui/Table';

const SEVERITY_TONE = {
  CRITICAL: 'danger',
  HIGH: 'danger',
  MEDIUM: 'warning',
  LOW: 'info',
  INFO: 'neutral',
};

const STATE_TONE = {
  OPEN: 'danger',
  ACKNOWLEDGED: 'warning',
  RESOLVED: 'success',
};

// "Active" is the default view: an acknowledged alert is still a live problem,
// so acknowledging must not make it vanish from the list you are working through.
const FILTERS = [
  { key: 'ACTIVE', label: 'Active', states: ['OPEN', 'ACKNOWLEDGED'] },
  { key: 'OPEN', label: 'Open', states: ['OPEN'] },
  { key: 'ACKNOWLEDGED', label: 'Acknowledged', states: ['ACKNOWLEDGED'] },
  { key: 'RESOLVED', label: 'Resolved', states: ['RESOLVED'] },
];

export const AlertsPage = ({ embedded = false }) => {
  const [allAlerts, setAllAlerts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('ACTIVE');
  const [busyId, setBusyId] = useState(null);

  // The alerts endpoint returns every account's alerts; narrow to the scope so
  // this tab agrees with the provider selected in the chooser.
  const scope = useCloudScope();
  const scoped = scope.filterByScope(allAlerts);

  const fetchAlerts = useCallback(async () => {
    try {
      // Always pull resolved ones too, so the state counts below are accurate and
      // switching filters needs no refetch.
      const res = await fetch('/api/v1/cloud/alerts?include_resolved=true');
      if (res.ok) {
        const data = await res.json();
        setAllAlerts(Array.isArray(data) ? data : (data?.alerts ?? []));
      }
    } catch (err) {
      console.error('Failed to fetch alerts', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAlerts();
    const interval = setInterval(fetchAlerts, 10000); // Polling every 10s
    return () => clearInterval(interval);
  }, [fetchAlerts]);

  const act = async (id, action) => {
    setBusyId(id);
    try {
      const res = await fetch(`/api/v1/cloud/alerts/${id}/${action}`, { method: 'POST' });
      if (!res.ok) throw new Error(`${action} failed: ${res.status}`);
      await fetchAlerts();
    } catch (err) {
      console.error(err);
    } finally {
      setBusyId(null);
    }
  };

  const countFor = (states) => scoped.filter((a) => states.includes(a.state ?? 'OPEN')).length;
  const activeStates = FILTERS.find((f) => f.key === filter)?.states ?? [];
  const alerts = scoped.filter((a) => activeStates.includes(a.state ?? 'OPEN'));

  return (
    <>
      {!embedded && (
        <CloudPageHeader
          backTo="/cloud"
          icon="bell"
          title="Real-Time Alerts"
          description="In-app anomaly detection and security incident alerts."
        />
      )}

      {loading ? (
        <PageLoading title="Loading alerts…" />
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <span className="mr-1 text-[11px] font-bold tracking-wider text-subtle uppercase">
              State
            </span>
            {FILTERS.map((f) => {
              const n = countFor(f.states);
              const active = filter === f.key;
              return (
                <button
                  key={f.key}
                  onClick={() => setFilter(f.key)}
                  disabled={n === 0 && !active}
                  className={`inline-flex items-center gap-1.5 rounded-control border px-3 py-1.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                    active
                      ? 'border-accent bg-accent-soft text-accent-text'
                      : 'border-border bg-surface text-muted hover:text-fg'
                  }`}
                >
                  {f.label}
                  <span className="rounded-full bg-neutral-soft px-1.5 text-[10px] text-muted">
                    {n}
                  </span>
                </button>
              );
            })}
          </div>

          {alerts.length === 0 ? (
            <div className="rounded-card border border-border bg-surface py-12">
              <EmptyState
                icon="check"
                title={filter === 'RESOLVED' ? 'Nothing resolved yet' : 'No alerts'}
                body={
                  filter === 'ACTIVE' || filter === 'OPEN'
                    ? 'Real-time anomaly detection alerts will appear here.'
                    : 'No alerts in this state.'
                }
              />
            </div>
          ) : (
            <div className="space-y-4">
              {alerts.map((alert) => {
                const state = alert.state ?? 'OPEN';
                const isResolved = state === 'RESOLVED';
                const isCritical = alert.severity === 'CRITICAL';
                const busy = busyId === alert.id;
                const accent = isResolved
                  ? 'border-l-success'
                  : isCritical
                    ? 'border-l-danger'
                    : 'border-l-warning';
                return (
                  <div
                    key={alert.id}
                    className={`flex items-start gap-4 rounded-card border border-border bg-surface p-5 border-l-4 ${accent} ${isResolved ? 'opacity-70' : ''}`}
                  >
                    <div
                      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-control ${
                        isResolved
                          ? 'bg-success-soft text-success-fg'
                          : isCritical
                            ? 'bg-danger-soft text-danger-fg'
                            : 'bg-warning-soft text-warning-fg'
                      }`}
                    >
                      {isResolved ? (
                        <CheckCircle2 size={20} />
                      ) : isCritical ? (
                        <ShieldAlert size={20} />
                      ) : (
                        <AlertTriangle size={20} />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-3">
                        <h3 className="text-[15px] font-semibold text-fg">
                          {alert.anomaly_type}
                        </h3>
                        <span className="whitespace-nowrap text-xs text-muted">
                          {new Date(alert.created_at).toLocaleString()}
                        </span>
                      </div>
                      <p className="mt-1.5 text-sm leading-relaxed text-muted">
                        {alert.details}
                      </p>
                      <div className="mt-3 flex flex-wrap items-center gap-3">
                        <Badge tone={SEVERITY_TONE[alert.severity] || SEVERITY_TONE.INFO}>
                          {alert.severity}
                        </Badge>
                        <Badge tone={STATE_TONE[state] || 'neutral'}>{state}</Badge>
                        {alert.simulated === true && <Badge tone="warning">Simulated</Badge>}
                        {/* A repeat count distinguishes a one-off blip from a fault
                            that has persisted across many scans. */}
                        {alert.occurrence_count > 1 && (
                          <span
                            className="inline-flex items-center gap-1 text-xs text-muted"
                            title={
                              alert.last_seen_at
                                ? `Last seen ${new Date(alert.last_seen_at).toLocaleString()}`
                                : undefined
                            }
                          >
                            <Repeat size={12} />
                            seen {alert.occurrence_count}×
                          </span>
                        )}
                        {alert.resource_name && (
                          <span className="truncate text-xs text-subtle">
                            {alert.resource_name}
                            {alert.resource_type ? ` · ${alert.resource_type}` : ''}
                          </span>
                        )}

                        {state === 'OPEN' && (
                          <button
                            onClick={() => act(alert.id, 'acknowledge')}
                            disabled={busy}
                            className="text-sm font-semibold text-accent-text hover:text-accent-hover disabled:opacity-50"
                          >
                            Acknowledge
                          </button>
                        )}
                        {!isResolved && (
                          <button
                            onClick={() => act(alert.id, 'resolve')}
                            disabled={busy}
                            className="text-sm font-semibold text-accent-text hover:text-accent-hover disabled:opacity-50"
                          >
                            Resolve
                          </button>
                        )}
                        {isResolved && alert.resolved_at && (
                          <span className="text-xs text-subtle">
                            resolved {new Date(alert.resolved_at).toLocaleString()}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </>
  );
};
