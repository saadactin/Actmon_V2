import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { errorText } from '@/api/client';
import {
  getConnectionDetails, testConnection, updateConnection,
} from '@/api/connections';
import PageHeader from '@/components/layout/PageHeader';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import Notice from '@/components/ui/Notice';
import Select from '@/components/ui/Select';
import { PageLoading } from '@/components/ui/Loading';
import { Panel } from '@/pages/_shared/enginePanels';
import { engineMeta } from '@/config/engines';
import {
  COSMOS_CONNECTION_FIELDS, COSMOS_CONNECTION_FIELD_LIST, connectionToForm, formToPayload,
} from '@/config/cosmosCatalog';

/**
 * Edit a Cosmos DB connection.
 *
 * The form is rendered from `COSMOS_CONNECTION_FIELDS`, so the fields, their
 * grouping, their hints and the name each one sends are defined once in the
 * catalogue. Nothing about a field is decided here.
 *
 * The one behaviour worth stating on screen: the API never returns a saved key, so
 * both key boxes load blank and a blank box means "keep what is stored". Sending
 * `""` would wipe the key, which is why `formToPayload` omits empty optionals
 * rather than passing them through.
 */
export default function CosmosDBEditConnectionPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const [form, setForm] = useState(null);
  const [errors, setErrors] = useState({});
  const [result, setResult] = useState(null);

  const engine = engineMeta('cosmosdb');
  const backTo = `/cosmosdb-dashboard/${id}`;

  const connQ = useQuery({
    queryKey: ['cosmosConnection', id],
    queryFn: () => getConnectionDetails('cosmosdb', id),
    retry: false,
  });

  useEffect(() => {
    if (connQ.data?.data && !form) setForm(connectionToForm(connQ.data.data));
  }, [connQ.data, form]);

  const set = (name, value) => {
    setForm((f) => ({ ...f, [name]: value }));
    setErrors((e) => (e[name] ? { ...e, [name]: undefined } : e));
    setResult(null);
  };

  /* Required-field check here rather than only on the server, so the operator is
     not told "endpoint required" by a round trip they had to wait for. */
  const validate = () => {
    const next = {};
    COSMOS_CONNECTION_FIELD_LIST.forEach((f) => {
      if (f.required && !String(form[f.name] ?? '').trim()) next[f.name] = 'Required';
    });
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const test = useMutation({
    /* Tests the values in the boxes, not the saved row — that is the point of a
       test button on an edit form. A blank key means the saved one is in use, and
       the inline test endpoint cannot read it, so that case is called out. */
    mutationFn: () => testConnection('CosmosDB', {
      endpoint: form.endpoint,
      primary_key: form.primary_key,
      database_name: form.database_name,
      container_name: form.container_name,
      connection_timeout_sec: form.connection_timeout_sec
        ? Number(form.connection_timeout_sec)
        : undefined,
    }),
    onSuccess: (r) => setResult({
      tone: 'success',
      title: r?.message || 'Connection successful.',
      body: form.primary_key
        ? 'Tested with the key you just typed. Save to store it.'
        : undefined,
    }),
    onError: (e) => setResult({
      tone: 'danger',
      title: 'Connection failed.',
      body: errorText(e),
    }),
  });

  const save = useMutation({
    mutationFn: () => updateConnection('cosmosdb', id, formToPayload(form)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['cosmosConnection', id] });
      qc.invalidateQueries({ queryKey: ['cosmosdbConnections'] });
      /* The catalogue queries key off the connection's database/container, so a
         changed default must not leave stale lists behind. */
      qc.invalidateQueries({ queryKey: ['cosmosDatabases', id] });
      setResult({ tone: 'success', title: 'Saved.' });
      navigate(backTo);
    },
    onError: (e) => setResult({
      tone: 'danger',
      title: 'Could not save.',
      body: errorText(e),
    }),
  });

  const header = (
    <PageHeader
      title="Edit Cosmos DB connection"
      description={connQ.data?.data?.connection_name}
      backTo={backTo}
      leading={(
        <span
          className="grid h-10 w-10 shrink-0 place-items-center rounded-md text-[20px]"
          style={{ background: `color-mix(in srgb, ${engine.color} 16%, transparent)` }}
        >
          {engine.emoji}
        </span>
      )}
      actions={(
        <>
          <Button variant="secondary" icon="plug" loading={test.isPending} onClick={() => test.mutate()}>
            Test
          </Button>
          <Button
            variant="primary"
            icon="save"
            loading={save.isPending}
            onClick={() => { if (validate()) save.mutate(); }}
          >
            Save changes
          </Button>
        </>
      )}
    />
  );

  if (connQ.isLoading || !form) {
    return (
      <>
        {header}
        {connQ.isError ? (
          <Notice tone="danger" title="Could not load the connection.">
            {errorText(connQ.error)}
          </Notice>
        ) : (
          <PageLoading title="Loading connection…" />
        )}
      </>
    );
  }

  return (
    <>
      {header}

      {result && (
        <Notice tone={result.tone} title={result.title}>{result.body}</Notice>
      )}
      {Object.keys(errors).length > 0 && (
        <Notice tone="danger" title="Some required fields are empty.">
          Every field marked with a dot must have a value.
        </Notice>
      )}

      <div className="space-y-gutter">
        {COSMOS_CONNECTION_FIELDS.map((group) => (
          <Panel key={group.group} title={group.group} subtitle={group.note}>
            <div className="grid gap-gutter-sm sm:grid-cols-2">
              {group.fields.map((f) => (
                <FormField
                  key={f.name}
                  field={f}
                  value={form[f.name]}
                  error={errors[f.name]}
                  onChange={(v) => set(f.name, v)}
                  className={f.full || f.kind === 'textarea' ? 'sm:col-span-2' : undefined}
                />
              ))}
            </div>
          </Panel>
        ))}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            icon="save"
            loading={save.isPending}
            onClick={() => { if (validate()) save.mutate(); }}
          >
            Save changes
          </Button>
          <Button variant="secondary" icon="plug" loading={test.isPending} onClick={() => test.mutate()}>
            Test connection
          </Button>
          <Button variant="ghost" onClick={() => navigate(backTo)}>Cancel</Button>
        </div>
      </div>
    </>
  );
}

