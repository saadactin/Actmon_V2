import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import cn from '@/lib/cn';
import Icon from '@/components/ui/Icon';
import IconButton from '@/components/ui/IconButton';
import Popover from '@/components/ui/Popover';
import Badge from '@/components/ui/Badge';
import Breadcrumbs from './Breadcrumbs';
import { MobileNavButton } from './Sidebar';
import { useUIStore } from '@/store/uiStore';
import { useThemeStore, resolveThemeId } from '@/theme/themeStore';
import { THEME_MODE } from '@/theme/presets';
import { APP, SHORTCUTS } from '@/config/app.config';

/**
 * Application top bar.
 *
 * Skin comes entirely from `--topbar-*` tokens, so the same markup renders as a
 * white bar, a translucent glass bar, a dark ink bar or an accent bar. Children
 * inherit `currentColor` (via tone="chrome" buttons) so nothing needs to know
 * which of those is active.
 */
export default function TopBar({ actions }) {
  const navigate = useNavigate();

  const sticky = useThemeStore((s) => s.stickyTopbar);
  const showBreadcrumbs = useThemeStore((s) => s.showBreadcrumbs);
  const themePref = useThemeStore((s) => s.theme);
  const toggleTheme = useThemeStore((s) => s.toggleTheme);

  const toggleAppearance = useUIStore((s) => s.toggleAppearance);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const searchOpen = useUIStore((s) => s.searchOpen);
  const toggleSearch = useUIStore((s) => s.toggleSearch);

  const isDark = THEME_MODE[resolveThemeId(themePref)] === 'dark';

  return (
    <header
      className={cn(
        'z-30 flex h-topbar shrink-0 items-center gap-2 border-b border-topbar-border bg-topbar text-topbar-fg',
        sticky && 'sticky top-0',
      )}
      style={{
        // only the `glass` variant sets a non-zero blur
        backdropFilter: 'blur(var(--topbar-blur))',
        WebkitBackdropFilter: 'blur(var(--topbar-blur))',
        paddingInline: 'var(--content-pad-x)',
      }}
    >
      <MobileNavButton />

      {/* Rail toggle also lives here so it's reachable when the rail is collapsed */}
      <IconButton
        icon="menu"
        label={`Toggle sidebar (${fmtKeys(SHORTCUTS.toggleNav.keys)})`}
        tone="chrome"
        size="sm"
        onClick={toggleSidebar}
        className="hidden lg:inline-flex"
      />

      {showBreadcrumbs && <Breadcrumbs className="hidden min-w-0 flex-1 md:flex" />}
      {!showBreadcrumbs && <div className="min-w-0 flex-1" />}

      {/* Page-supplied controls (filters, ranges, primary action) */}
      {actions && <div className="flex items-center gap-2">{actions}</div>}

      <div className="ml-auto flex items-center gap-1">
        {APP.features.search && <SearchTrigger open={searchOpen} onToggle={toggleSearch} />}

        {APP.features.quickThemeToggle && (
          <IconButton
            icon={isDark ? 'sun' : 'moon'}
            label={`Switch to ${isDark ? 'light' : 'dark'} (${fmtKeys(SHORTCUTS.toggleTheme.keys)})`}
            tone="chrome"
            onClick={toggleTheme}
          />
        )}

        {APP.features.notifications && <NotificationsButton />}

        {APP.features.appearancePanel && (
          <IconButton
            icon="palette"
            label={`Appearance (${fmtKeys(SHORTCUTS.appearance.keys)})`}
            tone="chrome"
            onClick={toggleAppearance}
          />
        )}

        {APP.features.helpMenu && <HelpButton />}

        {APP.features.fullscreen && <FullscreenButton />}

        <span className="mx-1 hidden h-5 w-px bg-current/15 sm:block" />

        <IconButton
          icon="settings"
          label="Settings"
          tone="chrome"
          onClick={() => navigate('/settings')}
        />
      </div>
    </header>
  );
}

