import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCloudScope } from '../hooks/useCloudScope';
import { CloudProviderSelector } from '../components/CloudProviderSelector';
import { CheckCircle, AlertTriangle, Download, ShieldCheck, ClipboardCheck, Loader2, Info, Clock } from 'lucide-react';
import { cloudAxios } from '../api/axios';

const fetchCompliance = async (accountId: string) => {
  const { data } = await cloudAxios.get(`/compliance/${accountId}`);
  return data;
};

const getScoreColor = (score: number | null) => {
  if (score == null) return '#9ca3af'; // Gray — NA
  if (score >= 90) return '#10b981'; // Green
  if (score >= 70) return '#f59e0b'; // Amber
  return '#ef4444'; // Red
};

const getScoreBarClass = (score: number | null) => {
  if (score == null) return 'bg-gray-300';
  if (score >= 90) return 'bg-green-500';
  if (score >= 70) return 'bg-amber-500';
  return 'bg-red-500';
};

const getScoreBadgeClass = (score: number | null) => {
  if (score == null) return 'bg-gray-50 text-gray-600 border-gray-200';
  if (score >= 90) return 'bg-green-50 text-green-700 border-green-200';
  if (score >= 70) return 'bg-amber-50 text-amber-700 border-amber-200';
  return 'bg-red-50 text-red-700 border-red-200';
};

export const CompliancePage = () => {
  const navigate = useNavigate();
  // Scope-aware (see useCloudScope) — compliance reports the chosen provider.
  const scope = useCloudScope();
  const accounts = scope.scopedAccounts;
  const selectedAccountId = scope.accountId;
  const setSelectedAccountId = scope.setAccountScope;

  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
    if (selectedAccountId) {
      setLoading(true);
      setError(null);
      fetchCompliance(selectedAccountId)
        .then(res => setData(res))
        .catch(err => {
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

  const { overall_compliance_score, frameworks, note } = data;
  const selectedAccount = accounts?.find(acc => acc.id === selectedAccountId);

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
      `}</style>
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

        {/* Methodology / data-source note */}
        {note && (
          <div className="flex items-start gap-2.5 bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 text-sm text-blue-800">
            <Info size={16} className="mt-0.5 shrink-0" />
            <span>{note}</span>
          </div>
        )}

        {/* Main Score Overview */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 flex flex-wrap items-center gap-10">
          <div className="shrink-0">
            <div
              className="w-36 h-36 rounded-full border-8 flex flex-col items-center justify-center"
              style={{ borderColor: getScoreColor(overall_compliance_score) }}
            >
              <span className="text-4xl font-bold text-gray-900 leading-none">
                {overall_compliance_score != null ? `${overall_compliance_score}%` : 'NA'}
              </span>
              <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider mt-1.5">Overall Score</span>
            </div>
          </div>
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-gray-900">Enterprise Compliance Posture</h2>
            <p className="text-sm text-gray-600 mt-2 max-w-xl leading-relaxed">
              Real security findings from your connected account are mapped against critical industry frameworks.
              Scores are shown as NA when control-level evaluation data is not available.
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold border ${selectedAccount?.auto_discovery ? 'bg-green-50 text-green-700 border-green-200' : 'bg-gray-50 text-gray-600 border-gray-200'}`}>
                <ShieldCheck size={14} /> Auto-Discovery: {selectedAccount ? (selectedAccount.auto_discovery ? 'On' : 'Off') : 'NA'}
              </span>
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-gray-50 text-gray-600 border border-gray-200">
                <Clock size={14} /> Last Scan: {selectedAccount?.last_discovery ? new Date(selectedAccount.last_discovery).toLocaleString() : 'NA'}
              </span>
            </div>
          </div>
        </div>

        {/* Framework Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {Object.entries(frameworks || {}).map(([name, data]: [string, any]) => (
            <div key={name} className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 flex flex-col">
              <div className="flex items-start justify-between mb-5">
                <div>
                  <h3 className="text-[15px] font-semibold text-gray-900">{name}</h3>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {data.total_controls != null ? `${data.total_controls} Controls Evaluated` : 'Controls Evaluated: NA'}
                  </p>
                </div>
                <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-bold uppercase tracking-wide border ${getScoreBadgeClass(data.score)}`}>
                  {data.score != null ? `${data.score}%` : 'NA'}
                </span>
              </div>

              {/* Progress Bar (only when a real score exists) */}
              {data.score != null && (
                <div className="bg-gray-100 rounded-full h-2 mb-5 overflow-hidden">
                  <div
                    className={`h-2 rounded-full ${getScoreBarClass(data.score)}`}
                    style={{ width: `${data.score}%` }}
                  />
                </div>
              )}

              {data.failed_controls != null ? (
                <div className={`mb-4 flex items-center gap-2 text-sm font-semibold ${data.failed_controls === 0 ? 'text-green-600' : 'text-amber-600'}`}>
                  {data.failed_controls === 0 ? <CheckCircle size={16} /> : <AlertTriangle size={16} />}
                  {data.failed_controls === 0 ? 'All Controls Passing' : `${data.failed_controls} Controls Failing`}
                </div>
              ) : (
                <div className={`mb-4 flex items-center gap-2 text-sm font-semibold ${(data.related_findings ?? 0) === 0 ? 'text-green-600' : 'text-amber-600'}`}>
                  {(data.related_findings ?? 0) === 0 ? <CheckCircle size={16} /> : <AlertTriangle size={16} />}
                  {data.related_findings != null
                    ? `${data.related_findings} Related Security Finding${data.related_findings === 1 ? '' : 's'}`
                    : 'Related Findings: NA'}
                </div>
              )}

              {/* Related Security Findings List */}
              {(data.issues?.length ?? 0) > 0 && (() => {
                const currentPage = pages[name] || 0;
                const totalPages = Math.ceil(data.issues.length / PAGE_SIZE);
                const paginatedIssues = data.issues.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

                return (
                  <div className="flex-1 flex flex-col">
                    <div className="flex-1 overflow-y-auto flex flex-col gap-2 min-h-[330px]">
                      {paginatedIssues.map((issue: any, idx: number) => (
                        <div
                          key={idx}
                          className={`bg-gray-50 rounded-lg border border-gray-200 border-l-4 px-3 py-2.5 ${issue.severity === 'CRITICAL' ? 'border-l-red-500' : 'border-l-amber-500'}`}
                        >
                          <div className="text-xs font-semibold text-gray-900 truncate mb-1">
                            {issue.rule}
                          </div>
                          <div className="text-[11px] text-gray-500">
                            {issue.affected_resource}
                          </div>
                        </div>
                      ))}
                    </div>

                    {/* Pagination Controls */}
                    {data.issues.length > PAGE_SIZE && (
                      <div className="no-print flex items-center justify-between mt-4 pt-4 border-t border-gray-200">
                        <button
                          onClick={() => handlePageChange(name, -1)}
                          disabled={currentPage === 0}
                          className="inline-flex items-center px-3 py-1.5 rounded-lg text-xs font-semibold bg-white border border-gray-300 text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                        >
                          Prev
                        </button>
                        <span className="text-[11px] font-semibold text-gray-500">
                          Page {currentPage + 1} of {totalPages}
                        </span>
                        <button
                          onClick={() => handlePageChange(name, 1)}
                          disabled={currentPage >= totalPages - 1}
                          className="inline-flex items-center px-3 py-1.5 rounded-lg text-xs font-semibold bg-white border border-gray-300 text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
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
