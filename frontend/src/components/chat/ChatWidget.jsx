import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'react-router-dom';
import cn from '@/lib/cn';
import Icon from '@/components/ui/Icon';
import IconButton from '@/components/ui/IconButton';
import ActmonAiMark from '@/components/brand/ActmonAiMark';
import FormatMessage from './formatMessage';
import { useChatStore, LAUNCHER_SIZE } from '@/store/chatStore';
import { APP } from '@/config/app.config';

const SUGGESTIONS = [
  'Is anything unhealthy right now?',
  'Summarise today’s alerts',
  'Which host has the highest CPU?',
];

/** Pointer movement past this, in either axis combined, counts as a drag rather
 *  than a click — small enough that a real drag never mistakes itself for a
 *  click, large enough that a slightly unsteady tap still opens the panel. */
const DRAG_THRESHOLD = 6;
const PANEL_GAP = 12; // clearance between the launcher and the panel
const PANEL_W = 380;
const PANEL_MAX_H = 600;
const EDGE_MARGIN = 8; // panel never touches the viewport edge exactly

/**
 * Drag-to-reposition for the launcher.
 *
 * Pointer Events rather than mouse+touch separately — one code path for mouse,
 * pen and touch, and `setPointerCapture` keeps receiving move/up events even
 * once the pointer leaves the button, which plain mouse events don't do.
 *
 * A drag and a click are the same gesture until they aren't: both start with a
 * pointerdown on the button. `wasDragged` is how the caller tells them apart —
 * read it in the click handler, which the browser always fires AFTER pointerup
 * for the same interaction, so the flag is set before anything checks it.
 */
function useDraggableLauncher() {
  const position = useChatStore((s) => s.position);
  const setPosition = useChatStore((s) => s.setPosition);
  const reclampPosition = useChatStore((s) => s.reclampPosition);
  const [dragPos, setDragPos] = useState(null);
  const drag = useRef(null);
  const wasDragged = useRef(false);

  useEffect(() => {
    reclampPosition(); // the window may have been resized since the last visit
    window.addEventListener('resize', reclampPosition);
    return () => window.removeEventListener('resize', reclampPosition);
  }, [reclampPosition]);

  const onPointerDown = (e) => {
    if (e.button !== undefined && e.button !== 0) return; // primary button/touch only
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { startX: e.clientX, startY: e.clientY, originX: position.x, originY: position.y };
  };

  const onPointerMove = (e) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!wasDragged.current && Math.hypot(dx, dy) > DRAG_THRESHOLD) wasDragged.current = true;
    if (wasDragged.current) setDragPos({ x: d.originX + dx, y: d.originY + dy });
  };

  const onPointerUp = () => {
    if (drag.current && wasDragged.current) setPosition(dragPos ?? position);
    drag.current = null;
    setDragPos(null);
    // Left set for the click handler that fires right after this to read; it
    // clears its own flag once consumed, so this isn't reset here.
  };

  const onClick = (thenToggle) => {
    if (wasDragged.current) { wasDragged.current = false; return; }
    thenToggle();
  };

  return { position: dragPos || position, onPointerDown, onPointerMove, onPointerUp, onClick, dragging: !!dragPos };
}

/**
 * Where the panel opens relative to the (possibly dragged) launcher.
 *
 * Flips to whichever side of the launcher actually has room — a launcher
 * dragged to the top-left needs the panel to open below and to the right of
 * it, not in its default bottom-right orientation, or most of it would render
 * off-screen.
 */
