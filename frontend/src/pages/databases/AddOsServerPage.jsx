import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import cn from '@/lib/cn';
import PageHeader from '@/components/layout/PageHeader';
import Icon from '@/components/ui/Icon';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import Switch from '@/components/ui/Switch';
import Badge from '@/components/ui/Badge';
import Steps from '@/components/ui/Steps';
import { createOsServer, getOsServer, linkDbInstance, listOsServers, testSshConnection } from '@/api/servers';
import { createConnection, testConnection } from '@/api/connections';
import {
  AGENT_STEPS, DATABASE_SERVICES, ENVIRONMENTS, NODE_TYPES, OPERATING_SYSTEMS,
  SERVER_FORM_DEFAULTS, SSH_STEPS, TECH_ROUTE, serviceColor, toServerPayload,
} from '@/config/servers';
import { engineMeta } from '@/config/engines';
import ConnectionFieldsForm from '@/components/connections/ConnectionFieldsForm';
import { defaultsForEngine, requiredFieldsForEngine, toConnectionPayload } from '@/config/connectionFieldCatalog';

/**
 * Add OS Server.
 *
 * The FLOW is the existing one, unchanged: pick a connection method, then either
 *   • Agent → hand off to the Add Data catalogue (/databases/add-data), which is
 *     the ported agent module. Nothing is registered here; that path is untouched.
 *   • SSH  → Operating System · Server Identity · SSH Access · Node Role ·
 *            Services · Review, then createOsServer().
 *
 * Field names, validation, the SSH test call and the request payload are identical
 * (payload built by config/servers.js → toServerPayload). The SSH screens are
 * restyled onto the token design system; the agent card keeps its original copy.
 */
