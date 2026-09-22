import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';
import client, { errorText } from '@/api/client';
import PageHeader from '@/components/layout/PageHeader';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Icon from '@/components/ui/Icon';
import Notice from '@/components/ui/Notice';
import Table, { EmptyState } from '@/components/ui/Table';
import Textarea from '@/components/ui/Textarea';
import { PageLoading, InlineLoading } from '@/components/ui/Loading';
import { MetricTile, Panel, TablePanel } from '@/pages/_shared/enginePanels';

/**
 * One Oracle user's roles/privileges — opened by clicking a row on the Users
 * tab. Same detail-page shape as OracleSessionDetailPage: real data first,
 * an "Ask ActMon AI" panel underneath that only ever explains the facts
 * already on the page, grounded via oracle-storage-ai-explain (the same
 * generic explain endpoint Storage Health and Live Queries already use —
 * object_type="user" here — never a second, parallel AI mechanism).
 */

const AI_LANGUAGES = [
  'English', 'Hindi', 'Marathi', 'Spanish', 'French', 'German', 'Portuguese',
  'Arabic', 'Chinese (Simplified)', 'Japanese', 'Russian',
];

const ACCOUNT_TONES = {
  OPEN: 'success',
  'EXPIRED(GRACE)': 'warning',
  EXPIRED: 'warning',
  LOCKED: 'danger',
  'LOCKED(TIMED)': 'danger',
  'EXPIRED & LOCKED': 'danger',
  'EXPIRED(GRACE) & LOCKED(TIMED)': 'danger',
};

