import cn from '@/lib/cn';

/**
 * A grid of bordered tiles that fills whatever width it's given — one tile
 * per field (or a couple of very short fields), instead of one narrow
 * capped-width column (leaves the rest of a wide page empty) or plain
 * controls stretched edge-to-edge (looks oversized with few options). More
 * tiles per row simply appear as the viewport widens. Shared by every
 * Appearance section (AppearancePanel.jsx, DashboardChartsSection.jsx).
 */
export function TileGrid({ children }) {
  return <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{children}</div>;
}

export function Tile({ className, children }) {
  return (
    <div className={cn('rounded-lg border border-border bg-sunken p-4', className)}>
      {children}
    </div>
  );
}

/** Spans every column — for the one rich, wide control in a section
    (a card grid, a live preview) that shouldn't be squeezed into a tile's
    share of the row. */
export const WIDE = 'sm:col-span-2 xl:col-span-3';
