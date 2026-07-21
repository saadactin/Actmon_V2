import React, { useState } from 'react';
import { TestTube2, Loader2, CheckCircle2, XCircle, Info } from 'lucide-react';
import { testConnection } from '../../../../api/connections';
import { testDbViaAgent } from '../../../../api/agents';

const inp = 'w-full h-11 px-3.5 rounded-lg border border-slate-200 text-[15px] outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-50 bg-white';
const Field = ({ label, required, children }) => (
  <label className="block">
    <span className="block text-[13px] font-bold text-slate-500 uppercase tracking-wide mb-1.5">{label}{required && <span className="text-red-500"> *</span>}</span>
    {children}
  </label>
);

// Step 2 — connection credentials for the database.
export default function StepCredentials({ data, setData, tech }) {
  const c = data.credentials;
  const set = (k, v) => setData({ credentials: { ...c, [k]: v } });
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState(null);

  // With an existing (already-running) agent we can test THROUGH it — it connects to
  // localhost on its own host, which the backend can never reach. Otherwise (a brand-new
  // agent not yet installed) the test happens after install; fall back to the server test
  // only for a genuinely remote DB.
  const viaAgent = data.agentMode === 'existing' && !!data.agentToken;

  const runTest = async () => {
    setTesting(true); setResult(null);
    try {
      if (viaAgent) {
        const r = await testDbViaAgent({
          token: data.agentToken, db_type: tech.name,
          host: c.host || 'localhost', port: Number(c.port) || tech.port,
          username: c.username, password: c.password, database_name: c.database_name,
        });
        setResult({ ok: !!r?.ok, msg: r?.ok ? (r.message || 'Connected via agent.') : (r?.error || 'Agent could not connect.') });
      } else {
        const r = await testConnection(tech.id, c);
        setResult({ ok: r?.success !== false, msg: r?.message || 'Connection successful.' });
      }
    } catch (e) {
      setResult({ ok: false, msg: e?.response?.data?.detail || e.message || 'Connection failed.' });
    } finally { setTesting(false); }
  };

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-[19px] font-black text-slate-800">Database credentials</h3>
        <p className="text-[15px] text-slate-500 mt-1">The agent connects read-only using these credentials.</p>
      </div>

      {viaAgent && (
        <div className="rounded-lg bg-sky-50 border border-sky-200 p-3.5 flex gap-2.5">
          <Info size={17} className="text-sky-600 flex-shrink-0 mt-0.5" />
          <p className="text-[13.5px] text-slate-600 leading-relaxed">
            The agent runs on the database host, so it connects to <b>localhost</b> directly — no IP needed.
            Leave <b>Host</b> as <code className="font-mono">localhost</code> unless the database is on a different machine.
            <b> Test connection runs through the agent</b> (validated on its host, not from the server).
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Connection name" required><input className={inp} value={c.connection_name} onChange={(e) => set('connection_name', e.target.value)} placeholder={`My ${tech.name}`} /></Field>
        <Field label="Environment"><select className={inp} value={c.environment} onChange={(e) => set('environment', e.target.value)}><option>Production</option><option>UAT</option><option>Development</option><option>Testing</option></select></Field>
        <Field label={viaAgent ? 'Host / IP (local to agent)' : 'Host / IP'} required={!viaAgent}><input className={inp} value={c.host} onChange={(e) => set('host', e.target.value)} placeholder={viaAgent ? 'localhost' : '192.168.0.10 / db.example.com'} /></Field>
        <Field label="Port"><input type="number" className={inp} value={c.port} onChange={(e) => set('port', Number(e.target.value))} /></Field>
        <Field label="Username" required><input className={inp} value={c.username} onChange={(e) => set('username', e.target.value)} placeholder="actmon_user" /></Field>
        <Field label="Password" required><input type="password" className={inp} value={c.password} onChange={(e) => set('password', e.target.value)} /></Field>
        <Field label={tech.id === 'oracle' ? 'Service name / SID' : 'Database name'}><input className={inp} value={c.database_name} onChange={(e) => set('database_name', e.target.value)} /></Field>
      </div>

      <div className="flex items-center gap-3">
        <button onClick={runTest} disabled={testing || !c.username} className="h-11 px-5 rounded-lg border border-blue-200 bg-blue-50 text-blue-700 text-[15px] font-bold flex items-center gap-1.5 hover:bg-blue-100 disabled:opacity-50">
          {testing ? <Loader2 size={15} className="animate-spin" /> : <TestTube2 size={15} />} {viaAgent ? 'Test via agent' : 'Test connection'}
        </button>
        {result && (
          <span className={`text-[15px] font-semibold flex items-center gap-1.5 ${result.ok ? 'text-emerald-600' : 'text-red-600'}`}>
            {result.ok ? <CheckCircle2 size={15} /> : <XCircle size={15} />}{result.msg}
          </span>
        )}
      </div>
    </div>
  );
}
