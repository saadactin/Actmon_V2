import React, { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import client from '@/api/client';
import Drawer from '@/components/ui/Drawer';
import Tabs from '@/components/ui/Tabs';
import Badge from '@/components/ui/Badge';
import Icon from '@/components/ui/Icon';
import Notice from '@/components/ui/Notice';
import Select from '@/components/ui/Select';
import Table, { EmptyState } from '@/components/ui/Table';
import { PageLoading } from '@/components/ui/Loading';

/**
 * Role Details — "what can this PostgreSQL role actually do?"
 *
 * Opens from a row in Users → Roles & Permissions. Everything shown is
 * EFFECTIVE access as PostgreSQL itself computes it (has_*_privilege), so it
 * already includes inherited privileges, PUBLIC grants and superuser — not just
 * what somebody typed in a GRANT.
 *
 * Two things this deliberately makes loud rather than leaving implicit:
 *
 *  - A SUPERUSER passes every privilege check. Showing 400 ticked tables without
 *    saying why would read as "somebody granted all this", when the truth is the
 *    role bypasses privilege checks entirely.
 *  - Schema/table/sequence/function privileges are PER-DATABASE. The drawer says
 *    which database it inspected and lets you switch, because "this role has no
 *    table access" is otherwise a half-truth about one database out of several.
 *
 * No password, hash or verifier is fetched or displayed — the API never selects
 * one.
 */

const TABS = [
  { id: 'overview',   label: 'Overview',     icon: 'info' },
  { id: 'databases',  label: 'Databases',    icon: 'database' },
  { id: 'schemas',    label: 'Schemas',      icon: 'layers' },
  { id: 'tables',     label: 'Tables',       icon: 'table' },
  { id: 'sequences',  label: 'Sequences',    icon: 'rows' },
  { id: 'functions',  label: 'Functions',    icon: 'settings' },
  { id: 'membership', label: 'Memberships',  icon: 'users' },
  { id: 'ownership',  label: 'Ownership',    icon: 'key' },
  { id: 'sessions',   label: 'Sessions',     icon: 'activity' },
];

/** Tick / cross. Never colour alone — the glyph carries the meaning too. */
const Flag = ({ on }) => (
  <span className="inline-flex items-center justify-center" title={on ? 'Granted' : 'Not granted'}>
    <Icon name={on ? 'check' : 'close'} size={14}
          style={{ color: on ? 'var(--success-fg)' : 'var(--border-strong)' }} />
  </span>
);

const AttrRow = ({ label, children }) => (
  <div className="flex items-center justify-between gap-3 border-b border-border py-2 last:border-0">
    <span className="text-[12.5px] text-muted">{label}</span>
    <span className="text-[13px] font-semibold text-fg">{children}</span>
  </div>
);

const YesNo = ({ v }) => (
  <Badge tone={v ? 'success' : 'neutral'} size="xs">{v ? 'Yes' : 'No'}</Badge>
);

/** Shared table chrome: same darkHeader treatment as the Agents list. */
const Grid = ({ columns, rows, empty }) => (
  <Table columns={columns} rows={rows} rowHeight={52} darkHeader
         empty={<EmptyState icon="boxes" title={empty} />} />
);

const priv = (key, label) => ({
  key, label, align: 'center', width: 96,
});

export default function RoleDetailDrawer({ connId, role, open, onClose }) {
  const [tab, setTab] = useState('overview');
  const [dbOverride, setDbOverride] = useState('');

  const q = useQuery({
    queryKey: ['pgRoleDetail', connId, role, dbOverride],
    queryFn: () => client
      .get(`/connections/postgresql/${connId}/role-detail`, {
        params: { role, ...(dbOverride ? { database: dbOverride } : {}) },
      })
      .then((r) => r.data),
    enabled: !!open && !!role,
    retry: false,
  });

  const d = q.data || {};
  const a = d.attributes || {};
  const sum = d.effective_summary || {};
  const isSuper = !!d.via_superuser;

  // Reset to Overview when a different role is opened, so you never land on a
  // deep tab showing the previous role's shape.
  React.useEffect(() => { setTab('overview'); setDbOverride(''); }, [role]);

  const dbOptions = useMemo(
    () => (d.databases || [])
      .filter((x) => x.datallowconn !== false)
      .map((x) => ({ id: x.datname, label: x.datname })),
    [d.databases],
  );

  const tabsWithCounts = useMemo(() => TABS.map((t) => {
    const n = {
      databases: (d.databases || []).length,
      schemas: (d.schemas || []).length,
      tables: d.tables?.total,
      sequences: (d.sequences || []).length,
      functions: d.functions?.total,
      membership: (d.member_of || []).length + (d.members || []).length,
      sessions: (d.sessions || []).length,
    }[t.id];
    return n == null ? t : { ...t, count: n };
  }), [d]);

  const body = () => {
    if (q.isLoading) return <PageLoading title={`Loading ${role}…`} />;
    if (q.isError || d.status === 'error') {
      return (
        <Notice tone="danger" title="Could not read this role">
          {d.error || q.error?.message || 'The server rejected the request.'}
        </Notice>
      );
    }

    switch (tab) {
      /* ── Overview ───────────────────────────────────────────────────── */
      case 'overview':
        return (
          <div className="space-y-4">
            {isSuper && (
              <Notice tone="warning" title="Superuser">
                This role bypasses every privilege check. The ticks on the other tabs
                reflect that, not individual grants — a superuser can access everything
                whether or not anything was granted to it.
              </Notice>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="rounded-card border border-border p-4">
                <p className="mb-2 text-[11px] font-bold tracking-wide text-muted uppercase">Role attributes</p>
                <AttrRow label="Can login"><YesNo v={a.rolcanlogin} /></AttrRow>
                <AttrRow label="Superuser"><YesNo v={a.rolsuper} /></AttrRow>
                <AttrRow label="Inherit privileges"><YesNo v={a.rolinherit} /></AttrRow>
                <AttrRow label="Create role"><YesNo v={a.rolcreaterole} /></AttrRow>
                <AttrRow label="Create database"><YesNo v={a.rolcreatedb} /></AttrRow>
                <AttrRow label="Replication"><YesNo v={a.rolreplication} /></AttrRow>
                <AttrRow label="Bypass RLS"><YesNo v={a.rolbypassrls} /></AttrRow>
              </div>
              <div className="rounded-card border border-border p-4">
                <p className="mb-2 text-[11px] font-bold tracking-wide text-muted uppercase">Login &amp; credentials</p>
                <AttrRow label="Login">
                  <Badge tone={a.rolcanlogin ? 'success' : 'neutral'} size="xs">
                    {a.rolcanlogin ? 'Enabled' : 'Disabled'}
                  </Badge>
                </AttrRow>
                <AttrRow label="Connection limit">
                  {a.rolconnlimit == null ? <span className="text-muted">Unlimited</span> : a.rolconnlimit}
                </AttrRow>
                <AttrRow label="Password expiry">
                  {a.rolvaliduntil
                    ? <Badge tone={a.expired ? 'danger' : 'success'} size="xs">
                        {a.expired ? 'Expired ' : ''}{String(a.rolvaliduntil).slice(0, 10)}
                      </Badge>
                    : <span className="text-muted">Never</span>}
                </AttrRow>
                <AttrRow label="Active sessions">{sum.active_sessions ?? 0}</AttrRow>
                {!!(a.rolconfig || []).length && (
                  <AttrRow label="Role settings">
                    <span className="font-mono text-[11.5px]">{a.rolconfig.join(', ')}</span>
                  </AttrRow>
                )}
                <p className="mt-2 text-[11px] text-subtle">
                  PostgreSQL never exposes a stored password or verifier, and ACTMON does not read one.
                </p>
              </div>
            </div>

            <div className="rounded-card border border-border p-4">
              <p className="mb-3 text-[11px] font-bold tracking-wide text-muted uppercase">
                Effective access {isSuper && '(via superuser)'}
              </p>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {[
                  ['Databases', `${sum.databases_connectable ?? 0} / ${sum.databases_total ?? 0}`, 'connectable'],
                  ['Schemas', `${sum.schemas_usable ?? 0} / ${sum.schemas_total ?? 0}`, 'usable'],
                  ['Tables', sum.tables_accessible ?? 0, 'accessible'],
                  ['Sequences', sum.sequences_accessible ?? 0, 'accessible'],
                  ['Functions', sum.functions_executable ?? 0, 'executable'],
                  ['Member of', sum.member_of_count ?? 0, 'roles'],
                ].map(([label, value, hint]) => (
                  <div key={label} className="rounded-control bg-sunken px-3 py-2.5">
                    <p className="text-[10px] font-bold tracking-wide text-subtle uppercase">{label}</p>
                    <p className="mt-0.5 text-[18px] font-bold text-fg">{value}</p>
                    <p className="text-[10px] text-subtle">{hint}</p>
                  </div>
                ))}
              </div>
              <p className="mt-3 text-[11.5px] text-muted">
                Counts are what PostgreSQL itself reports for this role, so they already include
                privileges inherited through role membership, grants made to PUBLIC
                {a.rolinherit === false && ' (note: this role does NOT inherit, so membership alone grants nothing until SET ROLE)'}
                {isSuper && ', and superuser'}.
              </p>
            </div>
          </div>
        );

      /* ── Databases ──────────────────────────────────────────────────── */
      case 'databases':
        return (
          <Grid
            columns={[
              { key: 'datname', label: 'Database', width: 220 },
              { key: 'owner', label: 'Owner', align: 'center', width: 160 },
              priv('connect', 'CONNECT'), priv('create', 'CREATE'), priv('temp', 'TEMP'),
            ]}
            rows={(d.databases || []).map((x) => ({
              key: x.datname,
              cells: {
                datname: <span className="text-[13px] font-semibold text-fg">{x.datname}</span>,
                owner: <span className="text-[12.5px] text-muted">{x.owner}</span>,
                connect: <Flag on={x.can_connect} />,
                create: <Flag on={x.can_create} />,
                temp: <Flag on={x.can_temp} />,
              },
            }))}
            empty="No databases visible to this connection"
          />
        );

      /* ── Schemas ────────────────────────────────────────────────────── */
      case 'schemas':
        return (
          <Grid
            columns={[
              { key: 'nspname', label: 'Schema', width: 260 },
              { key: 'owner', label: 'Owner', align: 'center', width: 180 },
              priv('usage', 'USAGE'), priv('create', 'CREATE'),
            ]}
            rows={(d.schemas || []).map((x) => ({
              key: x.nspname,
              cells: {
                nspname: <span className="text-[13px] font-semibold text-fg">{x.nspname}</span>,
                owner: <span className="text-[12.5px] text-muted">{x.owner}</span>,
                usage: <Flag on={x.usage} />,
                create: <Flag on={x.create} />,
              },
            }))}
            empty={`No schemas in ${d.inspected_database}`}
          />
        );

      /* ── Tables ─────────────────────────────────────────────────────── */
      case 'tables': {
        const t = d.tables || { items: [] };
        const KIND = { r: 'table', p: 'partitioned', v: 'view', m: 'matview', f: 'foreign' };
        return (
          <div className="space-y-3">
            {t.truncated && (
              <Notice tone="info" title={`Showing ${t.items.length} of ${t.total}`}>
                Only the first {t.items.length} are listed, to keep this fast on a large database.
              </Notice>
            )}
            <Grid
              columns={[
                { key: 'name', label: 'Table', width: 280 },
                { key: 'kind', label: 'Kind', align: 'center', width: 110 },
                priv('sel', 'SELECT'), priv('ins', 'INSERT'), priv('upd', 'UPDATE'),
                priv('del', 'DELETE'), priv('trunc', 'TRUNCATE'), priv('ref', 'REFERENCES'),
                priv('trig', 'TRIGGER'),
              ]}
              rows={t.items.map((x, i) => ({
                key: `${x.schema}.${x.name}-${i}`,
                cells: {
                  name: (
                    <span className="text-[13px] font-semibold text-fg">
                      <span className="text-muted">{x.schema}.</span>{x.name}
                    </span>
                  ),
                  kind: <Badge tone="neutral" size="xs">{KIND[x.relkind] || x.relkind}</Badge>,
                  sel: <Flag on={x.p_select} />, ins: <Flag on={x.p_insert} />,
                  upd: <Flag on={x.p_update} />, del: <Flag on={x.p_delete} />,
                  trunc: <Flag on={x.p_truncate} />, ref: <Flag on={x.p_references} />,
                  trig: <Flag on={x.p_trigger} />,
                },
              }))}
              empty={`No table access in ${d.inspected_database}`}
            />
          </div>
        );
      }

      /* ── Sequences ──────────────────────────────────────────────────── */
      case 'sequences':
        return (
          <Grid
            columns={[
              { key: 'name', label: 'Sequence', width: 300 },
              { key: 'owner', label: 'Owner', align: 'center', width: 160 },
              priv('usage', 'USAGE'), priv('sel', 'SELECT'), priv('upd', 'UPDATE'),
            ]}
            rows={(d.sequences || []).map((x, i) => ({
              key: `${x.schema}.${x.name}-${i}`,
              cells: {
                name: (
                  <span className="text-[13px] font-semibold text-fg">
                    <span className="text-muted">{x.schema}.</span>{x.name}
                  </span>
                ),
                owner: <span className="text-[12.5px] text-muted">{x.owner}</span>,
                usage: <Flag on={x.p_usage} />, sel: <Flag on={x.p_select} />,
                upd: <Flag on={x.p_update} />,
              },
            }))}
            empty={`No sequence access in ${d.inspected_database}`}
          />
        );

      /* ── Functions ──────────────────────────────────────────────────── */
      case 'functions': {
        const f = d.functions || { items: [] };
        return (
          <div className="space-y-3">
            {f.truncated && (
              <Notice tone="info" title={`Showing ${f.items.length} of ${f.total}`}>
                Only the first {f.items.length} are listed.
              </Notice>
            )}
            <Grid
              columns={[
                { key: 'name', label: 'Function / Procedure', width: 340 },
                { key: 'kind', label: 'Kind', align: 'center', width: 120 },
                { key: 'owner', label: 'Owner', align: 'center', width: 150 },
                priv('exec', 'EXECUTE'),
              ]}
              rows={f.items.map((x, i) => ({
                key: `${x.schema}.${x.name}-${i}`,
                cells: {
                  name: (
                    <span className="text-[13px] font-semibold text-fg">
                      <span className="text-muted">{x.schema}.</span>{x.name}
                      <span className="ml-1 font-mono text-[11px] text-subtle">({x.args || ''})</span>
                    </span>
                  ),
                  kind: <Badge tone="neutral" size="xs">{x.kind}</Badge>,
                  owner: <span className="text-[12.5px] text-muted">{x.owner}</span>,
                  exec: <Flag on={x.p_execute} />,
                },
              }))}
              empty={`No executable functions in ${d.inspected_database}`}
            />
          </div>
        );
      }

      /* ── Memberships ────────────────────────────────────────────────── */
      case 'membership':
        return (
          <div className="space-y-5">
            {a.rolinherit === false && (
              <Notice tone="warning" title="This role does not inherit">
                NOINHERIT is set, so membership alone grants nothing — the role must
                run SET ROLE to use privileges from the roles below.
              </Notice>
            )}
            <div>
              <p className="mb-2 text-[11px] font-bold tracking-wide text-muted uppercase">
                Member of ({(d.member_of || []).length})
              </p>
              <Grid
                columns={[
                  { key: 'role_name', label: 'Role', width: 260 },
                  { key: 'inherited', label: 'Privileges inherited', align: 'center', width: 200 },
                  { key: 'admin', label: 'Admin option', align: 'center', width: 160 },
                ]}
                rows={(d.member_of || []).map((x) => ({
                  key: x.role_name,
                  cells: {
                    role_name: <span className="text-[13px] font-semibold text-fg">{x.role_name}</span>,
                    inherited: <Badge tone={a.rolinherit ? 'success' : 'warning'} size="xs">
                      {a.rolinherit ? 'Yes' : 'Only after SET ROLE'}
                    </Badge>,
                    admin: <Flag on={x.admin_option} />,
                  },
                }))}
                empty="Not a member of any role"
              />
            </div>
            <div>
              <p className="mb-2 text-[11px] font-bold tracking-wide text-muted uppercase">
                Members of this role ({(d.members || []).length})
              </p>
              <Grid
                columns={[
                  { key: 'member_name', label: 'Member', width: 260 },
                  { key: 'login', label: 'Can login', align: 'center', width: 150 },
                  { key: 'inherits', label: 'Inherits', align: 'center', width: 150 },
                  { key: 'admin', label: 'Admin option', align: 'center', width: 160 },
                ]}
                rows={(d.members || []).map((x) => ({
                  key: x.member_name,
                  cells: {
                    member_name: <span className="text-[13px] font-semibold text-fg">{x.member_name}</span>,
                    login: <Flag on={x.member_can_login} />,
                    inherits: <Flag on={x.member_inherits} />,
                    admin: <Flag on={x.admin_option} />,
                  },
                }))}
                empty="No roles are members of this one"
              />
            </div>
          </div>
        );

      /* ── Ownership ──────────────────────────────────────────────────── */
      case 'ownership': {
        const o = d.ownership || {};
        const entries = [
          ['Databases', o.databases], ['Schemas', o.schemas], ['Tables', o.tables],
          ['Views', o.views], ['Materialized views', o.materialized_views],
          ['Sequences', o.sequences], ['Indexes', o.indexes],
          ['Foreign tables', o.foreign_tables], ['Functions', o.functions],
        ];
        const any = entries.some(([, n]) => (n || 0) > 0);
        return (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {entries.map(([label, n]) => (
                <div key={label} className="rounded-card border border-border px-3 py-2.5">
                  <p className="text-[10px] font-bold tracking-wide text-subtle uppercase">{label}</p>
                  <p className={`mt-0.5 text-[20px] font-bold ${(n || 0) > 0 ? 'text-fg' : 'text-subtle'}`}>
                    {n || 0}
                  </p>
                </div>
              ))}
            </div>
            {!any && (
              <p className="text-[12.5px] text-muted">This role owns nothing in {d.inspected_database}.</p>
            )}
            <p className="text-[11.5px] text-subtle">
              Object counts other than databases are for <b>{d.inspected_database}</b>; ownership is
              recorded per database.
            </p>
          </div>
        );
      }

      /* ── Sessions ───────────────────────────────────────────────────── */
      case 'sessions':
        return (
          <Grid
            columns={[
              { key: 'pid', label: 'PID', align: 'center', width: 90 },
              { key: 'datname', label: 'Database', width: 150 },
              { key: 'client', label: 'Client', width: 140 },
              { key: 'app', label: 'Application', width: 170 },
              { key: 'state', label: 'State', align: 'center', width: 140 },
              { key: 'started', label: 'Backend start', align: 'center', width: 170 },
              { key: 'age', label: 'Query age', align: 'center', width: 120 },
              { key: 'query', label: 'Current query', width: 340 },
            ]}
            rows={(d.sessions || []).map((x) => ({
              key: String(x.pid),
              cells: {
                pid: <span className="font-mono text-[12.5px] text-fg">{x.pid}</span>,
                datname: <span className="text-[12.5px] text-fg">{x.datname || '—'}</span>,
                client: <span className="font-mono text-[12px] text-muted">{x.client_addr || 'local'}</span>,
                app: <span className="truncate text-[12.5px] text-muted">{x.application_name || '—'}</span>,
                state: (
                  <Badge tone={x.state === 'active' ? 'success'
                    : String(x.state || '').startsWith('idle in transaction') ? 'warning' : 'neutral'} size="xs">
                    {x.state || 'unknown'}
                  </Badge>
                ),
                started: <span className="text-[12px] text-muted">{(x.backend_start || '').slice(0, 19) || '—'}</span>,
                age: <span className="text-[12.5px] text-muted">{x.query_age_s == null ? '—' : `${x.query_age_s}s`}</span>,
                query: (
                  <span className="block max-w-[320px] truncate font-mono text-[11.5px] text-muted"
                        title={x.query}>{x.query || '—'}</span>
                ),
              },
            }))}
            empty="No active sessions for this role"
          />
        );

      default:
        return null;
    }
  };

  /* Which database the object tabs describe — only meaningful on those tabs. */
  const showsDbScope = ['schemas', 'tables', 'sequences', 'functions', 'ownership'].includes(tab);

  return (
    <Drawer
      open={open}
      onClose={onClose}
      icon="users"
      title={role}
      subtitle={a.rolcanlogin ? 'LOGIN ENABLED' : 'LOGIN DISABLED'}
      width={1180}
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          {a.rolsuper && <Badge tone="danger" size="xs">SUPERUSER</Badge>}
          <Badge tone={a.rolcanlogin ? 'success' : 'neutral'} size="xs">
            {a.rolcanlogin ? 'LOGIN ENABLED' : 'LOGIN DISABLED'}
          </Badge>
          {a.rolcreatedb && <Badge tone="info" size="xs">CREATEDB</Badge>}
          {a.rolcreaterole && <Badge tone="accent" size="xs">CREATEROLE</Badge>}
          {a.rolreplication && <Badge tone="info" size="xs">REPLICATION</Badge>}
          {a.rolbypassrls && <Badge tone="warning" size="xs">BYPASSRLS</Badge>}
          {a.rolinherit === false && <Badge tone="warning" size="xs">NOINHERIT</Badge>}
          {a.expired && <Badge tone="danger" size="xs">PASSWORD EXPIRED</Badge>}
        </div>

        <Tabs tabs={tabsWithCounts} value={tab} onChange={setTab} />

        {showsDbScope && (
          <div className="flex flex-wrap items-center gap-2 rounded-card bg-sunken px-3 py-2">
            <Icon name="info" size={13} className="shrink-0 text-info-fg" />
            <span className="text-[12px] text-muted">
              Schema, table, sequence and function privileges are per-database. Showing
            </span>
            <div className="w-56">
              <Select
                value={dbOverride || d.inspected_database || ''}
                onChange={setDbOverride}
                options={dbOptions}
              />
            </div>
          </div>
        )}

        {body()}

        {!!(d.errors || []).length && (
          <Notice tone="warning" title="Some sections could not be read">
            <ul className="mt-1 space-y-0.5">
              {d.errors.map((e, i) => (
                <li key={i} className="font-mono text-[11px]">{e}</li>
              ))}
            </ul>
          </Notice>
        )}
      </div>
    </Drawer>
  );
}
