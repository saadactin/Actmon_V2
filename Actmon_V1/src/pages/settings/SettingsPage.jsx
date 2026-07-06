import React, { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Settings, Save, ShieldAlert, Sliders, Database,
  Mail, Plus, Trash2, CheckCircle2, XCircle, RefreshCw,
  Eye, EyeOff, TestTube2, Edit2, Star, StarOff, Wifi,
  AlertTriangle, Server, Clock, ChevronRight, ChevronLeft,
  Palette, PanelLeft, LayoutDashboard, Monitor, Moon, Sun, Laptop,
  RotateCcw, Search, Check,
} from 'lucide-react';
import client from '../../api/client';
import { useSettingsStore } from '../../store/settingsStore';
import { useUIStore } from '../../store/uiStore';

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

/* ─── Reusable controls ─── */
function Toggle({ checked, onChange }) {
  return (
    <button type="button" onClick={() => onChange(!checked)}
      className={`relative w-11 h-6 rounded-full transition-colors flex-shrink-0 ${checked ? 'bg-brand-primary' : 'bg-slate-300'}`}>
      <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-5' : ''}`} />
    </button>
  );
}

function Segment({ value, options, onChange }) {
  return (
    <div className="flex items-center gap-1 bg-slate-500/10 rounded-lg p-0.5">
      {options.map(([val, label, Icon]) => (
        <button key={val} onClick={() => onChange(val)}
          className={`h-8 px-3 rounded-md text-xs font-bold flex items-center gap-1.5 transition-all ${value === val ? 'bg-brand-surface shadow text-brand-primary' : 'text-brand-text-secondary hover:text-brand-text-primary'}`}>
          {Icon && <Icon size={13} />}{label}
        </button>
      ))}
    </div>
  );
}

const ACCENTS = ['#0078D4', '#2563eb', '#4f46e5', '#7c3aed', '#0891b2', '#059669', '#d97706', '#e11d48', '#db2777', '#334155'];
function AccentPicker({ value, onChange }) {
  return (
    <div className="flex items-center gap-1.5 flex-wrap justify-end max-w-[248px]">
      {ACCENTS.map((c) => (
        <button key={c} onClick={() => onChange(c)} title={c}
          className="w-6 h-6 rounded-full border-2 transition-transform hover:scale-110 flex items-center justify-center"
          style={{ background: c, borderColor: String(value).toLowerCase() === c ? '#0f172a' : 'transparent' }}>
          {String(value).toLowerCase() === c && <Check size={13} className="text-white" />}
        </button>
      ))}
      <label className="w-6 h-6 rounded-full border border-brand-border overflow-hidden cursor-pointer relative flex items-center justify-center" title="Custom color">
        <input type="color" value={value} onChange={(e) => onChange(e.target.value)} className="absolute inset-0 opacity-0 cursor-pointer" />
        <Palette size={12} className="text-slate-400" />
      </label>
    </div>
  );
}

function AboutCards() {
  const info = [
    ['Product Version', 'ActMon Enterprise v2026.1', 'text-brand-text-primary'],
    ['Active Environment', 'Production Gateway', 'text-emerald-600 font-black'],
    ['API Server Endpoint', 'http://192.168.8.100:8000', 'font-mono text-brand-primary'],
    ['System Local Time', new Date().toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }), 'text-brand-text-primary'],
  ];
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      {info.map(([label, value, cls]) => (
        <div key={label} className="bg-brand-surface rounded-xl p-4 border border-brand-border">
          <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wide">{label}</p>
          <p className={`text-sm mt-1 font-semibold ${cls}`}>{value}</p>
        </div>
      ))}
    </div>
  );
}

