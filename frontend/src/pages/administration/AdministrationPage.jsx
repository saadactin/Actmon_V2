import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import PageHeader from '@/components/layout/PageHeader';
import Icon from '@/components/ui/Icon';
import { EmptyState } from '@/components/ui/Table';
import { usePermissions } from '@/hooks/usePermissions';
import { useAuthStore } from '@/store/authStore';
import { organizationsApi } from '@/api/admin';

/**
 * The 13 sub-pages, fixed (not server-driven — same as the production
 * reference). `scope` decides how the click target is built:
 *   org    → the resource needs an org context: `{to}?org=&orgName=`
 *   global → app-wide catalog, no org context: bare `{to}`
 *   grpp   → the bespoke Role/Page Permissions screen: `/role-permissions/{orgId}`
 */
const MODULES = [
  { title: 'Roles', to: '/roles', icon: 'shield', scope: 'org', desc: 'Define the access roles available to each organization.' },
  { title: 'Group Role Permissions', to: '/role-permissions', icon: 'shield-check', scope: 'grpp', desc: 'Grant roles access to specific pages, with cascading grants.' },
  { title: 'User Master', to: '/users', icon: 'user-cog', scope: 'org', desc: 'The logins linked to employees, and each one’s role.' },
  { title: 'Employees', to: '/employees', icon: 'users', scope: 'org', desc: 'The people who can be linked to a login.' },
  { title: 'Departments', to: '/departments', icon: 'layers', scope: 'org', desc: 'The departments employees are organized into.' },
  { title: 'Designations', to: '/designations', icon: 'id-card', scope: 'org', desc: 'Job titles employees hold.' },
  { title: 'Permissions', to: '/permissions', icon: 'key', scope: 'global', desc: 'The bit-flag catalog every role’s access is built from.' },
  { title: 'Modules', to: '/modules', icon: 'boxes', scope: 'global', desc: 'The top-level areas of the app that pages belong to.' },
  { title: 'Pages', to: '/pages', icon: 'route', scope: 'global', desc: 'Every routable page/menu entry, by module and parent.' },
  { title: 'Audit Logs', to: '/audit-logs', icon: 'logs', scope: 'global', desc: 'Every insert/update/delete the app has made.' },
  { title: 'Login History', to: '/login-history', icon: 'history', scope: 'global', desc: 'Every sign-in attempt, successful or not.' },
  { title: 'User Sessions', to: '/user-sessions', icon: 'activity', scope: 'global', desc: 'Active and expired sessions issued to users.' },
  { title: 'Password History', to: '/password-history', icon: 'lock', scope: 'global', desc: 'When each user’s password was last changed.' },
];

function moduleHref(m, orgId, orgName) {
  if (m.scope === 'grpp') return `/role-permissions/${orgId}`;
  if (m.scope === 'org') return `${m.to}?org=${orgId}&orgName=${encodeURIComponent(orgName || '')}`;
  return m.to;
}

/** One card, shared shape for both the org picker and the module grid. */
/**
 * `image` (an org's `logo_path`, root-relative — served from /public) wins
 * over the icon tile when it's set and actually loads; a broken/missing
 * logo falls back to the icon rather than showing a broken-image glyph.
 */
function GridCard({ icon, title, subtitle, image, onClick }) {
  const [imageFailed, setImageFailed] = useState(false);
  const showImage = image && !imageFailed;
  return (
    <button
      type="button"
      onClick={onClick}
      className="card flex flex-col gap-3 p-5 text-left transition-shadow hover:shadow-md"
    >
      {showImage ? (
        // A brand wordmark reads at a logo size, not squeezed into the
        // small square icon tile — left-aligned, own row, real height.
        <div className="flex h-16 w-full items-center">
          <img
            src={encodeURI(image)}
            alt={title}
            className="max-h-16 max-w-[85%] object-contain object-left"
            onError={() => setImageFailed(true)}
          />
        </div>
      ) : (
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-md bg-accent-soft text-accent-text">
          <Icon name={icon} size={20} />
        </span>
      )}
      <span className="min-w-0">
        <span className="truncate-safe block text-[16px] font-bold text-fg">{title}</span>
        <span className="mt-1 block text-[13px] leading-snug text-muted">{subtitle}</span>
      </span>
      <span className="mt-auto flex items-center gap-1 text-[13px] font-semibold text-accent-text">
        Open <Icon name="chevron-right" size={13} />
      </span>
    </button>
  );
}

/**
 * Administration hub — org picker (super-admins only; everyone else is
 * bounced straight to their own org) then a 13-module grid, RBAC-filtered.
 * Handles both `/administration` and `/administration/:orgId`.
 */
export default function AdministrationPage() {
  const navigate = useNavigate();
  const { orgId: orgIdParam } = useParams();
  const { can } = usePermissions();
  const user = useAuthStore((s) => s.user);

  const { data: orgs = [], isLoading } = useQuery({
    queryKey: ['admin', 'organizations'],
    queryFn: () => organizationsApi.list(),
  });

  // Non-super users only ever manage their own org — skip the picker entirely.
  useEffect(() => {
    if (orgIdParam || isLoading || !orgs.length) return;
    if (!user?.is_superuser) {
      navigate(`/administration/${user?.org_id || orgs[0].org_id}`, { replace: true });
    }
  }, [orgIdParam, isLoading, orgs, user, navigate]);

  const visibleModules = useMemo(() => MODULES.filter((m) => can(m.to, 'view')), [can]);

  if (!orgIdParam) {
    return (
      <>
        <PageHeader
          title="Administration"
          icon="user-cog"
          description="Select an organization to manage its access control & masters."
        />
        <div className="mt-6 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {isLoading || orgs.length === 0 ? (
            <div className="col-span-full">
              <EmptyState icon="building" title={isLoading ? 'Loading organizations…' : 'No organizations yet'} />
            </div>
          ) : orgs.map((org) => (
            <GridCard
              key={org.org_id}
              icon="building"
              image={org.logo_path}
              title={org.org_name}
              subtitle={[org.org_code, org.city_name].filter(Boolean).join(' · ') || 'Organization'}
              onClick={() => navigate(`/administration/${org.org_id}`)}
            />
          ))}
        </div>
      </>
    );
  }

  const org = orgs.find((o) => String(o.org_id) === String(orgIdParam));

  return (
    <>
      <PageHeader
        title="Administration"
        icon="user-cog"
        description={`Administration & access control for ${org?.org_name || 'this organization'}.`}
        backTo="/administration"
        backLabel="Organizations"
      />
      <div className="mt-6 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {visibleModules.map((m) => (
          <GridCard
            key={m.to}
            icon={m.icon}
            title={m.title}
            subtitle={m.desc}
            onClick={() => navigate(moduleHref(m, orgIdParam, org?.org_name))}
          />
        ))}
      </div>
    </>
  );
}
