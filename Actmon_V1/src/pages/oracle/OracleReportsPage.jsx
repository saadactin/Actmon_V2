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
  red:    '#C74634', orange: '#F97316', amber:  '#F59E0B',
  green:  '#22C55E', blue:   '#3B82F6', purple: '#8B5CF6',
  teal:   '#14B8A6', slate:  '#64748B', cyan:   '#06B6D4',
  indigo: '#6366F1', rose:   '#F43F5E',
};
const POOL_COLORS = [C.red, C.orange, C.amber, C.blue, C.purple, C.teal, C.green, C.cyan];

/* ─── period options ─── */
const PERIODS = [
  { id: 'live',    label: 'Live',    color: C.green  },
  { id: '2h',      label: '2-Hour',  color: C.blue   },
  { id: 'daily',   label: 'Daily',   color: C.indigo },
  { id: 'weekly',  label: 'Weekly',  color: C.orange },
  { id: 'monthly', label: 'Monthly', color: C.purple },
];

/* ─── fetchers ─── */
const api = (path, id) => client.get(`/connections/oracle/${id}/${path}`).then(r => r.data);

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
  const good = ['OPEN','ACTIVE','COMPLETED','YES','RUNNING','STARTED','ONLINE','ARCHIVELOG'];
  const bad  = ['FAILED','ERROR','INVALID','NO','OFFLINE','NOARCHIVELOG'];
  const warn = ['WARNING','COMPLETED WITH WARNINGS','NOTIFIED','DEFERRED','MOUNT','RESTRICTED'];
  const color = good.includes(v) ? 'bg-green-100 text-green-700 border-green-200'
    : bad.includes(v)  ? 'bg-red-100 text-red-700 border-red-200'
    : warn.includes(v) ? 'bg-amber-100 text-amber-700 border-amber-200'
    : 'bg-slate-100 text-slate-600 border-slate-200';
  return <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${color}`}>{val || '—'}</span>;
}

/* ─── sub-components ─── */
function RSection({ title, icon: Icon, color = C.red, children, className = '', pageBreak = false }) {
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
        <span>Free: {used}</span><span>Total: {total}</span>
      </div>
    </div>
  );
}

/* ─── Email / Schedule Modal ─── */
function EmailScheduleModal({ id, connName, capturedPdfB64, captureErrMsg, onClose }) {
  const [tab, setTab]             = useState('send');
  const [step, setStep]           = useState('form'); // form | sending | done
  const [result, setResult]       = useState(null);
  const [recipients, setRecipients] = useState('');
  const [period, setPeriod]         = useState('24h');
  const [schedName, setSchedName]   = useState(`${connName || 'Oracle'} Daily Report`);
  const [freq, setFreq]             = useState('daily');
  const [timeH12, setTimeH12]       = useState(7);   // 1–12
  const [timeAmPm, setTimeAmPm]     = useState('AM');
  const [minute, setMinute]         = useState(0);
  const [dow, setDow]               = useState('0');
  const [dom, setDom]               = useState(1);
  const [schedMonth, setSchedMonth] = useState(1);   // for yearly

  // Convert 12h AM/PM → 24h
  const hour24 = () => {
    const h = Number(timeH12);
    if (timeAmPm === 'AM') return h === 12 ? 0 : h;
    return h === 12 ? 12 : h + 12;
  };

  // Load saved SMTP config for display only — backend uses it automatically
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

    // Send — pass captured PDF if available, otherwise backend generates its own
    try {
      setStep('sending');
      const res = await client.post('/oracle-report/send-email', {
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
      const res = await client.post('/oracle-report/schedules', {
        conn_id: Number(id), schedule_name: schedName,
        frequency: freq,
        hour: hour24(), minute: Number(minute),
        // for weekly: dow = day 0-6; for yearly: day_of_week = month 1-12
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

  const inp = "w-full px-3 py-2 text-xs rounded-lg border border-slate-200 bg-white focus:border-blue-400 focus:outline-none";
  const lbl = "block text-[11px] font-bold text-slate-500 mb-1";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.65)' }}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4"
          style={{ background: 'linear-gradient(135deg,#1e3a5f,#0891b2)' }}>
          <div className="flex items-center gap-3 text-white">
            <Mail size={18} />
            <div>
              <p className="font-black text-sm">Send Oracle Report</p>
              <p className="text-[11px] opacity-70">{connName} · PDF attached automatically</p>
            </div>
          </div>
          <button onClick={onClose} className="text-white/70 hover:text-white text-lg leading-none">✕</button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-slate-100 bg-slate-50">
          {[['send', 'Send Now', Send], ['schedule', 'Schedule', Bell]].map(([t, lx, Ic]) => (
            <button key={t} onClick={() => { if (!busy) { setTab(t); setResult(null); }}}
              className={`flex items-center gap-2 px-5 py-2.5 text-xs font-bold transition-all ${
                tab === t ? 'bg-white border-b-2 border-blue-500 text-blue-600' : 'text-slate-400 hover:text-slate-600'
              }`}>
              <Ic size={13} />{lx}
            </button>
          ))}
        </div>

        {/* Progress bar */}
        {busy && (
          <div className="px-5 py-2.5 bg-blue-50 border-b border-blue-100 flex items-center gap-3">
            <div className="flex gap-1.5 flex-shrink-0">
              {['sending'].map(s => (
                <div key={s} className={`h-1.5 rounded-full transition-all duration-500 ${
                  step === s ? 'w-20 bg-blue-500 animate-pulse'
                  : 'w-6 bg-slate-200'
                }`} />
              ))}
            </div>
            <p className="text-[11px] font-bold text-blue-700 flex items-center gap-2">
              <RefreshCw size={11} className="animate-spin flex-shrink-0" />
              {STEP_LABEL[step]}
            </p>
          </div>
        )}

        <div className="p-5 space-y-4 overflow-y-auto" style={{ maxHeight: '60vh' }}>

          {/* SMTP config card — read-only */}
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

          {/* PDF status */}
          {capturedPdfB64 ? (
            <div className="flex items-center gap-2 px-3 py-2.5 bg-green-50 border border-green-200 rounded-xl text-[11px] text-green-700">
              <CheckCircle2 size={14} className="flex-shrink-0 text-green-500" />
              <span><b>Report PDF captured</b> — exact copy of your current view will be attached.</span>
            </div>
          ) : (
            <div className="flex flex-col gap-1 px-3 py-2.5 bg-amber-50 border border-amber-200 rounded-xl text-[11px] text-amber-700">
              <div className="flex items-center gap-2">
                <AlertTriangle size={14} className="flex-shrink-0 text-amber-500" />
                <span>PDF capture failed — <b>backend will generate a report PDF</b> from live Oracle data.</span>
              </div>
              {captureErrMsg && (
                <div className="ml-6 mt-0.5 px-2 py-1 bg-amber-100 rounded text-[10px] font-mono text-amber-800 break-all">
                  {captureErrMsg}
                </div>
              )}
            </div>
          )}

          {/* Schedule name */}
          {tab === 'schedule' && (
            <div>
              <label className={lbl}>Schedule Name</label>
              <input className={inp} value={schedName} onChange={e => setSchedName(e.target.value)} />
            </div>
          )}

          {/* Recipients */}
          <div>
            <label className={lbl}>Recipient Emails <span className="text-slate-400 font-normal">(comma-separated)</span></label>
            <input className={inp} placeholder="dba@company.com, admin@company.com"
              value={recipients} onChange={e => setRecipients(e.target.value)} />
          </div>

          {/* Report Period */}
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

          {/* Schedule-specific fields */}
          {tab === 'schedule' && (
            <div className="border-t border-slate-100 pt-4 space-y-3">
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Recurrence</p>

              {/* Frequency */}
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

              {/* Time — AM/PM picker (hidden for hourly) */}
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
                            timeAmPm === ap ? 'bg-blue-600 text-white' : 'bg-white text-slate-500 hover:bg-slate-50'
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

              {/* Hourly: just minute */}
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

              {/* Weekly: day picker */}
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

              {/* Monthly: day of month */}
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

              {/* Yearly: month + day */}
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

          {/* Result */}
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
                    <li>PDF file: <b>Oracle_Report_{connName?.replace(/\s/g,'_')}_*.pdf</b></li>
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
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
              style={{ background: 'linear-gradient(135deg,#1e3a5f,#0891b2)' }}>
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
export default function OracleReportsPage() {
  const { id } = useParams();
  const [period, setPeriod]         = useState('live');
  const [genTime, setGenTime]       = useState(now);
  const [showEmailModal, setShowEmailModal] = useState(false);
  const [capturingPdf, setCapturingPdf]     = useState(false);
  const [capturedPdfB64, setCapturedPdfB64] = useState(null);
  const [captureErrMsg, setCaptureErrMsg]   = useState(null);
  const printRef                    = useRef(null);

  const refetchInterval = period === 'live' ? 30000 : false;

  /* existing queries */
  const { data: dash,  isLoading: l1, refetch: r1 } = useQuery({ queryKey: ['rpt-dash',   id], queryFn: () => api('oracle-dashboard',   id), refetchInterval });
  const { data: sgaD,  isLoading: l2 }               = useQuery({ queryKey: ['rpt-sga',    id], queryFn: () => api('oracle-sga-detail',  id), refetchInterval });
  const { data: pgaD }                               = useQuery({ queryKey: ['rpt-pga',    id], queryFn: () => api('oracle-pga-detail',  id), refetchInterval });
  const { data: sessD }                              = useQuery({ queryKey: ['rpt-sess',   id], queryFn: () => api('oracle-sessions',    id), refetchInterval });
  const { data: sqlD }                               = useQuery({ queryKey: ['rpt-sql',    id], queryFn: () => api('oracle-top-sql',     id), refetchInterval });
  const { data: waitD }                              = useQuery({ queryKey: ['rpt-wait',   id], queryFn: () => api('oracle-wait-events', id), refetchInterval });
  const { data: tsD }                                = useQuery({ queryKey: ['rpt-ts',     id], queryFn: () => api('oracle-tablespaces', id), refetchInterval });
  const { data: redoD }                              = useQuery({ queryKey: ['rpt-redo',   id], queryFn: () => api('oracle-redo-logs',   id), refetchInterval });
  const { data: dgD }                                = useQuery({ queryKey: ['rpt-dg',     id], queryFn: () => api('oracle-data-guard',  id), refetchInterval });
  const { data: liveD }                              = useQuery({ queryKey: ['rpt-live',   id], queryFn: () => api('oracle-live-queries', id), refetchInterval: period === 'live' ? 10000 : false });
  const { data: lockD }                              = useQuery({ queryKey: ['rpt-lock',   id], queryFn: () => api('oracle-locks',       id), refetchInterval });
  const { data: sysD }                               = useQuery({ queryKey: ['rpt-sys',    id], queryFn: () => api('oracle-system-stats', id), refetchInterval });
  const { data: procD }                              = useQuery({ queryKey: ['rpt-proc',   id], queryFn: () => api('oracle-processes',   id), refetchInterval });

  /* new endpoints */
  const { data: dbStatusD }   = useQuery({ queryKey: ['rpt-dbstatus',  id], queryFn: () => api('oracle-db-status',        id), refetchInterval });
  const { data: rmanD }       = useQuery({ queryKey: ['rpt-rman',      id], queryFn: () => api('oracle-rman-backup',      id), refetchInterval });
  const { data: archGapD }    = useQuery({ queryKey: ['rpt-archgap',   id], queryFn: () => api('oracle-archive-log-gap',  id), refetchInterval });
  const { data: invalidD }    = useQuery({ queryKey: ['rpt-invalid',   id], queryFn: () => api('oracle-invalid-objects',  id), refetchInterval });
  const { data: sarD }        = useQuery({ queryKey: ['rpt-sar',       id], queryFn: () => api('oracle-sar-top',          id), refetchInterval });
  const { data: datafilesD }  = useQuery({ queryKey: ['rpt-datafiles', id], queryFn: () => api('oracle-datafile-mounts',  id), refetchInterval });
  const { data: ebsWfD }      = useQuery({ queryKey: ['rpt-ebswf',     id], queryFn: () => api('oracle-ebs-workflow',     id), refetchInterval });
  const { data: ebsConcD }    = useQuery({ queryKey: ['rpt-ebsconc',   id], queryFn: () => api('oracle-ebs-concurrent',   id), refetchInterval });

  const loading = l1 || l2;
  const refetchAll = () => { r1(); setGenTime(now()); };
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

      const el = document.getElementById('oracle-report');
      if (!el) throw new Error('Element #oracle-report not found in DOM');

      window.scrollTo(0, 0);
      await new Promise(r => setTimeout(r, 100));

      // Portrait A4 at 96 dpi = 794 px wide — exactly matches window.print() layout.
      // Below Tailwind xl (1280 px): xl:grid-cols-2 collapses to single column,
      // identical to the Download PDF output.
      const CAPTURE_PX  = 794;
      const PIXEL_RATIO = 2;

      // Margins matching @page { margin: 14mm 12mm } in index.css print CSS
      const MH     = 12;             // mm — left/right
      const MV     = 14;             // mm — top/bottom
      const CONT_W = 210 - 2 * MH;  // 186 mm usable width
      const CONT_H = 297 - 2 * MV;  // 269 mm usable height

      // Stash current styles so we can restore them unconditionally
      const saved = {
        w:  el.style.width,
        mw: el.style.maxWidth,
        nw: el.style.minWidth,
        bg: el.style.background,
        ml: el.style.marginLeft,
        mr: el.style.marginRight,
      };

      // The print-only header has class "hidden print:block" — show it for capture
      const printHeader     = el.querySelector('[class*="print:block"]');
      const savedHeaderDisp = printHeader ? printHeader.style.display : '';

      el.style.width       = `${CAPTURE_PX}px`;
      el.style.maxWidth    = `${CAPTURE_PX}px`;
      el.style.minWidth    = `${CAPTURE_PX}px`;
      el.style.background  = '#ffffff';
      // Zero out mx-auto margins — in html-to-image's foreignObject context the
      // element is rendered inside a wider container; auto margins would center it,
      // leaving white space on the left and pushing content off the right edge.
      el.style.marginLeft  = '0';
      el.style.marginRight = '0';
      if (printHeader) printHeader.style.display = 'block';

      await new Promise(r => setTimeout(r, 300)); // reflow

      const elRect = el.getBoundingClientRect();

      // Gap candidates: after each direct child (section card)
      const unitBounds = [...el.children].map(c => {
        const r = c.getBoundingClientRect();
        return {
          top:    Math.round((r.top    - elRect.top) * PIXEL_RATIO),
          bottom: Math.round((r.bottom - elRect.top) * PIXEL_RATIO),
        };
      }).filter(b => b.bottom > b.top + 4);

      // Forced breaks: top edge of .page-break elements (RMAN section has pageBreak prop)
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
          width:           CAPTURE_PX,  // override html-to-image's scrollWidth detection
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

      // Defensive: if the canvas is wider than expected (e.g. because html-to-image
      // captured the full-viewport foreignObject and the element was centered inside it),
      // center-crop to extract just the element's content area.
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

      const GAP_PX    = Math.round(16 * PIXEL_RATIO);
      const gapBreaks = unitBounds.map(b => b.bottom + Math.round(GAP_PX * 0.5));

      const pageBreaks = [0];
      let cursor = 0;

      while (cursor < workCanvas.height) {
        const windowEnd = cursor + pagePx;
        if (windowEnd >= workCanvas.height) { pageBreaks.push(workCanvas.height); break; }

        // Honour .page-break forced breaks (RMAN and any other section with pageBreak prop)
        const forced = forcedBreakTops.find(y => y > cursor + GAP_PX && y <= windowEnd);
        if (forced) {
          pageBreaks.push(forced);
          cursor = forced;
          continue;
        }

        // Smart gap break: pack as much as possible, snap to nearest section gap
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

        // Place image inside margins: (MH, MV) offset, CONT_W wide
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
  const conn        = dash?.connection || dbStatusD?.instance || {};
  const tablespaces = tsD?.tablespaces || dash?.tablespaces || [];
  const wait_events = waitD?.wait_events || dash?.wait_events || [];
  const top_sql     = sqlD?.top_sql || dash?.top_sql || [];
  const redo_logs   = redoD?.redo_logs || dash?.redo_logs || [];
  const sessions    = sessD?.sessions || [];
  const liveQ       = liveD?.queries || [];
  const locks       = lockD?.lock_waits || [];
  const sysStats    = sysD?.stats || [];
  const procs       = procD?.processes || [];
  const dgStandby   = dgD?.standby_dbs || [];
  const sgaPools    = sgaD?.pools || [];

  /* new data */
  const dbInst      = dbStatusD?.instance || {};
  const dbSt        = dbStatusD?.db_status || {};
  const rmanJobs    = rmanD?.jobs || [];
  const drGap       = archGapD?.dr_gap || [];
  const hourlyArc   = archGapD?.hourly_rate || [];
  const archMode    = archGapD?.arch_mode || hs.log_mode || '—';
  const invalidObjs = invalidD?.objects || [];
  const invalidByType = invalidD?.by_type || [];
  const sarCpu      = sarD?.cpu_pct || 0;
  const sarMem      = sarD?.mem_pct || 0;
  const topCpu      = sarD?.top_cpu || [];
  const mountSummary= datafilesD?.mount_summary || [];
  const datafilesList = datafilesD?.datafiles || [];
  const ebsWf       = ebsWfD;
  const ebsConc     = ebsConcD;

  /* derived health */
  const activeSess  = Number(hs.active_sessions) || 0;
  const totalSess   = Number(hs.total_sessions) || 0;
  const maxSess     = Number(hs.max_sessions) || 1;
  const sessionPct  = Math.min(100, Math.round(totalSess / maxSess * 100));
  const bufHitPct   = Number(hs.buffer_cache_hit_pct) || 0;
  const libHitPct   = Number(hs.library_cache_hit_pct) || 0;
  const sgaMb       = Number(hs.sga_mb) || 0;
  const pgaMb       = Number(hs.pga_mb) || 0;
  const maxTsPct    = tablespaces.length > 0 ? Math.max(...tablespaces.map(t => Number(t.used_pct) || 0)) : 0;
  const rmanFailed  = rmanD?.failed?.length || 0;
  const maxGap      = archGapD?.max_gap || 0;

  function computeScore() {
    let s = 100;
    if (sessionPct > 90) s -= 30; else if (sessionPct > 70) s -= 15;
    if (bufHitPct < 70) s -= 25;  else if (bufHitPct < 85) s -= 10;
    if (maxTsPct > 90) s -= 20;   else if (maxTsPct > 80) s -= 10;
    if (rmanFailed > 0) s -= 15;
    if (maxGap > 10) s -= 20;     else if (maxGap > 5) s -= 10;
    if ((invalidD?.total || 0) > 50) s -= 10;
    return Math.max(0, s);
  }
  const healthScore = computeScore();

  const sessChartData = sessions.reduce((acc, s) => {
    const k = s.status || 'UNKNOWN';
    const ex = acc.find(x => x.name === k);
    if (ex) ex.value++; else acc.push({ name: k, value: 1 });
    return acc;
  }, []);

  const periodObj = PERIODS.find(p => p.id === period) || PERIODS[0];
  const connName  = dash?.connection?.name || dbInst?.name || `Oracle #${id}`;

  if (loading && !dash) return (
    <div className="min-h-screen flex items-center justify-center bg-[#f1f5f9]">
      <div className="text-center">
        <div className="w-12 h-12 border-4 border-red-200 border-t-red-600 rounded-full animate-spin mx-auto mb-4" />
        <p className="text-slate-600 font-semibold">Loading Oracle report…</p>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-[#f1f5f9]" id="oracle-report-root">
      {showEmailModal && (
        <EmailScheduleModal id={id} connName={connName}
          capturedPdfB64={capturedPdfB64}
          captureErrMsg={captureErrMsg}
          onClose={() => setShowEmailModal(false)} />
      )}

      {/* ─── CONTROL HEADER ─── */}
      <div className="no-print text-white shadow-xl sticky top-0 z-40"
        style={{ background: 'linear-gradient(135deg,#0f172a 0%,#1e3a5f 55%,#3b0a0a 100%)' }}>
        <div className="px-6 pt-4 pb-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-4">
            <Link to={`/oracle-dashboard/${id}`}
              className="w-9 h-9 rounded-xl flex items-center justify-center transition-all"
              style={{ background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)' }}>
              <ArrowLeft size={16} />
            </Link>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center text-xl"
                style={{ background: 'rgba(199,70,52,0.25)', border: '1px solid rgba(199,70,52,0.4)' }}>🏛</div>
              <div>
                <h1 className="text-[18px] font-black tracking-tight">Oracle Monitoring Report</h1>
                <p className="text-[12px] mt-0.5" style={{ color: 'rgba(252,165,165,0.8)' }}>
                  {connName} — {dbInst.host || conn.host || ''}
                  {dbInst.version ? ` · v${dbInst.version}` : ''}
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
              style={{ background: 'rgba(8,145,178,0.3)', border: '1px solid rgba(8,145,178,0.5)' }}>
              {capturingPdf
                ? <><Loader size={13} className="animate-spin" /> Preparing PDF…</>
                : <><Mail size={13} /> Send / Schedule</>}
            </button>
            <button onClick={handlePrint}
              className="flex items-center gap-2 px-4 py-1.5 rounded-lg text-xs font-bold transition-all"
              style={{ background: 'linear-gradient(135deg,#C74634,#9b2b1f)', border: '1px solid rgba(255,255,255,0.3)' }}>
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
          {/* alert badges */}
          {rmanFailed > 0 && (
            <span className="flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-red-500/20 text-red-300 border border-red-500/30">
              <AlertOctagon size={10} /> {rmanFailed} Backup Failed
            </span>
          )}
          {maxGap > 5 && (
            <span className="flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30">
              <AlertTriangle size={10} /> DR Gap: {maxGap}
            </span>
          )}
        </div>
      </div>

      {/* ─── PRINTABLE REPORT ─── */}
      <div ref={printRef} className="max-w-[1200px] mx-auto p-5" id="oracle-report">

        {/* Print-only header */}
        <div className="hidden print:block mb-6 pb-4 border-b-2 border-slate-800">
          <div className="flex justify-between items-start">
            <div>
              <h1 className="text-2xl font-black text-slate-900">Oracle Database Monitoring Report</h1>
              <p className="text-sm text-slate-600 mt-1">
                {connName} — {dbInst.host || ''} {dbInst.version ? `· v${dbInst.version}` : ''}
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
        <RSection title="Executive Summary" icon={Heart} color={healthScore >= 80 ? C.green : healthScore >= 60 ? C.amber : C.red}>
          <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-8 gap-3 mb-4">
            <KStat label="Health Score"     value={`${healthScore}/100`}           color={healthScore >= 80 ? C.green : healthScore >= 60 ? C.amber : C.red} />
            <KStat label="DB Status"        value={dbSt.open_mode || hs.status || '—'} color={dbSt.open_mode === 'READ WRITE' || hs.status === 'OPEN' ? C.green : C.red} />
            <KStat label="Uptime (days)"    value={dbInst.uptime_days || hs.uptime || '—'} />
            <KStat label="Sessions"         value={`${totalSess}/${maxSess}`}      color={sessionPct > 80 ? C.red : C.green} sub={`${sessionPct}% used`} />
            <KStat label="Active Sessions"  value={activeSess}                     color={activeSess > 50 ? C.orange : C.indigo} />
            <KStat label="Buffer Cache Hit" value={`${bufHitPct}%`}               color={bufHitPct < 80 ? C.red : C.green} />
            <KStat label="Invalid Objects"  value={invalidD?.total ?? '—'}        color={(invalidD?.total || 0) > 0 ? C.orange : C.green} />
            <KStat label="RMAN Failed"      value={rmanFailed}                     color={rmanFailed > 0 ? C.red : C.green} />
          </div>

          <div className="flex flex-wrap gap-2">
            {[
              { ok: dbSt.open_mode === 'READ WRITE' || hs.status === 'OPEN', label: `DB: ${dbSt.open_mode || hs.status || '—'}` },
              { ok: sessionPct < 80,              label: `Sessions ${sessionPct}%` },
              { ok: bufHitPct >= 90,              label: `Buffer Hit ${bufHitPct}%` },
              { ok: libHitPct >= 95,              label: `Library Cache ${libHitPct}%` },
              { ok: maxTsPct < 85,                label: `Max Tablespace ${maxTsPct}%` },
              { ok: archMode === 'ARCHIVELOG',    label: `Log Mode: ${archMode}` },
              { ok: maxGap <= 5,                  label: `DR Gap: ${maxGap} logs` },
              { ok: rmanFailed === 0,             label: `RMAN: ${rmanFailed === 0 ? 'OK' : `${rmanFailed} Failed`}` },
              { ok: (invalidD?.total || 0) === 0, label: `Invalid Objects: ${invalidD?.total ?? '—'}` },
              { ok: locks.length === 0,           label: `Locks: ${locks.length === 0 ? 'None' : `${locks.length} waits`}` },
            ].map(({ ok, label }) => (
              <span key={label} className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold border ${
                ok ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-red-50 border-red-200 text-red-700'}`}>
                {ok ? <CheckCircle2 size={11} /> : <AlertTriangle size={11} />}
                {label}
              </span>
            ))}
          </div>
        </RSection>

        {/* ══ 2. DATABASE STATUS ══ */}
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-4">
          <RSection title="Database Status" icon={Database} color={C.red} className="!mb-0">
            <div className="grid grid-cols-2 gap-x-6">
              {[
                ['DB Name',       dbSt.name || hs.db_name],
                ['Unique Name',   dbSt.unique_name || hs.db_unique_name || '—'],
                ['Instance',      dbInst.name || hs.instance_name],
                ['Host',          dbInst.host || hs.host_name],
                ['Version',       dbInst.version || hs.version],
                ['Open Mode',     dbSt.open_mode || hs.status],
                ['DB Role',       dbSt.role || dgD?.db_role || '—'],
                ['Log Mode',      dbSt.log_mode || hs.log_mode],
                ['Flashback',     dbSt.flashback || '—'],
                ['Protection',    dbSt.protection || dgD?.protection_mode || '—'],
                ['Archiver',      dbInst.archiver || '—'],
                ['Startup Time',  dbInst.startup_time || hs.startup_time],
                ['Uptime (days)', dbInst.uptime_days || '—'],
                ['Logins',        dbInst.logins || '—'],
                ['Platform',      dbSt.platform || '—'],
                ['DB Size (GB)',   hs.db_size_gb || '—'],
              ].map(([l, v]) => (
                <div key={l} className="flex items-start justify-between py-1.5 border-b border-slate-100 last:border-0 col-span-1">
                  <span className="text-[11px] text-slate-400 font-semibold flex-shrink-0">{l}</span>
                  <span className="text-[11px] font-bold text-slate-800 font-mono ml-2 text-right break-all">
                    {(l === 'Open Mode' || l === 'Log Mode' || l === 'Flashback' || l === 'Logins') ? statusBadge(v) : (v || '—')}
                  </span>
                </div>
              ))}
            </div>
          </RSection>

          <RSection title="Performance Overview" icon={TrendingUp} color={C.blue} className="!mb-0">
            <div className="grid grid-cols-2 gap-3 mb-4">
              <KStat label="Buffer Cache Hit" value={`${bufHitPct}%`}    color={bufHitPct < 85 ? C.red : C.green} />
              <KStat label="Library Cache Hit" value={`${libHitPct}%`}   color={libHitPct < 95 ? C.orange : C.green} />
              <KStat label="SGA (MB)"          value={fmtNum(sgaMb)}     color={C.blue} />
              <KStat label="PGA (MB)"          value={fmtNum(pgaMb)}     color={C.purple} />
              <KStat label="CPU %"             value={`${sarCpu}%`}      color={sarCpu > 80 ? C.red : C.green} />
              <KStat label="Memory %"          value={`${sarMem}%`}      color={sarMem > 85 ? C.red : C.green} />
            </div>
            {sgaPools.length > 0 && (
              <ResponsiveContainer width="100%" height={150}>
                <BarChart data={sgaPools.slice(0, 6)} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                  <XAxis dataKey="pool" tick={{ fontSize: 9 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 9 }} tickFormatter={v => `${(v/1048576).toFixed(0)}M`} axisLine={false} tickLine={false} />
                  <Tooltip formatter={v => fmtBytes(v)} />
                  <Bar dataKey="bytes" radius={[4,4,0,0]}>
                    {sgaPools.slice(0, 6).map((_, i) => <Cell key={i} fill={POOL_COLORS[i % POOL_COLORS.length]} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </RSection>
        </div>

        {/* ══ 3. RMAN BACKUP STATUS ══ */}
        <RSection title="RMAN Backup Status" icon={Archive} color={rmanFailed > 0 ? C.red : C.green} pageBreak>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <KStat label="Total Jobs"     value={rmanD?.total ?? '—'} />
            <KStat label="Running"        value={rmanD?.running?.length ?? 0}  color={C.blue} />
            <KStat label="Failed"         value={rmanFailed}                   color={rmanFailed > 0 ? C.red : C.green} />
            <KStat label="Last DB Backup" value={rmanD?.last_db_backup?.start_time?.slice(0,16) || '—'}
              color={rmanD?.last_db_backup?.status === 'COMPLETED' ? C.green : C.orange} />
          </div>
          <RTable
            headers={['Input Type','Status','Start Time','End Time','HRS','Bytes Backed (GB)','Output (GB)','Device']}
            rows={rmanJobs.slice(0, 15).map(j => [
              <span className="font-bold text-slate-700">{j.input_type}</span>,
              statusBadge(j.status),
              <span className="font-mono text-[10px]">{j.start_time}</span>,
              <span className="font-mono text-[10px]">{j.end_time}</span>,
              <span className={`font-bold ${Number(j.hrs) > 4 ? 'text-orange-600' : 'text-slate-700'}`}>{j.hrs}</span>,
              <span className="font-bold">{j.input_gb}</span>,
              j.output_gb,
              <span className="text-[10px] font-mono text-slate-500">{j.output_device_type}</span>,
            ])}
            emptyMsg="No RMAN backup data"
          />
        </RSection>

        {/* ══ 4. ARCHIVE LOG GAP / DR STATUS ══ */}
        <RSection title="Archive Log Gap — DR Status" icon={Radio} color={maxGap > 5 ? C.red : C.green}>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <KStat label="Archive Mode" value={archMode} color={archMode === 'ARCHIVELOG' ? C.green : C.red} />
            <KStat label="Max Gap (logs)" value={maxGap} color={maxGap > 10 ? C.red : maxGap > 5 ? C.orange : C.green} />
            <KStat label="Total Gap" value={archGapD?.total_gap ?? 0} color={C.slate} />
            <KStat label="Destinations" value={archGapD?.dr_gap?.length ?? 0} color={C.blue} />
          </div>
          <RTable
            headers={['DEST_ID','Dest Name','DB Unique','THREAD#','LOG_ARCHIVED','LOG_APPLIED','LOG_GAP','Status','Target']}
            rows={drGap.map(g => [
              g.dest_id,
              <span className="text-[10px] font-mono text-slate-500">{g.dest_name}</span>,
              <span className="font-bold text-blue-700">{g.db_unique || '—'}</span>,
              g.thread_num,
              <span className="font-mono">{g.log_archived}</span>,
              <span className="font-mono">{g.log_applied}</span>,
              <span className={`font-black text-lg ${Number(g.log_gap) > 10 ? 'text-red-600' : Number(g.log_gap) > 5 ? 'text-amber-600' : 'text-green-600'}`}>
                {g.log_gap}
              </span>,
              statusBadge(g.status),
              <span className={`text-[10px] font-bold ${g.target === 'STANDBY' ? 'text-purple-600' : 'text-slate-400'}`}>{g.target}</span>,
            ])}
            emptyMsg="No DR destinations configured"
          />
          {hourlyArc.length > 0 && (
            <div className="mt-4">
              <p className="text-xs font-bold text-slate-500 mb-2">Hourly Archive Generation (last 24h)</p>
              <ResponsiveContainer width="100%" height={140}>
                <BarChart data={hourlyArc.slice(0, 24).reverse()} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                  <XAxis dataKey="hour_slot" tick={{ fontSize: 8 }} axisLine={false} tickLine={false}
                    tickFormatter={v => v?.slice(-5) || ''} />
                  <YAxis tick={{ fontSize: 9 }} axisLine={false} tickLine={false} />
                  <Tooltip formatter={(v, n) => [v, n === 'logs' ? 'Archive Logs' : 'MB']} />
                  <Bar dataKey="logs" fill={C.blue} radius={[3,3,0,0]} name="logs" />
                  <Bar dataKey="mb"   fill={C.teal} radius={[3,3,0,0]} name="mb" />
                  <Legend wrapperStyle={{ fontSize: 10 }} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </RSection>

        {/* ══ 5. TABLESPACE USAGE ══ */}
        <RSection title="Tablespace Usage" icon={HardDrive} color={C.teal} pageBreak>
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
            <div>
              {tablespaces.slice(0, 12).map((ts, i) => (
                <UsageBar key={i}
                  label={ts.tablespace_name}
                  pct={Number(ts.used_pct) || 0}
                  used={`${fmtNum(ts.free_mb)} MB free`}
                  total={`${fmtNum(ts.total_mb)} MB`} />
              ))}
            </div>
            <RTable
              headers={['Tablespace','Status','Total (MB)','Free (GB)','Used %']}
              rows={tablespaces.map(ts => [
                <span className="font-bold text-teal-700">{ts.tablespace_name}</span>,
                statusBadge(ts.status),
                fmtNum(ts.total_mb),
                <span className="font-bold">{(Number(ts.free_mb || 0) / 1024).toFixed(1)}</span>,
                <span className={`font-bold ${Number(ts.used_pct) > 85 ? 'text-red-600' : Number(ts.used_pct) > 70 ? 'text-orange-600' : 'text-green-600'}`}>
                  {ts.used_pct}%
                </span>,
              ])}
            />
          </div>
        </RSection>

        {/* ══ 6. INVALID OBJECTS ══ */}
        <RSection title={`Invalid Objects (${invalidD?.total ?? 0} total)`}
          icon={AlertOctagon} color={(invalidD?.total || 0) > 0 ? C.orange : C.green}>
          {(invalidD?.total || 0) === 0 ? (
            <div className="text-center py-4 flex items-center justify-center gap-2 text-green-600">
              <CheckCircle2 size={18} />
              <span className="font-bold text-sm">No invalid objects found</span>
            </div>
          ) : (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
              <div>
                <p className="text-xs font-bold text-slate-500 mb-3">BY OBJECT TYPE</p>
                <RTable
                  headers={['Object Type', 'Count']}
                  rows={invalidByType.slice(0, 12).map(x => [
                    <span className="font-bold text-orange-700">{x.type}</span>,
                    <span className="font-black text-slate-800">{x.count}</span>,
                  ])}
                />
              </div>
              <div>
                <p className="text-xs font-bold text-slate-500 mb-3">INVALID OBJECT DETAILS (first 20)</p>
                <RTable
                  headers={['Owner', 'Type', 'Object Name', 'Last DDL']}
                  rows={invalidObjs.slice(0, 20).map(o => [
                    <span className="font-bold text-red-700">{o.owner}</span>,
                    <span className="text-[10px] font-mono text-slate-500">{o.object_type}</span>,
                    <span className="font-semibold text-slate-700">{o.object_name}</span>,
                    <span className="font-mono text-[10px] text-slate-400">{o.last_ddl?.slice(0,10)}</span>,
                  ])}
                />
              </div>
            </div>
          )}
        </RSection>

        {/* ══ 7. SAR / TOP PROCESSES ══ */}
        <RSection title="System Activity (SAR) / Top Processes" icon={Cpu} color={C.cyan} pageBreak>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <KStat label="CPU Usage %"      value={`${sarCpu}%`}            color={sarCpu > 80 ? C.red : C.green} />
            <KStat label="Memory Usage %"   value={`${sarMem}%`}            color={sarMem > 85 ? C.red : C.green} />
            <KStat label="Physical Mem (GB)" value={sarD?.phys_gb ?? '—'}   color={C.blue} />
            <KStat label="Free Mem (GB)"    value={sarD?.free_gb ?? '—'}    color={C.teal} />
          </div>
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
            <div>
              <p className="text-xs font-bold text-slate-500 mb-2">TOP SESSIONS BY CPU</p>
              <RTable
                headers={['SID','Username','Program','CPU %','Status','OS PID']}
                rows={topCpu.slice(0, 10).map(t => [
                  <span className="font-mono">{t.sid}</span>,
                  <span className="font-bold text-blue-700">{t.username || '—'}</span>,
                  <span className="text-[10px] text-slate-500 truncate max-w-[120px] block">{(t.program || '').slice(0,30)}</span>,
                  <span className={`font-bold ${t.cpu_pct > 20 ? 'text-red-600' : 'text-slate-700'}`}>{t.cpu_pct}%</span>,
                  statusBadge(t.status),
                  <span className="font-mono text-[10px] text-slate-400">{t.os_pid}</span>,
                ])}
                emptyMsg="No session CPU data"
              />
            </div>
            <div>
              <p className="text-xs font-bold text-slate-500 mb-2">OS STATISTICS</p>
              {sarD?.os_stats && (
                <RTable
                  headers={['Metric','Value']}
                  rows={Object.entries(sarD.os_stats).slice(0, 12).map(([k, v]) => [
                    <span className="font-semibold text-slate-600 text-[11px]">{k.replace(/_/g,' ')}</span>,
                    <span className="font-black text-slate-800">{typeof v === 'number' ? v.toLocaleString() : v}</span>,
                  ])}
                />
              )}
            </div>
          </div>
        </RSection>

        {/* ══ 8. DB MOUNT POINTS / DATA FILES ══ */}
        <RSection title="DB Mount Points / Data Files" icon={Layers} color={C.slate}>
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
            <div>
              <p className="text-xs font-bold text-slate-500 mb-2">MOUNT POINT SUMMARY</p>
              <RTable
                headers={['Mount Point','Files','Total GB']}
                rows={mountSummary.map(m => [
                  <span className="font-mono text-blue-700 text-[11px]">{m.mount || 'unknown'}</span>,
                  m.files,
                  <span className="font-bold">{Number(m.total_gb || 0).toFixed(2)}</span>,
                ])}
                emptyMsg="No mount point data"
              />
            </div>
            <div>
              <p className="text-xs font-bold text-slate-500 mb-2">DATA FILES (first 20)</p>
              <RTable
                headers={['Tablespace','Size GB','AutoExt','Max GB','Status']}
                rows={datafilesList.slice(0, 20).map(f => [
                  <span className="font-bold text-teal-700 text-[10px]">{f.tablespace}</span>,
                  <span className="font-bold">{f.size_gb}</span>,
                  statusBadge(f.autoextend),
                  f.max_gb,
                  statusBadge(f.status),
                ])}
                emptyMsg="No data file info (DBA privilege required)"
              />
            </div>
          </div>
        </RSection>

        {/* ══ 9. TOP SQL ══ */}
        <RSection title="Top SQL by Elapsed Time" icon={Zap} color={C.orange} pageBreak>
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-5 mb-4">
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={top_sql.slice(0, 8).map(s => ({
                name: (s.sql_id || '').slice(0, 12),
                elapsed: Math.round(Number(s.elapsed_ms) || 0),
                cpu: Math.round(Number(s.cpu_ms) || 0),
              }))} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 9 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 9 }} tickFormatter={fmtNum} axisLine={false} tickLine={false} />
                <Tooltip formatter={v => `${fmtNum(v)} ms`} />
                <Bar dataKey="elapsed" fill={C.orange} radius={[4,4,0,0]} name="Elapsed" />
                <Bar dataKey="cpu"     fill={C.red}    radius={[4,4,0,0]} name="CPU" />
                <Legend wrapperStyle={{ fontSize: 10 }} />
              </BarChart>
            </ResponsiveContainer>
            <RTable
              headers={['SQL ID','Exec','Elapsed (ms)','CPU (ms)','Buf Gets','Avg ms']}
              rows={top_sql.slice(0, 8).map(s => [
                <span className="font-mono text-[10px] text-red-700">{s.sql_id || '—'}</span>,
                fmtNum(s.executions),
                <span className={`font-bold ${Number(s.elapsed_ms) > 5000 ? 'text-red-600' : Number(s.elapsed_ms) > 1000 ? 'text-orange-600' : 'text-slate-700'}`}>{fmtNum(s.elapsed_ms)}</span>,
                fmtNum(s.cpu_ms),
                fmtNum(s.buffer_gets),
                <span className={`font-bold ${Number(s.avg_elapsed_ms) > 1000 ? 'text-red-600' : 'text-green-600'}`}>{fmtNum(s.avg_elapsed_ms)}</span>,
              ])}
            />
          </div>
        </RSection>

        {/* ══ 10. WAIT EVENTS + SESSIONS ══ */}
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-4">
          <RSection title="Top Wait Events" icon={Clock} color={C.red} className="!mb-0">
            {wait_events.length === 0 ? (
              <p className="text-center text-slate-400 py-6">No wait events</p>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart layout="vertical"
                  data={wait_events.slice(0, 8).map(w => ({
                    name: (w.event || '').slice(0, 30),
                    waits: Number(w.total_waits) || 0,
                  }))}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 9 }} tickFormatter={fmtNum} axisLine={false} tickLine={false} />
                  <YAxis width={150} type="category" dataKey="name" tick={{ fontSize: 9 }} axisLine={false} tickLine={false} />
                  <Tooltip formatter={(v) => [fmtNum(v), 'Total Waits']} />
                  <Bar dataKey="waits" fill={C.red} radius={[0,4,4,0]} name="Total Waits" />
                </BarChart>
              </ResponsiveContainer>
            )}
          </RSection>

          <RSection title="Session Analysis" icon={Users} color={C.indigo} className="!mb-0">
            <div className="grid grid-cols-3 gap-3 mb-3">
              <KStat label="Active"  value={activeSess} color={C.green} />
              <KStat label="Total"   value={totalSess}  color={C.indigo} />
              <KStat label="Max"     value={maxSess}    color={C.slate} />
            </div>
            {sessChartData.length > 0 ? (
              <ResponsiveContainer width="100%" height={150}>
                <PieChart>
                  <Pie data={sessChartData} dataKey="value" nameKey="name"
                    innerRadius={40} outerRadius={65}
                    label={({ name, percent }) => percent > 0.05 ? `${name} ${(percent*100).toFixed(0)}%` : ''}>
                    {sessChartData.map((_, i) => <Cell key={i} fill={POOL_COLORS[i % POOL_COLORS.length]} />)}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <p className="text-center text-slate-400 text-xs py-4">No session data</p>
            )}
          </RSection>
        </div>

        {/* ══ 11. LIVE QUERIES ══ */}
        <RSection title={`Live Queries (${liveQ.length} sessions)`} icon={Activity} color={C.green}>
          {liveQ.length === 0 ? (
            <div className="text-center py-6 flex items-center justify-center gap-2 text-green-600">
              <CheckCircle2 size={18} />
              <span className="font-bold text-sm">No active queries running</span>
            </div>
          ) : (
            <RTable
              headers={['SID','Username','Status','Wait Event','Sec Wait','SQL ID','Machine','SQL Preview']}
              rows={liveQ.slice(0, 15).map(q => [
                <span className="font-mono text-slate-500">{q.sid}</span>,
                <span className="font-bold text-red-700">{q.username || '—'}</span>,
                statusBadge(q.status),
                <span className="text-orange-600 text-[11px]">{q.wait_event || 'CPU'}</span>,
                <span className={`font-bold ${Number(q.seconds_in_wait) > 60 ? 'text-red-600' : 'text-slate-600'}`}>{q.seconds_in_wait || 0}s</span>,
                <span className="font-mono text-[10px] text-slate-400">{q.sql_id || '—'}</span>,
                <span className="text-slate-400 text-[10px]">{(q.machine || '').slice(0, 20)}</span>,
                <span className="font-mono text-[10px] text-slate-500 max-w-[200px] truncate block">{(q.sql_text || '').slice(0, 80)}</span>,
              ])}
            />
          )}
        </RSection>

        {/* ══ 12. LOCK ANALYSIS ══ */}
        <RSection title={`Lock Analysis (${locks.length} waits)`} icon={Lock} color={locks.length > 0 ? C.red : C.green}>
          {locks.length === 0 ? (
            <div className="text-center py-4 flex items-center justify-center gap-2 text-green-600">
              <CheckCircle2 size={18} />
              <span className="font-bold text-sm">No lock waits — database is healthy</span>
            </div>
          ) : (
            <RTable
              headers={['Blocker SID','Waiter SID','Lock Type','Mode Held','Mode Req','Wait (s)']}
              rows={locks.map(l => [
                <span className="font-bold text-red-700">{l.blocking_session || l.blocker_sid || '—'}</span>,
                l.waiting_session || l.waiter_sid || '—',
                l.lock_type || '—',
                l.mode_held || '—',
                l.mode_requested || '—',
                <span className={`font-bold ${Number(l.seconds_in_wait || l.wait_seconds) > 60 ? 'text-red-600' : 'text-orange-600'}`}>
                  {l.seconds_in_wait || l.wait_seconds || '—'}
                </span>,
              ])}
            />
          )}
        </RSection>

        {/* ══ 13. REDO LOGS + DATA GUARD ══ */}
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-4">
          <RSection title="Redo Log Groups" icon={RotateCcw} color={C.blue} className="!mb-0">
            <RTable
              headers={['Group','Members','Bytes','Sequence','Status','Archived']}
              rows={redo_logs.map(r => [
                <span className="font-mono font-bold">{r.group_no || r.group}</span>,
                r.members,
                fmtBytes(r.bytes || 0),
                r.sequence_no || r.sequence || '—',
                statusBadge(r.status),
                <span className={r.archived === 'YES' ? 'text-green-600 font-bold' : 'text-red-600 font-bold'}>{r.archived}</span>,
              ])}
              emptyMsg="No redo log data"
            />
          </RSection>

          <RSection title="Data Guard / DR Sync" icon={Shield} color={C.purple} className="!mb-0">
            <div className="grid grid-cols-2 gap-3 mb-3">
              <KStat label="DB Role"     value={dgD?.db_role || dbSt.role || '—'} color={C.purple} />
              <KStat label="Protection"  value={dgD?.protection_mode || dbSt.protection || '—'} />
              <KStat label="Switchover"  value={dgD?.switchover_status || '—'} color={C.indigo} />
              <KStat label="Standby DBs" value={dgStandby.length} color={dgStandby.length > 0 ? C.green : C.slate} />
            </div>
            {dgStandby.length > 0 ? (
              <RTable
                headers={['Dest','DB Name','Status','Log Mode','Delay']}
                rows={dgStandby.map(s => [
                  s.dest_id || '—',
                  s.db_unique_name || '—',
                  s.status || '—',
                  s.protection_mode || '—',
                  s.delay_mins ? `${s.delay_mins}m` : '0',
                ])}
              />
            ) : (
              <p className="text-slate-400 text-xs text-center py-4">Standalone instance — no Data Guard</p>
            )}
          </RSection>
        </div>

        {/* ══ 14. EBS SECTIONS (only shown if is_ebs) ══ */}
        {(ebsWf?.is_ebs || ebsConc?.is_ebs) && (
          <>
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-4">
              <RSection title={`EBS Workflow Status (${ebsWf?.total_stuck || 0} stuck)`}
                icon={Activity} color={(ebsWf?.total_stuck || 0) > 0 ? C.red : C.green} className="!mb-0">
                {(ebsWf?.by_type || []).length > 0 ? (
                  <>
                    <div className="grid grid-cols-3 gap-2 mb-3">
                      {(ebsWf?.by_type || []).slice(0, 6).map(x => (
                        <KStat key={x.status} label={x.status} value={x.count}
                          color={x.status === 'ERROR' ? C.red : x.status === 'DEFERRED' ? C.orange : C.slate} />
                      ))}
                    </div>
                    {(ebsWf?.stuck || []).length > 0 && (
                      <RTable
                        headers={['Item Type','Status','Begin Date','Days Stuck']}
                        rows={(ebsWf?.stuck || []).slice(0, 10).map(w => [
                          <span className="font-bold text-purple-700">{w.item_type}</span>,
                          statusBadge(w.status),
                          <span className="font-mono text-[10px]">{w.begin_date}</span>,
                          <span className={`font-bold ${w.days_stuck > 1 ? 'text-red-600' : 'text-orange-600'}`}>{w.days_stuck}d</span>,
                        ])}
                      />
                    )}
                  </>
                ) : (
                  <p className="text-slate-400 text-xs text-center py-4">No EBS Workflow data (non-EBS instance)</p>
                )}
              </RSection>

              <RSection title="Concurrent Manager Status" icon={Server} color={C.cyan} className="!mb-0">
                {(ebsConc?.managers || []).length > 0 ? (
                  <RTable
                    headers={['Manager','Enabled','Running','Max']}
                    rows={(ebsConc?.managers || []).slice(0, 15).map(m => [
                      <span className="font-bold text-cyan-700 text-[11px]">{m.display || m.name}</span>,
                      statusBadge(m.enabled === 'Y' ? 'YES' : 'NO'),
                      <span className="font-bold">{m.running}</span>,
                      m.max,
                    ])}
                  />
                ) : (
                  <p className="text-slate-400 text-xs text-center py-4">No Concurrent Manager data (non-EBS instance)</p>
                )}
              </RSection>
            </div>
          </>
        )}

        {/* ══ 15. SYSTEM STATISTICS ══ */}
        <RSection title="System Statistics" icon={BarChart2} color={C.slate} pageBreak>
          {sysStats.length === 0 ? (
            <p className="text-center text-slate-400 py-4">No system stats</p>
          ) : (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={sysStats.slice(0, 8).map(s => ({
                  name: (s.name || s.statistic_name || '').replace(/_/g,' ').slice(0, 22),
                  value: Number(s.value) || 0,
                }))} layout="vertical" margin={{ left: 10, right: 10 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 9 }} tickFormatter={fmtNum} axisLine={false} tickLine={false} />
                  <YAxis width={150} type="category" dataKey="name" tick={{ fontSize: 9 }} axisLine={false} tickLine={false} />
                  <Tooltip formatter={v => fmtNum(v)} />
                  <Bar dataKey="value" fill={C.slate} radius={[0,4,4,0]} />
                </BarChart>
              </ResponsiveContainer>
              <RTable
                headers={['Statistic','Value']}
                rows={sysStats.slice(0, 16).map(s => [
                  <span className="font-semibold text-slate-600">{s.name || s.statistic_name}</span>,
                  <span className="font-black text-slate-800">{fmtNum(s.value)}</span>,
                ])}
              />
            </div>
          )}
        </RSection>

        {/* ══ 16. WAIT EVENTS DETAIL ══ */}
        <RSection title="Wait Events Detail" icon={Clock} color={C.amber} pageBreak>
          <RTable
            headers={['Event','Wait Class','Total Waits','Time Waited (s)','Avg Wait (ms)']}
            rows={wait_events.slice(0, 15).map(w => [
              <span className="font-semibold text-slate-700">{w.event}</span>,
              <span className="text-[11px] px-2 py-0.5 rounded bg-amber-50 text-amber-700 font-bold">{w.wait_class}</span>,
              fmtNum(w.total_waits),
              <span className="font-bold">{Number(w.time_waited_seconds || 0).toFixed(2)}</span>,
              <span className={`font-bold ${Number(w.avg_wait_ms) > 100 ? 'text-red-600' : 'text-green-600'}`}>
                {Number(w.avg_wait_ms || 0).toFixed(2)}
              </span>,
            ])}
            emptyMsg="No wait events"
          />
        </RSection>

        {/* ══ REPORT FOOTER ══ */}
        <div className="mt-6 pt-4 border-t-2 border-slate-200 flex items-center justify-between text-xs text-slate-400">
          <div className="flex items-center gap-2">
            <span className="text-lg">🏛</span>
            <div>
              <p className="font-black text-slate-600">Actmon — Oracle Database Monitoring Report</p>
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
