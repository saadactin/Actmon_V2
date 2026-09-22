import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Icon from '@/components/ui/Icon';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import Select from '@/components/ui/Select';
import Notice from '@/components/ui/Notice';
import Table, { EmptyState, nextSort, sortRows } from '@/components/ui/Table';
import Pagination from '@/components/ui/Pagination';
import usePaged from '@/hooks/usePaged';
import { PageLoading } from '@/components/ui/Loading';
import { usePermissions } from '@/hooks/usePermissions';
import { useAuthStore } from '@/store/authStore';
import { rolesApi, usersApi } from '@/api/admin';

/**
 * User Roles — which role each login carries, changeable in place.
 *
 * There was no such screen: a user's role was one field buried in the User
 * Master create/edit dialog, so answering "who is an administrator?" meant
 * opening every user in turn. This is the same `role_id` on the same endpoint,
 * surfaced as a column you can edit and filter by.
 *
 * Deliberately narrow: it changes the role and nothing else. Usernames,
 * employees and passwords stay in User Master, so this cannot become a second,
 * half-complete user editor that drifts from the real one.
 */
export default function UserRolesTab() {
  const qc = useQueryClient();
  const { canHere } = usePermissions();
  const myUserId = useAuthStore((s) => s.user?.user_id);
  const orgId = useAuthStore((s) => s.user?.org_id) ?? 1;
  const canEdit = canHere('edit');

  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('all');
  const [sort, setSort] = useState({ key: 'user_name', dir: 'asc' });
  const [pending, setPending] = useState({});   // user_id -> role_id being saved
  const [error, setError] = useState(null);

  const users = useQuery({ queryKey: ['admin', 'users', orgId], queryFn: () => usersApi.list(orgId) });
  const roles = useQuery({ queryKey: ['admin', 'roles', orgId], queryFn: () => rolesApi.list(orgId) });

  const roleList = useMemo(() => (roles.data || []).filter((r) => r.is_active !== false), [roles.data]);
  const roleOptions = useMemo(
    () => roleList.map((r) => ({ id: String(r.role_id), label: r.role_name })), [roleList],
  );

  const setRole = useMutation({
    mutationFn: async ({ user, roleId }) => {
      // PUT the whole row back with only role_id changed — the endpoint is a
      // full update, so omitting fields would blank them.
      await usersApi.update(user.user_id, { ...user, role_id: Number(roleId) });
    },
    onMutate: ({ user, roleId }) => setPending((p) => ({ ...p, [user.user_id]: roleId })),
    onSettled: (_d, _e, { user }) => setPending((p) => {
      const n = { ...p }; delete n[user.user_id]; return n;
    }),
    onSuccess: () => { setError(null); qc.invalidateQueries({ queryKey: ['admin', 'users'] }); },
    onError: (e) => setError(e?.message || 'Could not change that role.'),
  });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (users.data || [])
      .filter((u) => roleFilter === 'all' || String(u.role_id) === String(roleFilter))
      .filter((u) => !q
        || u.user_name?.toLowerCase().includes(q)
        || u.employee_name?.toLowerCase().includes(q)
        || u.role_name?.toLowerCase().includes(q));
  }, [users.data, search, roleFilter]);

  const rows = useMemo(() => filtered.map((u) => {
    const isSelf = Number(u.user_id) === Number(myUserId);
    return {
      key: String(u.user_id),
      sort: {
        user_name: u.user_name || '', employee_name: u.employee_name || '',
        role_name: u.role_name || '', status: u.is_active === false ? 0 : 1,
      },
      cells: {
        user_name: <span className="text-[1rem] leading-[1.125rem] font-semibold text-fg">{u.user_name}</span>,
        employee_name: <span className="text-[1rem] leading-[1.125rem]" style={{ color: 'var(--agent-gray)' }}>{u.employee_name || '—'}</span>,
        role: (
          <div className="mx-auto w-56">
            <Select
              value={String(pending[u.user_id] ?? u.role_id ?? '')}
              onChange={(v) => setRole.mutate({ user: u, roleId: v })}
              options={roleOptions}
              // Changing your own role could remove your own access to this
              // very screen, so it is blocked here exactly as the Role
              // Permissions tab blocks editing your own role.
              disabled={!canEdit || isSelf || !!pending[u.user_id]}
              placeholder="No role"
            />
          </div>
        ),
        status: (
          <Badge tone={u.is_active === false ? 'danger' : 'success'} size="xs">
            {u.is_active === false ? 'Inactive' : 'Active'}
          </Badge>
        ),
        note: isSelf
          ? <Badge tone="warning" size="xs">You</Badge>
          : (u.account_locked ? <Badge tone="danger" size="xs">Locked</Badge> : null),
      },
    };
  }), [filtered, roleOptions, pending, canEdit, myUserId, setRole]);

  const sorted = useMemo(() => sortRows(rows, sort), [rows, sort]);
  const paged = usePaged(sorted);

  if (users.isLoading || roles.isLoading) return <PageLoading title="Loading users…" />;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold text-fg">User Roles</h2>
          <p className="text-[12px] text-muted">
            The role each login carries. Change it here; everything else stays in User Master.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Input value={search} onChange={(e) => setSearch(e.target.value)} onClear={() => setSearch('')}
                 placeholder="Search users…" icon="search" size="sm" wrapperClassName="w-56" />
          <div className="w-48">
            <Select value={roleFilter} onChange={setRoleFilter}
                    options={[{ id: 'all', label: 'All roles' }, ...roleOptions]} />
          </div>
        </div>
      </div>

      {error && <div className="mb-3"><Notice tone="danger" title="Role not changed">{error}</Notice></div>}
      {!canEdit && (
        <div className="mb-3">
          <Notice tone="info" title="Read only">
            You do not have Edit on this page, so roles are shown but cannot be changed.
          </Notice>
        </div>
      )}

      <Table
        columns={[
          { key: 'user_name', label: 'Username', sortable: true, width: 220 },
          { key: 'employee_name', label: 'Employee', sortable: true, width: 240 },
          { key: 'role', label: 'Role', align: 'center', width: 260 },
          { key: 'status', label: 'Status', align: 'center', width: 120, sortable: true },
          { key: 'note', label: '', align: 'center', width: 100 },
        ]}
        rows={paged.rows}
        sort={sort}
        onSort={(key) => setSort((cur) => nextSort(cur, key))}
        rowHeight={64}
        darkHeader
        loading={users.isFetching}
        empty={<EmptyState icon="users" title={search ? 'No users match that search.' : 'No users yet.'} />}
      />
      <Pagination {...paged.props} unit="users" />

      <p className="mt-3 flex items-start gap-2 text-[12px] text-muted">
        <Icon name="info" size={14} className="mt-px shrink-0 text-info-fg" />
        A role change takes effect the next time that user signs in or their menu refreshes.
        Your own role is locked here — use another administrator account to change it.
      </p>
    </div>
  );
}
