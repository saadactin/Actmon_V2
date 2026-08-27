import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import { useConfirmExit, useWizardStep } from '@/hooks/useWizard';
import { X, Zap, Info, Plus, ChevronDown, Check, Loader2 } from 'lucide-react';
import { createExternalCheck } from '@/api/digitalExperience';

const INTERVAL_SECONDS = {
  '1 minute': 60, '5 minutes': 300, '10 minutes': 600,
  '15 minutes': 900, '30 minutes': 1800, '1 hour': 3600,
};

const REGIONS = ['North America (AWS)', 'Europe (AWS)', 'South America (AWS)', 'Asia (AWS)', 'Australia and Oceania (AWS)'];
const COUNTRIES = [
  { flag: '🇺🇸', name: 'United States (AWS)' }, { flag: '🇩🇪', name: 'Germany (AWS)' },
  { flag: '🇧🇷', name: 'Brazil (AWS)' }, { flag: '🇯🇵', name: 'Japan (AWS)' },
  { flag: '🇬🇧', name: 'United Kingdom (AWS)' }, { flag: '🇦🇺', name: 'Australia (AWS)' },
  { flag: '🇨🇦', name: 'Canada (AWS)' }, { flag: '🇸🇪', name: 'Sweden (AWS)' },
];
const CITIES = [
  { flag: '🇺🇸', name: 'N. Virginia (AWS)' }, { flag: '🇺🇸', name: 'Oregon (AWS)' },
  { flag: '🇩🇪', name: 'Frankfurt (AWS)' }, { flag: '🇧🇷', name: 'São Paulo (AWS)' },
  { flag: '🇯🇵', name: 'Tokyo (AWS)' }, { flag: '🇬🇧', name: 'London (AWS)' },
  { flag: '🇦🇺', name: 'Sydney (AWS)' }, { flag: '🇨🇦', name: 'Central (AWS)' },
];
const INTERVALS = ['1 minute', '5 minutes', '10 minutes', '15 minutes', '30 minutes', '1 hour'];
const STEPS = ['Basics', 'Availability', 'Summary'];

// Browser-window "W.W.W" illustration (matches the ActMon left panel).
function WebsiteArt() {
  return (
    <svg viewBox="0 0 210 160" className="w-full max-w-[220px]" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="8" y="8" width="194" height="144" rx="12" fill="#e9ebf0" />
      <path d="M8 20a12 12 0 0 1 12-12h170a12 12 0 0 1 12 12v14H8z" fill="#c9ccd6" />
      <g fill="#f4f5f8"><circle cx="26" cy="21" r="3.5" /><circle cx="38" cy="21" r="3.5" /><circle cx="50" cy="21" r="3.5" /></g>
      <rect x="150" y="16" width="42" height="10" rx="5" fill="#eef0f4" />
      <g transform="translate(105 96)">
        <circle r="42" fill="#bfe4e8" />
        <g stroke="#2aa9b8" strokeWidth="2.5" fill="none"><ellipse rx="42" ry="16" /><ellipse rx="16" ry="42" /><path d="M-42 0h84M0 -42v84" /></g>
        <text x="0" y="7" textAnchor="middle" fontSize="22" fontWeight="800" fill="#2aa9b8" fontFamily="Arial">W.W.W</text>
      </g>
    </svg>
  );
}

const Toggle = ({ on, onClick }) => (
  <button type="button" onClick={onClick}
    className={`relative w-10 h-[22px] rounded-full transition-colors flex-shrink-0 ${on ? 'bg-emerald-500' : 'bg-slate-300'}`}>
    <span className={`absolute top-[3px] w-4 h-4 rounded-full bg-white transition-all ${on ? 'left-[21px]' : 'left-[3px]'}`} />
  </button>
);

const Check2 = ({ on, onClick, label }) => (
  <label className="flex items-center gap-2.5 cursor-pointer select-none" onClick={onClick}>
    <span className={`w-[18px] h-[18px] rounded flex items-center justify-center border transition-colors ${on ? 'bg-blue-600 border-blue-600' : 'bg-white border-slate-300'}`}>
      {on && <Check size={13} className="text-white" strokeWidth={3} />}
    </span>
    <span className="text-[15px] text-slate-700">{label}</span>
  </label>
);

