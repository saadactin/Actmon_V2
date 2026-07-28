import React, { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Settings, Save, ShieldAlert, Sliders, Database,
  Mail, Plus, Trash2, CheckCircle2, XCircle, RefreshCw,
  Eye, EyeOff, TestTube2, Edit2, Star, StarOff, Wifi,
  AlertTriangle, Server, Clock, ChevronRight, ChevronLeft, ChevronDown,
  Palette, PanelLeft, LayoutDashboard, Monitor, Moon, Sun, Laptop,
  RotateCcw, Search, Check, Cpu, MemoryStick, HardDrive, Activity, Zap,
} from 'lucide-react';
import client from '../../api/client';
import { useSettingsStore } from '../../store/settingsStore';
import { useUIStore } from '../../store/uiStore';
import { useAuthStore } from '../../store/authStore';
import { useDashboardAppearance, SCOPES } from '../../context/DashboardAppearanceContext';
import Gauge from '../../components/gauges/Gauge';
import TrendChart from '../../components/gauges/TrendChart';

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

const monitoringApi = {
  get:    ()     => client.get('/settings/monitoring').then(r => r.data),
  update: (data) => client.put('/settings/monitoring', data).then(r => r.data),
};

// FastAPI validation failures (422) return `detail` as an ARRAY of
// {loc, msg, type} objects, not a string — rendering that array directly
// (as a couple of save handlers here used to) prints "[object Object]"
// instead of a readable message. This always resolves to a string.
function errMsg(e, fallback = 'Something went wrong.') {
  const detail = e?.response?.data?.detail;
  if (Array.isArray(detail)) return detail[0]?.msg || fallback;
  if (typeof detail === 'string') return detail;
  return e?.message || fallback;
}

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

const BRIGHTNESS_PRESETS = [['low', 'Low', 70], ['high', 'High', 130]];
function BrightnessSlider({ value, onChange }) {
  const v = Number(value) || 100;
  const preset = BRIGHTNESS_PRESETS.find(([, , val]) => val === v)?.[0];
  return (
    <div className="flex flex-col items-end gap-2 w-[248px]">
      <div className="flex items-center gap-1 bg-slate-500/10 rounded-lg p-0.5 self-stretch justify-center">
        {BRIGHTNESS_PRESETS.map(([id, label, val]) => (
          <button key={id} onClick={() => onChange(val)}
            className={`flex-1 h-8 px-3 rounded-md text-xs font-bold flex items-center justify-center gap-1.5 transition-all ${preset === id ? 'bg-brand-surface shadow text-brand-primary' : 'text-brand-text-secondary hover:text-brand-text-primary'}`}>
            {id === 'low' ? <Moon size={13} /> : <Sun size={13} />}{label}
          </button>
        ))}
        <button onClick={() => onChange(100)}
          className={`flex-1 h-8 px-3 rounded-md text-xs font-bold flex items-center justify-center transition-all ${v === 100 ? 'bg-brand-surface shadow text-brand-primary' : 'text-brand-text-secondary hover:text-brand-text-primary'}`}>
          Reset
        </button>
      </div>
      <div className="flex items-center gap-2 self-stretch">
        <Moon size={13} className="text-slate-400 flex-shrink-0" />
        <input type="range" min={50} max={150} step={5} value={v}
          onChange={(e) => onChange(Number(e.target.value))}
          className="flex-1 h-1.5 accent-brand-primary cursor-pointer" />
        <Sun size={15} className="text-slate-400 flex-shrink-0" />
        <span className="text-xs font-bold text-brand-text-primary tabular-nums w-10 text-right">{v}%</span>
      </div>
    </div>
  );
}

