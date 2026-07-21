import React from 'react';
import { useLocation } from 'react-router-dom';
import { usePermissions } from '../../hooks/usePermissions';

/**
 * Render children only if the user holds `action` on `page` (defaults to the
 * current route). Bit values resolve from the DB permission catalog.
 *   <Can action="add">…</Can>            gate by current page
 *   <Can action="edit" page="/roles">…   gate by a specific page
 */
export default function Can({ action = 'view', page, children, fallback = null }) {
  const { can } = usePermissions();
  const { pathname } = useLocation();
  return can(page || pathname, action) ? <>{children}</> : fallback;
}
