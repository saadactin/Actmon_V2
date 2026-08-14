import { useState, useEffect } from 'react';
import { ShieldAlert, AlertTriangle } from 'lucide-react';
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

export const AlertsPage = ({ embedded = false }) => {
  const [allAlerts, setAllAlerts] = useState([]);
  const [loading, setLoading] = useState(true);

  // The alerts endpoint returns every account's alerts; narrow to the scope so
  // this tab agrees with the provider selected in the chooser.
  const scope = useCloudScope();
  const alerts = scope.filterByScope(allAlerts);
  const setAlerts = setAllAlerts;

  const fetchAlerts = async () => {
    try {
      const res = await fetch('/api/v1/cloud/alerts');
      if (res.ok) {
        const data = await res.json();
        setAlerts(Array.isArray(data) ? data : (data?.alerts ?? []));
      }
    } catch (err) {
      console.error('Failed to fetch alerts', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAlerts();
    const interval = setInterval(fetchAlerts, 10000); // Polling every 10s
    return () => clearInterval(interval);
  }, []);

  const handleMarkRead = async (id) => {
    try {
      await fetch(`/api/v1/cloud/alerts/${id}/read`, { method: 'POST' });
      fetchAlerts();
    } catch (err) {
      console.error(err);
    }
  };

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
      ) : alerts.length === 0 ? (
        <div className="rounded-card border border-border bg-surface py-12">
          <EmptyState
            icon="check"
            title="No alerts"
            body="Real-time anomaly detection alerts will appear here."
          />
        </div>
      ) : (
        <div className="space-y-4">
          {alerts.map((alert) => {
            const isCritical = alert.severity === 'CRITICAL';
            return (
              <div
                key={alert.id}
                className={`flex items-start gap-4 rounded-card border border-border bg-surface p-5 border-l-4 ${isCritical ? 'border-l-danger' : 'border-l-warning'} ${alert.is_read ? 'opacity-70' : ''}`}
              >
                <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-control ${isCritical ? 'bg-danger-soft text-danger-fg' : 'bg-warning-soft text-warning-fg'}`}>
                  {isCritical ? <ShieldAlert size={20} /> : <AlertTriangle size={20} />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-3">
                    <h3 className="text-[15px] font-semibold text-fg">{alert.anomaly_type}</h3>
                    <span className="whitespace-nowrap text-xs text-muted">
                      {new Date(alert.created_at).toLocaleString()}
                    </span>
                  </div>
                  <p className="mt-1.5 text-sm leading-relaxed text-muted">
                    {alert.details}
                  </p>
                  <div className="mt-3 flex items-center gap-3">
                    <Badge tone={SEVERITY_TONE[alert.severity] || SEVERITY_TONE.INFO}>
                      {alert.severity}
                    </Badge>
                    {alert.simulated === true && (
                      <Badge tone="warning">Simulated</Badge>
                    )}
                    {!alert.is_read && (
                      <button
                        onClick={() => handleMarkRead(alert.id)}
                        className="text-sm font-semibold text-accent-text hover:text-accent-hover"
                      >
                        Mark as read
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
};