function ColorField({ value, presets, clearable, onChange }) {
  const cur = String(value || '').toLowerCase();
  return (
    <div className="flex items-center gap-1.5 flex-wrap justify-end max-w-[248px]">
      {clearable && (
        <button onClick={() => onChange('')} title="Use preset / default"
          className={`h-6 px-2.5 rounded-full text-[10px] font-bold border transition-colors ${!cur ? 'bg-brand-primary text-white border-brand-primary' : 'border-brand-border text-brand-text-secondary hover:border-brand-primary'}`}>
          Auto
        </button>
      )}
      {presets.map((c) => (
        <button key={c} onClick={() => onChange(c)} title={c}
          className="w-6 h-6 rounded-full border-2 transition-transform hover:scale-110 flex items-center justify-center"
          style={{ background: c, borderColor: cur === c.toLowerCase() ? '#0f172a' : 'rgba(0,0,0,0.12)' }}>
          {cur === c.toLowerCase() && <Check size={13} className={/^#f/i.test(c) ? 'text-slate-700' : 'text-white'} />}
        </button>
      ))}
      <label className="w-6 h-6 rounded-full border border-brand-border overflow-hidden cursor-pointer relative flex items-center justify-center" title="Custom color">
        <input type="color" value={value || '#ffffff'} onChange={(e) => onChange(e.target.value)} className="absolute inset-0 opacity-0 cursor-pointer" />
        <Palette size={12} className="text-slate-400" />
      </label>
    </div>
  );
}

/* ─── Monitoring Detection Speed (Super Admin only) ─── */
function MonitoringSettingsSection() {
  const qc = useQueryClient();
  const [form, setForm] = useState(null);   // null until loaded, then a local editable copy
  const [saveMsg, setSaveMsg] = useState(null);

  const { data, isLoading } = useQuery({
    queryKey: ['monitoring-settings'],
    queryFn: monitoringApi.get,
  });

  useEffect(() => {
    if (data && !form) setForm(data);
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveMut = useMutation({
    mutationFn: monitoringApi.update,
    onSuccess: (saved) => {
      qc.setQueryData(['monitoring-settings'], saved);
      setForm(saved);
      setSaveMsg({ ok: true, text: 'Saved — takes effect within a few seconds, no restart needed.' });
      setTimeout(() => setSaveMsg(null), 4000);
    },
    onError: (e) => {
      setSaveMsg({ ok: false, text: errMsg(e) });
    },
  });

  const FIELDS = [
    { key: 'error_streak', label: 'Failures before "DB Error"', suffix: 'checks', min: 1, max: 10,
      desc: 'How many consecutive failed checks before a database flips to DB Error. Lower = faster detection, higher risk of flapping on a single blip.' },
    { key: 'collector_interval_sec', label: 'Check interval', suffix: 'seconds', min: 5, max: 300,
      desc: 'How often each monitored database is checked. Lower = faster detection, more load on this server and the monitored hosts.' },
    { key: 'offline_after_sec', label: 'Silence before "Offline"', suffix: 'seconds', min: 30, max: 3600,
      desc: 'How long a host/agent can go silent (no heartbeat at all) before it shows Offline. Kept deliberately conservative — a prior lower value caused hosts to flap online/offline while just busy.' },
  ];

  if (isLoading || !form) {
    return (
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-12 flex items-center justify-center">
        <RefreshCw size={20} className="animate-spin text-slate-400" />
      </div>
    );
  }

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
      <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100" style={{ borderLeft: '4px solid #7c3aed' }}>
        <div className="flex items-center gap-3">
          <Sliders size={18} className="text-violet-600" />
          <div>
            <h3 className="font-black text-slate-800 text-sm">Monitoring Detection Speed</h3>
            <p className="text-xs text-slate-400 mt-0.5">How fast ActMon notices a database going down or coming back up</p>
          </div>
        </div>
      </div>

      <div className="p-6 space-y-5">
        {FIELDS.map((f) => (
          <div key={f.key} className="flex items-start justify-between gap-6 pb-5 border-b border-slate-100 last:border-0 last:pb-0">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold text-slate-800">{f.label}</p>
              <p className="text-xs text-slate-400 mt-0.5 leading-relaxed">{f.desc}</p>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <input type="number" min={f.min} max={f.max} value={form[f.key]}
                onChange={(e) => setForm((p) => ({ ...p, [f.key]: Number(e.target.value) }))}
                className="w-20 h-10 px-3 rounded-lg border border-slate-300 text-sm font-bold text-center outline-none focus:border-violet-400" />
              <span className="text-xs text-slate-400 w-14">{f.suffix}</span>
            </div>
          </div>
        ))}

        {saveMsg && (
          <p className={`text-xs font-semibold ${saveMsg.ok ? 'text-emerald-600' : 'text-red-600'}`}>{saveMsg.text}</p>
        )}

        <div className="flex items-center gap-3 pt-2">
          <button onClick={() => saveMut.mutate({
              error_streak: form.error_streak,
              collector_interval_sec: form.collector_interval_sec,
              offline_after_sec: form.offline_after_sec,
            })}
            disabled={saveMut.isPending}
            className="flex items-center gap-2 px-5 py-2.5 text-xs font-bold text-white rounded-lg disabled:opacity-60"
            style={{ background: 'linear-gradient(135deg,#7c3aed,#4c1d95)' }}>
            {saveMut.isPending ? <RefreshCw size={13} className="animate-spin" /> : <Save size={13} />}
            Save Changes
          </button>
          {data?.updated_at && (
            <span className="text-[11px] text-slate-400">Last updated {new Date(data.updated_at).toLocaleString()}</span>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─── Dashboard Appearance (gauge/chart templates, applies to every dashboard) ─── */
// "Basics" chart-type list — same set/order as the reference gallery. `built`
// marks the ones that actually render for real; the rest show a clear
// "not built yet" placeholder in the preview pane rather than faking a look
// nobody has approved, waiting on specific design guidance per type.
const CHART_CATEGORIES = [
  { title: 'Basics', options: [
    { key: 'line',      name: 'Line chart',      built: true,  desc: 'Clean stroked line, no fill. Best when comparing several series.' },
    { key: 'area',      name: 'Area chart',      built: true,  desc: 'Gradient-filled area under the line. Good for volume/magnitude.' },
    { key: 'bar',       name: 'Column chart',    built: true,  desc: 'Vertical bars per sample. Reads well for interval/count data.' },
    { key: 'barh',      name: 'Bar chart',       built: true,  desc: 'Horizontal grouped bars with each value labeled at its end. Good for ranking categories, or on narrow screens where long category names read better than rotated axis labels.' },
    { key: 'pie',       name: 'Pie chart',       built: true,  desc: 'Each series as a slice of its total over the shown window. Good for breakdowns, e.g. operations by type.' },
    { key: 'donut',     name: 'Donut chart',     built: true,  desc: 'Same breakdown as Pie with a hollow center — reads a little lighter on a busy dashboard.' },
    { key: 'gauge',     name: 'Gauge',           built: true,  desc: 'Semi-circular dial with colored zone bands, tick marks and a needle — for the latest value of a trend panel, distinct from the ring/donut "Indicator style" used on gauge tiles.' },
    { key: 'bubble',    name: 'Bubble chart',    built: true,  desc: 'Each point sized by a third dimension, individually colored and labeled. Good for comparing 3 metrics across a handful of entities (e.g. servers) without extra axes.' },
    { key: 'scatter',   name: 'Scatter plot',    built: true,  desc: 'Plots one series against another as points — good for spotting correlation (e.g. CPU vs. response time).' },
    { key: 'spark',     name: 'Sparkline',       built: true,  desc: 'Axis-free micro trend line. Pairs with Minimal Numeric cards.' },
    { key: 'heatmap',   name: 'Heatmap',         built: false, desc: 'Waiting on design guidance.' },
    { key: 'candle',    name: 'Candlestick',     built: false, desc: 'Waiting on design guidance — ActMon has no OHLC-style data source today.' },
    { key: 'choropleth',name: 'Choropleth map',  built: false, desc: 'Waiting on design guidance — ActMon has no geographic data source today.' },
    { key: 'tiledmap',  name: 'Tiled web map',   built: false, desc: 'Waiting on design guidance — ActMon has no geographic data source today.' },
    { key: 'gantt',     name: 'Gantt chart',     built: true,  desc: 'Hierarchical task timeline with group summary bars, milestones, percent-complete overlays and dependency arrows. Good for maintenance/rollout plans, not live metrics.' },
  ] },
  // Mirrors the Highcharts Demos site's own "Highcharts Core > Line charts"
  // sidebar group — deliberately more advanced/specific techniques than the
  // plain "Line chart" already in Basics above, so listed separately rather
  // than folded into it. All waiting on design guidance like every other
  // not-yet-built type — no faked look for a technique nobody's approved.
  { title: 'Line charts', options: [
    { key: 'spline_symbols',        name: 'Spline with symbols',              built: false, desc: 'A smoothed (curved, not straight-segment) line with a marker shape at every data point. Waiting on design guidance.' },
    { key: 'spline_inverted_axes',  name: 'Spline with inverted axes',        built: false, desc: 'Same smoothed curve with X and Y swapped (categories run vertically). Waiting on design guidance.' },
    { key: 'line_data_labels',      name: 'With data labels',                 built: false, desc: 'Prints each point\'s value directly above it, in addition to the line. Waiting on design guidance.' },
    { key: 'log_axis',              name: 'Logarithmic axis',                 built: false, desc: 'Y-axis scaled logarithmically — for series spanning several orders of magnitude. Waiting on design guidance.' },
    { key: 'line_race',             name: 'Line Race Chart',                  built: false, desc: 'Animated line chart that draws itself over time, racing left to right. Waiting on design guidance.' },
    { key: 'line_entrance_anim',    name: 'Line chart with custom entrance animation', built: false, desc: 'A bespoke draw-in animation on first load instead of the default fade. Waiting on design guidance.' },
    { key: 'forecast',              name: 'Forecast',                         built: false, desc: 'Historical series continuing into a dashed/shaded projected range. ActMon has no forecasting model wired in today.' },
    { key: 'stock_annotations',     name: 'Stock data with annotations',      built: false, desc: 'Price-style series with manually or programmatically placed callouts. ActMon has no stock/OHLC data source today.' },
    { key: 'large_dataset',         name: 'Line chart with 500k points',      built: false, desc: 'Performance-oriented rendering (boost mode) for very large point counts. Waiting on design guidance — none of ActMon\'s trend panels currently plot that many points.' },
    { key: 'zoomable_timeseries',   name: 'Time series, zoomable',            built: false, desc: 'A range selector / navigator strip below the chart for zooming into a time window. Waiting on design guidance.' },
    { key: 'irregular_intervals',   name: 'Time data with irregular intervals', built: false, desc: 'X-axis spacing reflects actual gaps between samples instead of assuming a fixed interval. Waiting on design guidance.' },
    { key: 'spline_plotbands',      name: 'Spline with plot bands',           built: false, desc: 'A smoothed curve with shaded horizontal bands marking threshold ranges (e.g. healthy/warning/critical). Waiting on design guidance.' },
  ] },
  // Same "Highcharts Core" sidebar grouping continued — Area/Column/Pie/
  // Scatter variants build on the already-built base type of the same
  // family (see Basics above); Combinations and 3D charts are new families.
  // Deliberately NOT included: Styled mode, Accessibility, Audio charts,
  // Dynamic charts — those are Highcharts library FEATURES (a CSS theming
  // mode, screen-reader support, sonification, live-update behavior), not
  // visual chart types, so they don't belong in a "pick a chart type" list.
  { title: 'Area charts', options: [
    { key: 'area_range',    name: 'Area range',            built: false, desc: 'A shaded band between a min and max series (e.g. p10-p90 latency) instead of one line. Waiting on design guidance.' },
    { key: 'area_spline',   name: 'Area spline',           built: false, desc: 'The existing Area style with a smoothed (curved) line instead of straight segments. Waiting on design guidance.' },
    { key: 'area_stacked',  name: 'Stacked area',          built: false, desc: 'Multiple series stacked on top of each other so the total is also readable. Waiting on design guidance.' },
    { key: 'area_negative', name: 'Area with negative values', built: false, desc: 'Area fill that extends below zero, shaded differently than the positive region. Waiting on design guidance.' },
  ] },
  { title: 'Column and bar charts', options: [
    { key: 'column_stacked',  name: 'Stacked columns',        built: false, desc: 'Column style with series stacked per category instead of grouped side by side. Waiting on design guidance.' },
    { key: 'column_pyramid',  name: 'Column pyramid',         built: false, desc: 'Columns widen/narrow toward one end instead of a flat rectangle — a funnel-like variant. Waiting on design guidance.' },
    { key: 'bar_negative',    name: 'Bar with negative stack', built: false, desc: 'Horizontal Bar style where stacked segments can extend in both directions from zero. Waiting on design guidance.' },
  ] },
  { title: 'Pie charts', options: [
    { key: 'pie_semicircle',  name: 'Semi-circle donut',    built: false, desc: 'The existing Donut style cut to a half-circle instead of a full ring. Waiting on design guidance.' },
    { key: 'pie_variable_radius', name: 'Variable radius pie', built: false, desc: 'Each slice\'s radius (not just its angle) also encodes a value — two dimensions in one pie. Waiting on design guidance.' },
  ] },
  { title: 'Scatter and bubble charts', options: [
    { key: 'bubble_packed',  name: 'Packed bubble chart',   built: false, desc: 'Bubbles sized by value and packed together (no X/Y axes) instead of positioned on a grid. Waiting on design guidance.' },
  ] },
  { title: 'Combinations', options: [
    { key: 'combo_dual_axis', name: 'Dual axes, line and column', built: false, desc: 'A column series and a line series sharing one chart on two different Y-axis scales (e.g. request count vs. latency). Waiting on design guidance.' },
  ] },
  { title: '3D charts', options: [
    { key: '3d_column', name: '3D column', built: false, desc: 'The existing Column style rendered with 3D depth/perspective. Waiting on design guidance.' },
    { key: '3d_pie',    name: '3D pie',    built: false, desc: 'The existing Pie style rendered with 3D depth/perspective. Waiting on design guidance.' },
  ] },
  { title: 'Gauges', options: [
    { key: 'gauge_solid', name: 'Solid gauge', built: false, desc: 'A radial progress ring (value as arc sweep, not a needle) — closer to ActMon\'s existing ring "Indicator style" than the needle Gauge above. Waiting on design guidance on how the two should differ.' },
  ] },
];
const SAMPLE_GAUGES = [
  { icon: Cpu,         label: 'CPU Usage',    pct: 32, sub: 'of 100% · 12 CPUs' },
  { icon: MemoryStick, label: 'RAM Usage',    pct: 64, sub: '10.2 GB of 16 GB' },
  { icon: HardDrive,   label: 'Disk Usage',   pct: 48, sub: '120 GB of 250 GB' },
  { icon: Activity,    label: 'Sessions %',   pct: 8,  sub: '12 / 150 max' },
  { icon: Zap,         label: 'Cache Hit %',  pct: 97, sub: 'Logical read efficiency' },
];
const SAMPLE_TREND = Array.from({ length: 14 }, (_, i) => ({
  t: i,
  a: Math.round(60 + 8 * Math.sin(i / 2) + (i > 9 ? 4 : 0)),
  b: Math.round(55 + 7 * Math.cos(i / 2.3) + (i > 9 ? 3 : 0)),
}));
// Category-grouped sample for the horizontal Bar chart style — this one
// genuinely isn't a time series (like the reference's per-region population
// bars), so it gets its own small illustrative dataset instead of reusing
// SAMPLE_TREND under a different axis.
const SAMPLE_BAR_CATEGORIES = [
  { engine: 'MySQL',      active: 42, peak: 68, errors: 3 },
  { engine: 'PostgreSQL', active: 35, peak: 51, errors: 1 },
  { engine: 'Oracle',     active: 58, peak: 90, errors: 5 },
  { engine: 'MongoDB',    active: 21, peak: 34, errors: 0 },
];
const SAMPLE_BAR_SERIES = [
  { key: 'active', label: 'Active Connections', color: '#22c55e' },
  { key: 'peak',   label: 'Peak Connections',   color: '#3f6fd6' },
  { key: 'errors', label: 'Errors',              color: '#ef4444' },
];
// Bubble chart sample — per-engine latency vs. connection load, sized by
// error count. Unlike Highcharts' literal sugar/fat demo, the "safe zone"
// here is a genuine ActMon concept: low latency AND low connection load is
// an actually-healthy server, not an arbitrary illustrative threshold.
const SAMPLE_BUBBLE = [
  { code: 'MY', latency: 12, connections: 28, errors: 1 },
  { code: 'PG', latency: 18, connections: 35, errors: 0 },
  { code: 'OR', latency: 46, connections: 62, errors: 4 },
  { code: 'MS', latency: 34, connections: 48, errors: 2 },
  { code: 'MG', latency: 22, connections: 40, errors: 1 },
  { code: 'CH', latency: 9,  connections: 20, errors: 0 },
];
// Gantt sample — an ActMon maintenance plan (patch rollout + failover drill)
// instead of Highcharts' literal office-relocation demo. Day numbers, not
// real calendar dates — no date library is wired into TrendChart, so this
// is an honest simplification rather than a faked schedule.
const SAMPLE_GANTT = [
  { id: 'g1', name: 'Patch Rollout', level: 0, isGroup: true },
  { id: 'g1_backup', name: 'Backup Verified', level: 1, start: 0, duration: 0, color: '#f97316' },
  { id: 'g1_apply', name: 'Apply Patches', level: 1, start: 0, duration: 4, percent: 65, color: '#4f46e5', dependsOn: 'g1_backup' },
  { id: 'g1_restart', name: 'Restart Services', level: 1, start: 4, duration: 1, color: '#0ea5e9', dependsOn: 'g1_apply' },
  { id: 'g1_health', name: 'Health Check Passed', level: 1, start: 5, duration: 0, color: '#f97316', dependsOn: 'g1_restart' },
  { id: 'g2', name: 'Failover Drill', level: 0, isGroup: true },
  { id: 'g2_promote', name: 'Promote Replica', level: 1, start: 6, duration: 1, color: '#8b5cf6', dependsOn: 'g1_health' },
  { id: 'g2_dns', name: 'Update DNS Records', level: 1, start: 7, duration: 1, color: '#14b8a6', dependsOn: 'g2_promote' },
  { id: 'g2_cutover', name: 'Cutover Confirmed', level: 1, start: 8, duration: 0, color: '#f97316', dependsOn: 'g2_dns' },
];
// Small multi-series sample sweep — one shape per mini KPI card below, purely
// illustrative (same spirit as SAMPLE_GAUGES' fixed pct values), just varied
// enough per card to preview the chosen chart style across a realistic grid
// of widgets instead of a single big panel.
const kpiTrend = (amp, phase, tilt) => Array.from({ length: 14 }, (_, i) => ({
  t: i,
  a: Math.round(amp.a + amp.a * 0.18 * Math.sin(i / 2 + phase) + (i > 9 ? tilt : 0)),
  b: Math.round(amp.b + amp.b * 0.15 * Math.cos(i / 2.3 + phase) + (i > 9 ? tilt * 0.7 : 0)),
}));
const SAMPLE_KPI_CARDS = [
  { title: 'Connections & Sessions', value: '1,284', sub: 'Active connections', color2: 'Peak sessions', v2: '1,940',
    data: kpiTrend({ a: 60, b: 45 }, 0, 25) },
  { title: 'Slow queries', value: '182', sub: 'Slow queries (Sum)', color2: 'Failed queries', v2: '9',
    data: kpiTrend({ a: 20, b: 8 }, 1.1, 55) },
  { title: 'Avg query response time', value: '84 ms', sub: 'Response time (Avg)', color2: null, v2: null,
    data: kpiTrend({ a: 40, b: 40 }, 2.2, -18) },
  { title: 'Uptime & availability', value: '99.95%', sub: 'Availability (Avg)', color2: null, v2: null,
    data: kpiTrend({ a: 92, b: 92 }, 0.4, -6) },
  { title: 'Errors & failed operations', value: '46', sub: 'Errors (Sum)', color2: 'Timeouts', v2: '3',
    data: kpiTrend({ a: 12, b: 5 }, 1.8, 40) },
  { title: 'CPU & memory utilization', value: '34.5%', sub: 'CPU (Avg)', color2: 'Memory (Avg)', v2: '61.2%',
    data: kpiTrend({ a: 45, b: 60 }, 0.7, 10) },
];
const SAMPLE_HISTORY = Array.from({ length: 14 }, (_, i) => ({
  t: i, v: Math.round(55 + 10 * Math.sin(i / 2.2) + (i > 9 ? 6 : 0)),
}));

// Per-scope widget picker — lets the Live Preview below show a specific REAL
// widget exactly as it appears on that technology's actual dashboard, instead
// of a generic mockup. Every entry here mirrors a widget that genuinely exists
// on the corresponding *Dashboard.jsx page (verified against the real Gauge/
// ChartCard titles) — where an engine's real dashboard has no equivalent to a
// concept another engine has (e.g. Oracle has no per-statement-type "Query
// Operations" breakdown, ClickHouse pools no client connections), the entry
// is an honest substitute with its own real name and a note explaining the
// difference, never a faked lookalike. This is preview-only: style is still
// saved once per scope, not per widget.
// The real "Host Resources" widget is ONE shared component
// (PgHostResources.jsx's `HostResources`) mounted identically on every
// engine's dashboard (mysql/postgresql/oracle/mssql/clickhouse/mongodb) —
// it always shows exactly these 3 gauges (CPU, RAM, Disk), never the
// engine-specific gauge row that happens to sit next to it on the page.
const HOST_RESOURCES_GAUGES = [
  { icon: Cpu, label: 'CPU', pct: 46, sub: 'of host CPU' },
  { icon: MemoryStick, label: 'RAM', pct: 64, sub: '10.2 GB / 16 GB' },
  { icon: HardDrive, label: 'Disk (/)', pct: 48, sub: 'Root filesystem' },
];
const SCOPE_WIDGETS = {
  all: [
    { key: 'host_resources', name: 'Host Resources', kind: 'gauges',
      desc: 'The shared Host Resources widget (CPU/RAM/Disk) — identical on every technology\'s dashboard.',
      gauges: HOST_RESOURCES_GAUGES },
    { key: 'connection_pool', name: 'Connection Pool', kind: 'gauges',
      desc: 'Generic composite — the exact gauge shown varies per technology.',
      gauges: [{ icon: Wifi, label: 'Connection Pool', pct: 45, sub: 'Illustrative — real gauge depends on engine' }] },
    { key: 'query_operations', name: 'Query Operations', kind: 'chart',
      desc: 'Generic composite — the exact breakdown varies per technology.',
      xKey: 'op', xLabel: 'Statement type', title: 'Query Operations', subtitle: 'Illustrative statement breakdown',
      data: [{ op: 'SELECT', count: 48210 }, { op: 'INSERT', count: 9120 }, { op: 'UPDATE', count: 6210 }, { op: 'DELETE', count: 1180 }],
      series: [{ key: 'count', label: 'Executions', color: '#3f6fd6' }] },
    { key: 'database_size_distribution', name: 'Database Size Distribution', kind: 'chart',
      desc: 'Generic composite — the exact grouping (database/tablespace/collection) varies per technology.',
      xKey: 'db', xLabel: 'Database', title: 'Database Size Distribution', subtitle: 'Illustrative per-database size, largest first',
      data: [{ db: 'appdb', mb: 2340 }, { db: 'salesdb', mb: 1180 }, { db: 'logsdb', mb: 860 }, { db: 'sys', mb: 120 }],
      series: [{ key: 'mb', label: 'Size (MB)', color: '#f59e0b' }] },
  ],
  mysql: [
    { key: 'host_resources', name: 'Host Resources', kind: 'gauges',
      desc: 'The shared Host Resources widget (CPU/RAM/Disk) at the top of the MySQL Dashboard Overview tab.',
      gauges: HOST_RESOURCES_GAUGES },
    { key: 'connection_pool', name: 'Connection Pool', kind: 'gauges',
      desc: 'A single gauge from the Host Resources row.',
      gauges: [{ icon: Wifi, label: 'Connection Pool', pct: 62, sub: '312 / 500 max' }] },
    { key: 'query_operations', name: 'Query Operations', kind: 'chart',
      desc: 'The "Query Operations (cumulative)" chart — Com_select/insert/update/delete/commit/rollback.',
      xKey: 'op', xLabel: 'Statement type', title: 'Query Operations', subtitle: 'Cumulative Com_* counters since server start',
      data: [{ op: 'SELECT', count: 48210 }, { op: 'INSERT', count: 9120 }, { op: 'UPDATE', count: 6210 }, { op: 'DELETE', count: 1180 }, { op: 'COMMIT', count: 5320 }, { op: 'ROLLBACK', count: 96 }],
      series: [{ key: 'count', label: 'Executions', color: '#3f6fd6' }] },
    { key: 'database_size_distribution', name: 'Database Size Distribution', kind: 'chart',
      desc: 'The "Database Size Distribution" chart — bar on the Overview tab, donut on the Databases tab (pick Chart style below to see either).',
      xKey: 'db', xLabel: 'Database', title: 'Database Size Distribution', subtitle: 'Per-database size, largest first',
      data: [{ db: 'appdb', mb: 2340 }, { db: 'salesdb', mb: 1180 }, { db: 'logsdb', mb: 860 }, { db: 'sys', mb: 120 }],
      series: [{ key: 'mb', label: 'Size (MB)', color: '#f59e0b' }] },
    { key: 'qps_trend', name: 'QPS Trend', kind: 'chart',
      desc: 'The "QPS Trend" sparkline on the Performance tab.',
      xKey: 't', yLabel: 'q/s', xLabel: 'Time →', title: 'QPS Trend', subtitle: 'Queries per second',
      data: Array.from({ length: 14 }, (_, i) => ({ t: i, v: Number((0.4 + 0.3 * Math.sin(i / 2)).toFixed(2)) })),
      series: [{ key: 'v', label: 'QPS', color: '#06b6d4' }] },
    { key: 'buffer_pool_hit_pct', name: 'Buffer Pool Hit %', kind: 'chart',
      desc: 'The "Buffer Pool Hit %" sparkline on the Performance tab.',
      xKey: 't', yLabel: '%', xLabel: 'Time →', title: 'Buffer Pool Hit %', subtitle: 'InnoDB buffer pool hit ratio',
      data: Array.from({ length: 14 }, (_, i) => ({ t: i, v: Number((99.5 + 0.4 * Math.sin(i / 3)).toFixed(2)) })),
      series: [{ key: 'v', label: 'Buffer Pool Hit %', color: '#22c55e' }] },
    { key: 'active_txns', name: 'Active Txns', kind: 'chart',
      desc: 'The "Active Txns" sparkline on the Performance tab.',
      xKey: 't', yLabel: 'txn', xLabel: 'Time →', title: 'Active Txns', subtitle: 'Currently open transactions',
      data: Array.from({ length: 14 }, (_, i) => ({ t: i, v: Math.round(2 + 2 * Math.max(0, Math.sin(i / 2.5))) })),
      series: [{ key: 'v', label: 'Active Txns', color: '#f59e0b' }] },
    { key: 'innodb_buffer_pool', name: 'InnoDB Buffer Pool', kind: 'chart',
      desc: 'The "InnoDB Buffer Pool" pool-page breakdown donut on the Performance tab.',
      xKey: 'page_type', xLabel: 'Page type', title: 'InnoDB Buffer Pool', subtitle: 'Pool pages — Data / Free / Dirty / Misc',
      data: [{ page_type: 'Data Pages', pages: 1555 }, { page_type: 'Free Pages', pages: 6612 }, { page_type: 'Dirty Pages', pages: 0 }, { page_type: 'Misc', pages: 33 }],
      series: [{ key: 'pages', label: 'Pages', color: '#3f6fd6' }] },
    { key: 'top_wait_events', name: 'Top Wait Events', kind: 'chart',
      desc: 'The "Top Wait Events (Performance Schema)" chart on the Performance tab.',
      xKey: 'event', xLabel: 'Wait event', title: 'Top Wait Events (Performance Schema)', subtitle: 'Cumulative wait time by event',
      data: [{ event: 'innodb_log_file', ms: 8900 }, { event: 'innodb_data_file', ms: 3000 }, { event: 'sql/binlog', ms: 1800 }, { event: 'innodb_temp_file', ms: 1300 }, { event: 'sql/handler', ms: 1000 }, { event: 'innodb_dblwr_file', ms: 338 }],
      series: [{ key: 'ms', label: 'Wait Time (ms)', color: '#3f6fd6' }] },
    { key: 'row_operations', name: 'Row Operations', kind: 'chart',
      desc: 'The "Row Operations" chart on the Performance tab.',
      xKey: 'op', xLabel: 'Operation', title: 'Row Operations', subtitle: 'Handler-level row reads/inserts/updates/deletes',
      data: [{ op: 'Reads', count: 165000 }, { op: 'Inserts', count: 5100 }, { op: 'Updates', count: 0 }, { op: 'Deletes', count: 0 }],
      series: [{ key: 'count', label: 'Row Operations', color: '#3f6fd6' }] },
    { key: 'innodb_io_statistics', name: 'InnoDB I/O Statistics', kind: 'chart',
      desc: 'The "InnoDB I/O Statistics" chart on the Performance tab.',
      xKey: 'metric', xLabel: 'Metric', title: 'InnoDB I/O Statistics', subtitle: 'Data/log/page I/O counters',
      data: [{ metric: 'Data Reads', v: 1500 }, { metric: 'Data Writes', v: 13500 }, { metric: 'Log Writes', v: 9000 }, { metric: 'OS Log Fsyncs', v: 7000 }, { metric: 'Pages Read', v: 800 }, { metric: 'Pages Written', v: 5500 }],
      series: [{ key: 'v', label: 'Count', color: '#3f6fd6' }] },
    { key: 'top_tables_by_size', name: 'Top 10 Tables by Size', kind: 'chart',
      desc: 'The "Top 10 Tables by Size (MB)" chart on the Databases tab.',
      xKey: 'table', xLabel: 'Table', title: 'Top 10 Tables by Size (MB)', subtitle: 'Data + index size per table',
      data: [{ table: 'quotation', data_mb: 38.0, index_mb: 5.17 }, { table: 'employee_records', data_mb: 37.06, index_mb: 0.5 }, { table: 'rental', data_mb: 2.4, index_mb: 0.26 }, { table: 'payment', data_mb: 1.9, index_mb: 0.23 }],
      series: [{ key: 'data_mb', label: 'Data', color: '#3f6fd6' }, { key: 'index_mb', label: 'Index', color: '#8b5cf6' }] },
  ],
  postgresql: [
    { key: 'host_resources', name: 'Host Resources', kind: 'gauges',
      desc: 'The shared Host Resources widget (CPU/RAM/Disk) at the top of the PostgreSQL Dashboard Overview tab.',
      gauges: HOST_RESOURCES_GAUGES },
    { key: 'connection_pool', name: 'Connection Pool', kind: 'gauges',
      desc: 'A single gauge from the engine-specific row next to Host Resources (not part of it).',
      gauges: [{ icon: Wifi, label: 'Connection Pool', pct: 58, sub: '145 / 250 max' }] },
    { key: 'query_operations', name: 'Query Operations', kind: 'chart',
      desc: 'The "Query Operations (cumulative)" chart on the Overview tab.',
      xKey: 'op', xLabel: 'Statement type', title: 'Query Operations', subtitle: 'Cumulative pg_stat_database counters',
      data: [{ op: 'SELECT', count: 39400 }, { op: 'INSERT', count: 7100 }, { op: 'UPDATE', count: 5200 }, { op: 'DELETE', count: 940 }],
      series: [{ key: 'count', label: 'Executions', color: '#3f6fd6' }] },
    { key: 'database_size_distribution', name: 'Database Size Distribution', kind: 'chart',
      desc: 'The "Database Size Distribution" chart — click a bar to open its tables.',
      xKey: 'db', xLabel: 'Database', title: 'Database Size Distribution', subtitle: 'Per-database size, largest first',
      data: [{ db: 'appdb', mb: 2980 }, { db: 'reporting', mb: 1440 }, { db: 'staging', mb: 610 }, { db: 'postgres', mb: 80 }],
      series: [{ key: 'mb', label: 'Size (MB)', color: '#f59e0b' }] },
    { key: 'io_transaction_performance', name: 'I/O & Transaction Performance', kind: 'chart',
      desc: 'The "I/O & Transaction Performance" chart on the Performance tab.',
      xKey: 'name', xLabel: 'Metric', title: 'I/O & Transaction Performance', subtitle: 'Block I/O and tuple operations (pg_stat_database)',
      data: [{ name: 'Blks Read', v: 120000 }, { name: 'Blks Hit', v: 4300000 }, { name: 'Tup Fetched', v: 980000 }, { name: 'Tup Inserted', v: 15000 }, { name: 'Tup Updated', v: 8200 }, { name: 'Tup Deleted', v: 1100 }],
      series: [{ key: 'v', label: 'Count', color: '#3f6fd6' }] },
    { key: 'database_sizes', name: 'Database Sizes', kind: 'chart',
      desc: 'The "Database Sizes" chart on the Storage tab.',
      xKey: 'datname', xLabel: 'Database', title: 'Database Sizes', subtitle: 'Per-database size, largest first',
      data: [{ datname: 'production', size_mb: 8400 }, { datname: 'analytics', size_mb: 3100 }, { datname: 'staging', size_mb: 620 }],
      series: [{ key: 'size_mb', label: 'Size (MB)', color: '#8b5cf6' }] },
    { key: 'top_tables_by_size', name: 'Top Tables by Size', kind: 'chart',
      desc: 'The "Top Tables by Size" chart on the Storage tab.',
      xKey: 'relname', xLabel: 'Table', title: 'Top Tables by Size', subtitle: 'Per-table size, largest first',
      data: [{ relname: 'orders', mb: 1450 }, { relname: 'audit_log', mb: 980 }, { relname: 'users', mb: 210 }],
      series: [{ key: 'mb', label: 'Size (MB)', color: '#f59e0b' }] },
  ],
  oracle: [
    { key: 'host_resources', name: 'Host Resources', kind: 'gauges',
      desc: 'The shared Host Resources widget (CPU/RAM/Disk) at the top of the Oracle Dashboard Overview tab.',
      gauges: HOST_RESOURCES_GAUGES },
    { key: 'sessions_pct', name: 'Sessions %', kind: 'gauges',
      desc: "Oracle's connection-pool analog — a single gauge from the engine-specific row next to Host Resources (not part of it).",
      gauges: [{ icon: Wifi, label: 'Sessions %', pct: 61, sub: '92 / 150 max' }] },
    { key: 'top_wait_events', name: 'Top Wait Events', kind: 'chart',
      desc: "Oracle's real Query-Operations analog — the Overview tab has no per-statement-type breakdown, but does chart top wait events.",
      xKey: 'event', xLabel: 'Wait event', title: 'Top Wait Events', subtitle: 'Cumulative wait time by event',
      data: [{ event: 'db file sequential read', ms: 8200 }, { event: 'log file sync', ms: 3100 }, { event: 'CPU', ms: 2600 }, { event: 'latch free', ms: 640 }],
      series: [{ key: 'ms', label: 'Wait Time (ms)', color: '#ef4444' }] },
    { key: 'tablespace_size', name: 'Tablespace Size', kind: 'chart',
      desc: "Oracle organizes storage by tablespace, not per-database — this is its Database-Size-Distribution analog.",
      xKey: 'ts', xLabel: 'Tablespace', title: 'Tablespace Size', subtitle: 'Per-tablespace size, largest first',
      data: [{ ts: 'SYSTEM', mb: 1600 }, { ts: 'USERS', mb: 4200 }, { ts: 'UNDOTBS1', mb: 900 }, { ts: 'TEMP', mb: 512 }],
      series: [{ key: 'mb', label: 'Size (MB)', color: '#f59e0b' }] },
    { key: 'cache_hit_ratios', name: 'Cache Hit Ratios', kind: 'chart',
      desc: 'The dual-series Buffer/Library Cache Hit trend on the Overview tab.',
      xKey: 't', yLabel: '%', xLabel: 'Time →', title: 'Cache Hit Ratios', subtitle: 'Buffer Cache Hit vs. Library Cache Hit',
      data: Array.from({ length: 14 }, (_, i) => ({ t: i, bufHit: Number((93 + 2 * Math.sin(i / 2)).toFixed(1)), libHit: Number((97 + 1.5 * Math.cos(i / 2.3)).toFixed(1)) })),
      series: [{ key: 'bufHit', label: 'Buffer Cache Hit', color: '#22c55e' }, { key: 'libHit', label: 'Library Cache Hit', color: '#f59e0b' }] },
    { key: 'sga_pool_breakdown', name: 'SGA Pool Breakdown', kind: 'chart',
      desc: 'The "SGA Pool Breakdown" chart on the Performance tab.',
      xKey: 'pool', xLabel: 'Pool', title: 'SGA Pool Breakdown', subtitle: 'SGA memory allocation by pool',
      data: [{ pool: 'Shared Pool', mb: 512 }, { pool: 'Buffer Cache', mb: 2048 }, { pool: 'Large Pool', mb: 128 }, { pool: 'Java Pool', mb: 64 }],
      series: [{ key: 'mb', label: 'Size (MB)', color: '#3f6fd6' }] },
    { key: 'wait_events_by_time', name: 'Wait Events by Time', kind: 'chart',
      desc: 'The "Wait Events by Time" chart on the Performance tab.',
      xKey: 'name', xLabel: 'Wait event', title: 'Wait Events by Time', subtitle: 'Time waited by event (seconds)',
      data: [{ name: 'db file sequential read', time_s: 245.6 }, { name: 'log file sync', time_s: 88.2 }, { name: 'CPU', time_s: 60.1 }, { name: 'latch free', time_s: 14.3 }],
      series: [{ key: 'time_s', label: 'Time Waited (s)', color: '#ef4444' }] },
    { key: 'sessions_by_status', name: 'Sessions by Status', kind: 'chart',
      desc: 'The "Sessions by Status" donut on the Sessions tab.',
      xKey: 'name', xLabel: 'Status', title: 'Sessions by Status', subtitle: 'Active / Inactive / Killed session counts',
      data: [{ name: 'ACTIVE', count: 12 }, { name: 'INACTIVE', count: 48 }, { name: 'KILLED', count: 1 }],
      series: [{ key: 'count', label: 'Sessions', color: '#3f6fd6' }] },
    { key: 'sessions_by_type', name: 'Sessions by Type', kind: 'chart',
      desc: 'The "Sessions by Type" donut on the Sessions tab.',
      xKey: 'name', xLabel: 'Type', title: 'Sessions by Type', subtitle: 'User vs. background session counts',
      data: [{ name: 'USER', count: 40 }, { name: 'BACKGROUND', count: 20 }],
      series: [{ key: 'count', label: 'Sessions', color: '#8b5cf6' }] },
    { key: 'tablespace_usage_distribution', name: 'Tablespace Usage Distribution', kind: 'chart',
      desc: 'The "Usage Distribution" donut on the Tablespaces tab.',
      xKey: 'name', xLabel: 'Tablespace', title: 'Tablespace Usage Distribution', subtitle: 'Used space per tablespace',
      data: [{ name: 'SYSTEM', mb: 1200 }, { name: 'USERS', mb: 4500 }, { name: 'UNDOTBS1', mb: 700 }, { name: 'TEMP', mb: 300 }],
      series: [{ key: 'mb', label: 'Used (MB)', color: '#f59e0b' }] },
    { key: 'objects_by_type', name: 'Objects by Type', kind: 'chart',
      desc: 'The "Objects by Type" chart on the Objects tab.',
      xKey: 'object_type', xLabel: 'Object type', title: 'Objects by Type', subtitle: 'Schema object counts by type',
      data: [{ object_type: 'TABLE', count: 340 }, { object_type: 'INDEX', count: 512 }, { object_type: 'VIEW', count: 88 }, { object_type: 'PACKAGE BODY', count: 46 }],
      series: [{ key: 'count', label: 'Objects', color: '#3f6fd6' }] },
    { key: 'pga_allocation_by_process', name: 'PGA Allocation by Process', kind: 'chart',
      desc: 'The "PGA Allocation by Process (Top 15)" chart on the Processes tab.',
      xKey: 'name', xLabel: 'Process', title: 'PGA Allocation by Process', subtitle: 'PGA memory per background process',
      data: [{ name: 'PMON', pga: 4.2 }, { name: 'SMON', pga: 3.8 }, { name: 'DBWn', pga: 12.8 }, { name: 'LGWR', pga: 9.1 }],
      series: [{ key: 'pga', label: 'PGA (MB)', color: '#3f6fd6' }] },
    { key: 'account_status_distribution', name: 'Account Status Distribution', kind: 'chart',
      desc: 'The "Account Status Distribution" donut on the Users tab.',
      xKey: 'name', xLabel: 'Status', title: 'Account Status Distribution', subtitle: 'User account status counts',
      data: [{ name: 'OPEN', count: 58 }, { name: 'LOCKED', count: 6 }, { name: 'EXPIRED', count: 3 }, { name: 'EXPIRED(GRACE)', count: 1 }],
      series: [{ key: 'count', label: 'Users', color: '#8b5cf6' }] },
  ],
  mssql: [
    { key: 'host_resources', name: 'Host Resources', kind: 'gauges',
      desc: 'The shared Host Resources widget (CPU/RAM/Disk) at the top of the SQL Server Dashboard Overview tab.',
      gauges: HOST_RESOURCES_GAUGES },
    { key: 'connection_pool', name: 'Connection Pool', kind: 'gauges',
      desc: 'A single gauge from the engine-specific row next to Host Resources (not part of it).',
      gauges: [{ icon: Wifi, label: 'Connection Pool', pct: 40, sub: '210 / ∞ (unlimited)' }] },
    { key: 'top_wait_types', name: 'Top Wait Types', kind: 'chart',
      desc: "SQL Server's real Query-Operations analog — the Overview tab charts top wait types (ms), not a per-statement breakdown.",
      xKey: 'wait', xLabel: 'Wait type', title: 'Top Wait Types', subtitle: 'Cumulative wait time (ms)',
      data: [{ wait: 'PAGEIOLATCH_SH', ms: 5200 }, { wait: 'CXPACKET', ms: 3400 }, { wait: 'LCK_M_S', ms: 1100 }, { wait: 'ASYNC_NETWORK_IO', ms: 420 }],
      series: [{ key: 'ms', label: 'Wait Time (ms)', color: '#ef4444' }] },
    { key: 'database_size_distribution', name: 'Database Size Distribution', kind: 'chart',
      desc: 'The real "Database Size Distribution" chart on the Storage tab.',
      xKey: 'db', xLabel: 'Database', title: 'Database Size Distribution', subtitle: 'Per-database size, largest first',
      data: [{ db: 'AppDB', mb: 3200 }, { db: 'Warehouse', mb: 1650 }, { db: 'Staging', mb: 480 }, { db: 'master', mb: 60 }],
      series: [{ key: 'mb', label: 'Size (MB)', color: '#f59e0b' }] },
    { key: 'connection_usage_pct', name: 'Connection Usage %', kind: 'chart',
      desc: 'The "Connection Usage %" sparkline on the Overview tab.',
      xKey: 't', yLabel: '%', xLabel: 'Time →', title: 'Connection Usage %', subtitle: 'Active connections as % of max',
      data: Array.from({ length: 14 }, (_, i) => ({ t: i, v: Math.round(40 + 10 * Math.sin(i / 2)) })),
      series: [{ key: 'v', label: 'Connection Usage %', color: '#0078D4' }] },
    { key: 'buffer_cache_hit_pct', name: 'Buffer Cache Hit %', kind: 'chart',
      desc: 'The "Buffer Cache Hit %" sparkline on the Overview tab.',
      xKey: 't', yLabel: '%', xLabel: 'Time →', title: 'Buffer Cache Hit %', subtitle: 'Pages served from buffer pool',
      data: Array.from({ length: 14 }, (_, i) => ({ t: i, v: Number((93 + 3 * Math.sin(i / 3)).toFixed(1)) })),
      series: [{ key: 'v', label: 'Buffer Cache Hit %', color: '#22c55e' }] },
    { key: 'cpu_usage_pct', name: 'CPU Usage %', kind: 'chart',
      desc: 'The "CPU Usage %" sparkline on the Overview tab.',
      xKey: 't', yLabel: '%', xLabel: 'Time →', title: 'CPU Usage %', subtitle: 'Host CPU utilization',
      data: Array.from({ length: 14 }, (_, i) => ({ t: i, v: Math.round(48 + 15 * Math.sin(i / 2.2)) })),
      series: [{ key: 'v', label: 'CPU Usage %', color: '#f97316' }] },
    { key: 'top_databases_by_data_size', name: 'Top Databases by Data Size', kind: 'chart',
      desc: 'The "Top Databases by Data Size (MB)" chart on the Storage tab.',
      xKey: 'name', xLabel: 'Database', title: 'Top Databases by Data Size (MB)', subtitle: 'Data + log size per database',
      data: [{ name: 'AdventureWorks', data: 4200, log: 350 }, { name: 'SalesDB', data: 1800, log: 120 }, { name: 'master', data: 60, log: 8 }],
      series: [{ key: 'data', label: 'Data', color: '#0078D4' }, { key: 'log', label: 'Log', color: '#38bdf8' }] },
    { key: 'top_tables_by_total_size', name: 'Top 10 Tables by Total Size', kind: 'chart',
      desc: 'The "Top 10 Tables by Total Size (MB)" chart on the Storage tab.',
      xKey: 'name', xLabel: 'Table', title: 'Top 10 Tables by Total Size (MB)', subtitle: 'Data + index size per table',
      data: [{ name: 'dbo.Orders', data: 850, idx: 210 }, { name: 'dbo.Customers', data: 430, idx: 95 }, { name: 'sales.Transactions', data: 280, idx: 60 }],
      series: [{ key: 'data', label: 'Data', color: '#0078D4' }, { key: 'idx', label: 'Index', color: '#4f46e5' }] },
  ],
  mongodb: [
    { key: 'host_resources', name: 'Host Resources', kind: 'gauges',
      desc: 'The shared Host Resources widget (CPU/RAM/Disk) at the top of the MongoDB Dashboard Overview tab.',
      gauges: HOST_RESOURCES_GAUGES },
    { key: 'connection_pct', name: 'Connection %', kind: 'gauges',
      desc: "MongoDB's connection-pool analog — a single gauge from the engine-specific row next to Host Resources (not part of it).",
      gauges: [{ icon: Wifi, label: 'Connection %', pct: 35, sub: '140 current / 400 available' }] },
    { key: 'opcounters', name: 'Opcounters', kind: 'chart',
      desc: "MongoDB's real Query-Operations analog — the Opcounters (cumulative) chart.",
      xKey: 'op', xLabel: 'Operation', title: 'Opcounters', subtitle: 'Cumulative op counters since server start',
      data: [{ op: 'insert', count: 1200 }, { op: 'query', count: 9800 }, { op: 'update', count: 2100 }, { op: 'delete', count: 340 }, { op: 'getmore', count: 610 }, { op: 'command', count: 15400 }],
      series: [{ key: 'count', label: 'Ops', color: '#3f6fd6' }] },
    { key: 'top_collections', name: 'Top Collections by Size', kind: 'chart',
      desc: 'MongoDB organizes storage by collection, not a single per-database total — its Database-Size-Distribution analog.',
      xKey: 'coll', xLabel: 'Collection', title: 'Top Collections by Size', subtitle: 'Per-collection size (MB), largest first',
      data: [{ coll: 'orders', mb: 1840 }, { coll: 'events', mb: 3100 }, { coll: 'users', mb: 620 }, { coll: 'sessions', mb: 210 }],
      series: [{ key: 'mb', label: 'Size (MB)', color: '#f59e0b' }] },
    { key: 'wiredtiger_tickets', name: 'WiredTiger Tickets', kind: 'gauges',
      desc: 'The Cache Used / Read Tickets / Write Tickets / Cache Dirty gauges on the WiredTiger tab.',
      gauges: [
        { icon: MemoryStick, label: 'Cache Used %', pct: 72, sub: 'WiredTiger cache used' },
        { icon: Wifi, label: 'Read Tickets Used %', pct: 18, sub: '23 / 128 available' },
        { icon: Activity, label: 'Write Tickets Used %', pct: 9, sub: '12 / 128 available' },
        { icon: AlertTriangle, label: 'WT Cache Dirty %', pct: 3, sub: 'Dirty bytes in cache' },
      ] },
    { key: 'transaction_rates', name: 'Transaction Rates', kind: 'gauges',
      desc: 'The Commit Rate / Abort Rate gauges on the Transactions tab.',
      gauges: [
        { icon: Zap, label: 'Commit Rate', pct: 96, sub: '4801 / 5000 committed' },
        { icon: AlertTriangle, label: 'Abort Rate', pct: 4, sub: '199 / 5000 aborted' },
      ] },
    { key: 'opcounters_breakdown', name: 'Opcounters Breakdown', kind: 'chart',
      desc: 'The "Opcounters Breakdown" chart on the Operations tab.',
      xKey: 'op', xLabel: 'Operation', title: 'Opcounters Breakdown', subtitle: 'Cumulative op counters since server start',
      data: [{ op: 'Insert', count: 15234 }, { op: 'Query', count: 892345 }, { op: 'Update', count: 44021 }, { op: 'Delete', count: 1203 }, { op: 'Getmore', count: 33012 }, { op: 'Command', count: 502341 }],
      series: [{ key: 'count', label: 'Ops', color: '#3f6fd6' }] },
    { key: 'replication_lag_per_secondary', name: 'Replication Lag per Secondary', kind: 'chart',
      desc: 'The "Replication Lag per Secondary (seconds)" chart on the Replication tab.',
      xKey: 'member', xLabel: 'Secondary', title: 'Replication Lag per Secondary (seconds)', subtitle: 'Oplog lag per replica set member',
      data: [{ member: 'mongo-secondary-1:27017', lag_seconds: 2 }, { member: 'mongo-secondary-2:27017', lag_seconds: 8 }],
      series: [{ key: 'lag_seconds', label: 'Lag (s)', color: '#f59e0b' }] },
    { key: 'oplog_operation_breakdown', name: 'Oplog Operation Breakdown', kind: 'chart',
      desc: 'The "Oplog Operation Breakdown" donut on the Oplog tab.',
      xKey: 'name', xLabel: 'Op type', title: 'Oplog Operation Breakdown', subtitle: 'Oplog entries by operation type',
      data: [{ name: 'insert', count: 4021 }, { name: 'update', count: 8833 }, { name: 'delete', count: 120 }, { name: 'command', count: 45 }, { name: 'noop', count: 900 }],
      series: [{ key: 'count', label: 'Entries', color: '#8b5cf6' }] },
    { key: 'chunk_distribution_per_shard', name: 'Chunk Distribution per Shard', kind: 'chart',
      desc: 'The "Chunk Distribution per Shard" chart on the Sharding tab.',
      xKey: 'shard', xLabel: 'Shard', title: 'Chunk Distribution per Shard', subtitle: 'Chunk counts per shard',
      data: [{ shard: 'shard0000', count: 120 }, { shard: 'shard0001', count: 340 }, { shard: 'shard0002', count: 89 }],
      series: [{ key: 'count', label: 'Chunks', color: '#3f6fd6' }] },
    { key: 'transaction_state_distribution', name: 'Transaction State Distribution', kind: 'chart',
      desc: 'The "Transaction State Distribution" chart on the Transactions tab.',
      xKey: 'name', xLabel: 'State', title: 'Transaction State Distribution', subtitle: 'Current transactions by state',
      data: [{ name: 'Active', count: 2 }, { name: 'Open', count: 5 }, { name: 'Inactive', count: 1 }, { name: 'Prepared', count: 0 }],
      series: [{ key: 'count', label: 'Transactions', color: '#8b5cf6' }] },
  ],
  clickhouse: [
    { key: 'host_resources', name: 'Host Resources', kind: 'gauges',
      desc: 'The shared Host Resources widget (CPU/RAM/Disk) at the top of the ClickHouse Dashboard Overview tab.',
      gauges: HOST_RESOURCES_GAUGES },
    { key: 'query_rate', name: 'Query Rate', kind: 'gauges',
      desc: 'ClickHouse pools no client connections — Query Rate is its closest activity gauge, used here in place of Connection Pool. From the engine-specific row next to Host Resources (not part of it).',
      gauges: [{ icon: Activity, label: 'Query Rate', pct: 30, sub: 'queries/s (normalized)' }] },
    { key: 'query_type_distribution', name: 'Query Type Distribution', kind: 'chart',
      desc: "ClickHouse's real Query-Operations analog — the Query Type Distribution chart on the Queries tab.",
      xKey: 'type', xLabel: 'Query type', title: 'Query Type Distribution', subtitle: 'Query counts by type',
      data: [{ type: 'SELECT', count: 4200 }, { type: 'INSERT', count: 310 }, { type: 'FAILED', count: 12 }],
      series: [{ key: 'count', label: 'Queries', color: '#3f6fd6' }] },
    { key: 'top_databases_by_size', name: 'Top Databases by Size', kind: 'chart',
      desc: 'The real "Top Databases by Size" chart on the Overview tab.',
      xKey: 'db', xLabel: 'Database', title: 'Top Databases by Size', subtitle: 'Per-database size, largest first',
      data: [{ db: 'analytics', mb: 8600 }, { db: 'logs', mb: 4100 }, { db: 'default', mb: 320 }, { db: 'system', mb: 90 }],
      series: [{ key: 'mb', label: 'Size (MB)', color: '#f59e0b' }] },
    { key: 'memory_pct_trend', name: 'Memory %', kind: 'chart',
      desc: 'The "Memory %" sparkline on the Overview tab.',
      xKey: 't', yLabel: '%', xLabel: 'Time →', title: 'Memory %', subtitle: 'Host memory utilization',
      data: Array.from({ length: 14 }, (_, i) => ({ t: i, v: Math.round(58 + 8 * Math.sin(i / 2.4)) })),
      series: [{ key: 'v', label: 'Memory %', color: '#eab308' }] },
    { key: 'query_rate_trend', name: 'Query Rate Trend', kind: 'chart',
      desc: 'The "Query Rate" sparkline on the Overview tab (distinct from the Query Rate gauge above).',
      xKey: 't', yLabel: 'q/s', xLabel: 'Time →', title: 'Query Rate', subtitle: 'Queries per second',
      data: Array.from({ length: 14 }, (_, i) => ({ t: i, v: Number((12 + 4 * Math.sin(i / 2)).toFixed(1)) })),
      series: [{ key: 'v', label: 'Queries/s', color: '#f59e0b' }] },
    { key: 'total_parts_trend', name: 'Total Parts', kind: 'chart',
      desc: 'The "Total Parts" sparkline on the Overview tab.',
      xKey: 't', xLabel: 'Time →', title: 'Total Parts', subtitle: 'MergeTree part count over time',
      data: Array.from({ length: 14 }, (_, i) => ({ t: i, v: Math.round(1200 + 300 * Math.sin(i / 2.6)) })),
      series: [{ key: 'v', label: 'Parts', color: '#f97316' }] },
    { key: 'elapsed_distribution', name: 'Elapsed Distribution (top 20)', kind: 'chart',
      desc: 'The "Elapsed Distribution (top 20)" chart on the Slow Queries tab.',
      xKey: 'rank', xLabel: 'Query rank', title: 'Elapsed Distribution (top 20)', subtitle: 'Query duration by rank',
      data: [{ rank: '#1', ms: 6300 }, { rank: '#2', ms: 1520 }, { rank: '#3', ms: 890 }, { rank: '#4', ms: 250 }],
      series: [{ key: 'ms', label: 'Duration (ms)', color: '#ef4444' }] },
    { key: 'database_size_comparison', name: 'Database Size Comparison', kind: 'chart',
      desc: 'The "Database Size Comparison (non-empty)" chart on the Databases tab.',
      xKey: 'name', xLabel: 'Database', title: 'Database Size Comparison (non-empty)', subtitle: 'Non-empty databases by size',
      data: [{ name: 'default', mb: 2300 }, { name: 'system', mb: 890 }],
      series: [{ key: 'mb', label: 'Size (MB)', color: '#3f6fd6' }] },
  ],
  infra: [
    { key: 'host_resources', name: 'Host Resources', kind: 'gauges',
      desc: 'The CPU / Memory / Disk gauges on the Infra host Overview tab.',
      gauges: [
        { icon: Cpu, label: 'CPU Utilization', pct: 44, sub: 'of host CPU' },
        { icon: MemoryStick, label: 'Memory Utilization', pct: 67, sub: 'of host RAM' },
        { icon: HardDrive, label: 'Disk Usage', pct: 79, sub: 'busiest mount' },
      ] },
    { key: 'top_processes_cpu', name: 'Top Processes by CPU', kind: 'chart',
      desc: 'The real "Top processes by CPU" widget on the Overview tab.',
      xKey: 'proc', xLabel: 'Process', title: 'Top Processes by CPU', subtitle: 'Per-process CPU usage',
      data: [{ proc: 'postgres', cpu: 22 }, { proc: 'node', cpu: 14 }, { proc: 'java', cpu: 9 }, { proc: 'sshd', cpu: 1 }],
      series: [{ key: 'cpu', label: 'CPU %', color: '#3f6fd6' }] },
    { key: 'process_cpu_vs_memory', name: 'Process CPU vs Memory', kind: 'chart',
      desc: 'The real "Process CPU vs Memory" scatter — each dot is a running process. Infra hosts have no Query Operations / Database Size Distribution concept.',
      xKey: 'proc', title: 'Process CPU vs Memory', subtitle: 'Each point is a running process',
      data: [{ proc: 'postgres', cpu: 22, mem: 340 }, { proc: 'node', cpu: 14, mem: 210 }, { proc: 'java', cpu: 9, mem: 580 }, { proc: 'sshd', cpu: 1, mem: 12 }],
      series: [{ key: 'cpu', label: 'CPU %', color: '#3f6fd6' }, { key: 'mem', label: 'Memory (MB)', color: '#8b5cf6' }] },
  ],
  cosmosdb: [
    { key: 'health_score', name: 'Health Score', kind: 'gauges',
      desc: "The real Actmon AI composite gauge on the Cosmos DB Overview tab. Cosmos DB isn't host-based, so it has no 4-gauge Host Resources row.",
      gauges: [{ icon: Zap, label: 'Health Score', pct: 88, sub: 'Actmon AI composite score' }] },
    { key: 'ru_consumed', name: 'RU Consumed', kind: 'chart',
      desc: 'The real "RU consumed" trend chart. Cosmos DB has no Query Operations / Database Size Distribution concept — it bills by Request Units.',
      xKey: 't', yLabel: 'RU', xLabel: 'Time →', title: 'RU Consumed', subtitle: 'Request Units consumed per interval',
      data: Array.from({ length: 14 }, (_, i) => ({ t: i, v: Math.round(400 + 120 * Math.sin(i / 2) + (i > 9 ? 60 : 0)) })),
      series: [{ key: 'v', label: 'RU consumed', color: '#0ea5e9' }] },
  ],
};

// Chart-type tree picker — mirrors a demo gallery's sidebar: an "Overview"
// label, a collapsible category with branch-line connectors, and a "Soon"
// badge on any type that isn't built yet (see BUILT_STYLES in TrendChart.jsx).
// Picking an unbuilt one shows "not built yet" in the preview rather than
// faking a look nobody has approved — real design comes one type at a time.
function ChartTypeGallery({ categories, selectedKey, onSelect, renderPreview }) {
  const [collapsed, setCollapsed] = useState({});
  const allOptions = categories.flatMap((c) => c.options);
  const active = allOptions.find((o) => o.key === selectedKey) || allOptions[0];
  return (
    <div className="flex flex-col md:flex-row md:items-start gap-3 mb-4">
      {/* Flex siblings stretch to match height by default — with many
          categories now (Line/Area/Column/Pie/Scatter/Combinations/3D/
          Gauges), expanding one pushed this sidebar tall enough to drag the
          preview panel (and the gauge centered inside it) down with it.
          md:items-start keeps the preview panel's height independent of the
          sidebar; its own scroll keeps a fully-expanded sidebar from
          growing the page layout without bound. */}
      <div className="md:w-64 flex-shrink-0 rounded-xl border border-indigo-100 bg-indigo-50/60 p-3 md:max-h-[520px] md:overflow-y-auto">
        <p className="text-[11px] font-bold text-indigo-500 mb-2">Overview</p>
        {categories.map((cat) => {
          const isCollapsed = collapsed[cat.title];
          return (
            <div key={cat.title}>
              <button onClick={() => setCollapsed((c) => ({ ...c, [cat.title]: !c[cat.title] }))}
                className="w-full flex items-center justify-between px-2 py-1.5 rounded-lg hover:bg-white/60 transition-colors">
                <span className="text-[13px] font-black text-slate-800">{cat.title}</span>
                <ChevronDown size={14} className={`text-slate-500 transition-transform ${isCollapsed ? '-rotate-90' : ''}`} />
              </button>
              {!isCollapsed && (
                <div className="ml-3 border-l-2 border-indigo-200 pl-3 mt-0.5 space-y-0.5">
                  {cat.options.map((opt) => {
                    const isActive = opt.key === selectedKey;
                    return (
                      <button key={opt.key} onClick={() => onSelect(opt.key)}
                        className={`w-full text-left px-2.5 py-1.5 rounded-md text-[12.5px] transition-colors flex items-center justify-between gap-2 ${
                          isActive ? 'bg-white shadow-sm font-bold text-blue-700 ring-1 ring-blue-200' : 'text-indigo-700 hover:bg-white/70'}`}>
                        <span className="truncate">{opt.name}</span>
                        {!opt.built && <span className="text-[9px] font-black text-amber-500 uppercase flex-shrink-0">Soon</span>}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="flex-1 rounded-xl border border-slate-200 p-4 flex flex-col">
        <div className="flex-1 min-h-[440px] flex items-center pointer-events-none">
          <div className="w-full">{renderPreview(active.key)}</div>
        </div>
        <p className="text-[12px] text-slate-500 leading-snug mt-2 pt-2 border-t border-slate-100">
          {active.desc}
          {!active.built && ' Tell me how you\'d like this one to look and I\'ll build it.'}
        </p>
      </div>
    </div>
  );
}

// Compact metric-card: small trend chart + colored legend rows with a bold
// value under each series — mirrors the dense multi-widget grid a real
// monitoring dashboard uses, so the chosen chart style previews the way it'll
// actually look across several small panels, not just one large one.
function MiniTrendCard({ card, chartStyle }) {
  const series = [{ key: 'a', label: card.sub, color: '#3f6fd6' }];
  if (card.color2) series.push({ key: 'b', label: card.color2, color: '#8b5cf6' });
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-3">
      <p className="text-[11px] font-bold text-slate-600 mb-1.5 truncate">{card.title}</p>
      <div className="h-14 -mx-1">
        <TrendChart styleOverride={chartStyle} data={card.data} series={series} height={56} showLegend={false} yDomain={['auto', 'auto']} />
      </div>
      <div className="mt-2 pt-2 border-t border-slate-100 flex flex-wrap gap-x-4 gap-y-1">
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full inline-block flex-shrink-0" style={{ background: '#3f6fd6' }} />
          <div className="leading-tight">
            <p className="text-[9.5px] text-slate-400">{card.sub}</p>
            <p className="text-[13px] font-black text-slate-800">{card.value}</p>
          </div>
        </div>
        {card.color2 && (
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full inline-block flex-shrink-0" style={{ background: '#8b5cf6' }} />
            <div className="leading-tight">
              <p className="text-[9.5px] text-slate-400">{card.color2}</p>
              <p className="text-[13px] font-black text-slate-800">{card.v2}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function DashboardAppearanceSection() {
  const [selectedScope, setSelectedScope] = useState('all');
  const {
    indicatorStyle, chartStyle, displayMode, isOverridden, loading, saving, map, saveScope, resetScope,
  } = useDashboardAppearance(selectedScope);

  const [draftChart, setDraftChart] = useState(chartStyle);
  const [draftMode, setDraftMode] = useState(displayMode);
  const [saveMsg, setSaveMsg] = useState(null);

  const scopeLabel = SCOPES.find((s) => s.key === selectedScope)?.label || selectedScope;
  const scopeWidgets = SCOPE_WIDGETS[selectedScope] || SCOPE_WIDGETS.all;
  const [selectedWidgetKey, setSelectedWidgetKey] = useState(null);
  const selectedWidget = scopeWidgets.find((w) => w.key === selectedWidgetKey) || scopeWidgets[0];
  const chartWidget = selectedWidget?.kind === 'chart' ? selectedWidget : null;

  useEffect(() => {
    setDraftChart(chartStyle);
    setDraftMode(displayMode);
  }, [chartStyle, displayMode, selectedScope]);

  const draftChartBuilt = CHART_CATEGORIES.flatMap((c) => c.options).find((o) => o.key === draftChart)?.built !== false;

  const handleSave = () => {
    if (!draftChartBuilt) {
      setSaveMsg({ ok: false, text: 'This chart type isn\'t built yet — pick a different one before saving.' });
      return;
    }
    saveScope(selectedScope, { indicatorStyle, chartStyle: draftChart, displayMode: draftMode })
      .then(() => {
        const scopeLabel = SCOPES.find((s) => s.key === selectedScope)?.label || selectedScope;
        setSaveMsg({ ok: true, text: `Saved — applied to ${scopeLabel}.` });
        setTimeout(() => setSaveMsg(null), 4000);
      })
      .catch((e) => setSaveMsg({ ok: false, text: errMsg(e) }));
  };

  const handleReset = () => {
    resetScope(selectedScope)
      .then(() => setSaveMsg({ ok: true, text: `Reverted — now following the global "All technologies" default.` }))
      .catch((e) => setSaveMsg({ ok: false, text: errMsg(e) }));
  };

  if (loading) {
    return (
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-12 flex items-center justify-center">
        <RefreshCw size={20} className="animate-spin text-slate-400" />
      </div>
    );
  }

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
      <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100" style={{ borderLeft: '4px solid #3f6fd6' }}>
        <div className="flex items-center gap-3">
          <LayoutDashboard size={18} className="text-blue-600" />
          <div>
            <h3 className="font-black text-slate-800 text-sm">Dashboard Appearance</h3>
            <p className="text-xs text-slate-400 mt-0.5">Gauges, graphs and trend charts — set one default for everything, or override per database technology.</p>
          </div>
        </div>
      </div>

      <div className="p-6 space-y-8">
        {/* Scope selector */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs font-bold text-slate-500 uppercase tracking-wide">Apply to</p>
            {selectedScope !== 'all' && (
              <button onClick={handleReset} disabled={saving || !map[selectedScope]}
                className="text-[11px] font-bold text-slate-400 hover:text-red-500 disabled:opacity-40 disabled:hover:text-slate-400 flex items-center gap-1">
                <RotateCcw size={11} /> Reset to global default
              </button>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {SCOPES.map((s) => {
              const active = selectedScope === s.key;
              const customized = s.key !== 'all' && Boolean(map[s.key]);
              return (
                <button key={s.key} onClick={() => setSelectedScope(s.key)}
                  className={`relative h-8 px-3.5 rounded-lg text-xs font-bold transition-colors ${active ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}>
                  {s.label}
                  {customized && <span className={`absolute -top-1 -right-1 w-2 h-2 rounded-full ${active ? 'bg-white' : 'bg-blue-500'}`} />}
                </button>
              );
            })}
          </div>
          {selectedScope !== 'all' && !map[selectedScope] && (
            <p className="text-[11px] text-slate-400 mt-2">Currently following the global "All technologies" default — change anything below and save to give {SCOPES.find((s) => s.key === selectedScope)?.label} its own style.</p>
          )}
        </div>

        {/* Widget picker — makes the Live Preview sections below show a
            specific REAL widget exactly as it looks on the selected
            technology's actual dashboard, instead of a generic mockup.
            Preview-only: style is still saved once per scope, not per widget. */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs font-bold text-slate-500 uppercase tracking-wide">Preview widget</p>
            <p className="text-[11px] text-slate-400">{scopeLabel} dashboard</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {scopeWidgets.map((w) => {
              const active = w.key === selectedWidget?.key;
              return (
                <button key={w.key} onClick={() => setSelectedWidgetKey(w.key)}
                  className={`h-8 px-3.5 rounded-lg text-xs font-bold transition-colors ${active ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}>
                  {w.name}
                </button>
              );
            })}
          </div>
          {selectedWidget?.desc && (
            <p className="text-[11px] text-slate-400 mt-2">{selectedWidget.desc}</p>
          )}
        </div>

        {/* Current preview — the selected widget exactly as it looks today
            (this scope's currently-saved indicator/chart style), no picker.
            Pick a new Chart style below to see how it would change. */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs font-bold text-slate-500 uppercase tracking-wide">Current preview</p>
            <p className="text-[11px] text-slate-400">{selectedWidget?.name} — {scopeLabel} dashboard, as it looks today</p>
          </div>
          <div className="bg-slate-50 rounded-xl border border-slate-100 p-5">
            {selectedWidget?.kind === 'gauges' ? (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3">
                {selectedWidget.gauges.map((g) => (
                  <Gauge key={g.label} styleOverride={indicatorStyle} displayModeOverride={displayMode}
                    historyOverride={displayMode === 'graph' ? SAMPLE_HISTORY : undefined}
                    chartStyleOverride={chartStyle}
                    icon={g.icon} label={g.label} pct={g.pct} sub={g.sub} />
                ))}
              </div>
            ) : (
              <TrendChart styleOverride={chartStyle} data={selectedWidget?.data} xKey={selectedWidget?.xKey || 't'}
                series={selectedWidget?.series} height={260} yDomain={selectedWidget?.yDomain || ['auto', 'auto']}
                xLabel={selectedWidget?.xLabel} yLabel={selectedWidget?.yLabel}
                title={selectedWidget?.title} subtitle={selectedWidget?.subtitle} />
            )}
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs font-bold text-slate-500 uppercase tracking-wide">Chart style</p>
            <p className="text-[11px] text-slate-400">Select a style to preview it on {selectedWidget?.kind === 'chart' ? `"${selectedWidget.name}"` : 'a sample trend panel'}</p>
          </div>
          <ChartTypeGallery categories={CHART_CATEGORIES} selectedKey={draftChart} onSelect={setDraftChart}
            renderPreview={(key) => {
              const typeName = CHART_CATEGORIES.flatMap((c) => c.options).find((o) => o.key === key)?.name || key;
              if (chartWidget) {
                return (
                  <TrendChart styleOverride={key} data={chartWidget.data} xKey={chartWidget.xKey || 't'} series={chartWidget.series}
                    height={320} yDomain={chartWidget.yDomain || ['auto', 'auto']} xLabel={chartWidget.xLabel} yLabel={chartWidget.yLabel}
                    title={chartWidget.title} subtitle={chartWidget.subtitle}
                    caption={`Preview of the "${typeName}" style on the real "${chartWidget.name}" widget from the ${scopeLabel} dashboard.`} />
                );
              }
              if (key === 'barh') {
                return (
                  <TrendChart styleOverride={key} data={SAMPLE_BAR_CATEGORIES} xKey="engine" series={SAMPLE_BAR_SERIES}
                    height={320} yDomain={['auto', 'auto']} xLabel="Connections"
                    title="Connections by Engine" subtitle="Source: Actmon sample data"
                    caption={`Preview of the "${typeName}" style using Actmon's own sample data — this is the same rendering every trend panel across the app will use once you save it.`} />
                );
              }
              if (key === 'bubble') {
                return (
                  <TrendChart styleOverride={key} data={SAMPLE_BUBBLE} xKey="latency"
                    series={[{ key: 'connections', label: 'Active Connections', color: '#3f6fd6' }]}
                    sizeKey="errors" labelKey="code" xThreshold={25} yThreshold={35} zoneLabel="Safe zone"
                    height={320} xLabel="Avg Query Latency (ms)" yLabel="Active Connections"
                    title="Server Health — Latency vs. Load" subtitle="Bubble size = error count"
                    caption={`Preview of the "${typeName}" style using Actmon's own sample data — this is the same rendering every trend panel across the app will use once you save it.`} />
                );
              }
              if (key === 'gantt') {
                return (
                  <TrendChart styleOverride={key} data={SAMPLE_GANTT} height={340}
                    title="Maintenance Plan" subtitle="Patch rollout + failover drill"
                    caption={`Preview of the "${typeName}" style using Actmon's own sample data — this is the same rendering every trend panel across the app will use once you save it.`} />
                );
              }
              return (
                <TrendChart styleOverride={key} data={SAMPLE_TREND}
                  series={[{ key: 'a', label: 'CPU Usage', color: '#22c55e' }, { key: 'b', label: 'Session Load', color: '#3f6fd6' }]}
                  height={320} yLabel="%" xLabel="Time →"
                  title="Server metrics — live trend" subtitle="CPU usage and session load combined"
                  caption={`Preview of the "${typeName}" style using Actmon's own sample data — this is the same rendering every trend panel across the app will use once you save it.`} />
              );
            }} />
          <div className="bg-slate-50 rounded-xl border border-slate-100 p-5">
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wide mb-3">Live preview — dashboard widgets</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {SAMPLE_KPI_CARDS.map((card) => (
                <MiniTrendCard key={card.title} card={card} chartStyle={draftChart} />
              ))}
            </div>
          </div>
        </div>

        {saveMsg && (
          <p className={`text-xs font-semibold ${saveMsg.ok ? 'text-emerald-600' : 'text-red-600'}`}>{saveMsg.text}</p>
        )}

        <div className="flex items-center gap-3 pt-1">
          <button onClick={handleSave} disabled={saving || !draftChartBuilt}
            title={!draftChartBuilt ? 'This chart type isn\'t built yet' : undefined}
            className="flex items-center gap-2 px-5 py-2.5 text-xs font-bold text-white rounded-lg disabled:opacity-60"
            style={{ background: 'linear-gradient(135deg,#3f6fd6,#1e3a8a)' }}>
            {saving ? <RefreshCw size={13} className="animate-spin" /> : <Save size={13} />}
            Save Changes
          </button>
          <span className="text-[11px] text-slate-400">
            {selectedScope === 'all' ? 'Applies to every technology that has no override of its own.' : `Applies only to ${SCOPES.find((s) => s.key === selectedScope)?.label}.`}
          </span>
        </div>
      </div>
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
  const { user } = useAuthStore();
  const isSuperAdmin = user?.role === 'Super Admin';
  const [active, setActive] = useState('appearance');
  const [q, setQ] = useState('');
  const [openSection, setOpenSection] = useState('brightness');

  const GROUPS = [
    { id: 'appearance', title: 'Appearance', icon: Palette },
    { id: 'dashboard',  title: 'Dashboard',  icon: LayoutDashboard },
    { id: 'smtp',       title: 'SMTP Email',  icon: Mail },
    ...(isSuperAdmin ? [{ id: 'monitoring', title: 'Detection Speed', icon: Sliders }] : []),
    { id: 'data',       title: 'Data & Telemetry', icon: Database },
    { id: 'about',      title: 'About',       icon: ShieldAlert },
  ];

  // Appearance is an accordion: collapsed header names; click to reveal controls.
  // Sections may hold several sub-controls (e.g. Sidebar → colour / menu / style).
  const APPEARANCE = [
    { id: 'brightness', title: 'Brightness', desc: 'Dim or brighten the whole screen — Low, High, or a custom level.', icon: Sun, kw: 'brightness dim light screen low high custom glare night',
      rows: [{ type: 'slider', key: 'brightness' }] },
    { id: 'theme', title: 'Color theme', desc: 'Light, dim, dark — or follow your system.', icon: Moon, kw: 'theme dark light dim mode color system',
      rows: [{ type: 'segment', key: 'theme', options: [['light', 'Light', Sun], ['dim', 'Dim', Monitor], ['dark', 'Dark', Moon], ['system', 'System', Laptop]] }] },
    { id: 'accent', title: 'Accent color', desc: 'Primary highlight color used across the UI.', icon: Palette, kw: 'accent color primary highlight brand',
      rows: [{ type: 'accent', key: 'accent' }] },
    { id: 'sidebar', title: 'Sidebar', desc: 'Colour, menu layout and preset style of the left navigation.', icon: PanelLeft, kw: 'sidebar colour color menu move adjust style navigation collapse labels icons',
      rows: [
        { title: 'Colour', desc: 'Custom sidebar background colour (overrides the style below).', type: 'swatch', key: 'sidebarColor', presets: ['#201F1E', '#0b1220', '#0f2438', '#1e293b', '#3730a3', '#134e4a'], clearable: true },
        { title: 'Hide menu names', desc: 'Collapse the sidebar to icons only.', type: 'toggle', key: 'sidebarLabels', invert: true },
        { title: 'Move / collapse menu', desc: 'Start with a compact icon sidebar.', type: 'toggleUI' },
        { title: 'Sidebar style', desc: 'Preset colour used when no custom colour is set.', type: 'segment', key: 'sidebarStyle', options: [['slate', 'Slate'], ['midnight', 'Midnight'], ['ocean', 'Ocean'], ['match', 'Accent']] },
      ] },
    { id: 'topbar', title: 'Topbar', desc: 'Background colour of the top bar (text auto-adjusts).', icon: LayoutDashboard, kw: 'topbar top bar header colour color background',
      rows: [{ title: 'Colour', desc: 'Top bar background colour.', type: 'swatch', key: 'topbarColor', presets: ['#FFFFFF', '#F8FAFC', '#0f172a', '#1e293b', '#1e40af', '#0e7490'], clearable: false }] },
    { id: 'size', title: 'Interface size', desc: 'Make everything a bit smaller or larger.', icon: Sliders, kw: 'size scale font zoom text bigger smaller',
      rows: [{ type: 'segment', key: 'fontScale', options: [['compact', 'Compact'], ['default', 'Default'], ['large', 'Large']] }] },
    { id: 'font', title: 'Font style', desc: 'Typeface used throughout the app.', icon: Sliders, kw: 'font typeface family serif mono rounded',
      rows: [{ type: 'segment', key: 'fontStyle', options: [['system', 'System'], ['rounded', 'Rounded'], ['serif', 'Serif'], ['mono', 'Mono']] }] },
    { id: 'radius', title: 'Corner roundness', desc: 'How rounded cards and buttons look.', icon: Sliders, kw: 'corner radius rounded sharp shape',
      rows: [{ type: 'segment', key: 'radius', options: [['sharp', 'Sharp'], ['default', 'Default'], ['round', 'Round']] }] },
    { id: 'contrast', title: 'High contrast', desc: 'Stronger text contrast for easier reading.', icon: Sliders, kw: 'contrast accessibility readable bold',
      rows: [{ type: 'toggle', key: 'contrast' }] },
    { id: 'motion', title: 'Reduce motion', desc: 'Minimise animations and transitions.', icon: Sliders, kw: 'motion animation accessibility reduce',
      rows: [{ type: 'toggle', key: 'reduceMotion' }] },
  ];

  const ROWS = [
    { group: 'dashboard', title: 'Refresh interval', desc: 'How often live widgets poll for data.', kw: 'refresh interval poll rate seconds', type: 'select', key: 'refreshInterval', num: true, options: [[15, '15 seconds'], [30, '30 seconds'], [60, '60 seconds'], [300, '5 minutes']] },
    { group: 'dashboard', title: 'Toast notifications', desc: 'Show real-time pop-up notifications.', kw: 'toast notification popup alert', type: 'toggle', key: 'toasts' },
    { group: 'data', title: 'Audit log retention', desc: 'How long to keep audit and history logs.', kw: 'retention audit log data history', type: 'select', key: 'retention', num: true, options: [[30, '30 days'], [90, '90 days'], [180, '180 days'], [365, '1 year']] },
    { group: 'data', title: 'Automatic discovery', desc: 'Periodically scan for new resources.', kw: 'discovery scan auto agents', type: 'toggle', key: 'autoDiscovery' },
  ];

  const control = (r) => {
    if (r.type === 'swatch') return <ColorField value={s[r.key]} presets={r.presets} clearable={r.clearable} onChange={(v) => s.update({ [r.key]: v })} />;
    if (r.type === 'toggle') { const v = r.invert ? !s[r.key] : s[r.key]; return <Toggle checked={!!v} onChange={(nv) => s.update({ [r.key]: r.invert ? !nv : nv })} />; }
    if (r.type === 'toggleUI') return <Toggle checked={!sidebarOpen} onChange={(nv) => setSidebarOpen(!nv)} />;
    if (r.type === 'segment') return <Segment value={s[r.key]} options={r.options} onChange={(v) => s.update({ [r.key]: v })} />;
    if (r.type === 'accent') return <AccentPicker value={s.accent} onChange={(v) => s.update({ accent: v })} />;
    if (r.type === 'slider') return <BrightnessSlider value={s[r.key]} onChange={(v) => s.update({ [r.key]: v })} />;
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

  // flatten the appearance accordion so its controls are searchable too
  const appFlat = APPEARANCE.flatMap((sec) =>
    sec.rows.map((r) => ({
      ...r, group: 'appearance', kw: sec.kw,
      title: sec.rows.length > 1 ? `${sec.title}: ${r.title}` : sec.title,
      desc: r.desc || sec.desc,
    })));
  const ql = q.trim().toLowerCase();
  const matches = ql ? [...appFlat, ...ROWS].filter((r) => (r.title + ' ' + r.desc + ' ' + r.kw).toLowerCase().includes(ql)) : [];
  const activeGroup = GROUPS.find((g) => g.id === active);
  const card = (children) => <div className="bg-brand-surface rounded-2xl border border-brand-border shadow-sm px-5">{children}</div>;

  const AccordionSection = (sec) => {
    const open = openSection === sec.id;
    const Icon = sec.icon;
    return (
      <div key={sec.id} className="bg-brand-surface rounded-2xl border border-brand-border shadow-sm mb-3 overflow-hidden">
        <button onClick={() => setOpenSection(open ? null : sec.id)}
          className="w-full flex items-center gap-3 px-5 py-4 text-left hover:bg-slate-500/[0.04] transition-colors">
          <div className="w-9 h-9 rounded-lg bg-brand-primary-light flex items-center justify-center flex-shrink-0"><Icon size={17} className="text-brand-primary" /></div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold text-brand-text-primary">{sec.title}</p>
            <p className="text-xs text-brand-text-secondary mt-0.5 truncate">{sec.desc}</p>
          </div>
          <ChevronRight size={18} className={`text-slate-400 flex-shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
        </button>
        {open && (
          <div className="border-t border-brand-border px-5">
            {sec.rows.length === 1 ? (
              <div className="py-4 flex justify-end">{control(sec.rows[0])}</div>
            ) : sec.rows.map((r, i) => (
              <div key={r.title || r.key || i} className="py-4 border-b border-brand-border last:border-0 flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-brand-text-primary">{r.title}</p>
                  {r.desc && <p className="text-xs text-brand-text-secondary mt-0.5">{r.desc}</p>}
                </div>
                <div className="flex-shrink-0">{control(r)}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

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
          <div className="w-full">
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
                  : active === 'monitoring' && isSuperAdmin ? <MonitoringSettingsSection />
                  : active === 'about' ? <AboutCards />
                  : active === 'appearance' ? APPEARANCE.map(AccordionSection)
                  : active === 'dashboard' ? (
                    <>
                      {card(ROWS.filter((r) => r.group === active).map(Row))}
                      <div className="mt-6"><DashboardAppearanceSection /></div>
                    </>
                  )
                  : card(ROWS.filter((r) => r.group === active).map(Row))}
              </>
            )}
          </div>
        </main>
      </div>
    </div>
  );
};
