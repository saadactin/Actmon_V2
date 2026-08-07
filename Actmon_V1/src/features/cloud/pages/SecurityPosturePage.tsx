import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSecurityPosture } from '../hooks/useSecurity';
import { useCloudScope } from '../hooks/useCloudScope';
import { CloudProviderSelector } from '../components/CloudProviderSelector';
import { ShieldAlert, ShieldCheck, AlertTriangle, Info, RefreshCw, ExternalLink, Filter, Wrench, Loader2 } from 'lucide-react';

export const SecurityPosturePage = () => {
  const navigate = useNavigate();
  // Scope-aware account resolution (see useCloudScope) — keeps this tab on the
  // provider the user drilled into instead of defaulting to accounts[0].
  const scope = useCloudScope();
  const accounts = scope.scopedAccounts;
  const selectedAccountId = scope.accountId;
  const setSelectedAccountId = scope.setAccountScope;

  // Filters
  const [severityFilter, setSeverityFilter] = useState<string>('ALL');
  const [categoryFilter, setCategoryFilter] = useState<string>('ALL');

  const { data: posture, isLoading, isError, refetch, isRefetching } = useSecurityPosture(selectedAccountId);

  const selectedAccount = scope.account;

  if (isLoading) {
    return (
      <div className="p-6">
        <div className="flex flex-col items-center justify-center py-24 gap-3">
          <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
          <span className="text-sm text-gray-500">Analyzing security configuration...</span>
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

  // Tailwind classes per severity: badge pill + left border accent
  const getSeverityClasses = (sev: string) => {
    switch (sev.toUpperCase()) {
      case 'CRITICAL':
        return { badge: 'bg-red-50 text-red-700 border-red-200', accent: 'border-l-red-500' };
      case 'HIGH':
        return { badge: 'bg-orange-50 text-orange-700 border-orange-200', accent: 'border-l-orange-500' };
      case 'MEDIUM':
        return { badge: 'bg-amber-50 text-amber-700 border-amber-200', accent: 'border-l-amber-500' };
      case 'LOW':
        return { badge: 'bg-blue-50 text-blue-700 border-blue-200', accent: 'border-l-blue-500' };
      case 'INFO':
      default:
        return { badge: 'bg-gray-100 text-gray-600 border-gray-200', accent: 'border-l-gray-400' };
    }
  };

  const BADGE_BASE = 'inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-bold uppercase tracking-wide border';

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
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex justify-between items-start gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-blue-50 text-blue-600">
              <ShieldAlert size={20} />
            </div>
            Security Posture Scanner
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Identify misconfigurations, open ports, and IAM privilege violations
          </p>
        </div>

        {/* Account picker & scan trigger */}
        {accounts && accounts.length > 0 && (
          <div className="flex items-center gap-3">
            <CloudProviderSelector
              accounts={accounts}
              mode="single"
              selected={selectedAccountId}
              onSelect={id => id && setSelectedAccountId(id)}
            />

            <button
              onClick={() => refetch()}
              disabled={isRefetching}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold bg-blue-600 text-white hover:bg-blue-700 transition-colors disabled:opacity-60"
            >
              <RefreshCw size={14} className={isRefetching ? 'animate-spin' : ''} />
              {isRefetching ? 'Scanning...' : 'Scan Now'}
            </button>
          </div>
        )}
      </div>

      {isError || !posture ? (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
          <div className="text-center py-10 px-5">
            <ShieldAlert size={48} className="text-red-500 mx-auto mb-4" />
            <h3 className="text-base font-semibold text-gray-900 mb-2">Security Scan Unavailable</h3>
            <p className="text-sm text-gray-500">
              Unable to analyze cloud account resources. Please make sure resources have been discovered first.
            </p>
          </div>
        </div>
      ) : (
        <>
          {/* Main Dashboard Cards */}
          <div className="grid grid-cols-1 lg:grid-cols-[1fr_3fr] gap-5">

            {/* Health Score Gauge */}
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 flex flex-col items-center justify-center text-center">
              <div className="relative w-[140px] h-[140px] flex items-center justify-center">
                {/* SVG Gauge */}
                <svg width="140" height="140" viewBox="0 0 140 140">
                  <circle cx="70" cy="70" r="58" fill="none" stroke="#e5e7eb" strokeWidth="10" />
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
                  <span className="text-4xl font-bold text-gray-900 leading-none">{posture.score}</span>
                  <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider mt-1">Score</span>
                </div>
              </div>

              <div className="mt-4">
                <span
                  className="text-xs font-bold px-3.5 py-1 rounded-full border"
                  style={{
                    color: getGradeColor(posture.grade),
                    backgroundColor: `${getGradeColor(posture.grade)}1a`,
                    borderColor: `${getGradeColor(posture.grade)}44`,
                  }}
                >
                  Grade {posture.grade}
                </span>
              </div>
              <p className="text-xs text-gray-500 mt-3 px-2">
                {posture.score >= 90 ? 'Excellent security posture. Keep it up!' :
                 posture.score >= 70 ? 'Good overall security, but some issues need attention.' :
                 'Critical misconfigurations found. Immediate action required!'}
              </p>
            </div>

            {/* Severity Breakdown & Metrics */}
            <div className="flex flex-col gap-4">
              {/* Severity Card grid */}
              <div className="grid grid-cols-2 xl:grid-cols-4 gap-3.5">
                {[
                  { label: 'Critical / High', count: (posture.by_severity['CRITICAL'] || 0) + (posture.by_severity['HIGH'] || 0), chip: 'bg-red-50 text-red-600', icon: <ShieldAlert size={20} /> },
                  { label: 'Medium', count: posture.by_severity['MEDIUM'] || 0, chip: 'bg-amber-50 text-amber-600', icon: <AlertTriangle size={20} /> },
                  { label: 'Low', count: posture.by_severity['LOW'] || 0, chip: 'bg-blue-50 text-blue-600', icon: <Info size={20} /> },
                  { label: 'Info', count: posture.by_severity['INFO'] || 0, chip: 'bg-gray-100 text-gray-500', icon: <ShieldCheck size={20} /> }
                ].map(stat => (
                  <div key={stat.label} className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 flex items-center gap-4">
                    <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${stat.chip}`}>
                      {stat.icon}
                    </div>
                    <div>
                      <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">{stat.label}</div>
                      <div className="text-2xl font-bold text-gray-900 mt-0.5">{stat.count}</div>
                    </div>
                  </div>
                ))}
              </div>

              {/* General details bar */}
              <div className="bg-white rounded-xl border border-gray-200 shadow-sm px-6 py-4 flex justify-around items-center">
                <div>
                  <span className="text-xs text-gray-500">Resources Scanned</span>
                  <div className="text-lg font-bold text-gray-900 mt-1">{posture.total_resources_scanned}</div>
                </div>
                <div className="w-px h-8 bg-gray-200" />
                <div>
                  <span className="text-xs text-gray-500">Total Findings</span>
                  <div className="text-lg font-bold text-gray-900 mt-1">{posture.total_findings}</div>
                </div>
                <div className="w-px h-8 bg-gray-200" />
                <div>
                  <span className="text-xs text-gray-500">Last Scanned</span>
                  <div className="text-lg font-bold text-gray-900 mt-1">
                    {selectedAccount?.last_discovery ? new Date(selectedAccount.last_discovery).toLocaleString() : 'Never'}
                  </div>
                </div>
              </div>
            </div>

          </div>

          {/* Filter Bar */}
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm px-5 py-3 flex justify-between items-center">
            <div className="flex items-center gap-2 text-sm font-semibold text-gray-500">
              <Filter size={16} /> Filters
            </div>

            <div className="flex gap-3">
              {/* Severity Filter */}
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-500">Severity:</span>
                <select
                  value={severityFilter}
                  onChange={(e) => setSeverityFilter(e.target.value)}
                  className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="ALL">All Severities</option>
                  <option value="CRITICAL">Critical / High</option>
                  <option value="MEDIUM">Medium</option>
                  <option value="LOW">Low</option>
                  <option value="INFO">Info</option>
                </select>
              </div>

              {/* Category Filter */}
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-500">Category:</span>
                <select
                  value={categoryFilter}
                  onChange={(e) => setCategoryFilter(e.target.value)}
                  className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
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
          <div className="flex flex-col gap-3">
            {filteredFindings.length === 0 ? (
              <div className="bg-white rounded-xl border border-gray-200 shadow-sm py-14 px-5 text-center">
                <ShieldCheck size={36} className="text-green-500 mx-auto mb-3" />
                <h3 className="text-base font-semibold text-gray-900 mb-1">All Clear</h3>
                <p className="text-sm text-gray-500">No findings match your filters.</p>
              </div>
            ) : (
              filteredFindings.map((finding, idx) => {
                const sev = getSeverityClasses(finding.severity);
                return (
                  <div key={idx} className={`bg-white rounded-xl border border-gray-200 shadow-sm border-l-4 ${sev.accent} px-6 py-4`}>
                    <div className="flex justify-between items-start gap-4">
                      <div>
                        {/* Title and Badge */}
                        <div className="flex items-center gap-2.5 flex-wrap">
                          <h4 className="text-[15px] font-semibold text-gray-900">{finding.title}</h4>
                          <span className={`${BADGE_BASE} ${sev.badge}`}>
                            {finding.severity}
                          </span>
                          <span className="bg-gray-100 text-gray-600 text-xs px-2 py-0.5 rounded">
                            {finding.category}
                          </span>
                        </div>

                        {/* Description */}
                        <p className="text-sm text-gray-600 leading-relaxed mt-2 mb-3">
                          {finding.description}
                        </p>

                        {/* Recommendation */}
                        <div className="bg-blue-50/60 border border-blue-100 rounded-lg p-3">
                          <div className="flex items-center gap-1.5 text-[11px] font-bold text-blue-700 uppercase tracking-wide mb-1">
                            <Wrench size={12} /> Remediation Recommendation
                          </div>
                          <p className="text-xs text-gray-700">
                            {finding.recommendation}
                          </p>
                        </div>
                      </div>

                      {/* Affected Resource Link */}
                      <div className="shrink-0 text-right">
                        <span className="block text-[10px] font-semibold text-gray-500 uppercase tracking-wide">Target Resource</span>
                        <button
                          onClick={() => navigate(`/cloud/resources/${finding.resource_id}`)}
                          className="text-blue-600 hover:text-blue-700 text-sm font-semibold inline-flex items-center gap-1 mt-1"
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
