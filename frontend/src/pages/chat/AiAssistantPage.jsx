import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import PageHeader from '@/components/layout/PageHeader';
import ResizableSidebar from '@/components/layout/ResizableSidebar';
import IconButton from '@/components/ui/IconButton';
import Icon from '@/components/ui/Icon';
import Tooltip from '@/components/ui/Tooltip';
import ActmonAiMark from '@/components/brand/ActmonAiMark';
import ChatSidebar from '@/components/chat/ChatSidebar';
import { Bubble, Welcome } from '@/components/chat/ChatWidget';
import { useChatStore } from '@/store/chatStore';
import cn from '@/lib/cn';

/**
 * Full-page ActMon AI — a ChatGPT/Cursor-style workspace: a resizable,
 * collapsible left rail of the signed-in user's own conversations (see
 * ChatSidebar/ResizableSidebar), and the active conversation filling the
 * rest of the page. Same `chatStore` the floating widget uses, so opening
 * this page mid-conversation never loses anything; the widget itself never
 * mounts here (see AppShell), so there is exactly one chat surface on
 * screen at a time.
 *
 * The workspace's height is MEASURED, not guessed: `<main>` (AppShell) is
 * the app's one scrolling element and gives this page's own root no
 * intrinsic height of its own, so a fixed calc() here would drift the
 * moment the header's description wraps to a second line or the density
 * setting changes control heights. Measuring the header via ResizeObserver
 * and sizing the workspace to exactly what's left is what makes the
 * conversation/input panel fill the page with no leftover blank strip
 * below it, and without <main> itself ever needing to scroll.
 */
