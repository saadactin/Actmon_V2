import React from 'react';
import { useCostSummary } from '../hooks/useCost';
import { formatCurrency } from '../utils/formatters';
import { DollarSign, Loader2 } from 'lucide-react';

interface Props {
  accountId: string | null;
}

export const CostOverview: React.FC<Props> = ({ accountId }) => {
  const { data: cost, isLoading } = useCostSummary(accountId);

  if (!accountId) return null;

  if (isLoading) {
    return (
      <div className="flex justify-center p-8">
        <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
      </div>
    );
  }

  if (!cost) {
    return <div className="p-4 text-sm text-gray-500 italic">No cost data available for this account.</div>;
  }

  return (
    <div className="space-y-4">
      {/* Total monthly cost card */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
        <div className="flex items-center gap-4">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-600">
            <DollarSign className="h-5 w-5" />
          </span>
          <div>
            <h3 className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">Total Monthly Cost</h3>
            <p className="text-2xl font-bold text-gray-900 mt-1">
              {formatCurrency(cost.total_monthly_cost, cost.currency)}
            </p>
          </div>
        </div>
      </div>

      {/* Breakdown */}
      <div>
        <h4 className="text-sm font-semibold text-gray-900 mb-2">Cost Breakdown</h4>
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm divide-y divide-gray-100 overflow-hidden">
          {cost.breakdown.map((item, idx) => (
            <div key={idx} className="flex items-center justify-between px-4 py-3 hover:bg-gray-50 transition-colors">
              <div className="min-w-0">
                <div className="text-sm font-medium text-gray-900 truncate">{item.resource_name || 'Unknown'}</div>
                <div className="text-xs text-gray-500 mt-0.5">{item.resource_type} · {item.region}</div>
              </div>
              <div className="text-sm font-semibold text-gray-900 shrink-0 ml-4">
                {formatCurrency(item.monthly_cost, item.currency)}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
