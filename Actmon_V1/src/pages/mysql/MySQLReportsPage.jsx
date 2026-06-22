import React, { useState, useRef } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft, Download, RefreshCw, Activity, Clock, Calendar,
  Server, Database, Users, Zap, HardDrive, RotateCcw,
  Shield, Lock, BarChart2, Cpu, Heart,
  CheckCircle2, AlertTriangle, XCircle, TrendingUp, FileText,
  ChevronRight, Mail, Send, Bell, X,
  Archive, AlertOctagon, Layers, Radio, Loader,
} from 'lucide-react';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, PieChart, Pie, Cell, Legend,
} from 'recharts';
import client from '../../api/client';

/* ─── palette ─── */
const C = {
  red:    '#ef4444', orange: '#F97316', amber:  '#F59E0B',
  green:  '#16a34a', blue:   '#3B82F6', purple: '#8B5CF6',
  teal:   '#14B8A6', slate:  '#64748B', cyan:   '#06B6D4',
  indigo: '#6366F1', rose:   '#F43F5E',
  mysql:  '#005b30',
};
const POOL_COLORS = [C.green, C.blue, C.orange, C.purple, C.teal, C.cyan, C.amber, C.indigo];

/* ─── period options ─── */
const PERIODS = [
  { id: 'live',    label: 'Live',    color: C.green  },
  { id: '2h',      label: '2-Hour',  color: C.blue   },
  { id: 'daily',   label: 'Daily',   color: C.indigo },
  { id: 'weekly',  label: 'Weekly',  color: C.orange },
  { id: 'monthly', label: 'Monthly', color: C.purple },
];

/* ─── fetchers ─── */
const api = (path, id, params = {}) => client.get(`/connections/mysql/${id}/${path}`, { params }).then(r => r.data);

