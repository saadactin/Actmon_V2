import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import cn from '@/lib/cn';
import Icon from '@/components/ui/Icon';
import IconButton from '@/components/ui/IconButton';
import Brand from './Brand';
import NavItem, { NAV_ROW_PAD } from './NavItem';
import SidebarUser from './SidebarUser';
import { useUIStore } from '@/store/uiStore';
import { useThemeStore } from '@/theme/themeStore';
import useNavigation from '@/hooks/useNavigation';

/**
 * The navigation rail.
 *
 * The list is flat — one row per module, in module_master order — matching what
 * the app has always shown. Visibility comes from the server menu once login
 * runs (see useNavigation).
 *
 * ── Alignment ──────────────────────────────────────────────────────────────
 * Header, every nav row and the account block share one geometry so the rail
 * reads as a single column:
 *   • RAIL_PAD  horizontal padding on the header / nav / footer containers
 *   • NAV_ROW_PAD  padding inside each row (from NavItem)
 *   • a fixed 28px glyph box starts every row → all labels begin on the same x
 * Collapsed mode drops the label and centres that same box in the rail.
 */
const RAIL_PAD = 'px-2';

export default function Sidebar({ user, onSignOut }) {
  const { pathname } = useLocation();
  const collapsed = useUIStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const mobileOpen = useUIStore((s) => s.mobileNavOpen);
  const closeMobileNav = useUIStore((s) => s.closeMobileNav);

  const showLabels = useThemeStore((s) => s.showNavLabels);
  const position = useThemeStore((s) => s.sidebarPosition);

  const items = useNavigation();

  // "Hide menu names" in Appearance is the same visual state as a manual collapse.
  const iconOnly = collapsed || !showLabels;

  // Close the mobile drawer whenever the route changes.
  useEffect(() => { closeMobileNav(); }, [pathname, closeMobileNav]);

  useEffect(() => {
    if (!mobileOpen) return undefined;
    const onKey = (e) => e.key === 'Escape' && closeMobileNav();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [mobileOpen, closeMobileNav]);

  return (
    <>
      {/* desktop rail */}
      <div className="hidden lg:block">
        <Rail
          items={items}
          iconOnly={iconOnly}
          position={position}
          user={user}
          onSignOut={onSignOut}
          onToggle={toggleSidebar}
        />
      </div>

      {/* mobile drawer — always labelled; an icon rail makes no sense here */}
      <div
        className={cn('fixed inset-0 z-50 lg:hidden', mobileOpen ? 'pointer-events-auto' : 'pointer-events-none')}
        aria-hidden={!mobileOpen}
      >
        <div
          className={cn(
            'absolute inset-0 bg-black/50 transition-opacity duration-[var(--dur-normal)]',
            mobileOpen ? 'opacity-100' : 'opacity-0',
          )}
          onClick={closeMobileNav}
        />
        <div
          className={cn(
            'absolute inset-y-0 w-[var(--sidebar-w)] max-w-[86vw] shadow-xl',
            'transition-transform duration-[var(--dur-normal)] ease-[var(--ease-out)]',
            position === 'right' ? 'right-0' : 'left-0',
            mobileOpen ? 'translate-x-0' : position === 'right' ? 'translate-x-full' : '-translate-x-full',
          )}
        >
          <Rail items={items} iconOnly={false} position={position} user={user} onSignOut={onSignOut} mobile />
        </div>
      </div>
    </>
  );
}

/* ── the rail body, shared by desktop and the mobile drawer ─────────────── */
function Rail({ items, iconOnly, position, user, onSignOut, onToggle, mobile = false }) {
  const closeMobileNav = useUIStore((s) => s.closeMobileNav);

  return (
    <aside
      className={cn(
        'flex h-full shrink-0 flex-col bg-sidebar text-sidebar-fg',
        'transition-[width] duration-[var(--dur-normal)] ease-[var(--ease)]',
        position === 'right' ? 'border-l' : 'border-r',
        'border-sidebar-border',
      )}
      style={{
        width: mobile ? '100%' : iconOnly ? 'var(--sidebar-w-collapsed)' : 'var(--sidebar-w)',
        // set by the `gradient` sidebar variant; 'none' otherwise
        backgroundImage: 'var(--sidebar-bg-image)',
      }}
    >
      {/* ── header: same padding + glyph column as the rows below ── */}
      <div
        className={cn(
          'flex h-topbar shrink-0 items-center border-b border-sidebar-border',
          RAIL_PAD,
          iconOnly ? 'justify-center' : 'gap-1',
        )}
      >
        <Brand collapsed={iconOnly} className={cn('min-w-0', !iconOnly && `flex-1 ${NAV_ROW_PAD}`)} />

        {!iconOnly && !mobile && (
          <IconButton
            icon={position === 'right' ? 'chevrons-right' : 'chevrons-left'}
            label="Collapse sidebar"
            tone="chrome"
            size="sm"
            tooltipSide="bottom"
            onClick={onToggle}
          />
        )}
        {mobile && (
          <IconButton icon="close" label="Close menu" tone="chrome" size="sm" onClick={closeMobileNav} />
        )}
      </div>

      {/* ── nav ── */}
      <nav className={cn('min-h-0 flex-1 space-y-0.5 overflow-x-hidden overflow-y-auto py-2', RAIL_PAD)}>
        {items.map((item) => (
          <NavItem key={item.id} item={item} collapsed={iconOnly} />
        ))}
      </nav>

      {/* ── footer ── */}
      <div className={cn('shrink-0 border-t border-sidebar-border py-2', RAIL_PAD)}>
        {iconOnly && !mobile && (
          <div className="mb-1 flex justify-center">
            <IconButton
              icon={position === 'right' ? 'chevrons-left' : 'chevrons-right'}
              label="Expand sidebar"
              tone="chrome"
              size="sm"
              tooltipSide="right"
              onClick={onToggle}
            />
          </div>
        )}
        <SidebarUser collapsed={iconOnly} user={user} onSignOut={onSignOut} />
      </div>
    </aside>
  );
}

/** Opens the drawer on narrow screens — rendered by the top bar. */
export function MobileNavButton() {
  const openMobileNav = useUIStore((s) => s.openMobileNav);
  return (
    <button
      type="button"
      onClick={openMobileNav}
      aria-label="Open menu"
      className="inline-flex h-9 w-9 items-center justify-center rounded-control text-current/70 transition-colors hover:bg-current/10 hover:text-current lg:hidden"
    >
      <Icon name="menu" size={19} />
    </button>
  );
}
