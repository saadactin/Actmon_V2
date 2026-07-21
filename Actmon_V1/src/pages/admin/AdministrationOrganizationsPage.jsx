import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Building2, Shield, KeyRound, UserCog, Users, Network, IdCard } from 'lucide-react';
import { organizationsApi } from '../../api/admin';

const CHILD_MODULES = [
  { key: 'roles', label: 'Roles', icon: Shield },
  { key: 'permissions', label: 'Permissions', icon: KeyRound },
  { key: 'users', label: 'User Master', icon: UserCog },
  { key: 'employees', label: 'Employees', icon: Users },
  { key: 'departments', label: 'Departments', icon: Network },
  { key: 'designations', label: 'Designations', icon: IdCard },
];

export default function AdministrationOrganizationsPage() {
  const [organizations, setOrganizations] = useState([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    let active = true;
    const loadOrganizations = async () => {
      try {
        const data = await organizationsApi.list();
        if (!active) return;
        setOrganizations(data || []);
      } finally {
        if (active) setLoading(false);
      }
    };
    loadOrganizations();
    return () => { active = false; };
  }, []);

  return (
    <div className="min-h-screen bg-[#f1f5f9] p-4 sm:p-6">
      <div className="max-w-[1750px] mx-auto px-4">
        <div className="rounded-2xl bg-gradient-to-br from-slate-900 via-slate-800 to-indigo-950 px-7 py-7 mb-7 relative overflow-hidden">
          <div className="absolute inset-0 opacity-[0.04]"
            style={{ backgroundImage: 'linear-gradient(#fff 1px,transparent 1px),linear-gradient(90deg,#fff 1px,transparent 1px)', backgroundSize: '28px 28px' }} />
          <div className="relative flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-4 min-w-0">
              <div className="w-12 h-12 rounded-xl bg-indigo-500/20 border border-indigo-400/30 flex items-center justify-center text-indigo-300">
                <Building2 size={24} />
              </div>
              <div>
                <h1 className="text-2xl font-black text-white tracking-tight leading-none">Administration</h1>
                <p className="text-slate-400 text-sm mt-1">Start with organizations, then manage roles, permissions, users, employees and organization child modules.</p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {CHILD_MODULES.slice(0, 3).map((item) => {
                const Icon = item.icon;
                return (
                  <div key={item.key} className="rounded-2xl bg-white/10 border border-white/15 p-3 text-white flex items-center gap-3">
                    <div className="w-10 h-10 rounded-2xl bg-white/10 flex items-center justify-center text-slate-100">
                      <Icon size={18} />
                    </div>
                    <span className="font-semibold text-sm">{item.label}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between mb-4">
          <div>
            <h2 className="text-xl font-black text-slate-900">Organizations</h2>
            <p className="text-slate-500 text-sm mt-1">Select an organization to manage its roles, users, employees, departments and designations.</p>
          </div>
        </div>

        {loading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {Array.from({ length: 6 }).map((_, index) => (
              <div key={index} className="h-44 rounded-3xl bg-white border border-slate-200 shadow-sm animate-pulse" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {organizations.map((org) => (
              <button key={org.org_id} onClick={() => navigate(`/administration/organizations/${org.org_id}`)}
                className="group relative bg-white rounded-3xl border border-slate-200 p-6 text-left shadow-sm hover:shadow-xl transition-all duration-300">
                <div className="flex items-center justify-between gap-3 mb-5">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-400">Organization</p>
                    <h3 className="text-xl font-black text-slate-900 truncate">{org.org_name}</h3>
                  </div>
                  <div className="w-12 h-12 rounded-2xl bg-indigo-500/10 text-indigo-600 flex items-center justify-center text-lg font-bold">
                    {org.org_code?.slice(0, 2) || 'OG'}
                  </div>
                </div>
                <div className="text-slate-500 text-sm mb-4 line-clamp-2">{org.city_name || 'No city specified'}</div>
                <div className="flex flex-wrap gap-2 text-[11px] uppercase tracking-[0.18em] text-slate-500 font-semibold">
                  <span className="px-3 py-1 bg-slate-100 rounded-full">{org.status_name || (org.is_active ? 'Active' : 'Inactive')}</span>
                  {org.parent_org_id ? <span className="px-3 py-1 bg-slate-100 rounded-full">Child Org</span> : <span className="px-3 py-1 bg-slate-100 rounded-full">Headquarters</span>}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