/* ─── helpers ─── */
function fmtNum(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return `${(v/1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v/1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v/1e3).toFixed(1)}K`;
  return String(v);
}
function fmtBytes(b) {
  const v = Number(b) || 0;
  if (v > 1073741824) return `${(v/1073741824).toFixed(2)} GB`;
  if (v > 1048576)    return `${(v/1048576).toFixed(2)} MB`;
  if (v > 1024)       return `${(v/1024).toFixed(2)} KB`;
  return `${v} B`;
}
function now() {
  return new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'medium' });
}
function statusBadge(val) {
  const v = (val || '').toUpperCase();
  const good = ['YES','ACTIVE','RUNNING','OK','CONNECTED','1','TRUE','ONLINE','COMPLETED'];
  const bad  = ['NO','FAILED','ERROR','OFFLINE','0','FALSE'];
  const warn = ['WARNING','SLOW','DEGRADED','DELAYED'];
  const color = good.includes(v) ? 'bg-green-100 text-green-700 border-green-200'
    : bad.includes(v)  ? 'bg-red-100 text-red-700 border-red-200'
    : warn.includes(v) ? 'bg-amber-100 text-amber-700 border-amber-200'
    : 'bg-slate-100 text-slate-600 border-slate-200';
  return <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${color}`}>{val || '—'}</span>;
}
function pick(obj, keys, fallback = undefined) {
  for (const k of keys) {
    if (obj?.[k] !== undefined && obj?.[k] !== null && obj?.[k] !== '') return obj[k];
  }
  return fallback;
}
function procField(p, keys, fallback = '—') {
  return pick(p, keys, fallback);
}

/* ─── sub-components ─── */
function RSection({ title, icon: Icon, color = C.mysql, children, className = '', pageBreak = false }) {
  return (
    <div className={`report-card report-section bg-white rounded-xl border border-slate-200 overflow-hidden mb-4 ${pageBreak ? 'page-break' : ''} ${className}`}>
      <div className="flex items-center gap-3 px-5 py-3 border-b border-slate-100"
        style={{ borderLeft: `4px solid ${color}` }}>
        {Icon && <Icon size={15} style={{ color }} />}
        <h2 className="font-black text-slate-800 text-sm tracking-tight uppercase">{title}</h2>
      </div>
      <div className="p-5">{children}</div>
    </div>
  );
}

function KStat({ label, value, color = '#1e293b', sub }) {
  return (
    <div className="bg-slate-50 rounded-lg p-3 border border-slate-100">
      <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wide">{label}</p>
      <p className="text-lg font-black mt-0.5" style={{ color }}>{value ?? '—'}</p>
      {sub && <p className="text-[9px] text-slate-400 mt-0.5">{sub}</p>}
    </div>
  );
}

function RTable({ headers, rows, emptyMsg = 'No data' }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr className="bg-slate-50 border-y border-slate-200">
            {headers.map(h => (
              <th key={h} className="px-3 py-2 text-left text-[10px] font-bold text-slate-400 uppercase whitespace-nowrap">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={headers.length} className="text-center py-6 text-slate-400">{emptyMsg}</td></tr>
          ) : rows.map((row, i) => (
            <tr key={i} className={`border-b border-slate-100 ${i % 2 === 1 ? 'bg-slate-50/40' : ''}`}>
              {row.map((cell, j) => <td key={j} className="px-3 py-2 text-slate-700">{cell}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function UsageBar({ label, pct, used, total, color }) {
  const c = pct > 85 ? C.red : pct > 70 ? C.orange : (color || C.teal);
  return (
    <div className="mb-3">
      <div className="flex justify-between items-center mb-1">
        <span className="text-xs font-bold text-slate-700 truncate max-w-[180px]">{label}</span>
        <span className="text-xs font-black ml-2" style={{ color: c }}>{pct}%</span>
      </div>
      <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
        <div className="h-2 rounded-full transition-all" style={{ width: `${Math.min(100,pct)}%`, background: c }} />
      </div>
      <div className="flex justify-between mt-0.5 text-[10px] text-slate-400">
        <span>{used}</span><span>Total: {total}</span>
      </div>
    </div>
  );
}

/* ─── Email / Schedule Modal ─── */
function EmailScheduleModal({ id, connName, capturedPdfB64, captureErrMsg, onClose }) {
  const [tab, setTab]             = useState('send');
  const [step, setStep]           = useState('form');
  const [result, setResult]       = useState(null);
  const [recipients, setRecipients] = useState('');
  const [period, setPeriod]         = useState('24h');
  const [schedName, setSchedName]   = useState(`${connName || 'MySQL'} Daily Report`);
  const [freq, setFreq]             = useState('daily');
  const [timeH12, setTimeH12]       = useState(7);
  const [timeAmPm, setTimeAmPm]     = useState('AM');
  const [minute, setMinute]         = useState(0);
  const [dow, setDow]               = useState('0');
  const [dom, setDom]               = useState(1);
  const [schedMonth, setSchedMonth] = useState(1);

  const hour24 = () => {
    const h = Number(timeH12);
    if (timeAmPm === 'AM') return h === 12 ? 0 : h;
    return h === 12 ? 12 : h + 12;
  };

  const { data: smtpData } = useQuery({
    queryKey: ['smtp-default-modal'],
    queryFn:  () => client.get('/settings/smtp/default').then(r => r.data),
    staleTime: 60000,
  });
  const smtpCfg = smtpData?.config;

  const STEP_LABEL = { sending: 'Sending email with PDF report…' };
  const busy = step === 'sending';
  const getEmails = () => recipients.split(',').map(e => e.trim()).filter(Boolean);

  const handleSend = async () => {
    const emails = getEmails();
    if (!emails.length) { setResult({ ok: false, msg: 'Enter at least one recipient email.' }); return; }
    if (!smtpCfg) { setResult({ ok: false, msg: 'No SMTP configured. Go to Settings → SMTP Configuration first.' }); return; }
    setResult(null);
    try {
      setStep('sending');
      const res = await client.post('/mysql-report/send-email', {
        conn_id: Number(id),
        recipient_emails: emails,
        report_period: period,
        base_url: `${window.location.protocol}//${window.location.hostname}:8000`,
        pdf_base64: capturedPdfB64 || null,
        db_name: connName || null,
      });
      setResult({ ok: res.data.status !== 'error', warn: res.data.status === 'partial',
                  msg: res.data.message });
      setStep('done');
    } catch (e) {
      setResult({ ok: false, msg: e?.response?.data?.detail || e.message });
      setStep('form');
    }
  };

  const handleSchedule = async () => {
    const emails = getEmails();
    if (!emails.length) { setResult({ ok: false, msg: 'Enter at least one recipient email.' }); return; }
    if (!smtpCfg) { setResult({ ok: false, msg: 'No SMTP configured. Go to Settings → SMTP Configuration first.' }); return; }
    setStep('sending'); setResult(null);
    try {
      const res = await client.post('/mysql-report/schedules', {
        conn_id: Number(id), schedule_name: schedName,
        frequency: freq,
        hour: hour24(), minute: Number(minute),
        day_of_week: freq === 'yearly' ? String(schedMonth) : dow,
        day_of_month: Number(dom),
        recipient_emails: emails,
        report_period: period,
        base_url: `${window.location.protocol}//${window.location.hostname}:8000`,
      });
      const nextRun = res.data.next_run_at
        ? new Date(res.data.next_run_at + 'Z').toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })
        : '';
      setResult({ ok: true, msg: `Schedule "${schedName}" created! First run: ${nextRun || 'scheduled'}` });
      setStep('done');
    } catch (e) {
      setResult({ ok: false, msg: e?.response?.data?.detail || e.message });
      setStep('form');
    }
  };

  const inp = "w-full px-3 py-2 text-xs rounded-lg border border-slate-200 bg-white focus:border-green-400 focus:outline-none";
  const lbl = "block text-[11px] font-bold text-slate-500 mb-1";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.65)' }}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden">

        <div className="flex items-center justify-between px-6 py-4"
          style={{ background: 'linear-gradient(135deg,#005b30,#16a34a)' }}>
          <div className="flex items-center gap-3 text-white">
            <Mail size={18} />
            <div>
              <p className="font-black text-sm">Send MySQL Report</p>
              <p className="text-[11px] opacity-70">{connName} · PDF attached automatically</p>
            </div>
          </div>
          <button onClick={onClose} className="text-white/70 hover:text-white text-lg leading-none">✕</button>
        </div>

        <div className="flex border-b border-slate-100 bg-slate-50">
          {[['send', 'Send Now', Send], ['schedule', 'Schedule', Bell]].map(([t, lx, Ic]) => (
            <button key={t} onClick={() => { if (!busy) { setTab(t); setResult(null); }}}
              className={`flex items-center gap-2 px-5 py-2.5 text-xs font-bold transition-all ${
                tab === t ? 'bg-white border-b-2 border-green-600 text-green-700' : 'text-slate-400 hover:text-slate-600'
              }`}>
              <Ic size={13} />{lx}
            </button>
          ))}
        </div>

        {busy && (
          <div className="px-5 py-2.5 bg-green-50 border-b border-green-100 flex items-center gap-3">
            <div className="flex gap-1.5 flex-shrink-0">
              <div className={`h-1.5 rounded-full transition-all duration-500 ${
                step === 'sending' ? 'w-20 bg-green-600 animate-pulse' : 'w-6 bg-slate-200'
              }`} />
            </div>
            <p className="text-[11px] font-bold text-green-700 flex items-center gap-2">
              <RefreshCw size={11} className="animate-spin flex-shrink-0" />
              {STEP_LABEL[step]}
            </p>
          </div>
        )}

        <div className="p-5 space-y-4 overflow-y-auto" style={{ maxHeight: '60vh' }}>

          {smtpCfg ? (
            <div className="flex items-center gap-3 p-3 bg-green-50 border border-green-200 rounded-xl">
              <CheckCircle2 size={16} className="text-green-600 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-xs font-black text-green-800">{smtpCfg.name}</p>
                <p className="text-[11px] text-green-700 truncate">
                  {smtpCfg.sender_email} · via {smtpCfg.smtp_host}:{smtpCfg.smtp_port}
                </p>
              </div>
              <Link to="/settings" onClick={onClose}
                className="text-[11px] font-bold text-green-700 underline flex-shrink-0">
                Change
              </Link>
            </div>
          ) : (
            <div className="flex items-center gap-3 p-3 bg-red-50 border border-red-200 rounded-xl">
              <XCircle size={16} className="text-red-500 flex-shrink-0" />
              <div className="flex-1">
                <p className="text-xs font-black text-red-700">No SMTP configured</p>
                <p className="text-[11px] text-red-600">Set up mail server in Settings first</p>
              </div>
              <Link to="/settings" onClick={onClose}
                className="text-[11px] font-bold text-red-700 underline flex-shrink-0">
                Configure
              </Link>
            </div>
          )}

          {capturedPdfB64 ? (
            <div className="flex items-center gap-2 px-3 py-2.5 bg-green-50 border border-green-200 rounded-xl text-[11px] text-green-700">
              <CheckCircle2 size={14} className="flex-shrink-0 text-green-500" />
              <span><b>Report PDF captured</b> — exact copy of your current view will be attached.</span>
            </div>
          ) : (
            <div className="flex flex-col gap-1 px-3 py-2.5 bg-amber-50 border border-amber-200 rounded-xl text-[11px] text-amber-700">
              <div className="flex items-center gap-2">
                <AlertTriangle size={14} className="flex-shrink-0 text-amber-500" />
                <span>PDF capture failed — <b>backend will generate a report PDF</b> from live MySQL data.</span>
              </div>
              {captureErrMsg && (
                <div className="ml-6 mt-0.5 px-2 py-1 bg-amber-100 rounded text-[10px] font-mono text-amber-800 break-all">
                  {captureErrMsg}
                </div>
              )}
            </div>
          )}

          {tab === 'schedule' && (
            <div>
              <label className={lbl}>Schedule Name</label>
              <input className={inp} value={schedName} onChange={e => setSchedName(e.target.value)} />
            </div>
          )}

          <div>
            <label className={lbl}>Recipient Emails <span className="text-slate-400 font-normal">(comma-separated)</span></label>
            <input className={inp} placeholder="dba@company.com, admin@company.com"
              value={recipients} onChange={e => setRecipients(e.target.value)} />
          </div>

          <div>
            <label className={lbl}>Report Period</label>
            <select className={inp} value={period} onChange={e => setPeriod(e.target.value)}>
              <option value="live">Live (Real-Time)</option>
              <option value="1h">Last 1 Hour</option>
              <option value="24h">Last 24 Hours</option>
              <option value="7d">Last 7 Days</option>
              <option value="30d">Last 30 Days</option>
              <option value="90d">Last 90 Days</option>
              <option value="1y">Last 1 Year</option>
              <option value="custom">Custom Period</option>
            </select>
          </div>

          {tab === 'schedule' && (
            <div className="border-t border-slate-100 pt-4 space-y-3">
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Recurrence</p>

              <div>
                <label className={lbl}>Frequency</label>
                <select className={inp} value={freq} onChange={e => setFreq(e.target.value)}>
                  <option value="hourly">Every Hour</option>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                  <option value="yearly">Yearly</option>
                </select>
              </div>

              {freq !== 'hourly' && (
                <div>
                  <label className={lbl}>Send Time</label>
                  <div className="flex gap-2">
                    <select className={inp} style={{ flex: '0 0 76px' }} value={timeH12}
                      onChange={e => setTimeH12(Number(e.target.value))}>
                      {[1,2,3,4,5,6,7,8,9,10,11,12].map(h => (
                        <option key={h} value={h}>{String(h).padStart(2,'0')}</option>
                      ))}
                    </select>
                    <span className="self-center text-slate-400 font-bold">:</span>
                    <select className={inp} style={{ flex: '0 0 76px' }} value={minute}
                      onChange={e => setMinute(Number(e.target.value))}>
                      {[0,5,10,15,20,25,30,35,40,45,50,55].map(m => (
                        <option key={m} value={m}>{String(m).padStart(2,'0')}</option>
                      ))}
                    </select>
                    <div className="flex rounded-lg overflow-hidden border border-slate-200 flex-shrink-0">
                      {['AM','PM'].map(ap => (
                        <button key={ap} type="button"
                          onClick={() => setTimeAmPm(ap)}
                          className={`px-3 py-2 text-xs font-bold transition-colors ${
                            timeAmPm === ap ? 'bg-green-600 text-white' : 'bg-white text-slate-500 hover:bg-slate-50'
                          }`}>
                          {ap}
                        </button>
                      ))}
                    </div>
                  </div>
                  <p className="text-[10px] text-slate-400 mt-1">
                    = {String(hour24()).padStart(2,'0')}:{String(minute).padStart(2,'0')} UTC
                    &nbsp;({String((hour24() + 5) % 24).padStart(2,'0')}:{String(minute).padStart(2,'0')} IST approx)
                  </p>
                </div>
              )}

              {freq === 'hourly' && (
                <div>
                  <label className={lbl}>At Minute (0–59)</label>
                  <select className={inp} value={minute} onChange={e => setMinute(Number(e.target.value))}>
                    {[0,5,10,15,20,25,30,35,40,45,50,55].map(m => (
                      <option key={m} value={m}>{String(m).padStart(2,'0')} past the hour</option>
                    ))}
                  </select>
                </div>
              )}

              {freq === 'weekly' && (
                <div>
                  <label className={lbl}>Day of Week</label>
                  <select className={inp} value={dow} onChange={e => setDow(e.target.value)}>
                    {['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'].map((d,i) => (
                      <option key={i} value={String(i)}>{d}</option>
                    ))}
                  </select>
                </div>
              )}

              {freq === 'monthly' && (
                <div>
                  <label className={lbl}>Day of Month (1–28)</label>
                  <select className={inp} value={dom} onChange={e => setDom(Number(e.target.value))}>
                    {Array.from({length:28},(_,i)=>i+1).map(d=>(
                      <option key={d} value={d}>{d}</option>
                    ))}
                  </select>
                </div>
              )}

              {freq === 'yearly' && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className={lbl}>Month</label>
                    <select className={inp} value={schedMonth} onChange={e => setSchedMonth(Number(e.target.value))}>
                      {['January','February','March','April','May','June',
                        'July','August','September','October','November','December'].map((m,i)=>(
                        <option key={i} value={i+1}>{m}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className={lbl}>Day (1–28)</label>
                    <select className={inp} value={dom} onChange={e => setDom(Number(e.target.value))}>
                      {Array.from({length:28},(_,i)=>i+1).map(d=>(
                        <option key={d} value={d}>{d}</option>
                      ))}
                    </select>
                  </div>
                </div>
              )}
            </div>
          )}

          {result && (
            <div className={`rounded-xl border overflow-hidden ${
              result.ok ? 'border-green-200' : result.warn ? 'border-amber-200' : 'border-red-200'
            }`}>
              <div className={`px-4 py-3 text-xs font-semibold flex items-start gap-2 ${
                result.ok ? 'bg-green-50 text-green-800' : result.warn ? 'bg-amber-50 text-amber-800' : 'bg-red-50 text-red-800'
              }`}>
                {result.ok ? <CheckCircle2 size={14} className="flex-shrink-0 mt-0.5" />
                  : result.warn ? <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
                  : <XCircle size={14} className="flex-shrink-0 mt-0.5" />}
                <span>{result.msg}</span>
              </div>
              {(result.ok || result.warn) && (
                <div className="px-4 py-2.5 bg-slate-50 border-t border-slate-100 text-[11px] text-slate-600 space-y-1">
                  <p className="font-bold text-slate-700">📬 Not in inbox?</p>
                  <ul className="list-disc pl-4 space-y-0.5">
                    <li>Check <b>Outlook → Junk Email</b> folder → right-click → "Not Junk"</li>
                    <li>Check <b>Microsoft 365 Quarantine</b> at security.microsoft.com</li>
                    <li>PDF file: <b>MySQL_Report_{connName?.replace(/\s/g,'_')}_*.pdf</b></li>
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="px-5 py-3.5 border-t border-slate-100 flex justify-end gap-2">
          <button onClick={onClose} disabled={busy}
            className="px-4 py-2 text-xs font-semibold text-slate-600 bg-slate-100 rounded-lg hover:bg-slate-200 disabled:opacity-50">
            {step === 'done' ? 'Close' : 'Cancel'}
          </button>
          {step !== 'done' && (
            <button
              onClick={tab === 'send' ? handleSend : handleSchedule}
              disabled={busy || !smtpCfg}
              className="flex items-center gap-2 px-5 py-2 text-xs font-black text-white rounded-lg disabled:opacity-50"
              style={{ background: 'linear-gradient(135deg,#005b30,#16a34a)' }}>
              {busy ? <RefreshCw size={13} className="animate-spin" />
                : tab === 'send' ? <Send size={13} /> : <Bell size={13} />}
              {busy ? STEP_LABEL[step]
                : tab === 'send' ? 'Generate PDF & Send' : 'Create Schedule'}
            </button>
          )}
        </div>

      </div>
    </div>
  );
}

/* ─── main component ─── */
export default function MySQLReportsPage() {
  const { id } = useParams();
  const [period, setPeriod]         = useState('live');
  const [genTime, setGenTime]       = useState(now);
  const [showEmailModal, setShowEmailModal] = useState(false);
  const [capturingPdf, setCapturingPdf]     = useState(false);
  const [capturedPdfB64, setCapturedPdfB64] = useState(null);
  const [captureErrMsg, setCaptureErrMsg]   = useState(null);
  const printRef                    = useRef(null);

  const refetchInterval = period === 'live' ? 30000 : false;
  const reportParams = { period, live: period === 'live' };

  const { data: dash,  isLoading: l1, refetch: r1 } = useQuery({ queryKey: ['rpt-mysql-dash',   id, period], queryFn: () => api('dashboard',           id, reportParams), refetchInterval });
  const { data: backupD, refetch: r2 }              = useQuery({ queryKey: ['rpt-mysql-backup', id, period], queryFn: () => api('backup-info',         id, reportParams), refetchInterval });
  const { data: tableD,  refetch: r3 }              = useQuery({ queryKey: ['rpt-mysql-table',  id, period], queryFn: () => api('table-stats',         id, reportParams), refetchInterval });
  const { data: innoD,   refetch: r4 }              = useQuery({ queryKey: ['rpt-mysql-innodb', id, period], queryFn: () => api('innodb-metrics',      id, reportParams), refetchInterval });
  const { data: perfD,   refetch: r5 }              = useQuery({ queryKey: ['rpt-mysql-perf',   id, period], queryFn: () => api('performance-detail',   id, reportParams), refetchInterval });
  const { data: userD,   refetch: r6 }              = useQuery({ queryKey: ['rpt-mysql-users',  id, period], queryFn: () => api('user-stats',          id, reportParams), refetchInterval });
  const { data: slowD,   refetch: r7 }              = useQuery({ queryKey: ['rpt-mysql-slow',   id, period], queryFn: () => api('slow-queries',        id, reportParams), refetchInterval: period === 'live' ? 15000 : false });
  const { data: replD,   refetch: r8 }              = useQuery({ queryKey: ['rpt-mysql-repl',   id, period], queryFn: () => api('replication/status',  id, reportParams), refetchInterval });
  const { data: errD,    refetch: r9 }              = useQuery({ queryKey: ['rpt-mysql-errlogs',id, period], queryFn: () => api('error-logs',          id, reportParams), refetchInterval });
  const { data: idxD,    refetch: r10 }             = useQuery({ queryKey: ['rpt-mysql-idx',    id, period], queryFn: () => api('index-analysis',      id, reportParams), refetchInterval });

  const loading = l1;
  const refetchAll = () => {
    [r1, r2, r3, r4, r5, r6, r7, r8, r9, r10].forEach(fn => fn());
    setGenTime(now());
  };
  const handlePrint = () => { setGenTime(now()); setTimeout(() => window.print(), 200); };

  const openEmailModal = async () => {
    setCapturingPdf(true);
    setCapturedPdfB64(null);
    setCaptureErrMsg(null);
    let pdfB64 = null;
    let errMsg = null;

    try {
      const [htiMod, jpMod] = await Promise.all([
        import('html-to-image'),
        import('jspdf'),
      ]);
      const toCanvas = htiMod.toCanvas;
      const jsPDF    = jpMod.jsPDF;
      if (typeof toCanvas !== 'function') throw new Error('html-to-image toCanvas not available');
      if (typeof jsPDF   !== 'function') throw new Error('jsPDF import failed');

      const el = document.getElementById('mysql-report');
      if (!el) throw new Error('Element #mysql-report not found in DOM');

      window.scrollTo(0, 0);
      await new Promise(r => setTimeout(r, 100));

      const CAPTURE_PX  = 794;
      const PIXEL_RATIO = 2;
      const MH     = 12;
      const MV     = 14;
      const CONT_W = 210 - 2 * MH;
      const CONT_H = 297 - 2 * MV;

      const saved = {
        w:  el.style.width,
        mw: el.style.maxWidth,
        nw: el.style.minWidth,
        bg: el.style.background,
        ml: el.style.marginLeft,
        mr: el.style.marginRight,
      };

      const printHeader     = el.querySelector('[class*="print:block"]');
      const savedHeaderDisp = printHeader ? printHeader.style.display : '';

      el.style.width       = `${CAPTURE_PX}px`;
      el.style.maxWidth    = `${CAPTURE_PX}px`;
      el.style.minWidth    = `${CAPTURE_PX}px`;
      el.style.background  = '#ffffff';
      el.style.marginLeft  = '0';
      el.style.marginRight = '0';
      if (printHeader) printHeader.style.display = 'block';

      await new Promise(r => setTimeout(r, 300));

      const elRect = el.getBoundingClientRect();

      const unitBounds = [...el.children].map(c => {
        const r = c.getBoundingClientRect();
        return {
          top:    Math.round((r.top    - elRect.top) * PIXEL_RATIO),
          bottom: Math.round((r.bottom - elRect.top) * PIXEL_RATIO),
        };
      }).filter(b => b.bottom > b.top + 4);

      const forcedBreakTops = [...el.querySelectorAll('.page-break')].map(pb => {
        const r = pb.getBoundingClientRect();
        return Math.round((r.top - elRect.top) * PIXEL_RATIO);
      }).filter(y => y > 0);

      let canvas;
      try {
        canvas = await toCanvas(el, {
          pixelRatio:      PIXEL_RATIO,
          backgroundColor: '#ffffff',
          skipFonts:       false,
          cacheBust:       true,
          width:           CAPTURE_PX,
        });
      } catch (canvasErr) {
        throw new Error(`html-to-image threw: ${canvasErr?.message || canvasErr}`);
      } finally {
        el.style.width       = saved.w;
        el.style.maxWidth    = saved.mw;
        el.style.minWidth    = saved.nw;
        el.style.background  = saved.bg;
        el.style.marginLeft  = saved.ml;
        el.style.marginRight = saved.mr;
        if (printHeader) printHeader.style.display = savedHeaderDisp;
      }

      if (!canvas?.width || !canvas?.height) throw new Error('html-to-image returned empty canvas');

      const expectedW = CAPTURE_PX * PIXEL_RATIO;
      let workCanvas = canvas;
      if (canvas.width > expectedW + 4) {
        const cropX  = Math.round((canvas.width - expectedW) / 2);
        workCanvas   = document.createElement('canvas');
        workCanvas.width  = expectedW;
        workCanvas.height = canvas.height;
        const wCtx   = workCanvas.getContext('2d');
        wCtx.fillStyle = '#ffffff';
        wCtx.fillRect(0, 0, expectedW, canvas.height);
        wCtx.drawImage(canvas, cropX, 0, expectedW, canvas.height, 0, 0, expectedW, canvas.height);
      }

      const pdf     = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
      const pxPerMm = workCanvas.width / CONT_W;
      const pagePx  = Math.round(CONT_H * pxPerMm);
      const GAP_PX  = Math.round(16 * PIXEL_RATIO);
      const gapBreaks = unitBounds.map(b => b.bottom + Math.round(GAP_PX * 0.5));
      const pageBreaks = [0];
      let cursor = 0;

      while (cursor < workCanvas.height) {
        const windowEnd = cursor + pagePx;
        if (windowEnd >= workCanvas.height) { pageBreaks.push(workCanvas.height); break; }
        const forced = forcedBreakTops.find(y => y > cursor + GAP_PX && y <= windowEnd);
        if (forced) { pageBreaks.push(forced); cursor = forced; continue; }
        const minY    = cursor + Math.round(pagePx * 0.35);
        const choices = gapBreaks.filter(y => y > minY && y <= windowEnd);
        const breakY  = choices.length ? choices[choices.length - 1] : windowEnd;
        pageBreaks.push(breakY);
        cursor = breakY;
      }

      for (let i = 0; i < pageBreaks.length - 1; i++) {
        if (i > 0) pdf.addPage();
        const srcY = pageBreaks[i];
        const srcH = pageBreaks[i + 1] - srcY;
        if (srcH <= 0) continue;
        const slice  = document.createElement('canvas');
        slice.width  = workCanvas.width;
        slice.height = srcH;
        const ctx    = slice.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, workCanvas.width, srcH);
        ctx.drawImage(workCanvas, 0, srcY, workCanvas.width, srcH, 0, 0, workCanvas.width, srcH);
        pdf.addImage(
          slice.toDataURL('image/jpeg', 0.92), 'JPEG',
          MH, MV, CONT_W, srcH / pxPerMm,
        );
        slice.width = 0;
      }

      const dataUri  = pdf.output('datauristring');
      const b64start = dataUri.indexOf(';base64,');
      pdfB64 = b64start >= 0 ? dataUri.slice(b64start + 8) : dataUri.split(',')[1];
      if (!pdfB64) throw new Error('pdf.output returned empty base64');

    } catch (e) {
      errMsg = e?.message || String(e);
      console.error('[ActMon] PDF capture error:', errMsg);
    }

    setCapturedPdfB64(pdfB64);
    setCaptureErrMsg(errMsg);
    setCapturingPdf(false);
    setShowEmailModal(true);
  };

  /* ── derived values ── */
  const hs          = dash?.health_summary || {};
  const conn        = dash?.connection || {};
  const tables      = (tableD?.tables || []).map((t, i) => {
    const tableName = t.table || t.table_name || t.name || `Table ${i + 1}`;
    const schemaName = t.schema || t.database || t.db_name || '';
    return {
      ...t,
      tableName,
      fullTableName: schemaName ? `${schemaName}.${tableName}` : tableName,
    };
  });
  const slowQueries = slowD?.queries || slowD?.slow_queries || [];
  const errLogs     = errD?.logs || errD?.errors || [];
  const users       = userD?.users || [];
  const innoMetrics = innoD?.metrics || {};
  const replStatus  = replD?.slave_status || replD?.replica_status || {};
  const processList = dash?.process_list || [];
  const longRunning = dash?.long_running_queries || [];
  const chartData   = dash?.chart_data || {};
  const dbSizes     = chartData.db_sizes || [];
  const queryStats  = dash?.query_stats || {};
  const threads     = dash?.threads || {};
  const memory      = dash?.memory || {};
  const network     = dash?.network || {};
  const tableLocks  = dash?.table_locks || perfD?.locking || {};
  const tmpTables   = dash?.tmp_tables || perfD?.tmp_tables || {};
  const perfTables  = perfD?.table_io_stats || [];
  const topStatements = perfD?.top_statements || [];
  const waitEvents  = perfD?.wait_events || [];
  const memoryConsumers = perfD?.memory_consumers || [];
  const perfStats   = perfD?.stats || perfD?.variables || {
    qps: perfD?.query_quality?.qps,
    tps: perfD?.query_quality?.tps,
    slow_queries: perfD?.query_quality?.slow_queries,
    active_connections: perfD?.connections?.current,
    buffer_pool_hit_pct: perfD?.buffer_pool?.hit_ratio,
    tmp_disk_pct: perfD?.tmp_tables?.disk_pct,
    lock_waits: perfD?.locking?.lock_waits,
    table_contention_pct: perfD?.locking?.table_contention_pct,
  };
  const backupInfo  = backupD?.last_backup || backupD?.backup_info || {};
  const missingIdx  = idxD?.missing_index_candidates || [];
  const unusedIdx   = idxD?.unused_indexes || [];
  const duplicateIdx = idxD?.duplicate_indexes || [];
  const existingIdx = idxD?.existing_indexes || idxD?.indexes || [];
  const idxIssues   = idxD?.issues || missingIdx || unusedIdx || [];
  const idxSummary  = idxD?.summary || {};

  const activeCon   = Number(hs.active_connections || hs.threads_connected || hs.current_connections || dash?.connections_detail?.current) || 0;
  const maxCon      = Number(hs.max_connections) || 0;
  const conPct      = maxCon > 0 ? Math.min(100, Math.round(activeCon / maxCon * 100)) : 0;
  const bufHitPct   = Number(hs.buffer_pool_hit_pct || hs.buffer_hit_ratio || hs.cache_usage_pct || memory.cache_usage_pct || chartData.cache_pct) || 0;
  const slowQCnt    = Number(hs.slow_queries || queryStats.Slow_queries || perfD?.query_quality?.slow_queries) || 0;
  const dbSizeGb    = Number(hs.database_size_gb || hs.db_size_gb || hs.total_size_gb) || 0;
  const uptime      = hs.uptime || '—';
  const totalTables = hs.table_count || hs.total_tables || tables.length || '—';
  const totalDbs    = hs.total_databases || dbSizes.length || '—';
  const questionsPerSec = hs.questions_per_sec || perfD?.query_quality?.qps || 0;
  const rowsPerSec = hs.innodb_rows_per_sec || hs.rows_per_sec || perfD?.row_ops?.reads_per_sec || 0;
  const openTables = hs.open_tables || dash?.server_vars?.table_open_cache || '—';
  const commandChart = chartData.query_stats?.labels?.map((label, i) => ({
    name: label.replace('Com_', ''),
    value: Number(chartData.query_stats?.values?.[i]) || 0,
  })) || Object.entries({
    Select: queryStats.Com_select,
    Insert: queryStats.Com_insert,
    Update: queryStats.Com_update,
    Delete: queryStats.Com_delete,
  }).map(([name, value]) => ({ name, value: Number(value) || 0 }));
  const processCommandData = Object.entries(processList.reduce((acc, p) => {
    const cmd = procField(p, ['Command', 'command'], 'Unknown');
    acc[cmd] = (acc[cmd] || 0) + 1;
    return acc;
  }, {})).map(([name, value]) => ({ name, value }));
  const connectionPieData = [
    { name: 'Used', value: activeCon },
    { name: 'Free', value: Math.max(0, maxCon - activeCon) },
  ];

  const replRunning = replStatus.slave_io_running || replStatus.replica_io_running || '—';
  const replSQLRunning = replStatus.slave_sql_running || replStatus.replica_sql_running || '—';
  const replLag     = replStatus.seconds_behind_master || replStatus.seconds_behind_source || 0;

  function computeScore() {
    let s = 100;
    if (conPct > 90) s -= 30; else if (conPct > 70) s -= 15;
    if (bufHitPct < 70) s -= 25; else if (bufHitPct < 85) s -= 10;
    if (slowQCnt > 100) s -= 20; else if (slowQCnt > 20) s -= 10;
    if (replRunning === 'No') s -= 20;
    if (replLag > 60) s -= 20; else if (replLag > 10) s -= 10;
    return Math.max(0, s);
  }
  const healthScore = computeScore();

  const periodObj = PERIODS.find(p => p.id === period) || PERIODS[0];
  const connName  = dash?.connection?.name || hs?.database || `MySQL #${id}`;

  if (loading && !dash) return (
    <div className="min-h-screen flex items-center justify-center bg-[#f1f5f9]">
      <div className="text-center">
        <div className="w-12 h-12 border-4 border-green-200 border-t-green-600 rounded-full animate-spin mx-auto mb-4" />
        <p className="text-slate-600 font-semibold">Loading MySQL report…</p>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-[#f1f5f9]" id="mysql-report-root">
      {showEmailModal && (
        <EmailScheduleModal id={id} connName={connName}
          capturedPdfB64={capturedPdfB64}
          captureErrMsg={captureErrMsg}
          onClose={() => setShowEmailModal(false)} />
      )}

      {/* ─── CONTROL HEADER ─── */}
      <div className="no-print text-white shadow-xl sticky top-0 z-40"
        style={{ background: 'linear-gradient(135deg,#0f172a 0%,#005b30 55%,#064e3b 100%)' }}>
        <div className="px-6 pt-4 pb-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-4">
            <Link to={`/mysql-dashboard/${id}`}
              className="w-9 h-9 rounded-xl flex items-center justify-center transition-all"
              style={{ background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)' }}>
              <ArrowLeft size={16} />
            </Link>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center text-xl"
                style={{ background: 'rgba(22,163,74,0.25)', border: '1px solid rgba(22,163,74,0.4)' }}>🐬</div>
              <div>
                <h1 className="text-[18px] font-black tracking-tight">MySQL Monitoring Report</h1>
                <p className="text-[12px] mt-0.5" style={{ color: 'rgba(134,239,172,0.8)' }}>
                  {connName} — {conn.host || hs.host || ''}
                  {hs.version ? ` · v${hs.version}` : ''}
                </p>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex items-center gap-1 bg-white/10 rounded-xl p-1 border border-white/20">
              {PERIODS.map(p => (
                <button key={p.id} onClick={() => setPeriod(p.id)}
                  className="px-3 py-1 rounded-lg text-[11px] font-bold transition-all"
                  style={period === p.id
                    ? { background: p.color, color: '#fff', boxShadow: '0 1px 4px rgba(0,0,0,0.3)' }
                    : { color: 'rgba(255,255,255,0.6)' }}>
                  {p.label}
                </button>
              ))}
            </div>
            <button onClick={refetchAll}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all"
              style={{ background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)' }}>
              <RefreshCw size={13} /> Refresh
            </button>
            <button onClick={openEmailModal} disabled={capturingPdf}
              className="flex items-center gap-2 px-4 py-1.5 rounded-lg text-xs font-bold transition-all disabled:opacity-60"
              style={{ background: 'rgba(22,163,74,0.3)', border: '1px solid rgba(22,163,74,0.5)' }}>
              {capturingPdf
                ? <><Loader size={13} className="animate-spin" /> Preparing PDF…</>
                : <><Mail size={13} /> Send / Schedule</>}
            </button>
            <button onClick={handlePrint}
              className="flex items-center gap-2 px-4 py-1.5 rounded-lg text-xs font-bold transition-all"
              style={{ background: 'linear-gradient(135deg,#16a34a,#15803d)', border: '1px solid rgba(255,255,255,0.3)' }}>
              <Download size={13} /> Download PDF
            </button>
          </div>
        </div>

        <div className="px-6 pb-3 flex items-center gap-3">
          <span className="text-[11px] font-bold px-3 py-1 rounded-full"
            style={{ background: periodObj.color + '33', color: periodObj.color, border: `1px solid ${periodObj.color}55` }}>
            {periodObj.label} Report
          </span>
          <span className="text-[11px] text-white/50">Generated: {genTime}</span>
          {period === 'live' && (
            <span className="flex items-center gap-1.5 text-[10px] text-green-400 font-bold">
              <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />AUTO-REFRESH 30s
            </span>
          )}
          {replRunning === 'No' && (
            <span className="flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-red-500/20 text-red-300 border border-red-500/30">
              <AlertOctagon size={10} /> Replication IO Stopped
            </span>
          )}
          {slowQCnt > 20 && (
            <span className="flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30">
              <AlertTriangle size={10} /> {slowQCnt} Slow Queries
            </span>
          )}
        </div>
      </div>

      {/* ─── PRINTABLE REPORT ─── */}
      <div ref={printRef} className="max-w-[1200px] mx-auto p-5" id="mysql-report">

        {/* Print-only header */}
        <div className="hidden print:block mb-6 pb-4 border-b-2 border-slate-800">
          <div className="flex justify-between items-start">
            <div>
              <h1 className="text-2xl font-black text-slate-900">MySQL Database Monitoring Report</h1>
              <p className="text-sm text-slate-600 mt-1">
                {connName} — {conn.host || ''} {hs.version ? `· v${hs.version}` : ''}
              </p>
            </div>
            <div className="text-right">
              <p className="text-sm font-bold text-slate-700">{periodObj.label} Report</p>
              <p className="text-xs text-slate-500 mt-0.5">Generated: {genTime}</p>
              <p className="text-xs text-slate-500">Powered by Actmon</p>
            </div>
          </div>
        </div>

        {/* ══ 1. EXECUTIVE SUMMARY ══ */}
        <RSection title="Executive Summary" icon={Heart}
          color={healthScore >= 80 ? C.green : healthScore >= 60 ? C.amber : C.red}>
          <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-8 gap-3 mb-4">
            <KStat label="Health Score"     value={`${healthScore}/100`}        color={healthScore >= 80 ? C.green : healthScore >= 60 ? C.amber : C.red} />
            <KStat label="DB Status"        value={hs.status || 'RUNNING'}      color={C.green} />
            <KStat label="Uptime"           value={uptime} />
            <KStat label="Connections"      value={`${activeCon}/${maxCon}`}    color={conPct > 80 ? C.red : C.green} sub={`${conPct}% used`} />
            <KStat label="Buffer Pool Hit"  value={`${bufHitPct}%`}             color={bufHitPct < 80 ? C.red : C.green} />
            <KStat label="Slow Queries"     value={slowQCnt}                    color={slowQCnt > 50 ? C.red : slowQCnt > 10 ? C.orange : C.green} />
            <KStat label="DB Size (GB)"     value={dbSizeGb > 0 ? `${dbSizeGb.toFixed(1)}` : '—'} color={C.blue} />
            <KStat label="Replication IO"   value={replRunning}                 color={replRunning === 'Yes' ? C.green : replRunning === '—' ? C.slate : C.red} />
          </div>

          <div className="flex flex-wrap gap-2">
            {[
              { ok: true,                          label: `Status: ${hs.status || 'RUNNING'}` },
              { ok: conPct < 80,                   label: `Connections ${conPct}%` },
              { ok: bufHitPct >= 90,               label: `Buffer Hit ${bufHitPct}%` },
              { ok: slowQCnt <= 20,                label: `Slow Queries: ${slowQCnt}` },
              { ok: replRunning !== 'No',          label: `Replication IO: ${replRunning}` },
              { ok: replSQLRunning !== 'No',       label: `Replication SQL: ${replSQLRunning}` },
              { ok: Number(replLag) <= 10,         label: `Repl Lag: ${replLag}s` },
            ].map(({ ok, label }) => (
              <span key={label} className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold border ${
                ok ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-red-50 border-red-200 text-red-700'}`}>
                {ok ? <CheckCircle2 size={11} /> : <AlertTriangle size={11} />}
                {label}
              </span>
            ))}
          </div>
        </RSection>

        {/* ══ 2. DATABASE STATUS + PERFORMANCE ══ */}
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-4">
          <RSection title="Database Status" icon={Database} color={C.mysql} className="!mb-0">
            <div className="grid grid-cols-2 gap-x-6">
              {[
                ['Connection Name', connName],
                ['Host',            conn.host || hs.host || '—'],
                ['Port',            conn.port || hs.port || '3306'],
                ['Database',        conn.database_name || hs.database || '—'],
                ['MySQL Version',   hs.version || '—'],
                ['Uptime',          hs.uptime || '—'],
                ['Active Connections', activeCon],
                ['Max Connections', maxCon],
                ['Buffer Pool Hit %', `${bufHitPct}%`],
                ['Slow Query Log',  hs.slow_query_log || '—'],
                ['Binary Logging',  hs.log_bin || '—'],
                ['Default Engine',  hs.default_storage_engine || 'InnoDB'],
                ['Character Set',   hs.character_set || '—'],
                ['Collation',       hs.collation || '—'],
                ['DB Size (GB)',     dbSizeGb > 0 ? `${dbSizeGb.toFixed(2)}` : '—'],
                ['Database Count',   totalDbs],
                ['Table Count',      totalTables],
                ['Error Log Path',   dash?.error_log_path || '—'],
              ].map(([l, v]) => (
                <div key={l} className="flex items-start justify-between py-1.5 border-b border-slate-100 last:border-0 col-span-1">
                  <span className="text-[11px] text-slate-400 font-semibold flex-shrink-0">{l}</span>
                  <span className="text-[11px] font-bold text-slate-800 font-mono ml-2 text-right break-all">
                    {v ?? '—'}
                  </span>
                </div>
              ))}
            </div>
          </RSection>

          <RSection title="Performance Overview" icon={TrendingUp} color={C.blue} className="!mb-0">
            <div className="grid grid-cols-2 gap-3 mb-4">
              <KStat label="Buffer Pool Hit" value={`${bufHitPct}%`}      color={bufHitPct < 85 ? C.red : C.green} />
              <KStat label="Active Threads"  value={threads.running || activeCon} color={C.blue} />
              <KStat label="Questions/s"     value={fmtNum(questionsPerSec)} color={C.purple} />
              <KStat label="InnoDB Rows/s"   value={fmtNum(rowsPerSec)} color={C.teal} />
              <KStat label="Slow Queries"    value={slowQCnt}  color={slowQCnt > 50 ? C.red : C.green} />
              <KStat label="Open Tables"     value={fmtNum(openTables)} color={C.slate} />
            </div>
            {Object.keys(perfStats).length > 0 && (
              <ResponsiveContainer width="100%" height={140}>
                <BarChart
                  data={Object.entries(perfStats).slice(0, 6).map(([k, v]) => ({
                    name: k.replace(/_/g,' ').slice(0,18),
                    value: Number(v) || 0,
                  }))}
                  margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 8 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 9 }} tickFormatter={fmtNum} axisLine={false} tickLine={false} />
                  <Tooltip formatter={v => fmtNum(v)} />
                  <Bar dataKey="value" radius={[4,4,0,0]}>
                    {Object.keys(perfStats).slice(0,6).map((_, i) => <Cell key={i} fill={POOL_COLORS[i % POOL_COLORS.length]} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </RSection>
        </div>

        {/* ══ 3. LIVE WORKLOAD CHARTS ══ */}
        <RSection title="Live Workload Charts" icon={Activity} color={C.purple}>
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
            <div className="bg-slate-50 rounded-lg border border-slate-100 p-3">
              <p className="text-[10px] text-slate-400 font-bold uppercase mb-2">SQL Command Mix</p>
              <ResponsiveContainer width="100%" height={170}>
                <BarChart data={commandChart}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 9 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 9 }} tickFormatter={fmtNum} axisLine={false} tickLine={false} />
                  <Tooltip formatter={v => fmtNum(v)} />
                  <Bar dataKey="value" radius={[4,4,0,0]}>
                    {commandChart.map((_, i) => <Cell key={i} fill={POOL_COLORS[i % POOL_COLORS.length]} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>

            <div className="bg-slate-50 rounded-lg border border-slate-100 p-3">
              <p className="text-[10px] text-slate-400 font-bold uppercase mb-2">Connection Usage</p>
              <ResponsiveContainer width="100%" height={170}>
                <PieChart>
                  <Pie data={connectionPieData} dataKey="value" nameKey="name" innerRadius={42} outerRadius={66} paddingAngle={3}>
                    <Cell fill={conPct > 80 ? C.red : C.green} />
                    <Cell fill="#e2e8f0" />
                  </Pie>
                  <Tooltip formatter={v => fmtNum(v)} />
                  <Legend wrapperStyle={{ fontSize: 10 }} />
                </PieChart>
              </ResponsiveContainer>
            </div>

            <div className="bg-slate-50 rounded-lg border border-slate-100 p-3">
              <p className="text-[10px] text-slate-400 font-bold uppercase mb-2">Database Sizes</p>
              <ResponsiveContainer width="100%" height={170}>
                <BarChart data={dbSizes.slice(0, 8)} layout="vertical" margin={{ left: 20, right: 10 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 9 }} tickFormatter={fmtNum} axisLine={false} tickLine={false} />
                  <YAxis type="category" dataKey="name" tick={{ fontSize: 9 }} width={70} axisLine={false} tickLine={false} />
                  <Tooltip formatter={v => `${fmtNum(v)} MB`} />
                  <Bar dataKey="size_mb" fill={C.teal} radius={[0,4,4,0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">
            <KStat label="Bytes Received" value={fmtBytes(network.bytes_received)} color={C.blue} />
            <KStat label="Bytes Sent" value={fmtBytes(network.bytes_sent)} color={C.green} />
            <KStat label="Tmp Disk Tables" value={fmtNum(tmpTables.disk || tmpTables.on_disk)} color={Number(tmpTables.disk_pct) > 25 ? C.orange : C.slate} sub={`${tmpTables.disk_pct || 0}% disk`} />
            <KStat label="Table Lock Waits" value={fmtNum(tableLocks.waited || tableLocks.table_locks_waited || tableLocks.lock_waits)} color={Number(tableLocks.contention_pct || tableLocks.table_contention_pct) > 5 ? C.red : C.slate} />
          </div>
        </RSection>

        {/* ══ 3. SLOW QUERIES ══ */}
        <RSection title={`Slow Queries (${slowQCnt} total)`} icon={Clock}
          color={slowQCnt > 50 ? C.red : slowQCnt > 10 ? C.orange : C.green} pageBreak>
          {slowQueries.length === 0 ? (
            <div className="text-center py-4 flex items-center justify-center gap-2 text-green-600">
              <CheckCircle2 size={18} />
              <span className="font-bold text-sm">No slow queries captured</span>
            </div>
          ) : (
            <RTable
              headers={['Execution Time (s)', 'Rows Examined', 'Rows Sent', 'Database', 'Query Preview']}
              rows={slowQueries.slice(0, 15).map(q => [
                <span className={`font-bold ${Number(q.query_time || q.execution_time) > 5 ? 'text-red-600' : 'text-orange-600'}`}>
                  {q.query_time || q.execution_time || '—'}
                </span>,
                fmtNum(q.rows_examined),
                fmtNum(q.rows_sent),
                <span className="text-[10px] text-blue-700 font-bold">{q.db || q.database || '—'}</span>,
                <span className="font-mono text-[10px] text-slate-500 max-w-[300px] truncate block">
                  {(q.sql_text || q.query || '').slice(0, 100)}
                </span>,
              ])}
            />
          )}
        </RSection>

        {/* ══ 4. PROCESSLIST ══ */}
        <RSection title={`Processlist (${processList.length} processes)`} icon={Server} color={longRunning.length ? C.orange : C.green}>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-4">
            <KStat label="Total Processes" value={processList.length} color={C.blue} />
            <KStat label="Long Running" value={longRunning.length} color={longRunning.length ? C.red : C.green} />
            <KStat label="Threads Running" value={threads.running || 0} color={C.purple} />
            <KStat label="Threads Cached" value={threads.cached || 0} color={C.slate} />
            <KStat label="Max Used Connections" value={fmtNum(threads.max_used || 0)} color={C.teal} />
          </div>

          {processCommandData.length > 0 && (
            <div className="mb-4 bg-slate-50 rounded-lg border border-slate-100 p-3">
              <p className="text-[10px] text-slate-400 font-bold uppercase mb-2">Process Commands</p>
              <ResponsiveContainer width="100%" height={130}>
                <BarChart data={processCommandData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 9 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 9 }} allowDecimals={false} axisLine={false} tickLine={false} />
                  <Tooltip />
                  <Bar dataKey="value" fill={C.cyan} radius={[4,4,0,0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {longRunning.length > 0 && (
            <div className="mb-4">
              <p className="text-xs font-bold text-red-600 mb-2">LONG-RUNNING QUERIES</p>
              <RTable
                headers={['ID','User','Host','DB','Command','Time','State','SQL Preview']}
                rows={longRunning.slice(0, 10).map(p => [
                  <span className="font-mono text-[10px]">{procField(p, ['Id', 'id'])}</span>,
                  procField(p, ['User', 'user']),
                  <span className="font-mono text-[10px]">{procField(p, ['Host', 'host'])}</span>,
                  procField(p, ['db', 'database']),
                  statusBadge(procField(p, ['Command', 'command'])),
                  <span className="font-bold text-red-600">{procField(p, ['Time', 'time'], 0)}s</span>,
                  <span className="text-[10px]">{procField(p, ['State', 'state'])}</span>,
                  <span className="font-mono text-[10px] text-slate-500 max-w-[320px] truncate block">{String(procField(p, ['Info', 'info'], '') || '').slice(0, 140)}</span>,
                ])}
              />
            </div>
          )}

          <RTable
            headers={['ID','User','Host','DB','Command','Time','State','SQL Preview']}
            rows={processList.slice(0, 25).map(p => [
              <span className="font-mono text-[10px]">{procField(p, ['Id', 'id'])}</span>,
              procField(p, ['User', 'user']),
              <span className="font-mono text-[10px]">{procField(p, ['Host', 'host'])}</span>,
              procField(p, ['db', 'database']),
              statusBadge(procField(p, ['Command', 'command'])),
              `${procField(p, ['Time', 'time'], 0)}s`,
              <span className="text-[10px]">{procField(p, ['State', 'state'])}</span>,
              <span className="font-mono text-[10px] text-slate-500 max-w-[320px] truncate block">{String(procField(p, ['Info', 'info'], '') || '').slice(0, 140)}</span>,
            ])}
            emptyMsg="No active processes"
          />
        </RSection>

        {/* ══ 4. TABLE STATISTICS ══ */}
        <RSection title="Top Tables by Size" icon={HardDrive} color={C.teal}>
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
            <div>
              {tables.slice(0, 10).map((t, i) => {
                const dataMb = Number(t.data_mb || (t.data_length / 1048576) || 0);
                const totalMb = dataMb + Number(t.index_mb || (t.index_length / 1048576) || 0);
                const pct = totalMb > 0 ? Math.min(100, Math.round(dataMb / Math.max(totalMb, 1) * 100)) : 0;
                return (
                  <UsageBar key={i}
                    label={t.fullTableName}
                    pct={pct}
                    used={`Data: ${dataMb.toFixed(1)} MB`}
                    total={`${totalMb.toFixed(1)} MB`}
                    color={C.teal} />
                );
              })}
            </div>
            <RTable
              headers={['Table','Engine','Rows','Data (MB)','Index (MB)','Last Updated']}
              rows={tables.slice(0, 15).map(t => [
                <span className="font-bold text-teal-700 text-[11px]">{t.fullTableName}</span>,
                <span className="text-[10px] font-mono text-slate-500">{t.engine || 'InnoDB'}</span>,
                fmtNum(t.table_rows || t.rows || 0),
                <span className="font-bold">{(Number(t.data_mb || (t.data_length/1048576)) || 0).toFixed(1)}</span>,
                <span className="font-bold">{(Number(t.index_mb || (t.index_length/1048576)) || 0).toFixed(1)}</span>,
                <span className="font-mono text-[10px] text-slate-400">{(t.update_time || '—')?.toString().slice(0,10)}</span>,
              ])}
              emptyMsg="No table statistics available"
            />
          </div>
        </RSection>

        {/* ══ 5. BACKUP STATUS ══ */}
        <RSection title="Backup Status" icon={Archive}
          color={backupInfo.status === 'COMPLETED' ? C.green : C.orange} pageBreak>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <KStat label="Last Backup Status"
              value={backupInfo.status || backupInfo.backup_status || '—'}
              color={backupInfo.status === 'COMPLETED' || backupInfo.status === 'OK' ? C.green : C.orange} />
            <KStat label="Backup Date"
              value={backupInfo.backup_date?.toString().slice(0,16) || backupInfo.created_at?.toString().slice(0,16) || '—'} />
            <KStat label="Backup Type"   value={backupInfo.backup_type || backupInfo.type || '—'} color={C.blue} />
            <KStat label="Backup Size"   value={backupInfo.backup_size || backupInfo.size || '—'} color={C.purple} />
          </div>
          {backupD?.schedules?.length > 0 && (
            <>
              <p className="text-xs font-bold text-slate-500 mb-2">BACKUP SCHEDULES</p>
              <RTable
                headers={['Schedule Name','Frequency','Next Run','Status','Enabled']}
                rows={(backupD.schedules || []).slice(0, 10).map(s => [
                  <span className="font-bold text-slate-700">{s.schedule_name || s.name}</span>,
                  s.frequency || '—',
                  <span className="font-mono text-[10px]">{s.next_run_at?.slice(0,16) || '—'}</span>,
                  statusBadge(s.last_status || s.status),
                  statusBadge(s.enabled ? 'YES' : 'NO'),
                ])}
              />
            </>
          )}
          {(!backupD?.schedules?.length) && (
            <div className="text-center py-4 text-slate-400 text-sm">
              No backup schedules configured
            </div>
          )}
        </RSection>

        {/* ══ 6. REPLICATION STATUS ══ */}
        <RSection title="Replication Status" icon={Radio}
          color={replRunning === 'Yes' ? C.green : replRunning === '—' ? C.slate : C.red}>
          {!replStatus || Object.keys(replStatus).length === 0 ? (
            <div className="text-center py-4 text-slate-400 text-sm">
              No replication configured — standalone instance
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
                <KStat label="IO Thread"    value={replRunning}     color={replRunning === 'Yes' ? C.green : C.red} />
                <KStat label="SQL Thread"   value={replSQLRunning}  color={replSQLRunning === 'Yes' ? C.green : C.red} />
                <KStat label="Lag (seconds)" value={replLag}        color={Number(replLag) > 60 ? C.red : Number(replLag) > 10 ? C.orange : C.green} />
                <KStat label="Master Host"
                  value={replStatus.master_host || replStatus.source_host || '—'} color={C.blue} />
              </div>
              <div className="grid grid-cols-2 gap-x-6">
                {[
                  ['Master Log File',   replStatus.master_log_file || replStatus.source_log_file],
                  ['Read Master Log Pos', replStatus.read_master_log_pos || replStatus.read_source_log_pos],
                  ['Relay Log File',    replStatus.relay_log_file],
                  ['Relay Log Pos',     replStatus.relay_log_pos],
                  ['Exec Master Log Pos', replStatus.exec_master_log_pos || replStatus.exec_source_log_pos],
                  ['Last SQL Error',    replStatus.last_sql_error || 'None'],
                  ['Last IO Error',     replStatus.last_io_error || 'None'],
                  ['Auto Position',     replStatus.auto_position],
                ].map(([l, v]) => (
                  <div key={l} className="flex items-start justify-between py-1.5 border-b border-slate-100 last:border-0 col-span-1">
                    <span className="text-[11px] text-slate-400 font-semibold flex-shrink-0">{l}</span>
                    <span className="text-[11px] font-bold text-slate-800 font-mono ml-2 text-right break-all max-w-[200px] truncate">
                      {v ?? '—'}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </RSection>

        {/* ══ 7. INNODB STATUS ══ */}
        <RSection title="InnoDB Engine Status" icon={Cpu} color={C.cyan} pageBreak>
          {Object.keys(innoMetrics).length === 0 ? (
            <p className="text-center text-slate-400 py-4">No InnoDB metrics available</p>
          ) : (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
              <div className="grid grid-cols-2 gap-3">
                {Object.entries(innoMetrics).slice(0, 8).map(([k, v]) => (
                  <KStat key={k}
                    label={k.replace(/innodb_/g,'').replace(/_/g,' ').toUpperCase().slice(0,20)}
                    value={typeof v === 'number' ? fmtNum(v) : String(v).slice(0,12)}
                    color={C.cyan} />
                ))}
              </div>
              <RTable
                headers={['Metric', 'Value']}
                rows={Object.entries(innoMetrics).slice(0, 20).map(([k, v]) => [
                  <span className="font-semibold text-slate-600 text-[11px]">{k.replace(/_/g,' ')}</span>,
                  <span className="font-black text-slate-800">{typeof v === 'number' ? fmtNum(v) : String(v)}</span>,
                ])}
              />
            </div>
          )}
        </RSection>

        {/* ══ 8. PERFORMANCE SCHEMA DETAIL ══ */}
        <RSection title="Performance Schema Detail" icon={Zap} color={C.purple}>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <KStat label="PS Enabled" value={perfD?.ps_enabled ? 'YES' : 'NO'} color={perfD?.ps_enabled ? C.green : C.slate} />
            <KStat label="Top Statements" value={topStatements.length} color={C.purple} />
            <KStat label="Wait Events" value={waitEvents.length} color={C.orange} />
            <KStat label="Table IO Rows" value={perfTables.length} color={C.teal} />
          </div>

          {topStatements.length > 0 && (
            <div className="mb-5">
              <p className="text-xs font-bold text-slate-500 mb-2">TOP STATEMENTS BY TOTAL TIME</p>
              <RTable
                headers={['Count','Avg ms','Max ms','Rows Examined','No Index','Last Seen','SQL Digest']}
                rows={topStatements.slice(0, 10).map(s => [
                  fmtNum(s.count),
                  <span className="font-bold">{s.avg_ms}</span>,
                  <span className={Number(s.max_ms) > 1000 ? 'font-bold text-red-600' : 'font-bold'}>{s.max_ms}</span>,
                  fmtNum(s.rows_examined),
                  <span className={Number(s.no_index || s.no_good_index) > 0 ? 'text-red-600 font-bold' : 'text-green-600 font-bold'}>
                    {fmtNum((s.no_index || 0) + (s.no_good_index || 0))}
                  </span>,
                  <span className="font-mono text-[10px]">{s.last_seen || '—'}</span>,
                  <span className="font-mono text-[10px] text-slate-500 max-w-[420px] truncate block">{String(s.digest_text || '').slice(0, 150)}</span>,
                ])}
              />
            </div>
          )}

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
            <div>
              <p className="text-xs font-bold text-slate-500 mb-2">WAIT EVENTS</p>
              <RTable
                headers={['Event','Class','Count','Total ms','Avg ms']}
                rows={waitEvents.slice(0, 10).map(w => [
                  <span className="font-mono text-[10px] text-slate-600">{w.event_name}</span>,
                  w.wait_class || '—',
                  fmtNum(w.count),
                  <span className="font-bold">{w.total_ms}</span>,
                  w.avg_ms,
                ])}
                emptyMsg="No wait events available"
              />
            </div>

            <div>
              <p className="text-xs font-bold text-slate-500 mb-2">TABLE IO HOTSPOTS</p>
              <RTable
                headers={['Table','Fetch','Insert','Update','Delete','Total ms']}
                rows={perfTables.slice(0, 10).map(t => [
                  <span className="font-bold text-teal-700 text-[11px]">{t.schema}.{t.table}</span>,
                  fmtNum(t.fetch),
                  fmtNum(t.insert),
                  fmtNum(t.update),
                  fmtNum(t.delete),
                  <span className="font-bold">{t.total_ms}</span>,
                ])}
                emptyMsg="No table IO stats available"
              />
            </div>
          </div>

          {memoryConsumers.length > 0 && (
            <div className="mt-5">
              <p className="text-xs font-bold text-slate-500 mb-2">MEMORY CONSUMERS</p>
              <RTable
                headers={['Event','Current MB','High MB','Count Used']}
                rows={memoryConsumers.slice(0, 10).map(m => [
                  <span className="font-mono text-[10px] text-slate-600">{m.event_name}</span>,
                  <span className="font-bold">{m.current_mb}</span>,
                  m.high_mb,
                  fmtNum(m.count_used),
                ])}
              />
            </div>
          )}
        </RSection>

        {/* ══ 8. USER STATISTICS ══ */}
        <RSection title="User Statistics" icon={Users} color={C.indigo}>
          {users.length === 0 ? (
            <p className="text-center text-slate-400 py-4">No user statistics available</p>
          ) : (
            <RTable
              headers={['User','Host','Active Connections','Total Connections','Queries Sent']}
              rows={users.slice(0, 15).map(u => [
                <span className="font-bold text-indigo-700">{u.user || u.username || '—'}</span>,
                <span className="font-mono text-[10px] text-slate-500">{u.host || '%'}</span>,
                <span className="font-bold">{u.current_connections || u.active_connections || 0}</span>,
                fmtNum(u.total_connections || u.connections || 0),
                fmtNum(u.total_queries || u.queries_sent || 0),
              ])}
            />
          )}
        </RSection>

        {/* ══ 9. ERROR LOGS ══ */}
        <RSection title={`Error Logs (${errLogs.length} entries)`} icon={AlertOctagon}
          color={errLogs.length > 0 ? C.orange : C.green} pageBreak>
          {errLogs.length === 0 ? (
            <div className="text-center py-4 flex items-center justify-center gap-2 text-green-600">
              <CheckCircle2 size={18} />
              <span className="font-bold text-sm">No recent errors in error log</span>
            </div>
          ) : (
            <RTable
              headers={['Timestamp','Level','Message']}
              rows={errLogs.slice(0, 20).map(e => [
                <span className="font-mono text-[10px] text-slate-400">{(e.timestamp || e.logged || e.time || '—').toString().slice(0,19)}</span>,
                <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${
                  (e.level || e.priority || '').includes('ERROR') ? 'bg-red-100 text-red-700'
                  : (e.level || '').includes('WARN')  ? 'bg-amber-100 text-amber-700'
                  : 'bg-slate-100 text-slate-600'}`}>
                  {e.level || e.priority || e.errcode || '—'}
                </span>,
                <span className="text-[11px] text-slate-700">{(e.message || e.msg || e.subsystem || '—').toString().slice(0,120)}</span>,
              ])}
            />
          )}
        </RSection>

        {/* ══ 10. INDEX ANALYSIS ══ */}
        <RSection title="Index Analysis" icon={BarChart2} color={C.amber}>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-4">
            <KStat label="Total Indexes" value={fmtNum(idxSummary.total_indexes || existingIdx.length)} color={C.amber} />
            <KStat label="Unused" value={fmtNum(idxSummary.unused_count || unusedIdx.length)} color={unusedIdx.length ? C.orange : C.green} />
            <KStat label="Duplicate" value={fmtNum(idxSummary.duplicate_count || duplicateIdx.length)} color={duplicateIdx.length ? C.orange : C.green} />
            <KStat label="Missing Candidates" value={fmtNum(idxSummary.missing_candidates || missingIdx.length)} color={missingIdx.length ? C.red : C.green} />
            <KStat label="Tables Analyzed" value={fmtNum(idxSummary.total_tables_analyzed || 0)} color={C.slate} />
          </div>

          {missingIdx.length === 0 && unusedIdx.length === 0 && duplicateIdx.length === 0 && idxIssues.length === 0 ? (
            <div className="text-center py-4 flex items-center justify-center gap-2 text-green-600">
              <CheckCircle2 size={18} />
              <span className="font-bold text-sm">No index issues detected</span>
            </div>
          ) : (
            <div className="space-y-5">
              {missingIdx.length > 0 && (
                <div>
                  <p className="text-xs font-bold text-red-600 mb-2">MISSING INDEX CANDIDATES</p>
                  <RTable
                    headers={['Table','No Index Count','Rows Examined','Worst Avg sec','Data MB','Recommendation']}
                    rows={missingIdx.slice(0, 10).map(idx => [
                      <span className="font-bold text-red-700">{idx.db_name}.{idx.table_name}</span>,
                      fmtNum(idx.no_index_count),
                      fmtNum(idx.rows_examined),
                      idx.worst_avg_sec ?? '—',
                      idx.data_mb ?? '—',
                      <span className="text-[10px] text-slate-600">{idx.recommendation || 'Review query predicates and joins'}</span>,
                    ])}
                  />
                </div>
              )}

              {unusedIdx.length > 0 && (
                <div>
                  <p className="text-xs font-bold text-orange-600 mb-2">UNUSED INDEXES</p>
                  <RTable
                    headers={['Table','Index','Columns','Data MB','Rows','Issue']}
                    rows={unusedIdx.slice(0, 10).map(idx => [
                      <span className="font-bold text-orange-700">{idx.db_name}.{idx.table_name}</span>,
                      <span className="font-mono text-[10px]">{idx.index_name}</span>,
                      <span className="font-mono text-[10px]">{Array.isArray(idx.columns) ? idx.columns.join(', ') : idx.columns || '—'}</span>,
                      idx.data_mb ?? '—',
                      fmtNum(idx.row_estimate || idx.table_rows),
                      <span className="text-[10px] text-slate-600">{idx.reason || idx.issue || 'No observed reads'}</span>,
                    ])}
                  />
                </div>
              )}

              {duplicateIdx.length > 0 && (
                <div>
                  <p className="text-xs font-bold text-amber-600 mb-2">DUPLICATE INDEXES</p>
                  <RTable
                    headers={['Table','Index','Duplicate Of','Columns','Issue']}
                    rows={duplicateIdx.slice(0, 10).map(idx => [
                      <span className="font-bold text-amber-700">{idx.db_name}.{idx.table_name}</span>,
                      <span className="font-mono text-[10px]">{idx.index_name || idx.index}</span>,
                      <span className="font-mono text-[10px]">{idx.duplicate_of || idx.same_as || '—'}</span>,
                      <span className="font-mono text-[10px]">{Array.isArray(idx.columns) ? idx.columns.join(', ') : idx.columns || '—'}</span>,
                      <span className="text-[10px] text-slate-600">{idx.issue || idx.recommendation || 'Duplicate index definition'}</span>,
                    ])}
                  />
                </div>
              )}

              {idxIssues.length > 0 && missingIdx.length === 0 && (
                <RTable
                  headers={['Table','Index','Type','Cardinality','Usage','Issue']}
                  rows={idxIssues.slice(0, 15).map(idx => [
                    <span className="font-bold text-amber-700">{idx.table_name || idx.table || '—'}</span>,
                    <span className="font-mono text-[10px] text-slate-600">{idx.index_name || idx.name || '—'}</span>,
                    idx.index_type || idx.type || '—',
                    fmtNum(idx.cardinality || idx.distinct_values || 0),
                    statusBadge(idx.usage || (idx.used ? 'YES' : 'NO')),
                    <span className={`text-[10px] font-bold ${idx.issue ? 'text-red-600' : 'text-slate-400'}`}>
                      {idx.issue || idx.recommendation || 'OK'}
                    </span>,
                  ])}
                />
              )}
            </div>
          )}
        </RSection>

        {/* ══ REPORT FOOTER ══ */}
        <div className="mt-6 pt-4 border-t-2 border-slate-200 flex items-center justify-between text-xs text-slate-400">
          <div className="flex items-center gap-2">
            <span className="text-lg">🐬</span>
            <div>
              <p className="font-black text-slate-600">Actmon — MySQL Database Monitoring Report</p>
              <p>{connName} — {periodObj.label} Report</p>
            </div>
          </div>
          <div className="text-right">
            <p className="font-bold text-slate-500">Generated: {genTime}</p>
            <p>Powered by Actmon — All rights reserved</p>
          </div>
        </div>

      </div>
    </div>
  );
}
