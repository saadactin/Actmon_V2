import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import cn from '@/lib/cn';
import Icon from '@/components/ui/Icon';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import Select from '@/components/ui/Select';
import Notice from '@/components/ui/Notice';
import { PageLoading } from '@/components/ui/Loading';
import { Checkbox } from '@/components/ui/Table';
import { usePermissions } from '@/hooks/usePermissions';
import { useAuthStore } from '@/store/authStore';
import {
  rolesApi, pagesApi, permissionsApi, modulesApi, rolePermissionsApi,
} from '@/api/admin';

/**
 * Role Permissions — pick a role, walk the page tree, tick permissions.
 *
 * Replaces a three-level drill-down of card grids where you could only ever see
 * one level at a time and every click wrote to the API immediately. Here the
 * whole hierarchy is visible and expandable, and edits are a DRAFT: nothing is
 * written until Save, so a half-finished change never lands on a live role.
 *
 * Cascade is unchanged and deliberately so. Saving a page still applies its
 * mask to every descendant, exactly as before — "Apply to Children" is an
 * explicit re-push, not the only way to propagate. Making cascade opt-in would
 * have quietly narrowed every future grant.
 *
 * Self-lockout guard is preserved: your own role is read-only, for everyone.
 */

/* Per-permission accent, keyed by the catalogue's lowercased name. The
   catalogue is DB-driven, so an unknown name simply falls back to neutral
   rather than breaking the row. */
const PERM_STYLE = {
  view:    { bar: 'var(--info)',    fg: 'var(--info-fg)',    soft: 'var(--info-soft)' },
  add:     { bar: 'var(--success)', fg: 'var(--success-fg)', soft: 'var(--success-soft)' },
  edit:    { bar: 'var(--warning)', fg: 'var(--warning-fg)', soft: 'var(--warning-soft)' },
  delete:  { bar: 'var(--danger)',  fg: 'var(--danger-fg)',  soft: 'var(--danger-soft)' },
  import:  { bar: 'var(--chart-5)', fg: 'var(--chart-5)',    soft: 'var(--neutral-soft)' },
  export:  { bar: 'var(--chart-6)', fg: 'var(--chart-6)',    soft: 'var(--neutral-soft)' },
  execute: { bar: 'var(--chart-4)', fg: 'var(--chart-4)',    soft: 'var(--neutral-soft)' },
  approve: { bar: 'var(--border-strong)', fg: 'var(--fg-muted)', soft: 'var(--neutral-soft)' },
  restart: { bar: 'var(--chart-3)', fg: 'var(--chart-3)',    soft: 'var(--neutral-soft)' },
};
const styleFor = (name) => PERM_STYLE[String(name).toLowerCase()]
  || { bar: 'var(--border-strong)', fg: 'var(--fg-muted)', soft: 'var(--neutral-soft)' };

/** "Full Access" is the catalogue's sentinel — the sum of every real bit (511
    today, 255 before Restart was added). It is matched by NAME, never by value,
    so adding a bit tomorrow needs no change here. */
const isRealPermission = (p) => String(p.permission_name).toLowerCase() !== 'full access';

/** Every descendant of a page, by real parent_id — used for the cascade. */
function descendantsOf(pageId, allPages) {
  const out = [];
  const walk = (id) => {
    allPages.filter((p) => p.parent_id === id).forEach((c) => { out.push(c); walk(c.page_id); });
  };
  walk(pageId);
  return out;
}

