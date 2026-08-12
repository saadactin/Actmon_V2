import React from 'react';

// Network catalog brand marks — plain (no background tile).
const Box = ({ size, children }) => (
  <span className="inline-flex items-center justify-center flex-shrink-0" style={{ width: size, height: size }}>{children}</span>
);
const Word = ({ size, text, color, italic, tracking }) => (
  <Box size={size}><span style={{ color, fontWeight: 800, fontSize: Math.round(size * 0.24), fontStyle: italic ? 'italic' : 'normal', letterSpacing: tracking }}>{text}</span></Box>
);

// Cisco "sound-bars" mark (shared by Cisco / Viptela / ASA / UCS / ACI).
function CiscoBars({ size }) {
  const hs = [8, 16, 24, 28, 24, 16, 8];
  return (
    <Box size={size}>
      <svg width={size} height={Math.round(size * 0.72)} viewBox="0 0 56 34" fill="#049FD9">
        {hs.map((h, i) => <rect key={i} x={4 + i * 8} y={(34 - h) / 2} width="3" height={h} rx="1.5" />)}
      </svg>
    </Box>
  );
}

export function NetLogo({ id, size = 48 }) {
  const s = size;
  switch (id) {
    case 'netdevice':
      return (
        <Box size={size}><svg width={s} height={s} viewBox="0 0 48 48" fill="none">
          <rect x="9" y="12" width="30" height="18" rx="2.5" fill="#4EA8DE" /><rect x="18" y="30" width="12" height="5" fill="#4EA8DE" />
          <rect x="14" y="35" width="20" height="3" rx="1.5" fill="#2C7BB6" />
          <g fill="#fff"><circle cx="16" cy="21" r="2" /><circle cx="24" cy="21" r="2" /><circle cx="32" cy="21" r="2" /></g>
        </svg></Box>
      );
    case 'discover':
      return (
        <Box size={size}><svg width={s} height={s} viewBox="0 0 48 48" fill="none">
          <circle cx="22" cy="22" r="14" stroke="#1B3A6B" strokeWidth="2.6" fill="none" />
          <path d="M22 15v14M15 22h14" stroke="#1B3A6B" strokeWidth="2" strokeLinecap="round" />
          <path d="M33 33l8 8" stroke="#1B3A6B" strokeWidth="3" strokeLinecap="round" />
        </svg></Box>
      );
    case 'netpath':
      return (
        <Box size={size}><svg width={s} height={s} viewBox="0 0 48 48" fill="none">
          <circle cx="24" cy="24" r="13" stroke="#F59E0B" strokeWidth="2" strokeDasharray="2 4" fill="none" />
          <circle cx="24" cy="11" r="3.5" fill="#F59E0B" /><circle cx="37" cy="24" r="3.5" fill="#F59E0B" />
          <circle cx="24" cy="37" r="3.5" fill="#F59E0B" /><circle cx="11" cy="24" r="3.5" fill="#F59E0B" />
          <circle cx="24" cy="24" r="3" fill="#F59E0B" />
        </svg></Box>
      );
    case 'aruba': return <Word size={size} text="aruba" color="#FF8300" />;
    case 'meraki':
      return <Box size={size}><span style={{ color: '#67B346', fontWeight: 900, fontSize: Math.round(size * 0.7) }}>M</span></Box>;
    case 'prisma':
      return (
        <Box size={size}><svg width={s} height={s} viewBox="0 0 48 48" fill="none">
          <path d="M24 6l16 28H8z" fill="#FA582D" /><path d="M24 18l9 16H15z" fill="#F5A623" />
        </svg></Box>
      );
    case 'fortinet':
      return (
        <Box size={size}><svg width={s} height={s} viewBox="0 0 48 48" fill="none">
          <rect x="8" y="12" width="32" height="24" rx="3" fill="#DA291C" />
          <g fill="#fff"><rect x="13" y="18" width="10" height="4" /><rect x="13" y="26" width="16" height="4" /></g>
        </svg></Box>
      );
    case 'extreme':
      return <Box size={size}><span style={{ color: '#5B1F86', fontWeight: 900, fontSize: Math.round(size * 0.66) }}>E</span></Box>;
    case 'arista': return <Word size={size} text="ARISTA" color="#333" tracking="0.5px" />;
    case 'juniper': return <Word size={size} text="Juniper" color="#0A4B78" />;
    case 'ruckus':
      return (
        <Box size={size}><svg width={s} height={s} viewBox="0 0 48 48" fill="none">
          <path d="M8 30c4-1 8-6 14-6s8 3 12 2" stroke="#111" strokeWidth="3" strokeLinecap="round" fill="none" />
          <circle cx="10" cy="30" r="3" fill="#111" />
          <g stroke="#FF7A00" strokeWidth="2.5" strokeLinecap="round"><path d="M34 18v10M39 14v14" /></g>
        </svg></Box>
      );
    case 'velocloud': return <Word size={size} text="vmware" color="#696D6E" />;
    case 'viptela': return <CiscoBars size={size} />;
    case 'ups':
      return (
        <Box size={size}><svg width={s} height={s} viewBox="0 0 48 48" fill="none">
          <rect x="14" y="8" width="20" height="32" rx="2.5" fill="#2FB6C4" /><rect x="19" y="6" width="10" height="3" rx="1" fill="#2FB6C4" />
          <path d="M25 15l-5 9h4l-1 7 6-10h-4z" fill="#FFD400" />
        </svg></Box>
      );
    case 'dhcp':
      return (
        <Box size={size}><svg width={s} height={s} viewBox="0 0 48 48" fill="none"><g fill="#2FB6C4">
          <rect x="9" y="10" width="30" height="8" rx="2" /><rect x="9" y="20" width="30" height="8" rx="2" opacity=".6" /><rect x="9" y="30" width="30" height="8" rx="2" /></g>
          <g fill="#fff"><circle cx="15" cy="14" r="1.8" /><circle cx="15" cy="24" r="1.8" /><circle cx="15" cy="34" r="1.8" /></g>
        </svg></Box>
      );
    case 'paloalto':
      return (
        <Box size={size}><svg width={s} height={s} viewBox="0 0 48 48" fill="none">
          <rect x="10" y="20" width="12" height="8" rx="1.5" fill="#F04E23" transform="rotate(45 16 24)" />
          <rect x="26" y="20" width="12" height="8" rx="1.5" fill="#FA582D" transform="rotate(45 32 24)" />
        </svg></Box>
      );
    case 'f5':
      return (
        <Box size={size}><svg width={s} height={s} viewBox="0 0 48 48"><circle cx="24" cy="24" r="18" fill="#E4002B" />
          <text x="24" y="30" textAnchor="middle" fontSize="17" fontWeight="800" fill="#fff">f5</text></svg></Box>
      );
    case 'ciscoasa':
    case 'ciscoucs':
    case 'ciscoaci':
      return <CiscoBars size={size} />;
    default:
      return <Box size={size} />;
  }
}

export default NetLogo;
