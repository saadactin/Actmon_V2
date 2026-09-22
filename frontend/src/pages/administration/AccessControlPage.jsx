import { lazy, Suspense } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import cn from '@/lib/cn';
import Icon from '@/components/ui/Icon';
import { PageLoading } from '@/components/ui/Loading';
import AdminResourcePage from './_shared/AdminResourcePage';
import { ADMIN_RESOURCES } from '@/config/adminResources';

const RolePermissionsMatrix = lazy(() => import('./accessControl/RolePermissionsMatrix'));
const UserRolesTab = lazy(() => import('./accessControl/UserRolesTab'));

/**
 * Access Control — one screen over the whole RBAC model.
 *
 * Until now these lived as six unrelated routes reached from a card grid, so
 * "who can do what" meant navigating away and back six times. The tab strip
 * keeps all of it in one place; each tab is still the same component it always
 * was, embedded rather than re-implemented, so the standalone routes and these
 * cannot drift apart.
 *
 * The tab lives in the URL (/access-control/:tab) so a tab is linkable and
 * survives a refresh — a screen people send each other links to.
 */

/* Icons match what each resource's own config already uses (adminResources.jsx),
   so a tab and the screen it opens never show two different glyphs. */
const TABS = [
  { id: 'roles',            label: 'Roles',            hint: 'Manage roles',                icon: 'shield' },
  { id: 'pages',            label: 'Pages',            hint: 'Manage application pages',    icon: 'route' },
  { id: 'permissions',      label: 'Permissions',      hint: 'Manage permission types',     icon: 'key' },
  { id: 'role-permissions', label: 'Role Permissions', hint: 'Assign permissions to roles', icon: 'shield-check' },
  { id: 'user-roles',       label: 'User Roles',       hint: 'Assign roles to users',       icon: 'users' },
  { id: 'audit-logs',       label: 'Audit Logs',       hint: 'Track changes and activity',  icon: 'logs' },
];

const DEFAULT_TAB = 'role-permissions';

export default function AccessControlPage() {
  const { tab } = useParams();
  const navigate = useNavigate();
  const active = TABS.some((t) => t.id === tab) ? tab : DEFAULT_TAB;
  const activeTab = TABS.find((t) => t.id === active);

  return (
    <div className="pb-gutter-lg">
      {/* ── header ─────────────────────────────────────────────────────────── */}
      <div className="mb-gutter-lg flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-success-soft text-success-fg">
            <Icon name="shield-check" size={22} />
          </span>
          <div className="min-w-0">
            <h1 className="text-[22px] leading-tight font-bold text-fg">Access Control</h1>
            <p className="mt-0.5 text-[13px] text-muted">
              Manage application access, roles, pages and permissions
            </p>
          </div>
        </div>
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-[12.5px] text-muted">
          <Link to="/dashboard" className="transition-colors hover:text-fg">Home</Link>
          <Icon name="chevron-right" size={13} className="text-subtle" />
          <Link to="/access-control" className="transition-colors hover:text-fg">Access Control</Link>
          <Icon name="chevron-right" size={13} className="text-subtle" />
          <span className="font-semibold text-fg">{activeTab.label}</span>
        </nav>
      </div>

      {/* ── tab strip ──────────────────────────────────────────────────────── */}
      <div
        role="tablist"
        aria-label="Access Control sections"
        className="mb-gutter-lg grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6"
      >
        {TABS.map((t) => {
          const isActive = t.id === active;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => navigate(`/access-control/${t.id}`)}
              className={cn(
                'flex items-center gap-3 rounded-xl border px-3.5 py-3 text-left transition-colors',
                isActive
                  ? 'border-2 border-accent bg-accent-softer'
                  : 'border-border bg-surface hover:border-strong hover:bg-raised',
              )}
            >
              <span className={cn(
                'grid h-9 w-9 shrink-0 place-items-center rounded-lg',
                isActive ? 'bg-accent text-on-accent' : 'bg-sunken text-muted',
              )}>
                <Icon name={t.icon} size={17} />
              </span>
              <span className="min-w-0">
                <span className={cn(
                  'block truncate text-[13.5px] font-bold',
                  isActive ? 'text-accent-text' : 'text-fg',
                )}>
                  {t.label}
                </span>
                <span className="block truncate text-[11px] text-muted">{t.hint}</span>
              </span>
            </button>
          );
        })}
      </div>

      {/* ── panel ──────────────────────────────────────────────────────────── */}
      <Suspense fallback={<PageLoading title="Loading…" />}>
        {active === 'role-permissions' && <RolePermissionsMatrix />}
        {active === 'user-roles' && <UserRolesTab />}
        {active === 'roles' && <AdminResourcePage config={ADMIN_RESOURCES.roles} embedded />}
        {active === 'pages' && <AdminResourcePage config={ADMIN_RESOURCES.pages} embedded />}
        {active === 'permissions' && <AdminResourcePage config={ADMIN_RESOURCES.permissions} embedded />}
        {active === 'audit-logs' && <AdminResourcePage config={ADMIN_RESOURCES['audit-logs']} embedded />}
      </Suspense>
    </div>
  );
}
