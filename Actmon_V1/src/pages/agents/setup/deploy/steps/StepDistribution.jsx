import React from 'react';
import { CheckCircle2, Package } from 'lucide-react';
import { DISTRO_GROUPS } from '../deployConfig';

// Plain brand marks for the Linux distribution cards (no background tile).
const Box = ({ size, children }) => (
  <span className="inline-flex items-center justify-center flex-shrink-0" style={{ width: size, height: size }}>{children}</span>
);

function DistroLogo({ id, size = 44 }) {
  const s = size;
  switch (id) {
    case 'ubuntu':
      return <Box size={size}><svg width={s} height={s} viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#E95420" /><g fill="#fff"><circle cx="17.5" cy="7.5" r="1.7" /><circle cx="17.5" cy="16.5" r="1.7" /><circle cx="6.5" cy="12" r="1.7" /><path d="M12 7.2a4.8 4.8 0 0 1 3.4 1.4l1.5-1.5A6.9 6.9 0 0 0 12 5.1zM7.1 12c0-.9.2-1.7.6-2.4L5.5 8.4A6.9 6.9 0 0 0 5.1 12c0 1.3.3 2.5.9 3.6l2.1-1.2c-.6-.7-1-1.5-1-2.4zm4.9 4.8a4.8 4.8 0 0 1-3.4-1.4l-1.5 1.5A6.9 6.9 0 0 0 12 18.9z" opacity=".9" /></g></svg></Box>;
    case 'debian':
      return <Box size={size}><svg width={s} height={s} viewBox="0 0 24 24" fill="none"><path d="M15.5 9.5c1 2.5-.5 6-3.5 6.5s-5-1.5-5-4 2-4.5 4.5-4.5c1.6 0 3.2.6 4 2z" stroke="#A80030" strokeWidth="1.8" /><path d="M13.5 11c.3 1-.3 2.3-1.5 2.5-1.2.2-2-.6-2-1.6s.8-1.9 1.8-1.9c.7 0 1.4.3 1.7 1z" fill="#A80030" /></svg></Box>;
    case 'centos':
    case 'centos6':
      return <Box size={size}><svg width={s} height={s} viewBox="0 0 24 24"><g><rect x="10.6" y="2" width="2.8" height="8" fill="#9CCD2A" /><rect x="10.6" y="14" width="2.8" height="8" fill="#EFA724" /><rect x="2" y="10.6" width="8" height="2.8" fill="#262577" /><rect x="14" y="10.6" width="8" height="2.8" fill="#A02C46" /><rect x="9.5" y="9.5" width="5" height="5" fill="#fff" stroke="#888" strokeWidth=".6" transform="rotate(45 12 12)" /></g></svg></Box>;
    case 'redhat':
    case 'redhat6':
      return <Box size={size}><svg width={s} height={s} viewBox="0 0 24 24"><path d="M4 13c2-1 4-1 6 0 1.5.8 4 1 6 .2l2-.8c.5 1.8-.5 3.6-3 4.1-2 .5-5 .3-7-.5-2.5-1-4.5-1.5-4-3z" fill="#EE0000" /><path d="M9 11c0-2 1.5-4 4-4 2 0 3.5 1.3 4 3l-2 .8c-2 .8-4.5.5-6 .2z" fill="#151515" /></svg></Box>;
    case 'fedora':
      return <Box size={size}><svg width={s} height={s} viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#294172" /><path d="M13.5 6.5c-2.2 0-4 1.8-4 4v1.5H8a1.5 1.5 0 0 0 0 3h1.5v.5a1.5 1.5 0 0 1-1.5 1.5 1.5 1.5 0 0 0 0 3c2.5 0 4.5-2 4.5-4.5v-.5h1.5a1.5 1.5 0 0 0 0-3h-1.5v-1.5c0-.6.4-1 1-1H15a1.5 1.5 0 0 0 0-3z" fill="#fff" /></svg></Box>;
    case 'suse':
    case 'opensuse':
      return <Box size={size}><svg width={s} height={s} viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#73BA25" /><path d="M5 13c2-3 6-4 9-2.5 1.5.8 3 .8 4.5.2-.5 2.5-3 3.8-5.5 3-1.5-.5-2.5-.5-4 0-1.5.6-3 .3-4-.7z" fill="#fff" /><circle cx="16.5" cy="9" r="1.6" fill="#fff" /><circle cx="16.9" cy="8.8" r=".7" fill="#73BA25" /></svg></Box>;
    case 'amazon':
      return <Box size={size}><svg width={s} height={Math.round(s * 0.8)} viewBox="0 0 48 38"><text x="24" y="20" textAnchor="middle" fontSize="16" fontWeight="800" fill="#232F3E">aws</text><path d="M10 27c9 6 19 6 28 0" stroke="#FF9900" strokeWidth="2.6" fill="none" strokeLinecap="round" /></svg></Box>;
    case 'oracle':
      return <Box size={size}><svg width={s} height={Math.round(s * 0.55)} viewBox="0 0 48 26"><rect x="3" y="4" width="42" height="18" rx="9" stroke="#F80000" strokeWidth="3.2" fill="none" /></svg></Box>;
    case 'rocky':
      return <Box size={size}><svg width={s} height={s} viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#10B981" /><path d="M4.5 16 10 9l4 5 2.5-3 3 4.5A10 10 0 0 1 12 22a10 10 0 0 1-7.5-6z" fill="#0B7A5C" /></svg></Box>;
    case 'kali':
      return <Box size={size}><svg width={s} height={s} viewBox="0 0 24 24" fill="none"><path d="M3 14c5-3 10-4 15-2l3 1.5-3.5.5c1 1.5.5 3.5-1 4.5.3-1.5-.3-2.8-1.5-3.5-3.5-1.5-8-1.5-12-1z" fill="#1B2838" /><circle cx="18.6" cy="12.4" r=".7" fill="#4FB3E8" /></svg></Box>;
    case 'dpkg':
      return <Box size={size}><Package size={Math.round(s * 0.72)} className="text-[#A80030]" /></Box>;
    case 'dnf':
      return <Box size={size}><span style={{ color: '#294172', fontWeight: 900, fontSize: Math.round(s * 0.4) }}>dnf</span></Box>;
    case 'rpm':
      return <Box size={size}><svg width={s} height={s} viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#CC0000" /><text x="12" y="16" textAnchor="middle" fontSize="8" fontWeight="800" fill="#fff">rpm</text></svg></Box>;
    case 'yum':
      return <Box size={size}><span style={{ color: '#B58900', fontWeight: 900, fontSize: Math.round(s * 0.38) }}>yum</span></Box>;
    case 'zypper':
      return <Box size={size}><span style={{ color: '#73BA25', fontWeight: 900, fontSize: Math.round(s * 0.3) }}>zyp</span></Box>;
    default:
      return <Box size={size}><Package size={Math.round(s * 0.7)} className="text-slate-400" /></Box>;
  }
}

