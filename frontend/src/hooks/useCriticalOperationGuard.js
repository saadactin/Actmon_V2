import { useEffect, useRef } from 'react';

/**
 * Protects a page against losing track of a genuinely long-running,
 * hard-to-interrupt background operation (a multi-minute WAL purge, a
 * backup job, ...) while `active` is true:
 *   - a hard refresh / tab close shows the browser's own "leave site?" prompt
 *   - the browser back/forward button asks for confirmation before leaving
 *   - clicking any real in-app link (top nav, breadcrumbs, sidebar) asks too
 *
 * Deliberately scoped PER PAGE (call it from the one page that has
 * something worth protecting) rather than wired into the router globally —
 * most navigation in the app has nothing running that a leave would affect,
 * so a blanket guard would just be an extra confirm dialog for no reason.
 *
 * Returns `confirmLeave()` for a page's own custom back/close controls that
 * aren't plain `<a href>` links (and so the automatic click-listener below
 * can't see them) — call it before actually navigating away in an onClick.
 */
export default function useCriticalOperationGuard(
  active,
  message = 'An operation is still in progress. Leaving this page will not stop it, but you will lose the live view. Continue?',
) {
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    const handleBeforeUnload = (e) => {
      if (!activeRef.current) return;
      e.preventDefault();
      e.returnValue = message; // required by Chrome; most browsers show their own generic text regardless of this value
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [message]);

  useEffect(() => {
    // Capture phase so this runs before react-router's own <Link> handler,
    // letting a "cancel" here stop the navigation outright.
    const handleClick = (e) => {
      if (!activeRef.current) return;
      const link = e.target.closest?.('a[href]');
      if (!link) return;
      const href = link.getAttribute('href') || '';
      if (href.startsWith('#') || link.closest('[data-no-nav-guard]')) return;
      if (!window.confirm(message)) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
      }
    };
    document.addEventListener('click', handleClick, true);
    return () => document.removeEventListener('click', handleClick, true);
  }, [message]);

  useEffect(() => {
    if (!active) return undefined;
    // Seed one extra history entry so the FIRST back-press lands on our own
    // popstate handler instead of immediately leaving — the closest
    // approximation the History API allows to "confirm before going back".
    window.history.pushState(null, '', window.location.href);
    const handlePopState = () => {
      if (!activeRef.current) return;
      if (!window.confirm(message)) {
        window.history.pushState(null, '', window.location.href);
      }
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [active, message]);

  return { confirmLeave: () => !activeRef.current || window.confirm(message) };
}
