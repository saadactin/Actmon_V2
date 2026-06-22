/**
 * 🔐 Group Role Page Permission
 *   URL-driven drill-down (everything has a route):
 *     /role-permissions                       → Organizations (super admin)
 *     /role-permissions/:orgId                → Roles of that org
 *     /role-permissions/:orgId/:roleId        → Page-permission cards for that role
 *   - Tag-based multi-select permissions (bitwise OR → permission integer)
 *   - Fancy cards everywhere + gradient form modal
 *   (Frontend-only / mock data — backend stored procedures wired later.)
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Lock, Plus, Pencil, Trash2, Search, ChevronLeft, ChevronRight, ChevronDown, X, Shield, Check,
  RefreshCw, Building2, ArrowRight, FileText,
} from 'lucide-react';
import { useAuthStore } from '../../store/authStore';
import {
  grppApi, rolesApi, pagesApi, permissionsApi, organizationsApi, decodePermission,
} from './_shared/mockDb';

const ACCENTS = [
  { bar: 'from-indigo-500 to-blue-600',    text: 'text-indigo-600',  soft: 'bg-indigo-500',  ring: 'group-hover:border-indigo-300' },
  { bar: 'from-rose-500 to-pink-600',      text: 'text-rose-600',    soft: 'bg-rose-500',    ring: 'group-hover:border-rose-300' },
  { bar: 'from-emerald-500 to-teal-600',   text: 'text-emerald-600', soft: 'bg-emerald-500', ring: 'group-hover:border-emerald-300' },
  { bar: 'from-amber-500 to-orange-600',   text: 'text-amber-600',   soft: 'bg-amber-500',   ring: 'group-hover:border-amber-300' },
  { bar: 'from-violet-500 to-purple-600',  text: 'text-violet-600',  soft: 'bg-violet-500',  ring: 'group-hover:border-violet-300' },
  { bar: 'from-cyan-500 to-sky-600',       text: 'text-cyan-600',    soft: 'bg-cyan-500',    ring: 'group-hover:border-cyan-300' },
  { bar: 'from-fuchsia-500 to-pink-600',   text: 'text-fuchsia-600', soft: 'bg-fuchsia-500', ring: 'group-hover:border-fuchsia-300' },
];

export default function GroupRolePagePermission() {
  const navigate = useNavigate();
  const { orgId, roleId } = useParams();
  const { user } = useAuthStore();
  // TODO: drive from real auth/RBAC. Forced on during development so the full
  // Organizations → Roles → Permissions drill-down is visible.
  const DEV_FORCE_SUPER_ADMIN = true;
  const superAdmin = DEV_FORCE_SUPER_ADMIN || !!user?.is_superuser;
  const myOrgId = user?.org_id || user?.active_org_id || 1;

  const [records, setRecords] = useState([]);
  const [orgs, setOrgs] = useState([]);
  const [roles, setRoles] = useState([]);
  const [pages, setPages] = useState([]);
  const [permissions, setPermissions] = useState([]);
  const [loading, setLoading] = useState(true);

  const [formVisible, setFormVisible] = useState(false);
  const [editId, setEditId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [toast, setToast] = useState(null);
  const [selectedPerms, setSelectedPerms] = useState([]);
  const [form, setForm] = useState({ org_id: '', role_id: '', page_id: '', permission: 0 });
  const [permOpen, setPermOpen] = useState(false);
  const permRef = useRef(null);

  // close the custom permission dropdown on outside click
  useEffect(() => {
    const h = (e) => { if (permRef.current && !permRef.current.contains(e.target)) setPermOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const flash = (msg, ok = true) => { setToast({ msg, ok }); setTimeout(() => setToast(null), 2400); };

  const loadAll = async () => {
    setLoading(true);
    const [rec, og, rl, pg, pm] = await Promise.all([
      grppApi.list(), organizationsApi.list(), rolesApi.list(), pagesApi.list(), permissionsApi.list(),
    ]);
    setRecords(rec); setOrgs(og); setRoles(rl); setPages(pg); setPermissions(pm);
    setLoading(false);
  };
  useEffect(() => { loadAll(); /* eslint-disable-next-line */ }, []);

  // Org admins skip the org level → redirect to their org.
  useEffect(() => {
    if (!loading && !superAdmin && !orgId && orgs.length) {
      navigate(`/role-permissions/${myOrgId}`, { replace: true });
    }
  }, [loading, superAdmin, orgId, orgs, myOrgId, navigate]);

  const selectedOrg  = orgId ? orgs.find((o) => String(o.org_id) === String(orgId)) : null;
  const selectedRole = roleId ? roles.find((r) => String(r.role_id) === String(roleId)) : null;

  const isEditMode = editId != null;
  const pageName = (id) => pages.find((p) => Number(p.page_id) === Number(id))?.page_name || `#${id}`;
  const pageUrl  = (id) => pages.find((p) => Number(p.page_id) === Number(id))?.page_url || '';
  const roleName = (id) => roles.find((r) => Number(r.role_id) === Number(id))?.role_name || `#${id}`;
  const orgName  = (id) => orgs.find((o) => Number(o.org_id) === Number(id))?.org_name || `#${id}`;

  const orgStats  = useMemo(() => { const m = {}; roles.forEach((r) => { m[r.org_id] = (m[r.org_id] || 0) + 1; }); return m; }, [roles]);
  const roleStats = useMemo(() => { const m = {}; records.forEach((r) => { m[`${r.org_id}-${r.role_id}`] = (m[`${r.org_id}-${r.role_id}`] || 0) + 1; }); return m; }, [records]);

  const orgRoles = useMemo(
    () => (selectedOrg ? roles.filter((r) => Number(r.org_id) === Number(selectedOrg.org_id)) : []),
    [roles, selectedOrg],
  );

  const roleRecords = useMemo(() => {
    if (!selectedOrg || !selectedRole) return [];
    let list = records.filter((r) => Number(r.org_id) === Number(selectedOrg.org_id) && Number(r.role_id) === Number(selectedRole.role_id));
    if (searchText.trim()) { const q = searchText.toLowerCase(); list = list.filter((r) => pageName(r.page_id).toLowerCase().includes(q)); }
    return list;
  }, [records, selectedOrg, selectedRole, searchText, pages]);

  const assignedPageIds = useMemo(
    () => new Set(records.filter((r) => Number(r.org_id) === Number(selectedOrg?.org_id) && Number(r.role_id) === Number(selectedRole?.role_id)).map((r) => Number(r.page_id))),
    [records, selectedOrg, selectedRole],
  );

  /* ── permission tag handlers (bitwise) ── */
  const sumPerms = (list) => list.reduce((s, p) => s + Number(p.permission_value), 0);
  const addPerm = (val) => {
    if (!val) return;
    const perm = permissions.find((p) => Number(p.permission_value) === Number(val));
    if (perm && !selectedPerms.some((s) => s.permission_id === perm.permission_id)) {
      const list = [...selectedPerms, perm];
      setSelectedPerms(list); setForm((f) => ({ ...f, permission: sumPerms(list) }));
    }
  };
  const removePerm = (val) => {
    const list = selectedPerms.filter((p) => p.permission_value !== val);
    setSelectedPerms(list); setForm((f) => ({ ...f, permission: sumPerms(list) }));
  };
  const togglePerm = (p) => {
    const on = selectedPerms.some((s) => s.permission_id === p.permission_id);
    const list = on ? selectedPerms.filter((s) => s.permission_id !== p.permission_id) : [...selectedPerms, p];
    setSelectedPerms(list); setForm((f) => ({ ...f, permission: sumPerms(list) }));
  };

  const openAdd = () => {
    setEditId(null);
    setForm({ org_id: selectedOrg.org_id, role_id: selectedRole.role_id, page_id: '', permission: 0 });
    setSelectedPerms([]); setPermOpen(false); setFormVisible(true);
  };
  const openEdit = (rec) => {
    setEditId(rec.page_permission_id);
    setForm({ org_id: rec.org_id, role_id: rec.role_id, page_id: rec.page_id, permission: rec.permission || 0 });
    setSelectedPerms(permissions.filter((p) => (Number(rec.permission) & p.permission_value) === p.permission_value));
    setPermOpen(false); setFormVisible(true);
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!form.org_id || !form.role_id || !form.page_id) { flash('Select all required fields', false); return; }
    setSaving(true);
    try {
      const permission_description = selectedPerms.map((p) => p.permission_name).join('/') || 'No access';
      if (isEditMode) { await grppApi.update(editId, { permission: form.permission, permission_description }); flash('Permission updated'); }
      else { await grppApi.create({ org_id: +form.org_id, role_id: +form.role_id, page_id: +form.page_id, permission: form.permission, permission_description }); flash('Permission added'); }
      setFormVisible(false); setEditId(null); await loadAll();
    } catch (err) { flash(err.message || 'Save failed', false); }
    finally { setSaving(false); }
  };

  const del = async (id) => {
    if (!window.confirm('Delete this permission?')) return;
    await grppApi.remove(id); flash('Deleted'); await loadAll();
  };

  const crumb = selectedRole ? `${orgName(selectedOrg.org_id)} → ${selectedRole.role_name}`
    : selectedOrg ? `${selectedOrg.org_name} → Roles` : 'Organizations';
  const goBack = () => {
    if (roleId) navigate(`/role-permissions/${orgId}`);
    else if (orgId && superAdmin) navigate('/role-permissions');
    else navigate('/administration');
  };

  /* ════════════════ RENDER ════════════════ */
  return (
    <div className="min-h-screen bg-[#f1f5f9] p-4 sm:p-6">
      <div className="max-w-[1400px] mx-auto">
        {/* Hero header */}
        <div className="rounded-2xl bg-gradient-to-br from-slate-900 via-slate-800 to-rose-950 px-5 sm:px-7 py-6 mb-6 relative overflow-hidden">
          <div className="absolute inset-0 opacity-[0.04]"
            style={{ backgroundImage: 'linear-gradient(#fff 1px,transparent 1px),linear-gradient(90deg,#fff 1px,transparent 1px)', backgroundSize: '28px 28px' }} />
          <div className="relative flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3 min-w-0">
              <button onClick={goBack} className="w-9 h-9 rounded-xl bg-white/10 border border-white/15 flex items-center justify-center text-white hover:bg-white/20 flex-shrink-0">
                <ChevronLeft size={18} />
              </button>
              <div className="w-11 h-11 rounded-xl bg-rose-500/20 border border-rose-400/30 flex items-center justify-center flex-shrink-0">
                <Lock size={22} className="text-rose-300" />
              </div>
              <div className="min-w-0">
                <h1 className="text-base sm:text-2xl font-black text-white tracking-tight leading-none truncate">{crumb}</h1>
                <p className="text-slate-400 text-xs mt-1">
                  {!selectedOrg ? 'Select an organization' : !selectedRole ? 'Select a role to manage its page permissions' : 'Manage page permissions for this role'}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={loadAll} className="h-10 w-10 rounded-xl bg-white/10 border border-white/15 flex items-center justify-center text-white hover:bg-white/20">
                <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
              </button>
              {selectedRole && (
                <button onClick={openAdd} className="h-10 px-4 sm:px-5 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-bold text-sm flex items-center gap-2 shadow-lg">
                  <Plus size={16} /> <span className="hidden sm:inline">Add Page Permission</span><span className="sm:hidden">Add</span>
                </button>
              )}
            </div>
          </div>
        </div>

        {/* LEVEL 0 — Organizations */}
        {!selectedOrg && (loading ? <CardSkeleton /> : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {orgs.map((o, i) => {
              const a = ACCENTS[i % ACCENTS.length];
              return (
                <button key={o.org_id} onClick={() => navigate(`/role-permissions/${o.org_id}`)}
                  className={`group relative bg-white rounded-3xl border border-slate-200 ${a.ring} overflow-hidden text-left shadow-sm hover:shadow-2xl hover:-translate-y-1.5 transition-all duration-300`}>
                  <div className={`h-1.5 bg-gradient-to-r ${a.bar}`} />
                  <div className={`pointer-events-none absolute -top-12 -right-12 w-40 h-40 rounded-full ${a.soft} opacity-0 group-hover:opacity-10 blur-3xl transition-opacity duration-500`} />
                  {o.parent_org_id === 0 && <span className={`absolute top-4 left-4 z-10 text-[10px] font-black px-2.5 py-1 rounded-full bg-gradient-to-r ${a.bar} text-white shadow-md`}>★ HQ</span>}
                  <span className="absolute top-4 right-4 z-10 inline-flex items-center gap-1 text-[11px] font-bold px-2.5 py-1 rounded-full bg-white/80 backdrop-blur text-slate-600 border border-slate-200 shadow-sm">
                    <Shield size={11} className={a.text} /> {orgStats[o.org_id] || 0} roles
                  </span>
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
                    <h3 className="font-black text-slate-800 text-lg leading-tight truncate">{o.org_name}</h3>
                    <p className="text-xs text-slate-400 font-semibold mt-1 tracking-wide uppercase">{o.org_code} · {o.city_name}</p>
                    <div className="mt-5 flex items-center justify-between">
                      <span className={`text-sm font-extrabold ${a.text}`}>Manage Access Control</span>
                      <span className={`w-9 h-9 rounded-xl bg-gradient-to-br ${a.bar} text-white flex items-center justify-center shadow-lg group-hover:translate-x-1 transition-transform`}><ArrowRight size={17} /></span>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        ))}

        {/* LEVEL 1 — Roles */}
        {selectedOrg && !selectedRole && (loading ? <CardSkeleton /> : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
            {orgRoles.length === 0 && <p className="text-slate-400 col-span-full text-center py-10">No roles in this organization.</p>}
            {orgRoles.map((role, i) => {
              const a = ACCENTS[i % ACCENTS.length];
              return (
                <button key={role.role_id} onClick={() => { setSearchText(''); navigate(`/role-permissions/${selectedOrg.org_id}/${role.role_id}`); }}
                  className={`group relative bg-white rounded-2xl border border-slate-200 ${a.ring} overflow-hidden p-5 text-left shadow-sm hover:shadow-2xl hover:-translate-y-1 transition-all duration-300`}>
                  <div className={`pointer-events-none absolute -top-10 -right-10 w-32 h-32 rounded-full ${a.soft} opacity-0 group-hover:opacity-10 blur-3xl transition-opacity duration-500`} />
                  <div className="flex items-center justify-between">
                    <div className={`w-12 h-12 rounded-2xl bg-gradient-to-br ${a.bar} flex items-center justify-center text-white shadow-lg group-hover:scale-110 transition-transform`}><Shield size={22} /></div>
                    <span className={`text-[11px] font-bold px-2.5 py-1 rounded-full bg-slate-50 border border-slate-200 ${a.text}`}>{roleStats[`${selectedOrg.org_id}-${role.role_id}`] || 0} pages</span>
                  </div>
                  <h3 className="font-black text-slate-800 text-base mt-4 truncate">{role.role_name}</h3>
                  <p className="text-xs text-slate-500 mt-0.5 line-clamp-1">{role.role_description || 'No description'}</p>
                  <div className="mt-4 flex items-center justify-between">
                    <span className={`text-xs font-extrabold ${a.text}`}>Manage Permission</span>
                    <ChevronRight size={16} className={`${a.text} group-hover:translate-x-1 transition-transform`} />
                  </div>
                </button>
              );
            })}
          </div>
        ))}

        {/* LEVEL 2 — Page-permission cards */}
        {selectedOrg && selectedRole && (
          <>
            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-3 mb-4 flex items-center gap-3">
              <div className="relative flex-1 max-w-md">
                <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input value={searchText} onChange={(e) => setSearchText(e.target.value)} placeholder="Search page name…"
                  className="w-full h-10 pl-9 pr-3 rounded-xl bg-slate-50 border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-rose-200 focus:border-rose-400" />
              </div>
              <span className="inline-flex items-center gap-1.5 text-xs text-slate-500 font-bold ml-auto px-3 py-1.5 rounded-full bg-slate-100">
                <span className="w-1.5 h-1.5 rounded-full bg-rose-500" />{roleRecords.length} record{roleRecords.length !== 1 ? 's' : ''}
              </span>
            </div>

            {roleRecords.length === 0 ? (
              <div className="bg-white rounded-3xl border border-slate-200 shadow-sm py-16 text-center">
                <div className="w-14 h-14 mx-auto rounded-2xl bg-slate-100 flex items-center justify-center mb-3"><FileText className="text-slate-300" size={26} /></div>
                <p className="text-slate-500 font-bold">No page permissions yet</p>
                <p className="text-slate-400 text-sm mt-1">Click <b>Add Page Permission</b> to grant access.</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
                {roleRecords.map((r, i) => {
                  const a = ACCENTS[i % ACCENTS.length];
                  const perms = decodePermission(r.permission);
                  return (
                    <div key={r.page_permission_id}
                      className={`group relative bg-white rounded-2xl border border-slate-200 ${a.ring} overflow-hidden shadow-sm hover:shadow-2xl hover:-translate-y-1 transition-all duration-300`}>
                      <div className={`h-1.5 bg-gradient-to-r ${a.bar}`} />
                      <div className={`pointer-events-none absolute -top-10 -right-10 w-32 h-32 rounded-full ${a.soft} opacity-0 group-hover:opacity-[0.08] blur-3xl transition-opacity duration-500`} />
                      <div className="p-5">
                        <div className="flex items-start gap-3">
                          <div className={`w-11 h-11 rounded-xl bg-gradient-to-br ${a.bar} flex items-center justify-center text-white shadow-lg flex-shrink-0`}><FileText size={19} /></div>
                          <div className="min-w-0 flex-1">
                            <h3 className="font-black text-slate-800 truncate leading-tight">{pageName(r.page_id)}</h3>
                            <span className="text-[11px] font-mono text-slate-400 truncate block">{pageUrl(r.page_id) || `Page #${r.page_id}`}</span>
                          </div>
                        </div>
                        <div className="mt-4">
                          <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">Permissions</p>
                          <div className="flex flex-wrap gap-1.5">
                            {perms.length ? perms.map((p) => (
                              <span key={p} className="text-[10px] font-bold px-2 py-0.5 rounded-md bg-indigo-50 text-indigo-700 border border-indigo-100">{p}</span>
                            )) : <span className="text-slate-300 text-xs">No access</span>}
                          </div>
                        </div>
                      </div>
                      <div className="px-5 py-3 border-t border-slate-100 bg-slate-50/40 flex items-center justify-between">
                        <span className="text-[11px] font-mono text-slate-400">bitmask {r.permission}</span>
                        <div className="flex items-center gap-1">
                          <button onClick={() => openEdit(r)} title="Edit" className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:bg-indigo-50 hover:text-indigo-600"><Pencil size={15} /></button>
                          <button onClick={() => del(r.page_permission_id)} title="Delete" className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:bg-red-50 hover:text-red-600"><Trash2 size={15} /></button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>

      {/* Fancy full-screen form */}
      {formVisible && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex sm:items-center sm:justify-center sm:p-6" onClick={() => setFormVisible(false)}>
          <form onSubmit={submit} onClick={(e) => e.stopPropagation()}
            className="bg-white w-full h-full sm:h-[94vh] sm:max-w-4xl sm:rounded-3xl shadow-2xl flex flex-col overflow-hidden sm:animate-[fadeIn_.18s_ease-out]">
            {/* gradient header */}
            <div className="flex items-center justify-between px-6 sm:px-8 py-5 bg-gradient-to-r from-slate-900 via-slate-800 to-rose-900 text-white">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-2xl bg-white/10 border border-white/15 flex items-center justify-center text-rose-200"><Lock size={24} /></div>
                <div>
                  <h2 className="text-lg sm:text-xl font-black leading-none">{isEditMode ? 'Edit' : 'Add'} Page Permission</h2>
                  <p className="text-xs text-white/60 mt-1.5">{isEditMode ? 'Update permissions for this page' : 'Grant a page to this role'}</p>
                </div>
              </div>
              <button type="button" onClick={() => setFormVisible(false)} className="w-10 h-10 rounded-xl flex items-center justify-center text-white/70 hover:bg-white/15"><X size={20} /></button>
            </div>

            {/* body */}
            <div className="flex-1 overflow-y-auto bg-slate-50/60">
              <div className="max-w-3xl mx-auto px-6 sm:px-8 py-7 space-y-6">
                {/* context card */}
                <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 sm:p-8">
                  <div className="flex items-center gap-2 mb-6">
                    <span className="w-1 h-5 rounded-full bg-gradient-to-b from-rose-500 to-pink-500" />
                    <h3 className="text-sm font-black text-slate-700 uppercase tracking-wider">Scope</h3>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-x-6 gap-y-5">
                    <Ghost label="Organization" value={orgName(form.org_id)} />
                    <Ghost label="Role" value={roleName(form.role_id)} />
                    <div>
                      <label className="block text-[11px] font-black text-slate-500 uppercase tracking-wider mb-2">Page <span className="text-red-500">*</span></label>
                      {isEditMode ? <Ghost value={pageName(form.page_id)} bare /> : (
                        <div className="relative">
                          <select value={form.page_id} onChange={(e) => setForm((f) => ({ ...f, page_id: e.target.value }))} required
                            className={`w-full h-11 px-3.5 pr-10 rounded-xl border border-slate-200 bg-white text-sm font-semibold appearance-none transition-all focus:outline-none focus:ring-4 focus:ring-rose-100 focus:border-rose-400 hover:border-slate-300 ${form.page_id ? 'text-slate-800' : 'text-slate-400'}`}>
                            <option value="">Select Page</option>
                            {pages.filter((p) => !assignedPageIds.has(Number(p.page_id))).map((p) => (
                              <option key={p.page_id} value={p.page_id} className="text-slate-800">{p.page_name}{p.page_url ? ` (${p.page_url})` : ''}</option>
                            ))}
                          </select>
                          <ChevronDown size={16} className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {/* permissions card */}
                <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 sm:p-8">
                  <div className="flex items-center gap-2 mb-6">
                    <span className="w-1 h-5 rounded-full bg-gradient-to-b from-indigo-500 to-violet-500" />
                    <h3 className="text-sm font-black text-slate-700 uppercase tracking-wider">Permissions</h3>
                  </div>
                  {/* Custom multi-select dropdown */}
                  <div className="relative max-w-md" ref={permRef}>
                    <button type="button" onClick={() => setPermOpen((o) => !o)}
                      className={`w-full h-11 px-3.5 pr-10 rounded-xl border bg-white text-sm font-semibold text-left flex items-center transition-all hover:border-slate-300 focus:outline-none focus:ring-4 focus:ring-indigo-100 ${permOpen ? 'border-indigo-400 ring-4 ring-indigo-100' : 'border-slate-200'} ${selectedPerms.length ? 'text-slate-800' : 'text-slate-400'}`}>
                      {selectedPerms.length ? `${selectedPerms.length} permission${selectedPerms.length > 1 ? 's' : ''} selected` : 'Select permissions…'}
                      <ChevronDown size={16} className={`absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-400 transition-transform ${permOpen ? 'rotate-180' : ''}`} />
                    </button>
                    {permOpen && (
                      <div className="absolute z-30 mt-2 w-full bg-white rounded-2xl border border-slate-200 shadow-2xl p-1.5 max-h-72 overflow-y-auto">
                        {permissions.map((p) => {
                          const on = selectedPerms.some((s) => s.permission_id === p.permission_id);
                          return (
                            <button type="button" key={p.permission_id} onClick={() => togglePerm(p)}
                              className={`w-full flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl text-sm transition-colors ${on ? 'bg-indigo-50' : 'hover:bg-slate-50'}`}>
                              <span className="flex items-center gap-2.5">
                                <span className={`w-5 h-5 rounded-md flex items-center justify-center border ${on ? 'bg-gradient-to-br from-indigo-600 to-violet-600 border-transparent text-white' : 'border-slate-300 bg-white'}`}>
                                  {on && <Check size={13} />}
                                </span>
                                <span className={`font-semibold ${on ? 'text-indigo-700' : 'text-slate-700'}`}>{p.permission_name}</span>
                              </span>
                              <span className="text-[11px] font-mono text-slate-400">{p.permission_value}</span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* Selected chips (below, never overlapped) */}
                  <div className="flex flex-wrap gap-2 mt-4 min-h-[40px]">
                    {selectedPerms.length === 0 && <span className="text-sm text-slate-400 py-2">No permissions selected yet — pick from the dropdown above.</span>}
                    {selectedPerms.map((perm) => (
                      <span key={perm.permission_id} className="inline-flex items-center gap-2 pl-3.5 pr-2 py-2 rounded-xl bg-gradient-to-r from-indigo-600 to-violet-600 text-white text-sm font-bold shadow">
                        <Check size={13} />{perm.permission_name}
                        <button type="button" onClick={() => removePerm(perm.permission_value)} className="w-5 h-5 rounded-lg flex items-center justify-center hover:bg-white/20"><X size={13} /></button>
                      </span>
                    ))}
                  </div>
                  <p className="text-xs text-slate-400 mt-4">Computed bitmask value: <b className="text-slate-700">{form.permission}</b></p>
                </div>
              </div>
            </div>

            {/* sticky footer */}
            <div className="px-6 sm:px-8 py-4 border-t border-slate-200 flex items-center justify-end gap-3 bg-white">
              <button type="button" onClick={() => setFormVisible(false)} className="h-11 px-6 rounded-xl bg-slate-100 text-slate-600 font-bold text-sm hover:bg-slate-200">Cancel</button>
              <button type="submit" disabled={saving} className="h-11 px-8 rounded-xl bg-gradient-to-r from-rose-600 to-pink-600 hover:from-rose-500 hover:to-pink-500 text-white font-bold text-sm shadow-lg disabled:opacity-60 transition-all">
                {saving ? 'Saving…' : isEditMode ? 'Update Permission' : 'Save Permission'}
              </button>
            </div>
          </form>
        </div>
      )}

      {toast && (
        <div className={`fixed bottom-6 right-6 z-50 px-4 py-3 rounded-xl shadow-xl text-sm font-bold text-white flex items-center gap-2 ${toast.ok ? 'bg-emerald-600' : 'bg-red-600'}`}>
          <Check size={16} /> {toast.msg}
        </div>
      )}
    </div>
  );
}

function Ghost({ label, value, bare }) {
  return (
    <div>
      {!bare && label && <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1.5">{label}</label>}
      <input value={value} disabled className="w-full h-10 px-3 rounded-xl border border-slate-200 bg-slate-100 text-slate-500 text-sm font-semibold" />
    </div>
  );
}

function CardSkeleton() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="bg-white rounded-3xl border border-slate-200 p-6 animate-pulse">
          <div className="w-full h-24 rounded-2xl bg-slate-200" />
          <div className="h-4 bg-slate-200 rounded mt-4 w-2/3" />
          <div className="h-3 bg-slate-100 rounded mt-2 w-1/2" />
        </div>
      ))}
    </div>
  );
}