export default function RolePermissionsMatrix() {
  const qc = useQueryClient();
  const { canHere } = usePermissions();
  const myRoleId = useAuthStore((s) => s.user?.role_id);
  const orgId = useAuthStore((s) => s.user?.org_id) ?? 1;
  const canEdit = canHere('edit');

  const [roleId, setRoleId] = useState(null);
  const [selectedPageId, setSelectedPageId] = useState(null);
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState(() => new Set());
  /** Draft masks by page_id. Only pages the user actually touched appear here,
      so Save writes the minimum rather than re-pushing the whole tree. */
  const [draft, setDraft] = useState({});
  const [saveError, setSaveError] = useState(null);
  const [savedNote, setSavedNote] = useState(null);

  const roles = useQuery({ queryKey: ['admin', 'roles', orgId], queryFn: () => rolesApi.list(orgId) });
  const pages = useQuery({ queryKey: ['admin', 'pages'], queryFn: () => pagesApi.list() });
  const modules = useQuery({ queryKey: ['admin', 'modules'], queryFn: () => modulesApi.list() });
  const perms = useQuery({ queryKey: ['admin', 'permissions'], queryFn: () => permissionsApi.list() });
  const grants = useQuery({
    queryKey: ['admin', 'role-permissions', orgId, roleId],
    queryFn: () => rolePermissionsApi.list(orgId, roleId),
    enabled: !!roleId,
  });

  const roleList = useMemo(() => (roles.data || []).filter((r) => r.is_active !== false), [roles.data]);
  const pageList = useMemo(() => (pages.data || []).filter((p) => p.is_active !== false), [pages.data]);
  const permList = useMemo(
    () => (perms.data || []).filter(isRealPermission).sort((a, b) => a.permission_value - b.permission_value),
    [perms.data],
  );
  const moduleName = useMemo(() => {
    const m = {};
    (modules.data || []).forEach((x) => { m[x.module_id] = x.module_name; });
    return m;
  }, [modules.data]);
  const moduleList = useMemo(
    () => (modules.data || [])
      .filter((m) => m.is_active !== false)
      .sort((a, b) => (a.display_order - b.display_order)
        || String(a.module_name).localeCompare(String(b.module_name))),
    [modules.data],
  );

  // First active role by default, so the screen is never an empty shell.
  useEffect(() => {
    if (roleId == null && roleList.length) setRoleId(roleList[0].role_id);
  }, [roleList, roleId]);

  /** Saved mask per page, straight from the API. */
  const savedMask = useMemo(() => {
    const m = {};
    (grants.data || []).forEach((g) => { m[g.page_id] = Number(g.permission) || 0; });
    return m;
  }, [grants.data]);

  const maskOf = (pageId) => (pageId in draft ? draft[pageId] : (savedMask[pageId] ?? 0));
  const dirtyIds = useMemo(
    () => Object.keys(draft).map(Number).filter((id) => (draft[id] ?? 0) !== (savedMask[id] ?? 0)),
    [draft, savedMask],
  );
  const isDirty = dirtyIds.length > 0;

  // Changing role must not carry a half-finished draft across to another role.
  useEffect(() => { setDraft({}); setSaveError(null); setSavedNote(null); }, [roleId]);

  /* ── tree ───────────────────────────────────────────────────────────────── */
  /* Children keyed by parent_id, each level ordered by display_order — the same
     order the real navigation uses, so the tree reads like the app's own menu
     rather than like a database dump. */
  const childrenOf = useMemo(() => {
    const m = {};
    pageList.forEach((p) => { (m[p.parent_id ?? 0] ||= []).push(p); });
    Object.values(m).forEach((arr) => arr.sort(
      (a, b) => (a.display_order - b.display_order) || a.page_name.localeCompare(b.page_name),
    ));
    return m;
  }, [pageList]);

  /* Roots grouped by MODULE, so the tree is
       Dashboard ─ Main Dashboard / Cloud Dashboard / …
       Agents    ─ /agents ─ Add Data ─ Integrations ─ Apache
     A page whose parent_id is 0 is a root WITHIN its module; nesting below that
     follows parent_id all the way down, at any depth. */
  const rootsByModule = useMemo(() => {
    const m = {};
    (childrenOf[0] || []).forEach((p) => { (m[p.module_id] ||= []).push(p); });
    return m;
  }, [childrenOf]);

  const q = search.trim().toLowerCase();
  /** Pages matching the search, plus every ancestor, so a deep match stays
      reachable instead of appearing to have no parent. */
  const visibleIds = useMemo(() => {
    if (!q) return null;
    const byId = new Map(pageList.map((p) => [p.page_id, p]));
    const keep = new Set();
    pageList.forEach((p) => {
      const hit = p.page_name?.toLowerCase().includes(q) || p.page_url?.toLowerCase().includes(q)
        || p.page_code?.toLowerCase().includes(q);
      if (!hit) return;
      keep.add(p.page_id);
      let cur = byId.get(p.parent_id);
      while (cur) { keep.add(cur.page_id); cur = byId.get(cur.parent_id); }
    });
    return keep;
  }, [q, pageList]);

  // Modules are expandable too, so Expand All has to cover them — otherwise it
  // would open every page but leave the modules containing them shut.
  const allParentIds = useMemo(() => [
    ...moduleList.filter((m) => (rootsByModule[m.module_id] || []).length).map((m) => `mod-${m.module_id}`),
    ...pageList.filter((p) => (childrenOf[p.page_id] || []).length).map((p) => p.page_id),
  ], [pageList, childrenOf, moduleList, rootsByModule]);
  const allExpanded = expanded.size >= allParentIds.length && allParentIds.length > 0;
  const toggleExpandAll = () => setExpanded(allExpanded ? new Set() : new Set(allParentIds));
  const toggleNode = (id) => setExpanded((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  const selectedPage = useMemo(
    () => pageList.find((p) => p.page_id === selectedPageId) || null,
    [pageList, selectedPageId],
  );
  const breadcrumb = useMemo(() => {
    if (!selectedPage) return [];
    const byId = new Map(pageList.map((p) => [p.page_id, p]));
    const chain = [];
    let cur = selectedPage;
    while (cur) { chain.unshift(cur); cur = byId.get(cur.parent_id); }
    return chain;
  }, [selectedPage, pageList]);

  /* ── editing ────────────────────────────────────────────────────────────── */
  const mask = selectedPage ? maskOf(selectedPage.page_id) : 0;
  const activePerms = permList.filter((p) => (mask & p.permission_value) === p.permission_value);
  const viewingOwnRole = roleId != null && Number(roleId) === Number(myRoleId);
  const readOnly = !canEdit || viewingOwnRole;

  const setMask = (pageId, next) => setDraft((d) => ({ ...d, [pageId]: next }));
  const togglePerm = (p) => {
    if (readOnly || !selectedPage) return;
    const cur = maskOf(selectedPage.page_id);
    setMask(selectedPage.page_id, (cur & p.permission_value) ? cur & ~p.permission_value : cur | p.permission_value);
  };

  /** Stage the selected page's mask onto every descendant. Still a draft — it
      writes nothing until Save, so it can be reviewed or cancelled. */
  const applyToChildren = () => {
    if (readOnly || !selectedPage) return;
    const kids = descendantsOf(selectedPage.page_id, pageList);
    if (!kids.length) return;
    const m = maskOf(selectedPage.page_id);
    setDraft((d) => {
      const n = { ...d };
      kids.forEach((k) => { n[k.page_id] = m; });
      return n;
    });
    setSavedNote(`Staged ${kids.length} child page${kids.length === 1 ? '' : 's'} — not saved yet.`);
  };

  const [copyFrom, setCopyFrom] = useState('');
  /** Copy another role's mask for THIS page into the draft. The inverse of the
      old "clone to…", which could only push your role outward. */
  const copyFromRole = async () => {
    if (readOnly || !selectedPage || !copyFrom) return;
    try {
      const rows = await rolePermissionsApi.list(orgId, Number(copyFrom));
      const row = (rows || []).find((r) => r.page_id === selectedPage.page_id);
      setMask(selectedPage.page_id, Number(row?.permission) || 0);
      const name = roleList.find((r) => String(r.role_id) === String(copyFrom))?.role_name || 'role';
      setSavedNote(`Copied this page's permissions from ${name} — not saved yet.`);
    } catch (e) {
      setSaveError(e?.message || 'Could not read that role.');
    }
  };

  const resetDraft = () => { setDraft({}); setSaveError(null); setSavedNote(null); };

  const save = useMutation({
    mutationFn: async () => {
      const rows = grants.data || [];
      for (const pageId of dirtyIds) {
        const value = draft[pageId] ?? 0;
        const description = permList
          .filter((p) => (value & p.permission_value) === p.permission_value)
          .map((p) => p.permission_name).join(' + ') || 'No access';
        const payload = { org_id: orgId, role_id: Number(roleId), page_id: Number(pageId), permission: value, permission_description: description };
        const existing = rows.find((r) => r.page_id === Number(pageId));
        if (existing) await rolePermissionsApi.update(existing.page_permission_id, payload);
        else await rolePermissionsApi.create(payload);

        // Cascade, unchanged from the previous screen: a page's mask always
        // reaches its descendants. Skipped for pages the user already staged
        // explicitly (via Apply to Children), so an explicit choice wins.
        const kids = descendantsOf(Number(pageId), pageList)
          .filter((k) => !(k.page_id in draft));
        for (const k of kids) {
          const kp = { ...payload, page_id: k.page_id };
          const kExisting = rows.find((r) => r.page_id === k.page_id);
          if (kExisting) await rolePermissionsApi.update(kExisting.page_permission_id, kp);
          else await rolePermissionsApi.create(kp);
        }
      }
    },
    onSuccess: () => {
      setDraft({});
      setSaveError(null);
      setSavedNote('Permissions saved.');
      qc.invalidateQueries({ queryKey: ['admin', 'role-permissions'] });
    },
    onError: (e) => setSaveError(e?.message || 'Save failed.'),
  });

  // A draft lost to a stray click or a closed tab is the whole reason this
  // screen defers writes; warn on the way out.
  useEffect(() => {
    if (!isDirty) return undefined;
    const onBeforeUnload = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [isDirty]);

  if (roles.isLoading || pages.isLoading || perms.isLoading) {
    return <PageLoading title="Loading access control…" />;
  }

  return (
    <div className="card overflow-hidden">
      {/* ── panel header ─────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-card py-card">
        <div className="min-w-0">
          <h2 className="text-[16px] font-bold text-fg">Role Permissions</h2>
          <p className="text-[12px] text-muted">Select a role and manage page permissions</p>
        </div>
        <div className="flex items-center gap-2.5">
          <span className="text-[12.5px] font-medium text-muted">Select Role</span>
          <div className="w-64">
            <Select
              value={roleId == null ? '' : String(roleId)}
              onChange={(v) => setRoleId(Number(v))}
              options={roleList.map((r) => ({ id: String(r.role_id), label: r.role_name }))}
              placeholder="Choose a role"
            />
          </div>
          <Badge tone={viewingOwnRole ? 'warning' : 'success'} size="xs">
            {viewingOwnRole ? 'Your role' : 'Active'}
          </Badge>
        </div>
      </div>

      {viewingOwnRole && (
        <div className="px-card pt-card">
          <Notice tone="warning" title="This is your own role">
            You cannot change the permissions of the role you are signed in with — that is the
            guard that stops an administrator locking themselves out. Pick another role to edit.
          </Notice>
        </div>
      )}

      <div className="grid gap-gutter-lg p-card lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
        {/* ── page tree ──────────────────────────────────────────────────── */}
        <div className="rounded-card border border-border">
          <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2.5">
            <h3 className="text-[13px] font-bold text-fg">Application Menu (Pages)</h3>
            <button type="button" onClick={toggleExpandAll}
                    className="text-[12px] font-semibold text-accent-text transition-colors hover:underline">
              {allExpanded ? 'Collapse All' : 'Expand All'}
            </button>
          </div>
          <div className="p-2.5">
            <Input value={search} onChange={(e) => setSearch(e.target.value)} onClear={() => setSearch('')}
                   placeholder="Search pages…" icon="search" size="sm" />
          </div>
          <div className="max-h-[560px] overflow-y-auto px-1.5 pb-2.5">
            {moduleList.map((mod) => {
              const roots = (rootsByModule[mod.module_id] || [])
                .filter((p) => !visibleIds || visibleIds.has(p.page_id));
              if (!roots.length) return null;
              const key = `mod-${mod.module_id}`;
              const open = !!q || expanded.has(key);
              return (
                <div key={key} className="mb-0.5">
                  <button type="button" onClick={() => toggleNode(key)}
                          className="flex w-full items-center gap-1 rounded-control px-1.5 py-1.5 text-left hover:bg-sunken">
                    <Icon name={open ? 'chevron-down' : 'chevron-right'} size={13} className="shrink-0 text-subtle" />
                    <Icon name="boxes" size={13} className="shrink-0 text-muted" />
                    <span className="truncate text-[12.5px] font-bold text-fg">{mod.module_name}</span>
                    <span className="ml-auto shrink-0 text-[10.5px] text-subtle">{roots.length}</span>
                  </button>
                  {open && (
                    <TreeLevel
                      parentId={0}
                      only={roots}
                      depth={1}
                      childrenOf={childrenOf}
                      visibleIds={visibleIds}
                      expanded={expanded}
                      forceOpen={!!q}
                      onToggle={toggleNode}
                      selectedId={selectedPageId}
                      onSelect={setSelectedPageId}
                      maskOf={maskOf}
                      dirty={draft}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* ── right column ───────────────────────────────────────────────── */}
        <div className="min-w-0 space-y-gutter-lg">
          {!selectedPage ? (
            <div className="rounded-card border border-border p-10 text-center">
              <Icon name="route" size={28} className="mx-auto mb-2 text-subtle" />
              <p className="text-[13px] font-semibold text-fg">Select a page</p>
              <p className="mt-0.5 text-[12px] text-muted">
                Pick a page from the menu to view its details and set permissions.
              </p>
            </div>
          ) : (
            <>
              <PageDetails page={selectedPage} breadcrumb={breadcrumb} moduleName={moduleName}
                           onPick={setSelectedPageId} />

              <div className="rounded-card border border-border">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
                  <div className="min-w-0">
                    <h3 className="text-[14px] font-bold text-fg">Permissions</h3>
                    <p className="text-[12px] text-muted">Select permissions for the selected page</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="w-44">
                      <Select value={copyFrom} onChange={setCopyFrom} placeholder="Copy from role…"
                              options={roleList.filter((r) => r.role_id !== roleId)
                                .map((r) => ({ id: String(r.role_id), label: r.role_name }))} />
                    </div>
                    <Button size="sm" variant="secondary" icon="copy" onClick={copyFromRole}
                            disabled={readOnly || !copyFrom}>Copy</Button>
                    <Button size="sm" variant="secondary" icon="chevron-down" onClick={applyToChildren}
                            disabled={readOnly || !descendantsOf(selectedPage.page_id, pageList).length}>
                      Apply to Children
                    </Button>
                    <Button size="sm" variant="ghost" icon="refresh" onClick={resetDraft}
                            disabled={!isDirty}>Reset</Button>
                  </div>
                </div>

                <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,240px)]">
                  <div className="divide-y divide-border rounded-card border border-border">
                    {permList.map((p) => {
                      const on = (mask & p.permission_value) === p.permission_value;
                      const st = styleFor(p.permission_name);
                      // The whole row toggles. Checkbox is itself a <button>, so
                      // it carries no handler of its own here — its click simply
                      // bubbles to this row, which toggles exactly once. A
                      // <label> wrapper would have risked a double fire.
                      return (
                        <div key={p.permission_id}
                             role="button" tabIndex={readOnly ? -1 : 0}
                             aria-pressed={on} aria-disabled={readOnly}
                             onClick={() => togglePerm(p)}
                             onKeyDown={(e) => {
                               if (readOnly) return;
                               if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePerm(p); }
                             }}
                             className={cn('flex items-center gap-3 px-3 py-2.5 outline-none',
                               readOnly ? 'cursor-not-allowed opacity-70'
                                 : 'cursor-pointer hover:bg-sunken focus-visible:bg-sunken')}>
                          <Checkbox checked={on} disabled={readOnly} label={p.permission_name} />
                          <span className="w-32 shrink-0 text-[13px] font-semibold" style={{ color: st.fg }}>
                            {p.permission_name} ({p.permission_value})
                          </span>
                          <span className="min-w-0 flex-1 truncate text-[12.5px] text-muted">
                            {PERM_HINT[String(p.permission_name).toLowerCase()] || `Grants ${p.permission_name}`}
                          </span>
                          <Badge tone={on ? 'success' : 'danger'} size="xs">{on ? 'Enabled' : 'Disabled'}</Badge>
                        </div>
                      );
                    })}
                  </div>

                  <div className="space-y-3">
                    <div className="rounded-card border border-accent-border bg-accent-softer px-4 py-4 text-center">
                      <p className="text-[11px] font-bold tracking-wide text-muted uppercase">Permission Value</p>
                      <p className="mt-1 text-[32px] leading-none font-bold text-accent-text">{mask}</p>
                      <p className="mt-1.5 text-[11.5px] text-muted">
                        {activePerms.length
                          ? `(${activePerms.map((p) => p.permission_value).join(' + ')})`
                          : '(no permissions)'}
                      </p>
                    </div>
                    <div className="rounded-card border border-border px-3 py-3">
                      <p className="mb-2 text-[11px] font-bold tracking-wide text-muted uppercase">Active Permissions</p>
                      {activePerms.length ? (
                        <div className="flex flex-wrap gap-1.5">
                          {activePerms.map((p) => {
                            const st = styleFor(p.permission_name);
                            return (
                              <button key={p.permission_id} type="button" disabled={readOnly}
                                      onClick={() => togglePerm(p)}
                                      className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11.5px] font-semibold disabled:cursor-not-allowed"
                                      style={{ color: st.fg, background: st.soft }}>
                                {p.permission_name}
                                {!readOnly && <Icon name="close" size={11} />}
                              </button>
                            );
                          })}
                        </div>
                      ) : <p className="text-[12px] text-subtle">None granted.</p>}
                    </div>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── footer ───────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-sunken px-card py-3">
        <div className="flex min-w-0 items-start gap-2 text-[12px] text-muted">
          <Icon name="info" size={14} className="mt-px shrink-0 text-info-fg" />
          <p className="min-w-0">
            A parent page must have View for its children to be reachable. Saving a page also
            applies its permissions to every child page.
            {isDirty && <b className="ml-1 font-semibold text-warning-fg">
              {dirtyIds.length} unsaved page{dirtyIds.length === 1 ? '' : 's'}.
            </b>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {saveError && <span className="text-[12px] font-semibold text-danger-fg">{saveError}</span>}
          {!saveError && savedNote && <span className="text-[12px] text-muted">{savedNote}</span>}
          <Button variant="secondary" onClick={resetDraft} disabled={!isDirty}>Cancel</Button>
          <Button variant="primary" icon="lock" onClick={() => save.mutate()}
                  disabled={readOnly || !isDirty || save.isPending}>
            {save.isPending ? 'Saving…' : 'Save Permissions'}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Short descriptions. The catalogue carries no description column, so these
    are keyed by name and fall back to a generic line for anything new. */
const PERM_HINT = {
  view: 'Can view the page/menu',
  add: 'Can add new data',
  edit: 'Can modify existing data',
  delete: 'Can delete data',
  import: 'Can import data',
  export: 'Can export data',
  execute: 'Can execute actions',
  approve: 'Can approve data',
  restart: 'Can restart services',
};

/** `only` overrides the parentId lookup — the module level passes the roots it
    has already narrowed to that module, since parent_id 0 spans every module. */
function TreeLevel({ parentId, only, depth, childrenOf, visibleIds, expanded, forceOpen, onToggle, selectedId, onSelect, maskOf, dirty }) {
  const kids = only || (childrenOf[parentId] || []).filter((p) => !visibleIds || visibleIds.has(p.page_id));
  if (!kids.length) return null;
  return (
    <ul className={depth ? 'ml-3.5 border-l border-border pl-1.5' : undefined}>
      {kids.map((p) => {
        const hasKids = (childrenOf[p.page_id] || []).length > 0;
        const open = forceOpen || expanded.has(p.page_id);
        const isSel = p.page_id === selectedId;
        const mask = maskOf(p.page_id);
        return (
          <li key={p.page_id}>
            <div className={cn('group flex items-center gap-1 rounded-control px-1.5 py-1',
              isSel ? 'bg-accent-soft' : 'hover:bg-sunken')}>
              {hasKids ? (
                <button type="button" onClick={() => onToggle(p.page_id)}
                        aria-label={open ? 'Collapse' : 'Expand'} className="shrink-0 p-0.5 text-subtle hover:text-fg">
                  <Icon name={open ? 'chevron-down' : 'chevron-right'} size={13} />
                </button>
              ) : <span className="w-[18px] shrink-0" />}
              <button type="button" onClick={() => onSelect(p.page_id)}
                      className="flex min-w-0 flex-1 items-center gap-1.5 py-0.5 text-left">
                <Icon name={p.is_menu === false ? 'file-edit' : 'route'} size={12}
                      className={isSel ? 'text-accent-text' : 'text-subtle'} />
                <span className={cn('truncate text-[12.5px]',
                  isSel ? 'font-semibold text-accent-text' : 'text-fg')}>{p.page_name}</span>
                {/* A page with any permission gets a dot; a staged edit gets an
                    amber one, so unsaved work is visible without opening it. */}
                {(p.page_id in dirty) ? (
                  <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-warning" title="Unsaved change" />
                ) : mask > 0 ? (
                  <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-success" title={`Permission value ${mask}`} />
                ) : null}
              </button>
            </div>
            {hasKids && open && (
              <TreeLevel parentId={p.page_id} depth={depth + 1} childrenOf={childrenOf}
                         visibleIds={visibleIds} expanded={expanded} forceOpen={forceOpen}
                         onToggle={onToggle} selectedId={selectedId} onSelect={onSelect}
                         maskOf={maskOf} dirty={dirty} />
            )}
          </li>
        );
      })}
    </ul>
  );
}

function PageDetails({ page, breadcrumb, moduleName, onPick }) {
  const Row = ({ label, children }) => (
    <div className="flex min-w-0 gap-2">
      <span className="w-28 shrink-0 text-[12px] font-semibold text-muted">{label}</span>
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg">{children}</span>
    </div>
  );
  return (
    <div className="rounded-card border border-border">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <Icon name="route" size={14} className="text-accent-text" />
        <h3 className="text-[13.5px] font-bold text-fg">Selected Page Details</h3>
      </div>
      <div className="px-4 py-3">
        <nav aria-label="Page path" className="mb-3 flex flex-wrap items-center gap-1 text-[12.5px]">
          {breadcrumb.map((b, i) => (
            <span key={b.page_id} className="flex items-center gap-1">
              {i > 0 && <Icon name="chevron-right" size={12} className="text-subtle" />}
              {i === breadcrumb.length - 1
                ? <span className="font-semibold text-fg">{b.page_name}</span>
                : <button type="button" onClick={() => onPick(b.page_id)}
                          className="text-accent-text transition-colors hover:underline">{b.page_name}</button>}
            </span>
          ))}
        </nav>
        <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
          <Row label="Page Name">{page.page_name}</Row>
          <Row label="Page ID">{page.page_id}</Row>
          <Row label="Page Code"><span className="font-mono text-[11.5px]">{page.page_code}</span></Row>
          <Row label="Module">{moduleName[page.module_id] ? `${page.module_id} (${moduleName[page.module_id]})` : page.module_id}</Row>
          <Row label="Page URL"><span className="font-mono text-[11.5px]">{page.page_url || '—'}</span></Row>
          <Row label="Menu Item">
            <Badge tone={page.is_menu ? 'success' : 'danger'} size="xs">{page.is_menu ? 'Yes' : 'No'}</Badge>
          </Row>
          <Row label="Display Order">{page.display_order ?? 0}</Row>
        </div>
      </div>
    </div>
  );
}
