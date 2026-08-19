import { useNavigate } from 'react-router-dom';
import PageHeader from '@/components/layout/PageHeader';
import Icon from '@/components/ui/Icon';
import Button from '@/components/ui/Button';
import { APP } from '@/config/app.config';

/**
 * Shown by AppShell (see isDeniedHere in usePermissions.js) whenever a signed-in
 * user's role hasn't been granted View on the current URL — reached by typing
 * or bookmarking a route directly, since the nav itself already hides links a
 * role can't see. Blocking here is what actually enforces RBAC on navigation;
 * hiding a menu item was only ever a discoverability nicety, not access control.
 */
export default function AccessDeniedPage() {
  const navigate = useNavigate();
  return (
    <>
      <PageHeader title="Access Denied" icon="shield" description="Your role doesn't have permission to view this page." />
      <div className="card grid place-items-center gap-3 p-10 text-center">
        <div className="grid h-12 w-12 place-items-center rounded-full bg-danger-soft text-danger-fg">
          <Icon name="shield" size={24} />
        </div>
        <div>
          <p className="text-sm font-semibold text-fg">You don't have access to this page</p>
          <p className="mt-1 text-[13px] text-muted">
            If you believe this is a mistake, ask a Super Admin to grant your role View access under Group Role Permissions.
          </p>
        </div>
        <Button variant="primary" icon="layout-grid" onClick={() => navigate(APP.defaultRoute)}>Back to Dashboard</Button>
      </div>
    </>
  );
}
