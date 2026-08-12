import React from 'react';
import { ScrollText, PackageCheck } from 'lucide-react';

// Brand marks for each deployment method (inline SVG, no external assets).
export function DeployIcon({ id, size = 26 }) {
  const s = size;
  switch (id) {
    case 'script':
      return <ScrollText size={s} className="text-indigo-500" />;
    case 'installer':
      return <PackageCheck size={s} className="text-indigo-500" />;
    case 'ansible':
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="11" fill="#000" /><path d="M11.4 6.2l4.6 11-3-1.3-2.1-5.3-2.6 6.4h-1.9L11.4 6.2z" fill="#fff" /></svg>
      );
    case 'chef':
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="11" fill="#F0F7EC" /><path d="M12 5c-2 0-3.6 1.5-3.9 3.4C6.8 8.7 6 9.8 6 11c0 1.5 1.2 2.7 2.7 2.7h6.6c1.5 0 2.7-1.2 2.7-2.7 0-1.2-.8-2.3-2.1-2.6C15.6 6.5 14 5 12 5z" fill="#3B7D23" /><rect x="9" y="14" width="6" height="4" rx="1" fill="#3B7D23" /></svg>
      );
    case 'puppet':
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" fill="none"><rect x="2" y="2" width="20" height="20" rx="3" fill="#FDF3E7" /><path d="M8 5h4a4 4 0 0 1 0 8H8v6H5V5h3zm0 3v2h4a1 1 0 0 0 0-2H8z" fill="#FFAE1A" /></svg>
      );
    case 'saltstack':
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="11" fill="#E8F7F3" /><path d="M6 15c3-1 5-5 8-6s3 3 4 2" stroke="#00E6C3" strokeWidth="2.2" strokeLinecap="round" /><circle cx="16" cy="9" r="1.4" fill="#0B537A" /></svg>
      );
    case 'docker':
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" fill="none"><g fill="#2496ED"><rect x="4" y="11" width="2.6" height="2.6" rx=".3" /><rect x="7" y="11" width="2.6" height="2.6" rx=".3" /><rect x="10" y="11" width="2.6" height="2.6" rx=".3" /><rect x="7" y="8.2" width="2.6" height="2.6" rx=".3" /><rect x="10" y="8.2" width="2.6" height="2.6" rx=".3" /><rect x="13" y="11" width="2.6" height="2.6" rx=".3" /></g><path d="M20 12c-1 0-1.8.2-2.4.5-.3-1.8-1.7-2.6-1.8-2.7l-.4-.2-.3.4c-.4.6-.6 1.4-.5 2.1 0 .3.1.7.3 1-.4.2-1 .3-2 .3H3c-.2 1.8.3 3.6 1.5 4.8 1.2 1 3 1.5 5.2 1.5 4.8 0 8.3-2.2 10-6.2 1 0 2.2 0 2.8-1.2l.2-.3-.3-.2c-.5-.3-1.3-.4-2.4-.4z" fill="#2496ED" /></svg>
      );
    case 'k8s':
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" fill="none"><path d="M12 2.3l8 3.8 2 8.6-5.5 6.8H7.5L2 14.7l2-8.6 8-3.8z" fill="#326CE5" /><g stroke="#fff" strokeWidth="1"><circle cx="12" cy="12" r="3.2" fill="none" /><path d="M12 3.5v3M12 17.5v3M4.5 8l2.8 1.4M16.7 14.6l2.8 1.4M19.5 8l-2.8 1.4M7.3 14.6L4.5 16" /></g></svg>
      );
    default:
      return <div style={{ width: s, height: s }} className="rounded bg-slate-200" />;
  }
}

export default DeployIcon;
