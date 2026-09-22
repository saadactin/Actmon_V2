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
 * Administration — one screen over the whole RBAC model and the masters behind it.
 *
 * Replaces the card grid that made you leave and come back for every one of
 * eleven screens. Access Control is the primary row because it is what people
 * come here to do; the org and setup masters sit in a second row rather than
 * being dropped, since the grid was their only entry point.
 *
 * The tab is in the URL (/administration/tab/:tab) so it is linkable and
 * survives a refresh, and every tab renders the SAME component its standalone
 * route does — embedded, never reimplemented — so the two cannot drift.
 */

const ACCESS_TABS = [
  { id: 'roles',            label: 'Roles',            hint: 'Manage roles',                icon: 'shield' },
  { id: 'pages',            label: 'Pages',            hint: 'Manage application pages',    icon: 'route' },
  { id: 'permissions',      label: 'Permissions',      hint: 'Manage permission types',     icon: 'key' },
  { id: 'role-permissions', label: 'Role Permissions', hint: 'Assign permissions to roles', icon: 'shield-check' },
  { id: 'user-roles',       label: 'User Roles',       hint: 'Assign roles to users',       icon: 'users' },
  { id: 'audit-logs',       label: 'Audit Logs',       hint: 'Track changes and activity',  icon: 'logs' },
];

const SETUP_TABS = [
  { id: 'users',        label: 'User Master',    hint: 'Logins linked to employees',   icon: 'user-cog' },
  { id: 'employees',    label: 'Employees',      hint: 'People who can have a login',  icon: 'users' },
  { id: 'departments',  label: 'Departments',    hint: 'How employees are organized',  icon: 'layers' },
  { id: 'designations', label: 'Designations',   hint: 'Job titles employees hold',    icon: 'id-card' },
  { id: 'modules',      label: 'Modules',        hint: 'Top-level areas of the app',   icon: 'boxes' },
  // These two are full pages with their own header and layout, not CRUD tables,
  // so they link out instead of embedding — inlining them would stack a second
  // page header under this one.
  { id: 'ai-chat',    label: 'AI Chat Sessions', hint: 'Every ActMon AI conversation',  icon: 'chat',    to: '/ai-chat-sessions' },
  { id: 'appearance', label: 'Help Center',      hint: 'Documentation library styling', icon: 'palette', to: '/help-center-appearance' },
];

const ALL_TABS = [...ACCESS_TABS, ...SETUP_TABS];
const DEFAULT_TAB = 'role-permissions';

/** Tabs that are just the generic CRUD engine with a different config. */
const RESOURCE_TAB = {
  roles: 'roles', pages: 'pages', permissions: 'permissions', 'audit-logs': 'audit-logs',
  users: 'users', employees: 'employees', departments: 'departments',
  designations: 'designations', modules: 'modules',
};

function TabCard({ tab, active, onClick }) {
  return (
    <button
      type="button" role="tab" aria-selected={active} onClick={onClick}
      className={cn(
        'flex items-center gap-3 rounded-xl border px-3.5 py-3 text-left transition-colors',
        active ? 'border-2 border-accent bg-accent-softer'
          : 'border-border bg-surface hover:border-strong hover:bg-raised',
      )}
    >
      <span className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-lg',
        active ? 'bg-accent text-on-accent' : 'bg-sunken text-muted')}>
        <Icon name={tab.icon} size={17} />
      </span>
      <span className="min-w-0">
        <span className={cn('block truncate text-[13.5px] font-bold',
          active ? 'text-accent-text' : 'text-fg')}>{tab.label}</span>
        <span className="block truncate text-[11px] text-muted">{tab.hint}</span>
      </span>
    </button>
  );
}

export default function AccessControlPage() {
  const { tab } = useParams();
  const navigate = useNavigate();
  const active = ALL_TABS.some((t) => t.id === tab) ? tab : DEFAULT_TAB;
  const activeTab = ALL_TABS.find((t) => t.id === active);
  const go = (t) => navigate(t.to || `/administration/tab/${t.id}`);
  const resourceKey = RESOURCE_TAB[active];

  return (
    <div className="pb-gutter-lg">
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
          <Link to="/administration" className="transition-colors hover:text-fg">Access Control</Link>
          <Icon name="chevron-right" size={13} className="text-subtle" />
          <span className="font-semibold text-fg">{activeTab.label}</span>
        </nav>
      </div>

      <div role="tablist" aria-label="Access Control"
           className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {ACCESS_TABS.map((t) => (
          <TabCard key={t.id} tab={t} active={t.id === active} onClick={() => go(t)} />
        ))}
      </div>

      {/* The masters the old card grid was the only way into. Kept visible and
          secondary rather than dropped — removing the grid must not strand a
          screen that nothing else links to. */}
      <div className="mb-gutter-lg">
        <p className="mb-2 text-[11px] font-bold tracking-wide text-subtle uppercase">
          Organization &amp; setup
        </p>
        <div role="tablist" aria-label="Organization and setup"
             className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-7">
          {SETUP_TABS.map((t) => (
            <TabCard key={t.id} tab={t} active={t.id === active} onClick={() => go(t)} />
          ))}
        </div>
      </div>

      <Suspense fallback={<PageLoading title="Loading…" />}>
        {active === 'role-permissions' && <RolePermissionsMatrix />}
        {active === 'user-roles' && <UserRolesTab />}
        {resourceKey && <AdminResourcePage config={ADMIN_RESOURCES[resourceKey]} embedded />}
      </Suspense>
    </div>
  );
}
