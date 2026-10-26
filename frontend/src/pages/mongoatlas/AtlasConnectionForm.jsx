import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  atlasErrorText, createAtlasConnection, getAtlasConnection, testAtlasDraft, updateAtlasConnection,
} from '@/api/atlas';
import PageHeader from '@/components/layout/PageHeader';
import Button from '@/components/ui/Button';
import Icon from '@/components/ui/Icon';
import Input from '@/components/ui/Input';
import Notice from '@/components/ui/Notice';
import Select from '@/components/ui/Select';
import { PageLoading } from '@/components/ui/Loading';
import { engineMeta } from '@/config/engines';
import cn from '@/lib/cn';

/**
 * Add / edit a MongoDB Atlas connection.
 *
 * Three ways in, matching what Atlas gives you:
 *   · Connection URI — the mongodb+srv:// string from Atlas → Connect → Drivers.
 *   · Database credentials — cluster host + database user (built into an SRV URI on the server).
 *   · Atlas API key — project-level Admin API key only: clusters, metrics, alerts, backups, security, but no
 *     database / collection browsing.
 * The first two can ALSO carry an API key, which is what unlocks Atlas-computed history and alerts.
 *
 * Secrets are write-only: on edit, every secret box is empty and "leave blank to keep" applies. The form posts to
 * the ActMon backend, which tests the connection and refuses to save one that does not connect.
 */
const METHODS = [
  { id: 'uri', label: 'Connection URI', icon: 'link', hint: 'Paste the mongodb+srv:// string from Atlas → Connect → Drivers.' },
  { id: 'credentials', label: 'Database credentials', icon: 'key', hint: 'Cluster host plus a database user (Atlas → Database Access).' },
  { id: 'api_key', label: 'Atlas API key', icon: 'shield', hint: 'Project API key only — clusters, metrics, alerts, backups. No collection browsing.' },
];

const SCOPES = [
  { id: 'clusters', label: 'Clusters & metrics', needs: 'API key' },
  { id: 'databases', label: 'Databases & collections', needs: 'URI or credentials' },
  { id: 'performance', label: 'Performance & current ops', needs: 'URI or credentials (API key for history)' },
  { id: 'alerts', label: 'Atlas alerts', needs: 'API key' },
  { id: 'backups', label: 'Backups', needs: 'API key' },
  { id: 'security', label: 'Security & access', needs: 'API key' },
  { id: 'query', label: 'Query analytics', needs: 'API key, M10+ tier' },
];
const ALL_SCOPES = SCOPES.map((s) => s.id);

const EMPTY = {
  connection_name: '', environment: 'Production', project_label: '', auth_method: 'uri',
  connection_uri: '', host: '', username: '', password: '', auth_source: '', database_name: '',
  use_api: false, project_id: '', api_public_key: '', api_private_key: '', monitoring_scope: ALL_SCOPES,
};

const URI_RE = /^mongodb(\+srv)?:\/\/\S+$/;
const PROJECT_RE = /^[0-9a-f]{24}$/;

function fromConnection(c) {
  return {
    ...EMPTY,
    connection_name: c.connection_name || '', environment: c.environment || 'Production',
    project_label: c.project_label || '', auth_method: c.auth_method || 'uri',
    host: c.auth_method === 'credentials' ? (c.host || '') : '', username: c.username || '',
    auth_source: c.auth_source || '', database_name: c.database_name || '',
    use_api: Boolean(c.has_api_key), project_id: c.project_id || '',
    monitoring_scope: c.monitoring_scope?.length ? c.monitoring_scope : ALL_SCOPES,
  };
}

