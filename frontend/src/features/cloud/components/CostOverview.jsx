import { useCostSummary } from '../hooks/useCost';
import { formatCurrency } from '../utils/formatters';
import CloudSection from './CloudSection';
import { InlineLoading } from '@/components/ui/Loading';
import { DollarSign } from 'lucide-react';

export const CostOverview = ({ accountId }) => {
  const { data: cost, isLoading } = useCostSummary(accountId);

  if (!accountId) return null;

  if (isLoading) {
    return <InlineLoading label="Loading cost summary…" />;
  }

  if (!cost) {
    return <p className="p-4 text-sm text-muted italic">No cost data available for this account.</p>;
  }

  return (
    <div className="space-y-4">
      {/* Total monthly cost card */}
      <CloudSection>
        <div className="flex items-center gap-4">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-control bg-accent-soft text-accent-text">
            <DollarSign className="h-5 w-5" />
          </span>
          <div>
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted">Total Monthly Cost</h3>
            <p className="mt-1 text-2xl font-bold text-fg">
              {formatCurrency(cost.total_monthly_cost, cost.currency)}
            </p>
          </div>
        </div>
      </CloudSection>

      {/* Breakdown */}
      <div>
        <h4 className="mb-2 text-sm font-semibold text-fg">Cost Breakdown</h4>
        <CloudSection bodyClassName="p-0 divide-y divide-border">
          {cost.breakdown.map((item, idx) => (
            <div key={idx} className="flex items-center justify-between px-4 py-3 transition-colors hover:bg-sunken">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-fg">{item.resource_name || 'Unknown'}</div>
                <div className="mt-0.5 text-xs text-muted">{item.resource_type} · {item.region}</div>
              </div>
              <div className="ml-4 shrink-0 text-sm font-semibold text-fg">
                {formatCurrency(item.monthly_cost, item.currency)}
              </div>
            </div>
          ))}
        </CloudSection>
      </div>
    </div>
  );
};
