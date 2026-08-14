import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import PageHeader from '@/components/layout/PageHeader';
import Icon from '@/components/ui/Icon';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import Select from '@/components/ui/Select';
import Dialog from '@/components/ui/Dialog';
import Table, { EmptyState, nextSort, sortRows } from '@/components/ui/Table';
import Pagination, { pageCountOf, paginate } from '@/components/ui/Pagination';
import FormatMessage from '@/components/chat/formatMessage';
import ActmonAiMark from '@/components/brand/ActmonAiMark';
import { listChatAudit, getChatAuditMessages } from '@/api/chatSessions';
import { organizationsApi, usersApi } from '@/api/admin';
import { fullTime, ago } from '@/lib/format';
import { useThemeStore } from '@/theme/themeStore';

/**
 * Super Admin → AI Chat Sessions audit — cross-user visibility into ActMon AI
 * conversations, gated by the SAME permission-bit RBAC every other admin page
 * uses (`/ai-chat-sessions`, enforced server-side — see
 * `ai_chat_audit_routes.py`). A non-super admin holding this permission only
 * ever sees their own org's conversations no matter what filter is picked;
 * only the true super admin can cross org boundaries — the backend decides
 * that, this page just renders whatever it's handed.
 */
export default function AiChatSessionsPage() {
  const [search, setSearch] = useState('');
  const [userId, setUserId] = useState('all');
  const [orgId, setOrgId] = useState('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [sort, setSort] = useState({ key: 'updated_at', dir: 'desc' });
  const [page, setPage] = useState(1);
  const appPageSize = useThemeStore((s) => s.rowsPerPage);
  const [ownPageSize, setOwnPageSize] = useState(null);
  const pageSize = ownPageSize ?? appPageSize;
  const [openId, setOpenId] = useState(null);

  const { data: orgs = [] } = useQuery({ queryKey: ['organizations'], queryFn: () => organizationsApi.list() });
  const { data: users = [] } = useQuery({ queryKey: ['users'], queryFn: () => usersApi.list() });

  const filters = useMemo(() => ({
    org_id: orgId === 'all' ? undefined : Number(orgId),
    user_id: userId === 'all' ? undefined : Number(userId),
    q: search.trim() || undefined,
    date_from: dateFrom || undefined,
    date_to: dateTo || undefined,
  }), [orgId, userId, search, dateFrom, dateTo]);

  const { data: sessions = [], isFetching, refetch } = useQuery({
    queryKey: ['ai-chat-sessions', filters],
    queryFn: () => listChatAudit(filters),
  });

  const hasFilters = search || userId !== 'all' || orgId !== 'all' || dateFrom || dateTo;
  const clearFilters = () => { setSearch(''); setUserId('all'); setOrgId('all'); setDateFrom(''); setDateTo(''); };

  const columns = [
    { key: 'user', label: 'User', sortable: true },
    { key: 'org', label: 'Organization', sortable: true },
    { key: 'conversation', label: 'Conversation', sortable: true },
    { key: 'last_message', label: 'Last Message' },
    { key: 'created_at', label: 'Created', sortable: true, width: 130 },
    { key: 'updated_at', label: 'Updated', sortable: true, width: 130 },
    { key: 'open', label: '', width: 90 },
  ];

  const rows = sessions.map((s) => ({
    key: String(s.id),
    sort: {
      user: s.user_name || '', org: s.org_name || '', conversation: s.title || '',
      created_at: s.created_at ? new Date(s.created_at).getTime() : 0,
      updated_at: s.updated_at ? new Date(s.updated_at).getTime() : 0,
    },
    cells: {
      user: <span className="font-semibold text-fg">{s.user_name || `User ${s.user_id}`}</span>,
      org: <span className="text-muted">{s.org_name || `Org ${s.org_id}`}</span>,
      conversation: <span className="text-fg">{s.title || 'New chat'}</span>,
      last_message: s.last_message
        ? <span className="truncate-safe block max-w-72 text-muted" title={s.last_message}>{s.last_message}</span>
        : <span className="text-subtle">—</span>,
      created_at: <span className="whitespace-nowrap text-[12px] text-muted">{fullTime(s.created_at)}</span>,
      updated_at: <span className="whitespace-nowrap text-[12px] text-muted" title={fullTime(s.updated_at)}>{ago(s.updated_at)}</span>,
      open: <Button size="sm" variant="secondary" icon="external" onClick={() => setOpenId(s.id)}>Open</Button>,
    },
  }));

  const sorted = sortRows(rows, sort);
  const pageCount = pageCountOf(sorted.length, pageSize);
  useEffect(() => { if (page > pageCount) setPage(pageCount); }, [page, pageCount]);
  const currentPage = Math.min(page, pageCount);
  const pageRows = paginate(sorted, currentPage, pageSize);

  const openSession = sessions.find((s) => s.id === openId);

  return (
    <div className="space-y-gutter">
      <PageHeader
        title="AI Chat Sessions"
        description="Every ActMon AI conversation across your users, for audit and support."
        icon="chat"
      />

      <div className="flex flex-wrap items-center gap-2">
        <Input
          icon="search"
          placeholder="Search conversation title or message…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onClear={() => setSearch('')}
          wrapperClassName="w-full min-w-0 sm:w-auto sm:max-w-64 sm:flex-1"
        />
        <Select
          width="auto"
          value={userId}
          onChange={setUserId}
          options={[{ id: 'all', label: 'All users' }, ...users.map((u) => ({ id: String(u.user_id), label: u.user_name }))]}
        />
        <Select
          width="auto"
          value={orgId}
          onChange={setOrgId}
          options={[{ id: 'all', label: 'All organizations' }, ...orgs.map((o) => ({ id: String(o.org_id), label: o.org_name }))]}
        />
        <Button variant="ghost" size="sm" icon="refresh" loading={isFetching} onClick={() => refetch()}>Refresh</Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-semibold text-subtle">Date range</span>
        <input
          type="date"
          value={dateFrom}
          onChange={(e) => setDateFrom(e.target.value)}
          className="h-control-sm rounded-control border border-border bg-surface px-2 text-[12px] text-fg"
        />
        <span className="text-[11px] text-subtle">to</span>
        <input
          type="date"
          value={dateTo}
          onChange={(e) => setDateTo(e.target.value)}
          className="h-control-sm rounded-control border border-border bg-surface px-2 text-[12px] text-fg"
        />
        {hasFilters && <Button variant="ghost" size="sm" icon="close" onClick={clearFilters}>Clear filters</Button>}
        <span className="ml-auto shrink-0 text-[12px] whitespace-nowrap text-subtle">{sessions.length} conversations</span>
      </div>

      <div>
        <Table
          columns={columns}
          rows={pageRows}
          sort={sort}
          onSort={(key) => setSort((s) => nextSort(s, key))}
          rowHeight={64}
          darkHeader
          loading={isFetching}
          empty={
            hasFilters ? (
              <EmptyState
                icon="filter"
                title="No conversations match these filters"
                body="Try widening the search or clearing a filter."
                action={<Button size="sm" icon="close" onClick={clearFilters}>Clear filters</Button>}
              />
            ) : (
              <EmptyState icon="chat" title="No AI conversations yet" body="Conversations appear here as users chat with ActMon AI." />
            )
          }
        />
      </div>
      {sorted.length > 0 && (
        <div className="card">
          <Pagination
            page={currentPage}
            pageCount={pageCount}
            total={sorted.length}
            pageSize={pageSize}
            onPage={setPage}
            onPageSize={setOwnPageSize}
            unit="conversations"
          />
        </div>
      )}

      <ConversationDialog
        open={!!openId}
        sessionId={openId}
        title={openSession?.title}
        userName={openSession?.user_name}
        onClose={() => setOpenId(null)}
      />
    </div>
  );
}

function ConversationDialog({ open, sessionId, title, userName, onClose }) {
  const { data, isFetching } = useQuery({
    queryKey: ['ai-chat-audit-messages', sessionId],
    queryFn: () => getChatAuditMessages(sessionId),
    enabled: open && !!sessionId,
  });
  const messages = data?.messages || [];

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title || 'Conversation'}
      subtitle={userName ? `${userName}'s conversation` : undefined}
      icon="chat"
      size="full"
      width={720}
    >
      <div className="space-y-4 py-1">
        {isFetching && messages.length === 0 ? (
          <p className="py-8 text-center text-[12px] text-subtle">Loading conversation…</p>
        ) : messages.length === 0 ? (
          <p className="py-8 text-center text-[12px] text-subtle">No messages in this conversation.</p>
        ) : (
          messages.map((m) => (
            <div key={m.id} className={m.role === 'user' ? 'flex justify-end' : 'flex items-start gap-2'}>
              {m.role !== 'user' && <ActmonAiMark size={22} glow={false} animated={false} className="mt-0.5" />}
              <div
                className={
                  m.role === 'user'
                    ? 'max-w-[80%] rounded-2xl rounded-br-md bg-accent px-3 py-2 text-accent-fg'
                    : `max-w-[80%] rounded-2xl rounded-bl-md px-3 py-2 ${m.error ? 'bg-danger-soft text-danger-fg' : 'bg-sunken'}`
                }
              >
                {m.role === 'user'
                  ? <p className="text-[13px] leading-relaxed whitespace-pre-wrap">{m.content}</p>
                  : <FormatMessage text={m.content} />}
                <p className="mt-1 text-[10px] text-subtle">{fullTime(m.created_at)}</p>
              </div>
            </div>
          ))
        )}
      </div>
    </Dialog>
  );
}