export default function OracleUserDetailPage() {
  const { id, username } = useParams();
  const navigate = useNavigate();
  const backTo = `/oracle-dashboard/${id}/users`;

  const [aiThread, setAiThread] = useState([]);
  const [aiQuestion, setAiQuestion] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [language, setLanguage] = useState('English');
  const [aiError, setAiError] = useState('');

  const { data, isLoading, error } = useQuery({
    queryKey: ['oracleUserPrivileges', id, username],
    queryFn: () => client.get(`/connections/oracle/${id}/oracle-users/${username}/privileges`).then((r) => r.data),
    enabled: !!id && !!username,
    retry: false,
  });

  if (isLoading) return <PageLoading title={`Reading ${username}'s roles and privileges…`} illustration />;
  if (error || data?.status === 'error') {
    return (
      <>
        <PageHeader title={username} icon="key" backTo={backTo} />
        <Notice tone="danger" title="Could not load this account.">{data?.error || errorText(error)}</Notice>
      </>
    );
  }

  const p = data.profile;
  const roles = data.roles || [];
  const sysPrivs = data.system_privileges || [];
  const objPrivs = data.object_privileges || [];
  const quotas = data.tablespace_quotas || [];
  const s = data.summary || {};

  const askAi = async (question) => {
    setAiLoading(true);
    setAiError('');
    try {
      const facts = {
        account_status: p.account_status,
        profile: p.profile,
        default_tablespace: p.default_tablespace,
        temporary_tablespace: p.temporary_tablespace,
        created: p.created,
        last_login: p.last_login || 'never recorded',
        expiry_date: p.expiry_date || 'does not expire',
        is_dba: s.is_dba,
        roles: roles.map((r) => r.role).join(', ') || '(none)',
        system_privileges: sysPrivs.map((sp) => sp.privilege).join(', ') || '(none)',
        object_privilege_count: s.object_privilege_count,
        tablespace_quotas: quotas.map((q) => `${q.tablespace_name}: ${q.used_mb}MB used${q.max_mb != null ? ` of ${q.max_mb}MB` : ' (unlimited)'}`).join('; ') || '(none)',
      };

      const res = await client.post(`/connections/oracle/${id}/oracle-storage-ai-explain`, {
        object_type: 'user',
        object_label: username,
        problem: s.is_dba ? 'This account holds the DBA role.' : null,
        evidence: s.is_dba ? 'DBA is granted directly among its roles.' : null,
        facts,
        question: question || null,
        history: aiThread,
        language,
      }).then((r) => r.data);

      if (res.status === 'success') {
        setAiThread((prev) => [...prev, { question: question || null, answer: res.answer }]);
        setAiQuestion('');
      } else {
        setAiError(res.error || 'ActMon AI could not answer that.');
      }
    } catch (e) {
      setAiError(errorText(e));
    } finally {
      setAiLoading(false);
    }
  };

  return (
    <>
      <PageHeader
        title={p.username}
        description={`${p.profile || 'no profile'} · ${p.default_tablespace || 'no default tablespace'}`}
        icon="key"
        backTo={backTo}
        actions={(
          <>
            <Badge tone={ACCOUNT_TONES[p.account_status] || 'neutral'} size="sm">{p.account_status}</Badge>
            {s.is_dba && <Badge tone="danger" size="sm">DBA</Badge>}
          </>
        )}
      />

      <div className="space-y-gutter">
        {(data.errors || []).length > 0 && (
          <Notice tone="warning" title="Some privilege data could not be collected.">{data.errors.join(' · ')}</Notice>
        )}

        <div className="grid grid-cols-2 gap-gutter-sm sm:grid-cols-4">
          <MetricTile label="Roles" value={s.role_count ?? 0} icon="layers" />
          <MetricTile label="System Privileges" value={s.system_privilege_count ?? 0} icon="key" />
          <MetricTile label="Object Privileges" value={s.object_privilege_count ?? 0} icon="database" />
          <MetricTile label="Last Login" value={p.last_login || 'Never'} icon="clock"
            tone={p.last_login ? 'neutral' : 'warn'} />
        </div>

        {s.is_dba && (
          <Notice tone="danger" title="This account holds the DBA role.">
            DBA effectively grants every system privilege in the database — treat any change to this account as high-risk.
          </Notice>
        )}

        <TablePanel title="Granted roles" icon="layers"
          subtitle="dba_role_privs — a role bundles many privileges together under one name">
          <Table
            columns={[
              { key: 'role', label: 'Role' },
              { key: 'default', label: 'Default at login' },
              { key: 'admin', label: 'Can grant to others' },
            ]}
            rows={roles.map((r) => ({
              key: r.role,
              cells: {
                role: <span className="font-mono text-[12px] font-semibold text-fg">{r.role}</span>,
                default: r.default_role
                  ? <Badge tone="success" size="xs">Yes</Badge>
                  : <span className="text-subtle">No</span>,
                admin: r.admin_option
                  ? <Badge tone="warning" size="xs">Yes (ADMIN OPTION)</Badge>
                  : <span className="text-subtle">No</span>,
              },
            }))}
            empty={<EmptyState icon="layers" title="No roles granted" />}
          />
        </TablePanel>

        <TablePanel title="System privileges" icon="key"
          subtitle="dba_sys_privs — privileges granted directly, not through a role">
          <Table
            columns={[
              { key: 'privilege', label: 'Privilege' },
              { key: 'admin', label: 'Can grant to others' },
            ]}
            rows={sysPrivs.map((sp, i) => ({
              key: `${sp.privilege}-${i}`,
              cells: {
                privilege: <span className="font-mono text-[12px] text-fg">{sp.privilege}</span>,
                admin: sp.admin_option
                  ? <Badge tone="warning" size="xs">Yes (ADMIN OPTION)</Badge>
                  : <span className="text-subtle">No</span>,
              },
            }))}
            empty={<EmptyState icon="key" title="No direct system privileges" body="This account's privileges likely come entirely from its roles above." />}
          />
        </TablePanel>

        <TablePanel title="Object privileges" icon="database"
          subtitle={`dba_tab_privs — access to specific tables/views (capped at 300 rows)${s.object_privilege_count > objPrivs.length ? ', more exist than shown' : ''}`}>
          <Table
            columns={[
              { key: 'object', label: 'Object' },
              { key: 'privilege', label: 'Privilege' },
              { key: 'grantable', label: 'Can grant to others' },
            ]}
            rows={objPrivs.map((op, i) => ({
              key: `${op.owner}.${op.object_name}-${op.privilege}-${i}`,
              cells: {
                object: <span className="font-mono text-[12px] text-fg">{op.owner}.{op.object_name}</span>,
                privilege: <Badge tone="neutral" size="xs">{op.privilege}</Badge>,
                grantable: op.grantable
                  ? <Badge tone="warning" size="xs">Yes</Badge>
                  : <span className="text-subtle">No</span>,
              },
            }))}
            empty={<EmptyState icon="database" title="No object privileges" body="This account has no direct grants on individual tables or views." />}
          />
        </TablePanel>

        {quotas.length > 0 && (
          <TablePanel title="Tablespace quotas" icon="desktop" subtitle="dba_ts_quotas — how much space this account is allowed to use">
            <Table
              columns={[
                { key: 'ts', label: 'Tablespace' },
                { key: 'used', label: 'Used', align: 'right' },
                { key: 'max', label: 'Quota', align: 'right' },
              ]}
              rows={quotas.map((q) => ({
                key: q.tablespace_name,
                cells: {
                  ts: <span className="font-mono text-[12px] text-fg">{q.tablespace_name}</span>,
                  used: <span className="font-mono text-[12px]">{q.used_mb} MB</span>,
                  max: <span className="font-mono text-[12px] text-muted">{q.max_mb != null ? `${q.max_mb} MB` : 'Unlimited'}</span>,
                },
              }))}
              empty={<EmptyState icon="desktop" title="No quotas set" />}
            />
          </TablePanel>
        )}

        <div className="card flex flex-col gap-3 p-card">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="flex items-center gap-1.5 text-[13px] font-bold text-fg">
              <Sparkles size={15} className="text-accent-text" /> Ask ActMon AI
            </h3>
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              className="rounded-control border border-border bg-surface px-2 py-1 text-[11px] font-semibold text-fg"
            >
              {AI_LANGUAGES.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
          </div>

          {aiThread.length === 0 ? (
            <p className="text-[12px] text-subtle">
              Ask anything about this account's roles and privileges — e.g. "what can this user actually do", "is this risky", or "explain in Marathi" — grounded only in the real data on this page.
            </p>
          ) : (
            <div className="space-y-2">
              {aiThread.map((t, i) => (
                <div key={i} className="space-y-1">
                  {t.question && <p className="text-[12px] font-semibold text-fg">You asked: {t.question}</p>}
                  <p className="rounded-card border border-border bg-surface p-3 text-[13px] leading-relaxed text-fg">{t.answer}</p>
                </div>
              ))}
            </div>
          )}

          {aiError && <Notice tone="danger" title="ActMon AI could not answer that.">{aiError}</Notice>}

          {aiThread.length === 0 && (
            <Button variant="secondary" icon="sparkles" loading={aiLoading} onClick={() => askAi(null)}>
              Explain this account's permissions in plain English
            </Button>
          )}

          <div className="flex items-start gap-2">
            <Textarea
              rows={2}
              value={aiQuestion}
              onChange={(e) => setAiQuestion(e.target.value)}
              placeholder="Ask a follow-up question about this account's permissions…"
              wrapperClassName="flex-1"
            />
            <Button variant="primary" loading={aiLoading} disabled={!aiQuestion.trim()} onClick={() => askAi(aiQuestion.trim())}>
              Ask
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}
