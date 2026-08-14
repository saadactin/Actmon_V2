import { useState, useEffect } from 'react';
import { useCloudScope } from '../hooks/useCloudScope';
import CloudPageHeader from '../components/CloudPageHeader';
import CloudToolbar from '../components/CloudToolbar';
import CloudSection from '../components/CloudSection';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Icon from '@/components/ui/Icon';
import { PageLoading } from '@/components/ui/Loading';
import { EmptyState } from '@/components/ui/Table';
import { CheckCircle, AlertTriangle, ShieldCheck, Clock, Info } from 'lucide-react';
import { cloudAxios } from '../api/axios';

const fetchCompliance = async (accountId) => {
  const { data } = await cloudAxios.get(`/compliance/${accountId}`);
  return data;
};

const getScoreBadgeTone = (score) => {
  if (score == null) return 'neutral';
  if (score >= 90) return 'success';
  if (score >= 70) return 'warning';
  return 'danger';
};

// Only these reach the compliance view; the backend keeps LOW/INFO advisory
// findings out of framework mapping entirely.
const SEVERITY_LEVELS = ['CRITICAL', 'HIGH', 'MEDIUM'];

// Consolidated onto the app's status-tone vocabulary (success/warning/danger/info/
// neutral) — CRITICAL keeps its own danger tone since it is the top of the scale,
// HIGH and MEDIUM share warning (adjacent tiers), LOW/INFO are defensive fallbacks
// for severities the backend never actually sends into this view.
const SEVERITY_TONE = {
  CRITICAL: { tone: 'danger', bar: 'border-l-danger' },
  HIGH: { tone: 'warning', bar: 'border-l-warning' },
  MEDIUM: { tone: 'warning', bar: 'border-l-warning' },
  LOW: { tone: 'info', bar: 'border-l-info' },
  INFO: { tone: 'neutral', bar: 'border-l-border' },
};

const severityStyle = (sev) => SEVERITY_TONE[(sev || '').toUpperCase()] || SEVERITY_TONE.INFO;

