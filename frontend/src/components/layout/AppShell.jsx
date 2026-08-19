import { Suspense } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import cn from '@/lib/cn';
import TopNav from './TopNav';
import ErrorBoundary from '@/components/ErrorBoundary';
import AppearanceDrawer from '@/components/appearance/AppearanceDrawer';
import ChatWidget from '@/components/chat/ChatWidget';
import Icon from '@/components/ui/Icon';
import useShortcuts from '@/hooks/useShortcuts';
import { usePermissions } from '@/hooks/usePermissions';
import { useUIStore } from '@/store/uiStore';
import { PageLoading } from '@/components/ui/Loading';
import { APP, SHORTCUTS } from '@/config/app.config';
import AccessDeniedPage from '@/pages/AccessDeniedPage';

/**
 * The application frame: module bar + scrolling content.
 *
 * The bar sits OUTSIDE <main>, which is the only scrolling element, so it stays
 * put without needing `position: fixed` and a matching offset — and `top: 0` is
 * still the right anchor for a pinned page header inside the scrollport.
 */
/** Routes whose pages render their own edge-to-edge chrome. */
const BLEED_PREFIXES = [
  '/agents/setup', '/agents/deploy',
  '/databases/add-data', '/databases/setup',
];

export default function AppShell({ user, onSignOut }) {
  const { pathname } = useLocation();
  const bleed = BLEED_PREFIXES.some((p) => pathname.startsWith(p));
  const navHidden = useUIStore((s) => s.navHidden);
  const toggleNav = useUIStore((s) => s.toggleNav);
  // The actual RBAC enforcement point: the nav bar only HIDES links a role
  // can't see, which is discoverability, not access control — a direct visit
  // (typed URL, bookmark, browser history) skipped it entirely until this
  // check. isDeniedHere() was already built for exactly this in
  // usePermissions.js but had no caller anywhere in the app.
  const { isDeniedHere } = usePermissions();
  const denied = isDeniedHere();
  useShortcuts();

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-bg text-fg">
      {navHidden ? <ShowNavTab onShow={toggleNav} /> : <TopNav user={user} onSignOut={onSignOut} />}

      {/* Content column — the only part that scrolls */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <main className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
          {/* Full-bleed pages (the Add Data catalogue and the setup / deploy
              wizards) draw their own chrome edge-to-edge using Tailwind's fixed
              `-mx-6 md:-mx-8`. For those routes the container switches to the
              matching fixed padding and drops the max-width, so their negative
              margins cancel exactly instead of overflowing a density-driven
              padding that happens to differ. */}
          {/* `content-shell` carries the top padding in CSS rather than inline,
              because a pinned page header has to be able to cancel it — that
              padding sits ABOVE the header inside the scrollport, and would
              otherwise show as a shrinking gap under the top bar while scrolling.
              See PAGE HEADER PINNING in styles/tokens.css. */}
          <div
            className={cn(
              'mx-auto w-full',
              bleed ? 'px-6 pb-6 md:px-8 md:pb-8' : 'content-shell pb-gutter-lg',
            )}
            style={bleed ? undefined : {
              maxWidth: 'var(--content-max)',
              paddingInline: 'var(--content-pad-x)',
            }}
          >
            <ErrorBoundary resetKey={pathname}>
              {denied ? (
                <AccessDeniedPage />
              ) : (
                <Suspense fallback={<PageLoading title="Loading…" />}>
                  <Outlet />
                </Suspense>
              )}
            </ErrorBoundary>
          </div>
        </main>
      </div>

      {/* Global overlays.
          ChatWidget is mounted here — outside <main> — rather than on individual
          pages, so it is present on every signed-in screen (the "why isn't the
          bot on every screen" gap) and a page navigation never remounts it,
          which would otherwise drop the conversation and any in-flight stream. */}
      <AppearanceDrawer />
      {/* Suppressed on the full-page chat itself — that page already renders the
          conversation, so the floating launcher would just be a redundant second
          entry point to the same store overlapping its own content. */}
      {APP.features.chatbot && pathname !== '/ai-assistant' && <ChatWidget />}
    </div>
  );
}

/**
 * The way back.
 *
 * Hiding the bar hides every nav link and the account menu with it, so a
 * keyboard shortcut cannot be the only route back — someone who hid it by
 * accident, or on a touch screen, would be stranded on whatever page they were
 * on. This tab is deliberately small and flush to the top edge: present enough
 * to find, quiet enough not to undo the space that was just reclaimed.
 */
function ShowNavTab({ onShow }) {
  const keys = SHORTCUTS.toggleNav.keys
    .map((k) => (k.length === 1 ? k.toUpperCase() : k[0].toUpperCase() + k.slice(1)))
    .join('+');

  return (
    <button
      type="button"
      onClick={onShow}
      title={`Show menu bar (${keys})`}
      aria-label={`Show menu bar (${keys})`}
      className="group fixed top-0 left-1/2 z-40 flex h-5 -translate-x-1/2 items-center gap-1.5 rounded-b-md bg-inverse px-3 text-[10px] font-semibold text-on-inverse opacity-70 transition-opacity hover:opacity-100"
    >
      <Icon name="chevron-down" size={12} />
      <span className="hidden group-hover:inline">Show menu · {keys}</span>
    </button>
  );
}
