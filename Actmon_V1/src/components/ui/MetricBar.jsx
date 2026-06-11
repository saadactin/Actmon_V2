import React from 'react';
import { getMetricColor } from '../../utils/thresholds';

export const MetricBar = ({ value, showText = true }) => {
  const pct = Math.min(Math.max(value || 0, 0), 100);
  const color = getMetricColor(pct);

  return (
    <div className="w-full flex flex-col gap-1">
      <div className="h-2 w-full bg-gray-200 rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{
            width: `${pct}%`,
            backgroundColor: color,
          }}
        />
      </div>
      {showText && (
        <div className="flex justify-end text-xs font-medium" style={{ color }}>
          {pct.toFixed(1)}%
        </div>
      )}
    </div>
  );
};
