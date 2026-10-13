export const formatDate = (dateString) => {
  if (!dateString) return '-';
  const d = new Date(dateString);
  return d.toLocaleString();
};

export const getProviderIcon = (provider) => {
  switch (String(provider).toUpperCase()) {
    case 'AWS': return 'aws-icon';
    case 'AZURE': return 'azure-icon';
    case 'OCI':
    case 'ORACLE': return 'oci-icon';
    default: return 'cloud-icon';
  }
};
