import React from 'react';
import { getStatusColor } from '../../utils/thresholds';

export const StatusPill = ({ status }) => {
  const color = getStatusColor(status);
  
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold border"
      style={{
        borderColor: color,
        color: color,
        backgroundColor: `${color}0A`, // ~4% opacity
      }}
    >
      <span
        className="h-1.5 w-1.5 rounded-full animate-pulse"
        style={{ backgroundColor: color }}
      />
      {status}
    </span>
  );
};
