import { useEffect, useRef, useState } from 'react';
import cn from '@/lib/cn';
import IconButton from '@/components/ui/IconButton';

function readStored(key, fallback) {
  if (!key) return fallback;
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    if (typeof fallback === 'boolean') return raw === 'true';
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
}

/**
 * One reusable drag-resizable, collapsible side panel — used by both the AI
 * Assistant's chat-history rail (`AiAssistantPage.jsx`) and the Help
 * Center's documentation nav (`HelpCenterPage.jsx`), so there is exactly one
 * resize/collapse implementation in the app rather than two parallel ones.
 *
 * The drag handle is a plain 2px vertical line that only reveals a small
 * center grip on hover — deliberately NOT a large arrow icon sitting in the
 * content, since a resize affordance should read as a seam in the layout,
 * not as its own UI element.
 *
 * Width (and collapsed state) persist to `storageKey` in localStorage when
 * given — just a pixel number and a boolean, nothing sensitive — so a
 * reader's preferred width survives a reload.
 */
export default function ResizableSidebar({
  defaultWidth = 300,
  minWidth = 240,
  maxWidth = 500,
  collapsedWidth = 56,
  collapsible = true,
  storageKey,
  collapsedContent,
  children,
  className,
}) {
  const [width, setWidth] = useState(() => readStored(storageKey && `${storageKey}.width`, defaultWidth));
  const [collapsed, setCollapsed] = useState(() => readStored(storageKey && `${storageKey}.collapsed`, false));
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef(null);

  useEffect(() => {
    if (!storageKey) return;
    try { localStorage.setItem(`${storageKey}.width`, String(width)); } catch { /* non-fatal */ }
  }, [width, storageKey]);

  useEffect(() => {
    if (!storageKey) return;
    try { localStorage.setItem(`${storageKey}.collapsed`, String(collapsed)); } catch { /* non-fatal */ }
  }, [collapsed, storageKey]);

  useEffect(() => {
    if (!dragging) return undefined;
    const onMove = (e) => {
      const d = dragRef.current;
      if (!d) return;
      const next = Math.min(maxWidth, Math.max(minWidth, d.startWidth + (e.clientX - d.startX)));
      setWidth(next);
    };
    const onUp = () => {
      setDragging(false);
      dragRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [dragging, minWidth, maxWidth]);

  const startDrag = (e) => {
    if (collapsed) return;
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startWidth: width };
    setDragging(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  const nudge = (delta) => setWidth((w) => Math.min(maxWidth, Math.max(minWidth, w + delta)));

  return (
    <div
      className={cn(
        'relative flex h-full shrink-0 flex-col',
        !dragging && 'transition-[width] duration-[var(--dur-normal)] ease-[var(--ease)]',
        className,
      )}
      style={{ width: collapsed ? collapsedWidth : width }}
    >
      <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
        {collapsed
          ? (typeof collapsedContent === 'function' ? collapsedContent(() => setCollapsed(false)) : collapsedContent)
          : children}
      </div>

      {!collapsed && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize panel"
          aria-valuenow={width}
          aria-valuemin={minWidth}
          aria-valuemax={maxWidth}
          tabIndex={0}
          onPointerDown={startDrag}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') { e.preventDefault(); nudge(-16); }
            if (e.key === 'ArrowRight') { e.preventDefault(); nudge(16); }
          }}
          className="group absolute top-0 -right-1 bottom-0 z-10 flex w-2.5 cursor-col-resize items-center justify-center focus-visible:outline-none"
        >
          <span className="h-9 w-[3px] rounded-full bg-border transition-colors duration-[var(--dur-fast)] group-hover:bg-accent-border group-focus-visible:bg-accent" />
        </div>
      )}

      {collapsible && (
        <IconButton
          icon={collapsed ? 'chevron-right' : 'chevron-left'}
          label={collapsed ? 'Expand panel' : 'Collapse panel'}
          size="sm"
          tooltipSide="right"
          onClick={() => setCollapsed((c) => !c)}
          className="absolute top-3 -right-3 z-20 h-6 w-6 rounded-full border border-border bg-surface shadow-sm hover:border-accent-border"
        />
      )}
    </div>
  );
}
