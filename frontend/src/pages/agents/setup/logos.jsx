import React from 'react';

// Authentic-style brand marks for each database engine (inline SVG, no external assets).
// Kept simple/flat but recognizable, with each product's real brand colour.

const Wrap = ({ size = 40, bg, children, pad = 0 }) => (
  <span className="inline-flex items-center justify-center rounded-xl" style={{ width: size, height: size, background: bg, padding: pad }}>
    {children}
  </span>
);

export function TechLogo({ id, size = 44 }) {
  const s = Math.round(size * 0.62);
  switch (id) {
    case 'mysql':
      return (
        <Wrap size={size} bg="#F0F6F8">
          <svg width={s} height={s} viewBox="0 0 24 24" fill="none"><path d="M2 17c3.5 0 5.5-1.5 6.5-4C10 9 11.5 6 15 6c3 0 4.5 2 4.5 5.5" stroke="#00758F" strokeWidth="1.8" strokeLinecap="round"/><path d="M15.5 15c.6 1.4 1.8 2.4 3.5 2.6.7.1 1.2-.1 1.2-.1s-.6-.4-1-1c-.4-.6-.5-1.2-.5-1.2" stroke="#F29111" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/><circle cx="6.2" cy="8.4" r="1.1" fill="#00758F"/></svg>
        </Wrap>
      );
    case 'postgresql':
      return (
        <Wrap size={size} bg="#EAF0F7">
          <svg width={s} height={s} viewBox="0 0 24 24" fill="none"><path d="M17.5 5.5c-2-.9-4.2-1-6.4-.6C8.5 5.4 6.7 6.8 6 9.2c-.9 3 .1 6.6 1.7 8.6.8 1 1.9 1.2 2.4.2.3-.7.2-1.7.1-2.6" stroke="#336791" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/><path d="M13.2 15.6c.1 1.2.1 2.6.7 3.1.7.6 1.8.2 2.4-.7 1.2-1.8 1.8-4.9 1.5-7.4" stroke="#336791" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/><circle cx="10.4" cy="9.6" r="1" fill="#336791"/><circle cx="14.8" cy="9.4" r="1" fill="#336791"/></svg>
        </Wrap>
      );
    case 'mssql':
      return (
        <Wrap size={size} bg="#EAF2FA">
          <svg width={s} height={s} viewBox="0 0 24 24" fill="none"><ellipse cx="12" cy="6" rx="7" ry="2.6" stroke="#C33131" strokeWidth="1.7"/><path d="M5 6v12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6V6" stroke="#C33131" strokeWidth="1.7"/><path d="M5 12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6" stroke="#C33131" strokeWidth="1.7"/></svg>
        </Wrap>
      );
    case 'oracle':
      return (
        <Wrap size={size} bg="#FBEAEA">
          <svg width={Math.round(size * 0.72)} height={s} viewBox="0 0 40 24" fill="none"><rect x="2" y="4" width="36" height="16" rx="8" stroke="#C74634" strokeWidth="3"/></svg>
        </Wrap>
      );
    case 'mongodb':
      return (
        <Wrap size={size} bg="#E9F6EC">
          <svg width={s} height={s} viewBox="0 0 24 24" fill="none"><path d="M12 3c2.5 3 4 5.8 4 9 0 4-2 6.5-3.4 7.6L12 21l-.6-1.4C10 18.5 8 16 8 12c0-3.2 1.5-6 4-9Z" fill="#4DB33D"/><path d="M12 3v18" stroke="#3F9714" strokeWidth="1.2"/></svg>
        </Wrap>
      );
    case 'clickhouse':
      return (
        <Wrap size={size} bg="#FEF6E0">
          <svg width={s} height={s} viewBox="0 0 24 24" fill="none"><g fill="#161615"><rect x="3" y="5" width="2.6" height="14" rx="0.4"/><rect x="7.2" y="5" width="2.6" height="14" rx="0.4"/><rect x="11.4" y="5" width="2.6" height="14" rx="0.4"/><rect x="15.6" y="5" width="2.6" height="14" rx="0.4"/><rect x="19.8" y="10.6" width="2.6" height="2.8" rx="0.4" fill="#FAFF69"/></g><rect x="19.8" y="10.6" width="2.2" height="2.8" rx="0.4" fill="#F4C000"/></svg>
        </Wrap>
      );
    case 'cosmosdb':
      return (
        <Wrap size={size} bg="#EAF3FE">
          <svg width={s} height={s} viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="8.5" stroke="#0078D4" strokeWidth="1.7"/>
            <circle cx="12" cy="3.5" r="1.6" fill="#0078D4"/>
            <circle cx="19" cy="8" r="1.6" fill="#0078D4"/>
            <circle cx="19" cy="16" r="1.6" fill="#0078D4"/>
            <circle cx="12" cy="20.5" r="1.6" fill="#0078D4"/>
            <circle cx="5" cy="16" r="1.6" fill="#0078D4"/>
            <circle cx="5" cy="8" r="1.6" fill="#0078D4"/>
          </svg>
        </Wrap>
      );
    default:
      return <Wrap size={size} bg="#EEF2F6" />;
  }
}

export default TechLogo;
