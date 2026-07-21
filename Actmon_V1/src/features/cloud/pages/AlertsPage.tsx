import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Bell, Settings, Send, CheckCircle, AlertTriangle, ShieldAlert } from 'lucide-react';

export const AlertsPage = () => {
  const navigate = useNavigate();
  const [alerts, setAlerts] = useState<any[]>([]);
  const [simulating, setSimulating] = useState(false);
  const [loading, setLoading] = useState(true);

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

  const handleSimulate = async () => {
    setSimulating(true);
    try {
      const res = await fetch(`/api/v1/cloud/alerts/simulate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          anomaly_type: "Unusual GPU Instance Sprawl",
          details: "A massive p4d.24xlarge ($2,000/mo) instance was just spun up in us-east-1 outside of approved infrastructure provisioning windows.",
          severity: "CRITICAL"
        })
      });
      if (res.ok) {
        fetchAlerts();
      }
    } catch (err) {
      console.error(err);
    } finally {
      setSimulating(false);
    }
  };

  const handleMarkRead = async (id: string) => {
    try {
      await fetch(`/api/v1/cloud/alerts/${id}/read`, { method: 'POST' });
      fetchAlerts();
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div style={PAGE_STYLE}>
      <div style={{ maxWidth: 1000, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 32 }}>
        <div>
          <button 
            onClick={() => navigate('/cloud')} 
            style={{ background: 'transparent', border: 'none', color: '#94a3b8', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, padding: 0 }}
          >
            <ArrowLeft size={16} /> Cloud Control Center
          </button>
          <h1 style={{ margin: '8px 0 0', fontSize: 28, fontWeight: 800, color: '#1e293b', letterSpacing: -0.5, display: 'flex', alignItems: 'center', gap: 10 }}>
            🚨 Real-Time Alerts
          </h1>
          <p style={{ margin: '6px 0 0', color: '#64748b', fontSize: 14 }}>
            In-app anomaly detection and security incident alerts.
          </p>
        </div>
        <button 
          onClick={handleSimulate}
          disabled={simulating}
          style={{
            padding: '10px 16px', background: 'rgba(245,158,11,0.15)', color: '#f59e0b',
            border: '1px solid rgba(245,158,11,0.3)', borderRadius: 8, fontWeight: 600, cursor: simulating ? 'not-allowed' : 'pointer',
            display: 'flex', alignItems: 'center', gap: 8, transition: 'all 0.2s', fontSize: 13
          }}
        >
          <Send size={16} /> {simulating ? 'Simulating...' : 'Simulate Anomaly'}
        </button>
      </div>

      <div style={{
        background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: 12, padding: 24, minHeight: 400
      }}>
        {loading ? (
          <div style={{ color: '#94a3b8', textAlign: 'center', marginTop: 40 }}>Loading alerts...</div>
        ) : alerts.length === 0 ? (
          <div style={{ color: '#94a3b8', textAlign: 'center', marginTop: 80, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <Bell size={48} style={{ opacity: 0.2, marginBottom: 16 }} />
            <div style={{ fontSize: 16, fontWeight: 600, color: '#475569' }}>No alerts yet</div>
            <div style={{ fontSize: 13, marginTop: 4 }}>You will see anomalies and critical issues here.</div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {alerts.map((alert) => (
              <div key={alert.id} style={{
                background: alert.is_read ? 'rgba(0,0,0,0.15)' : 'rgba(239,68,68,0.05)',
                border: `1px solid ${alert.is_read ? '#e2e8f0' : 'rgba(239,68,68,0.2)'}`,
                borderLeft: `4px solid ${alert.severity === 'CRITICAL' ? '#ef4444' : '#f59e0b'}`,
                borderRadius: 8, padding: 20, display: 'flex', gap: 16, alignItems: 'flex-start'
              }}>
                <div style={{ color: alert.severity === 'CRITICAL' ? '#ef4444' : '#f59e0b', marginTop: 2 }}>
                  {alert.severity === 'CRITICAL' ? <ShieldAlert size={24} /> : <AlertTriangle size={24} />}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <h3 style={{ margin: 0, color: '#1e293b', fontSize: 16, fontWeight: 700 }}>{alert.anomaly_type}</h3>
                    <span style={{ fontSize: 12, color: '#64748b' }}>
                      {new Date(alert.created_at).toLocaleString()}
                    </span>
                  </div>
                  <p style={{ margin: '8px 0 16px 0', color: '#94a3b8', fontSize: 14, lineHeight: 1.5 }}>
                    {alert.details}
                  </p>
                  <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                    <span style={{
                      padding: '4px 8px', background: alert.severity === 'CRITICAL' ? 'rgba(239,68,68,0.15)' : 'rgba(245,158,11,0.15)',
                      color: alert.severity === 'CRITICAL' ? '#ef4444' : '#f59e0b', borderRadius: 4, fontSize: 11, fontWeight: 700, letterSpacing: 0.5
                    }}>
                      {alert.severity}
                    </span>
                    {!alert.is_read && (
                      <button 
                        onClick={() => handleMarkRead(alert.id)}
                        style={{ background: 'transparent', border: 'none', color: '#3b82f6', fontSize: 13, fontWeight: 600, cursor: 'pointer', padding: 0 }}
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
    </div>
  );
};

const PAGE_STYLE: React.CSSProperties = {
  minHeight: '100%',
  background: '#f1f5f9',
  padding: '28px 32px',
  fontFamily: "'Inter', -apple-system, sans-serif",
};
