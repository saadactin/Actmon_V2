import React, { useState, useEffect } from 'react';
import { getCostSummary } from '../../api/costAnalytics';
import { useToast } from '../ui/ToastProvider';
import { KPICard } from '../ui/KPICard';
import { DataTable } from '../ui/DataTable';
import { Spinner, Button } from '@fluentui/react-components';
import { DollarSign, TrendingUp, AlertTriangle, Package, PieChart as PieChartIcon, RefreshCw } from 'lucide-react';
import { PieChart, Pie, Cell, ResponsiveContainer, Legend, Tooltip } from 'recharts';

const COLORS = ['#0078D4', '#107C10', '#D13438', '#881798', '#FF8C00', '#00B7C3'];

export default function CostAnalyticsSummary({ accountId, accountName }) {
  const { addToast } = useToast();
  const [loading, setLoading] = useState(false);
  const [costData, setCostData] = useState(null);

  useEffect(() => {
    if (accountId) {
      fetchCostData();
    }
  }, [accountId]);

  const fetchCostData = async () => {
    setLoading(true);
    try {
      const data = await getCostSummary(accountId);
      setCostData(data);
    } catch (err) {
      addToast(`Failed to load cost analytics: ${err.message}`, 'error');
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center items-center py-20">
        <Spinner size="large" label="Analyzing costs across all resources..." />
      </div>
    );
  }

  if (!costData) {
    return (
      <div className="text-center py-12 text-brand-text-secondary">
        No cost data available
      </div>
    );
  }

  // Prepare pie chart data
  const pieChartData = costData?.cost_by_service
    ? Object.entries(costData.cost_by_service).map(([service, cost]) => ({
        name: service,
        value: parseFloat(cost.toFixed(2))
      }))
    : [];

  // Expensive resources table
  const expensiveResourcesColumns = [
    { key: 'resource_name', label: 'Resource Name', width: '35%' },
    { key: 'resource_type', label: 'Type', width: '20%' },
    {
      key: 'monthly_cost',
      label: 'Monthly Cost',
      width: '20%',
      render: (val) => `$${val?.toFixed(2) || '0.00'}`
    },
    {
      key: 'state',
      label: 'Status',
      width: '25%',
      render: (val) => val || '-'
    }
  ];

  // Idle resources table
  const idleResourcesColumns = [
    { key: 'resource_name', label: 'Resource Name', width: '20%' },
    { key: 'resource_type', label: 'Type', width: '15%' },
    {
      key: 'monthly_cost',
      label: 'Wasted Cost',
      width: '15%',
      render: (val) => `$${val?.toFixed(2) || '0.00'}`
    },
    { key: 'reason', label: 'Reason', width: '25%' },
    { key: 'recommendation', label: 'Action', width: '25%' }
  ];

  // Optimization recommendations table
  const recommendationsColumns = [
    { key: 'resource_name', label: 'Resource', width: '20%' },
    {
      key: 'severity',
      label: 'Severity',
      width: '12%',
      render: (val) => (
        <span className={`font-semibold text-xs px-2 py-1 rounded ${val === 'critical' ? 'bg-red-100 text-red-700' : 'bg-orange-100 text-orange-700'}`}>
          {val?.toUpperCase()}
        </span>
      )
    },
    { key: 'issue', label: 'Issue', width: '30%' },
    { key: 'recommendation', label: 'Recommendation', width: '38%' }
  ];

  return (
    <div className="space-y-6">
      {/* Header with Refresh */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-brand-text-primary flex items-center gap-2">
            <DollarSign className="h-6 w-6 text-green-600" />
            Cost Analytics: {accountName}
          </h2>
          <p className="text-xs text-brand-text-secondary mt-1">
            Real-time cost analysis and optimization recommendations
          </p>
        </div>
        <Button
          appearance="subtle"
          icon={<RefreshCw className="h-4 w-4" />}
          onClick={fetchCostData}
          size="small"
        >
          Refresh
        </Button>
      </div>

      {/* Summary KPIs */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <KPICard
          label="Total Monthly Cost"
          value={`$${costData.summary.total_monthly_cost.toFixed(2)}`}
          icon={DollarSign}
          subtext={`${costData.summary.services_count} services`}
        />
        <KPICard
          label="Total Resources"
          value={costData.summary.total_resources}
          icon={Package}
          subtext={`${costData.summary.total_idle_resources} idle`}
        />
        <KPICard
          label="Potential Savings"
          value={`$${costData.summary.potential_savings.toFixed(2)}`}
          icon={TrendingUp}
          subtext="From idle resources"
        />
        <KPICard
          label="Critical Alerts"
          value={costData.optimization_recommendations.length}
          icon={AlertTriangle}
          subtext="Requires attention"
        />
      </div>

      {/* Critical Optimization Recommendations */}
      {costData.optimization_recommendations.length > 0 && (
        <div className="bg-white border border-brand-border rounded-card p-4 shadow-card">
          <h3 className="text-sm font-semibold mb-3 text-brand-text-primary flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-red-600" />
            🚨 Critical Performance Issues ({costData.optimization_recommendations.length})
          </h3>
          <div className="mb-3 p-3 bg-red-50 border-l-4 border-red-500 text-red-900 text-sm">
            <strong>Immediate Action Required:</strong> These issues are severely impacting your application performance
          </div>
          <DataTable
            columns={recommendationsColumns}
            data={costData.optimization_recommendations}
            rowKeyField="resource_id"
          />
        </div>
      )}

      {/* Cost Breakdown Pie Chart */}
      {pieChartData.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="bg-white border border-brand-border rounded-card p-4 shadow-card">
            <h3 className="text-sm font-semibold mb-3 text-brand-text-primary flex items-center gap-2">
              <PieChartIcon className="h-5 w-5" />
              Cost Distribution by Service
            </h3>
            <ResponsiveContainer width="100%" height={250}>
              <PieChart>
                <Pie
                  data={pieChartData}
                  cx="50%"
                  cy="50%"
                  labelLine={false}
                  label={({ name, value }) => `${name}: $${value}`}
                  outerRadius={80}
                  fill="#8884d8"
                  dataKey="value"
                >
                  {pieChartData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip formatter={(value) => `$${value}`} />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          </div>

          {/* Cost Breakdown List */}
          <div className="bg-white border border-brand-border rounded-card p-4 shadow-card">
            <h3 className="text-sm font-semibold mb-3 text-brand-text-primary">Service Costs</h3>
            <div className="space-y-2">
              {Object.entries(costData.cost_by_service)
                .sort(([, a], [, b]) => b - a)
                .map(([service, cost], idx) => (
                  <div key={service} className="flex items-center justify-between p-2 rounded hover:bg-gray-50">
                    <div className="flex items-center gap-2">
                      <div
                        className="w-3 h-3 rounded-full"
                        style={{ backgroundColor: COLORS[idx % COLORS.length] }}
                      />
                      <span className="text-sm font-medium">{service}</span>
                    </div>
                    <span className="text-sm font-semibold">${cost.toFixed(2)}/mo</span>
                  </div>
                ))}
            </div>
          </div>
        </div>
      )}

      {/* Idle Resources */}
      {costData.idle_resources.length > 0 && (
        <div className="bg-white border border-brand-border rounded-card p-4 shadow-card">
          <h3 className="text-sm font-semibold mb-3 text-brand-text-primary flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-orange-600" />
            💰 Idle & Underutilized Resources ({costData.idle_resources.length})
          </h3>
          <div className="mb-3 p-3 bg-orange-50 border-l-4 border-orange-500 text-orange-900 text-sm">
            <strong>Potential Monthly Savings: ${costData.summary.potential_savings.toFixed(2)}</strong>
            <p className="mt-1">These resources are idle or unused and can be safely removed or optimized.</p>
          </div>
          <DataTable
            columns={idleResourcesColumns}
            data={costData.idle_resources}
            rowKeyField="resource_id"
          />
        </div>
      )}

      {/* Top Expensive Resources */}
      <div className="bg-white border border-brand-border rounded-card p-4 shadow-card">
        <h3 className="text-sm font-semibold mb-3 text-brand-text-primary">
          Top 10 Most Expensive Resources
        </h3>
        <DataTable
          columns={expensiveResourcesColumns}
          data={costData.top_expensive_resources}
          rowKeyField="resource_id"
        />
      </div>
    </div>
  );
}
