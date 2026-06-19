import React, { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Settings, Save, ShieldAlert, Sliders, Database,
  Mail, Plus, Trash2, CheckCircle2, XCircle, RefreshCw,
  Eye, EyeOff, TestTube2, Edit2, Star, StarOff, Wifi,
  AlertTriangle, Server, Clock,
} from 'lucide-react';
import client from '../../api/client';

/* ─── API ─── */
const smtpApi = {
  list:    ()       => client.get('/settings/smtp').then(r => r.data),
  default: ()       => client.get('/settings/smtp/default').then(r => r.data),
  create:  (data)   => client.post('/settings/smtp', data).then(r => r.data),
  update:  (id, d)  => client.put(`/settings/smtp/${id}`, d).then(r => r.data),
  delete:  (id)     => client.delete(`/settings/smtp/${id}`).then(r => r.data),
  test:    (id)     => client.post(`/settings/smtp/${id}/test`).then(r => r.data),
  testInline: (d)   => client.post('/settings/smtp/test-inline', d).then(r => r.data),
};

const EMPTY_FORM = {
  name: 'Default SMTP',
  smtp_host: '', smtp_port: 587,
  smtp_user: '', smtp_password: '',
  smtp_tls: true,
  sender_email: '', sender_name: 'Actmon Monitor',
  is_default: true,
};