/** One field from the spec. Every control here is the app's own, not a bare input. */
function FormField({ field, value, error, onChange, className }) {
  const control = (() => {
    if (field.kind === 'select') {
      return (
        <Select
          value={value ?? ''}
          onChange={onChange}
          options={field.options}
          size="sm"
        />
      );
    }
    if (field.kind === 'textarea') {
      return (
        <textarea
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value)}
          rows={2}
          placeholder={field.placeholder}
          spellCheck={false}
          className={`w-full rounded-control border bg-surface px-2.5 py-2 text-[13px] text-fg
            transition-colors placeholder:text-subtle hover:border-strong
            ${field.mono ? 'font-mono text-[12px]' : ''}
            ${error ? 'border-danger' : 'border-border'}`}
        />
      );
    }
    return (
      <Input
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        type={field.kind === 'password' ? 'password' : field.kind === 'number' ? 'number' : 'text'}
        placeholder={field.placeholder}
        size="sm"
        className={error ? 'border-danger' : undefined}
        autoComplete={field.kind === 'password' ? 'new-password' : 'off'}
      />
    );
  })();

  return (
    <div className={className}>
      <label className="mb-1 flex items-center gap-1.5 text-[12px] font-semibold text-fg">
        {field.label}
        {field.required && (
          <span className="h-1 w-1 rounded-full bg-danger" aria-label="required" title="Required" />
        )}
        {field.secret && <Badge tone="outline" size="xs">encrypted</Badge>}
      </label>
      {control}
      {error
        ? <p className="mt-0.5 text-[11px] text-danger-fg">{error}</p>
        : field.hint && <p className="mt-0.5 text-[11px] leading-snug text-subtle">{field.hint}</p>}
    </div>
  );
}
