import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, CheckCircle2, AlertTriangle, ShieldAlert, Loader2 } from 'lucide-react';
import { useCloudScope } from '../hooks/useCloudScope';

const SEVERITY_PILL_CLASSES: Record<string, string> = {
  CRITICAL: 'bg-red-50 text-red-700 border-red-200',
  HIGH: 'bg-orange-50 text-orange-700 border-orange-200',
  MEDIUM: 'bg-amber-50 text-amber-700 border-amber-200',
  LOW: 'bg-blue-50 text-blue-700 border-blue-200',
  INFO: 'bg-gray-100 text-gray-600 border-gray-200',
};

export const AlertsPage = () => {
  const navigate = useNavigate();
  const [allAlerts, setAllAlerts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  // The alerts endpoint returns every account's alerts; narrow to the scope so
  // this tab agrees with the provider selected in the chooser.
  const scope = useCloudScope();
  const alerts = scope.filterByScope(allAlerts);
  const setAlerts = setAllAlerts;

  const fetchAlerts = async () => {
    try {
      const res = await fetch(`/api/v1/cloud/alerts`);
      if (res.ok) {
        const data = await res.json();
        setAlerts(Array.isArray(data) ? data : (data?.alerts ?? []));
      }
    } catch (err) {
      console.error("Failed to fetch alerts", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAlerts();
    const interval = setInterval(fetchAlerts, 10000); // Polling every 10s
    return () => clearInterval(interval);
  }, []);

  const handleMarkRead = async (id: string) => {
    try {
      await fetch(`/api/v1/cloud/alerts/${id}/read`, { method: 'POST' });
      fetchAlerts();
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div className="p-6 space-y-6">
      <div className="max-w-[1000px] mx-auto space-y-6">
        {/* Header */}
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2.5">
              <div className="p-2 rounded-lg bg-blue-50 text-blue-600">
                <Bell size={20} />
              </div>
              Real-Time Alerts
            </h1>
            <p className="text-sm text-gray-500 mt-1">
              In-app anomaly detection and security incident alerts.
            </p>
          </div>
        </div>

        {loading ? (
          <div className="flex flex-col items-center justify-center gap-3 py-24">
            <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
            <p className="text-sm text-gray-500">Loading alerts...</p>
          </div>
        ) : alerts.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm flex flex-col items-center justify-center text-center py-12 px-6">
            <CheckCircle2 size={40} className="text-green-500 mb-3" />
            <h3 className="text-base font-semibold text-gray-900">No alerts</h3>
            <p className="text-sm text-gray-500 mt-1">Real-time anomaly detection alerts will appear here.</p>
          </div>
        ) : (
          <div className="space-y-4">
            {alerts.map((alert) => (
              <div
                key={alert.id}
                className={`bg-white rounded-xl border border-gray-200 shadow-sm border-l-4 p-5 flex items-start gap-4 ${alert.severity === 'CRITICAL' ? 'border-l-red-500' : 'border-l-amber-500'} ${alert.is_read ? 'opacity-70' : ''}`}
              >
                <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${alert.severity === 'CRITICAL' ? 'bg-red-50 text-red-600' : 'bg-amber-50 text-amber-600'}`}>
                  {alert.severity === 'CRITICAL' ? <ShieldAlert size={20} /> : <AlertTriangle size={20} />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-3">
                    <h3 className="text-[15px] font-semibold text-gray-900">{alert.anomaly_type}</h3>
                    <span className="text-xs text-gray-500 whitespace-nowrap">
                      {new Date(alert.created_at).toLocaleString()}
                    </span>
                  </div>
                  <p className="text-sm text-gray-600 mt-1.5 leading-relaxed">
                    {alert.details}
                  </p>
                  <div className="flex items-center gap-3 mt-3">
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-bold uppercase tracking-wide border ${SEVERITY_PILL_CLASSES[alert.severity] || SEVERITY_PILL_CLASSES.INFO}`}>
                      {alert.severity}
                    </span>
                    {alert.simulated === true && (
                      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-bold uppercase tracking-wide border bg-amber-50 text-amber-700 border-amber-300">
                        Simulated
                      </span>
                    )}
                    {!alert.is_read && (
                      <button
                        onClick={() => handleMarkRead(alert.id)}
                        className="text-sm font-semibold text-blue-600 hover:text-blue-700"
                      >
                        Mark as read
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
