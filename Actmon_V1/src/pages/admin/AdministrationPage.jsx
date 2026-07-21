import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Shield, KeyRound, Boxes, FileText, Lock, UserCog, Users, ChevronRight, ChevronLeft,
  Building2, Network, IdCard, ScrollText, History, MonitorSmartphone, KeySquare, ArrowRight, RefreshCw,
} from 'lucide-react';
import { organizationsApi } from '../../api/admin';
import { usePermissions } from '../../hooks/usePermissions';
import { useAuthStore } from '../../store/authStore';

const ACCENTS = [
  { bar: 'from-indigo-500 to-blue-600', soft: 'bg-indigo-500', ring: 'group-hover:border-indigo-300', text: 'text-indigo-600' },
  { bar: 'from-rose-500 to-pink-600', soft: 'bg-rose-500', ring: 'group-hover:border-rose-300', text: 'text-rose-600' },
  { bar: 'from-emerald-500 to-teal-600', soft: 'bg-emerald-500', ring: 'group-hover:border-emerald-300', text: 'text-emerald-600' },
  { bar: 'from-amber-500 to-orange-600', soft: 'bg-amber-500', ring: 'group-hover:border-amber-300', text: 'text-amber-600' },
  { bar: 'from-violet-500 to-purple-600', soft: 'bg-violet-500', ring: 'group-hover:border-violet-300', text: 'text-violet-600' },
  { bar: 'from-cyan-500 to-sky-600', soft: 'bg-cyan-500', ring: 'group-hover:border-cyan-300', text: 'text-cyan-600' },
  { bar: 'from-fuchsia-500 to-pink-600', soft: 'bg-fuchsia-500', ring: 'group-hover:border-fuchsia-300', text: 'text-fuchsia-600' },
];

// scope: 'org' = filtered by org (?org=) | 'grpp' = org access-control | 'global' = app-wide
const MODULES = [
  { to: '/roles',            icon: Shield,            title: 'Roles',                 desc: 'Roles for this organization',       color: 'from-indigo-500 to-indigo-600', scope: 'org' },
  { to: '/role-permissions', icon: Lock,              title: 'Group Role Permissions', desc: 'Access control for this company',   color: 'from-rose-500 to-rose-600',     scope: 'grpp' },
  { to: '/users',            icon: UserCog,           title: 'User Master',           desc: 'User accounts in this org',         color: 'from-emerald-500 to-emerald-600', scope: 'org' },
  { to: '/employees',        icon: Users,             title: 'Employees',             desc: 'Employees in this org',             color: 'from-amber-500 to-amber-600',   scope: 'org' },
  { to: '/departments',      icon: Network,           title: 'Departments',           desc: 'Departments in this org',           color: 'from-teal-500 to-emerald-600',  scope: 'org' },
  { to: '/designations',     icon: IdCard,            title: 'Designations',          desc: 'Designations in this org',          color: 'from-fuchsia-500 to-purple-600', scope: 'org' },
  { to: '/permissions',      icon: KeyRound,          title: 'Permissions',           desc: 'Permission bitmask catalog',        color: 'from-violet-500 to-violet-600', scope: 'global' },
  { to: '/modules',          icon: Boxes,             title: 'Modules',               desc: 'Application modules',               color: 'from-blue-500 to-blue-600',     scope: 'global' },
  { to: '/pages',            icon: FileText,          title: 'Pages',                 desc: 'Pages & menu hierarchy',            color: 'from-cyan-500 to-cyan-600',     scope: 'global' },
  { to: '/audit-logs',       icon: ScrollText,        title: 'Audit Logs',            desc: 'Every data change',                 color: 'from-slate-600 to-slate-800',   scope: 'global' },
  { to: '/login-history',    icon: History,           title: 'Login History',         desc: 'Login / logout activity',           color: 'from-cyan-500 to-blue-600',     scope: 'global' },
  { to: '/user-sessions',    icon: MonitorSmartphone, title: 'User Sessions',         desc: 'Active & past sessions',            color: 'from-teal-500 to-cyan-600',     scope: 'global' },
  { to: '/password-history', icon: KeySquare,         title: 'Password History',      desc: 'Password change records',           color: 'from-rose-500 to-pink-600',     scope: 'global' },
];

