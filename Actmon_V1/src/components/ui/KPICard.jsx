import React from 'react';
import { Card } from '@fluentui/react-components';

export const KPICard = ({
  label,
  value,
  icon,
  trend,
  subtext,
  loading = false,
}) => {
  if (loading) {
    return (
      <Card className="p-5 border border-brand-border bg-white shadow-card rounded-card animate-pulse">
        <div className="h-4 bg-gray-200 rounded w-24 mb-3" />
        <div className="h-8 bg-gray-200 rounded w-16 mb-2" />
        <div className="h-3 bg-gray-200 rounded w-32" />
      </Card>
    );
  }

  return (
    <Card className="p-5 border border-brand-border bg-white shadow-card rounded-card flex flex-col justify-between hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-brand-text-secondary uppercase tracking-wider truncate">
            {label}
          </p>
          <h3 className="text-2xl font-bold text-brand-text-primary mt-1 truncate">
            {value}
          </h3>
        </div>
        {icon && (
          <div className="p-2 bg-[#DEECF9] rounded-lg text-brand-primary flex-shrink-0">
            {icon}
          </div>
        )}
      </div>

      {(trend || subtext) && (
        <div className="mt-4 flex items-center gap-2 text-xs flex-wrap">
          {trend && (
            <span
              className={`font-semibold px-1.5 py-0.5 rounded-sm ${
                trend.isPositive ? 'bg-green-50 text-[#107C10]' : 'bg-red-50 text-[#A4262C]'
              }`}
            >
              {trend.value}
            </span>
          )}
          {trend?.label && <span className="text-brand-text-secondary">{trend.label}</span>}
          {subtext && <span className="text-brand-text-secondary truncate">{subtext}</span>}
        </div>
      )}
    </Card>
  );
};