export default function AddOsServerPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();

  const [step, setStep] = useState(0);
  const [selectedOs, setSelectedOs] = useState('Linux');
  const [selectedDbs, setSelectedDbs] = useState([]);
  const [testing, setTesting] = useState(false);
  const [sshTested, setSshTested] = useState(false);
  const [message, setMessage] = useState(null);
  const [showPass, setShowPass] = useState(false);
  const [collector, setCollector] = useState('ssh'); // 'ssh' | 'agent'

  /* ── server registration + per-engine connection sequencing ──────────────
     The server is created once, right as Services hands off to Add
     Connection — not at the very end — so each connection created after this
     point can be linked to a real server/instance immediately, the same way
     it would be if added later from the Database hub. Nothing here is a new
     backend concept: createOsServer, getOsServer, createConnection and
     linkDbInstance all already exist and are unchanged. */
  const [serverId, setServerId] = useState(null);
  const [dbInstances, setDbInstances] = useState([]); // [{id, db_type, ...}] from getOsServer
  const [registering, setRegistering] = useState(false);
  const [connIdx, setConnIdx] = useState(0); // index into selectedDbs for the current connection form
  const [connForms, setConnForms] = useState({}); // { [dbName]: fieldValues }
  const [connErrors, setConnErrors] = useState({});
  const [connTestResult, setConnTestResult] = useState(null);
  const [connSaving, setConnSaving] = useState(false);
  const [connResults, setConnResults] = useState({}); // { [dbName]: {status:'saved'|'skipped', connectionId?} }

  const { register, getValues, setValue, watch, formState: { errors } } = useForm({
    defaultValues: SERVER_FORM_DEFAULTS,
  });

  const nodeType = watch('node_type');
  const watchCluster = watch('cluster_name');
  const wName = watch('server_name');
  const wIp = watch('ip_address');
  const wSsh = watch('ssh_username');

  const { data: serversData } = useQuery({
    queryKey: ['osServers'], queryFn: () => listOsServers(), staleTime: 30000,
  });
  const existingClusters = [
    ...new Set((serversData?.data || serversData || []).map((s) => s.cluster_name).filter(Boolean)),
  ];

  const toggleDb = (db) => setSelectedDbs((prev) =>
    (prev.includes(db) ? prev.filter((d) => d !== db) : [...prev, db]));

  const steps = collector === 'agent' ? AGENT_STEPS : SSH_STEPS;
  const cur = Math.min(step, steps.length - 1);
  const name = steps[cur];
  const isLast = cur === steps.length - 1;

  /* Same gates as the existing page. */
  const canNext = () => {
    if (name === 'Server Identity') return !!(wName?.trim() && wIp?.trim());
    if (name === 'SSH Access') return !!wSsh?.trim();
    if (name === 'Node Role') return nodeType === 'Standalone' ? true : !!watchCluster?.trim();
    return true;
  };

  const handleTestSsh = async () => {
    const v = getValues();
    if (!v.ip_address || !v.ssh_username) {
      setMessage({ type: 'error', text: 'Fill in Host IP and SSH Username first.' });
      return;
    }
    setTesting(true); setMessage(null); setSshTested(false);
    try {
      const res = await testSshConnection({
        ip_address: v.ip_address,
        ssh_port: Number(v.ssh_port) || 22,
        ssh_username: v.ssh_username,
        ssh_password: v.ssh_password || '',
      });
      setMessage({ type: 'success', text: `SSH connected — ${res.message}` });
      setSshTested(true);
    } catch (err) {
      setMessage({ type: 'error', text: err?.message || 'SSH test failed' });
    } finally {
      setTesting(false);
    }
  };

  /* Registers the server the moment Services hands off — not at the very end
     — so every connection added afterward has a real server to attach to,
     the same way linking one later from the Database hub already works. */
  const registerServer = async () => {
    const data = getValues();
    setRegistering(true); setMessage(null);
    try {
      const res = await createOsServer(toServerPayload({ data, selectedOs, selectedDbs, collector }));
      const newId = res?.data?.id ?? res?.id;
      setServerId(newId);
      qc.invalidateQueries({ queryKey: ['osServers'] });
      qc.invalidateQueries({ queryKey: ['serverSummary'] });

      if (selectedDbs.length > 0) {
        const detail = await getOsServer(newId);
        setDbInstances(detail?.data?.db_instances || detail?.db_instances || []);
        setConnIdx(0);
        setStep(cur + 1); // Services → Add Connection
      } else {
        setStep(cur + 2); // nothing to connect — straight to Review
      }
      return true;
    } catch (err) {
      setMessage({ type: 'error', text: err?.message || 'Failed to register server' });
      return false;
    } finally {
      setRegistering(false);
    }
  };

  /* ── the current engine in the Add Connection sequence ───────────────── */
  const currentDbName = selectedDbs[connIdx];
  const currentEngineKey = currentDbName ? TECH_ROUTE[currentDbName] : null;
  const currentMeta = currentEngineKey ? engineMeta(currentEngineKey) : null;
  const currentForm = currentDbName ? connForms[currentDbName] : null;

  // Seed each engine's form the first time its turn comes up — host from the
  // server just registered, port from that engine's own default, a suggested
  // name. Only ever runs once per engine (guarded by the form not existing
  // yet), so it never clobbers what the user has already typed.
  useEffect(() => {
    if (!currentDbName || connForms[currentDbName]) return;
    setConnForms((f) => ({
      ...f,
      [currentDbName]: {
        ...defaultsForEngine(currentEngineKey, currentMeta?.port),
        host: wIp || '',
        connection_name: `${wName || 'server'}-${currentEngineKey}`,
      },
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentDbName]);

  const setCurrentForm = (next) => {
    setConnForms((f) => ({ ...f, [currentDbName]: next }));
    setConnTestResult(null);
  };

  const advanceConnection = () => {
    setConnTestResult(null); setConnErrors({});
    if (connIdx + 1 < selectedDbs.length) {
      setConnIdx((i) => i + 1);
    } else {
      setStep(cur + 1); // Add Connection → Review
    }
  };

  const validateCurrentConn = () => {
    const next = {};
    requiredFieldsForEngine(currentEngineKey).forEach((f) => {
      if (!String(currentForm?.[f] ?? '').trim()) next[f] = 'Required';
    });
    setConnErrors(next);
    return Object.keys(next).length === 0;
  };

  const testCurrentConnection = async () => {
    if (!validateCurrentConn()) return;
    setConnTestResult({ tone: 'info', title: 'Testing…' });
    try {
      const r = await testConnection(currentEngineKey, toConnectionPayload(currentEngineKey, currentForm));
      setConnTestResult({ tone: 'success', title: r?.message || 'Connection successful.' });
    } catch (err) {
      setConnTestResult({ tone: 'danger', title: 'Connection failed.', body: err?.message });
    }
  };

  const saveCurrentConnection = async () => {
    if (!validateCurrentConn()) return;
    setConnSaving(true);
    try {
      const fallbackName = `${wName || 'server'}-${currentEngineKey}`;
      const res = await createConnection(currentEngineKey, toConnectionPayload(currentEngineKey, currentForm, fallbackName));
      const connectionId = res?.data?.id ?? res?.id;
      const instance = dbInstances.find((i) => i.db_type === currentDbName);
      if (instance?.id && connectionId) {
        await linkDbInstance(serverId, instance.id, connectionId);
      }
      setConnResults((r) => ({ ...r, [currentDbName]: { status: 'saved', connectionId } }));
      advanceConnection();
    } catch (err) {
      setConnTestResult({ tone: 'danger', title: 'Could not save connection.', body: err?.message });
    } finally {
      setConnSaving(false);
    }
  };

  const skipCurrentConnection = () => {
    setConnResults((r) => ({ ...r, [currentDbName]: { status: 'skipped' } }));
    advanceConnection();
  };

  const finish = () => {
    const firstSaved = selectedDbs.find((d) => connResults[d]?.status === 'saved');
    const techSlug = firstSaved ? TECH_ROUTE[firstSaved] : null;
    navigate(techSlug ? `/${techSlug}-servers` : '/databases');
  };

  /* ── steps ──────────────────────────────────────────────────────────────── */

  const connectionStep = (
    <StepBody
      title="Connection Method"
      hint="How ActMon collects data from this server — both give the identical monitoring UI."
    >
      <div className="grid gap-gutter sm:grid-cols-2">
        <ChoiceCard
          selected={collector === 'ssh'}
          onClick={() => setCollector('ssh')}
          icon="terminal"
          tone="success"
          title="Connect via SSH"
          body="ActMon polls the host over SSH. No install — just credentials."
        />
        <ChoiceCard
          selected={collector === 'agent'}
          onClick={() => setCollector('agent')}
          icon="boxes"
          tone="info"
          title="Connect via Agent"
          body="Install a lightweight agent that pushes the same metrics — ideal when SSH isn't reachable."
        />
      </div>

      {collector === 'agent' && (
        <p className="mt-gutter flex items-start gap-2 rounded-control bg-info-soft px-3 py-2.5 text-[12px] leading-relaxed text-info-fg">
          <Icon name="info" size={14} className="mt-px shrink-0" />
          <span>
            Continue to pick the technology and generate the install command. The host appears
            here as soon as the agent reports.
          </span>
        </p>
      )}
    </StepBody>
  );

  const osStep = (
    <StepBody title="Operating System" hint="Select the OS running on this server.">
      <div className="grid grid-cols-2 gap-gutter-sm sm:grid-cols-3 lg:grid-cols-6">
        {OPERATING_SYSTEMS.map((os) => {
          const on = selectedOs === os.name;
          return (
            <button
              key={os.name}
              type="button"
              onClick={() => setSelectedOs(os.name)}
              aria-pressed={on}
              className={cn(
                'relative flex h-[104px] flex-col items-center justify-center gap-2 rounded-lg border transition-colors',
                on ? 'border-accent-border bg-accent-soft' : 'border-border hover:border-strong hover:bg-raised',
              )}
            >
              <span className="text-4xl leading-none">{os.icon}</span>
              <span className={cn('text-[13px] font-semibold', on ? 'text-accent-text' : 'text-muted')}>
                {os.name}
              </span>
              {on && (
                <span className="absolute top-2 right-2 grid h-5 w-5 place-items-center rounded-full bg-accent text-accent-fg">
                  <Icon name="check" size={11} strokeWidth={3} />
                </span>
              )}
            </button>
          );
        })}
      </div>
    </StepBody>
  );

  const identityStep = (
    <StepBody title="Server Identity" hint="Name and network details.">
      <div className="grid gap-gutter sm:grid-cols-2">
        <Field label="Server Name" required error={errors.server_name?.message}>
          <Input
            icon="server"
            placeholder="DB-OS-PROD-01"
            {...register('server_name', { required: 'Server name is required' })}
          />
        </Field>
        <Field label="Host IP Address" required error={errors.ip_address?.message}>
          <Input
            icon="globe"
            placeholder="192.168.1.10"
            {...register('ip_address', { required: 'IP address is required' })}
          />
        </Field>
        <Field label="Hostname (FQDN)">
          <Input icon="link" placeholder="db-01.company.local" {...register('hostname')} />
        </Field>
        <Field label="Environment">
          <div className="flex flex-wrap gap-1.5">
            {ENVIRONMENTS.map((env) => {
              const on = watch('environment') === env;
              return (
                <button
                  key={env}
                  type="button"
                  onClick={() => setValue('environment', env)}
                  aria-pressed={on}
                  className={cn(
                    'h-control rounded-control border px-3 text-[13px] font-semibold transition-colors',
                    on ? 'border-accent bg-accent text-accent-fg'
                      : 'border-border text-muted hover:border-strong hover:text-fg',
                  )}
                >
                  {env}
                </button>
              );
            })}
          </div>
        </Field>
      </div>
    </StepBody>
  );

  const sshStep = (
    <StepBody title="SSH Access" hint="Credentials for live OS metric collection.">
      <div className="grid gap-gutter sm:grid-cols-2">
        <Field label="SSH Username" required error={errors.ssh_username?.message}>
          <Input icon="key" placeholder="root" {...register('ssh_username', { required: 'SSH username is required' })} />
        </Field>
        <Field label="SSH Port" required>
          <Input icon="plug" type="number" {...register('ssh_port')} />
        </Field>
        <Field label="SSH Password" className="sm:col-span-2">
          <div className="relative">
            <Input
              icon="key"
              type={showPass ? 'text' : 'password'}
              placeholder="••••••••••"
              className="pr-9"
              {...register('ssh_password')}
            />
            <button
              type="button"
              onClick={() => setShowPass((v) => !v)}
              aria-label={showPass ? 'Hide password' : 'Show password'}
              className="absolute top-1/2 right-2 -translate-y-1/2 text-subtle transition-colors hover:text-fg"
            >
              <Icon name="eye" size={15} />
            </button>
          </div>
        </Field>
      </div>

      <div className="mt-gutter flex flex-wrap items-center gap-3">
        <Button
          variant={sshTested ? 'secondary' : 'secondary'}
          icon={testing ? undefined : sshTested ? 'check' : 'terminal'}
          loading={testing}
          onClick={handleTestSsh}
          className={sshTested ? 'border-success text-success-fg' : undefined}
        >
          {testing ? 'Connecting…' : sshTested ? 'SSH Connected' : 'Test SSH Connection'}
        </Button>
        <p className="text-[12px] text-subtle">Verify credentials before continuing.</p>
      </div>

      {message && <MessageBox message={message} />}
    </StepBody>
  );

  const nodeStep = (
    <StepBody title="Node Role" hint="Define this server's role in your topology.">
      <div className="grid grid-cols-2 gap-gutter-sm lg:grid-cols-4">
        {NODE_TYPES.map((nt) => {
          const on = nodeType === nt.value;
          return (
            <button
              key={nt.value}
              type="button"
              onClick={() => setValue('node_type', nt.value)}
              aria-pressed={on}
              className={cn(
                'rounded-lg border p-3 text-left transition-colors',
                on ? 'border-accent-border bg-accent-soft' : 'border-border hover:border-strong hover:bg-raised',
              )}
            >
              <span className="mb-1 flex items-center gap-2">
                <span className="text-lg leading-none" style={{ color: TONE_COLORS[nt.tone] }}>{nt.icon}</span>
                <span className={cn(
                  'truncate-safe text-[11px] font-bold tracking-wide uppercase',
                  on ? 'text-accent-text' : 'text-fg',
                )}>
                  {nt.label}
                </span>
                {on && <Icon name="check" size={12} className="ml-auto shrink-0 text-accent-text" strokeWidth={3} />}
              </span>
              <span className="block text-[11px] leading-snug text-subtle">{nt.desc}</span>
            </button>
          );
        })}
      </div>

      {nodeType !== 'Standalone' && (
        <div className="mt-gutter max-w-xl rounded-lg border border-border bg-raised p-card">
          <Field label="Cluster Name" required error={errors.cluster_name?.message}>
            {existingClusters.length > 0 && (
              <div className="mb-2.5">
                <p className="mb-1.5 flex items-center gap-1 text-[10px] font-bold tracking-wide text-subtle uppercase">
                  <Icon name="history" size={11} /> Join existing cluster
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {existingClusters.map((cl) => {
                    const on = watchCluster === cl;
                    return (
                      <button
                        key={cl}
                        type="button"
                        onClick={() => setValue('cluster_name', cl)}
                        className={cn(
                          'h-control-sm rounded-control border px-2.5 text-[12px] font-semibold transition-colors',
                          on ? 'border-accent bg-accent text-accent-fg'
                            : 'border-border text-muted hover:border-strong hover:text-fg',
                        )}
                      >
                        {cl}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            <Input
              icon="layers"
              list="cluster-datalist"
              placeholder={existingClusters.length ? 'Or enter a new cluster name…' : 'PROD-MYSQL-CLUSTER-01'}
              {...register('cluster_name')}
            />
            <datalist id="cluster-datalist">
              {existingClusters.map((cl) => <option key={cl} value={cl} />)}
            </datalist>
          </Field>
        </div>
      )}
    </StepBody>
  );

  const servicesStep = (
    <StepBody title="Database Services" hint="Which databases are running on this server?">
      <div className="flex flex-wrap gap-2">
        {DATABASE_SERVICES.map((db) => {
          const on = selectedDbs.includes(db.name);
          const colour = serviceColor(db.name);
          return (
            <button
              key={db.name}
              type="button"
              onClick={() => toggleDb(db.name)}
              aria-pressed={on}
              className="flex h-control items-center gap-1.5 rounded-control border px-3 text-[13px] font-semibold transition-colors"
              style={on
                ? { background: colour, borderColor: colour, color: '#fff' }
                : {
                  background: `color-mix(in srgb, ${colour} 12%, transparent)`,
                  borderColor: `color-mix(in srgb, ${colour} 34%, transparent)`,
                  color: colour,
                }}
            >
              {on && <Icon name="check" size={12} strokeWidth={3} />}
              {db.name}
            </button>
          );
        })}
      </div>
      {selectedDbs.length === 0 && (
        <p className="mt-2 text-[12px] text-subtle">
          Select at least one database service for auto-discovery.
        </p>
      )}

      <h4 className="mt-gutter-lg text-[15px] font-bold text-fg">Monitoring Options</h4>
      <div className="mt-gutter-sm grid gap-gutter sm:grid-cols-2">
        <ToggleField
          label="Live Monitoring" description="Collect CPU, RAM, Disk metrics"
          checked={watch('monitoring_enabled')} onChange={(v) => setValue('monitoring_enabled', v)}
        />
        <ToggleField
          label="Auto Discovery" description="Detect installed DB services automatically"
          checked={watch('auto_discovery')} onChange={(v) => setValue('auto_discovery', v)}
        />
      </div>
      {message && <MessageBox message={message} />}
    </StepBody>
  );

  /* The server is already registered by the time this step is reached (see
     registerServer) — this walks through one connection form per selected
     engine, pre-filled from the server's own host, saving each independently
     via the same createConnection() a standalone "Add Connection" page uses,
     then linking it to this server's matching DatabaseInstance row. */
  const addConnectionStep = currentDbName ? (
    <StepBody
      title={`Add Connection — ${currentMeta.name}`}
      hint={`${connIdx + 1} of ${selectedDbs.length} — connect ActMon to this ${currentMeta.name} instance`}
    >
      <ConnectionFieldsForm
        engine={currentEngineKey}
        value={currentForm || {}}
        onChange={setCurrentForm}
        errors={connErrors}
      />
      {connTestResult && (
        <div className="mt-gutter">
          <MessageBox message={{ type: connTestResult.tone === 'danger' ? 'error' : 'success', text: [connTestResult.title, connTestResult.body].filter(Boolean).join(' — ') }} />
        </div>
      )}
    </StepBody>
  ) : (
    <StepBody title="Add Connection" hint="No database services were selected — nothing to connect.">
      <p className="text-[13px] text-muted">
        You can add a connection for this server any time from the Database hub.
      </p>
    </StepBody>
  );

  const reviewStep = (
    <StepBody title="Review" hint="The server is registered — here's what was set up.">
      <dl className="max-w-2xl rounded-lg border border-border">
        <SummaryRow label="Operating System" value={selectedOs} />
        <SummaryRow label="Connection" value={collector === 'ssh' ? 'SSH' : 'Agent'} />
        <SummaryRow label="Server Name" value={wName} />
        <SummaryRow label="Host IP" value={wIp} />
        {collector === 'ssh' && <SummaryRow label="SSH User" value={wSsh} />}
        <SummaryRow label="Node Role" value={nodeType} />
        {nodeType !== 'Standalone' && <SummaryRow label="Cluster" value={watchCluster} />}
        <SummaryRow label="Environment" value={watch('environment')} last={selectedDbs.length === 0} />
        {selectedDbs.length > 0 && (
          <div className="border-t border-border px-card py-2.5">
            <span className="mb-1.5 block text-[12px] font-semibold text-subtle">Database connections</span>
            <div className="space-y-1">
              {selectedDbs.map((d) => {
                const r = connResults[d];
                return (
                  <div key={d} className="flex items-center gap-2 text-[13px]">
                    <Icon
                      name={r?.status === 'saved' ? 'check' : r?.status === 'skipped' ? 'minus' : 'alert'}
                      size={13}
                      className={r?.status === 'saved' ? 'text-success-fg' : 'text-subtle'}
                    />
                    <span className="text-fg">{d}</span>
                    <span className="text-subtle">
                      {r?.status === 'saved' ? '— connected' : r?.status === 'skipped' ? '— skipped, add later from the Database hub' : '— not configured'}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </dl>
      {message && <MessageBox message={message} />}
    </StepBody>
  );

  const body = {
    Connection: connectionStep,
    'Operating System': osStep,
    'Server Identity': identityStep,
    'SSH Access': sshStep,
    'Node Role': nodeStep,
    Services: servicesStep,
    'Add Connection': addConnectionStep,
    Review: reviewStep,
  }[name];

  return (
    <>
      <PageHeader
        title="Add OS Server"
        icon="server"
        description="Register a server for OS-level monitoring — over SSH, or with a lightweight agent"
        actions={
          <Button variant="secondary" icon="close" onClick={() => navigate('/databases')}>
            Cancel
          </Button>
        }
      />

      <div className="card overflow-hidden">
        <div className="border-b border-border px-card py-3.5">
          <Steps steps={steps} current={cur} />
        </div>

        <div className="px-card py-card">{body}</div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-raised px-card py-3">
          <span className="text-[12px] text-subtle">
            Step {cur + 1} of {steps.length}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => navigate('/databases')}>Cancel</Button>
            {/* Once the server is registered (past Services), going back can't
                un-register it or un-save a connection — Previous still lets you
                look, but within Add Connection it steps back one engine at a
                time rather than leaving the step entirely. */}
            {cur > 0 && !(name === 'Add Connection' && connIdx === 0) && (
              <Button
                variant="secondary"
                icon="arrow-left"
                onClick={() => (name === 'Add Connection' ? setConnIdx((i) => i - 1) : setStep(cur - 1))}
              >
                Previous
              </Button>
            )}
            {name === 'SSH Access' && (
              <Button variant="secondary" icon="terminal" loading={testing} onClick={handleTestSsh}>
                Test SSH
              </Button>
            )}
            {name === 'Add Connection' && currentDbName && (
              <Button variant="secondary" icon="plug" onClick={testCurrentConnection}>
                Test Connection
              </Button>
            )}

            {/* The agent path hands off to the Add Data catalogue — nothing is
                registered here. Unchanged from the existing flow. */}
            {name === 'Connection' && collector === 'agent' ? (
              <Button variant="primary" iconRight="arrow-right" onClick={() => navigate('/databases/add-data')}>
                Next
              </Button>
            ) : name === 'Services' ? (
              <Button variant="primary" icon="shield" loading={registering} onClick={registerServer}>
                {registering ? 'Registering…' : 'Register & Continue'}
              </Button>
            ) : name === 'Add Connection' ? (
              currentDbName ? (
                <>
                  <Button variant="ghost" onClick={skipCurrentConnection}>Skip for now</Button>
                  <Button variant="primary" iconRight="arrow-right" loading={connSaving} onClick={saveCurrentConnection}>
                    Save &amp; Continue
                  </Button>
                </>
              ) : (
                <Button variant="primary" iconRight="arrow-right" onClick={() => setStep(cur + 1)}>
                  Next
                </Button>
              )
            ) : !isLast ? (
              <Button
                variant="primary"
                iconRight="arrow-right"
                disabled={!canNext()}
                onClick={() => canNext() && setStep(cur + 1)}
              >
                Next
              </Button>
            ) : (
              <Button variant="primary" icon="check" onClick={finish}>
                Finish
              </Button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

/* ── pieces ─────────────────────────────────────────────────────────────── */

const TONE_COLORS = {
  neutral: 'var(--fg-muted)',
  success: 'var(--status-good)',
  info: 'var(--info)',
  warning: 'var(--status-warning)',
  accent: 'var(--accent)',
};

function StepBody({ title, hint, children }) {
  return (
    <div className="max-w-4xl">
      <h3 className="text-[16px] font-bold text-fg">{title}</h3>
      {hint && <p className="mt-1 text-[13px] text-muted">{hint}</p>}
      <div className="mt-gutter">{children}</div>
    </div>
  );
}

function ChoiceCard({ selected, onClick, icon, tone, title, body }) {
  const TONES = {
    success: 'bg-success-soft text-success-fg',
    info: 'bg-info-soft text-info-fg',
  };
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cn(
        'flex items-start gap-3 rounded-lg border p-card text-left transition-colors',
        selected ? 'border-accent-border bg-accent-soft' : 'border-border hover:border-strong hover:bg-raised',
      )}
    >
      <span className={cn('grid h-11 w-11 shrink-0 place-items-center rounded-md', TONES[tone])}>
        <Icon name={icon} size={22} />
      </span>
      <span className="min-w-0">
        <span className="flex items-center gap-1.5 text-[14px] font-bold text-fg">
          {title}
          {selected && <Icon name="check" size={14} className="text-accent-text" strokeWidth={3} />}
        </span>
        <span className="mt-1 block text-[13px] leading-relaxed text-muted">{body}</span>
      </span>
    </button>
  );
}

function Field({ label, required, error, className, children }) {
  return (
    <label className={cn('block', className)}>
      <span className="mb-1 block text-[11px] font-bold tracking-wide text-muted uppercase">
        {label}
        {required && <span className="ml-0.5 text-danger">*</span>}
      </span>
      {children}
      {error && <span className="mt-1 block text-[11px] font-medium text-danger">{error}</span>}
    </label>
  );
}

function ToggleField({ label, description, checked, onChange }) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border border-border p-card">
      <span className="min-w-0">
        <span className="block text-[13px] font-semibold text-fg">{label}</span>
        <span className="mt-0.5 block text-[11px] text-subtle">{description}</span>
      </span>
      <Switch checked={!!checked} onChange={onChange} label={label} />
    </div>
  );
}

function SummaryRow({ label, value, last }) {
  return (
    <div className={cn('flex gap-4 px-card py-2.5', !last && 'border-b border-border')}>
      <dt className="w-40 shrink-0 text-[12px] font-semibold text-subtle">{label}</dt>
      <dd className="min-w-0 text-[13px] break-all text-fg">
        {value || <span className="text-subtle">—</span>}
      </dd>
    </div>
  );
}

function MessageBox({ message }) {
  const ok = message.type === 'success';
  return (
    <p
      className={cn(
        'mt-gutter flex items-start gap-2 rounded-control px-3 py-2.5 text-[12px] font-medium',
        ok ? 'bg-success-soft text-success-fg' : 'bg-danger-soft text-danger-fg',
      )}
    >
      <Icon name={ok ? 'check' : 'alert'} size={14} className="mt-px shrink-0" />
      <span className="whitespace-pre-line">{message.text}</span>
    </p>
  );
}
