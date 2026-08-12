import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import PageHeader from '@/components/layout/PageHeader';
import Icon from '@/components/ui/Icon';
import IconButton from '@/components/ui/IconButton';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Select from '@/components/ui/Select';
import Input from '@/components/ui/Input';
import Dialog from '@/components/ui/Dialog';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import { EmptyState } from '@/components/ui/Table';
import { usePermissions } from '@/hooks/usePermissions';
import { useAuthStore } from '@/store/authStore';
import {
  organizationsApi, rolesApi, modulesApi, pagesApi, permissionsApi, rolePermissionsApi,
} from '@/api/admin';

const KEY = (orgId) => ['admin', 'role-permissions', orgId ?? null];

/** Full-Access (255) is a catalog sentinel, never an individually grantable tag. */
const isRealPermission = (p) => String(p.permission_name).toLowerCase() !== 'full access';

/** Bitmask int → readable tag names, using the SAME catalog the builder uses. */
function decode(mask, catalog) {
  return catalog.filter((p) => isRealPermission(p) && (mask & p.permission_value) === p.permission_value)
    .map((p) => p.permission_name);
}

/** Every page whose parent chain leads back to `pageId` (any depth). */
function descendantsOf(pageId, allPages) {
  const out = [];
  const walk = (id) => {
    allPages.filter((p) => p.parent_id === id).forEach((child) => { out.push(child); walk(child.page_id); });
  };
  walk(pageId);
  return out;
}

function GridCard({ icon, title, subtitle, badge, image, onClick }) {
  const [imageFailed, setImageFailed] = useState(false);
  const showImage = image && !imageFailed;
  return (
    <button type="button" onClick={onClick} className="card flex flex-col gap-3 p-5 text-left transition-shadow hover:shadow-md">
      <div className="flex items-start justify-between gap-2">
        {showImage ? (
          <div className="flex h-16 max-w-[85%] items-center">
            <img src={encodeURI(image)} alt={title} className="max-h-16 max-w-full object-contain object-left" onError={() => setImageFailed(true)} />
          </div>
        ) : (
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-md bg-accent-soft text-accent-text">
            <Icon name={icon} size={20} />
          </span>
        )}
        {badge}
      </div>
      <span className="min-w-0">
        <span className="truncate-safe block text-[16px] font-bold text-fg">{title}</span>
        {subtitle && <span className="mt-1 block text-[13px] leading-snug text-muted">{subtitle}</span>}
      </span>
      <span className="mt-auto flex items-center gap-1 text-[13px] font-semibold text-accent-text">
        Open <Icon name="chevron-right" size={13} />
      </span>
    </button>
  );
}

/**
 * Group Role → Page Permissions. Three drill levels:
 *   /role-permissions              organizations (super-admins only)
 *   /role-permissions/:orgId       roles in that org
 *   /role-permissions/:orgId/:roleId   modules → page grants (client state, not URL)
 *
 * A page's grant cascades to every descendant page on save — granting a
 * parent auto-grants/updates every child with the identical bitmask, same
 * as the production reference.
 */
