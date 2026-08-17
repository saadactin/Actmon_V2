import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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
import Steps from '@/components/ui/Steps';
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
 * Multi-select permission picker. Renders its open panel into a `document.body`
 * portal with `position: fixed` (measured from the trigger's own bounding
 * rect) — same technique Tooltip.jsx already uses for exactly the same reason:
 * this field sits inside a `.card overflow-hidden` wrapper (the app-wide
 * pattern that lets a card's bg-raised footer band clip to the card's own
 * rounded corners), and an in-flow `position: absolute` panel gets silently
 * cut off at that ancestor's edge the moment it's taller than the sliver of
 * space between the button and the footer — which, on this single-field step,
 * is almost always true for more than 1-2 items. A portal escapes that
 * ancestor entirely, so the panel is never clipped regardless of the card's
 * own size.
 *
 * Shows EVERY selectable permission with a checkbox-style selected state
 * (rather than removing picked ones from the list) so what's already granted
 * stays visible while the list is open, and stays open across multiple picks
 * — both are what the "picking permissions" flow should always have done.
 */
function PermissionPicker({ options, selected, onToggle }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const btnRef = useRef(null);
  const panelRef = useRef(null);

  // Panel height is capped at max-h-72 (18rem); estimate against that so the
  // flip decision doesn't need a post-render measurement pass.
  const PANEL_MAX_HEIGHT = 288;
  const GAP = 6;

  const reposition = () => {
    const el = btnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const spaceBelow = window.innerHeight - r.bottom;
    const spaceAbove = r.top;
    // Below is the default and strongly preferred — only flip to above when
    // there's genuinely more usable room there (not just "some"), so a panel
    // near the middle of the screen doesn't flip on a technicality.
    const openUpward = spaceBelow < PANEL_MAX_HEIGHT && spaceAbove > spaceBelow;
    setPos(openUpward
      ? { bottom: window.innerHeight - r.top + GAP, left: r.left, width: r.width, maxHeight: Math.max(120, spaceAbove - GAP * 2) }
      : { top: r.bottom + GAP, left: r.left, width: r.width, maxHeight: Math.max(120, spaceBelow - GAP * 2) });
  };

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (btnRef.current?.contains(e.target) || panelRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    // A portal-positioned panel doesn't move with the page, so rather than
    // tracking scroll continuously (unnecessary complexity for a short-lived
    // picker), closing on scroll avoids it drifting away from its trigger —
    // the same trade-off Tooltip.jsx makes.
    const onScroll = () => setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open]);

  const selectedIds = useMemo(() => new Set(selected.map((p) => p.permission_id)), [selected]);

  return (
    <>
      <button
        type="button"
        ref={btnRef}
        onClick={() => { if (!open) reposition(); setOpen((o) => !o); }}
        className="flex h-control w-full items-center justify-between rounded-control border border-border bg-surface px-2.5 text-[13px] text-fg"
      >
        {selected.length ? `${selected.length} permission${selected.length !== 1 ? 's' : ''} selected` : 'Select permissions…'}
        <Icon name="chevron-down" size={14} className={`text-subtle transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && pos && createPortal(
        <div
          ref={panelRef}
          role="listbox"
          aria-multiselectable="true"
          className="fixed z-[100] max-h-72 overflow-y-auto rounded-control border border-border bg-surface py-1 shadow-lg"
          style={{
            top: pos.top, bottom: pos.bottom, left: pos.left, width: pos.width,
            maxHeight: Math.min(288, pos.maxHeight),
          }}
        >
          {options.length === 0 ? (
            <p className="px-3 py-2 text-[12px] text-subtle">No permissions available.</p>
          ) : options.map((p) => {
            const isSelected = selectedIds.has(p.permission_id);
            return (
              <button
                key={p.permission_id}
                type="button"
                role="option"
                aria-selected={isSelected}
                onClick={() => onToggle(p)}
                className={`flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-[13px] transition-colors hover:bg-sunken ${isSelected ? 'bg-accent-soft' : ''}`}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className={`grid h-4 w-4 shrink-0 place-items-center rounded border ${isSelected ? 'border-accent bg-accent text-on-accent' : 'border-strong'}`}>
                    {isSelected && <Icon name="check" size={10} />}
                  </span>
                  <span className={`truncate ${isSelected ? 'font-semibold text-accent-text' : 'text-fg'}`}>{p.permission_name}</span>
                </span>
                <span className="shrink-0 text-[11px] text-subtle">{p.permission_value}</span>
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </>
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
  const [form, setForm] = useState(null); // { mode, step, moduleId, pageId, selectedPerms, existingPageId }
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
  // Clears `search` on the way in — otherwise drilling into a search-matched
  // card leaves stale search state that goBack()'s search-branch doesn't know
  // to unwind, so one "back" click would silently skip past the search
  // results the user was actually looking at.
  function drillInto(r) { setSearch(''); setTreeStack((s) => [...s, { page_id: r.page_id, page_name: r.page_name }]); }
  function goBack() {
    if (search) { setSearch(''); return; }
    if (treeStack.length) { setTreeStack((s) => s.slice(0, -1)); return; }
    if (selectedModuleId) { setSelectedModuleId(null); return; }
    if (roleId) { navigate(`/role-permissions/${orgId}`); return; }
    if (orgId) { navigate('/role-permissions'); return; }
  }

  // ── add/edit dialog ──────────────────────────────────────────────────
  function openGrantForm(existing) {
    setForm({
      mode: existing ? 'edit' : 'add',
      step: 0,
      moduleId: existing ? existing.module_id : selectedModuleId,
      parentId: existing ? (pageById[existing.page_id]?.parent_id || null) : null,
      pageId: existing ? existing.page_id : null,
      selectedPerms: existing ? permCatalog.filter((p) => isRealPermission(p) && (existing.permission & p.permission_value) === p.permission_value) : [],
      existingPageId: existing?.page_id,
    });
  }
  function closeForm() { setForm(null); }

  /** Top-level pages (no parent) belonging to one module — the "Parent Page" options. */
  const parentPagesOf = (moduleId) => pages.filter((p) => p.module_id === moduleId && !p.parent_id);

  /** Every descendant of one parent page, flattened depth-first with an
   * indent depth — the "Sub Page" options. Not just DIRECT children: some
   * modules nest 4+ levels deep (e.g. Infrastructure: Infrastructure → Host
   * Detail → a tab → one of that tab's own cards), so this still reaches a
   * page at any depth below the chosen parent, just presented as one
   * indented list instead of a 4th/5th dropdown. */
  const subPagesOf = (parentId) => {
    if (!parentId) return [];
    const byParent = {};
    pages.forEach((p) => { const k = p.parent_id || 0; (byParent[k] ||= []).push(p); });
    const out = [];
    const walk = (id, depth) => {
      (byParent[id] || [])
        .sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0))
        .forEach((p) => { out.push({ ...p, depth }); walk(p.page_id, depth + 1); });
    };
    walk(parentId, 0);
    return out;
  };

  /** Granted anywhere in this role (any module) — matches the "(granted)"
   * hint against the role's full grant set, not just the module currently
   * being drilled into on the page behind this form. */
  const isGrantedPage = (pageId) => roleRecords.some((r) => r.page_id === pageId);

  const targetPageId = form?.pageId || null;
  const bitmaskValue = form ? form.selectedPerms.reduce((sum, p) => sum + p.permission_value, 0) : 0;
  // Every selectable permission stays in the picker's list (selection state
  // is shown via a checkmark, not by removing the row) — see PermissionPicker.
  const selectablePerms = useMemo(() => permCatalog.filter(isRealPermission), [permCatalog]);

  function togglePerm(p) {
    setForm((f) => {
      const isSelected = f.selectedPerms.some((s) => s.permission_id === p.permission_id);
      return {
        ...f,
        selectedPerms: isSelected
          ? f.selectedPerms.filter((s) => s.permission_id !== p.permission_id)
          : [...f.selectedPerms, p],
      };
    });
  }
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

  // Grant-a-Page replaces this whole screen with a full page 2-step wizard —
  // same shell as AddOsServerPage.jsx (PageHeader + .card + Steps + footer
  // nav) — instead of a modal. Step 0 picks the page, step 1 picks
  // permissions; Back at step 1 returns to step 0, Back at step 0 closes the
  // form back to the tree view below.
  if (form) {
    const stepLabels = ['Choose Page', 'Choose Permissions'];
    const step = form.step || 0;
    return (
      <>
        <PageHeader
          title={form.mode === 'add' ? 'Grant a Page' : 'Edit Permission'}
          icon="shield-check"
          description={`${role?.role_name || 'Role'} · ${modules.find((m) => m.module_id === form.moduleId)?.module_name || selectedModule?.module_name || 'Module'}`}
          onBack={() => (step === 0 ? closeForm() : setForm((f) => ({ ...f, step: 0 })))}
          backLabel={step === 0 ? 'Cancel' : 'Back'}
        />

        <div className="card overflow-hidden">
          <div className="border-b border-border px-card py-3.5">
            <Steps steps={stepLabels} current={step} />
          </div>

          <div className="px-card py-card">
            {step === 0 ? (
              form.mode === 'edit' ? (
                // Which page a grant belongs to isn't editable — only the
                // permission set is (re-targeting to a different page is a
                // delete + re-grant, not an edit). Shown as a plain read-only
                // summary instead of three disabled-looking dropdowns, which
                // reads as broken rather than "locked on purpose."
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-[12px] font-semibold text-muted">Module</label>
                    <p className="flex h-control items-center rounded-control border border-border bg-sunken px-2.5 text-[13px] text-muted">
                      {modules.find((m) => m.module_id === form.moduleId)?.module_name || '—'}
                    </p>
                  </div>
                  <div>
                    <label className="mb-1 block text-[12px] font-semibold text-muted">Page</label>
                    <p className="flex h-control items-center rounded-control border border-border bg-sunken px-2.5 text-[13px] text-muted">
                      {pageById[form.pageId]?.page_name || '—'}
                    </p>
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                  <div>
                    <label className="mb-1 block text-[12px] font-semibold text-muted">Module <span className="text-danger">*</span></label>
                    <Select
                      value={String(form.moduleId ?? '')}
                      onChange={(v) => setForm((f) => ({ ...f, moduleId: Number(v), parentId: null, pageId: null }))}
                      options={modules.map((m) => ({ id: String(m.module_id), label: m.module_name }))}
                      placeholder="— Select module —"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-[12px] font-semibold text-muted">Parent Page <span className="text-danger">*</span></label>
                    <Select
                      value={String(form.parentId ?? '')}
                      onChange={(v) => setForm((f) => ({ ...f, parentId: v ? Number(v) : null, pageId: v ? Number(v) : null }))}
                      options={parentPagesOf(form.moduleId).map((p) => ({
                        id: String(p.page_id),
                        label: isGrantedPage(p.page_id) ? `${p.page_name} (granted)` : p.page_name,
                      }))}
                      placeholder={form.moduleId ? '— Select parent page —' : 'Select module first'}
                      disabled={!form.moduleId}
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-[12px] font-semibold text-muted">Sub Page</label>
                    <Select
                      value={form.pageId && form.pageId !== form.parentId ? String(form.pageId) : ''}
                      onChange={(v) => setForm((f) => ({ ...f, pageId: v ? Number(v) : f.parentId }))}
                      options={subPagesOf(form.parentId).map((p) => ({
                        id: String(p.page_id),
                        label: `${'—  '.repeat(p.depth)}${isGrantedPage(p.page_id) ? `${p.page_name} (granted)` : p.page_name}`,
                      }))}
                      placeholder={form.parentId ? '↳ Whole parent + all children' : 'Select parent first'}
                      disabled={!form.parentId}
                    />
                  </div>
                </div>
              )
            ) : (
              <div className="max-w-xl">
                <label className="mb-1 block text-[12px] font-semibold text-muted">Permissions</label>
                <PermissionPicker options={selectablePerms} selected={form.selectedPerms} onToggle={togglePerm} />
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
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-raised px-card py-3">
            <span className="text-[12px] text-subtle">Step {step + 1} of {stepLabels.length}</span>
            <div className="flex items-center gap-2">
              <Button variant="ghost" onClick={closeForm}>Cancel</Button>
              {step > 0 && (
                <Button variant="secondary" icon="arrow-left" onClick={() => setForm((f) => ({ ...f, step: 0 }))}>Previous</Button>
              )}
              {step === 0 ? (
                <Button variant="primary" iconRight="arrow-right" disabled={!form.pageId} onClick={() => setForm((f) => ({ ...f, step: 1 }))}>
                  Next
                </Button>
              ) : (
                <Button variant="primary" onClick={submitGrant}>
                  {form.mode === 'add' ? 'Save Permission' : 'Update Permission'}
                </Button>
              )}
            </div>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={`${role?.role_name || 'Role'} · ${selectedModule?.module_name || 'Module'}`}
        icon="shield-check"
        description={treeStack.length ? `Inside ${treeStack[treeStack.length - 1].page_name}` : 'Top-level pages for this module.'}
        onBack={goBack}
        actions={(
          <div className="flex items-center gap-2">
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
