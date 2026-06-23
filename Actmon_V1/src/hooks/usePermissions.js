import { useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';

/**
 * RBAC engine — fully DB-driven. Nothing hardcoded.
 *   - permission bits come from the permission catalog
 *   - a user's grants come from their per-page permissions
 *   - the set of GOVERNED routes comes from page_master (governedUrls)
 *
 * A route is "governed" if it exists in page_master. A logged-in user is
 * DENIED any governed route they weren't granted View on. Routes not in
 * page_master are public (login, access-denied, landing helpers).
 */
const toRe = (url) => new RegExp('^' + url.split('?')[0].replace(/:[^/]+/g, '[^/]+').replace(/\//g, '\\/') + '$');

export function usePermissions() {
  const permissions = useAuthStore((s) => s.permissions);
  const catalog = useAuthStore((s) => s.permissionCatalog);
  const governedUrls = useAuthStore((s) => s.governedUrls);
  const menu = useAuthStore((s) => s.menu);
  const { pathname } = useLocation();

  const bits = useMemo(() => {
    const m = {};
    (catalog || []).forEach((p) => { m[String(p.permission_name).toLowerCase()] = Number(p.permission_value); });
    return m;
  }, [catalog]);

  // user's granted pages → permission int (exact + param-route matchers)
  const grants = useMemo(() => {
    const exact = {};
    const matchers = [];
    (permissions || []).forEach((p) => {
      if (!p.page_url) return;
      exact[p.page_url] = Number(p.permission);
      matchers.push({ re: toRe(p.page_url), perm: Number(p.permission), len: p.page_url.length });
    });
    matchers.sort((a, b) => b.len - a.len);
    return { exact, matchers };
  }, [permissions]);

  // all governed page urls → compiled matchers
  const governed = useMemo(
    () => (governedUrls || []).map((u) => ({ re: toRe(u), len: u.length })).sort((a, b) => b.len - a.len),
    [governedUrls],
  );

  const bitFor = (action) => bits[String(action || 'view').toLowerCase()] ?? null;

  const permissionFor = (pageUrl) => {
    if (!pageUrl) return null;
    const base = pageUrl.split('?')[0];
    if (base in grants.exact) return grants.exact[base];
    const hit = grants.matchers.find((m) => m.re.test(base));
    return hit ? hit.perm : null;
  };

  const isGoverned = (path) => {
    const base = (path || '').split('?')[0];
    return governed.some((g) => g.re.test(base));
  };

  // "Hub" / launcher routes: a module landing (or a parent page) that the user can
  // reach because they have access to something INSIDE it — even if the hub page
  // itself wasn't individually granted. Derived entirely from the DB-driven menu
  // (the menu only contains modules/pages the user can view), so nothing is hardcoded.
  const hubs = useMemo(() => {
    const urls = [];
    const walk = (nodes) => (nodes || []).forEach((n) => {
      if (n.children && n.children.length) { if (n.url) urls.push(n.url); walk(n.children); }
    });
    (menu || []).forEach((m) => {
      if (m.route && m.children && m.children.length) urls.push(m.route);
      walk(m.children);
    });
    return urls.map((u) => toRe(u));
  }, [menu]);
  const isHub = (path) => {
    const base = (path || '').split('?')[0];
    return hubs.some((re) => re.test(base));
  };

  const can = (pageUrl, action = 'view') => {
    const perm = permissionFor(pageUrl);
    if (perm == null) return false;
    const bit = bitFor(action);
    return bit != null && (perm & bit) === bit;
  };

  /** Buttons: allowed on public pages; on governed pages require the action bit. */
  const canHere = (action = 'view') => {
    if (!isGoverned(pathname)) return true;
    return can(pathname, action);
  };

  /** Route guard: deny governed routes the user lacks View on — unless it's a launcher hub. */
  const isDeniedHere = () => isGoverned(pathname) && !can(pathname, 'view') && !isHub(pathname);

  return { can, permissionFor, bitFor, isGoverned, canHere, isDeniedHere, isHub };
}