export default function AtlasConnectionForm() {
  const { id } = useParams();
  const editing = Boolean(id);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const engine = engineMeta('mongoatlas');
  const [form, setForm] = useState(editing ? null : EMPTY);
  const [errors, setErrors] = useState({});
  const [result, setResult] = useState(null);   // { ok, results } from a test
  const [tested, setTested] = useState(false);  // the CURRENT values passed a test

  const connQ = useQuery({ queryKey: ['atlasConnection', id], queryFn: () => getAtlasConnection(id), enabled: editing, retry: false });
  const existing = connQ.data;
  useEffect(() => { if (existing && !form) setForm(fromConnection(existing)); }, [existing, form]);

  const set = (k, v) => {
    setForm((f) => ({ ...f, [k]: v }));
    setErrors((e) => ({ ...e, [k]: undefined }));
    setTested(false);
    setResult(null);
  };

  const validate = () => {
    const e = {};
    const f = form;
    if (!f.connection_name.trim()) e.connection_name = 'Required';
    if (f.auth_method === 'uri') {
      if (!f.connection_uri.trim() && !(editing && existing?.has_uri)) e.connection_uri = 'Required';
      else if (f.connection_uri.trim() && !URI_RE.test(f.connection_uri.trim())) e.connection_uri = 'Must start with mongodb+srv:// or mongodb://';
    }
    if (f.auth_method === 'credentials') {
      if (!f.host.trim()) e.host = 'Required';
      else if (/[/:]/.test(f.host.replace(/^mongodb(\+srv)?:\/\//, '')) || f.host.includes('://')) e.host = 'Host name only, e.g. cluster0.ab1cd.mongodb.net';
      if (!f.username.trim()) e.username = 'Required';
      if (!f.password && !(editing && existing?.has_password && existing?.auth_method === 'credentials')) e.password = 'Required';
    }
    const api = f.auth_method === 'api_key' || f.use_api;
    if (api) {
      if (!PROJECT_RE.test(f.project_id.trim())) e.project_id = '24-character hex Project ID (Atlas → Project Settings)';
      if (!f.api_public_key.trim() && !(editing && existing?.has_api_key)) e.api_public_key = 'Required';
      if (!f.api_private_key && !(editing && existing?.has_api_key)) e.api_private_key = 'Required';
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const payload = () => {
    const f = form;
    const api = f.auth_method === 'api_key' || f.use_api;
    return {
      connection_name: f.connection_name.trim(), environment: f.environment, project_label: f.project_label.trim() || null,
      auth_method: f.auth_method, monitoring_scope: f.monitoring_scope,
      connection_uri: f.auth_method === 'uri' ? f.connection_uri.trim() || null : null,
      host: f.auth_method === 'credentials' ? f.host.trim().replace(/^mongodb(\+srv)?:\/\//, '') : null,
      username: f.auth_method === 'credentials' ? f.username.trim() : null,
      password: f.auth_method === 'credentials' ? f.password || null : null,
      auth_source: f.auth_method === 'credentials' ? f.auth_source.trim() || null : null,
      database_name: f.database_name.trim() || null,
      project_id: api ? f.project_id.trim() : null,
      // On edit a blank public key keeps the stored one — the backend only sees the masked prefix otherwise.
      api_public_key: api ? (f.api_public_key.trim() || (editing ? undefined : null)) : null,
      api_private_key: api ? f.api_private_key || null : null,
      remove_api_key: !api && Boolean(existing?.has_api_key),
    };
  };

  const test = useMutation({
    mutationFn: () => testAtlasDraft(payload(), editing ? id : undefined),
    onSuccess: (r) => { setResult(r); setTested(r.ok); },
    onError: (e) => { setResult({ ok: false, message: atlasErrorText(e) }); setTested(false); },
  });

  const save = useMutation({
    mutationFn: () => (editing ? updateAtlasConnection(id, payload()) : createAtlasConnection(payload())),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['atlasConnections'] });
      qc.invalidateQueries({ queryKey: ['atlasConnection', id] });
      qc.invalidateQueries({ queryKey: ['atlas'] });
      navigate(`/mongoatlas-dashboard/${r.connection.id}`);
    },
    onError: (e) => { setResult({ ok: false, message: atlasErrorText(e), results: e?.response?.data?.detail?.results }); setTested(false); },
  });

  const header = (
    <PageHeader
      title={editing ? 'Edit MongoDB Atlas connection' : 'Connect MongoDB Atlas'}
      description={editing ? existing?.connection_name : 'Managed MongoDB — test the connection, then save'}
      backTo={editing ? `/mongoatlas-dashboard/${id}` : '/mongoatlas-servers'}
      leading={(
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-md text-[20px]"
          style={{ background: `color-mix(in srgb, ${engine.color} 16%, transparent)` }}>{engine.emoji}</span>
      )}
      actions={(
        <>
          <Button variant="secondary" icon="plug" loading={test.isPending} disabled={!form}
            onClick={() => { if (validate()) test.mutate(); }}>Test Connection</Button>
          <Button variant="primary" icon="save" loading={save.isPending} disabled={!form || !tested}
            title={tested ? undefined : 'Run a successful test first'}
            onClick={() => { if (validate()) save.mutate(); }}>{editing ? 'Save changes' : 'Save connection'}</Button>
        </>
      )}
    />
  );

  if (editing && connQ.isError) return <>{header}<Notice tone="danger" title="Connection not found.">{atlasErrorText(connQ.error)}</Notice></>;
  if (!form) return <>{header}<PageLoading title="Loading connection…" /></>;

  const f = form;
  const apiOn = f.auth_method === 'api_key' || f.use_api;
  const keepHint = editing ? 'Leave blank to keep the saved value' : undefined;

  return (
    <>
      {header}
      <div className="grid gap-gutter xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-gutter">
          <FormCard title="Connection" icon="database">
            <div className="grid gap-4 md:grid-cols-2">
              <F label="Connection name" error={errors.connection_name} required>
                <Input value={f.connection_name} onChange={(e) => set('connection_name', e.target.value)} placeholder="e.g. Prod Atlas" maxLength={255} />
              </F>
              <F label="Environment">
                <Select value={f.environment} onChange={(v) => set('environment', v)}
                  options={['Production', 'Staging', 'Development', 'QA', 'DR'].map((x) => ({ id: x, label: x }))} />
              </F>
              <F label="Project label" hint="Shown on the dashboard, e.g. the Atlas project name">
                <Input value={f.project_label} onChange={(e) => set('project_label', e.target.value)} placeholder="e.g. Payments" maxLength={255} />
              </F>
              <F label="Default database" hint="Optional — opened first on the Collections tab">
                <Input value={f.database_name} onChange={(e) => set('database_name', e.target.value)} placeholder="e.g. orders" maxLength={255} />
              </F>
            </div>
          </FormCard>

          <FormCard title="Authentication" icon="key">
            <div role="radiogroup" aria-label="Authentication method" className="grid gap-2 md:grid-cols-3">
              {METHODS.map((m) => (
                <button key={m.id} type="button" role="radio" aria-checked={f.auth_method === m.id}
                  onClick={() => set('auth_method', m.id)}
                  className={cn('rounded-xl border-2 p-3 text-left transition-colors',
                    f.auth_method === m.id ? 'border-accent bg-accent-soft' : 'border-border hover:bg-sunken')}>
                  <span className="flex items-center gap-2 text-[13px] font-bold text-fg">
                    <Icon name={m.icon} size={14} className={f.auth_method === m.id ? 'text-accent' : 'text-subtle'} />{m.label}
                  </span>
                  <span className="mt-1 block text-[11.5px] leading-snug text-muted">{m.hint}</span>
                </button>
              ))}
            </div>

            {f.auth_method === 'uri' && (
              <div className="mt-4">
                <F label="Atlas connection URI" required error={errors.connection_uri}
                  hint={editing && existing?.has_uri ? `Saved URI for ${existing.host || 'the cluster'} is kept unless you paste a new one` : 'mongodb+srv://user:password@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority'}>
                  <Input type="password" autoComplete="off" spellCheck={false} value={f.connection_uri}
                    onChange={(e) => set('connection_uri', e.target.value)} placeholder="mongodb+srv://…" maxLength={2000} className="font-mono" />
                </F>
              </div>
            )}

            {f.auth_method === 'credentials' && (
              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <F label="Cluster host" required error={errors.host} hint="From the SRV string, without mongodb+srv://">
                  <Input value={f.host} onChange={(e) => set('host', e.target.value)} placeholder="cluster0.ab1cd.mongodb.net" className="font-mono" maxLength={500} />
                </F>
                <F label="Auth database" hint="Usually blank (admin)">
                  <Input value={f.auth_source} onChange={(e) => set('auth_source', e.target.value)} placeholder="admin" maxLength={255} />
                </F>
                <F label="Database username" required error={errors.username}>
                  <Input value={f.username} onChange={(e) => set('username', e.target.value)} autoComplete="off" maxLength={255} />
                </F>
                <F label="Database password" required={!editing} error={errors.password} hint={keepHint}>
                  <Input type="password" autoComplete="new-password" value={f.password} onChange={(e) => set('password', e.target.value)} maxLength={500} />
                </F>
              </div>
            )}

            <div className="mt-5 rounded-xl border border-border bg-sunken/60 p-4">
              {f.auth_method !== 'api_key' && (
                <label className="flex cursor-pointer items-start gap-2.5">
                  <input type="checkbox" className="mt-0.5" checked={f.use_api} onChange={(e) => set('use_api', e.target.checked)} />
                  <span>
                    <span className="block text-[13px] font-bold text-fg">Also add an Atlas Admin API key</span>
                    <span className="block text-[11.5px] text-muted">Unlocks clusters, Atlas metric history (CPU, memory, disk), alerts, backups, security and Performance Advisor.</span>
                  </span>
                </label>
              )}
              {apiOn && (
                <div className={cn('grid gap-4 md:grid-cols-3', f.auth_method !== 'api_key' && 'mt-4')}>
                  <F label="Project ID" required error={errors.project_id}>
                    <Input value={f.project_id} onChange={(e) => set('project_id', e.target.value.trim())} placeholder="24-char hex" className="font-mono" maxLength={24} />
                  </F>
                  <F label="Public key" required={!editing} error={errors.api_public_key}
                    hint={editing && existing?.api_public_key ? `Saved: ${existing.api_public_key} — blank keeps it` : undefined}>
                    <Input value={f.api_public_key} onChange={(e) => set('api_public_key', e.target.value.trim())} autoComplete="off" className="font-mono" maxLength={100} />
                  </F>
                  <F label="Private key" required={!editing} error={errors.api_private_key} hint={keepHint}>
                    <Input type="password" autoComplete="new-password" value={f.api_private_key} onChange={(e) => set('api_private_key', e.target.value.trim())} className="font-mono" maxLength={200} />
                  </F>
                </div>
              )}
            </div>
          </FormCard>

          <FormCard title="Monitoring scope" icon="layers">
            <div className="grid gap-2 sm:grid-cols-2">
              {SCOPES.map((s) => (
                <label key={s.id} className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border p-2.5 hover:bg-sunken">
                  <input type="checkbox" className="mt-0.5" checked={f.monitoring_scope.includes(s.id)}
                    onChange={(e) => set('monitoring_scope', e.target.checked ? [...f.monitoring_scope, s.id] : f.monitoring_scope.filter((x) => x !== s.id))} />
                  <span>
                    <span className="block text-[13px] font-semibold text-fg">{s.label}</span>
                    <span className="block text-[11px] text-subtle">Needs: {s.needs}</span>
                  </span>
                </label>
              ))}
            </div>
          </FormCard>
        </div>

        <aside className="space-y-gutter">
          <TestResult result={result} pending={test.isPending || save.isPending} tested={tested} />
          <FormCard title="Permissions to grant" icon="shield">
            <ul className="space-y-2.5 text-[12px] leading-snug text-muted">
              <li><b className="text-fg">Database user</b> — built-in role <code className="rounded bg-sunken px-1">clusterMonitor</code> plus <code className="rounded bg-sunken px-1">readAnyDatabase</code> (read-only). ActMon never writes data.</li>
              <li><b className="text-fg">API key</b> — <code className="rounded bg-sunken px-1">Project Read Only</code>. <code className="rounded bg-sunken px-1">Project Owner</code> is only needed to acknowledge alerts from ActMon.</li>
              <li><b className="text-fg">Network</b> — add the ActMon server's IP to the cluster's <i>IP Access List</i> and to the API key's access list.</li>
              <li><b className="text-fg">Secrets</b> — stored encrypted on the ActMon server; never sent back to the browser.</li>
            </ul>
          </FormCard>
        </aside>
      </div>
    </>
  );
}

function FormCard({ title, icon, children }) {
  return (
    <section className="card p-card">
      <h2 className="mb-4 flex items-center gap-2 text-[15px] font-bold text-fg"><Icon name={icon} size={15} className="text-accent" />{title}</h2>
      {children}
    </section>
  );
}

function F({ label, hint, error, required, children }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[12px] font-semibold text-fg">{label}{required && <span className="text-danger-fg"> *</span>}</span>
      {children}
      {error ? <span className="mt-1 block text-[11px] font-semibold text-danger-fg">{error}</span>
        : hint ? <span className="mt-1 block text-[11px] text-subtle">{hint}</span> : null}
    </label>
  );
}

const KIND_TITLE = {
  auth: 'Authentication failed', network: 'Network / access list', config: 'Configuration error',
  permission: 'Permission denied', error: 'Connection failed',
};

function TestResult({ result, pending, tested }) {
  if (pending) return <div className="card p-card text-[13px] text-muted"><Icon name="refresh" size={14} className="mr-2 inline animate-spin" />Testing against Atlas… (up to 20 s)</div>;
  if (!result) {
    return (
      <div className="card p-card">
        <p className="text-[13px] font-bold text-fg">Test before saving</p>
        <p className="mt-1 text-[12px] text-muted">A connection is saved only after it connects. The test runs from the ActMon server, not your browser.</p>
      </div>
    );
  }
  const rows = Object.entries(result.results || {});
  return (
    <div className={cn('card border-2 p-card', tested ? 'border-success' : 'border-danger')}>
      <p className={cn('flex items-center gap-2 text-[14px] font-bold', tested ? 'text-success-fg' : 'text-danger-fg')}>
        <Icon name={tested ? 'check' : 'alert'} size={15} />{tested ? 'Connected — ready to save' : 'Test failed'}
      </p>
      {result.message && <p className="mt-2 text-[12px] text-muted">{result.message}</p>}
      <ul className="mt-3 space-y-2">
        {rows.map(([k, r]) => (
          <li key={k} className="rounded-lg bg-sunken p-2.5 text-[12px]">
            <span className="flex items-center justify-between font-bold text-fg">
              {k === 'database' ? 'Cluster (database access)' : 'Atlas Admin API'}
              <span className={r.ok ? 'text-success-fg' : 'text-danger-fg'}>{r.ok ? 'OK' : KIND_TITLE[r.kind] || 'Failed'}</span>
            </span>
            {r.ok ? (
              <span className="mt-1 block text-muted">
                {k === 'database'
                  ? `MongoDB ${r.version}${r.set_name ? ` · replica set ${r.set_name}` : ''} · ${r.latency_ms} ms`
                  : `Project “${r.project_name}”${r.cluster_count != null ? ` · ${r.cluster_count} cluster(s)` : ''}`}
              </span>
            ) : <span className="mt-1 block text-danger-fg">{r.message}{r.host && <span className="mt-1 block font-mono text-[11px] text-muted">URI host: {r.host}</span>}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
