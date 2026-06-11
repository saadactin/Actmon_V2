import { Database, DollarSign, Activity, AlertTriangle, TrendingUp } from 'lucide-react';
import { KPICard } from '../ui/KPICard';
import { DataTable } from '../ui/DataTable';

export default function DynamoDBDetailPanel({ data, resource }) {
  if (!data) return null;

  // Map API response to expected format
  const table_details = {
    table_name: data.table_name,
    table_status: data.status,
    creation_date: data.creation_date,
    item_count: data.item_count,
    table_size_bytes: data.size_bytes,
    billing_mode: data.billing_mode,
  };

  const capacity_metrics = {
    read_capacity: data.metrics?.read_capacity,
    write_capacity: data.metrics?.write_capacity,
  };

  const performance_metrics = {
    throttled_requests: data.metrics?.throttles,
    read_write_ratio: data.utilization?.read_write_ratio,
  };

  const cost_estimate = {
    read_cost_monthly: (data.cost_estimate?.read_cost_7d * 30 / 7) || 0,
    write_cost_monthly: (data.cost_estimate?.write_cost_7d * 30 / 7) || 0,
    storage_cost_monthly: data.cost_estimate?.storage_cost_monthly || 0,
    total_monthly: data.cost_estimate?.total_monthly_estimate || 0,
  };

  const indexes = data.global_secondary_indexes || [];

  const utilization_analysis = {
    avg_item_size_bytes: data.utilization?.avg_item_size_bytes,
    table_utilization_percent: 0,
    recommendations: [],
  };

  const writeThrottles = performance_metrics?.throttled_requests?.write_throttles_7d || 0;
  const readThrottles = performance_metrics?.throttled_requests?.read_throttles_7d || 0;
  const totalThrottles = writeThrottles + readThrottles;
  const hasCriticalThrottles = totalThrottles > 1000;

  // Prepare indexes table data
  const indexColumns = [
    { key: 'index_name', label: 'Index Name', width: '30%' },
    { key: 'index_type', label: 'Type', width: '20%' },
    { key: 'projection_type', label: 'Projection', width: '25%' },
    { key: 'status', label: 'Status', width: '25%' },
  ];

  return (
    <div className="space-y-6">
      {/* Critical Throttle Warning */}
      {hasCriticalThrottles && (
        <div className="p-4 bg-red-100 border-l-4 border-red-500 text-red-900">
          <strong className="text-base">⚠️ Critical Performance Issue:</strong>
          <div className="mt-1">
            <strong>{totalThrottles.toLocaleString()}</strong> throttled requests detected in the last 7 days!
            This is severely impacting application performance.
          </div>
          <div className="mt-2 text-sm">
            {writeThrottles > 0 && <div>• Write throttles: {writeThrottles.toLocaleString()}</div>}
            {readThrottles > 0 && <div>• Read throttles: {readThrottles.toLocaleString()}</div>}
          </div>
        </div>
      )}

      {/* Warning for moderate throttles */}
      {!hasCriticalThrottles && totalThrottles > 0 && (
        <div className="p-3 bg-orange-50 border-l-4 border-orange-500 text-orange-900 text-sm">
          <strong>⚠️ Throttling Detected:</strong> {totalThrottles.toLocaleString()} throttled requests in the last 7 days
        </div>
      )}

      {/* Summary Cards */}
      <div className="grid grid-cols-2 gap-4">
        <KPICard
          label="Item Count"
          value={table_details?.item_count?.toLocaleString() || '0'}
          icon={Database}
        />
        <KPICard
          label="Table Size"
          value={`${(table_details?.table_size_bytes / 1024 / 1024).toFixed(2)} MB`}
          icon={Database}
          subtext={`${table_details?.table_size_bytes?.toLocaleString() || '0'} bytes`}
        />
        <KPICard
          label="Monthly Cost"
          value={`$${cost_estimate?.total_monthly?.toFixed(2) || '0.00'}`}
          icon={DollarSign}
        />
        <KPICard
          label="Billing Mode"
          value={table_details?.billing_mode || 'N/A'}
          icon={Activity}
        />
      </div>

      {/* Table Details */}
      <div className="bg-white border border-brand-border rounded-card p-4 shadow-card">
        <h3 className="text-sm font-semibold mb-3 text-brand-text-primary">Table Details</h3>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <span className="text-brand-text-secondary">Table Name:</span>
            <span className="ml-2 font-mono text-brand-text-primary text-xs">{table_details?.table_name}</span>
          </div>
          <div>
            <span className="text-brand-text-secondary">Status:</span>
            <span className="ml-2 text-brand-text-primary">{table_details?.table_status}</span>
          </div>
          <div>
            <span className="text-brand-text-secondary">Created:</span>
            <span className="ml-2 text-brand-text-primary">
              {table_details?.creation_date ? new Date(table_details.creation_date).toLocaleDateString() : 'N/A'}
            </span>
          </div>
          <div>
            <span className="text-brand-text-secondary">Avg Item Size:</span>
            <span className="ml-2 text-brand-text-primary">
              {utilization_analysis?.avg_item_size_bytes?.toLocaleString() || '0'} bytes
            </span>
          </div>
        </div>
      </div>

      {/* Capacity Metrics */}
      {capacity_metrics && (
        <div className="bg-white border border-brand-border rounded-card p-4 shadow-card">
          <h3 className="text-sm font-semibold mb-3 text-brand-text-primary flex items-center gap-2">
            <Activity className="h-4 w-4" />
            Capacity Utilization (7-day avg)
          </h3>
          <div className="space-y-4">
            {/* Read Capacity */}
            <div>
              <div className="flex justify-between text-sm mb-1">
                <span className="text-brand-text-secondary">Read Capacity</span>
                <span className="font-semibold text-brand-text-primary">
                  {capacity_metrics.read_capacity?.utilization_percent?.toFixed(1) || '0'}% utilized
                </span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-2">
                <div
                  className="bg-blue-500 h-2 rounded-full"
                  style={{ width: `${Math.min(capacity_metrics.read_capacity?.utilization_percent || 0, 100)}%` }}
                />
              </div>
              <div className="flex justify-between text-xs text-brand-text-secondary mt-1">
                <span>Consumed: {capacity_metrics.read_capacity?.consumed_7d_avg?.toFixed(2) || '0'}</span>
                {capacity_metrics.read_capacity?.provisioned && (
                  <span>Provisioned: {capacity_metrics.read_capacity.provisioned}</span>
                )}
              </div>
            </div>

            {/* Write Capacity */}
            <div>
              <div className="flex justify-between text-sm mb-1">
                <span className="text-brand-text-secondary">Write Capacity</span>
                <span className="font-semibold text-brand-text-primary">
                  {capacity_metrics.write_capacity?.utilization_percent?.toFixed(1) || '0'}% utilized
                </span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-2">
                <div
                  className="bg-green-500 h-2 rounded-full"
                  style={{ width: `${Math.min(capacity_metrics.write_capacity?.utilization_percent || 0, 100)}%` }}
                />
              </div>
              <div className="flex justify-between text-xs text-brand-text-secondary mt-1">
                <span>Consumed: {capacity_metrics.write_capacity?.consumed_7d_avg?.toFixed(2) || '0'}</span>
                {capacity_metrics.write_capacity?.provisioned && (
                  <span>Provisioned: {capacity_metrics.write_capacity.provisioned}</span>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Performance Metrics */}
      {performance_metrics && (
        <div className="bg-white border border-brand-border rounded-card p-4 shadow-card">
          <h3 className="text-sm font-semibold mb-3 text-brand-text-primary flex items-center gap-2">
            <TrendingUp className="h-4 w-4" />
            Performance Metrics (7 days)
          </h3>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <div className="text-xs text-brand-text-secondary mb-1">Read Throttles</div>
              <div className={`text-lg font-semibold ${readThrottles > 0 ? 'text-red-600' : 'text-brand-text-primary'}`}>
                {readThrottles.toLocaleString()}
              </div>
            </div>
            <div>
              <div className="text-xs text-brand-text-secondary mb-1">Write Throttles</div>
              <div className={`text-lg font-semibold ${writeThrottles > 0 ? 'text-red-600' : 'text-brand-text-primary'}`}>
                {writeThrottles.toLocaleString()}
              </div>
            </div>
            <div>
              <div className="text-xs text-brand-text-secondary mb-1">Read/Write Ratio</div>
              <div className="text-lg font-semibold text-brand-text-primary">
                {performance_metrics.read_write_ratio?.toFixed(2) || '0.00'}
              </div>
            </div>
            <div>
              <div className="text-xs text-brand-text-secondary mb-1">Table Utilization</div>
              <div className="text-lg font-semibold text-brand-text-primary">
                {utilization_analysis?.table_utilization_percent?.toFixed(1) || '0'}%
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Indexes */}
      {indexes && indexes.length > 0 && (
        <div className="bg-white border border-brand-border rounded-card p-4 shadow-card">
          <h3 className="text-sm font-semibold mb-3 text-brand-text-primary">
            Indexes (GSI/LSI) - {indexes.length} total
          </h3>
          <DataTable
            columns={indexColumns}
            data={indexes}
            rowKeyField="index_name"
          />
        </div>
      )}

      {/* Cost Breakdown */}
      <div className="bg-white border border-brand-border rounded-card p-4 shadow-card">
        <h3 className="text-sm font-semibold mb-3 text-brand-text-primary flex items-center gap-2">
          <DollarSign className="h-4 w-4" />
          Cost Breakdown
        </h3>
        <div className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-brand-text-secondary">Read operations:</span>
            <span className="font-semibold text-brand-text-primary">${cost_estimate?.read_cost_monthly?.toFixed(2) || '0.00'}/mo</span>
          </div>
          <div className="flex justify-between">
            <span className="text-brand-text-secondary">Write operations:</span>
            <span className="font-semibold text-brand-text-primary">${cost_estimate?.write_cost_monthly?.toFixed(2) || '0.00'}/mo</span>
          </div>
          <div className="flex justify-between">
            <span className="text-brand-text-secondary">Storage:</span>
            <span className="font-semibold text-brand-text-primary">${cost_estimate?.storage_cost_monthly?.toFixed(2) || '0.00'}/mo</span>
          </div>
          <div className="flex justify-between border-t border-brand-border pt-2">
            <span className="text-brand-text-secondary font-semibold">Total monthly:</span>
            <span className="font-bold text-brand-text-primary">${cost_estimate?.total_monthly?.toFixed(2) || '0.00'}</span>
          </div>
        </div>
      </div>

      {/* Recommendations */}
      {utilization_analysis?.recommendations && utilization_analysis.recommendations.length > 0 && (
        <div className="bg-blue-50 border border-blue-200 rounded-card p-4">
          <h3 className="text-sm font-semibold mb-2 text-blue-900">💡 Recommendations</h3>
          <ul className="list-disc list-inside space-y-1 text-sm text-blue-800">
            {utilization_analysis.recommendations.map((rec, idx) => (
              <li key={idx}>{rec}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
