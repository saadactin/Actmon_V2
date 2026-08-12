import { useState, useEffect } from 'react';
import { useCloudScope } from '../hooks/useCloudScope';
import { CloudProviderSelector } from '../components/CloudProviderSelector';
import { CheckCircle, AlertTriangle, Download, ShieldCheck, ClipboardCheck, Loader2, Info, Clock } from 'lucide-react';
import { cloudAxios } from '../api/axios';

const fetchCompliance = async (accountId) => {
  const { data } = await cloudAxios.get(`/compliance/${accountId}`);
  return data;
};

const getScoreBadgeClass = (score) => {
  if (score == null) return 'bg-gray-50 text-gray-600 border-gray-200';
  if (score >= 90) return 'bg-green-50 text-green-700 border-green-200';
  if (score >= 70) return 'bg-amber-50 text-amber-700 border-amber-200';
  return 'bg-red-50 text-red-700 border-red-200';
};

// Only these reach the compliance view; the backend keeps LOW/INFO advisory
// findings out of framework mapping entirely.
const SEVERITY_LEVELS = ['CRITICAL', 'HIGH', 'MEDIUM'];

const SEVERITY_STYLE = {
  CRITICAL: { pill: 'bg-red-50 text-red-700 border-red-300', bar: 'border-l-red-500', dot: 'bg-red-500' },
  HIGH: { pill: 'bg-orange-50 text-orange-700 border-orange-300', bar: 'border-l-orange-500', dot: 'bg-orange-500' },
  MEDIUM: { pill: 'bg-amber-50 text-amber-700 border-amber-300', bar: 'border-l-amber-500', dot: 'bg-amber-500' },
  LOW: { pill: 'bg-blue-50 text-blue-700 border-blue-300', bar: 'border-l-blue-400', dot: 'bg-blue-400' },
  INFO: { pill: 'bg-gray-100 text-gray-600 border-gray-300', bar: 'border-l-gray-400', dot: 'bg-gray-400' },
};

const severityStyle = (sev) => SEVERITY_STYLE[(sev || '').toUpperCase()] || SEVERITY_STYLE.INFO;