// Step (Linux only) — pick the target distribution / package manager.
// Selection decides which package we serve (deb|rpm) and the install command.
export default function StepDistribution({ data, setData }) {
  const sel = data.distro?.id;
  return (
    <div className="max-w-[1100px]">
      <h3 className="text-[19px] font-black text-slate-800">Select your Linux distribution</h3>
      <p className="text-[15px] text-slate-500 mt-1">
        We'll generate the download link and installation command for the matching package
        (<span className="font-mono">.deb</span> or <span className="font-mono">.rpm</span>).
      </p>

      {DISTRO_GROUPS.map((group) => (
        <div key={group.title} className="mt-7">
          <h4 className="text-[13px] font-black text-slate-400 uppercase tracking-wide mb-3">{group.title}</h4>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {group.items.map((d) => {
              const active = sel === d.id;
              return (
                <button key={d.id} type="button" onClick={() => setData({ distro: d })}
                  className={`relative text-left rounded-xl border-2 bg-white p-5 min-h-[92px] flex items-center gap-4 transition-all ${
                    active ? 'border-blue-500 bg-blue-50/40 ring-2 ring-blue-100' : 'border-slate-200 hover:border-blue-300 hover:shadow-[0_4px_18px_-6px_rgba(37,99,235,0.25)]'}`}>
                  <DistroLogo id={d.id} size={44} />
                  <div className="flex-1 min-w-0">
                    <p className="font-black text-slate-800 text-[16px] leading-snug">{d.name}</p>
                    <p className="text-[13px] text-slate-400 mt-1">
                      {d.fmt === 'deb' ? 'Debian package (.deb)' : 'RPM package (.rpm)'} · installs via <span className="font-mono">{d.pm}</span>
                    </p>
                  </div>
                  {active && <CheckCircle2 size={20} className="text-blue-600 flex-shrink-0" />}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
