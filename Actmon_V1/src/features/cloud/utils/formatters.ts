export const formatCurrency = (value: number, currency: string = 'USD') => {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
  }).format(value);
};

export const formatDate = (dateString: string) => {
  if (!dateString) return '-';
  const d = new Date(dateString);
  return d.toLocaleString();
};

export const getProviderIcon = (provider: string) => {
  switch (provider.toUpperCase()) {
    case 'AWS': return 'aws-icon'; // Can map to real lucide icons in components
    case 'AZURE': return 'azure-icon';
    case 'OCI':
    case 'ORACLE': return 'oci-icon';
    default: return 'cloud-icon';
  }
};
