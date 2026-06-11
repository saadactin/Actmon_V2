import { Zap, Activity, DollarSign, Clock, AlertTriangle } from 'lucide-react';
import { KPICard } from '../ui/KPICard';

export default function LambdaDetailPanel({ data, resource }) {
  if (!data) return null;

  const { function_config, metrics, cost_estimate } = data;

  const hasThrottles = metrics?.throttles?.total_7d > 0;
  const errorRate = metrics?.errors?.error_rate_percent || 0;

  return (
    <div className="space-y-6">
      {/* Warning Banners */}
      {hasThrottles && (
        <div className="p-3 bg-orange-50 border-l-4 border-orange-500 text-orange-900 text-sm">
          <strong>⚠️ Throttling Detected:</strong> {metrics.throttles.total_7d.toLocaleString()} throttled invocations in the last 7 days
        </div>
      )}

      {errorRate > 5 && (
        <div className="p-3 bg-red-50 border-l-4 border-red-500 text-red-900 text-sm">
          <strong>⚠️ High Error Rate:</strong> {errorRate.toFixed(2)}% of invocations failed
        </div>
      )}

      {/* Summary Cards */}
      <div className="grid grid-cols-2 gap-4">
        <KPICard
          label="Invocations (7d)"
          value={metrics?.invocations?.total_7d?.toLocaleString() || '0'}
          icon={Zap}
          subtext={`Avg: ${metrics?.invocations?.avg_per_day?.toFixed(0) || '0'}/day`}
        />
        <KPICard
          label="Error Rate"
          value={`${errorRate.toFixed(2)}%`}
          icon={AlertTriangle}
          subtext={`${metrics?.errors?.total_7d || 0} errors`}
        />
        <KPICard
          label="Monthly Cost"
          value={`$${cost_estimate?.cost_monthly_estimate?.toFixed(2) || '0.00'}`}
          icon={DollarSign}
          subtext={`Last 7d: $${cost_estimate?.cost_7d?.toFixed(2) || '0.00'}`}
        />
        <KPICard
          label="Avg Duration"
          value={`${metrics?.duration?.avg_ms?.toFixed(0) || '0'} ms`}
          icon={Clock}
          subtext={`Max: ${metrics?.duration?.max_ms?.toFixed(0) || '0'} ms`}
        />
      </div>

      {/* Performance Metrics */}
      <div className="bg-white border border-brand-border rounded-card p-4 shadow-card">
        <h3 className="text-sm font-semibold mb-3 text-brand-text-primary flex items-center gap-2">
          <Activity className="h-4 w-4" />
          Performance Metrics (7 days)
        </h3>
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <div className="text-xs text-brand-text-secondary mb-1">Total Invocations</div>
            <div className="text-lg font-semibold text-brand-text-primary">
              {metrics?.invocations?.total_7d?.toLocaleString() || '0'}
            </div>
          </div>
          <div>
            <div className="text-xs text-brand-text-secondary mb-1">Avg per Day</div>
            <div className="text-lg font-semibold text-brand-text-primary">
              {metrics?.invocations?.avg_per_day?.toFixed(0) || '0'}
            </div>
          </div>
          <div>
            <div className="text-xs text-brand-text-secondary mb-1">Throttles</div>
            <div className={`text-lg font-semibold ${hasThrottles ? 'text-orange-600' : 'text-brand-text-primary'}`}>
              {metrics?.throttles?.total_7d?.toLocaleString() || '0'}
            </div>
          </div>
          <div>
            <div className="text-xs text-brand-text-secondary mb-1">Max Concurrent</div>
            <div className="text-lg font-semibold text-brand-text-primary">
              {metrics?.concurrent_executions?.max_concurrent || '0'}
            </div>
          </div>
        </div>
      </div>

      {/* Function Configuration */}
      <div className="bg-white border border-brand-border rounded-card p-4 shadow-card">
        <h3 className="text-sm font-semibold mb-3 text-brand-text-primary">Configuration</h3>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <span className="text-brand-text-secondary">Function Name:</span>
            <span className="ml-2 font-mono text-brand-text-primary text-xs">{function_config?.function_name}</span>
          </div>
          <div>
            <span className="text-brand-text-secondary">Runtime:</span>
            <span className="ml-2 text-brand-text-primary">{function_config?.runtime}</span>
          </div>
          <div>
            <span className="text-brand-text-secondary">Memory:</span>
            <span className="ml-2 text-brand-text-primary">{function_config?.memory_mb} MB</span>
          </div>
          <div>
            <span className="text-brand-text-secondary">Timeout:</span>
            <span className="ml-2 text-brand-text-primary">{function_config?.timeout_seconds}s</span>
          </div>
          <div>
            <span className="text-brand-text-secondary">Code Size:</span>
            <span className="ml-2 text-brand-text-primary">{(function_config?.code_size_bytes / 1024).toFixed(2)} KB</span>
          </div>
          <div>
            <span className="text-brand-text-secondary">Handler:</span>
            <span className="ml-2 font-mono text-brand-text-primary text-xs">{function_config?.handler}</span>
          </div>
        </div>
        {function_config?.last_modified && (
          <div className="mt-3 text-xs text-brand-text-secondary">
            Last modified: {new Date(function_config.last_modified).toLocaleString()}
          </div>
        )}
      </div>

      {/* Cost Breakdown */}
      <div className="bg-white border border-brand-border rounded-card p-4 shadow-card">
        <h3 className="text-sm font-semibold mb-3 text-brand-text-primary flex items-center gap-2">
          <DollarSign className="h-4 w-4" />
          Cost Breakdown
        </h3>
        <div className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-brand-text-secondary">Last 7 days:</span>
            <span className="font-semibold text-brand-text-primary">${cost_estimate?.cost_7d?.toFixed(4) || '0.0000'}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-brand-text-secondary">Monthly estimate:</span>
            <span className="font-semibold text-brand-text-primary">${cost_estimate?.cost_monthly_estimate?.toFixed(2) || '0.00'}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-brand-text-secondary">GB-seconds (7d):</span>
            <span className="font-mono text-xs text-brand-text-primary">{cost_estimate?.gb_seconds_7d?.toLocaleString() || '0'}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