/* ─── Main Settings Page (VS Code-style workbench) ─── */
export const SettingsPage = () => {
  const s = useSettingsStore();
  const { sidebarOpen, setSidebarOpen } = useUIStore();
  const [active, setActive] = useState('appearance');
  const [q, setQ] = useState('');

  const GROUPS = [
    { id: 'appearance', title: 'Appearance', icon: Palette },
    { id: 'navigation', title: 'Navigation', icon: PanelLeft },
    { id: 'dashboard',  title: 'Dashboard',  icon: LayoutDashboard },
    { id: 'smtp',       title: 'SMTP Email',  icon: Mail },
    { id: 'data',       title: 'Data & Telemetry', icon: Database },
    { id: 'about',      title: 'About',       icon: ShieldAlert },
  ];

  const ROWS = [
    { group: 'appearance', title: 'Color theme', desc: 'Light, dim, dark — or follow your system.', kw: 'theme dark light dim mode color system', type: 'segment', key: 'theme', options: [['light', 'Light', Sun], ['dim', 'Dim', Monitor], ['dark', 'Dark', Moon], ['system', 'System', Laptop]] },
    { group: 'appearance', title: 'Accent color', desc: 'Primary highlight color used across the UI.', kw: 'accent color primary highlight brand', type: 'accent', key: 'accent' },
    { group: 'appearance', title: 'Sidebar style', desc: 'Color of the left navigation sidebar.', kw: 'sidebar color navigation dark', type: 'segment', key: 'sidebarStyle', options: [['slate', 'Slate'], ['midnight', 'Midnight'], ['ocean', 'Ocean'], ['match', 'Accent']] },
    { group: 'appearance', title: 'Interface size', desc: 'Make everything a bit smaller or larger.', kw: 'size scale font zoom text bigger smaller', type: 'segment', key: 'fontScale', options: [['compact', 'Compact'], ['default', 'Default'], ['large', 'Large']] },
    { group: 'appearance', title: 'Font style', desc: 'Typeface used throughout the app.', kw: 'font typeface family serif mono rounded', type: 'segment', key: 'fontStyle', options: [['system', 'System'], ['rounded', 'Rounded'], ['serif', 'Serif'], ['mono', 'Mono']] },
    { group: 'appearance', title: 'Corner roundness', desc: 'How rounded cards and buttons look.', kw: 'corner radius rounded sharp shape', type: 'segment', key: 'radius', options: [['sharp', 'Sharp'], ['default', 'Default'], ['round', 'Round']] },
    { group: 'appearance', title: 'High contrast', desc: 'Stronger text contrast for easier reading.', kw: 'contrast accessibility readable bold', type: 'toggle', key: 'contrast' },
    { group: 'appearance', title: 'Reduce motion', desc: 'Minimise animations and transitions.', kw: 'motion animation accessibility reduce', type: 'toggle', key: 'reduceMotion' },
    { group: 'navigation', title: 'Hide menu names', desc: 'Collapse the sidebar to icons only.', kw: 'sidebar menu labels hide names collapse', type: 'toggle', key: 'sidebarLabels', invert: true },
    { group: 'navigation', title: 'Collapse sidebar', desc: 'Start with a compact icon sidebar.', kw: 'sidebar collapse compact narrow', type: 'toggleUI' },
    { group: 'dashboard', title: 'Refresh interval', desc: 'How often live widgets poll for data.', kw: 'refresh interval poll rate seconds', type: 'select', key: 'refreshInterval', num: true, options: [[15, '15 seconds'], [30, '30 seconds'], [60, '60 seconds'], [300, '5 minutes']] },
    { group: 'dashboard', title: 'Toast notifications', desc: 'Show real-time pop-up notifications.', kw: 'toast notification popup alert', type: 'toggle', key: 'toasts' },
    { group: 'data', title: 'Audit log retention', desc: 'How long to keep audit and history logs.', kw: 'retention audit log data history', type: 'select', key: 'retention', num: true, options: [[30, '30 days'], [90, '90 days'], [180, '180 days'], [365, '1 year']] },
    { group: 'data', title: 'Automatic discovery', desc: 'Periodically scan for new resources.', kw: 'discovery scan auto agents', type: 'toggle', key: 'autoDiscovery' },
  ];

  const control = (r) => {
    if (r.type === 'toggle') { const v = r.invert ? !s[r.key] : s[r.key]; return <Toggle checked={!!v} onChange={(nv) => s.update({ [r.key]: r.invert ? !nv : nv })} />; }
    if (r.type === 'toggleUI') return <Toggle checked={!sidebarOpen} onChange={(nv) => setSidebarOpen(!nv)} />;
    if (r.type === 'segment') return <Segment value={s[r.key]} options={r.options} onChange={(v) => s.update({ [r.key]: v })} />;
    if (r.type === 'accent') return <AccentPicker value={s.accent} onChange={(v) => s.update({ accent: v })} />;
    if (r.type === 'select') return (
      <select value={s[r.key]} onChange={(e) => s.update({ [r.key]: r.num ? Number(e.target.value) : e.target.value })}
        className="h-9 px-3 rounded-lg border border-brand-border bg-brand-surface text-sm text-brand-text-primary outline-none focus:border-brand-primary">
        {r.options.map(([val, label]) => <option key={val} value={val}>{label}</option>)}
      </select>
    );
    return null;
  };

  const Row = (r) => (
    <div key={r.title} className="py-4 border-b border-brand-border last:border-0 flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm font-bold text-brand-text-primary">{r.title}</p>
        <p className="text-xs text-brand-text-secondary mt-0.5">{r.desc}</p>
      </div>
      <div className="flex-shrink-0">{control(r)}</div>
    </div>
  );

  const ql = q.trim().toLowerCase();
  const matches = ql ? ROWS.filter((r) => (r.title + ' ' + r.desc + ' ' + r.kw).toLowerCase().includes(ql)) : [];
  const activeGroup = GROUPS.find((g) => g.id === active);
  const card = (children) => <div className="bg-brand-surface rounded-2xl border border-brand-border shadow-sm px-5">{children}</div>;

  return (
    <div className="-mx-6 md:-mx-8 -mb-6 md:-mb-8 h-full bg-brand-bg flex flex-col">
      {/* HEADER */}
      <div className="bg-gradient-to-r from-slate-900 via-blue-800 to-sky-700 px-6 md:px-8 pt-3 pb-4 relative overflow-hidden">
        <div className="absolute inset-0 opacity-[0.04]" style={{ backgroundImage: 'linear-gradient(#fff 1px,transparent 1px),linear-gradient(90deg,#fff 1px,transparent 1px)', backgroundSize: '28px 28px' }} />
        <div className="relative flex items-center gap-2 text-xs text-slate-300/70 mb-2.5">
          <span>ActMon</span><ChevronRight size={11} /><span className="text-white font-semibold">Settings</span>
        </div>
        <div className="relative flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-sky-400/20 border border-sky-400/40 flex items-center justify-center flex-shrink-0"><Settings size={18} className="text-sky-200" /></div>
            <div>
              <h1 className="text-lg font-black text-white tracking-tight leading-none">Settings</h1>
              <p className="text-sky-200/70 text-[11px] mt-0.5">Personalise ActMon — theme, colors, navigation &amp; more</p>
            </div>
          </div>
          <div className="relative w-64 max-w-[45vw]">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/50" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search settings…"
              className="w-full h-9 pl-9 pr-3 rounded-lg bg-white/10 border border-white/15 text-white text-sm placeholder-white/50 outline-none focus:bg-white/15" />
          </div>
        </div>
      </div>

      {/* BODY: category nav + settings pane */}
      <div className="flex flex-1 min-h-0">
        <aside className="w-56 flex-shrink-0 border-r border-brand-border bg-brand-surface/50 py-3 overflow-y-auto flex flex-col">
          <p className="px-4 pb-2 text-[10px] font-black text-slate-400 uppercase tracking-wider">Categories</p>
          {GROUPS.map((g) => {
            const Icon = g.icon; const on = !ql && active === g.id;
            return (
              <button key={g.id} onClick={() => { setQ(''); setActive(g.id); }}
                className={`mx-2 px-3 h-10 rounded-lg flex items-center gap-2.5 text-sm font-semibold transition-colors ${on ? 'bg-brand-primary-light text-brand-primary' : 'text-brand-text-secondary hover:bg-slate-500/10'}`}>
                <Icon size={16} /> {g.title}
              </button>
            );
          })}
          <div className="flex-1" />
          <button onClick={() => s.reset()} className="mx-2 mt-2 px-3 h-9 rounded-lg flex items-center gap-2 text-xs font-bold text-slate-400 hover:text-red-500 hover:bg-red-500/10 transition-colors">
            <RotateCcw size={14} /> Reset to defaults
          </button>
        </aside>

        <main className="flex-1 overflow-y-auto px-6 md:px-8 py-6">
          <div className="max-w-[860px]">
            {ql ? (
              matches.length ? (
                <>
                  <p className="text-sm font-bold text-brand-text-secondary mb-3">{matches.length} setting{matches.length !== 1 ? 's' : ''} matching “{q}”</p>
                  {card(matches.map((r) => (
                    <div key={r.title} className="py-4 border-b border-brand-border last:border-0 flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wide">{GROUPS.find((g) => g.id === r.group)?.title}</p>
                        <p className="text-sm font-bold text-brand-text-primary">{r.title}</p>
                        <p className="text-xs text-brand-text-secondary mt-0.5">{r.desc}</p>
                      </div>
                      <div className="flex-shrink-0 pt-3">{control(r)}</div>
                    </div>
                  )))}
                </>
              ) : <div className="text-center py-16 text-slate-400 text-sm">No settings match “{q}”.</div>
            ) : (
              <>
                <div className="flex items-center gap-2 mb-4">
                  {activeGroup && <activeGroup.icon size={18} className="text-brand-primary" />}
                  <h2 className="text-lg font-black text-brand-text-primary">{activeGroup?.title}</h2>
                </div>
                {active === 'smtp' ? <SmtpConfigSection />
                  : active === 'about' ? <AboutCards />
                  : card(ROWS.filter((r) => r.group === active).map(Row))}
              </>
            )}
          </div>
        </main>
      </div>
    </div>
  );
};
