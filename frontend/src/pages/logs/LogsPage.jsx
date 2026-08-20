import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import PageHeader from '@/components/layout/PageHeader';
import Icon from '@/components/ui/Icon';
import { EmptyState } from '@/components/ui/Table';
import { usePermissions } from '@/hooks/usePermissions';

/**
 * Logs hub — centralized system/audit activity, consolidated here instead of
 * scattered across Administration (see migrations/2026-08-20_logs_module.sql,
 * which moved these 4 pages' module ownership; existing per-page grants carry
 * over unchanged since they're keyed by page_id, not module_id).
 *
 * None of these four are org-scoped (they're app-wide catalogs, same as
 * Permissions/Modules/Pages), so — unlike AdministrationPage — there's no
 * org-picker level here, just a straight RBAC-filtered grid.
 */
const LOG_PAGES = [
  { title: 'Audit Logs', to: '/audit-logs', icon: 'logs', desc: 'Every insert/update/delete the app has made.' },
  { title: 'Login History', to: '/login-history', icon: 'history', desc: 'Every sign-in attempt, successful or not.' },
  { title: 'User Sessions', to: '/user-sessions', icon: 'activity', desc: 'Active and expired sessions issued to users.' },
  { title: 'Password History', to: '/password-history', icon: 'lock', desc: 'When each user’s password was last changed.' },
];

function GridCard({ icon, title, subtitle, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="card flex flex-col gap-3 p-5 text-left transition-shadow hover:shadow-md"
    >
      <span className="grid h-11 w-11 shrink-0 place-items-center rounded-md bg-accent-soft text-accent-text">
        <Icon name={icon} size={20} />
      </span>
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

export default function LogsPage() {
  const navigate = useNavigate();
  const { can } = usePermissions();

  const visible = useMemo(() => LOG_PAGES.filter((p) => can(p.to, 'view')), [can]);

  return (
    <>
      <PageHeader
        title="Logs"
        icon="logs"
        description="System and audit activity across the app."
        hideBreadcrumbs
      />
      <div className="mt-6 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {visible.length === 0 ? (
          <div className="col-span-full"><EmptyState icon="logs" title="Nothing here yet" body="Your role hasn't been granted access to any log pages." /></div>
        ) : visible.map((p) => (
          <GridCard
            key={p.to}
            icon={p.icon}
            title={p.title}
            subtitle={p.desc}
            onClick={() => navigate(p.to)}
          />
        ))}
      </div>
    </>
  );
}
