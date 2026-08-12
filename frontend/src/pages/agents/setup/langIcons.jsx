import React from 'react';

// Language brand marks for the APM catalog — plain logos (no background tile),
// rendered in a fixed box so all cards align identically.
const Box = ({ size, children }) => (
  <span className="inline-flex items-center justify-center flex-shrink-0" style={{ width: size, height: size }}>
    {children}
  </span>
);

export function LangLogo({ id, size = 48 }) {
  const s = size;
  switch (id) {
    case 'java':
      return (
        <Box size={size}>
          <svg width={s} height={s} viewBox="0 0 48 48" fill="none">
            <path d="M20 6c-4 4 3 6 2 10M27 4c-4 4 3 6 2 10" stroke="#E76F00" strokeWidth="2.4" strokeLinecap="round" />
            <path d="M13 24h22v6a7 7 0 0 1-7 7h-8a7 7 0 0 1-7-7z" fill="#5382A1" />
            <path d="M35 26h3.5a3.5 3.5 0 0 1 0 7H35" stroke="#5382A1" strokeWidth="2.6" fill="none" />
            <rect x="13" y="39.5" width="22" height="2.6" rx="1.3" fill="#E76F00" />
          </svg>
        </Box>
      );
    case 'python':
      return (
        <Box size={size}>
          <svg width={s} height={s} viewBox="0 0 48 48" fill="none">
            <path d="M24 5c-8 0-7.5 3.5-7.5 3.5V13H24v2H11s-5 0-5 9 5 9 5 9h3v-4.5s-.2-5 5-5h8s4.5.1 4.5-4.4V9S25.7 5 24 5Zm-4 3.2a1.7 1.7 0 1 1 0 3.4 1.7 1.7 0 0 1 0-3.4Z" fill="#3776AB" />
            <path d="M24 43c8 0 7.5-3.5 7.5-3.5V35H24v-2h13s5 0 5-9-5-9-5-9h-3v4.5s.2 5-5 5h-8s-4.5-.1-4.5 4.4V39S22.3 43 24 43Zm4-3.2a1.7 1.7 0 1 1 0-3.4 1.7 1.7 0 0 1 0 3.4Z" fill="#FFD43B" />
          </svg>
        </Box>
      );
    case 'nodejs':
      return (
        <Box size={size}>
          <svg width={s} height={s} viewBox="0 0 48 48" fill="none">
            <path d="M24 3l18.2 10.5v21L24 45 5.8 34.5v-21z" fill="#83CD29" />
            <text x="24" y="30" textAnchor="middle" fontSize="13" fontWeight="800" fill="#fff">JS</text>
          </svg>
        </Box>
      );
    case 'php':
      return (
        <Box size={size}>
          <svg width={size} height={Math.round(size * 0.62)} viewBox="0 0 60 34">
            <ellipse cx="30" cy="17" rx="29" ry="16" fill="#EDEDF3" />
            <text x="30" y="23" textAnchor="middle" fontSize="16" fontWeight="800" fontStyle="italic" fill="#777BB4">php</text>
          </svg>
        </Box>
      );
    case 'dotnet':
      return <Box size={size}><span style={{ color: '#512BD4', fontWeight: 800, fontSize: Math.round(size * 0.34) }}>.NET</span></Box>;
    case 'ruby':
      return (
        <Box size={size}>
          <svg width={s} height={s} viewBox="0 0 48 48" fill="none">
            <path d="M8 18l16-10 16 10-16 22z" fill="#CC342D" />
            <path d="M8 18h32L24 40z" fill="#9b241f" opacity="0.4" />
            <path d="M24 8v32" stroke="#fff" strokeWidth="0.8" opacity="0.4" />
          </svg>
        </Box>
      );
    case 'go':
      return <Box size={size}><span style={{ color: '#00ADD8', fontWeight: 800, fontSize: Math.round(size * 0.4), letterSpacing: '-2px' }}>GO</span></Box>;
    default:
      return <Box size={size} />;
  }
}

export default LangLogo;
