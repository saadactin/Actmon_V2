import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Shield,
  KeyRound,
  UserCog,
  Users,
  Network,
  IdCard,
  Lock,
  ChevronLeft,
  Building2
} from 'lucide-react';
import { organizationsApi } from '../../api/admin';

const CHILD_MODULES = [
  { key: 'roles', label: 'Roles', icon: Shield, route: 'roles', subtitle: 'Organization roles' },
  { key: 'users', label: 'User Master', icon: UserCog, route: 'users', subtitle: 'User accounts for this org' },
  { key: 'employees', label: 'Employees', icon: Users, route: 'employees', subtitle: 'Employee records for this org' },
  { key: 'departments', label: 'Departments', icon: Network, route: 'departments', subtitle: 'Organizational departments' },
  { key: 'designations', label: 'Designations', icon: IdCard, route: 'designations', subtitle: 'Job titles and designations' },
  { key: 'permissions', label: 'Permissions', icon: KeyRound, route: 'permissions', subtitle: 'Permission types and bitmask values' },
  { key: 'role-permissions', label: 'Role Permissions', icon: Lock, route: '../role-permissions', subtitle: 'Assign page permissions by role' },
];

export default function AdministrationOrganizationDetailPage() {
  const { orgId } = useParams();
  const navigate = useNavigate();
  const [organization, setOrganization] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let active = true;
    const load = async () => {
      setLoading(true);
      try {
        const org = await organizationsApi.get(orgId);
        if (!active) return;
        if (!org) {
          setError('Organization not found');
          return;
        }
        setOrganization(org);
      } catch (err) {
        setError(err.message || 'Failed to load organization');
      } finally {
        if (active) setLoading(false);
      }
    };
    if (orgId) load();
    return () => { active = false; };
  }, [orgId]);

  const handleNavigate = (route) => {
    if (route === '../role-permissions') {
      navigate(`/administration/role-permissions/${orgId}`);
      return;
    }
    navigate(`/administration/organizations/${orgId}/${route}`);
  };

  return (
    <div className="min-h-screen bg-[#f1f5f9] p-4 sm:p-6">
      <div className="max-w-[1400px] mx-auto">
        <div className="rounded-2xl bg-gradient-to-br from-slate-900 via-slate-800 to-indigo-950 px-7 py-7 mb-7 relative overflow-hidden">
          <div className="absolute inset-0 opacity-[0.04]"
            style={{ backgroundImage: 'linear-gradient(#fff 1px,transparent 1px),linear-gradient(90deg,#fff 1px,transparent 1px)', backgroundSize: '28px 28px' }} />
          <div className="relative flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-4 min-w-0">
              <button onClick={() => navigate('/administration/organizations')}
                className="w-11 h-11 rounded-xl bg-white/10 border border-white/15 flex items-center justify-center text-white hover:bg-white/20 transition-all">
                <ChevronLeft size={20} />
              </button>
              <div className="w-12 h-12 rounded-xl bg-indigo-500/20 border border-indigo-400/30 flex items-center justify-center text-indigo-300">
                <Building2 size={24} />
              </div>
              <div className="min-w-0">
                <h1 className="text-2xl font-black text-white tracking-tight leading-none">Organization</h1>
                <p className="text-slate-400 text-sm mt-1">Manage org-specific roles, users, employees, departments and designations.</p>
              </div>
            </div>
          </div>
        </div>

        {loading ? (
          <div className="rounded-3xl bg-white border border-slate-200 shadow-sm p-8 animate-pulse" />
        ) : error ? (
          <div className="rounded-3xl bg-white border border-red-200 text-red-700 shadow-sm p-8">{error}</div>
        ) : (
          <>
            <div className="grid gap-6 xl:grid-cols-[1.4fr,0.9fr] mb-6">
              <div className="rounded-3xl bg-white border border-slate-200 shadow-sm p-6">
                <div className="flex flex-col gap-4">
                  <div className="flex flex-wrap items-center gap-4">
                    <div className="w-14 h-14 rounded-3xl bg-indigo-50 flex items-center justify-center text-indigo-700 font-black text-lg">
                      {organization.org_code?.slice(0, 2) || 'OG'}
                    </div>
                    <div>
                      <h2 className="text-2xl font-black text-slate-900 truncate">{organization.org_name}</h2>
                      <p className="text-sm text-slate-500">{organization.org_code} • {organization.city_name || 'No city specified'}</p>
                    </div>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="rounded-2xl bg-slate-50 p-4">
                      <p className="text-xs uppercase tracking-[0.24em] text-slate-400">Status</p>
                      <p className="mt-2 font-semibold text-slate-900">{organization.is_active ? 'Active' : 'Inactive'}</p>
                    </div>
                    <div className="rounded-2xl bg-slate-50 p-4">
                      <p className="text-xs uppercase tracking-[0.24em] text-slate-400">Parent</p>
                      <p className="mt-2 font-semibold text-slate-900">{organization.parent_org_id ? `Child of #${organization.parent_org_id}` : 'Headquarters'}</p>
                    </div>
                  </div>
                </div>
              </div>
              <div className="rounded-3xl bg-white border border-slate-200 shadow-sm p-6">
                <h3 className="text-lg font-bold text-slate-900 mb-4">Quick actions</h3>
                <div className="grid gap-3 sm:grid-cols-2">
                  {CHILD_MODULES.slice(0, 4).map((item) => {
                    const Icon = item.icon;
                    return (
                      <button key={item.key} onClick={() => handleNavigate(item.route)}
                        className="rounded-3xl border border-slate-200 p-4 flex items-center gap-4 text-left hover:border-indigo-300 hover:shadow-sm transition-all">
                        <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-indigo-500/10 text-indigo-700">
                          <Icon size={18} />
                        </span>
                        <div>
                          <p className="font-semibold text-slate-900">{item.label}</p>
                          <p className="text-sm text-slate-500">{item.subtitle}</p>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="rounded-3xl bg-white border border-slate-200 shadow-sm p-6">
              <h3 className="text-lg font-bold text-slate-900 mb-6">All organization modules</h3>
              <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
                {CHILD_MODULES.map((item) => {
                  const Icon = item.icon;
                  return (
                    <button key={item.key} onClick={() => handleNavigate(item.route)}
                      className="rounded-3xl border border-slate-200 p-4 text-left hover:border-indigo-300 hover:shadow-sm transition-all flex items-center gap-4">
                      <span className="flex h-12 w-12 items-center justify-center rounded-3xl bg-slate-100 text-slate-700">
                        <Icon size={20} />
                      </span>
                      <div>
                        <p className="font-semibold text-slate-900">{item.label}</p>
                        <p className="text-sm text-slate-500">{item.subtitle}</p>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