export default function AdministrationPage() {
  const navigate = useNavigate();
  const { orgId } = useParams();
  const { can } = usePermissions();
  const { user } = useAuthStore();
  const superAdmin = !!user?.is_superuser;
  const [orgs, setOrgs] = useState([]);
  const [loading, setLoading] = useState(true);

  // Only show modules the user can VIEW (strict RBAC).
  const visibleModules = MODULES.filter((m) => can(m.to, 'view'));

  useEffect(() => {
    let alive = true;
    organizationsApi.list().then((d) => { if (alive) { setOrgs(d || []); setLoading(false); } }).catch(() => setLoading(false));
    return () => { alive = false; };
  }, []);

  // Non-super users manage exactly one org → skip the picker and jump straight in.
  useEffect(() => {
    if (!loading && !superAdmin && !orgId && orgs.length) {
      navigate(`/administration/${orgs[0].org_id}`, { replace: true });
    }
  }, [loading, superAdmin, orgId, orgs, navigate]);

  const selectedOrg = orgId ? orgs.find((o) => String(o.org_id) === String(orgId)) : null;

  const moduleHref = (m) => {
    if (m.scope === 'grpp') return `/role-permissions/${orgId}`;
    if (m.scope === 'org') return `${m.to}?org=${orgId}&orgName=${encodeURIComponent(selectedOrg?.org_name || '')}`;
    return m.to;
  };

  /* ───── LEVEL 0 — organization selector ───── */
  if (!orgId) {
    return (
      <div className="-mx-6 md:-mx-8 min-h-full bg-[#f1f5f9]">
        <Hero title="Administration" subtitle="Select an organization to manage its access control & masters" />
        <div className="px-6 xl:px-10 py-6 max-w-[1700px] mx-auto">
          {loading ? <CardSkeleton /> : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
              {orgs.map((o, i) => {
                const a = ACCENTS[i % ACCENTS.length];
                return (
                  <button key={o.org_id} onClick={() => navigate(`/administration/${o.org_id}`)}
                    className={`group relative bg-white rounded-3xl border border-slate-200 ${a.ring} overflow-hidden text-left shadow-sm hover:shadow-2xl hover:-translate-y-1.5 transition-all duration-300`}>
                    <div className={`h-1.5 bg-gradient-to-r ${a.bar}`} />
                    <div className={`pointer-events-none absolute -top-12 -right-12 w-40 h-40 rounded-full ${a.soft} opacity-0 group-hover:opacity-10 blur-3xl transition-opacity duration-500`} />
                    {o.parent_org_id === 0 && <span className={`absolute top-4 left-4 z-10 text-[10px] font-black px-2.5 py-1 rounded-full bg-gradient-to-r ${a.bar} text-white shadow-md`}>★ HQ</span>}
                    <div className="px-6 pt-8 pb-5 flex items-center justify-center">
                      <div className="w-full h-28 rounded-2xl bg-white border border-slate-100 shadow-[0_4px_20px_-8px_rgba(0,0,0,0.15)] flex items-center justify-center p-4 group-hover:scale-[1.03] transition-transform duration-300">
                        {o.logo_path
                          ? <img src={encodeURI(o.logo_path)} alt={o.org_name} className="max-h-16 max-w-[75%] object-contain"
                              onError={(e) => { e.currentTarget.style.display = 'none'; e.currentTarget.nextSibling.style.display = 'flex'; }} />
                          : null}
                        <div style={{ display: o.logo_path ? 'none' : 'flex' }} className={`w-16 h-16 rounded-2xl bg-gradient-to-br ${a.bar} items-center justify-center text-white`}><Building2 size={30} /></div>
                      </div>
                    </div>
                    <div className="px-6 pb-6">
                      <h3 className="font-black text-slate-800 text-lg truncate">{o.org_name}</h3>
                      <p className="text-xs text-slate-400 font-semibold mt-1 uppercase tracking-wide">{o.org_code} · {o.city_name}</p>
                      <div className="mt-5 flex items-center justify-between">
                        <span className={`text-sm font-extrabold ${a.text}`}>Manage Administration</span>
                        <span className={`w-9 h-9 rounded-xl bg-gradient-to-br ${a.bar} text-white flex items-center justify-center shadow-lg group-hover:translate-x-1 transition-transform`}><ArrowRight size={17} /></span>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    );
  }

  /* ───── LEVEL 1 — module grid for the selected org ───── */
  return (
    <div className="-mx-6 md:-mx-8 min-h-full bg-[#f1f5f9]">
      <div className="bg-gradient-to-r from-slate-900 via-blue-800 to-sky-700 px-6 md:px-8 pt-3 pb-4 relative overflow-hidden">
        <div className="absolute inset-0 opacity-[0.04]" style={{ backgroundImage: 'linear-gradient(#fff 1px,transparent 1px),linear-gradient(90deg,#fff 1px,transparent 1px)', backgroundSize: '28px 28px' }} />
        <div className="relative flex items-center gap-2 text-xs text-slate-300/70 mb-2.5">
          <button onClick={() => navigate('/administration')} className="hover:text-slate-200 transition-colors">ActMon</button>
          <ChevronRight size={11} />
          <button onClick={() => navigate('/administration')} className="hover:text-slate-200 transition-colors">Administration</button>
          <ChevronRight size={11} />
          <span className="text-white font-semibold truncate max-w-[220px]">{selectedOrg?.org_name || 'Organization'}</span>
        </div>
        <div className="relative flex items-center gap-3">
          <button onClick={() => navigate('/administration')} className="w-8 h-8 rounded-lg bg-white/10 border border-white/15 flex items-center justify-center text-white hover:bg-white/20 flex-shrink-0"><ChevronLeft size={16} /></button>
          <div className="w-9 h-9 rounded-lg bg-white flex items-center justify-center overflow-hidden flex-shrink-0 p-1">
            {selectedOrg?.logo_path
              ? <img src={encodeURI(selectedOrg.logo_path)} alt="" className="max-h-7 max-w-full object-contain" />
              : <Building2 size={18} className="text-indigo-500" />}
          </div>
          <div className="min-w-0">
            <h1 className="text-lg font-black text-white tracking-tight leading-none truncate">{selectedOrg?.org_name || 'Organization'}</h1>
            <p className="text-sky-200/70 text-[11px] mt-0.5">Administration &amp; access control for this organization</p>
          </div>
        </div>
      </div>

      <div className="px-6 xl:px-10 py-6 max-w-[1700px] mx-auto">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {visibleModules.map((m) => {
            const Icon = m.icon;
            return (
              <button key={m.to} onClick={() => navigate(moduleHref(m))}
                className="group relative bg-white rounded-3xl border border-slate-200 overflow-hidden text-left shadow-sm hover:shadow-2xl hover:-translate-y-1.5 transition-all duration-300">
                <div className={`h-1.5 bg-gradient-to-r ${m.color}`} />
                <div className={`pointer-events-none absolute -top-12 -right-12 w-40 h-40 rounded-full bg-gradient-to-br ${m.color} opacity-0 group-hover:opacity-10 blur-3xl transition-opacity duration-500`} />
                <div className="p-6">
                  <div className="flex items-center justify-between">
                    <div className={`w-14 h-14 rounded-2xl bg-gradient-to-br ${m.color} flex items-center justify-center text-white shadow-lg group-hover:scale-110 transition-transform`}><Icon size={24} /></div>
                    {m.scope === 'global' && <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-slate-100 text-slate-500">Global</span>}
                  </div>
                  <h3 className="font-black text-slate-800 text-lg mt-4">{m.title}</h3>
                  <p className="text-sm text-slate-500 mt-1">{m.desc}</p>
                  <div className="mt-5 flex items-center gap-1.5 text-sm font-extrabold text-slate-700 group-hover:gap-2.5 transition-all">Open <ChevronRight size={16} /></div>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Hero({ title, subtitle }) {
  return (
    <div className="bg-gradient-to-r from-slate-900 via-blue-800 to-sky-700 px-6 md:px-8 pt-3 pb-4 relative overflow-hidden">
      <div className="absolute inset-0 opacity-[0.04]" style={{ backgroundImage: 'linear-gradient(#fff 1px,transparent 1px),linear-gradient(90deg,#fff 1px,transparent 1px)', backgroundSize: '28px 28px' }} />
      <div className="relative flex items-center gap-2 text-xs text-slate-300/70 mb-2.5">
        <span>ActMon</span><ChevronRight size={11} /><span className="text-white font-semibold">Administration</span>
      </div>
      <div className="relative flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg bg-sky-400/20 border border-sky-400/40 flex items-center justify-center flex-shrink-0"><Shield size={18} className="text-sky-200" /></div>
        <div>
          <h1 className="text-lg font-black text-white tracking-tight leading-none">{title}</h1>
          <p className="text-sky-200/70 text-[11px] mt-0.5">{subtitle}</p>
        </div>
      </div>
    </div>
  );
}

function CardSkeleton() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="bg-white rounded-3xl border border-slate-200 p-6 animate-pulse">
          <div className="w-full h-24 rounded-2xl bg-slate-200" />
          <div className="h-4 bg-slate-200 rounded mt-4 w-2/3" /><div className="h-3 bg-slate-100 rounded mt-2 w-1/2" />
        </div>
      ))}
    </div>
  );
}
