import React from 'react';
import { useCostSummary } from '../hooks/useCost';
import { formatCurrency } from '../utils/formatters';
import { Card, Spinner } from '@fluentui/react-components';

interface Props {
  accountId: string | null;
}

export const CostOverview: React.FC<Props> = ({ accountId }) => {
  const { data: cost, isLoading } = useCostSummary(accountId);

  if (!accountId) return null;

  if (isLoading) {
    return <div className="flex justify-center p-8"><Spinner /></div>;
  }

  if (!cost) {
    return <div className="p-4 text-gray-500 italic">No cost data available for this account.</div>;
  }

  return (
    <div className="space-y-4">
      <Card className="p-6 bg-gradient-to-r from-blue-50 to-indigo-50 border-blue-100">
        <h3 className="text-sm font-semibold text-blue-800 uppercase tracking-wide">Total Monthly Cost</h3>
        <p className="text-4xl font-bold text-blue-900 mt-2">
          {formatCurrency(cost.total_monthly_cost, cost.currency)}
        </p>
      </Card>

      <h4 className="font-bold text-gray-700 mt-6 mb-2">Cost Breakdown</h4>
      <div className="bg-white border rounded-md divide-y">
        {cost.breakdown.map((item, idx) => (
          <div key={idx} className="p-3 flex justify-between items-center hover:bg-gray-50">
            <div>
              <div className="font-semibold text-sm">{item.resource_name || 'Unknown'}</div>
              <div className="text-xs text-gray-500">{item.resource_type} • {item.region}</div>
            </div>
            <div className="font-bold">
              {formatCurrency(item.monthly_cost, item.currency)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
