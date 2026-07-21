import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCloudAccounts } from '../hooks/useCloudAccounts';
import { useSecurityPosture } from '../hooks/useSecurity';
import { useCloudStore } from '../state/cloudStore';
import { CloudProviderSelector } from '../components/CloudProviderSelector';
import { Shield, ShieldAlert, ShieldCheck, AlertTriangle, Info, ArrowLeft, RefreshCw, ExternalLink, Filter } from 'lucide-react';

export const SecurityPosturePage = () => {
  const navigate = useNavigate();
  const { data: accounts } = useCloudAccounts();
  const selectedAccountId = useCloudStore(state => state.selectedAccountId);
  const setSelectedAccountId = useCloudStore(state => state.setSelectedAccountId);

  // Filters
  const [severityFilter, setSeverityFilter] = useState<string>('ALL');
  const [categoryFilter, setCategoryFilter] = useState<string>('ALL');

  useEffect(() => {
    if (!selectedAccountId && accounts && accounts.length > 0) {
      setSelectedAccountId(accounts[0].id);
    }
  }, [accounts, selectedAccountId, setSelectedAccountId]);

  const { data: posture, isLoading, isError, refetch, isRefetching } = useSecurityPosture(selectedAccountId);

  const selectedAccount = accounts?.find(a => a.id === selectedAccountId);

  if (isLoading) {
    return (
      <div style={PAGE_STYLE}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh', flexDirection: 'column', gap: 16 }}>
          <div style={SPINNER_STYLE} />
          <span style={{ color: '#94a3b8', fontSize: 15, fontWeight: 500 }}>Analyzing security configuration...</span>
        </div>
      </div>
    );
  }

  // Get color for grade
  const getGradeColor = (grade: string) => {
    switch (grade) {
      case 'A': return '#22c55e';
      case 'B': return '#10b981';
      case 'C': return '#eab308';
      case 'D': return '#f97316';
      case 'F': return '#ef4444';
      default: return '#94a3b8';
    }
  };

  // Get color for severity
  const getSeverityStyle = (sev: string) => {
    switch (sev.toUpperCase()) {
      case 'CRITICAL':
        return { bg: 'rgba(239,68,68,0.15)', fg: '#ef4444', border: 'rgba(239,68,68,0.3)' };
      case 'HIGH':
        return { bg: 'rgba(249,115,22,0.15)', fg: '#f97316', border: 'rgba(249,115,22,0.3)' };
      case 'MEDIUM':
        return { bg: 'rgba(234,179,8,0.15)', fg: '#eab308', border: 'rgba(234,179,8,0.3)' };
      case 'LOW':
        return { bg: 'rgba(59,130,246,0.15)', fg: '#3b82f6', border: 'rgba(59,130,246,0.3)' };
      case 'INFO':
      default:
        return { bg: 'rgba(148,163,184,0.15)', fg: '#94a3b8', border: 'rgba(148,163,184,0.3)' };
    }
  };

  const findings = posture?.findings || [];
  const categories = Array.from(new Set(findings.map(f => f.category)));

  const filteredFindings = findings.filter(f => {
    const fSev = f.severity.toUpperCase();
    const matchesSev = severityFilter === 'ALL' || 
      (severityFilter === 'CRITICAL' && (fSev === 'CRITICAL' || fSev === 'HIGH')) ||
      fSev === severityFilter;
    const matchesCat = categoryFilter === 'ALL' || f.category === categoryFilter;
    return matchesSev && matchesCat;
  });

  return (
    <div style={PAGE_STYLE}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 28 }}>
        <div>
          <button onClick={() => navigate('/cloud')} style={BACK_BTN}>
            <ArrowLeft size={16} /> Cloud Control Center
          </button>
          <h1 style={{ margin: '8px 0 0', fontSize: 28, fontWeight: 800, color: '#1e293b', letterSpacing: -0.5, display: 'flex', alignItems: 'center', gap: 10 }}>
            🛡️ Security Posture Scanner
          </h1>
          <p style={{ margin: '6px 0 0', color: '#64748b', fontSize: 14 }}>
            Identify misconfigurations, open ports, and IAM privilege violations
          </p>
        </div>

        {/* Account picker & scan trigger */}
        {accounts && accounts.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <CloudProviderSelector
              accounts={accounts}
              mode="single"
              selected={selectedAccountId}
              onSelect={id => id && setSelectedAccountId(id)}
            />

            <button
              onClick={() => refetch()}
              disabled={isRefetching}
              style={{
                padding: '9px 18px',
                borderRadius: 10,
                border: 'none',
                background: '#3b82f6',
                color: '#1e293b',
                fontSize: 13,
                fontWeight: 600,
                cursor: 'pointer',
                fontFamily: 'inherit',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                transition: 'all 0.2s',
                opacity: isRefetching ? 0.7 : 1,
              }}
            >
              <RefreshCw size={14} className={isRefetching ? 'animate-spin' : ''} />
              {isRefetching ? 'Scanning...' : 'Scan Now'}
            </button>
          </div>
        )}
      </div>

      {isError || !posture ? (
        <div style={CARD_STYLE}>
          <div style={{ textAlign: 'center', padding: '40px 20px' }}>
            <ShieldAlert size={48} color="#ef4444" style={{ marginBottom: 16 }} />
            <h3 style={{ margin: '0 0 8px', color: '#334155', fontSize: 18, fontWeight: 700 }}>Security Scan Unavailable</h3>
            <p style={{ margin: 0, color: '#64748b', fontSize: 14 }}>
              Unable to analyze cloud account resources. Please make sure resources have been discovered first.
            </p>
          </div>
        </div>
      ) : (
        <>
          {/* Main Dashboard Cards */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 3fr', gap: 20, marginBottom: 28 }}>
            
            {/* Health Score Gauge */}
            <div style={{
              ...CARD_STYLE,
              background: 'linear-gradient(135deg, rgba(30,41,59,0.5) 0%, rgba(15,23,42,0.6) 100%)',
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '24px 16px', textAlign: 'center',
              position: 'relative', overflow: 'hidden'
            }}>
              <div style={{
                position: 'absolute', top: -40, right: -40, width: 120, height: 120, pointerEvents: 'none',
                background: `radial-gradient(circle, ${getGradeColor(posture.grade)}11 0%, transparent 70%)`
              }} />

              <div style={{ position: 'relative', width: 140, height: 140, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {/* SVG Gauge */}
                <svg width="140" height="140" viewBox="0 0 140 140">
                  <circle cx="70" cy="70" r="58" fill="none" stroke="#e2e8f0" strokeWidth="10" />
                  <circle
                    cx="70" cy="70" r="58" fill="none"
                    stroke={getGradeColor(posture.grade)}
                    strokeWidth="10"
                    strokeDasharray="364.4"
                    strokeDashoffset={364.4 - (364.4 * posture.score) / 100}
                    strokeLinecap="round"
                    transform="rotate(-90 70 70)"
                    style={{ transition: 'stroke-dashoffset 1s ease-out' }}
                  />
                </svg>
                <div style={{ position: 'absolute', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                  <span style={{ fontSize: 36, fontWeight: 900, color: '#1e293b', lineHeight: 1 }}>{posture.score}</span>
                  <span style={{ fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 4 }}>Score</span>
                </div>
              </div>

              <div style={{ marginTop: 16 }}>
                <span style={{
                  fontSize: 12, fontWeight: 700, padding: '4px 14px', borderRadius: 20,
                  background: `${getGradeColor(posture.grade)}1a`,
                  border: `1.5px solid ${getGradeColor(posture.grade)}44`,
                  color: getGradeColor(posture.grade)
                }}>
                  Grade {posture.grade}
                </span>
              </div>
              <p style={{ color: '#64748b', fontSize: 12, marginTop: 12, marginHorizontal: 12 }}>
                {posture.score >= 90 ? 'Excellent security posture. Keep it up!' :
                 posture.score >= 70 ? 'Good overall security, but some issues need attention.' :
                 'Critical misconfigurations found. Immediate action required!'}
              </p>
            </div>

            {/* Severity Breakdown & Metrics */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {/* Severity Card grid */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14 }}>
                {[
                  { label: 'Critical / High', count: (posture.by_severity['CRITICAL'] || 0) + (posture.by_severity['HIGH'] || 0), color: '#ef4444', icon: <ShieldAlert size={20} /> },
                  { label: 'Medium', count: posture.by_severity['MEDIUM'] || 0, color: '#eab308', icon: <AlertTriangle size={20} /> },
                  { label: 'Low', count: posture.by_severity['LOW'] || 0, color: '#3b82f6', icon: <Info size={20} /> },
                  { label: 'Info', count: posture.by_severity['INFO'] || 0, color: '#94a3b8', icon: <ShieldCheck size={20} /> }
                ].map(stat => (
                  <div key={stat.label} style={{
                    ...CARD_STYLE, padding: '16px 20px', display: 'flex', alignItems: 'center', gap: 16,
                    border: `1px solid ${stat.color}15`, background: '#f8fafc'
                  }}>
                    <div style={{
                      width: 42, height: 42, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center',
                      background: `${stat.color}12`, border: `1px solid ${stat.color}25`, color: stat.color
                    }}>
                      {stat.icon}
                    </div>
                    <div>
                      <div style={{ color: '#64748b', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>{stat.label}</div>
                      <div style={{ color: '#1e293b', fontSize: 22, fontWeight: 800, marginTop: 2 }}>{stat.count}</div>
                    </div>
                  </div>
                ))}
              </div>

              {/* General details bar */}
              <div style={{ ...CARD_STYLE, padding: '18px 24px', display: 'flex', justifyContent: 'space-around', alignItems: 'center', background: '#f8fafc' }}>
                <div>
                  <span style={{ color: '#64748b', fontSize: 12 }}>Resources Scanned</span>
                  <div style={{ color: '#334155', fontSize: 18, fontWeight: 700, marginTop: 4 }}>{posture.total_resources_scanned}</div>
                </div>
                <div style={{ width: 1, height: 32, background: '#ffffff' }} />
                <div>
                  <span style={{ color: '#64748b', fontSize: 12 }}>Total Findings</span>
                  <div style={{ color: '#334155', fontSize: 18, fontWeight: 700, marginTop: 4 }}>{posture.total_findings}</div>
                </div>
                <div style={{ width: 1, height: 32, background: '#ffffff' }} />
                <div>
                  <span style={{ color: '#64748b', fontSize: 12 }}>Last Scanned</span>
                  <div style={{ color: '#334155', fontSize: 18, fontWeight: 700, marginTop: 4 }}>
                    {selectedAccount?.last_discovery ? new Date(selectedAccount.last_discovery).toLocaleString() : 'Never'}
                  </div>
                </div>
              </div>
            </div>

          </div>

          {/* Filter Bar */}
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            background: '#f8fafc', border: '1px solid #e2e8f0',
            borderRadius: 14, padding: '12px 20px', marginBottom: 20
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: '#94a3b8', fontSize: 13, fontWeight: 600 }}>
              <Filter size={16} /> Filters
            </div>
            
            <div style={{ display: 'flex', gap: 12 }}>
              {/* Severity Filter */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ color: '#64748b', fontSize: 12 }}>Severity:</span>
                <select
                  value={severityFilter}
                  onChange={(e) => setSeverityFilter(e.target.value)}
                  style={SELECT_STYLE}
                >
                  <option value="ALL">All Severities</option>
                  <option value="CRITICAL">Critical / High</option>
                  <option value="MEDIUM">Medium</option>
                  <option value="LOW">Low</option>
                  <option value="INFO">Info</option>
                </select>
              </div>

              {/* Category Filter */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ color: '#64748b', fontSize: 12 }}>Category:</span>
                <select
                  value={categoryFilter}
                  onChange={(e) => setCategoryFilter(e.target.value)}
                  style={SELECT_STYLE}
                >
                  <option value="ALL">All Categories</option>
                  {categories.map(cat => (
                    <option key={cat} value={cat}>{cat}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* Findings List */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {filteredFindings.length === 0 ? (
              <div style={{ ...CARD_STYLE, padding: '60px 20px', textAlign: 'center' }}>
                <ShieldCheck size={36} color="#22c55e" style={{ marginBottom: 12 }} />
                <p style={{ color: '#94a3b8', fontSize: 14, margin: 0 }}>No findings match your filters.</p>
              </div>
            ) : (
              filteredFindings.map((finding, idx) => {
                const style = getSeverityStyle(finding.severity);
                return (
                  <div key={idx} style={{
                    ...CARD_STYLE,
                    borderLeft: `4px solid ${style.fg}`,
                    padding: '18px 24px',
                    background: '#f8fafc',
                    transition: 'transform 0.15s, background-color 0.15s'
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
                      <div>
                        {/* Title and Badge */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                          <h4 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: '#1e293b' }}>{finding.title}</h4>
                          <span style={{
                            fontSize: 10, fontWeight: 800, padding: '2px 8px', borderRadius: 12,
                            background: style.bg, border: `1px solid ${style.border}`, color: style.fg,
                            textTransform: 'uppercase', letterSpacing: 0.5
                          }}>
                            {finding.severity}
                          </span>
                          <span style={{
                            fontSize: 11, color: '#64748b', background: '#ffffff', padding: '2px 8px', borderRadius: 4
                          }}>
                            {finding.category}
                          </span>
                        </div>

                        {/* Description */}
                        <p style={{ margin: '8px 0 12px', color: '#94a3b8', fontSize: 13, lineHeight: 1.5 }}>
                          {finding.description}
                        </p>

                        {/* Recommendation */}
                        <div style={{
                          padding: '10px 14px', borderRadius: 8, background: '#f1f5f9', border: '1px solid #eef2f6'
                        }}>
                          <div style={{ display: 'flex', gap: 6, alignItems: 'center', color: '#60a5fa', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>
                            🔧 Remediation Recommendation
                          </div>
                          <p style={{ margin: 0, color: '#475569', fontSize: 12 }}>
                            {finding.recommendation}
                          </p>
                        </div>
                      </div>

                      {/* Affected Resource Link */}
                      <div style={{ flexShrink: 0, textAlign: 'right' }}>
                        <span style={{ color: '#64748b', fontSize: 10, fontWeight: 600, display: 'block', textTransform: 'uppercase' }}>Target Resource</span>
                        <button
                          onClick={() => navigate(`/cloud/resources/${finding.resource_id}`)}
                          style={{
                            background: 'none', border: 'none', color: '#60a5fa', fontSize: 13, fontWeight: 600,
                            cursor: 'pointer', padding: '4px 0 0', display: 'inline-flex', alignItems: 'center', gap: 4,
                            fontFamily: 'inherit'
                          }}
                        >
                          {finding.resource_name}
                          <ExternalLink size={12} />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </>
      )}
    </div>
  );
};

const PAGE_STYLE: React.CSSProperties = {
  minHeight: '100%',
  background: '#f1f5f9',
  padding: '28px 32px',
  fontFamily: "'Inter', -apple-system, sans-serif",
};

const SPINNER_STYLE: React.CSSProperties = {
  width: 44,
  height: 44,
  borderRadius: '50%',
  border: '3px solid rgba(96,165,250,0.2)',
  borderTopColor: '#60a5fa',
  animation: 'spin 0.9s linear infinite',
};

const CARD_STYLE: React.CSSProperties = {
  background: '#f8fafc',
  border: '1px solid #e2e8f0',
  borderRadius: 16,
  padding: '20px 24px',
};

const BACK_BTN: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '6px 12px',
  background: '#ffffff',
  border: '1px solid #e2e8f0',
  borderRadius: 8,
  color: '#94a3b8',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
  fontFamily: 'inherit',
  marginBottom: 4,
};

const SELECT_STYLE: React.CSSProperties = {
  background: '#ffffff',
  border: '1px solid #e2e8f0',
  borderRadius: 8,
  color: '#334155',
  fontSize: 12,
  padding: '6px 10px',
  fontFamily: 'inherit',
  outline: 'none',
  cursor: 'pointer',
};
