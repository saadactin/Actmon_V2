import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSecurityPosture } from '../hooks/useSecurity';
import { useCloudScope } from '../hooks/useCloudScope';
import CloudPageHeader from '../components/CloudPageHeader';
import CloudToolbar from '../components/CloudToolbar';
import CloudSection from '../components/CloudSection';
import CloudFilterBar from '../components/CloudFilterBar';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/Table';
import { PageLoading } from '@/components/ui/Loading';
import { ShieldAlert, ShieldCheck, AlertTriangle, Info, ExternalLink, Filter, Wrench } from 'lucide-react';

// Grade → colour is a computed data value (like the score itself), not app
// chrome, so it stays a direct hex scale rather than a chrome token.
const getGradeColor = (grade) => {
  switch (grade) {
    case 'A': return '#22c55e';
    case 'B': return '#10b981';
    case 'C': return '#eab308';
    case 'D': return '#f97316';
    case 'F': return '#ef4444';
    default: return '#94a3b8';
  }
};

// Severity → Badge tone / left-accent border, per the app's status token trio.
const SEVERITY_TONE = { CRITICAL: 'danger', HIGH: 'danger', MEDIUM: 'warning', LOW: 'info', INFO: 'neutral' };
const SEVERITY_ACCENT = { CRITICAL: 'border-l-danger', HIGH: 'border-l-danger', MEDIUM: 'border-l-warning', LOW: 'border-l-info', INFO: 'border-l-border' };
const SEVERITY_CHIP = { CRITICAL: 'bg-danger-soft text-danger-fg', HIGH: 'bg-danger-soft text-danger-fg', MEDIUM: 'bg-warning-soft text-warning-fg', LOW: 'bg-info-soft text-info-fg', INFO: 'bg-neutral-soft text-muted' };

const severityTone = (sev) => SEVERITY_TONE[(sev || '').toUpperCase()] || 'neutral';
const severityAccent = (sev) => SEVERITY_ACCENT[(sev || '').toUpperCase()] || 'border-l-border';

