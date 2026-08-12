import { Fragment, useMemo } from 'react';
import { Link, useLocation } from 'react-router-dom';
import cn from '@/lib/cn';
import Icon from '@/components/ui/Icon';
import { NAV_INDEX, ROUTE_LABELS } from '@/config/navigation';

/** Numeric / uuid-ish path parts are record ids, not page names. */
const isIdSegment = (s) => /^\d+$/.test(s) || /^[0-9a-f]{8}-[0-9a-f]{4}/i.test(s);

const titleize = (s) =>
  s.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * Route-derived trail.
 *
 * Labels resolve in three steps: exact nav match → ROUTE_LABELS lookup →
 * title-cased slug. Id segments render as `#123` so a drill-down still reads
 * sensibly without us needing the record's name.
 */
export default function Breadcrumbs({ className }) {
  const { pathname } = useLocation();

  const crumbs = useMemo(() => {
    const parts = pathname.split('/').filter(Boolean);
    return parts.map((part, i) => {
      const to = `/${parts.slice(0, i + 1).join('/')}`;
      const navHit = NAV_INDEX.find((n) => n.to === to);
      const label = navHit?.label
        || (isIdSegment(part) ? `#${part}` : ROUTE_LABELS[part] || titleize(part));
      return { to, label, last: i === parts.length - 1 };
    });
  }, [pathname]);

  if (!crumbs.length) return null;

  return (
    <nav aria-label="Breadcrumb" className={cn('flex min-w-0 items-center gap-1 text-[13px]', className)}>
      <Link
        to="/dashboard"
        className="shrink-0 rounded-sm p-0.5 text-topbar-muted transition-colors hover:text-topbar-fg"
        aria-label="Dashboard"
      >
        <Icon name="dashboard" size={15} />
      </Link>

      {crumbs.map((c) => (
        <Fragment key={c.to}>
          <Icon name="chevron-right" size={13} className="shrink-0 text-topbar-muted opacity-50" />
          {c.last ? (
            <span className="truncate font-semibold text-topbar-fg" aria-current="page">{c.label}</span>
          ) : (
            <Link to={c.to} className="truncate text-topbar-muted transition-colors hover:text-topbar-fg">
              {c.label}
            </Link>
          )}
        </Fragment>
      ))}
    </nav>
  );
}