export const CompliancePage = ({ embedded = false }) => {
  // Scope-aware (see useCloudScope) — compliance reports the chosen provider.
  const scope = useCloudScope();
  const accounts = scope.scopedAccounts;
  const selectedAccountId = scope.accountId;
  const setSelectedAccountId = scope.setAccountScope;

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [severityFilter, setSeverityFilter] = useState('ALL');
  const [frameworkFilter, setFrameworkFilter] = useState('ALL');
  const [page, setPage] = useState(0);

  const PAGE_SIZE = 10;

  const handleDownloadPDF = () => {
    window.print();
  };

  useEffect(() => {
    if (selectedAccountId) {
      setLoading(true);
      setError(null);
      fetchCompliance(selectedAccountId)
        .then((res) => setData(res))
        .catch((err) => {
          console.error(err);
          setError(err?.response?.data?.detail || err?.message || 'Failed to fetch compliance data');
        })
        .finally(() => setLoading(false));
    }
  }, [selectedAccountId]);

  const header = embedded ? (
    <div className="no-print mb-4 flex justify-end">
      <Button variant="primary" icon="download" onClick={handleDownloadPDF}>
        Download PDF Report
      </Button>
    </div>
  ) : (
    <CloudPageHeader
      className="no-print"
      backTo="/cloud"
      title="Compliance & Audit Dashboard"
      description="Map your cloud security posture to SOC2, HIPAA, and PCI-DSS frameworks."
      icon="shield-check"
      actions={accounts && accounts.length > 0 && (
        <CloudToolbar
          selectorProps={{ accounts, selected: selectedAccountId, onSelect: setSelectedAccountId }}
        >
          <Button variant="primary" icon="download" onClick={handleDownloadPDF}>
            Download PDF Report
          </Button>
        </CloudToolbar>
      )}
    />
  );

  if (error) {
    return (
      <>
        {header}
        <div className="flex flex-col items-center justify-center gap-3 py-24 text-center">
          <span className="grid h-11 w-11 place-items-center rounded-full bg-danger-soft text-danger-fg">
            <Icon name="alert" size={22} />
          </span>
          <p className="text-[13px] font-semibold text-fg">Failed to load compliance data</p>
          <p className="max-w-sm text-[13px] text-muted">{error}</p>
        </div>
      </>
    );
  }

  if (accounts && accounts.length === 0) {
    return (
      <>
        {header}
        <div className="flex items-center justify-center py-24">
          <EmptyState
            icon="cloud"
            title="No cloud accounts connected"
            body="Add an account to view compliance data."
          />
        </div>
      </>
    );
  }

  if (loading || !data) {
    return (
      <>
        {header}
        <PageLoading title="Loading compliance data…" />
      </>
    );
  }

  const selectedAccount = accounts?.find((acc) => acc.id === selectedAccountId);

  const allViolations = data.violations || [];
  const frameworkSummary = data.framework_summary || {};
  const severityTotals = data.severity_totals || {};

  // A framework filter narrows to violations that framework actually cites.
  const violations = allViolations.filter((v) => {
    if (frameworkFilter !== 'ALL' && !(v.frameworks || []).includes(frameworkFilter)) return false;
    if (severityFilter !== 'ALL' && (v.severity || '').toUpperCase() !== severityFilter) return false;
    return true;
  });

  const totalPages = Math.max(1, Math.ceil(violations.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages - 1);

  return (
    <>
      <style>{`
        @media print {
          body * { visibility: hidden; }
          #compliance-report, #compliance-report * { visibility: visible; }
          #compliance-report { position: absolute; left: 0; top: 0; width: 100%; padding: 0 !important; }
          .no-print { display: none !important; }
          /* Ensure backgrounds print correctly */
          * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
        }
      `}
      </style>

      {header}

      <div id="compliance-report" className="space-y-6">
        {/* Headline counts */}
        <CloudSection bodyClassName="flex flex-wrap items-center gap-8">
          <div className="shrink-0">
            <div
              className="flex h-28 w-28 flex-col items-center justify-center rounded-full border-8"
              style={{ borderColor: allViolations.length === 0 ? 'var(--success)' : 'var(--danger)' }}
            >
              <span className="text-3xl leading-none font-bold text-fg">
                {allViolations.length}
              </span>
              <span className="mt-1 px-2 text-center text-[10px] font-semibold tracking-wider text-subtle uppercase">
                Violations
              </span>
            </div>
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold text-fg">Control Violations Across Frameworks</h2>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
              Each violation is listed once below, with the specific control it breaches in every
              framework that covers it. Overall percentage scores stay NA — those require a certified
              provider assessment, not an inferred number.
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Badge tone={selectedAccount?.auto_discovery ? 'success' : 'neutral'}>
                <ShieldCheck size={14} /> Auto-Discovery: {selectedAccount ? (selectedAccount.auto_discovery ? 'On' : 'Off') : 'NA'}
              </Badge>
              <Badge tone="neutral">
                <Clock size={14} /> Last Scan: {selectedAccount?.last_discovery ? new Date(selectedAccount.last_discovery).toLocaleString() : 'NA'}
              </Badge>
              {typeof data.advisory_findings === 'number' && data.advisory_findings > 0 && (
                <Badge tone="neutral">
                  <Info size={14} /> {data.advisory_findings} advisory (Security tab)
                </Badge>
              )}
            </div>
          </div>
        </CloudSection>

        {/* Framework tiles — click to narrow the list to that framework */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {Object.entries(frameworkSummary).map(([fw, s]) => {
            const active = frameworkFilter === fw;
            const n = s.violations ?? 0;
            return (
              <button
                key={fw}
                onClick={() => { setFrameworkFilter(active ? 'ALL' : fw); setPage(0); }}
                className={`rounded-card border bg-surface p-5 text-left shadow-sm transition-all ${
                  active ? 'border-accent ring-2 ring-accent-soft' : 'border-border hover:border-strong'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="text-[15px] font-semibold text-fg">{fw}</h3>
                    <p className="mt-0.5 text-xs text-muted">
                      {s.total_controls != null ? `${s.total_controls} Controls Evaluated` : 'Controls Evaluated: NA'}
                    </p>
                  </div>
                  <Badge tone={getScoreBadgeTone(s.score)} className="uppercase">
                    {s.score != null ? `${s.score}%` : 'NA'}
                  </Badge>
                </div>

                <div className={`mt-4 flex items-center gap-2 text-sm font-semibold ${n === 0 ? 'text-success-fg' : 'text-warning-fg'}`}>
                  {n === 0 ? <CheckCircle size={16} /> : <AlertTriangle size={16} />}
                  {n} Control Violation{n === 1 ? '' : 's'}
                </div>

                <div className="mt-3 flex flex-wrap gap-1.5">
                  {SEVERITY_LEVELS.map((lvl) => {
                    const c = s.by_severity?.[lvl] ?? 0;
                    if (!c) return null;
                    const st = severityStyle(lvl);
                    return (
                      <Badge key={lvl} tone={st.tone} size="xs">
                        <span className="h-1.5 w-1.5 rounded-full bg-current" />
                        {c} {lvl}
                      </Badge>
                    );
                  })}
                </div>

                {(s.controls_cited?.length ?? 0) > 0 && (
                  <div className="mt-3 border-t border-border pt-3">
                    <p className="mb-1.5 text-[10px] font-bold tracking-wider text-subtle uppercase">
                      Controls Breached
                    </p>
                    <ul className="space-y-0.5">
                      {s.controls_cited.map((c) => (
                        <li key={c} className="truncate text-[11px] text-muted">{c}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </button>
            );
          })}
        </div>

        {/* Filters */}
        <div className="no-print flex flex-wrap items-center gap-2">
          <span className="mr-1 text-[11px] font-bold tracking-wider text-subtle uppercase">Severity</span>
          {['ALL', ...SEVERITY_LEVELS].map((level) => {
            const active = severityFilter === level;
            const n = level === 'ALL'
              ? (data.total_violations ?? allViolations.length)
              : (severityTotals[level] ?? 0);
            const st = level === 'ALL' ? null : severityStyle(level);
            return (
              <button
                key={level}
                onClick={() => { setSeverityFilter(level); setPage(0); }}
                disabled={n === 0 && level !== 'ALL'}
                className={`inline-flex items-center gap-1.5 rounded-control border px-3 py-1.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                  active
                    ? (st ? (st.tone === 'danger' ? 'border-danger bg-danger-soft text-danger-fg'
                        : st.tone === 'warning' ? 'border-warning bg-warning-soft text-warning-fg'
                        : st.tone === 'info' ? 'border-info bg-info-soft text-info-fg'
                        : 'border-border bg-neutral-soft text-muted')
                      : 'border-inverse bg-inverse text-on-inverse')
                    : 'border-border bg-surface text-muted hover:bg-sunken'
                }`}
              >
                {st && <span className="h-1.5 w-1.5 rounded-full bg-current" />}
                {level === 'ALL' ? 'All' : level.charAt(0) + level.slice(1).toLowerCase()}
                <span className={`rounded-full px-1.5 text-[11px] font-bold ${
                  active ? 'bg-bg/70 text-fg' : 'bg-sunken text-muted'
                }`}
                >
                  {n}
                </span>
              </button>
            );
          })}
          {frameworkFilter !== 'ALL' && (
            <button
              onClick={() => { setFrameworkFilter('ALL'); setPage(0); }}
              className="inline-flex items-center gap-1.5 rounded-control border border-accent bg-accent-soft px-2.5 py-1.5 text-xs font-semibold text-accent-text hover:bg-accent-softer"
            >
              {frameworkFilter} only — clear
            </button>
          )}
        </div>

        {/* One list, each violation once, with per-framework control citations */}
        <CloudSection
          title="Control Violations"
          action={(
            <span className="text-xs text-muted">
              {violations.length} shown
              {violations.length !== allViolations.length && ` of ${allViolations.length}`}
            </span>
          )}
          bodyClassName="p-0"
        >
          {violations.length === 0 ? (
            <div className="px-6 py-14">
              <EmptyState
                icon="check"
                title="No matching violations"
                body={allViolations.length === 0
                  ? 'No CRITICAL, HIGH or MEDIUM control violations were found for this account.'
                  : 'Nothing matches the current filters — try clearing them.'}
              />
            </div>
          ) : (
            <>
              <div className="divide-y divide-border">
                {violations
                  .slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE)
                  .map((v, idx) => {
                    const st = severityStyle(v.severity);
                    return (
                      <div key={idx} className={`border-l-4 ${st.bar} px-5 py-4`}>
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge tone={st.tone} size="xs" className="uppercase">
                            {(v.severity || 'NA').toUpperCase()}
                          </Badge>
                          <h4 className="text-sm font-semibold text-fg">{v.rule}</h4>
                        </div>
                        <p className="mt-1 font-mono text-xs text-muted">{v.affected_resource}</p>
                        {v.description && (
                          <p className="mt-2 max-w-3xl text-xs leading-relaxed text-muted">{v.description}</p>
                        )}

                        {/* Per-framework control citations — the part that differs */}
                        <div className="mt-3 flex flex-col gap-1.5">
                          {Object.entries(v.controls || {}).map(([fw, refs]) => (
                            <div key={fw} className="flex flex-wrap items-baseline gap-2">
                              <Badge tone="neutral" size="xs" className="shrink-0">
                                {fw}
                              </Badge>
                              <span className="text-[11px] text-muted">
                                {refs.join('   ·   ')}
                              </span>
                            </div>
                          ))}
                        </div>

                        {v.recommendation && (
                          <div className="mt-3 rounded-control border border-border bg-info-soft px-3 py-2">
                            <p className="mb-0.5 text-[10px] font-bold tracking-wider text-info-fg uppercase">Remediation</p>
                            <p className="text-xs text-fg">{v.recommendation}</p>
                          </div>
                        )}
                      </div>
                    );
                  })}
              </div>

              {violations.length > PAGE_SIZE && (
                <div className="no-print flex items-center justify-between border-t border-border bg-sunken px-5 py-3">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                    disabled={currentPage === 0}
                  >
                    Prev
                  </Button>
                  <span className="text-[11px] font-semibold text-muted">
                    Page {currentPage + 1} of {totalPages}
                  </span>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                    disabled={currentPage >= totalPages - 1}
                  >
                    Next
                  </Button>
                </div>
              )}
            </>
          )}
        </CloudSection>
      </div>
    </>
  );
};