export default function GroupRolePagePermission() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { orgId: orgIdParam, roleId: roleIdParam } = useParams();
  const orgId = orgIdParam ? Number(orgIdParam) : undefined;
  const roleId = roleIdParam ? Number(roleIdParam) : undefined;
  const { canHere } = usePermissions();
  const user = useAuthStore((s) => s.user);

  const [selectedModuleId, setSelectedModuleId] = useState(null);
  const [treeStack, setTreeStack] = useState([]); // [{page_id, page_name}]
  const [search, setSearch] = useState('');
  const [form, setForm] = useState(null); // { mode, values, selectedPerms, permOpen }
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [clone, setClone] = useState(null); // { targetRoleId, mode }
  const [toast, setToast] = useState(null);

  const flash = (text, tone = 'success') => { setToast({ text, tone }); setTimeout(() => setToast(null), 2500); };

  const { data: orgs = [], isLoading: orgsLoading } = useQuery({
    queryKey: ['admin', 'organizations'], queryFn: () => organizationsApi.list(),
  });
  const { data: roles = [] } = useQuery({
    queryKey: ['admin', 'roles', orgId ?? null], queryFn: () => rolesApi.list(orgId), enabled: !!orgId,
  });
  const { data: modules = [] } = useQuery({ queryKey: ['admin', 'modules'], queryFn: () => modulesApi.list() });
  const { data: pages = [] } = useQuery({ queryKey: ['admin', 'pages'], queryFn: () => pagesApi.list() });
  const { data: permCatalog = [] } = useQuery({ queryKey: ['admin', 'permissions'], queryFn: () => permissionsApi.list() });
  const { data: records = [], isFetching: recordsLoading } = useQuery({
    queryKey: KEY(orgId), queryFn: () => rolePermissionsApi.list(orgId), enabled: !!orgId,
  });

  const refreshRecords = () => qc.invalidateQueries({ queryKey: KEY(orgId) });

  // Super-admins pick an org; everyone else is bounced to their own.
  useEffect(() => {
    if (orgIdParam || orgsLoading || !orgs.length) return;
    if (!user?.is_superuser) navigate(`/role-permissions/${user?.org_id || orgs[0].org_id}`, { replace: true });
  }, [orgIdParam, orgsLoading, orgs, user, navigate]);

  const org = orgs.find((o) => String(o.org_id) === String(orgId));
  const role = roles.find((r) => String(r.role_id) === String(roleId));

  const isOwnRole = (r) => user?.role_id != null && String(r.role_id) === String(user.role_id)
    && String(r.org_id) === String(user.org_id);
  const viewingOwnRole = role ? isOwnRole(role) : false;
  // Editing your own role's permissions is blocked for everyone, including a
  // super-admin — the backend enforces this unconditionally too (self
  // privilege-escalation guard) — a super-admin's only difference is they
  // can still SEE their own role in the roles list at all.
  const readOnly = viewingOwnRole;

  const roleRecords = useMemo(() => records.filter((r) => String(r.role_id) === String(roleId)), [records, roleId]);

  /** Granted-page count per role, for the roles-list badge (level 1). */
  const roleRecordCounts = useMemo(() => {
    const m = {};
    records.forEach((r) => { m[r.role_id] = (m[r.role_id] || 0) + 1; });
    return m;
  }, [records]);

  const moduleGrantCounts = useMemo(() => {
    const m = {};
    roleRecords.forEach((r) => { m[r.module_id] = (m[r.module_id] || 0) + 1; });
    return m;
  }, [roleRecords]);

  const moduleRecords = useMemo(
    () => roleRecords.filter((r) => r.module_id === selectedModuleId),
    [roleRecords, selectedModuleId],
  );

  // Attach each granted record's parent_id from the full page catalog — the
  // grant view itself doesn't carry it — so the tree/drill-down can group by
  // hierarchy without a second round-trip per page.
  const pageById = useMemo(() => Object.fromEntries(pages.map((p) => [p.page_id, p])), [pages]);
  const grantedIds = useMemo(() => new Set(moduleRecords.map((r) => r.page_id)), [moduleRecords]);
  const withParent = useMemo(() => moduleRecords.map((r) => {
    const parentId = pageById[r.page_id]?.parent_id;
    // "Effective parent" — only nest under a parent that is ALSO granted;
    // otherwise this row floats to root so it's never hidden.
    const effParent = parentId && grantedIds.has(parentId) ? parentId : 0;
    return { ...r, effParent };
  }), [moduleRecords, pageById, grantedIds]);

  const q = search.trim().toLowerCase();
  const currentParentId = treeStack.length ? treeStack[treeStack.length - 1].page_id : 0;
  const visibleRecords = q
    ? withParent.filter((r) => r.page_name.toLowerCase().includes(q) || r.page_url?.toLowerCase().includes(q))
    : withParent.filter((r) => r.effParent === currentParentId);
  const childCountOf = (pageId) => withParent.filter((r) => r.effParent === pageId).length;

  function openModule(m) { setSelectedModuleId(m.module_id); setTreeStack([]); setSearch(''); }
  function drillInto(r) { setTreeStack((s) => [...s, { page_id: r.page_id, page_name: r.page_name }]); }
  function goBack() {
    if (search) { setSearch(''); return; }
    if (treeStack.length) { setTreeStack((s) => s.slice(0, -1)); return; }
    if (selectedModuleId) { setSelectedModuleId(null); return; }
    if (roleId) { navigate(`/role-permissions/${orgId}`); return; }
    if (orgId) { navigate('/role-permissions'); return; }
  }

  // ── add/edit dialog ──────────────────────────────────────────────────
  function openGrantForm(existing) {
    const page = existing ? pageById[existing.page_id] : null;
    setForm({
      mode: existing ? 'edit' : 'add',
      moduleId: existing ? existing.module_id : selectedModuleId,
      parentId: page?.parent_id || null,
      childId: page && page.parent_id ? page.page_id : null,
      selectedPerms: existing ? permCatalog.filter((p) => isRealPermission(p) && (existing.permission & p.permission_value) === p.permission_value) : [],
      permOpen: false,
      existingPageId: existing?.page_id,
    });
  }
  function closeForm() { setForm(null); }

  const formPagesForModule = form ? pages.filter((p) => p.module_id === form.moduleId) : [];
  const parentOptions = formPagesForModule.filter((p) => !p.parent_id);
  const childOptions = form?.parentId ? formPagesForModule.filter((p) => p.parent_id === form.parentId) : [];
  const targetPageId = form?.childId || form?.parentId || null;
  const bitmaskValue = form ? form.selectedPerms.reduce((sum, p) => sum + p.permission_value, 0) : 0;
  const availablePerms = form
    ? permCatalog.filter((p) => isRealPermission(p) && !form.selectedPerms.some((s) => s.permission_id === p.permission_id))
    : [];

  function addPerm(p) { setForm((f) => ({ ...f, selectedPerms: [...f.selectedPerms, p], permOpen: false })); }
  function removePerm(id) { setForm((f) => ({ ...f, selectedPerms: f.selectedPerms.filter((p) => p.permission_id !== id) })); }

  async function submitGrant() {
    if (!targetPageId) { flash('Choose a page to grant.', 'danger'); return; }
    const description = decode(bitmaskValue, permCatalog).join(' + ') || 'No access';
    const payload = { org_id: orgId, role_id: roleId, page_id: targetPageId, permission: bitmaskValue, permission_description: description };
    try {
      const existing = roleRecords.find((r) => r.page_id === targetPageId);
      if (existing) await rolePermissionsApi.update(existing.page_permission_id, payload);
      else await rolePermissionsApi.create(payload);

      // Cascade: every descendant page gets the same bitmask.
      const kids = descendantsOf(targetPageId, pages);
      await Promise.allSettled(kids.map((child) => {
        const childExisting = roleRecords.find((r) => r.page_id === child.page_id);
        const childPayload = { ...payload, page_id: child.page_id };
        return childExisting
          ? rolePermissionsApi.update(childExisting.page_permission_id, childPayload)
          : rolePermissionsApi.create(childPayload);
      }));

      flash(`Permission saved${kids.length ? ` — cascaded to ${kids.length} sub-page${kids.length !== 1 ? 's' : ''}.` : '.'}`);
      refreshRecords();
      closeForm();
    } catch (err) {
      flash(err?.message || 'Save failed.', 'danger');
    }
  }

  async function confirmDelete() {
    try {
      await rolePermissionsApi.remove(deleteTarget.page_permission_id);
      flash('Permission removed.');
      refreshRecords();
    } catch (err) {
      flash(err?.message || 'Delete failed.', 'danger');
    } finally {
      setDeleteTarget(null);
    }
  }

  async function submitClone() {
    try {
      const res = await rolePermissionsApi.clone({
        org_id: orgId, source_role_id: roleId, target_role_id: clone.targetRoleId, mode: clone.mode,
      });
      flash(res?.message || `Copied ${res?.copied ?? 0} permission(s).`);
      refreshRecords();
      setClone(null);
    } catch (err) {
      flash(err?.message || 'Clone failed.', 'danger');
    }
  }

  // ── render ───────────────────────────────────────────────────────────

  if (!orgIdParam) {
    return (
      <>
        <PageHeader title="Group Role Permissions" icon="shield-check" description="Choose an organization to manage its roles’ page access." />
        <div className="mt-6 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {orgsLoading || orgs.length === 0 ? (
            <div className="col-span-full"><EmptyState icon="building" title={orgsLoading ? 'Loading…' : 'No organizations yet'} /></div>
          ) : orgs.map((o) => (
            <GridCard key={o.org_id} icon="building" image={o.logo_path} title={o.org_name} subtitle={o.org_code}
              onClick={() => navigate(`/role-permissions/${o.org_id}`)} />
          ))}
        </div>
      </>
    );
  }

  if (!roleIdParam) {
    const visibleRoles = roles.filter((r) => user?.is_superuser || !isOwnRole(r));
    return (
      <>
        <PageHeader
          title="Group Role Permissions"
          icon="shield-check"
          description={`Roles in ${org?.org_name || 'this organization'} — pick one to manage its page access.`}
          backTo="/role-permissions"
          backLabel="Organizations"
        />
        <div className="mt-6 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {visibleRoles.map((r) => (
            <GridCard
              key={r.role_id}
              icon="shield"
              title={r.role_name}
              subtitle={r.role_description}
              badge={<Badge tone="neutral" size="xs">{roleRecordCounts[r.role_id] || 0} pages</Badge>}
              onClick={() => navigate(`/role-permissions/${orgId}/${r.role_id}`)}
            />
          ))}
          {!visibleRoles.length && (
            <div className="col-span-full"><EmptyState icon="shield" title="No roles to manage here." /></div>
          )}
        </div>
      </>
    );
  }

  if (!selectedModuleId) {
    return (
      <>
        <PageHeader
          title={role?.role_name || 'Role'}
          icon="shield-check"
          description="Pick a module to manage which of its pages this role can access."
          backTo={`/role-permissions/${orgId}`}
          backLabel="Roles"
        />
        {viewingOwnRole && (
          <div className="card mt-6 flex items-center gap-2 border-warning-soft bg-warning-soft px-card py-3 text-[13px] text-warning-fg">
            <Icon name="alert" size={16} />
            You’re viewing your own role — it’s read-only to prevent locking yourself out.
          </div>
        )}
        <div className="mt-6 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {[...modules].sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0)).map((m) => (
            <GridCard
              key={m.module_id}
              icon={m.module_icon || 'boxes'}
              title={m.module_name}
              subtitle={`${moduleGrantCounts[m.module_id] || 0} page${(moduleGrantCounts[m.module_id] || 0) !== 1 ? 's' : ''} granted`}
              onClick={() => openModule(m)}
            />
          ))}
        </div>
      </>
    );
  }

  const selectedModule = modules.find((m) => m.module_id === selectedModuleId);

  return (
    <>
      <PageHeader
        title={`${role?.role_name || 'Role'} · ${selectedModule?.module_name || 'Module'}`}
        icon="shield-check"
        description={treeStack.length ? `Inside ${treeStack[treeStack.length - 1].page_name}` : 'Top-level pages for this module.'}
        actions={(
          <div className="flex items-center gap-2">
            <IconButton icon="chevron-left" label="Back" onClick={goBack} />
            {!readOnly && canHere('edit') && (
              <Button variant="secondary" icon="copy" onClick={() => setClone({ targetRoleId: '', mode: 'merge' })}>Clone to…</Button>
            )}
            {!readOnly && canHere('add') && (
              <Button variant="primary" icon="plus" onClick={() => openGrantForm(null)}>Grant Page</Button>
            )}
          </div>
        )}
      />

      <div className="card mt-6 flex items-center gap-2 px-card py-3">
        <Input icon="search" placeholder="Search pages in this module…" value={search} onChange={(e) => setSearch(e.target.value)} onClear={() => setSearch('')} wrapperClassName="w-full max-w-72" />
        <span className="ml-auto text-[12px] text-subtle">{visibleRecords.length} page{visibleRecords.length !== 1 ? 's' : ''}</span>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {recordsLoading ? (
          <div className="col-span-full"><EmptyState icon="route" title="Loading…" /></div>
        ) : visibleRecords.length === 0 ? (
          <div className="col-span-full"><EmptyState icon="route" title="No pages granted here yet." body={!readOnly ? 'Click "Grant Page" to add one.' : undefined} /></div>
        ) : visibleRecords.map((r) => {
          const kids = childCountOf(r.page_id);
          return (
            <div key={r.page_permission_id} className="card flex flex-col gap-3 p-5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate-safe font-bold text-fg">{r.page_name}</p>
                  <p className="truncate-safe text-[12px] text-subtle">{r.page_url || '—'}</p>
                </div>
                {!readOnly && (
                  <div className="flex shrink-0 items-center gap-1">
                    <IconButton icon="file-edit" label="Edit" size="sm" onClick={() => openGrantForm(r)} />
                    <IconButton icon="trash" label="Remove" size="sm" tone="danger" onClick={() => setDeleteTarget(r)} />
                  </div>
                )}
              </div>
              <div className="flex flex-wrap gap-1">
                {decode(r.permission, permCatalog).map((name) => (
                  <Badge key={name} tone="accent" size="xs">{name}</Badge>
                ))}
                {!r.permission && <Badge tone="neutral" size="xs">No access</Badge>}
              </div>
              {kids > 0 && (
                <button type="button" onClick={() => drillInto(r)} className="mt-auto flex items-center gap-1 text-[12px] font-semibold text-accent-text">
                  View {kids} sub-page{kids !== 1 ? 's' : ''} <Icon name="chevron-right" size={13} />
                </button>
              )}
            </div>
          );
        })}
      </div>

      {form && (
        <Dialog
          open
          onClose={closeForm}
          icon="shield-check"
          title={form.mode === 'add' ? 'Grant a Page' : 'Edit Permission'}
          width={560}
          footer={(
            <div className="flex items-center justify-end gap-2">
              <Button variant="secondary" onClick={closeForm}>Cancel</Button>
              <Button variant="primary" onClick={submitGrant}>{form.mode === 'add' ? 'Save Permission' : 'Update Permission'}</Button>
            </div>
          )}
        >
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <label className="mb-1 block text-[12px] font-semibold text-muted">Module</label>
                <Select
                  value={String(form.moduleId ?? '')}
                  onChange={(v) => setForm((f) => ({ ...f, moduleId: Number(v), parentId: null, childId: null }))}
                  options={modules.map((m) => ({ id: String(m.module_id), label: m.module_name }))}
                  disabled={form.mode === 'edit'}
                />
              </div>
              <div>
                <label className="mb-1 block text-[12px] font-semibold text-muted">Page</label>
                <Select
                  value={String(form.parentId ?? '')}
                  onChange={(v) => setForm((f) => ({ ...f, parentId: v ? Number(v) : null, childId: null }))}
                  options={parentOptions.map((p) => ({
                    id: String(p.page_id),
                    label: grantedIds.has(p.page_id) ? `${p.page_name} ✓` : p.page_name,
                  }))}
                  placeholder="— Select page —"
                  disabled={form.mode === 'edit'}
                />
              </div>
              <div>
                <label className="mb-1 block text-[12px] font-semibold text-muted">Sub-page (optional)</label>
                <Select
                  value={String(form.childId ?? '')}
                  onChange={(v) => setForm((f) => ({ ...f, childId: v ? Number(v) : null }))}
                  options={childOptions.map((p) => ({
                    id: String(p.page_id),
                    label: grantedIds.has(p.page_id) ? `${p.page_name} ✓` : p.page_name,
                  }))}
                  placeholder="Whole page"
                  disabled={form.mode === 'edit' || !form.parentId}
                />
              </div>
            </div>

            <div className="relative">
              <label className="mb-1 block text-[12px] font-semibold text-muted">Permissions</label>
              <button
                type="button"
                onClick={() => setForm((f) => ({ ...f, permOpen: !f.permOpen }))}
                className="flex h-control w-full items-center justify-between rounded-control border border-border bg-surface px-2.5 text-[13px] text-fg"
              >
                {form.selectedPerms.length ? `${form.selectedPerms.length} permission${form.selectedPerms.length !== 1 ? 's' : ''} selected` : 'Select permissions…'}
                <Icon name="chevron-down" size={14} className="text-subtle" />
              </button>
              {form.permOpen && (
                <div className="absolute z-10 mt-1 w-full rounded-control border border-border bg-surface py-1 shadow-lg">
                  {availablePerms.length === 0 ? (
                    <p className="px-3 py-2 text-[12px] text-subtle">All permissions selected.</p>
                  ) : availablePerms.map((p) => (
                    <button
                      key={p.permission_id}
                      type="button"
                      onClick={() => addPerm(p)}
                      className="flex w-full items-center justify-between px-3 py-1.5 text-left text-[13px] text-fg hover:bg-sunken"
                    >
                      {p.permission_name}
                      <span className="text-[11px] text-subtle">{p.permission_value}</span>
                    </button>
                  ))}
                </div>
              )}
              <div className="mt-2 flex flex-wrap gap-1.5">
                {form.selectedPerms.map((p) => (
                  <span key={p.permission_id} className="flex items-center gap-1 rounded-full bg-accent-soft px-2.5 py-1 text-[11px] font-semibold text-accent-text">
                    {p.permission_name}
                    <button type="button" onClick={() => removePerm(p.permission_id)} aria-label={`Remove ${p.permission_name}`}>
                      <Icon name="close" size={11} />
                    </button>
                  </span>
                ))}
              </div>
              <p className="mt-2 text-[11px] text-subtle">Computed bitmask value: <b className="text-fg">{bitmaskValue}</b></p>
            </div>
          </div>
        </Dialog>
      )}

      {clone && (
        <Dialog
          open
          onClose={() => setClone(null)}
          icon="copy"
          title="Clone Permissions"
          footer={(
            <div className="flex items-center justify-end gap-2">
              <Button variant="secondary" onClick={() => setClone(null)}>Cancel</Button>
              <Button variant="primary" disabled={!clone.targetRoleId} onClick={submitClone}>Copy Permissions</Button>
            </div>
          )}
        >
          <div className="space-y-4">
            <div>
              <label className="mb-1 block text-[12px] font-semibold text-muted">Copy {role?.role_name}’s permissions to</label>
              <Select
                value={clone.targetRoleId}
                onChange={(v) => setClone((c) => ({ ...c, targetRoleId: v }))}
                options={roles.filter((r) => r.role_id !== roleId).map((r) => ({ id: String(r.role_id), label: r.role_name }))}
                placeholder="— Select target role —"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              {[
                { id: 'merge', label: 'Merge', desc: 'Add/overwrite the target’s grants — keeps its existing extras.' },
                { id: 'replace', label: 'Replace', desc: 'Make the target an exact copy — removes its extras.' },
              ].map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setClone((c) => ({ ...c, mode: opt.id }))}
                  className={`rounded-control border p-3 text-left transition-colors ${
                    clone.mode === opt.id ? 'border-accent bg-accent-soft' : 'border-border hover:bg-sunken'}`}
                >
                  <p className="text-[13px] font-bold text-fg">{opt.label}</p>
                  <p className="mt-0.5 text-[11px] text-muted">{opt.desc}</p>
                </button>
              ))}
            </div>
          </div>
        </Dialog>
      )}

      <ConfirmDialog
        open={!!deleteTarget}
        title="Remove this permission?"
        message={deleteTarget ? `"${deleteTarget.page_name}" will no longer be accessible to this role.` : ''}
        confirmLabel="Remove"
        tone="danger"
        icon="trash"
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />

      {toast && (
        <div className={`fixed right-6 bottom-6 z-[95] rounded-control px-4 py-2.5 text-[13px] font-semibold shadow-lg ${
          toast.tone === 'danger' ? 'bg-danger text-white' : 'bg-success text-white'}`}
        >
          {toast.text}
        </div>
      )}
    </>
  );
}
