import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import PageHeader from '@/components/layout/PageHeader';
import IconButton from '@/components/ui/IconButton';
import ActmonAiMark from '@/components/brand/ActmonAiMark';
import ChatSidebar from '@/components/chat/ChatSidebar';
import { Bubble, Welcome } from '@/components/chat/ChatWidget';
import { useChatStore } from '@/store/chatStore';
import cn from '@/lib/cn';

/**
 * Full-page ActMon AI — a ChatGPT/Cursor-style layout: a left rail of the
 * signed-in user's own conversations (see ChatSidebar), and the active
 * conversation on the right. Same `chatStore` the floating widget uses, so
 * opening this page mid-conversation never loses anything; the widget itself
 * never mounts here (see AppShell), so there is exactly one chat surface on
 * screen at a time.
 */
export default function AiAssistantPage() {
  const messages = useChatStore((s) => s.messages);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const streaming = useChatStore((s) => s.streaming);
  const stop = useChatStore((s) => s.stop);
  const send = useChatStore((s) => s.send);
  const resumeLastSession = useChatStore((s) => s.resumeLastSession);

  const [draft, setDraft] = useState('');
  // The sidebar sits inline (always visible) at md+ (≥768px) — below that, a
  // fixed 256px column would crush the conversation into a sliver, so it
  // becomes a toggled overlay drawer instead. Same component, same route,
  // just how it's revealed at a narrow width.
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
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

  return (
    <>
      <PageHeader
        title="ActMon AI"
        description={streaming ? 'Thinking…' : 'Ask about a host, a database, an alert, or what needs attention right now.'}
        leading={<ActmonAiMark size={32} glow={false} />}
        actions={(
          <IconButton
            icon="menu" label="Conversations" size="sm" className="md:hidden"
            onClick={() => setMobileSidebarOpen((v) => !v)}
          />
        )}
      />

      <div className="card relative flex h-[calc(100vh-var(--content-pad-x)*2-11rem)] min-h-[480px] overflow-hidden p-0">
        <ChatSidebar
          className={cn(
            'w-64 shrink-0',
            mobileSidebarOpen
              ? 'absolute inset-y-0 left-0 z-20 flex shadow-xl'
              : 'hidden md:flex',
          )}
        />
        {mobileSidebarOpen && (
          <div
            className="absolute inset-0 z-10 bg-black/30 md:hidden"
            onClick={() => setMobileSidebarOpen(false)}
          />
        )}

        <div className="flex min-h-0 flex-1 flex-col">
          <div
            ref={listRef}
            onScroll={onScroll}
            className="flex-1 space-y-4 overflow-y-auto px-4 py-4 md:px-8"
          >
            <div className="mx-auto w-full max-w-2xl">
              {messages.length === 0 ? (
                <Welcome onPick={submit} />
              ) : (
                <div className="space-y-4">
                  {messages.map((m) => <Bubble key={m.id} message={m} onPick={submit} />)}
                </div>
              )}
            </div>
          </div>

          <div className="shrink-0 border-t border-border p-3">
            <div className="mx-auto flex w-full max-w-2xl items-end gap-2 rounded-control border border-border bg-surface px-3 py-2 focus-within:border-strong">
              <textarea
                ref={taRef}
                rows={1}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="Ask ActMon AI… (Shift+Enter for a new line)"
                className="max-h-32 min-h-[32px] flex-1 resize-none bg-transparent py-1 text-[13px] text-fg placeholder:text-subtle focus:outline-none"
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
            <p className="mx-auto mt-1.5 w-full max-w-2xl px-1 text-[10px] text-subtle">
              ActMon AI can be wrong about specifics — verify before acting on critical numbers.
            </p>
          </div>
        </div>
      </div>
    </>
  );
}