export const CompliancePage = () => {
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

  if (error) {
    return (
      <div className="p-6 space-y-6">
        <div className="flex flex-col items-center justify-center gap-3 py-24">
          <AlertTriangle className="h-8 w-8 text-red-500" />
          <p className="text-sm font-semibold text-gray-900">Failed to load compliance data</p>
          <p className="text-sm text-gray-500">{error}</p>
        </div>
      </div>
    );
  }

  if (accounts && accounts.length === 0) {
    return (
      <div className="p-6 space-y-6">
        <div className="flex flex-col items-center justify-center gap-3 py-24">
          <ClipboardCheck className="h-8 w-8 text-gray-400" />
          <p className="text-sm text-gray-500">No cloud accounts connected. Add an account to view compliance data.</p>
        </div>
      </div>
    );
  }

  if (loading || !data) {
    return (
      <div className="p-6 space-y-6">
        <div className="flex flex-col items-center justify-center gap-3 py-24">
          <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
          <p className="text-sm text-gray-500">Loading compliance data...</p>
        </div>
      </div>
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
    <div className="p-6 space-y-6">
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
      <div id="compliance-report" className="max-w-[1400px] mx-auto space-y-6">
        {/* Header */}
        <div className="no-print flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2.5">
              <div className="p-2 rounded-lg bg-blue-50 text-blue-600">
                <ClipboardCheck size={20} />
              </div>
              Compliance &amp; Audit Dashboard
            </h1>
            <p className="text-sm text-gray-500 mt-1">
              Map your cloud security posture to SOC2, HIPAA, and PCI-DSS frameworks.
            </p>
          </div>

          {accounts && accounts.length > 0 && (
            <div className="no-print flex items-center gap-3">
              <CloudProviderSelector
                accounts={accounts}
                selected={selectedAccountId}
                onSelect={setSelectedAccountId}
              />
              <button
                onClick={handleDownloadPDF}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold bg-blue-600 text-white hover:bg-blue-700 transition-colors disabled:opacity-60"
              >
                <Download size={16} /> Download PDF Report
              </button>
            </div>
          )}
        </div>

        {/* Headline counts */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 flex flex-wrap items-center gap-8">
          <div className="shrink-0">
            <div
              className="w-28 h-28 rounded-full border-8 flex flex-col items-center justify-center"
              style={{ borderColor: allViolations.length === 0 ? '#10b981' : '#ef4444' }}
            >
              <span className="text-3xl font-bold text-gray-900 leading-none">
                {allViolations.length}
              </span>
              <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mt-1 text-center px-2">
                Violations
              </span>
            </div>
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold text-gray-900">Control Violations Across Frameworks</h2>
            <p className="text-sm text-gray-600 mt-2 max-w-2xl leading-relaxed">
              Each violation is listed once below, with the specific control it breaches in every
              framework that covers it. Overall percentage scores stay NA — those require a certified
              provider assessment, not an inferred number.
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold border ${selectedAccount?.auto_discovery ? 'bg-green-50 text-green-700 border-green-200' : 'bg-gray-50 text-gray-600 border-gray-200'}`}>
                <ShieldCheck size={14} /> Auto-Discovery: {selectedAccount ? (selectedAccount.auto_discovery ? 'On' : 'Off') : 'NA'}
              </span>
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-gray-50 text-gray-600 border border-gray-200">
                <Clock size={14} /> Last Scan: {selectedAccount?.last_discovery ? new Date(selectedAccount.last_discovery).toLocaleString() : 'NA'}
              </span>
              {typeof data.advisory_findings === 'number' && data.advisory_findings > 0 && (
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-gray-50 text-gray-500 border border-gray-200">
                  <Info size={14} /> {data.advisory_findings} advisory (Security tab)
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Framework tiles — click to narrow the list to that framework */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {Object.entries(frameworkSummary).map(([fw, s]) => {
            const active = frameworkFilter === fw;
            const n = s.violations ?? 0;
            return (
              <button
                key={fw}
                onClick={() => { setFrameworkFilter(active ? 'ALL' : fw); setPage(0); }}
                className={`text-left bg-white rounded-xl border shadow-sm p-5 transition-all ${
                  active ? 'border-blue-500 ring-2 ring-blue-100' : 'border-gray-200 hover:border-gray-300'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="text-[15px] font-semibold text-gray-900">{fw}</h3>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {s.total_controls != null ? `${s.total_controls} Controls Evaluated` : 'Controls Evaluated: NA'}
                    </p>
                  </div>
                  <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-bold uppercase tracking-wide border ${getScoreBadgeClass(s.score)}`}>
                    {s.score != null ? `${s.score}%` : 'NA'}
                  </span>
                </div>

                <div className={`mt-4 flex items-center gap-2 text-sm font-semibold ${n === 0 ? 'text-green-600' : 'text-amber-600'}`}>
                  {n === 0 ? <CheckCircle size={16} /> : <AlertTriangle size={16} />}
                  {n} Control Violation{n === 1 ? '' : 's'}
                </div>

                <div className="mt-3 flex flex-wrap gap-1.5">
                  {SEVERITY_LEVELS.map((lvl) => {
                    const c = s.by_severity?.[lvl] ?? 0;
                    if (!c) return null;
                    const st = severityStyle(lvl);
                    return (
                      <span key={lvl} className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold border ${st.pill}`}>
                        <span className={`h-1.5 w-1.5 rounded-full ${st.dot}`} />
                        {c} {lvl}
                      </span>
                    );
                  })}
                </div>

                {(s.controls_cited?.length ?? 0) > 0 && (
                  <div className="mt-3 pt-3 border-t border-gray-100">
                    <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1.5">
                      Controls Breached
                    </p>
                    <ul className="space-y-0.5">
                      {s.controls_cited.map((c) => (
                        <li key={c} className="text-[11px] text-gray-600 truncate">{c}</li>
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
          <span className="text-[11px] font-bold text-gray-500 uppercase tracking-wider mr-1">Severity</span>
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
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                  active
                    ? (st ? st.pill : 'bg-gray-900 text-white border-gray-900')
                    : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
                }`}
              >
                {st && <span className={`h-1.5 w-1.5 rounded-full ${st.dot}`} />}
                {level === 'ALL' ? 'All' : level.charAt(0) + level.slice(1).toLowerCase()}
                <span className={`rounded-full px-1.5 text-[11px] font-bold ${
                  active ? 'bg-white/70 text-gray-700' : 'bg-gray-100 text-gray-500'
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
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-blue-200 bg-blue-50 text-blue-700 text-xs font-semibold hover:bg-blue-100"
            >
              {frameworkFilter} only — clear
            </button>
          )}
        </div>

        {/* One list, each violation once, with per-framework control citations */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="flex items-center justify-between gap-3 px-5 py-3.5 border-b border-gray-200 bg-gray-50">
            <h3 className="text-sm font-bold text-gray-700 uppercase tracking-wider">
              Control Violations
            </h3>
            <span className="text-xs text-gray-500">
              {violations.length} shown
              {violations.length !== allViolations.length && ` of ${allViolations.length}`}
            </span>
          </div>

          {violations.length === 0 ? (
            <div className="flex flex-col items-center justify-center text-center py-14 px-6">
              <CheckCircle size={36} className="text-green-500 mb-3" />
              <h4 className="text-base font-semibold text-gray-900 mb-1">No matching violations</h4>
              <p className="text-sm text-gray-500 max-w-md">
                {allViolations.length === 0
                  ? 'No CRITICAL, HIGH or MEDIUM control violations were found for this account.'
                  : 'Nothing matches the current filters — try clearing them.'}
              </p>
            </div>
          ) : (
            <>
              <div className="divide-y divide-gray-100">
                {violations
                  .slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE)
                  .map((v, idx) => {
                    const st = severityStyle(v.severity);
                    return (
                      <div key={idx} className={`border-l-4 ${st.bar} px-5 py-4`}>
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wide border ${st.pill}`}>
                            {(v.severity || 'NA').toUpperCase()}
                          </span>
                          <h4 className="text-sm font-semibold text-gray-900">{v.rule}</h4>
                        </div>
                        <p className="text-xs text-gray-500 mt-1 font-mono">{v.affected_resource}</p>
                        {v.description && (
                          <p className="text-xs text-gray-600 mt-2 leading-relaxed max-w-3xl">{v.description}</p>
                        )}

                        {/* Per-framework control citations — the part that differs */}
                        <div className="mt-3 flex flex-col gap-1.5">
                          {Object.entries(v.controls || {}).map(([fw, refs]) => (
                            <div key={fw} className="flex items-baseline gap-2 flex-wrap">
                              <span className="shrink-0 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold bg-gray-100 text-gray-600 border border-gray-200">
                                {fw}
                              </span>
                              <span className="text-[11px] text-gray-600">
                                {refs.join('   ·   ')}
                              </span>
                            </div>
                          ))}
                        </div>

                        {v.recommendation && (
                          <div className="mt-3 bg-blue-50/60 border border-blue-100 rounded-lg px-3 py-2">
                            <p className="text-[10px] font-bold text-blue-700 uppercase tracking-wider mb-0.5">Remediation</p>
                            <p className="text-xs text-gray-700">{v.recommendation}</p>
                          </div>
                        )}
                      </div>
                    );
                  })}
              </div>

              {violations.length > PAGE_SIZE && (
                <div className="no-print flex items-center justify-between px-5 py-3 border-t border-gray-200 bg-gray-50">
                  <button
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                    disabled={currentPage === 0}
                    className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-white border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                  >
                    Prev
                  </button>
                  <span className="text-[11px] font-semibold text-gray-500">
                    Page {currentPage + 1} of {totalPages}
                  </span>
                  <button
                    onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                    disabled={currentPage >= totalPages - 1}
                    className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-white border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                  >
                    Next
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};
