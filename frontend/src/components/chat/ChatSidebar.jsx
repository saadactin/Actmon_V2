import { useEffect, useState } from 'react';
import cn from '@/lib/cn';
import Icon from '@/components/ui/Icon';
import Button from '@/components/ui/Button';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import { useChatStore } from '@/store/chatStore';

/**
 * ChatGPT-style left rail: New Chat, search, and the signed-in user's own
 * conversation history (rename/delete on hover, active conversation
 * highlighted). Ownership is enforced server-side — this list only ever shows
 * what `GET /chatbot/sessions` actually returns for the caller's own token.
 */
export default function ChatSidebar({ className }) {
  const sessions = useChatStore((s) => s.sessions);
  const sessionsLoading = useChatStore((s) => s.sessionsLoading);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const loadSessions = useChatStore((s) => s.loadSessions);
  const newChat = useChatStore((s) => s.newChat);
  const openSession = useChatStore((s) => s.openSession);
  const renameSession = useChatStore((s) => s.renameSession);
  const deleteSession = useChatStore((s) => s.deleteSession);

  const [query, setQuery] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editValue, setEditValue] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => { loadSessions(); }, [loadSessions]);

  // Debounced server-side search — by title AND message content (see
  // chat_session_service.list_sessions on the backend).
  useEffect(() => {
    const t = setTimeout(() => loadSessions(query.trim() || undefined), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const startRename = (s) => { setEditingId(s.id); setEditValue(s.title || ''); };
  const commitRename = async () => {
    const id = editingId;
    setEditingId(null);
    if (id && editValue.trim()) await renameSession(id, editValue.trim());
  };

  const confirmDelete = async () => {
    setDeleting(true);
    try {
      await deleteSession(confirmDeleteId);
      setConfirmDeleteId(null);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className={cn('flex h-full flex-col border-r border-border bg-sunken', className)}>
      <div className="p-2.5">
        <Button variant="secondary" icon="plus" className="w-full justify-center" onClick={newChat}>
          New Chat
        </Button>
      </div>

      <div className="px-2.5 pb-2.5">
        <div className="relative">
          <Icon name="search" size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats"
            className="h-9 w-full rounded-control border border-border bg-surface pl-8 pr-2.5 text-[14px] text-fg placeholder:text-subtle outline-none focus:border-accent"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {sessionsLoading && sessions.length === 0 ? (
          <p className="px-2.5 py-3 text-center text-[12px] text-subtle">Loading…</p>
        ) : sessions.length === 0 ? (
          <p className="px-2.5 py-3 text-center text-[12px] text-subtle">
            {query ? 'No matching chats.' : 'No conversations yet — say hello.'}
          </p>
        ) : (
          <ul className="space-y-0.5">
            {sessions.map((s) => (
              <li key={s.id}>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => editingId !== s.id && openSession(s.id)}
                  className={cn(
                    'group flex items-center gap-1 rounded-control px-2.5 py-2 cursor-pointer transition-colors',
                    s.id === activeSessionId ? 'bg-accent-soft text-accent-text' : 'text-fg hover:bg-surface',
                  )}
                >
                  {editingId === s.id ? (
                    <input
                      autoFocus
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitRename();
                        if (e.key === 'Escape') setEditingId(null);
                      }}
                      onBlur={commitRename}
                      className="h-6 flex-1 rounded border border-accent bg-surface px-1.5 text-[14px] text-fg outline-none"
                    />
                  ) : (
                    <div className="min-w-0 flex-1">
                      <p className="truncate-safe text-[15px] font-semibold">{s.title || 'New chat'}</p>
                      {s.last_message && (
                        <p className="truncate-safe text-[13px] text-subtle">{s.last_message}</p>
                      )}
                    </div>
                  )}

                  {editingId !== s.id && (
                    <div className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
                      <button
                        type="button"
                        title="Rename"
                        aria-label="Rename conversation"
                        onClick={(e) => { e.stopPropagation(); startRename(s); }}
                        className="grid h-6 w-6 place-items-center rounded text-subtle hover:bg-sunken hover:text-fg"
                      >
                        <Icon name="file-edit" size={12} />
                      </button>
                      <button
                        type="button"
                        title="Delete"
                        aria-label="Delete conversation"
                        onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(s.id); }}
                        className="grid h-6 w-6 place-items-center rounded text-subtle hover:bg-danger-soft hover:text-danger-fg"
                      >
                        <Icon name="trash" size={12} />
                      </button>
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={!!confirmDeleteId}
        title="Delete conversation?"
        message="This permanently removes the conversation and its messages. This can't be undone."
        confirmLabel="Delete"
        tone="danger"
        loading={deleting}
        onCancel={() => setConfirmDeleteId(null)}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