const Radio = ({ on, onClick, label }) => (
  <label className="flex items-center gap-2 cursor-pointer select-none" onClick={onClick}>
    <span className={`w-[18px] h-[18px] rounded-full border-2 flex items-center justify-center ${on ? 'border-blue-600' : 'border-slate-300'}`}>
      {on && <span className="w-2.5 h-2.5 rounded-full bg-blue-600" />}
    </span>
    <span className="text-[15px] text-slate-700">{label}</span>
  </label>
);

const Field = ({ label, required, children }) => (
  <div>
    <label className="block text-[15px] font-bold text-slate-700 mb-1.5">{label}{required && <span className="text-rose-500"> *</span>}</label>
    {children}
  </div>
);

// Collapsible accordion section (Authentication, Headers, POST Data, …).
function Section({ title, info, children, open, onToggle }) {
  return (
    <div className="border-t border-slate-200">
      <button type="button" onClick={onToggle} className="w-full flex items-center gap-2 py-3.5 text-left">
        <ChevronDown size={18} className={`text-slate-500 transition-transform ${open ? '' : '-rotate-90'}`} />
        <span className="text-[15px] font-bold text-slate-700">{title}</span>
        {info && <Info size={14} className="text-slate-400" />}
      </button>
      {open && <div className="pb-4 pl-1">{children}</div>}
    </div>
  );
}

