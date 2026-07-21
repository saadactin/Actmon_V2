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
  RefreshCw, Building2, ArrowRight, FileText, Copy, Loader2,
} from 'lucide-react';
import { useAuthStore } from '../../store/authStore';
import {
  rolesApi, pagesApi, permissionsApi, organizationsApi, rolePermissionsApi, modulesApi,
} from '../../api/admin';

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
  // Only the real super admin (role 1 + org 1) sees the org picker; everyone else
  // is locked to their own organization (backend enforces this too).
  const superAdmin = !!user?.is_superuser;
  const myOrgId = user?.org_id || user?.active_org_id || 1;

  const [records, setRecords] = useState([]);
  const [orgs, setOrgs] = useState([]);
  const [roles, setRoles] = useState([]);
  const [pages, setPages] = useState([]);
  const [modules, setModules] = useState([]);
  const [permissions, setPermissions] = useState([]);
  const [loading, setLoading] = useState(true);

  // cascading page picker (Add form): module → parent page → child page
  const [pickModule, setPickModule] = useState('');
  const [pickParent, setPickParent] = useState('');

  const [formVisible, setFormVisible] = useState(false);
  const [editId, setEditId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [treeStack, setTreeStack] = useState([]); // drill path: [{page_id, page_name}]
  const [toast, setToast] = useState(null);
  const [selectedPerms, setSelectedPerms] = useState([]);
  const [form, setForm] = useState({ org_id: '', role_id: '', page_id: '', permission: 0 });
  const [permOpen, setPermOpen] = useState(false);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [cloneTarget, setCloneTarget] = useState('');
  const [cloneMode, setCloneMode] = useState('merge');
  const [cloning, setCloning] = useState(false);
  const permRef = useRef(null);

  // close the custom permission dropdown on outside click
  useEffect(() => {
    const h = (e) => { if (permRef.current && !permRef.current.contains(e.target)) setPermOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const flash = (msg, ok = true) => { setToast({ msg, ok }); setTimeout(() => setToast(null), 2400); };

  // master data (orgs / roles / pages / permissions) — load once
  const loadAll = async () => {
    setLoading(true);
    const [og, rl, pg, pm, md] = await Promise.all([
      organizationsApi.list(), rolesApi.list(), pagesApi.list(), permissionsApi.list(), modulesApi.list(),
    ]);
    setOrgs(og); setRoles(rl); setPages(pg); setPermissions(pm); setModules(md);
    setLoading(false);
  };
  useEffect(() => { loadAll(); /* eslint-disable-next-line */ }, []);

  // grpp records are org-scoped — (re)load whenever an org is selected
  const loadRecords = async () => {
    if (!orgId) { setRecords([]); return; }
    try { setRecords(await rolePermissionsApi.list(orgId)); } catch { setRecords([]); }
  };
  useEffect(() => { loadRecords(); /* eslint-disable-next-line */ }, [orgId]);

  // decode a bitmask → permission names (from the real permission catalog, excl. Full Access)
  const decodePermission = (mask) => permissions
    .filter((p) => p.permission_name?.toLowerCase() !== 'full access' && (Number(mask) & p.permission_value) === p.permission_value)
    .map((p) => p.permission_name);
  const selectablePerms = permissions.filter((p) => Number(p.permission_value) !== 255 && p.permission_name?.toLowerCase() !== 'full access');

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

  // Hide the user's OWN role — nobody may edit the permissions of the role they're logged in with.
  const isOwnRole = (r) => Number(r.role_id) === Number(user?.role_id) && Number(r.org_id) === Number(user?.org_id);
  // Hide the signed-in user's own role to avoid self-lockout — EXCEPT for a
  // super admin, who may view (read-only) their own role here. The own-role
  // view is already gated read-only via `ownRoleOpen` (no Add/Edit/Delete).
  const orgRoles = useMemo(
    () => (selectedOrg ? roles.filter((r) => Number(r.org_id) === Number(selectedOrg.org_id) && (superAdmin || !isOwnRole(r))) : []),
    [roles, selectedOrg, user, superAdmin],
  );
  // True when the currently-opened role is the logged-in user's own role (e.g. via direct URL).
  const ownRoleOpen = !!(selectedRole && isOwnRole(selectedRole));

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

  /* ── Hierarchical drill-down (parent → child → sub-child) ───────────────── */
  // page_master.parent_id points to another page_id (0 = top-level).
  // full granted set for this role, ignoring the search box (the tree is built from this)
  const grantedAll = useMemo(() => {
    if (!selectedOrg || !selectedRole) return [];
    return records.filter((r) => Number(r.org_id) === Number(selectedOrg.org_id) && Number(r.role_id) === Number(selectedRole.role_id));
  }, [records, selectedOrg, selectedRole]);

  const pageById = useMemo(() => { const m = {}; pages.forEach((p) => { m[Number(p.page_id)] = p; }); return m; }, [pages]);
  const grantedIds = useMemo(() => new Set(grantedAll.map((r) => Number(r.page_id))), [grantedAll]);
  // A record's effective parent = its parent_id IF that parent is also granted; otherwise it floats to root (0)
  // so nothing ever disappears when a child is granted without its parent.
  const effParent = (r) => { const pid = Number(pageById[Number(r.page_id)]?.parent_id || 0); return pid && grantedIds.has(pid) ? pid : 0; };
  const childCountOf = useMemo(() => {
    const m = {};
    grantedAll.forEach((r) => { const ep = effParent(r); m[ep] = (m[ep] || 0) + 1; });
    return m;
  }, [grantedAll, grantedIds, pageById]);

  const curParent = treeStack.length ? Number(treeStack[treeStack.length - 1].page_id) : 0;
  const searching = !!searchText.trim();

  // Cards shown at the current level (or flat results while searching).
  const levelRecords = useMemo(() => {
    if (searching) {
      const q = searchText.toLowerCase();
      return grantedAll.filter((r) => pageName(r.page_id).toLowerCase().includes(q));
    }
    return grantedAll.filter((r) => effParent(r) === curParent);
  }, [grantedAll, searching, searchText, curParent, grantedIds, pageById]);

  // all-pages parent→children map (used to cascade a parent grant down to its children)
  const childrenByParent = useMemo(() => {
    const m = {};
    pages.forEach((p) => { const pid = Number(p.parent_id || 0); (m[pid] = m[pid] || []).push(p); });
    return m;
  }, [pages]);
  const descendantsOf = (pageId) => {
    const out = []; const stack = [...(childrenByParent[Number(pageId)] || [])];
    while (stack.length) { const p = stack.pop(); out.push(p); stack.push(...(childrenByParent[Number(p.page_id)] || [])); }
    return out;
  };

  // ── cascading page picker options (Add form) ──
  const moduleId = (p) => Number(p.module_id || 0);
  const parentPagesOf = (modId) => pages.filter((p) => moduleId(p) === Number(modId) && !Number(p.parent_id || 0));
  const childPagesOf = (parentId) => pages.filter((p) => Number(p.parent_id || 0) === Number(parentId));
  const isGranted = (pageId) => grantedAll.some((r) => Number(r.page_id) === Number(pageId));

  const drillInto = (r) => setTreeStack((s) => [...s, { page_id: Number(r.page_id), page_name: pageName(r.page_id) }]);
  const drillTo = (idx) => setTreeStack((s) => s.slice(0, idx)); // idx = number of crumbs to keep (0 = root)

  // reset drill path when switching role / org
  useEffect(() => { setTreeStack([]); setSearchText(''); }, [roleId, orgId]);

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
    setPickModule(''); setPickParent('');
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
      const permission_description = selectedPerms.map((p) => p.permission_name).join(' + ') || 'No access';
      const base = { org_id: +form.org_id, role_id: +form.role_id, permission: form.permission, permission_description };
      // upsert: update if this role already has the page, else create — never a duplicate.
      const upsert = (pageId) => {
        const existing = grantedAll.find((r) => Number(r.page_id) === Number(pageId));
        return existing
          ? rolePermissionsApi.update(existing.page_permission_id, { permission: form.permission, permission_description })
          : rolePermissionsApi.create({ ...base, page_id: Number(pageId) });
      };

      // Save the page itself
      if (isEditMode) await rolePermissionsApi.update(editId, { permission: form.permission, permission_description });
      else await upsert(+form.page_id);

      // Cascade the SAME permission down to every child / sub-child page (upsert each).
      const kids = descendantsOf(+form.page_id);
      if (kids.length) await Promise.allSettled(kids.map((k) => upsert(k.page_id)));

      flash(kids.length
        ? `${isEditMode ? 'Updated' : 'Added'} — cascaded to ${kids.length} child page${kids.length !== 1 ? 's' : ''}`
        : (isEditMode ? 'Permission updated' : 'Permission added'));
      setFormVisible(false); setEditId(null); await loadRecords();
    } catch (err) { flash(err.message || 'Save failed', false); }
    finally { setSaving(false); }
  };

  const del = async (id) => {
    if (!window.confirm('Remove this page permission?')) return;
    try { await rolePermissionsApi.remove(id); flash('Removed'); await loadRecords(); }
    catch (err) { flash(err.message || 'Delete failed', false); }
  };

  // roles in this org that can RECEIVE a clone (exclude the source role & own role)
  const cloneTargets = useMemo(
    () => orgRoles.filter((r) => Number(r.role_id) !== Number(roleId)),
    [orgRoles, roleId],
  );
  const openClone = () => { setCloneTarget(''); setCloneMode('merge'); setCloneOpen(true); };
  const doClone = async () => {
    if (!cloneTarget) { flash('Pick a target role', false); return; }
    setCloning(true);
    try {
      const res = await rolePermissionsApi.clone({
        org_id: Number(orgId), source_role_id: Number(roleId),
        target_role_id: Number(cloneTarget), mode: cloneMode,
      });
      setCloneOpen(false);
      flash(res?.message || `Copied ${res?.copied ?? ''} permission(s)`);
    } catch (err) {
      flash(err?.response?.data?.detail || err.message || 'Clone failed', false);
    } finally { setCloning(false); }
  };

  const crumb = selectedRole ? `${orgName(selectedOrg.org_id)} → ${selectedRole.role_name}`
    : selectedOrg ? `${selectedOrg.org_name} → Roles` : 'Organizations';
  const goBack = () => {
    // role permissions table → back to that org's role list
    if (roleId) navigate(`/role-permissions/${orgId}`);
    // role list (org chosen in Administration) → back to that org's Administration grid
    else if (orgId) navigate(`/administration/${orgId}`);
    else navigate('/administration');
  };

  /* ════════════════ RENDER ════════════════ */
  return (
    <div className="-mx-6 md:-mx-8 min-h-full bg-[#f1f5f9]">
      {/* Full-width gradient header (matches Administration) */}
      <div className="bg-gradient-to-r from-slate-900 via-blue-800 to-sky-700 px-6 md:px-8 pt-3 pb-4 relative overflow-hidden">
        <div className="absolute inset-0 opacity-[0.04]"
          style={{ backgroundImage: 'linear-gradient(#fff 1px,transparent 1px),linear-gradient(90deg,#fff 1px,transparent 1px)', backgroundSize: '28px 28px' }} />
        {/* breadcrumb */}
        <div className="relative flex items-center gap-2 text-xs text-slate-300/70 mb-2.5">
          <button onClick={() => navigate('/administration')} className="hover:text-slate-200 transition-colors">ActMon</button>
          <ChevronRight size={11} />
          <button onClick={() => navigate('/administration')} className="hover:text-slate-200 transition-colors">Administration</button>
          {selectedOrg && (<><ChevronRight size={11} /><span className="text-slate-200/80 truncate max-w-[160px]">{selectedOrg.org_name}</span></>)}
          <ChevronRight size={11} />
          <span className="text-white font-semibold truncate max-w-[220px]">{selectedRole ? selectedRole.role_name : 'Role Permissions'}</span>
        </div>
        {/* header row */}
        <div className="relative flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <button onClick={goBack} className="w-8 h-8 rounded-lg bg-white/10 border border-white/15 flex items-center justify-center text-white hover:bg-white/20 flex-shrink-0"><ChevronLeft size={16} /></button>
            <div className="w-9 h-9 rounded-lg bg-white/10 border border-white/15 flex items-center justify-center text-white flex-shrink-0"><Lock size={18} /></div>
            <div className="min-w-0">
              <h1 className="text-lg font-black text-white tracking-tight leading-none truncate">{crumb}</h1>
              <p className="text-sky-200/70 text-[11px] mt-0.5 truncate">
                {!selectedOrg ? 'Select an organization' : !selectedRole ? 'Select a role to manage its page permissions' : 'Manage page permissions for this role'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button onClick={loadAll} className="h-9 w-9 rounded-lg bg-white/10 border border-white/15 flex items-center justify-center text-white hover:bg-white/20"><RefreshCw size={15} className={loading ? 'animate-spin' : ''} /></button>
            {selectedRole && (
              <button onClick={openClone} title="Copy this role's permissions to another role"
                className="h-9 px-4 rounded-lg bg-white/10 border border-white/20 text-white font-bold text-sm flex items-center gap-2 hover:bg-white/20">
                <Copy size={15} /> <span className="hidden sm:inline">Clone</span>
              </button>
            )}
            {selectedRole && !ownRoleOpen && (
              <button onClick={openAdd} className="h-9 px-4 rounded-lg bg-white text-blue-700 font-bold text-sm flex items-center gap-2 hover:bg-sky-50 shadow-sm">
                <Plus size={16} /> <span className="hidden sm:inline">Add Page Permission</span><span className="sm:hidden">Add</span>
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="px-6 xl:px-10 py-6 max-w-[1700px] mx-auto">

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
            {ownRoleOpen && (
              <div className="bg-amber-50 border border-amber-200 rounded-2xl px-5 py-4 mb-4 flex items-start gap-3">
                <Lock size={18} className="text-amber-600 mt-0.5 flex-shrink-0" />
                <div>
                  <p className="font-black text-amber-800 text-sm">This is your own role</p>
                  <p className="text-amber-700 text-xs mt-0.5">For security, you can view but not change the permissions of the role you're signed in with. Ask a super admin to adjust it.</p>
                </div>
              </div>
            )}
            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-3 mb-4 flex items-center gap-3 flex-wrap">
              <div className="relative flex-1 min-w-[220px] max-w-md">
                <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input value={searchText} onChange={(e) => setSearchText(e.target.value)} placeholder="Search all pages…"
                  className="w-full h-10 pl-9 pr-3 rounded-xl bg-slate-50 border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-rose-200 focus:border-rose-400" />
              </div>
              <span className="inline-flex items-center gap-1.5 text-xs text-slate-500 font-bold ml-auto px-3 py-1.5 rounded-full bg-slate-100">
                <span className="w-1.5 h-1.5 rounded-full bg-rose-500" />{grantedAll.length} page{grantedAll.length !== 1 ? 's' : ''} granted
              </span>
            </div>

            {/* ── Drill breadcrumb (hidden while searching) ── */}
            {!searching && (
              <div className="flex items-center gap-1.5 flex-wrap mb-4 text-sm">
                <button onClick={() => drillTo(0)}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-bold transition-colors ${treeStack.length ? 'text-indigo-600 hover:bg-indigo-50' : 'bg-slate-800 text-white'}`}>
                  <Lock size={13} /> All Pages
                </button>
                {treeStack.map((c, idx) => (
                  <React.Fragment key={c.page_id}>
                    <ChevronRight size={15} className="text-slate-300" />
                    <button onClick={() => drillTo(idx + 1)}
                      className={`px-3 py-1.5 rounded-lg font-bold transition-colors ${idx === treeStack.length - 1 ? 'bg-slate-800 text-white' : 'text-indigo-600 hover:bg-indigo-50'}`}>
                      {c.page_name}
                    </button>
                  </React.Fragment>
                ))}
              </div>
            )}

            {levelRecords.length === 0 ? (
              <div className="bg-white rounded-3xl border border-slate-200 shadow-sm py-16 text-center">
                <div className="w-14 h-14 mx-auto rounded-2xl bg-slate-100 flex items-center justify-center mb-3"><FileText className="text-slate-300" size={26} /></div>
                <p className="text-slate-500 font-bold">{searching ? 'No matching pages' : grantedAll.length === 0 ? 'No page permissions yet' : 'No sub-pages here'}</p>
                <p className="text-slate-400 text-sm mt-1">{grantedAll.length === 0 ? <>Click <b>Add Page Permission</b> to grant access.</> : searching ? 'Try a different search term.' : 'This page has no further child pages.'}</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
                {levelRecords.map((r, i) => {
                  const a = ACCENTS[i % ACCENTS.length];
                  const perms = decodePermission(r.permission);
                  const kids = childCountOf[Number(r.page_id)] || 0;
                  const canDrill = !searching && kids > 0;
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
                          {canDrill && (
                            <span className="flex-shrink-0 inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-slate-100 text-slate-500">
                              {kids} sub
                            </span>
                          )}
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
                      {canDrill && (
                        <button onClick={() => drillInto(r)}
                          className="w-full px-5 py-2.5 border-t border-slate-100 flex items-center justify-between text-sm font-bold text-indigo-600 hover:bg-indigo-50/60 transition-colors">
                          <span>View {kids} sub-page{kids !== 1 ? 's' : ''}</span>
                          <ChevronRight size={16} />
                        </button>
                      )}
                      <div className="px-5 py-3 border-t border-slate-100 bg-slate-50/40 flex items-center justify-between">
                        <span className="text-[11px] font-mono text-slate-400">bitmask {r.permission}</span>
                        <div className="flex items-center gap-1">
                          {!ownRoleOpen && <button onClick={() => openEdit(r)} title="Edit" className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:bg-indigo-50 hover:text-indigo-600"><Pencil size={15} /></button>}
                          {!ownRoleOpen && <button onClick={() => del(r.page_permission_id)} title="Delete" className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:bg-red-50 hover:text-red-600"><Trash2 size={15} /></button>}
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
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-5">
                    <Ghost label="Organization" value={orgName(form.org_id)} />
                    <Ghost label="Role" value={roleName(form.role_id)} />
                  </div>

                  {isEditMode ? (
                    <div className="mt-5">
                      <label className="block text-[11px] font-black text-slate-500 uppercase tracking-wider mb-2">Page</label>
                      <Ghost value={pageName(form.page_id)} bare />
                    </div>
                  ) : (
                    <div className="mt-5 grid grid-cols-1 sm:grid-cols-3 gap-x-6 gap-y-5">
                      {/* 1) Module */}
                      <div>
                        <label className="block text-[11px] font-black text-slate-500 uppercase tracking-wider mb-2">Module <span className="text-red-500">*</span></label>
                        <Picker value={pickModule} placeholder="Select Module"
                          onChange={(v) => { setPickModule(v); setPickParent(''); setForm((f) => ({ ...f, page_id: '' })); }}>
                          {modules.map((m) => <option key={m.module_id} value={m.module_id} className="text-slate-800">{m.module_name}</option>)}
                        </Picker>
                      </div>
                      {/* 2) Parent page (parent_id = 0) */}
                      <div>
                        <label className="block text-[11px] font-black text-slate-500 uppercase tracking-wider mb-2">Parent Page <span className="text-red-500">*</span></label>
                        <Picker value={pickParent} disabled={!pickModule} placeholder={pickModule ? 'Select Parent Page' : 'Select module first'}
                          onChange={(v) => { setPickParent(v); setForm((f) => ({ ...f, page_id: v })); }}>
                          {parentPagesOf(pickModule).map((p) => (
                            <option key={p.page_id} value={p.page_id} className="text-slate-800">{p.page_name}{isGranted(p.page_id) ? ' ✓' : ''}</option>
                          ))}
                        </Picker>
                      </div>
                      {/* 3) Child page (parent_id = selected parent) — optional */}
                      <div>
                        <label className="block text-[11px] font-black text-slate-500 uppercase tracking-wider mb-2">Child Page</label>
                        <Picker value={String(form.page_id) === String(pickParent) ? '' : form.page_id} disabled={!pickParent}
                          placeholder={pickParent ? '↳ Whole parent + all children' : 'Select parent first'}
                          onChange={(v) => setForm((f) => ({ ...f, page_id: v || pickParent }))}>
                          {childPagesOf(pickParent).map((p) => (
                            <option key={p.page_id} value={p.page_id} className="text-slate-800">{p.page_name}{isGranted(p.page_id) ? ' ✓' : ''}</option>
                          ))}
                        </Picker>
                      </div>
                    </div>
                  )}

                  {!isEditMode && pickParent && (
                    <p className="mt-4 text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 flex items-start gap-2">
                      <Check size={14} className="text-emerald-500 mt-0.5 flex-shrink-0" />
                      {String(form.page_id) === String(pickParent)
                        ? <span>Granting <b>{pageName(pickParent)}</b> will apply the same permission to its <b>{descendantsOf(pickParent).length}</b> child page{descendantsOf(pickParent).length !== 1 ? 's' : ''}.</span>
                        : <span>Granting <b>{pageName(form.page_id)}</b>{descendantsOf(form.page_id).length ? <> and its <b>{descendantsOf(form.page_id).length}</b> sub-page(s)</> : null}. Already-granted pages are updated, not duplicated.</span>}
                    </p>
                  )}
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
                        {(() => {
                          // Only show permissions NOT already selected — the chosen ones live in the chips below.
                          const available = selectablePerms.filter((p) => !selectedPerms.some((s) => s.permission_id === p.permission_id));
                          if (available.length === 0) {
                            return <p className="px-3 py-4 text-sm text-slate-400 text-center">All permissions selected</p>;
                          }
                          return available.map((p) => (
                            <button type="button" key={p.permission_id} onClick={() => { addPerm(p.permission_value); }}
                              className="w-full flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl text-sm transition-colors hover:bg-slate-50">
                              <span className="font-semibold text-slate-700">{p.permission_name}</span>
                              <span className="text-[11px] font-mono text-slate-400">{p.permission_value}</span>
                            </button>
                          ));
                        })()}
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

      {/* ── Clone permissions modal ── */}
      {cloneOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-6" onClick={() => setCloneOpen(false)}>
          <div className="bg-white w-full max-w-md rounded-3xl shadow-2xl overflow-hidden animate-[fadeIn_.18s_ease-out]" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-6 py-4 bg-gradient-to-r from-slate-900 via-slate-800 to-indigo-900 text-white">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-white/10 border border-white/15 flex items-center justify-center"><Copy size={18} /></div>
                <div>
                  <h2 className="text-base font-black leading-none">Clone Permissions</h2>
                  <p className="text-[11px] text-white/60 mt-1">from <b className="text-white">{selectedRole?.role_name}</b></p>
                </div>
              </div>
              <button onClick={() => setCloneOpen(false)} className="w-9 h-9 rounded-xl flex items-center justify-center text-white/70 hover:bg-white/15"><X size={18} /></button>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-[11px] font-black text-slate-500 uppercase tracking-wider mb-1.5">Copy to role</label>
                <select value={cloneTarget} onChange={(e) => setCloneTarget(e.target.value)}
                  className="w-full h-11 px-3 rounded-xl border border-slate-200 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 bg-white">
                  <option value="">— Select target role —</option>
                  {cloneTargets.map((r) => <option key={r.role_id} value={r.role_id}>{r.role_name}</option>)}
                </select>
                {cloneTargets.length === 0 && <p className="text-[11px] text-amber-600 mt-1.5">No other roles available in this organization.</p>}
              </div>
              <div>
                <label className="block text-[11px] font-black text-slate-500 uppercase tracking-wider mb-1.5">Mode</label>
                <div className="grid grid-cols-2 gap-2">
                  {[['merge', 'Merge', 'Add / overwrite; keep target extras'], ['replace', 'Replace', 'Exact copy; remove target extras']].map(([val, label, hint]) => (
                    <button key={val} onClick={() => setCloneMode(val)}
                      className={`text-left px-3 py-2.5 rounded-xl border transition-all ${cloneMode === val ? 'border-indigo-400 bg-indigo-50 ring-2 ring-indigo-100' : 'border-slate-200 hover:border-slate-300'}`}>
                      <p className={`text-sm font-bold ${cloneMode === val ? 'text-indigo-700' : 'text-slate-700'}`}>{label}</p>
                      <p className="text-[10.5px] text-slate-400 mt-0.5 leading-tight">{hint}</p>
                    </button>
                  ))}
                </div>
              </div>
              <p className="text-[11px] text-slate-400">This copies every page permission from <b>{selectedRole?.role_name}</b> to the selected role{cloneMode === 'replace' ? ', replacing its current grants' : ''}.</p>
            </div>
            <div className="px-6 py-4 border-t border-slate-100 flex items-center justify-end gap-3 bg-slate-50">
              <button onClick={() => setCloneOpen(false)} className="h-10 px-5 rounded-xl bg-slate-100 text-slate-600 font-bold text-sm hover:bg-slate-200">Cancel</button>
              <button onClick={doClone} disabled={cloning || !cloneTarget}
                className="h-10 px-6 rounded-xl bg-gradient-to-r from-indigo-600 to-violet-600 text-white font-bold text-sm shadow-lg shadow-indigo-200 disabled:opacity-50 flex items-center gap-2">
                {cloning ? <Loader2 size={15} className="animate-spin" /> : <Copy size={15} />} Clone permissions
              </button>
            </div>
          </div>
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

// styled <select> with chevron, used by the cascading page picker
function Picker({ value, onChange, disabled, placeholder, children }) {
  return (
    <div className="relative">
      <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}
        className={`w-full h-11 px-3.5 pr-10 rounded-xl border bg-white text-sm font-semibold appearance-none transition-all focus:outline-none focus:ring-4 focus:ring-rose-100 focus:border-rose-400 hover:border-slate-300 disabled:bg-slate-100 disabled:cursor-not-allowed ${value ? 'text-slate-800 border-slate-200' : 'text-slate-400 border-slate-200'}`}>
        <option value="">{placeholder}</option>
        {children}
      </select>
      <ChevronDown size={16} className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
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