export default function AiAssistantPage() {
  const messages = useChatStore((s) => s.messages);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const streaming = useChatStore((s) => s.streaming);
  const stop = useChatStore((s) => s.stop);
  const send = useChatStore((s) => s.send);
  const retry = useChatStore((s) => s.retry);
  const newChat = useChatStore((s) => s.newChat);
  const resumeLastSession = useChatStore((s) => s.resumeLastSession);

  const [draft, setDraft] = useState('');
  // The sidebar sits inline (resizable) at md+ (≥768px) — below that, a
  // fixed-width column would crush the conversation into a sliver, so it
  // becomes a toggled overlay drawer instead. Same component, same route,
  // just how it's revealed at a narrow width.
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [fullScreen, setFullScreen] = useState(false);
  const listRef = useRef(null);
  const taRef = useRef(null);
  const pinnedToBottom = useRef(true);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && pinnedToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  useEffect(() => { taRef.current?.focus(); }, [activeSessionId]);
  // Reopen wherever the user left off — same behaviour the old localStorage
  // store had, just backed by the server now.
  useEffect(() => { resumeLastSession(); }, [resumeLastSession]);

  useEffect(() => {
    if (!fullScreen) return undefined;
    const onKey = (e) => e.key === 'Escape' && setFullScreen(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [fullScreen]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  const submit = (text) => {
    const value = (text ?? draft).trim();
    if (!value || streaming) return;
    pinnedToBottom.current = true;
    send(value, '/ai-assistant');
    setDraft('');
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  // Header height is measured (description text can wrap, density settings
  // change control heights), so the workspace below is sized to exactly the
  // space left — only the sidebar and conversation panels ever scroll,
  // <main> (AppShell's own scroll container) never does.
  const headerRef = useRef(null);
  const [headerH, setHeaderH] = useState(0);
  useLayoutEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setHeaderH(entry.contentRect.height));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const workspace = (
    <div
      className="card mb-[calc(-1*var(--gap-lg))] flex min-h-0 overflow-hidden"
      style={{ height: fullScreen ? '100vh' : `calc(100vh - var(--topnav-h) - ${headerH}px)` }}
    >
      <ResizableSidebar
        defaultWidth={300}
        minWidth={240}
        maxWidth={500}
        collapsedWidth={56}
        storageKey="actmon.ai.sidebar"
        className={cn(mobileSidebarOpen ? 'absolute inset-y-0 left-0 z-20 shadow-xl' : 'hidden md:flex')}
        collapsedContent={(expand) => <CollapsedRail onNewChat={newChat} onSearch={expand} />}
      >
        <ChatSidebar className="flex h-full" />
      </ResizableSidebar>

      {mobileSidebarOpen && (
        <div
          className="absolute inset-0 z-10 bg-black/30 md:hidden"
          onClick={() => setMobileSidebarOpen(false)}
        />
      )}

      {/* Conversation column fills all remaining width; the message list and
          input are each capped and centered independently so a wide monitor
          gets a readable line length, not a giant blank gutter either side
          of a narrow fixed box. */}
      <div className="flex min-h-0 flex-1 flex-col">
        <div
          ref={listRef}
          onScroll={onScroll}
          className="flex-1 space-y-4 overflow-y-auto px-4 py-5 md:px-10"
        >
          <div className="mx-auto w-full max-w-[900px]">
            {messages.length === 0 ? (
              <Welcome onPick={submit} />
            ) : (
              <div className="space-y-4">
                {messages.map((m) => (
                  <Bubble key={m.id} message={m} onPick={submit} onRetry={(id) => retry(id, '/ai-assistant')} />
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="shrink-0 border-t border-border p-4">
          <div className="mx-auto flex w-full max-w-[900px] items-end gap-2 rounded-control border border-border bg-surface px-3.5 py-2.5 focus-within:border-strong">
            <textarea
              ref={taRef}
              rows={1}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Ask ActMon AI… (Shift+Enter for a new line)"
              className="max-h-32 min-h-[36px] flex-1 resize-none bg-transparent py-1 text-[16px] text-fg placeholder:text-subtle focus:outline-none"
            />
            {streaming ? (
              <IconButton icon="stop" label="Stop" tone="danger" onClick={stop} />
            ) : (
              <IconButton
                icon="send"
                label="Send"
                tone="accent"
                disabled={!draft.trim()}
                onClick={() => submit()}
              />
            )}
          </div>
          <p className="mx-auto mt-1.5 w-full max-w-[900px] px-1 text-[13px] text-subtle">
            ActMon AI can be wrong about specifics — verify before acting on critical numbers.
          </p>
        </div>
      </div>
    </div>
  );

  if (fullScreen) {
    return (
      <div className="fixed inset-0 z-[95] flex flex-col bg-bg p-4">
        <div className="mb-3 flex shrink-0 items-center gap-2.5">
          <ActmonAiMark size={28} glow={false} />
          <span className="text-[16px] font-bold text-fg">ActMon AI</span>
          <span className="text-[14px] text-subtle">{streaming ? 'Thinking…' : 'Full-screen workspace'}</span>
          <Tooltip label="Exit full screen" side="bottom">
            <button
              type="button"
              onClick={() => setFullScreen(false)}
              aria-label="Exit full screen"
              className="ml-auto grid h-9 w-9 place-items-center rounded-control text-muted transition-colors hover:bg-sunken hover:text-fg"
            >
              <Icon name="collapse" size={17} />
            </button>
          </Tooltip>
        </div>
        <div className="min-h-0 flex-1">{workspace}</div>
      </div>
    );
  }

  return (
    <>
      <div ref={headerRef}>
        <PageHeader
          title="ActMon AI"
          description={streaming ? 'Thinking…' : 'Ask about a host, a database, an alert, or what needs attention right now.'}
          leading={<ActmonAiMark size={32} glow={false} />}
          actions={(
            <div className="flex items-center gap-1.5">
              <IconButton
                icon="menu" label="Conversations" size="sm" className="md:hidden"
                onClick={() => setMobileSidebarOpen((v) => !v)}
              />
              <IconButton icon="plus" label="New chat" size="sm" onClick={newChat} />
              <IconButton icon="expand" label="Full-screen workspace" size="sm" onClick={() => setFullScreen(true)} />
            </div>
          )}
        />
      </div>
      {workspace}
    </>
  );
}

function CollapsedRail({ onNewChat, onSearch }) {
  return (
    <div className="flex h-full flex-col items-center gap-1.5 border-r border-border bg-sunken py-2.5">
      <IconButton icon="plus" label="New chat" size="sm" onClick={onNewChat} />
      <IconButton icon="search" label="Search conversations" size="sm" onClick={onSearch} />
    </div>
  );
}
