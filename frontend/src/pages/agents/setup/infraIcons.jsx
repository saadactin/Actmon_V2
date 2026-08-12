import React from 'react';

// Infrastructure catalog brand marks — plain logos (no background tile).
const Box = ({ size, children }) => (
  <span className="inline-flex items-center justify-center flex-shrink-0" style={{ width: size, height: size }}>{children}</span>
);

export function InfraLogo({ id, size = 48 }) {
  const s = size;
  switch (id) {
    case 'k8s':
      return (
        <Box size={size}>
          <svg width={s} height={s} viewBox="0 0 48 48" fill="none">
            <path d="M24 3l17 8 4 18-12 15H15L3 29l4-18z" fill="#326CE5" />
            <g stroke="#fff" strokeWidth="1.6"><circle cx="24" cy="24" r="6.5" fill="none" />
              <path d="M24 6.5v6M24 35.5v6M8 15l5.5 3M34.5 30l5.5 3M40 15l-5.5 3M13.5 30 8 33" /></g>
          </svg>
        </Box>
      );
    case 'hosts':
      return (
        <Box size={size}>
          <svg width={s} height={s} viewBox="0 0 48 48" fill="none"><g fill="#2FB6C4">
            <rect x="8" y="9" width="32" height="9" rx="2.5" /><rect x="8" y="20" width="32" height="9" rx="2.5" opacity=".55" /><rect x="8" y="31" width="32" height="9" rx="2.5" /></g>
            <g fill="#fff"><circle cx="14" cy="13.5" r="2" /><circle cx="14" cy="35.5" r="2" /><circle cx="14" cy="24.5" r="2" /></g>
          </svg>
        </Box>
      );
    case 'aws':
      return (
        <Box size={size}>
          <svg width={size} height={Math.round(size * 0.7)} viewBox="0 0 60 42">
            <text x="30" y="24" textAnchor="middle" fontSize="20" fontWeight="800" fill="#232F3E">aws</text>
            <path d="M14 32c10 6 22 6 32 0" stroke="#FF9900" strokeWidth="3" fill="none" strokeLinecap="round" />
          </svg>
        </Box>
      );
    case 'azure':
      return (
        <Box size={size}>
          <svg width={s} height={s} viewBox="0 0 48 48" fill="none">
            <path d="M20 8L8 38h9l3-8 8 3-10 5h20L26 8z" fill="#0089D6" />
          </svg>
        </Box>
      );
    case 'gcp':
      return (
        <Box size={size}>
          <svg width={s} height={s} viewBox="0 0 48 48" fill="none">
            <path d="M28 15l3-5a12 12 0 0 0-17 6" fill="#EA4335" />
            <path d="M14 16a12 12 0 0 0-2 14l5-4a6 6 0 0 1 1-7z" fill="#FBBC05" />
            <path d="M24 34a12 12 0 0 0 12-12c0-2-.5-4-1-5l-6 4a6 6 0 0 1-9 6z" fill="#34A853" />
            <path d="M30 10a12 12 0 0 1 5 12h-11l6-4a6 6 0 0 0-3-3z" fill="#4285F4" />
          </svg>
        </Box>
      );
    case 'discover':
      return (
        <Box size={size}>
          <svg width={s} height={s} viewBox="0 0 48 48" fill="none">
            <circle cx="22" cy="22" r="14" stroke="#1B3A6B" strokeWidth="2.6" fill="none" />
            <path d="M22 15v14M15 22h14" stroke="#1B3A6B" strokeWidth="2" strokeLinecap="round" />
            <path d="M33 33l8 8" stroke="#1B3A6B" strokeWidth="3" strokeLinecap="round" />
          </svg>
        </Box>
      );
    case 'hyperv':
      return (
        <Box size={size}>
          <svg width={s} height={s} viewBox="0 0 48 48" fill="#0078D4">
            <rect x="7" y="7" width="15.5" height="15.5" rx="1" /><rect x="25.5" y="7" width="15.5" height="15.5" rx="1" />
            <rect x="7" y="25.5" width="15.5" height="15.5" rx="1" /><rect x="25.5" y="25.5" width="15.5" height="15.5" rx="1" />
          </svg>
        </Box>
      );
    case 'vmware':
      return <Box size={size}><span style={{ color: '#696D6E', fontWeight: 800, fontSize: Math.round(size * 0.26) }}>vmware</span></Box>;
    case 'nutanix':
      return (
        <Box size={size}>
          <svg width={s} height={s} viewBox="0 0 48 48" fill="none" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 10l14 14-8 14M39 10L25 24l8 14" stroke="#B0D236" strokeWidth="4" fill="none" />
            <path d="M9 38l14-14 8 14M39 38L25 24 33 10" stroke="#024DA1" strokeWidth="4" fill="none" opacity=".85" />
          </svg>
        </Box>
      );
    case 'storage':
      return (
        <Box size={size}>
          <svg width={s} height={s} viewBox="0 0 48 48" fill="none">
            <rect x="8" y="14" width="32" height="20" rx="2.5" fill="#2FB6C4" />
            <g stroke="#fff" strokeWidth="2.2"><path d="M16 20v8M22 20v8M28 20v8M34 20v8" /></g>
          </svg>
        </Box>
      );
    case 'otel':
      return (
        <Box size={size}>
          <svg width={s} height={s} viewBox="0 0 48 48" fill="none">
            <circle cx="14" cy="30" r="5" fill="#F59E0B" /><circle cx="30" cy="14" r="6" fill="#4285F4" />
            <circle cx="34" cy="34" r="4" fill="#FBBC05" /><path d="M18 27l9-9M30 20l3 11" stroke="#94a3b8" strokeWidth="2" />
          </svg>
        </Box>
      );
    default:
      return <Box size={size} />;
  }
}

export default InfraLogo;