export default function AddWebsiteWizard() {
  const navigate = useNavigate();

  /* Step in the URL so a reload returns to it. These steps are 1-based. */
  const [step, setStep] = useWizardStep({ initial: 1, min: 1, max: STEPS.length });
  /* Browser Back would discard the check being defined; ask first. */
  const exit = useConfirmExit(true);
  const close = () => { exit.release(); navigate('/agents/setup/digital-experience'); };
  // Basics
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [availMon, setAvailMon] = useState(true);
  const [rum, setRum] = useState(false);
  const [tags, setTags] = useState([]);
  // Availability
  const [http, setHttp] = useState(false);
  const [https, setHttps] = useState(true);
  const [mode, setMode] = useState('regions');
  const [locations, setLocations] = useState(['North America (AWS)']);
  const [locOpen, setLocOpen] = useState(false);
  const [privateProbe, setPrivateProbe] = useState('');
  const [interval, setIntervalV] = useState('1 minute');
  const [auth, setAuth] = useState({ user: '', pass: '' });
  const [userAgent] = useState('actmon/1.0 (www.actin.co.in/actmon-observability)');
  const [postData, setPostData] = useState('');
  const [checkOp, setCheckOp] = useState('Contains');
  const [checkVal, setCheckVal] = useState('');
  const [outage, setOutage] = useState('default');
  const [ssl, setSsl] = useState(false);
  const [insecure, setInsecure] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [sections, setSections] = useState({ auth: false, ua: false, headers: false, post: false, str: false, outage: true });
  const sec = (k) => setSections((s) => ({ ...s, [k]: !s[k] }));

  const options = mode === 'regions' ? REGIONS.map((r) => ({ name: r })) : mode === 'countries' ? COUNTRIES : CITIES;
  const protoCount = (http ? 1 : 0) + (https ? 1 : 0);
  const uptimeCount = locations.length * Math.max(protoCount, 1);

  const toggleLoc = (n) => setLocations((ls) => ls.includes(n) ? ls.filter((x) => x !== n) : [...ls, n]);
  const setModeSafe = (m) => { setMode(m); setLocations([]); setLocOpen(false); };

  const canNext1 = name.trim() && url.trim() && (availMon || rum);
  const canNext2 = protoCount > 0 && locations.length > 0;

  const basics = (
    <div className="space-y-6 max-w-[760px]">
      <Field label="Name" required>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="What is the name of your website?"
          className="w-full h-11 px-3.5 rounded-md border border-slate-300 text-[15px] focus:border-blue-500 focus:ring-2 focus:ring-blue-100 outline-none" />
      </Field>
      <Field label="URL" required>
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="URL to your website?"
          className="w-full h-11 px-3.5 rounded-md border border-slate-300 text-[15px] focus:border-blue-500 focus:ring-2 focus:ring-blue-100 outline-none" />
      </Field>
      <div>
        <label className="block text-[15px] font-bold text-slate-700 mb-3">Monitoring Options<span className="text-rose-500"> *</span></label>
        <div className="space-y-3">
          <div className="flex items-center gap-2.5">
            <Toggle on={availMon} onClick={() => setAvailMon((v) => !v)} />
            <span className="text-[15px] text-slate-700">Availability Monitoring</span>
            <Info size={14} className="text-slate-400" />
          </div>
          <div className="flex items-center gap-2.5">
            <Toggle on={rum} onClick={() => setRum((v) => !v)} />
            <span className="text-[15px] text-slate-700">Real User Monitoring</span>
            <Info size={14} className="text-slate-400" />
          </div>
        </div>
      </div>
      <div>
        <label className="block text-[15px] font-bold text-slate-700 mb-2">Tags</label>
        <div className="flex flex-wrap items-center gap-2">
          {tags.map((t, i) => (
            <span key={i} className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md bg-slate-100 text-[13px] text-slate-700">
              {t}<button onClick={() => setTags((ts) => ts.filter((_, j) => j !== i))}><X size={13} /></button>
            </span>
          ))}
          <button onClick={() => { const t = window.prompt('Add tag (key:value)'); if (t) setTags((ts) => [...ts, t]); }}
            className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md border border-slate-300 text-[12px] font-black uppercase tracking-wide text-slate-700 hover:bg-slate-50">
            <Plus size={14} /> Add Tag
          </button>
        </div>
      </div>
    </div>
  );

  const availability = (
    <div className="max-w-[900px]">
      <Field label="Protocol" required>
        <div className="space-y-2.5 mt-1">
          <Check2 on={http} onClick={() => setHttp((v) => !v)} label="HTTP" />
          <Check2 on={https} onClick={() => setHttps((v) => !v)} label="HTTPS" />
        </div>
      </Field>

      <div className="mt-6">
        <label className="block text-[15px] font-bold text-slate-700">Test From<span className="text-rose-500"> *</span></label>
        <p className="text-[13px] text-slate-500 mt-2 mb-2">Public Locations</p>
        <div className="flex items-center gap-8 mb-3">
          <Radio on={mode === 'regions'} onClick={() => setModeSafe('regions')} label="Regions" />
          <Radio on={mode === 'countries'} onClick={() => setModeSafe('countries')} label="Countries" />
          <Radio on={mode === 'cities'} onClick={() => setModeSafe('cities')} label="Cities" />
        </div>
        {/* multiselect */}
        <div className="relative">
          <div onClick={() => setLocOpen((v) => !v)}
            className="min-h-[44px] w-full px-2 py-1.5 rounded-md border border-slate-300 flex flex-wrap items-center gap-1.5 cursor-pointer">
            {locations.length === 0 && <span className="text-[15px] text-slate-400 px-1.5">Select Location…</span>}
            {locations.map((l) => (
              <span key={l} className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded bg-cyan-50 text-cyan-800 text-[13px] border border-cyan-200">
                {l}<button onClick={(e) => { e.stopPropagation(); toggleLoc(l); }}><X size={13} /></button>
              </span>
            ))}
            <ChevronDown size={18} className="text-slate-400 ml-auto mr-1" />
          </div>
          {locOpen && (
            <div className="absolute z-20 mt-1 w-full rounded-md border border-slate-200 bg-white shadow-lg max-h-64 overflow-y-auto py-1">
              {options.map((o) => (
                <button key={o.name} onClick={() => { toggleLoc(o.name); }}
                  className={`w-full flex items-center gap-2.5 px-3.5 py-2.5 text-left text-[15px] hover:bg-slate-50 ${locations.includes(o.name) ? 'bg-blue-50 text-blue-700' : 'text-slate-700'}`}>
                  {o.flag && <span className="text-[17px]">{o.flag}</span>}{o.name}
                </button>
              ))}
            </div>
          )}
        </div>

        <p className="text-[13px] text-slate-500 mt-4 mb-1.5">Private Probes</p>
        <div className="relative">
          <select value={privateProbe} onChange={(e) => setPrivateProbe(e.target.value)}
            className="w-full h-11 px-3.5 rounded-md border border-slate-300 text-[15px] text-slate-500 appearance-none outline-none focus:border-blue-500">
            <option value="">Select Private Probe…</option>
          </select>
          <ChevronDown size={18} className="text-slate-400 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
        </div>
      </div>

      <div className="mt-6">
        <label className="block text-[15px] font-bold text-slate-700 mb-1.5">Test Interval<span className="text-rose-500"> *</span></label>
        <div className="relative">
          <select value={interval} onChange={(e) => setIntervalV(e.target.value)}
            className="w-full h-11 px-3.5 rounded-md border border-slate-300 text-[15px] appearance-none outline-none focus:border-blue-500">
            {INTERVALS.map((i) => <option key={i}>{i}</option>)}
          </select>
          <ChevronDown size={18} className="text-slate-400 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
        </div>
        <p className="text-[14px] text-slate-500 mt-3 flex items-center gap-1.5">Uptime checks count: <span className="font-bold text-slate-700">{uptimeCount}</span> <Info size={13} className="text-slate-400" /></p>
      </div>

      <div className="mt-5">
        <Section title="Authentication" open={sections.auth} onToggle={() => sec('auth')}>
          <div className="grid grid-cols-2 gap-3">
            <input value={auth.user} onChange={(e) => setAuth((a) => ({ ...a, user: e.target.value }))} placeholder="Username"
              className="h-11 px-3.5 rounded-md border border-slate-300 text-[15px] outline-none focus:border-blue-500" />
            <input value={auth.pass} type="password" onChange={(e) => setAuth((a) => ({ ...a, pass: e.target.value }))} placeholder="Password"
              className="h-11 px-3.5 rounded-md border border-slate-300 text-[15px] outline-none focus:border-blue-500" />
          </div>
        </Section>
        <Section title="User-Agent Header" open={sections.ua} onToggle={() => sec('ua')}>
          <div className="flex items-center gap-3">
            <input value={userAgent} readOnly className="flex-1 h-11 px-3.5 rounded-md border border-slate-200 bg-slate-50 text-[14px] text-slate-500 outline-none" />
            <button className="h-11 px-5 rounded-md border border-slate-300 text-[12px] font-black uppercase tracking-wide text-slate-700 hover:bg-slate-50">Edit</button>
          </div>
        </Section>
        <Section title="Request Headers" open={sections.headers} onToggle={() => sec('headers')}>
          <button className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md border border-slate-300 text-[12px] font-black uppercase tracking-wide text-slate-700 hover:bg-slate-50">
            <Plus size={14} /> Add Header
          </button>
        </Section>
        <Section title="POST Data" info open={sections.post} onToggle={() => sec('post')}>
          <textarea value={postData} onChange={(e) => setPostData(e.target.value)} rows={4}
            className="w-full px-3.5 py-2.5 rounded-md border border-slate-300 text-[15px] outline-none focus:border-blue-500 resize-y" />
        </Section>
        <Section title="Check for String" open={sections.str} onToggle={() => sec('str')}>
          <div className="flex items-center gap-3">
            <div className="relative w-56">
              <select value={checkOp} onChange={(e) => setCheckOp(e.target.value)}
                className="w-full h-11 px-3.5 rounded-md border border-slate-300 text-[15px] appearance-none outline-none focus:border-blue-500">
                <option>Contains</option><option>Does not contain</option>
              </select>
              <ChevronDown size={18} className="text-slate-400 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            </div>
            <input value={checkVal} onChange={(e) => setCheckVal(e.target.value)}
              className="flex-1 h-11 px-3.5 rounded-md border border-slate-300 text-[15px] outline-none focus:border-blue-500" />
          </div>
        </Section>
        <Section title="Outage Configuration" open={sections.outage} onToggle={() => sec('outage')}>
          <div className="flex items-center gap-8 mb-4">
            <Radio on={outage === 'default'} onClick={() => setOutage('default')} label="Default" />
            <Radio on={outage === 'custom'} onClick={() => setOutage('custom')} label="Custom" />
          </div>
          <div className="text-[15px] text-slate-600 flex flex-wrap items-center gap-2 leading-8">
            The Website is considered down if it is unavailable from
            <span className="relative">
              <select disabled={outage === 'default'} className="h-9 pl-3 pr-8 rounded-md border border-slate-300 text-[14px] appearance-none disabled:bg-slate-100 disabled:text-slate-400 outline-none">
                <option>Any</option><option>All</option>
              </select>
              <ChevronDown size={16} className="text-slate-400 absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none" />
            </span>
            of the selected test locations within
            <input disabled={outage === 'default'} defaultValue={2} className="w-16 h-9 px-3 rounded-md border border-slate-300 text-[14px] disabled:bg-slate-100 disabled:text-slate-400 outline-none" />
            consecutive test intervals.
          </div>
          <div className="mt-4 rounded-md border border-blue-200 bg-blue-50 px-4 py-3 flex items-start gap-2.5">
            <Info size={16} className="text-blue-500 mt-0.5 flex-shrink-0" />
            <p className="text-[14px] text-slate-600">Test locations are Cities, Countries, and Regions. Every location contains one or more <span className="text-blue-600">probes</span>.</p>
          </div>
          <p className="text-[14px] text-slate-500 mt-3">To learn more about outages and more in depth details please visit our <span className="text-blue-600">documentation</span>.</p>
        </Section>
        <div className="border-t border-slate-200 pt-4 space-y-3">
          <div className="flex items-center gap-2.5">
            <Toggle on={ssl} onClick={() => setSsl((v) => !v)} />
            <span className="text-[15px] text-slate-700">SSL/TLS certificate monitoring</span>
            <Info size={14} className="text-slate-400" />
          </div>
          <Check2 on={insecure} onClick={() => setInsecure((v) => !v)} label="Allow insecure renegotiation" />
        </div>
      </div>
    </div>
  );

  const Row = ({ label, value }) => (
    <div className="flex gap-4 py-2.5 border-b border-slate-100">
      <span className="w-52 flex-shrink-0 text-[14px] font-bold text-slate-500">{label}</span>
      <span className="text-[15px] text-slate-800 break-all">{value || <span className="text-slate-400">—</span>}</span>
    </div>
  );
  const summary = (
    <div className="max-w-[760px]">
      <h3 className="text-[17px] font-black text-slate-800 mb-2">Review your website</h3>
      <p className="text-[15px] text-slate-500 mb-5">Confirm the configuration below, then create the website monitor.</p>
      <div className="rounded-xl border border-slate-200 p-5">
        <Row label="Name" value={name} />
        <Row label="URL" value={url} />
        <Row label="Monitoring" value={[availMon && 'Availability', rum && 'Real User'].filter(Boolean).join(', ')} />
        <Row label="Protocol" value={[http && 'HTTP', https && 'HTTPS'].filter(Boolean).join(', ')} />
        <Row label="Test locations" value={`${locations.join(', ')} (${mode})`} />
        <Row label="Test interval" value={interval} />
        <Row label="Uptime checks" value={String(uptimeCount)} />
        <Row label="SSL/TLS monitoring" value={ssl ? 'Enabled' : 'Disabled'} />
        <Row label="Tags" value={tags.join(', ')} />
      </div>
    </div>
  );

  const next = () => setStep(Math.min(STEPS.length, step + 1));
  /* On step 1 there is no earlier step, so Previous closes the wizard —
     the control is then present on every step rather than appearing later. */
  const prev = () => (step > 1 ? setStep(step - 1) : close());
  const finish = async () => {
    setSaving(true); setSaveError(null);
    try {
      await createExternalCheck({
        name: name.trim(),
        check_type: 'website',
        target: url.trim(),
        interval_seconds: INTERVAL_SECONDS[interval] || 300,
        enabled: availMon,
        config: {
          protocol: https ? 'https' : 'http', protocols: [http && 'http', https && 'https'].filter(Boolean),
          rum, mode, locations, private_probe: privateProbe || null,
          auth: auth.user ? { user: auth.user } : null, // password intentionally not stored in config JSON
          post_data: postData || null,
          string_match: checkVal ? { op: checkOp, value: checkVal } : null,
          outage: { mode: outage, threshold_locations: 'Any', consecutive_intervals: 2 },
          ssl_monitoring: ssl, allow_insecure_renegotiation: insecure, tags,
        },
      });
      exit.release();
      navigate('/agents/setup/digital-experience');
    } catch (e) {
      setSaveError(e?.response?.data?.detail || e.message || 'Failed to create website monitor.');
    } finally {
      setSaving(false);
    }
  };
  const nextDisabled = (step === 1 && !canNext1) || (step === 2 && !canNext2);

  return (
    <div className="-mx-6 md:-mx-8 -mb-6 md:-mb-8 h-screen bg-white flex flex-col overflow-hidden pb-16">
      {/* Raised when the browser's Back button is pressed mid-setup. */}
      <ConfirmDialog
        open={exit.pending}
        title="Leave website check setup?"
        message={`You are on step ${step} of ${STEPS.length}. Leaving now discards this check — nothing will be monitored.`}
        confirmLabel="Yes, leave"
        cancelLabel="No, stay here"
        onConfirm={() => { exit.confirm(); navigate('/agents/setup/digital-experience'); }}
        onCancel={exit.cancel}
      />
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-3.5 border-b border-slate-200 flex-shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-md bg-gradient-to-br from-blue-500 to-sky-400 flex items-center justify-center"><Zap size={16} className="text-white" /></div>
          <span className="text-lg font-black text-slate-800">Add Website</span>
        </div>
        <button onClick={close} className="text-slate-400 hover:text-slate-700"><X size={20} /></button>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* Left panel */}
        <aside className="hidden lg:flex flex-col w-[340px] flex-shrink-0 border-r border-slate-100 px-8 py-10">
          <div className="flex justify-center pt-2"><WebsiteArt /></div>
          <h2 className="text-[26px] leading-tight font-black text-slate-800 mt-10">Website</h2>
          <p className="text-slate-500 mt-3 leading-relaxed">Measure the availability and real user experience to improve performance and identify issues before your users do.</p>
        </aside>

        {/* Right */}
        <section className="flex-1 min-w-0 flex flex-col">
          {/* Stepper */}
          <div className="px-10 pt-7 pb-5 flex-shrink-0">
            <div className="flex items-center">
              {STEPS.map((s, i) => {
                const n = i + 1;
                const done = n < step, active = n === step;
                return (
                  <React.Fragment key={s}>
                    <div className="flex flex-col items-center">
                      <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[12px] font-bold ${
                        done ? 'bg-emerald-500 text-white' : active ? 'bg-blue-600 text-white' : 'bg-white border border-slate-300 text-slate-400'}`}>
                        {done ? <Check size={14} strokeWidth={3} /> : n}
                      </div>
                      <span className={`mt-1.5 text-[13px] ${active ? 'font-black text-slate-800' : 'font-semibold text-slate-500'}`}>{s}</span>
                    </div>
                    {n < STEPS.length && <div className={`flex-1 h-[3px] mx-2 mb-5 rounded ${n < step ? 'bg-emerald-400' : n === step ? 'bg-blue-500' : 'bg-slate-200'}`} />}
                  </React.Fragment>
                );
              })}
            </div>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto px-10 pb-6">
            {step === 1 && basics}
            {step === 2 && availability}
            {step === 3 && summary}
          </div>

          {/* Footer */}
          <div className="relative flex items-center justify-between pl-10 pr-28 py-4 border-t border-slate-200 flex-shrink-0">
            <button className="text-[14px] font-semibold text-blue-600 hover:underline">Help &amp; User Guide</button>
            <div className="flex items-center gap-2">
              {step === 1 ? (
                <button onClick={close} className="h-9 px-5 rounded-md text-[13px] font-black uppercase tracking-wide text-slate-600 hover:bg-slate-50">Cancel</button>
              ) : (
                <button onClick={prev} className="h-9 px-5 rounded-md border border-slate-300 text-[13px] font-black uppercase tracking-wide text-slate-700 hover:bg-slate-50">Previous</button>
              )}
              {step < 3 ? (
                <button onClick={next} disabled={nextDisabled}
                  className="h-9 px-6 rounded-md bg-blue-600 text-white text-[13px] font-black uppercase tracking-wide hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed">Next</button>
              ) : (
                <button onClick={finish} disabled={saving}
                  className="h-9 px-6 rounded-md bg-blue-600 text-white text-[13px] font-black uppercase tracking-wide hover:bg-blue-700 disabled:opacity-60 flex items-center gap-2">
                  {saving && <Loader2 size={14} className="animate-spin" />}{saving ? 'Creating…' : 'Create'}
                </button>
              )}
            </div>
            {saveError && (
              <p className="absolute right-28 -top-8 text-[12px] font-semibold text-rose-600 bg-rose-50 border border-rose-200 rounded-md px-3 py-1.5">{saveError}</p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
