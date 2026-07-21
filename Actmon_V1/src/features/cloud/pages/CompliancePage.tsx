import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCloudAccounts } from '../hooks/useCloudAccounts';
import { useCloudStore } from '../state/cloudStore';
import { CloudProviderSelector } from '../components/CloudProviderSelector';
import { ArrowLeft, CheckCircle, AlertTriangle, Download, ShieldCheck } from 'lucide-react';

// We'll create a quick fetcher or use fetch directly since we don't have a hook yet.
const fetchCompliance = async (accountId: string) => {
  const res = await fetch(`http://localhost:8002/api/v1/cloud/compliance/${accountId}`);
  if (!res.ok) throw new Error("Failed to fetch compliance");
  return res.json();
};

export const CompliancePage = () => {
  const navigate = useNavigate();
  const { data: accounts } = useCloudAccounts();
  const selectedAccountId = useCloudStore(state => state.selectedAccountId);
  const setSelectedAccountId = useCloudStore(state => state.setSelectedAccountId);

  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  // Track current page per framework for pagination
  const [pages, setPages] = useState<Record<string, number>>({
    "SOC2": 0,
    "HIPAA": 0,
    "PCI-DSS": 0
  });

  const PAGE_SIZE = 5;

  const handlePageChange = (frameworkName: string, delta: number) => {
    setPages(prev => ({
      ...prev,
      [frameworkName]: Math.max(0, (prev[frameworkName] || 0) + delta)
    }));
  };

  const handleDownloadPDF = () => {
    window.print();
  };

  useEffect(() => {
    if (!selectedAccountId && accounts && accounts.length > 0) {
      setSelectedAccountId(accounts[0].id);
    }
  }, [accounts, selectedAccountId, setSelectedAccountId]);

  useEffect(() => {
    if (selectedAccountId) {
      setLoading(true);
      fetchCompliance(selectedAccountId)
        .then(res => setData(res))
        .catch(err => console.error(err))
        .finally(() => setLoading(false));
    }
  }, [selectedAccountId]);

  if (loading || !data) {
    return (
      <div style={PAGE_STYLE}>
        <div style={{ padding: 40, color: '#94a3b8', fontFamily: 'Inter, sans-serif' }}>
          Loading Compliance Data...
        </div>
      </div>
    );
  }

  const { overall_compliance_score, frameworks } = data;

  const getScoreColor = (score: number) => {
    if (score >= 90) return '#10b981'; // Green
    if (score >= 70) return '#f59e0b'; // Yellow
    return '#ef4444'; // Red
  };

  return (
    <div style={PAGE_STYLE}>
      <style>{`
        @media print {
          body * { visibility: hidden; }
          #compliance-report, #compliance-report * { visibility: visible; }
          #compliance-report { position: absolute; left: 0; top: 0; width: 100%; padding: 0 !important; }
          .no-print { display: none !important; }
          /* Ensure backgrounds print correctly */
          * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
        }
      `}</style>
      <div id="compliance-report" style={{ maxWidth: 1400, margin: '0 auto' }}>
      {/* Header */}
      <div className="no-print" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 28 }}>
        <div>
          <button 
            onClick={() => navigate('/cloud')} 
            style={{ background: 'transparent', border: 'none', color: '#94a3b8', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, padding: 0 }}
          >
            <ArrowLeft size={16} /> Cloud Control Center
          </button>
          <h1 style={{ margin: '8px 0 0', fontSize: 28, fontWeight: 800, color: '#1e293b', letterSpacing: -0.5, display: 'flex', alignItems: 'center', gap: 10 }}>
            📜 Compliance & Audit Dashboard
          </h1>
          <p style={{ margin: '6px 0 0', color: '#64748b', fontSize: 14 }}>
            Map your cloud security posture to SOC2, HIPAA, and PCI-DSS frameworks.
          </p>
        </div>

        {accounts && accounts.length > 0 && (
          <div className="no-print" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <CloudProviderSelector
              accounts={accounts}
              selected={selectedAccountId}
              onSelect={setSelectedAccountId}
            />
            <button 
              onClick={handleDownloadPDF}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '9px 16px', background: '#3b82f6', color: '#1e293b',
                border: 'none', borderRadius: 8, fontWeight: 600, cursor: 'pointer',
                transition: 'background 0.2s', fontSize: 13
              }}
            >
              <Download size={16} /> Download PDF Report
            </button>
          </div>
        )}
      </div>

      {/* Main Score Overview */}
      <div style={{ 
        background: 'linear-gradient(135deg, rgba(30,41,59,0.7) 0%, rgba(15,23,42,0.7) 100%)',
        border: '1px solid #e2e8f0',
        borderRadius: 16,
        padding: 32,
        marginBottom: 32,
        display: 'flex',
        alignItems: 'center',
        gap: 40
      }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ 
            width: 140, height: 140, borderRadius: '50%', 
            border: `8px solid ${getScoreColor(overall_compliance_score)}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexDirection: 'column',
            boxShadow: `0 0 30px ${getScoreColor(overall_compliance_score)}40`
          }}>
            <span style={{ fontSize: 42, fontWeight: 800, color: '#1e293b', lineHeight: 1 }}>{overall_compliance_score}%</span>
            <span style={{ fontSize: 12, color: '#94a3b8', marginTop: 4, fontWeight: 600, textTransform: 'uppercase' }}>Overall Score</span>
          </div>
        </div>
        <div>
          <h2 style={{ color: '#334155', fontSize: 22, margin: '0 0 12px 0', fontWeight: 700 }}>Enterprise Compliance Posture</h2>
          <p style={{ color: '#94a3b8', fontSize: 14, margin: '0 0 20px 0', maxWidth: 600, lineHeight: 1.5 }}>
            Your cloud infrastructure is continuously mapped against critical industry frameworks. 
            An overall score above 90% indicates readiness for an external compliance audit.
          </p>
          <div style={{ display: 'flex', gap: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#10b981', fontSize: 13, fontWeight: 600, background: 'rgba(16,185,129,0.1)', padding: '6px 12px', borderRadius: 20 }}>
              <ShieldCheck size={16} /> Continuous Monitoring Active
            </div>
          </div>
        </div>
      </div>

      {/* Framework Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 24 }}>
        {Object.entries(frameworks).map(([name, data]: [string, any]) => (
          <div key={name} style={{
            background: '#ffffff',
            border: '1px solid #e2e8f0',
            borderRadius: 12,
            padding: 24,
            display: 'flex',
            flexDirection: 'column'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
              <div>
                <h3 style={{ margin: 0, color: '#1e293b', fontSize: 18, fontWeight: 700 }}>{name}</h3>
                <p style={{ margin: '4px 0 0', color: '#64748b', fontSize: 12 }}>{data.total_controls} Controls Evaluated</p>
              </div>
              <div style={{ 
                background: getScoreColor(data.score) + '20', 
                color: getScoreColor(data.score),
                padding: '4px 10px',
                borderRadius: 12,
                fontSize: 14,
                fontWeight: 700
              }}>
                {data.score}%
              </div>
            </div>

            {/* Progress Bar */}
            <div style={{ height: 6, background: '#e2e8f0', borderRadius: 3, marginBottom: 20, overflow: 'hidden' }}>
              <div style={{ width: `${data.score}%`, height: '100%', background: getScoreColor(data.score), borderRadius: 3 }} />
            </div>

            <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8, color: data.failed_controls === 0 ? '#10b981' : '#f59e0b', fontSize: 13, fontWeight: 600 }}>
              {data.failed_controls === 0 ? <CheckCircle size={16} /> : <AlertTriangle size={16} />}
              {data.failed_controls === 0 ? 'All Controls Passing' : `${data.failed_controls} Controls Failing`}
            </div>

            {/* Failing Controls List */}
            {data.issues.length > 0 && (() => {
              const currentPage = pages[name] || 0;
              const totalPages = Math.ceil(data.issues.length / PAGE_SIZE);
              const paginatedIssues = data.issues.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

              return (
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                  <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8, minHeight: 330 }}>
                    {paginatedIssues.map((issue: any, idx: number) => (
                      <div key={idx} style={{ background: '#f1f5f9', padding: '10px 12px', borderRadius: 8, borderLeft: `3px solid ${issue.severity === 'CRITICAL' ? '#ef4444' : '#f59e0b'}` }}>
                        <div style={{ color: '#334155', fontSize: 12, fontWeight: 600, marginBottom: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {issue.rule}
                        </div>
                        <div style={{ color: '#94a3b8', fontSize: 11 }}>
                          {issue.affected_resource}
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Pagination Controls */}
                  {data.issues.length > PAGE_SIZE && (
                    <div className="no-print" style={{ 
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center', 
                      marginTop: 16, paddingTop: 16, borderTop: '1px solid #e2e8f0' 
                    }}>
                      <button 
                        onClick={() => handlePageChange(name, -1)}
                        disabled={currentPage === 0}
                        style={{ background: '#ffffff', border: 'none', color: currentPage === 0 ? '#475569' : '#94a3b8', padding: '4px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: currentPage === 0 ? 'not-allowed' : 'pointer' }}
                      >
                        Prev
                      </button>
                      <span style={{ fontSize: 11, color: '#64748b', fontWeight: 600 }}>
                        Page {currentPage + 1} of {totalPages}
                      </span>
                      <button 
                        onClick={() => handlePageChange(name, 1)}
                        disabled={currentPage >= totalPages - 1}
                        style={{ background: '#ffffff', border: 'none', color: currentPage >= totalPages - 1 ? '#475569' : '#94a3b8', padding: '4px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: currentPage >= totalPages - 1 ? 'not-allowed' : 'pointer' }}
                      >
                        Next
                      </button>
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
        ))}
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