/* ─── SMTP Form Modal ─── */
function SmtpFormModal({ initial, onSave, onClose, isSaving }) {
  const [form, setForm]   = useState(initial || EMPTY_FORM);
  const [showPw, setShowPw] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const handleTest = async () => {
    setTesting(true); setTestResult(null);
    try {
      const res = await smtpApi.testInline(form);
      setTestResult({ ok: res.ok, msg: res.msg });
    } catch (e) {
      setTestResult({ ok: false, msg: e?.response?.data?.detail || e.message });
    } finally {
      setTesting(false);
    }
  };

  const inp = 'w-full px-3 py-2 text-sm rounded-lg border border-slate-200 focus:border-blue-400 focus:outline-none bg-white';
  const lbl = 'block text-xs font-bold text-slate-500 mb-1';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-4">
        <div className="flex items-center justify-between px-6 py-4 rounded-t-2xl"
          style={{ background: 'linear-gradient(135deg,#1e3a5f,#0891b2)' }}>
          <div className="flex items-center gap-3 text-white">
            <Mail size={18} />
            <p className="font-black text-sm">{initial ? 'Edit SMTP Configuration' : 'New SMTP Configuration'}</p>
          </div>
          <button onClick={onClose} className="text-white/70 hover:text-white text-xl">✕</button>
        </div>

        <div className="p-6 space-y-4 max-h-[70vh] overflow-y-auto">
          <div>
            <label className={lbl}>Configuration Name</label>
            <input className={inp} value={form.name} onChange={e => set('name', e.target.value)} placeholder="e.g. Company Gmail" />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <label className={lbl}>SMTP Host</label>
              <input className={inp} value={form.smtp_host} onChange={e => set('smtp_host', e.target.value)}
                placeholder="smtp.gmail.com" />
            </div>
            <div>
              <label className={lbl}>Port</label>
              <input className={inp} type="number" value={form.smtp_port} onChange={e => set('smtp_port', Number(e.target.value))} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={lbl}>SMTP Username</label>
              <input className={inp} value={form.smtp_user} onChange={e => set('smtp_user', e.target.value)}
                placeholder="your@gmail.com" />
            </div>
            <div>
              <label className={lbl}>SMTP Password / App Password</label>
              <div className="relative">
                <input className={inp + ' pr-9'} type={showPw ? 'text' : 'password'}
                  value={form.smtp_password} onChange={e => set('smtp_password', e.target.value)}
                  placeholder="Gmail: use App Password" />
                <button type="button" onClick={() => setShowPw(p => !p)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                  {showPw ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={lbl}>Sender Email</label>
              <input className={inp} value={form.sender_email} onChange={e => set('sender_email', e.target.value)}
                placeholder="noreply@company.com" />
            </div>
            <div>
              <label className={lbl}>Sender Name</label>
              <input className={inp} value={form.sender_name} onChange={e => set('sender_name', e.target.value)} />
            </div>
          </div>

          <div className="flex items-center gap-6">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={form.smtp_tls} onChange={e => set('smtp_tls', e.target.checked)}
                className="w-4 h-4 rounded" />
              <span className="text-sm font-semibold text-slate-600">Use TLS / STARTTLS</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={form.is_default} onChange={e => set('is_default', e.target.checked)}
                className="w-4 h-4 rounded" />
              <span className="text-sm font-semibold text-slate-600">Set as Default</span>
            </label>
          </div>

          {/* Gmail help tip */}
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs text-amber-800">
            <p className="font-bold mb-1">Gmail setup tip:</p>
            <ul className="list-disc pl-4 space-y-0.5">
              <li>Enable 2-Step Verification on your Google account</li>
              <li>Go to <strong>Google Account → Security → App Passwords</strong></li>
              <li>Generate an App Password for "Mail" → use that as the password here</li>
              <li>Host: <strong>smtp.gmail.com</strong> · Port: <strong>587</strong> · TLS: <strong>ON</strong></li>
            </ul>
          </div>

          {/* Test result */}
          {testResult && (
            <div className={`flex items-start gap-2 p-3 rounded-xl text-xs font-semibold border ${
              testResult.ok ? 'bg-green-50 border-green-200 text-green-800' : 'bg-red-50 border-red-200 text-red-800'
            }`}>
              {testResult.ok ? <CheckCircle2 size={14} className="mt-0.5 flex-shrink-0" /> : <XCircle size={14} className="mt-0.5 flex-shrink-0" />}
              <span>{testResult.msg}</span>
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-slate-100 flex justify-between items-center">
          <button onClick={handleTest} disabled={testing || !form.smtp_host}
            className="flex items-center gap-2 px-4 py-2 text-xs font-bold rounded-lg border border-blue-200 text-blue-700 bg-blue-50 hover:bg-blue-100 disabled:opacity-50">
            {testing ? <RefreshCw size={13} className="animate-spin" /> : <TestTube2 size={13} />}
            Test Connection
          </button>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-2 text-xs font-semibold text-slate-600 bg-slate-100 rounded-lg hover:bg-slate-200">
              Cancel
            </button>
            <button onClick={() => onSave(form)} disabled={isSaving || !form.smtp_host || !form.sender_email}
              className="flex items-center gap-2 px-5 py-2 text-xs font-bold text-white rounded-lg disabled:opacity-50"
              style={{ background: 'linear-gradient(135deg,#1e3a5f,#0891b2)' }}>
              {isSaving ? <RefreshCw size={13} className="animate-spin" /> : <Save size={13} />}
              Save Configuration
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── SMTP Config Card ─── */
function SmtpConfigSection() {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing]   = useState(null);
  const [testingId, setTestingId] = useState(null);
  const [testResults, setTestResults] = useState({});

  const { data, isLoading } = useQuery({
    queryKey: ['smtp-configs'],
    queryFn:  smtpApi.list,
  });

  const createMut = useMutation({
    mutationFn: smtpApi.create,
    onSuccess:  () => { qc.invalidateQueries(['smtp-configs']); setShowForm(false); },
  });

  const updateMut = useMutation({
    mutationFn: ({ id, d }) => smtpApi.update(id, d),
    onSuccess:  () => { qc.invalidateQueries(['smtp-configs']); setEditing(null); },
  });

  const deleteMut = useMutation({
    mutationFn: smtpApi.delete,
    onSuccess:  () => qc.invalidateQueries(['smtp-configs']),
  });

  const handleTest = async (id) => {
    setTestingId(id);
    try {
      const res = await smtpApi.test(id);
      setTestResults(p => ({ ...p, [id]: { ok: res.ok, msg: res.msg } }));
      qc.invalidateQueries(['smtp-configs']);
    } catch (e) {
      setTestResults(p => ({ ...p, [id]: { ok: false, msg: e?.response?.data?.detail || e.message } }));
    } finally {
      setTestingId(null);
    }
  };

  const configs = data?.configs || [];

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
      {/* Section header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100"
        style={{ borderLeft: '4px solid #0891b2' }}>
        <div className="flex items-center gap-3">
          <Mail size={18} className="text-cyan-600" />
          <div>
            <h3 className="font-black text-slate-800 text-sm">SMTP Email Configuration</h3>
            <p className="text-xs text-slate-400 mt-0.5">Saved mail server settings for Oracle report delivery and alerts</p>
          </div>
        </div>
        <button onClick={() => setShowForm(true)}
          className="flex items-center gap-2 px-4 py-2 text-xs font-bold text-white rounded-lg"
          style={{ background: 'linear-gradient(135deg,#0891b2,#1e3a5f)' }}>
          <Plus size={13} /> Add SMTP Config
        </button>
      </div>

      <div className="p-6">
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <RefreshCw size={20} className="animate-spin text-slate-400" />
          </div>
        ) : configs.length === 0 ? (
          <div className="text-center py-12 border-2 border-dashed border-slate-200 rounded-xl">
            <Mail size={32} className="mx-auto mb-3 text-slate-300" />
            <p className="font-bold text-slate-500">No SMTP configuration saved</p>
            <p className="text-xs text-slate-400 mt-1 mb-4">Add your mail server to enable report delivery and scheduled emails</p>
            <button onClick={() => setShowForm(true)}
              className="px-4 py-2 text-xs font-bold text-white rounded-lg inline-flex items-center gap-2"
              style={{ background: 'linear-gradient(135deg,#0891b2,#1e3a5f)' }}>
              <Plus size={13} /> Add SMTP Config
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            {configs.map(cfg => {
              const tr = testResults[cfg.id];
              const isTest = testingId === cfg.id;
              return (
                <div key={cfg.id} className={`border rounded-xl overflow-hidden ${cfg.is_default ? 'border-cyan-300' : 'border-slate-200'}`}>
                  <div className={`flex items-center justify-between px-4 py-3 ${cfg.is_default ? 'bg-cyan-50' : 'bg-slate-50'}`}>
                    <div className="flex items-center gap-3">
                      {cfg.is_default
                        ? <Star size={15} className="text-cyan-500 fill-cyan-400" />
                        : <StarOff size={15} className="text-slate-300" />}
                      <div>
                        <div className="flex items-center gap-2">
                          <p className="font-black text-slate-800 text-sm">{cfg.name}</p>
                          {cfg.is_default && (
                            <span className="px-2 py-0.5 bg-cyan-500 text-white text-[10px] font-bold rounded-full">DEFAULT</span>
                          )}
                        </div>
                        <p className="text-xs text-slate-500 mt-0.5">
                          <span className="font-mono">{cfg.smtp_host}:{cfg.smtp_port}</span>
                          {cfg.smtp_tls && <span className="ml-2 text-green-600 font-bold">TLS</span>}
                          {cfg.smtp_user && <span className="ml-2">· {cfg.smtp_user}</span>}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {/* Last test badge */}
                      {cfg.last_test_at && (
                        <span className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold ${
                          cfg.last_test_ok ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                        }`}>
                          {cfg.last_test_ok ? <CheckCircle2 size={10} /> : <XCircle size={10} />}
                          {cfg.last_test_ok ? 'OK' : 'Failed'}
                        </span>
                      )}
                      <button onClick={() => handleTest(cfg.id)} disabled={isTest}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-bold text-blue-700 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 disabled:opacity-60">
                        {isTest ? <RefreshCw size={11} className="animate-spin" /> : <Wifi size={11} />}
                        Test
                      </button>
                      <button onClick={() => setEditing(cfg)}
                        className="p-1.5 text-slate-400 hover:text-slate-700 rounded-lg hover:bg-slate-100">
                        <Edit2 size={13} />
                      </button>
                      <button onClick={() => deleteMut.mutate(cfg.id)}
                        className="p-1.5 text-red-300 hover:text-red-600 rounded-lg hover:bg-red-50">
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>

                  {/* Details row */}
                  <div className="px-4 py-2 bg-white flex flex-wrap items-center gap-4 text-xs text-slate-500">
                    <span className="flex items-center gap-1"><Mail size={11} /> {cfg.sender_email}</span>
                    <span>· Sender: <strong>{cfg.sender_name}</strong></span>
                    {cfg.last_test_at && (
                      <span className="flex items-center gap-1 ml-auto text-[11px]">
                        <Clock size={10} /> Last tested: {new Date(cfg.last_test_at).toLocaleString()}
                      </span>
                    )}
                  </div>

                  {/* Test result */}
                  {(tr || (cfg.last_test_msg && !tr)) && (
                    <div className={`px-4 py-2 text-xs font-semibold flex items-start gap-2 ${
                      (tr?.ok ?? cfg.last_test_ok)
                        ? 'bg-green-50 text-green-700'
                        : 'bg-red-50 text-red-700'
                    }`}>
                      {(tr?.ok ?? cfg.last_test_ok) ? <CheckCircle2 size={12} className="mt-0.5 flex-shrink-0" /> : <XCircle size={12} className="mt-0.5 flex-shrink-0" />}
                      {tr?.msg || cfg.last_test_msg}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Common SMTP presets */}
        <div className="mt-5 pt-4 border-t border-slate-100">
          <p className="text-xs font-bold text-slate-400 uppercase mb-3">Quick Presets</p>
          <div className="flex flex-wrap gap-2">
            {[
              { label: 'Gmail', host: 'smtp.gmail.com', port: 587, tls: true },
              { label: 'Outlook / Office 365', host: 'smtp.office365.com', port: 587, tls: true },
              { label: 'Yahoo Mail', host: 'smtp.mail.yahoo.com', port: 587, tls: true },
              { label: 'Zoho Mail', host: 'smtp.zoho.com', port: 587, tls: true },
              { label: 'SendGrid', host: 'smtp.sendgrid.net', port: 587, tls: true },
              { label: 'AWS SES (US East)', host: 'email-smtp.us-east-1.amazonaws.com', port: 587, tls: true },
            ].map(p => (
              <button key={p.label}
                onClick={() => {
                  setEditing(null);
                  setShowForm(true);
                  setTimeout(() => {}, 0);
                }}
                className="px-3 py-1.5 text-[11px] font-semibold text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-lg border border-slate-200"
                title={`${p.host}:${p.port}`}>
                {p.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Modals */}
      {showForm && (
        <SmtpFormModal
          initial={null}
          onSave={(d) => createMut.mutate(d)}
          onClose={() => setShowForm(false)}
          isSaving={createMut.isPending}
        />
      )}
      {editing && (
        <SmtpFormModal
          initial={{ ...editing, smtp_password: '' }}
          onSave={(d) => updateMut.mutate({ id: editing.id, d })}
          onClose={() => setEditing(null)}
          isSaving={updateMut.isPending}
        />
      )}
    </div>
  );
}

/* ─── Main Settings Page ─── */
export const SettingsPage = () => {
  const [refreshRate, setRefreshRate] = useState('30');
  const [alertSound, setAlertSound]   = useState('normal');
  const [toasts, setToasts]           = useState(true);
  const [highContrast, setHighContrast] = useState(true);
  const [autoDiscovery, setAutoDiscovery] = useState(true);
  const [retention, setRetention]     = useState('90');
  const [saved, setSaved]             = useState(false);

  const handleSave = () => {
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  const selClass = 'w-full px-3 py-2 text-sm rounded-lg border border-slate-200 focus:border-blue-400 focus:outline-none bg-white';

  return (
    <div className="min-h-screen bg-[#f1f5f9] p-6 space-y-6">

      {/* Page Header */}
      <div>
        <h1 className="text-2xl font-black text-slate-900 flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center"
            style={{ background: 'linear-gradient(135deg,#1e3a5f,#0891b2)' }}>
            <Settings size={18} className="text-white" />
          </div>
          System Settings
        </h1>
        <p className="text-sm text-slate-500 mt-1 ml-13">
          Global configuration — SMTP, dashboard preferences, telemetry, and platform info
        </p>
      </div>

      {/* ══ SMTP CONFIGURATION ══ */}
      <SmtpConfigSection />

      {/* ══ DASHBOARD & UI ══ */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="flex items-center gap-3 px-6 py-4 border-b border-slate-100"
          style={{ borderLeft: '4px solid #6366F1' }}>
          <Sliders size={18} className="text-indigo-500" />
          <div>
            <h3 className="font-black text-slate-800 text-sm">Dashboard & UI Controls</h3>
            <p className="text-xs text-slate-400 mt-0.5">Refresh rates, alerts, and display preferences</p>
          </div>
        </div>
        <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-bold text-slate-500 mb-1">Default Refresh Interval</label>
              <select value={refreshRate} onChange={e => setRefreshRate(e.target.value)} className={selClass}>
                <option value="15">15 Seconds (Aggressive)</option>
                <option value="30">30 Seconds (Default)</option>
                <option value="60">60 Seconds (Balanced)</option>
                <option value="300">5 Minutes (Telemetry)</option>
              </select>
              <p className="text-[11px] text-slate-400 mt-1">Polling rate for real-time dashboard widgets</p>
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-500 mb-1">System Alert Sound</label>
              <select value={alertSound} onChange={e => setAlertSound(e.target.value)} className={selClass}>
                <option value="mute">Muted</option>
                <option value="quiet">Low volume</option>
                <option value="normal">Normal volume (Default)</option>
              </select>
            </div>
          </div>
          <div className="space-y-3">
            <p className="text-xs font-bold text-slate-500 mb-2">Display Options</p>
            {[
              [toasts, setToasts, 'Enable Real-Time Toast Notifications'],
              [highContrast, setHighContrast, 'Enable High-Contrast Charts for Accessibility'],
            ].map(([checked, setter, label]) => (
              <label key={label} className="flex items-center gap-3 cursor-pointer p-3 rounded-xl border border-slate-100 hover:bg-slate-50">
                <div onClick={() => setter(c => !c)}
                  className={`w-10 h-5 rounded-full transition-all relative ${checked ? 'bg-indigo-500' : 'bg-slate-200'}`}>
                  <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all ${checked ? 'left-5' : 'left-0.5'}`} />
                </div>
                <span className="text-sm text-slate-700">{label}</span>
              </label>
            ))}
          </div>
        </div>
      </div>

      {/* ══ TELEMETRY & AGENTS ══ */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="flex items-center gap-3 px-6 py-4 border-b border-slate-100"
          style={{ borderLeft: '4px solid #14B8A6' }}>
          <Database size={18} className="text-teal-500" />
          <div>
            <h3 className="font-black text-slate-800 text-sm">Telemetry & Agent Collectors</h3>
            <p className="text-xs text-slate-400 mt-0.5">Log retention, discovery scanning, and agent settings</p>
          </div>
        </div>
        <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <label className="block text-xs font-bold text-slate-500 mb-1">Audit Log Retention</label>
            <select value={retention} onChange={e => setRetention(e.target.value)} className={selClass}>
              <option value="30">30 Days</option>
              <option value="90">90 Days (Recommended)</option>
              <option value="180">180 Days (Compliance)</option>
              <option value="365">1 Year</option>
            </select>
          </div>
          <div className="space-y-3">
            {[
              [autoDiscovery, setAutoDiscovery, 'Enable Automatic Discovery Scanning'],
            ].map(([checked, setter, label]) => (
              <label key={label} className="flex items-center gap-3 cursor-pointer p-3 rounded-xl border border-slate-100 hover:bg-slate-50">
                <div onClick={() => setter(c => !c)}
                  className={`w-10 h-5 rounded-full transition-all relative ${checked ? 'bg-teal-500' : 'bg-slate-200'}`}>
                  <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all ${checked ? 'left-5' : 'left-0.5'}`} />
                </div>
                <span className="text-sm text-slate-700">{label}</span>
              </label>
            ))}
          </div>
        </div>
      </div>

      {/* ══ PLATFORM INFO ══ */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="flex items-center gap-3 px-6 py-4 border-b border-slate-100"
          style={{ borderLeft: '4px solid #C74634' }}>
          <ShieldAlert size={18} className="text-red-500" />
          <h3 className="font-black text-slate-800 text-sm">Platform Information</h3>
        </div>
        <div className="p-6 grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            ['Product Version',      'ActMon Enterprise v2026.1',      'text-slate-800'],
            ['Active Environment',   'Production Gateway',             'text-emerald-600 font-black'],
            ['API Server Endpoint',  'http://192.168.8.100:8000',      'font-mono text-blue-700'],
            ['System Local Time',    new Date().toLocaleString('en-IN',{dateStyle:'medium',timeStyle:'short'}), 'text-slate-700'],
          ].map(([label, value, cls]) => (
            <div key={label} className="bg-slate-50 rounded-xl p-4 border border-slate-100">
              <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wide">{label}</p>
              <p className={`text-sm mt-1 font-semibold ${cls}`}>{value}</p>
            </div>
          ))}
        </div>
      </div>

      {/* ══ SAVE BAR ══ */}
      <div className="flex justify-end items-center gap-3 pt-2">
        {saved && (
          <span className="flex items-center gap-2 text-sm text-green-700 font-bold">
            <CheckCircle2 size={16} /> Settings saved successfully
          </span>
        )}
        <button onClick={handleSave}
          className="flex items-center gap-2 px-6 py-2.5 text-sm font-black text-white rounded-xl shadow-lg"
          style={{ background: 'linear-gradient(135deg,#1e3a5f,#0891b2)' }}>
          <Save size={15} /> Save Settings
        </button>
      </div>
    </div>
  );
};