export const SecurityPosturePage = ({ embedded = false }) => {
  const navigate = useNavigate();
  // Scope-aware account resolution (see useCloudScope) — keeps this tab on the
  // provider the user drilled into instead of defaulting to accounts[0].
  const scope = useCloudScope();
  const accounts = scope.scopedAccounts;
  const selectedAccountId = scope.accountId;
  const setSelectedAccountId = scope.setAccountScope;

  // Filters
  const [severityFilter, setSeverityFilter] = useState('ALL');
  const [categoryFilter, setCategoryFilter] = useState('ALL');

  const { data: posture, isLoading, isError, refetch, isRefetching } = useSecurityPosture(selectedAccountId);

  const selectedAccount = scope.account;

  if (isLoading) {
    return <PageLoading title="Analyzing security configuration..." />;
  }

  const findings = posture?.findings || [];
  const categories = Array.from(new Set(findings.map((f) => f.category)));

  const filteredFindings = findings.filter((f) => {
    const fSev = f.severity.toUpperCase();
    const matchesSev = severityFilter === 'ALL'
      || (severityFilter === 'CRITICAL' && (fSev === 'CRITICAL' || fSev === 'HIGH'))
      || fSev === severityFilter;
    const matchesCat = categoryFilter === 'ALL' || f.category === categoryFilter;
    return matchesSev && matchesCat;
  });

  const severityOptions = [
    { id: 'ALL', label: 'All Severities' },
    { id: 'CRITICAL', label: 'Critical / High' },
    { id: 'MEDIUM', label: 'Medium' },
    { id: 'LOW', label: 'Low' },
    { id: 'INFO', label: 'Info' },
  ];
  const categoryOptions = [
    { id: 'ALL', label: 'All Categories' },
    ...categories.map((cat) => ({ id: cat, label: cat })),
  ];

  return (
    <>
      {embedded ? (
        <div className="mb-4 flex justify-end">
          <Button variant="primary" icon="refresh" loading={isRefetching} onClick={() => refetch()}>
            {isRefetching ? 'Scanning...' : 'Scan Now'}
          </Button>
        </div>
      ) : (
        <CloudPageHeader
          backTo="/cloud"
          title="Security Posture Scanner"
          description="Identify misconfigurations, open ports, and IAM privilege violations"
          actions={accounts && accounts.length > 0 && (
            <CloudToolbar
              selectorProps={{
                accounts,
                mode: 'single',
                selected: selectedAccountId,
                onSelect: (id) => id && setSelectedAccountId(id),
              }}
            >
              <Button variant="primary" icon="refresh" loading={isRefetching} onClick={() => refetch()}>
                {isRefetching ? 'Scanning...' : 'Scan Now'}
              </Button>
            </CloudToolbar>
          )}
        />
      )}

      {isError || !posture ? (
        <CloudSection>
          <div className="flex flex-col items-center gap-3 py-10 px-5 text-center">
            <span className="grid h-14 w-14 place-items-center rounded-full bg-danger-soft text-danger-fg">
              <ShieldAlert size={26} />
            </span>
            <h3 className="text-[15px] font-semibold text-fg">Security Scan Unavailable</h3>
            <p className="max-w-sm text-sm text-muted">
              Unable to analyze cloud account resources. Please make sure resources have been discovered first.
            </p>
          </div>
        </CloudSection>
      ) : (
        <div className="space-y-5">
          {/* Main Dashboard Cards */}
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_3fr]">

            {/* Health Score Gauge */}
            <CloudSection bodyClassName="flex flex-col items-center justify-center text-center">
              <div className="relative flex h-[140px] w-[140px] items-center justify-center">
                {/* SVG Gauge */}
                <svg width="140" height="140" viewBox="0 0 140 140">
                  <circle cx="70" cy="70" r="58" fill="none" stroke="var(--border)" strokeWidth="10" />
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
                <div className="absolute flex flex-col items-center">
                  <span className="text-4xl font-bold leading-none text-fg">{posture.score}</span>
                  <span className="mt-1 text-[11px] font-semibold uppercase tracking-wider text-muted">Score</span>
                </div>
              </div>

              <div className="mt-4">
                <span
                  className="rounded-full border px-3.5 py-1 text-xs font-bold"
                  style={{
                    color: getGradeColor(posture.grade),
                    backgroundColor: `${getGradeColor(posture.grade)}1a`,
                    borderColor: `${getGradeColor(posture.grade)}44`,
                  }}
                >
                  Grade {posture.grade}
                </span>
              </div>
              <p className="mt-3 px-2 text-xs text-muted">
                {posture.score >= 90 ? 'Excellent security posture. Keep it up!'
                  : posture.score >= 70 ? 'Good overall security, but some issues need attention.'
                    : 'Critical misconfigurations found. Immediate action required!'}
              </p>
            </CloudSection>

            {/* Severity Breakdown & Metrics */}
            <div className="flex flex-col gap-4">
              {/* Severity Card grid */}
              <div className="grid grid-cols-2 gap-3.5 xl:grid-cols-4">
                {[
                  { label: 'Critical / High', count: (posture.by_severity.CRITICAL || 0) + (posture.by_severity.HIGH || 0), chip: SEVERITY_CHIP.CRITICAL, icon: <ShieldAlert size={20} /> },
                  { label: 'Medium', count: posture.by_severity.MEDIUM || 0, chip: SEVERITY_CHIP.MEDIUM, icon: <AlertTriangle size={20} /> },
                  { label: 'Low', count: posture.by_severity.LOW || 0, chip: SEVERITY_CHIP.LOW, icon: <Info size={20} /> },
                  { label: 'Info', count: posture.by_severity.INFO || 0, chip: SEVERITY_CHIP.INFO, icon: <ShieldCheck size={20} /> },
                ].map((stat) => (
                  <div key={stat.label} className="card flex items-center gap-4 p-card">
                    <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${stat.chip}`}>
                      {stat.icon}
                    </div>
                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">{stat.label}</div>
                      <div className="mt-0.5 text-2xl font-bold text-fg">{stat.count}</div>
                    </div>
                  </div>
                ))}
              </div>

              {/* General details bar */}
              <div className="card flex items-center justify-around px-card py-4">
                <div>
                  <span className="text-xs text-muted">Resources Scanned</span>
                  <div className="mt-1 text-lg font-bold text-fg">{posture.total_resources_scanned}</div>
                </div>
                <div className="h-8 w-px bg-border" />
                <div>
                  <span className="text-xs text-muted">Total Findings</span>
                  <div className="mt-1 text-lg font-bold text-fg">{posture.total_findings}</div>
                </div>
                <div className="h-8 w-px bg-border" />
                <div>
                  <span className="text-xs text-muted">Last Scanned</span>
                  <div className="mt-1 text-lg font-bold text-fg">
                    {selectedAccount?.last_discovery ? new Date(selectedAccount.last_discovery).toLocaleString() : 'Never'}
                  </div>
                </div>
              </div>
            </div>

          </div>

          {/* Filter Bar */}
          <div className="card flex flex-wrap items-center justify-between gap-3 px-card py-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-muted">
              <Filter size={16} /> Filters
            </div>

            <CloudFilterBar
              filters={[
                { key: 'severity', value: severityFilter, onChange: setSeverityFilter, options: severityOptions, width: 'auto' },
                { key: 'category', value: categoryFilter, onChange: setCategoryFilter, options: categoryOptions, width: 'auto' },
              ]}
            />
          </div>

          {/* Findings List */}
          <div className="flex flex-col gap-3">
            {filteredFindings.length === 0 ? (
              <CloudSection>
                <EmptyState icon="shield-check" title="All Clear" body="No findings match your filters." />
              </CloudSection>
            ) : (
              filteredFindings.map((finding, idx) => (
                <div key={idx} className={`card border-l-4 px-card py-4 ${severityAccent(finding.severity)}`}>
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      {/* Title and Badge */}
                      <div className="flex flex-wrap items-center gap-2.5">
                        <h4 className="text-[15px] font-semibold text-fg">{finding.title}</h4>
                        <Badge tone={severityTone(finding.severity)}>{finding.severity}</Badge>
                        <Badge tone="neutral">{finding.category}</Badge>
                      </div>

                      {/* Description */}
                      <p className="mt-2 mb-3 text-sm leading-relaxed text-muted">
                        {finding.description}
                      </p>

                      {/* Recommendation */}
                      <div className="rounded-control border border-info-soft bg-info-soft p-3">
                        <div className="mb-1 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-info-fg">
                          <Wrench size={12} /> Remediation Recommendation
                        </div>
                        <p className="text-xs text-fg">
                          {finding.recommendation}
                        </p>
                      </div>
                    </div>

                    {/* Affected Resource Link */}
                    <div className="shrink-0 text-right">
                      <span className="block text-[10px] font-semibold uppercase tracking-wide text-muted">Target Resource</span>
                      <button
                        onClick={() => navigate(`/cloud/resources/${finding.resource_id}`)}
                        className="mt-1 inline-flex items-center gap-1 text-sm font-semibold text-accent-text hover:text-accent-hover"
                      >
                        {finding.resource_name}
                        <ExternalLink size={12} />
                      </button>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </>
  );
};