function usePanelPlacement(launcherPos) {
  return useMemo(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.min(PANEL_W, vw - EDGE_MARGIN * 2);
    const height = Math.min(PANEL_MAX_H, vh - EDGE_MARGIN * 2);

    const spaceBelow = vh - (launcherPos.y + LAUNCHER_SIZE) - PANEL_GAP;
    const spaceAbove = launcherPos.y - PANEL_GAP;
    const openBelow = spaceBelow >= spaceAbove;
    const top = openBelow
      ? Math.min(launcherPos.y + LAUNCHER_SIZE + PANEL_GAP, vh - height - EDGE_MARGIN)
      : Math.max(launcherPos.y - PANEL_GAP - height, EDGE_MARGIN);

    // Prefer right-aligning the panel with the launcher; fall back to
    // left-aligning it when that would push the panel off the left edge.
    let left = launcherPos.x + LAUNCHER_SIZE - width;
    if (left < EDGE_MARGIN) left = launcherPos.x;
    left = Math.min(Math.max(left, EDGE_MARGIN), vw - width - EDGE_MARGIN);

    return { top, left, width, height };
  }, [launcherPos.x, launcherPos.y]);
}

/**
 * ActMon AI — the floating assistant, present on every signed-in screen.
 *
 * Mounted once in AppShell (outside <main>, so page unmounts never reset it) and
 * portalled to <body> so a page's own `overflow: hidden` can never clip the panel.
 * Login and the first-run wizard render outside AppShell entirely, so the widget
 * is already absent there without a separate check here.
 *
 * The conversation lives in chatStore, not local state, so it survives the panel
 * closing — reopening it mid-page-nav resumes where you left off.
 */