/* ── search ───────────────────────────────────────────────────────────────── */
function SearchTrigger({ open, onToggle }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className={cn(
        'group hidden h-control items-center gap-2 rounded-control border border-current/15 px-2.5',
        'text-current/60 transition-colors hover:border-current/30 hover:text-current md:flex',
        'min-w-[190px]',
      )}
    >
      <Icon name="search" size={15} />
      <span className="text-[13px]">Search…</span>
      <span className="ml-auto flex items-center gap-0.5">
        <Kbd>Ctrl</Kbd>
        <Kbd>K</Kbd>
      </span>
    </button>
  );
}

export function Kbd({ children }) {
  return (
    <kbd className="rounded-xs border border-current/20 bg-current/5 px-1 py-px font-sans text-[10px] leading-none font-semibold text-current/70">
      {children}
    </kbd>
  );
}

const fmtKeys = (keys) =>
  keys.map((k) => (k.length === 1 ? k.toUpperCase() : k[0].toUpperCase() + k.slice(1))).join('+');

/* ── notifications ────────────────────────────────────────────────────────── */
function NotificationsButton() {
  const open = useUIStore((s) => s.notificationsOpen);
  const toggle = useUIStore((s) => s.toggleNotifications);
  const close = useUIStore((s) => s.closeNotifications);

  // Wired to the notifications API in a later step; the chrome is ready for it.
  const unread = 0;

  return (
    <div className="relative">
      <IconButton
        icon={unread > 0 ? 'bell-ring' : 'bell'}
        label={unread > 0 ? `Notifications (${unread} unread)` : 'Notifications'}
        tone="chrome"
        active={open}
        onClick={toggle}
      >
        {unread > 0 && (
          <span className="absolute top-1 right-1 grid h-[17px] min-w-[17px] place-items-center rounded-full bg-danger px-1 text-[10px] font-bold text-white">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </IconButton>

      <Popover open={open} onClose={close} width={340}>
        <div className="flex items-center justify-between border-b border-border px-3.5 py-2.5">
          <span className="text-sm font-bold text-fg">Notifications</span>
          <Badge tone="neutral" size="xs">{unread} new</Badge>
        </div>
        <div className="grid place-items-center gap-2 px-4 py-10 text-center">
          <Icon name="bell" size={24} className="text-subtle" />
          <p className="text-[13px] font-medium text-muted">You're all caught up</p>
          <p className="text-xs text-subtle">Alerts and agent events will appear here.</p>
        </div>
      </Popover>
    </div>
  );
}

/* ── help ─────────────────────────────────────────────────────────────────── */
function HelpButton() {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative hidden sm:block">
      <IconButton icon="help" label="Help & shortcuts" tone="chrome" active={open} onClick={() => setOpen((v) => !v)} />
      <Popover open={open} onClose={() => setOpen(false)} width={300}>
        <div className="border-b border-border px-3.5 py-2.5 text-sm font-bold text-fg">
          Keyboard shortcuts
        </div>
        <div className="space-y-1.5 p-3.5">
          {Object.values(SHORTCUTS).map((s) => (
            <div key={s.label} className="flex items-center justify-between gap-3">
              <span className="text-[13px] text-muted">{s.label}</span>
              <span className="flex shrink-0 items-center gap-0.5 text-fg">
                {s.keys.map((k) => <Kbd key={k}>{k.length === 1 ? k.toUpperCase() : k}</Kbd>)}
              </span>
            </div>
          ))}
        </div>
        <div className="border-t border-border px-3.5 py-2 text-[11px] font-semibold text-subtle">
          {APP.name} v{APP.version} · {APP.company}
        </div>
      </Popover>
    </div>
  );
}

/* ── fullscreen ───────────────────────────────────────────────────────────── */
function FullscreenButton() {
  const [full, setFull] = useState(false);

  useEffect(() => {
    const onChange = () => setFull(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggle = () => {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.();
  };

  return (
    <IconButton
      icon={full ? 'collapse' : 'expand'}
      label={full ? 'Exit full screen' : 'Full screen'}
      tone="chrome"
      onClick={toggle}
      className="hidden sm:inline-flex"
    />
  );
}
