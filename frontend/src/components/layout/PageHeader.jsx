import { Link } from 'react-router-dom';
import cn from '@/lib/cn';
import Icon from '@/components/ui/Icon';
import Breadcrumbs from './Breadcrumbs';
import { useThemeStore } from '@/theme/themeStore';

/**
 * Standard page heading. Every page uses this so titles, descriptions and
 * primary actions line up identically across the app.
 *
 * `icon` takes either a token name from the icon set ("database") or an icon
 * component. The ported engine sub-pages pass components, and a component handed
 * to <Icon name> resolves to the fallback circle — so both forms are accepted
 * rather than leaving those pages silently iconless.
 *
 * `subtitle` is an accepted alias for `description` for the same reason.
 *
 * The breadcrumb trail is rendered HERE, right-aligned above the actions. It used
 * to belong to the old 56px top bar; the module bar that replaced that bar has no
 * room for it, and the design puts the trail on the title row anyway. Still gated
 * by the `showBreadcrumbs` appearance setting, so it stays switchable.
 *
 * `crumbs` is deliberately NOT rendered: pages may still pass it, but the trail is
 * derived from the route so the two can't disagree.
 */
export default function PageHeader({
  title,
  description,
  subtitle,
  icon,
  /** Replaces the icon tile — for pages whose subject has its own mark
      (a database engine's logo and colour, for instance). */
  leading,
  /** Renders a back link before the title. */
  backTo,
  backLabel = 'Back',
  actions,
  tabs,
  className,
  children,
  /** Opt out of the breadcrumb trail on a page whose reference design has
      none — the Agents list, specced pixel-for-pixel against Figma, is the
      first case. Everything else keeps following the app-wide setting. */
  hideBreadcrumbs = false,
}) {
  const showCrumbs = useThemeStore((s) => s.showBreadcrumbs) && !hideBreadcrumbs;
  const sub = description ?? subtitle;
  const mark = typeof icon === 'function' || (icon && typeof icon === 'object')
    ? (() => { const C = icon; return <C size={20} />; })()
    : (icon && <Icon name={icon} size={20} />);

  return (
    /* Two hooks, deliberately separate (see styles/tokens.css):
         header-surface  the configurable colour / gradient / texture. Anything
                         may borrow the look — the Settings page previews with it.
         page-header     THE page header, and so the only thing that gets pinned. */
    <div className={cn('page-header header-surface mb-gutter', className)}>
      <div className="flex flex-wrap items-start justify-between gap-gutter-sm">
        <div className="flex min-w-0 items-start gap-3">
          {backTo && (
            <Link
              to={backTo}
              title={backLabel}
              aria-label={backLabel}
              className="grid h-10 w-10 shrink-0 place-items-center rounded-md border border-border text-muted transition-colors hover:bg-sunken hover:text-fg"
            >
              <Icon name="chevron-left" size={18} />
            </Link>
          )}
          {leading || (mark && (
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-accent-soft text-accent-text">
              {mark}
            </div>
          ))}
          <div className="min-w-0">
            <h1 className="truncate-safe text-[1.75rem] leading-[1.2] font-semibold tracking-[-0.01em] text-muted">{title}</h1>
            {sub && (
              <p className="mt-0.5 text-[0.8125rem] leading-snug text-muted">{sub}</p>
            )}
          </div>
        </div>

        {/* ml-auto + justify-end so the actions stay right-aligned even when a long
            subtitle pushes them onto their own line — without it they wrapped and
            went flush left, which is why two reports with the same shell looked
            like different pages. */}
        {(showCrumbs || actions) && (
          <div className="ml-auto flex flex-col items-end gap-2">
            {showCrumbs && <Breadcrumbs className="hidden justify-end md:flex" />}
            {actions && (
              <div className="flex flex-wrap items-center justify-end gap-2">{actions}</div>
            )}
          </div>
        )}
      </div>

      {tabs && (
        <div className="no-scrollbar mt-gutter-sm flex gap-1 overflow-x-auto border-b border-border">
          {tabs}
        </div>
      )}

      {children}
    </div>
  );
}
