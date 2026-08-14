import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { errorText } from '@/api/client';
import { createConnection, testConnection } from '@/api/connections';
import PageHeader from '@/components/layout/PageHeader';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Icon from '@/components/ui/Icon';
import Notice from '@/components/ui/Notice';
import { Panel } from '@/pages/_shared/enginePanels';
import { engineMeta } from '@/config/engines';
import { DATABASE_SERVICES, TECH_ROUTE } from '@/config/servers';
import ConnectionFieldsForm from '@/components/connections/ConnectionFieldsForm';
import {
  defaultsForEngine, requiredFieldsForEngine, toConnectionPayload,
} from '@/config/connectionFieldCatalog';

/**
 * Add a database connection — the page `DatabaseServersPage` (and, per plan,
 * Add OS Server's Database Services step) links to as
 * `/connections/add?type=postgresql&host=...&port=...&name=...`.
 *
 * `type` decides which of the 7 supported technologies to render immediately;
 * `host`/`port`/`name` (a suggested connection name) pre-fill the form when
 * given. With no recognised `type`, the same technology picker Add OS Server
 * uses (`DATABASE_SERVICES`) is shown instead of a blank/not-found page — one
 * click reaches the exact same form.
 *
 * Every field, per-engine extra, and submission shape is driven by
 * `connectionFieldCatalog.js` — this page only wires it to the existing
 * `createConnection`/`testConnection` API calls, both already live.
 */

/** Resolve a `type` query param (either a pill name like "MariaDB" or the
 * canonical engine key like "postgresql") to its DATABASE_SERVICES pill. */
function resolvePill(typeParam) {
  if (!typeParam) return null;
  const t = typeParam.toLowerCase().trim();
  return DATABASE_SERVICES.find(
    (d) => d.name.toLowerCase() === t || TECH_ROUTE[d.name]?.toLowerCase() === t,
  ) || null;
}

export default function AddConnectionPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const preType = searchParams.get('type');
  const preHost = searchParams.get('host');
  const prePort = searchParams.get('port');
  const preName = searchParams.get('name');

  const [pill, setPill] = useState(() => resolvePill(preType));
  const [form, setForm] = useState(null);
  const [errors, setErrors] = useState({});
  const [result, setResult] = useState(null);

  const engineKey = pill ? TECH_ROUTE[pill.name] : null;
  const meta = engineKey ? engineMeta(engineKey) : null;

  // Seed the form the moment a technology is known — from the URL on first
  // load, or the instant the picker below is clicked.
  useEffect(() => {
    if (!engineKey || form) return;
    const defaults = defaultsForEngine(engineKey, meta?.port);
    setForm({
      ...defaults,
      host: preHost || defaults.host,
      port: prePort || defaults.port,
      connection_name: preName || defaults.connection_name,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engineKey]);

  const selectPill = (d) => {
    setPill(d);
    setForm(null); // re-seeded by the effect above once engineKey changes
    setErrors({});
    setResult(null);
  };

  const changeTechnology = () => {
    setPill(null);
    setForm(null);
    setErrors({});
    setResult(null);
  };

  const set = (next) => {
    setForm(next);
    setResult(null);
  };

  const validate = () => {
    const next = {};
    requiredFieldsForEngine(engineKey).forEach((name) => {
      if (!String(form[name] ?? '').trim()) next[name] = 'Required';
    });
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const test = useMutation({
    mutationFn: () => testConnection(engineKey, toConnectionPayload(engineKey, form)),
    onSuccess: (r) => setResult({ tone: 'success', title: r?.message || 'Connection successful.' }),
    onError: (e) => setResult({ tone: 'danger', title: 'Connection failed.', body: errorText(e) }),
  });

  const save = useMutation({
    mutationFn: () => createConnection(
      engineKey,
      toConnectionPayload(engineKey, form, `${meta.name}-${form.host || 'connection'}`),
    ),
    onSuccess: () => {
      setResult({ tone: 'success', title: 'Connection saved.' });
      setTimeout(() => navigate(`/${engineKey}-servers`), 900);
    },
    onError: (e) => setResult({ tone: 'danger', title: 'Could not save connection.', body: errorText(e) }),
  });

  const runTest = () => { if (validate()) test.mutate(); };
  const runSave = () => { if (validate()) save.mutate(); };

  const header = (
    <PageHeader
      title={pill ? `Add ${meta.name} Connection` : 'Add Database Connection'}
      description={pill
        ? `Connect ActMon to a ${meta.name} instance for monitoring`
        : 'Choose a database technology to connect'}
      icon="database"
      backTo="/databases"
      actions={pill && (
        <Button variant="ghost" icon="refresh" onClick={changeTechnology}>Change technology</Button>
      )}
    />
  );

  if (!pill || !form) {
    return (
      <>
        {header}
        <Panel title="Database Technology" icon="database" subtitle="Which database are you connecting to?">
          <div className="flex flex-wrap gap-2">
            {DATABASE_SERVICES.map((d) => {
              const key = TECH_ROUTE[d.name];
              const m = engineMeta(key);
              return (
                <button
                  key={d.name}
                  type="button"
                  onClick={() => selectPill(d)}
                  className="flex h-control items-center gap-1.5 rounded-control border border-border px-3 text-[13px] font-semibold text-fg transition-colors hover:border-strong hover:bg-sunken"
                >
                  <span aria-hidden="true">{m.emoji}</span>
                  {d.name}
                </button>
              );
            })}
          </div>
        </Panel>
      </>
    );
  }

  return (
    <>
      {header}
      <Panel
        title={`${meta.name} Connection Details`}
        icon="database"
        subtitle={`Default port ${meta.port} — override below if this instance uses a different one`}
      >
        <ConnectionFieldsForm engine={engineKey} value={form} onChange={set} errors={errors} />

        {result && (
          <Notice tone={result.tone} title={result.title} className="mt-gutter">
            {result.body}
          </Notice>
        )}

        <div className="mt-gutter flex flex-wrap items-center gap-2">
          <Button variant="primary" icon="check" loading={save.isPending} onClick={runSave}>
            Save Connection
          </Button>
          <Button variant="secondary" icon="plug" loading={test.isPending} onClick={runTest}>
            Test Connection
          </Button>
          <Button variant="ghost" onClick={() => navigate('/databases')}>Cancel</Button>
          <Badge tone="accent" size="xs" className="ml-auto">
            <Icon name="database" size={10} />
            {meta.name}
          </Badge>
        </div>
      </Panel>
    </>
  );
}
