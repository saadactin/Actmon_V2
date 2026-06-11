import { HardDrive, DollarSign, Shield, AlertTriangle, CheckCircle } from 'lucide-react';
import { KPICard } from '../ui/KPICard';
import { StatusPill } from '../ui/StatusPill';

export default function S3DetailPanel({ data, resource }) {
  if (!data) return null;

  // Map API response to expected format
  const bucket_details = {
    bucket_name: data.bucket_name,
    region: data.region,
    creation_date: null,
  };

  const storage_metrics = {
    total_size_bytes: data.metrics?.storage?.size_bytes || 0,
    total_size_mb: data.metrics?.storage?.size_mb || 0,
    total_size_gb: data.metrics?.storage?.size_gb || 0,
    object_count: data.metrics?.objects?.count || 0,
    storage_class_breakdown: {},
  };

  const cost_estimate = {
    storage_monthly: data.cost_estimate?.storage_cost_monthly || 0,
    requests_monthly: data.cost_estimate?.request_cost_monthly_estimate || 0,
    total_monthly: data.cost_estimate?.total_monthly_estimate || 0,
  };

  const security_analysis = {
    security_score: data.security_score?.score || 0,
    versioning_enabled: data.versioning === 'Enabled',
    encryption_type: data.encryption?.enabled ? 'AES256' : 'None',
    public_access_blocked: data.public_access_block?.BlockPublicAcls && data.public_access_block?.BlockPublicPolicy,
    security_findings: data.security_score?.issues || [],
  };

  const securityScore = security_analysis?.security_score || 0;
  const hasPublicAccess = !security_analysis?.public_access_blocked;
  const isEncrypted = security_analysis?.encryption_type !== 'None';

  // Color code security score
  const getSecurityScoreColor = (score) => {
    if (score >= 80) return 'text-green-600';
    if (score >= 60) return 'text-yellow-600';
    return 'text-red-600';
  };

  return (
    <div className="space-y-6">
      {/* Security Warnings */}
      {hasPublicAccess && (
        <div className="p-3 bg-red-50 border-l-4 border-red-500 text-red-900 text-sm">
          <strong>🚨 Security Alert:</strong> This bucket allows public access! Sensitive data may be exposed.
        </div>
      )}

      {!isEncrypted && (
        <div className="p-3 bg-orange-50 border-l-4 border-orange-500 text-orange-900 text-sm">
          <strong>⚠️ No Encryption:</strong> Bucket is not encrypted at rest
        </div>
      )}

      {/* Summary Cards */}
      <div className="grid grid-cols-2 gap-4">
        <KPICard
          label="Storage Used"
          value={`${storage_metrics?.total_size_gb?.toFixed(2) || '0.00'} GB`}
          icon={HardDrive}
          subtext={`${storage_metrics?.total_size_mb?.toFixed(2) || '0.00'} MB`}
        />
        <KPICard
          label="Object Count"
          value={storage_metrics?.object_count?.toLocaleString() || '0'}
          icon={HardDrive}
        />
        <KPICard
          label="Monthly Cost"
          value={`$${cost_estimate?.total_monthly?.toFixed(2) || '0.00'}`}
          icon={DollarSign}
          subtext={`Storage: $${cost_estimate?.storage_monthly?.toFixed(2) || '0.00'}`}
        />
        <KPICard
          label="Security Score"
          value={`${securityScore}/100`}
          icon={Shield}
        />
      </div>

      {/* Bucket Details */}
      <div className="bg-white border border-brand-border rounded-card p-4 shadow-card">
        <h3 className="text-sm font-semibold mb-3 text-brand-text-primary">Bucket Details</h3>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <span className="text-brand-text-secondary">Bucket Name:</span>
            <span className="ml-2 font-mono text-brand-text-primary text-xs">{bucket_details?.bucket_name}</span>
          </div>
          <div>
            <span className="text-brand-text-secondary">Region:</span>
            <span className="ml-2 text-brand-text-primary">{bucket_details?.region}</span>
          </div>
          <div>
            <span className="text-brand-text-secondary">Created:</span>
            <span className="ml-2 text-brand-text-primary">
              {bucket_details?.creation_date ? new Date(bucket_details.creation_date).toLocaleDateString() : 'N/A'}
            </span>
          </div>
          <div>
            <span className="text-brand-text-secondary">Total Size:</span>
            <span className="ml-2 text-brand-text-primary">{storage_metrics?.total_size_bytes?.toLocaleString() || '0'} bytes</span>
          </div>
        </div>
      </div>

      {/* Storage Breakdown */}
      {storage_metrics?.storage_class_breakdown && Object.keys(storage_metrics.storage_class_breakdown).length > 0 && (
        <div className="bg-white border border-brand-border rounded-card p-4 shadow-card">
          <h3 className="text-sm font-semibold mb-3 text-brand-text-primary">Storage Class Breakdown</h3>
          <div className="space-y-2">
            {Object.entries(storage_metrics.storage_class_breakdown).map(([storageClass, count]) => (
              <div key={storageClass} className="flex justify-between items-center text-sm">
                <span className="text-brand-text-secondary">{storageClass}:</span>
                <span className="font-semibold text-brand-text-primary">{count.toLocaleString()} objects</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Security Analysis */}
      <div className="bg-white border border-brand-border rounded-card p-4 shadow-card">
        <h3 className="text-sm font-semibold mb-3 text-brand-text-primary flex items-center gap-2">
          <Shield className="h-4 w-4" />
          Security Analysis
        </h3>

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm text-brand-text-secondary">Overall Security Score:</span>
            <span className={`text-2xl font-bold ${getSecurityScoreColor(securityScore)}`}>
              {securityScore}/100
            </span>
          </div>

          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="flex items-center gap-2">
              {isEncrypted ? (
                <CheckCircle className="h-4 w-4 text-green-500" />
              ) : (
                <AlertTriangle className="h-4 w-4 text-red-500" />
              )}
              <span className="text-brand-text-secondary">Encryption:</span>
              <span className="font-semibold">{security_analysis?.encryption_type || 'None'}</span>
            </div>

            <div className="flex items-center gap-2">
              {security_analysis?.versioning_enabled ? (
                <CheckCircle className="h-4 w-4 text-green-500" />
              ) : (
                <AlertTriangle className="h-4 w-4 text-yellow-500" />
              )}
              <span className="text-brand-text-secondary">Versioning:</span>
              <span className="font-semibold">{security_analysis?.versioning_enabled ? 'Enabled' : 'Disabled'}</span>
            </div>

            <div className="flex items-center gap-2">
              {security_analysis?.public_access_blocked ? (
                <CheckCircle className="h-4 w-4 text-green-500" />
              ) : (
                <AlertTriangle className="h-4 w-4 text-red-500" />
              )}
              <span className="text-brand-text-secondary">Public Access:</span>
              <span className="font-semibold">{security_analysis?.public_access_blocked ? 'Blocked' : 'Allowed'}</span>
            </div>
          </div>

          {security_analysis?.security_findings && security_analysis.security_findings.length > 0 && (
            <div className="mt-3">
              <div className="text-xs font-semibold text-brand-text-secondary mb-2">Security Findings:</div>
              <div className="flex flex-wrap gap-2">
                {security_analysis.security_findings.map((finding, idx) => (
                  <StatusPill key={idx} status={finding.includes('public') ? 'error' : 'warning'}>
                    {finding}
                  </StatusPill>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Cost Breakdown */}
      <div className="bg-white border border-brand-border rounded-card p-4 shadow-card">
        <h3 className="text-sm font-semibold mb-3 text-brand-text-primary flex items-center gap-2">
          <DollarSign className="h-4 w-4" />
          Cost Breakdown
        </h3>
        <div className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-brand-text-secondary">Storage cost:</span>
            <span className="font-semibold text-brand-text-primary">${cost_estimate?.storage_monthly?.toFixed(2) || '0.00'}/mo</span>
          </div>
          <div className="flex justify-between">
            <span className="text-brand-text-secondary">Request cost:</span>
            <span className="font-semibold text-brand-text-primary">${cost_estimate?.requests_monthly?.toFixed(2) || '0.00'}/mo</span>
          </div>
          <div className="flex justify-between border-t border-brand-border pt-2">
            <span className="text-brand-text-secondary font-semibold">Total monthly:</span>
            <span className="font-bold text-brand-text-primary">${cost_estimate?.total_monthly?.toFixed(2) || '0.00'}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
