export const getMetricColor = (value) => {
  if (value < 70) {
    return 'var(--color-success)'; // Green
  }
  if (value < 85) {
    return 'var(--color-warning)'; // Orange/Warning
  }
  return 'var(--color-error)'; // Red
};

export const getMetricTailwindClass = (value) => {
  if (value < 70) {
    return 'bg-brand-success';
  }
  if (value < 85) {
    return 'bg-brand-warning';
  }
  return 'bg-brand-error';
};

export const getMetricTextColorClass = (value) => {
  if (value < 70) {
    return 'text-brand-success';
  }
  if (value < 85) {
    return 'text-brand-warning';
  }
  return 'text-brand-error';
};

export const getStatusColor = (status) => {
  switch (status?.toLowerCase()) {
    case 'online':
    case 'healthy':
      return 'var(--color-success)';
    case 'warning':
    case 'degraded':
      return 'var(--color-warning)';
    case 'offline':
      return 'var(--color-text-disabled)';
    case 'critical':
    case 'error':
    default:
      return 'var(--color-error)';
  }
};