export default function ChatWidget() {
  const { pathname } = useLocation();
  const open = useChatStore((s) => s.open);
  const messages = useChatStore((s) => s.messages);
  const streaming = useChatStore((s) => s.streaming);
  const toggle = useChatStore((s) => s.toggle);
  const close = useChatStore((s) => s.close);
  const clear = useChatStore((s) => s.clear);
  const stop = useChatStore((s) => s.stop);
  const send = useChatStore((s) => s.send);

  const [draft, setDraft] = useState('');
  const listRef = useRef(null);
  const taRef = useRef(null);

  const launcher = useDraggableLauncher();
  const panelStyle = usePanelPlacement(launcher.position);

  // Follows new content unless the reader has scrolled up to look at history —
  // a streaming reply shouldn't yank them back down mid-read.
  const pinnedToBottom = useRef(true);
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && pinnedToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages, open]);

  useEffect(() => {
    if (open) taRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === 'Escape' && close();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, close]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  const submit = (text) => {
    const value = (text ?? draft).trim();
    if (!value || streaming) return;
    pinnedToBottom.current = true;
    send(value, pathname);
    setDraft('');
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return createPortal(
    <>
      {/* ── launcher ──
          Closed state has NO background shape at all — just the mark, at its
          own 80×80, with its own glow (a CSS drop-shadow baked into
          ActmonAiMark) doing the lift off the page. A wrapping circle behind
          it — `bg-inverse` resolves to a near-black navy in the light theme —
          is what put a solid dark disc around the owl; the mark is the button.
          The open state swaps to a close icon, which DOES need a backdrop to
          stay legible over arbitrary page content, so only that state gets
          one — a normal card surface, never a hardcoded dark chip.

          Positioned by inline style, not a Tailwind corner utility — the whole
          point is that it doesn't stay pinned to one corner, it goes wherever
          it's been dragged. `touch-none` stops the browser's own scroll/zoom
          gestures from fighting the drag on a touchscreen. */}
      <button
        type="button"
        onClick={() => launcher.onClick(toggle)}
        onPointerDown={launcher.onPointerDown}
        onPointerMove={launcher.onPointerMove}
        onPointerUp={launcher.onPointerUp}
        aria-label={open ? 'Close ActMon AI' : 'Open ActMon AI (drag to move)'}
        aria-expanded={open}
        style={{ left: launcher.position.x, top: launcher.position.y }}
        className={cn(
          'fixed z-[70] grid h-20 w-20 touch-none place-items-center rounded-full select-none',
          'transition-transform hover:scale-105 active:scale-95',
          open && 'border border-border bg-surface shadow-lg',
        )}
      >
        {open
          ? <Icon name="close" size={24} className="text-fg" />
          : <ActmonAiMark size={80} />}
      </button>

      {/* ── panel ──
          Placed relative to the launcher's current position (see
          usePanelPlacement) rather than pinned to a corner, so it still opens
          fully on-screen no matter where the launcher has been dragged to. */}
      {open && (
        <div
          role="dialog"
          aria-modal="false"
          aria-label="ActMon AI"
          style={{ top: panelStyle.top, left: panelStyle.left, width: panelStyle.width, height: panelStyle.height }}
          className="card fixed z-[70] flex flex-col overflow-hidden anim-pop-in"
        >
          <header className="flex shrink-0 items-center gap-2.5 border-b border-border px-3.5 py-3">
            <ActmonAiMark size={32} glow={false} />
            <div className="min-w-0 flex-1">
              <p className="truncate-safe text-[13px] font-bold text-fg">ActMon AI</p>
              <p className="truncate-safe text-[11px] text-subtle">
                {streaming ? 'Thinking…' : `Ask about ${APP.name}`}
              </p>
            </div>
            {messages.length > 0 && (
              <IconButton icon="refresh" label="Clear conversation" size="sm" onClick={clear} />
            )}
            <IconButton icon="close" label="Close" size="sm" onClick={close} />
          </header>

          <div
            ref={listRef}
            onScroll={onScroll}
            className="flex-1 space-y-3 overflow-y-auto px-3.5 py-3"
          >
            {messages.length === 0 ? (
              <Welcome onPick={submit} />
            ) : (
              messages.map((m) => <Bubble key={m.id} message={m} />)
            )}
          </div>

          <div className="shrink-0 border-t border-border p-2.5">
            <div className="flex items-end gap-2 rounded-control border border-border bg-surface px-2 py-1.5 focus-within:border-strong">
              <textarea
                ref={taRef}
                rows={1}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="Ask ActMon AI…"
                className="max-h-24 min-h-[28px] flex-1 resize-none bg-transparent py-1 text-[13px] text-fg placeholder:text-subtle focus:outline-none"
              />
              {streaming ? (
                <IconButton icon="stop" label="Stop" tone="danger" size="sm" onClick={stop} />
              ) : (
                <IconButton
                  icon="send"
                  label="Send"
                  tone="accent"
                  size="sm"
                  disabled={!draft.trim()}
                  onClick={() => submit()}
                />
              )}
            </div>
            <p className="mt-1.5 px-1 text-[10px] text-subtle">
              ActMon AI can be wrong about specifics — verify before acting on critical numbers.
            </p>
          </div>
        </div>
      )}
    </>,
    document.body,
  );
}

function Welcome({ onPick }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-2 text-center">
      <ActmonAiMark size={56} />
      <div>
        <p className="text-[13px] font-bold text-fg">Hi, I&rsquo;m ActMon AI</p>
        <p className="mt-1 text-[12px] text-muted">
          Ask about a host, an alert, or what needs attention right now.
        </p>
      </div>
      <div className="flex w-full flex-col gap-1.5">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onPick(s)}
            className="rounded-control border border-border px-3 py-2 text-left text-[12px] text-muted transition-colors hover:border-strong hover:bg-sunken hover:text-fg"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

function Bubble({ message }) {
  const mine = message.role === 'user';
  return (
    <div className={cn('flex items-end gap-2', mine && 'flex-row-reverse')}>
      {!mine && <ActmonAiMark size={24} glow={false} animated={false} className="mb-0.5" />}
      <div
        className={cn(
          'max-w-[85%] rounded-2xl px-3 py-2',
          mine ? 'rounded-br-md bg-accent text-accent-fg'
            : message.error ? 'rounded-bl-md bg-danger-soft text-danger-fg'
              : 'rounded-bl-md bg-sunken',
        )}
      >
        {mine
          ? <p className="text-[13px] leading-relaxed whitespace-pre-wrap">{message.content}</p>
          : message.content
            ? <FormatMessage text={message.content} />
            : <TypingDots />}
      </div>
    </div>
  );
}

function TypingDots() {
  return (
    <span className="flex items-center gap-1 py-0.5">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="chat-typing-dot h-1.5 w-1.5 rounded-full bg-subtle"
          style={{ animationDelay: `${i * 0.15}s` }}
        />
      ))}
    </span>
  );
}
