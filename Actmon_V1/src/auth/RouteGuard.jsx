import React from 'react';
import { usePermissions } from '../hooks/usePermissions';
import AccessDenied from '../pages/AccessDenied';

/**
 * Blocks routes that map to a page the user lacks View permission for.
 * Only enforced once the user actually has permissions loaded (provisioned),
 * so an un-provisioned session can still reach setup screens.
 */
export default function RouteGuard({ children }) {
  const { isDeniedHere } = usePermissions();
  if (isDeniedHere()) return <AccessDenied />;
  return children;
}
