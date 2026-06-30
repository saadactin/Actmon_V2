/*
 * Shared Report Kit — the single source of truth for every database report page
 * (PostgreSQL, SQL Server, Oracle, MySQL, …).  Guarantees identical STRUCTURE,
 * UI and FLOW across all technologies:
 *   • ReportShell        — control header (period selector, Refresh, permission-gated
 *                          Send/Schedule + Download PDF), the printable container,
 *                          the print-only header, and client-side PDF capture.
 *   • EmailScheduleModal — Send-now / Schedule tabs with full recurrence, SMTP check.
 *   • RSection/KStat/RTable/UsageBar/statusBadge — the report building blocks.
 * Only the *data sections* differ per engine; the shell is shared verbatim.
 */
import React, { useState, useRef } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { usePermissions } from '../../hooks/usePermissions';
import {
  ArrowLeft, Download, RefreshCw, Mail, Send, Bell, Loader,
  CheckCircle2, AlertTriangle, XCircle, AlertOctagon,
} from 'lucide-react';
import client from '../../api/client';

/* ─── shared palette ─── */
export const C = {
  red: '#ef4444', orange: '#F97316', amber: '#F59E0B',
  green: '#22C55E', blue: '#3B82F6', purple: '#8B5CF6',
  teal: '#14B8A6', slate: '#64748B', cyan: '#06B6D4', indigo: '#6366F1',
};

export const PERIODS = [
  { id: 'live', label: 'Live', color: C.green },
  { id: '2h', label: '2-Hour', color: C.blue },
  { id: 'daily', label: 'Daily', color: C.indigo },
  { id: 'weekly', label: 'Weekly', color: C.orange },
  { id: 'monthly', label: 'Monthly', color: C.purple },
];

/* ─── formatters ─── */
export function fmtNum(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(v);
}
export function fmtBytes(b) {
  const v = Number(b) || 0;
  if (v > 1073741824) return `${(v / 1073741824).toFixed(2)} GB`;
  if (v > 1048576) return `${(v / 1048576).toFixed(2)} MB`;
  if (v > 1024) return `${(v / 1024).toFixed(2)} KB`;
  return `${v} B`;
}
export function now() {
  return new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'medium' });
}
export function statusBadge(val) {
  const v = (val || '').toUpperCase();
  const good = ['ACTIVE', 'YES', 'OK', 'STREAMING', 'SYNC', 'ASYNC', 'CONNECTED', 'ONLINE', 'COMPLETED', 'TRUE', '1', 'PRIMARY', 'HEALTHY'];
  const bad = ['INACTIVE', 'NO', 'ERROR', 'FAILED', 'OFFLINE', 'FALSE', '0', 'DISCONNECTED', 'SUSPECT'];
  const warn = ['WARNING', 'SLOW', 'DEGRADED', 'CATCHUP', 'RECOVERY'];
  const color = good.includes(v) ? 'bg-green-100 text-green-700 border-green-200'
    : bad.includes(v) ? 'bg-red-100 text-red-700 border-red-200'
    : warn.includes(v) ? 'bg-amber-100 text-amber-700 border-amber-200'
    : 'bg-slate-100 text-slate-600 border-slate-200';
  return <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${color}`}>{val || '—'}</span>;
}

/* ─── building blocks ─── */
export function RSection({ title, icon: Icon, color = C.blue, children, className = '', pageBreak = false }) {
  return (
    <div className={`report-card report-section bg-white rounded-xl border border-slate-200 overflow-hidden mb-4 ${pageBreak ? 'page-break' : ''} ${className}`}>
      <div className="flex items-center gap-3 px-5 py-3 border-b border-slate-100" style={{ borderLeft: `4px solid ${color}` }}>
        {Icon && <Icon size={15} style={{ color }} />}
        <h2 className="font-black text-slate-800 text-sm tracking-tight uppercase">{title}</h2>
      </div>
      <div className="p-5">{children}</div>
    </div>
  );
}
export function KStat({ label, value, color = '#1e293b', sub }) {
  return (
    <div className="bg-slate-50 rounded-lg p-3 border border-slate-100">
      <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wide">{label}</p>
      <p className="text-lg font-black mt-0.5" style={{ color }}>{value ?? '—'}</p>
      {sub && <p className="text-[9px] text-slate-400 mt-0.5">{sub}</p>}
    </div>
  );
}
export function RTable({ headers, rows, emptyMsg = 'No data' }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr className="bg-slate-50 border-y border-slate-200">
            {headers.map(h => <th key={h} className="px-3 py-2 text-left text-[10px] font-bold text-slate-400 uppercase whitespace-nowrap">{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {(!rows || rows.length === 0) ? (
            <tr><td colSpan={headers.length} className="text-center py-6 text-slate-400">{emptyMsg}</td></tr>
          ) : rows.map((row, i) => (
            <tr key={i} className={`border-b border-slate-100 ${i % 2 === 1 ? 'bg-slate-50/40' : ''}`}>
              {row.map((cell, j) => <td key={j} className="px-3 py-2 text-slate-700 align-top">{cell}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
export function UsageBar({ label, pct, sub, color }) {
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  const c = p > 85 ? C.red : p > 70 ? C.orange : (color || C.teal);
  return (
    <div className="mb-3">
      <div className="flex justify-between items-center mb-1">
        <span className="text-xs font-bold text-slate-700 truncate max-w-[200px]">{label}</span>
        <span className="text-xs font-black ml-2" style={{ color: c }}>{p}%</span>
      </div>
      <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
        <div className="h-2 rounded-full transition-all" style={{ width: `${p}%`, background: c }} />
      </div>
      {sub && <p className="text-[10px] text-slate-400 mt-0.5">{sub}</p>}
    </div>
  );
}

/* ─── Email / Schedule Modal (shared) ─── */
function EmailScheduleModal({ id, engine, connName, capturedPdfB64, captureErrMsg, onClose }) {
  const [tab, setTab] = useState('send');
  const [step, setStep] = useState('form');
  const [result, setResult] = useState(null);
  const [recipients, setRecipients] = useState('');
  const [period, setPeriod] = useState('24h');
  const [schedName, setSchedName] = useState(`${connName || engine.label} Daily Report`);
  const [freq, setFreq] = useState('daily');
  const [timeH12, setTimeH12] = useState(7);
  const [timeAmPm, setTimeAmPm] = useState('AM');
  const [minute, setMinute] = useState(0);
  const [dow, setDow] = useState('0');
  const [dom, setDom] = useState(1);
  const [schedMonth, setSchedMonth] = useState(1);

  const hour24 = () => {
    const h = Number(timeH12);
    if (timeAmPm === 'AM') return h === 12 ? 0 : h;
    return h === 12 ? 12 : h + 12;
  };

  const { data: smtpData } = useQuery({
    queryKey: ['smtp-default-modal'],
    queryFn: () => client.get('/settings/smtp/default').then(r => r.data),
    staleTime: 60000,
  });
  const smtpCfg = smtpData?.config;
  const busy = step === 'sending';
  const getEmails = () => recipients.split(',').map(e => e.trim()).filter(Boolean);
  const baseUrl = `${window.location.protocol}//${window.location.hostname}:8000`;

  const handleSend = async () => {
    const emails = getEmails();
    if (!emails.length) { setResult({ ok: false, msg: 'Enter at least one recipient email.' }); return; }
    if (!smtpCfg) { setResult({ ok: false, msg: 'No SMTP configured. Go to Settings → SMTP Configuration first.' }); return; }
    setResult(null);
    try {
      setStep('sending');
      const res = await client.post(`/${engine.reportPrefix}/send-email`, {
        conn_id: Number(id), recipient_emails: emails, report_period: period,
        base_url: baseUrl, pdf_base64: capturedPdfB64 || null, db_name: connName || null,
      });
      setResult({ ok: res.data.status !== 'error', warn: res.data.status === 'partial', msg: res.data.message });
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
      const res = await client.post(`/${engine.reportPrefix}/schedules`, {
        conn_id: Number(id), schedule_name: schedName, frequency: freq,
        hour: hour24(), minute: Number(minute),
        day_of_week: freq === 'yearly' ? String(schedMonth) : dow,
        day_of_month: Number(dom), recipient_emails: emails, report_period: period, base_url: baseUrl,
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

  const inp = 'w-full px-3 py-2 text-xs rounded-lg border border-slate-200 bg-white focus:border-blue-400 focus:outline-none';
  const lbl = 'block text-[11px] font-bold text-slate-500 mb-1';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.65)' }}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4" style={{ background: engine.gradient }}>
          <div className="flex items-center gap-3 text-white">
            <Mail size={18} />
            <div>
              <p className="font-black text-sm">Send {engine.label} Report</p>
              <p className="text-[11px] opacity-70">{connName} · PDF attached automatically</p>
            </div>
          </div>
          <button onClick={onClose} className="text-white/70 hover:text-white text-lg leading-none">✕</button>
        </div>

        <div className="flex border-b border-slate-100 bg-slate-50">
          {[['send', 'Send Now', Send], ['schedule', 'Schedule', Bell]].map(([t, lx, Ic]) => (
            <button key={t} onClick={() => { if (!busy) { setTab(t); setResult(null); } }}
              className={`flex items-center gap-2 px-5 py-2.5 text-xs font-bold transition-all ${tab === t ? 'bg-white border-b-2 border-blue-600 text-blue-700' : 'text-slate-400 hover:text-slate-600'}`}>
              <Ic size={13} />{lx}
            </button>
          ))}
        </div>

        {busy && (
          <div className="px-5 py-2.5 bg-blue-50 border-b border-blue-100 flex items-center gap-3">
            <div className="h-1.5 w-20 rounded-full bg-blue-500 animate-pulse" />
            <p className="text-[11px] font-bold text-blue-700 flex items-center gap-2">
              <RefreshCw size={11} className="animate-spin flex-shrink-0" /> Sending email with PDF report…
            </p>
          </div>
        )}

        <div className="p-5 space-y-4 overflow-y-auto" style={{ maxHeight: '60vh' }}>
          {smtpCfg ? (
            <div className="flex items-center gap-3 p-3 bg-green-50 border border-green-200 rounded-xl">
              <CheckCircle2 size={16} className="text-green-600 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-xs font-black text-green-800">{smtpCfg.name}</p>
                <p className="text-[11px] text-green-700 truncate">{smtpCfg.sender_email} · via {smtpCfg.smtp_host}:{smtpCfg.smtp_port}</p>
              </div>
              <Link to="/settings" onClick={onClose} className="text-[11px] font-bold text-green-700 underline flex-shrink-0">Change</Link>
            </div>
          ) : (
            <div className="flex items-center gap-3 p-3 bg-red-50 border border-red-200 rounded-xl">
              <XCircle size={16} className="text-red-500 flex-shrink-0" />
              <div className="flex-1">
                <p className="text-xs font-black text-red-700">No SMTP configured</p>
                <p className="text-[11px] text-red-600">Set up mail server in Settings first</p>
              </div>
              <Link to="/settings" onClick={onClose} className="text-[11px] font-bold text-red-700 underline flex-shrink-0">Configure</Link>
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
                <span>PDF capture failed — <b>backend will generate a report PDF</b> from live data.</span>
              </div>
              {captureErrMsg && <div className="ml-6 mt-0.5 px-2 py-1 bg-amber-100 rounded text-[10px] font-mono text-amber-800 break-all">{captureErrMsg}</div>}
            </div>
          )}

          {tab === 'schedule' && (
            <div><label className={lbl}>Schedule Name</label>
              <input className={inp} value={schedName} onChange={e => setSchedName(e.target.value)} /></div>
          )}

          <div><label className={lbl}>Recipient Emails <span className="text-slate-400 font-normal">(comma-separated)</span></label>
            <input className={inp} placeholder="dba@company.com, admin@company.com" value={recipients} onChange={e => setRecipients(e.target.value)} /></div>

          <div><label className={lbl}>Report Period</label>
            <select className={inp} value={period} onChange={e => setPeriod(e.target.value)}>
              <option value="live">Live (Real-Time)</option>
              <option value="1h">Last 1 Hour</option>
              <option value="24h">Last 24 Hours</option>
              <option value="7d">Last 7 Days</option>
              <option value="30d">Last 30 Days</option>
              <option value="90d">Last 90 Days</option>
              <option value="1y">Last 1 Year</option>
            </select>
          </div>

          {tab === 'schedule' && (
            <div className="border-t border-slate-100 pt-4 space-y-3">
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Recurrence</p>
              <div><label className={lbl}>Frequency</label>
                <select className={inp} value={freq} onChange={e => setFreq(e.target.value)}>
                  <option value="hourly">Every Hour</option>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                  <option value="yearly">Yearly</option>
                </select>
              </div>
              {freq !== 'hourly' && (
                <div><label className={lbl}>Send Time</label>
                  <div className="flex gap-2">
                    <select className={inp} style={{ flex: '0 0 76px' }} value={timeH12} onChange={e => setTimeH12(Number(e.target.value))}>
                      {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(h => <option key={h} value={h}>{String(h).padStart(2, '0')}</option>)}
                    </select>
                    <span className="self-center text-slate-400 font-bold">:</span>
                    <select className={inp} style={{ flex: '0 0 76px' }} value={minute} onChange={e => setMinute(Number(e.target.value))}>
                      {[0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55].map(m => <option key={m} value={m}>{String(m).padStart(2, '0')}</option>)}
                    </select>
                    <div className="flex rounded-lg overflow-hidden border border-slate-200 flex-shrink-0">
                      {['AM', 'PM'].map(ap => (
                        <button key={ap} type="button" onClick={() => setTimeAmPm(ap)}
                          className={`px-3 py-2 text-xs font-bold transition-colors ${timeAmPm === ap ? 'bg-blue-600 text-white' : 'bg-white text-slate-500 hover:bg-slate-50'}`}>{ap}</button>
                      ))}
                    </div>
                  </div>
                  <p className="text-[10px] text-slate-400 mt-1">= {String(hour24()).padStart(2, '0')}:{String(minute).padStart(2, '0')} UTC</p>
                </div>
              )}
              {freq === 'hourly' && (
                <div><label className={lbl}>At Minute (0–59)</label>
                  <select className={inp} value={minute} onChange={e => setMinute(Number(e.target.value))}>
                    {[0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55].map(m => <option key={m} value={m}>{String(m).padStart(2, '0')} past the hour</option>)}
                  </select>
                </div>
              )}
              {freq === 'weekly' && (
                <div><label className={lbl}>Day of Week</label>
                  <select className={inp} value={dow} onChange={e => setDow(e.target.value)}>
                    {['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map((d, i) => <option key={i} value={String(i)}>{d}</option>)}
                  </select>
                </div>
              )}
              {freq === 'monthly' && (
                <div><label className={lbl}>Day of Month (1–28)</label>
                  <select className={inp} value={dom} onChange={e => setDom(Number(e.target.value))}>
                    {Array.from({ length: 28 }, (_, i) => i + 1).map(d => <option key={d} value={d}>{d}</option>)}
                  </select>
                </div>
              )}
              {freq === 'yearly' && (
                <div className="grid grid-cols-2 gap-3">
                  <div><label className={lbl}>Month</label>
                    <select className={inp} value={schedMonth} onChange={e => setSchedMonth(Number(e.target.value))}>
                      {['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'].map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
                    </select>
                  </div>
                  <div><label className={lbl}>Day (1–28)</label>
                    <select className={inp} value={dom} onChange={e => setDom(Number(e.target.value))}>
                      {Array.from({ length: 28 }, (_, i) => i + 1).map(d => <option key={d} value={d}>{d}</option>)}
                    </select>
                  </div>
                </div>
              )}
            </div>
          )}

          {result && (
            <div className={`rounded-xl border overflow-hidden ${result.ok ? 'border-green-200' : result.warn ? 'border-amber-200' : 'border-red-200'}`}>
              <div className={`px-4 py-3 text-xs font-semibold flex items-start gap-2 ${result.ok ? 'bg-green-50 text-green-800' : result.warn ? 'bg-amber-50 text-amber-800' : 'bg-red-50 text-red-800'}`}>
                {result.ok ? <CheckCircle2 size={14} className="flex-shrink-0 mt-0.5" /> : result.warn ? <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" /> : <XCircle size={14} className="flex-shrink-0 mt-0.5" />}
                <span>{result.msg}</span>
              </div>
              {(result.ok || result.warn) && (
                <div className="px-4 py-2.5 bg-slate-50 border-t border-slate-100 text-[11px] text-slate-600 space-y-1">
                  <p className="font-bold text-slate-700">📬 Not in inbox?</p>
                  <ul className="list-disc pl-4 space-y-0.5">
                    <li>Check <b>Outlook → Junk Email</b> folder → right-click → "Not Junk"</li>
                    <li>PDF file: <b>{engine.label.replace(/\s/g, '')}_Report_{connName?.replace(/\s/g, '_')}_*.pdf</b></li>
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="px-5 py-3.5 border-t border-slate-100 flex justify-end gap-2">
          <button onClick={onClose} disabled={busy} className="px-4 py-2 text-xs font-semibold text-slate-600 bg-slate-100 rounded-lg hover:bg-slate-200 disabled:opacity-50">
            {step === 'done' ? 'Close' : 'Cancel'}
          </button>
          {step !== 'done' && (
            <button onClick={tab === 'send' ? handleSend : handleSchedule} disabled={busy || !smtpCfg}
              className="flex items-center gap-2 px-5 py-2 text-xs font-black text-white rounded-lg disabled:opacity-50" style={{ background: engine.gradient }}>
              {busy ? <RefreshCw size={13} className="animate-spin" /> : tab === 'send' ? <Send size={13} /> : <Bell size={13} />}
              {busy ? 'Sending…' : tab === 'send' ? 'Generate PDF & Send' : 'Create Schedule'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─── client-side PDF capture (identical algorithm for every engine) ─── */
async function capturePdf(reportElementId) {
  const [htiMod, jpMod] = await Promise.all([import('html-to-image'), import('jspdf')]);
  const toCanvas = htiMod.toCanvas;
  const jsPDF = jpMod.jsPDF;
  if (typeof toCanvas !== 'function') throw new Error('html-to-image toCanvas not available');
  if (typeof jsPDF !== 'function') throw new Error('jsPDF import failed');

  const el = document.getElementById(reportElementId);
  if (!el) throw new Error(`Element #${reportElementId} not found`);
  window.scrollTo(0, 0);
  await new Promise(r => setTimeout(r, 100));

  const CAPTURE_PX = 794, PIXEL_RATIO = 2;
  const MH = 12, MV = 14, CONT_W = 210 - 2 * MH, CONT_H = 297 - 2 * MV;

  const saved = { w: el.style.width, mw: el.style.maxWidth, nw: el.style.minWidth, bg: el.style.background, ml: el.style.marginLeft, mr: el.style.marginRight };
  const printHeader = el.querySelector('[class*="print:block"]');
  const savedHdr = printHeader ? printHeader.style.display : '';

  el.style.width = `${CAPTURE_PX}px`; el.style.maxWidth = `${CAPTURE_PX}px`;
  el.style.minWidth = `${CAPTURE_PX}px`; el.style.background = '#ffffff';
  el.style.marginLeft = '0'; el.style.marginRight = '0';
  if (printHeader) printHeader.style.display = 'block';
  await new Promise(r => setTimeout(r, 300));

  const elRect = el.getBoundingClientRect();
  const unitBounds = [...el.children].map(c => {
    const r = c.getBoundingClientRect();
    return { top: Math.round((r.top - elRect.top) * PIXEL_RATIO), bottom: Math.round((r.bottom - elRect.top) * PIXEL_RATIO) };
  }).filter(b => b.bottom > b.top + 4);
  const forcedBreakTops = [...el.querySelectorAll('.page-break')].map(pb => {
    const r = pb.getBoundingClientRect();
    return Math.round((r.top - elRect.top) * PIXEL_RATIO);
  }).filter(y => y > 0);

  let canvas;
  try {
    canvas = await toCanvas(el, { pixelRatio: PIXEL_RATIO, backgroundColor: '#ffffff', skipFonts: false, cacheBust: true, width: CAPTURE_PX });
  } finally {
    el.style.width = saved.w; el.style.maxWidth = saved.mw; el.style.minWidth = saved.nw;
    el.style.background = saved.bg; el.style.marginLeft = saved.ml; el.style.marginRight = saved.mr;
    if (printHeader) printHeader.style.display = savedHdr;
  }
  if (!canvas?.width || !canvas?.height) throw new Error('html-to-image returned empty canvas');

  const expectedW = CAPTURE_PX * PIXEL_RATIO;
  let workCanvas = canvas;
  if (canvas.width > expectedW + 4) {
    const cropX = Math.round((canvas.width - expectedW) / 2);
    workCanvas = document.createElement('canvas');
    workCanvas.width = expectedW; workCanvas.height = canvas.height;
    const wCtx = workCanvas.getContext('2d');
    wCtx.fillStyle = '#ffffff'; wCtx.fillRect(0, 0, expectedW, canvas.height);
    wCtx.drawImage(canvas, cropX, 0, expectedW, canvas.height, 0, 0, expectedW, canvas.height);
  }

  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pxPerMm = workCanvas.width / CONT_W;
  const pagePx = Math.round(CONT_H * pxPerMm);
  const GAP_PX = Math.round(16 * PIXEL_RATIO);
  const gapBreaks = unitBounds.map(b => b.bottom + Math.round(GAP_PX * 0.5));
  const pageBreaks = [0]; let cursor = 0;

  while (cursor < workCanvas.height) {
    const windowEnd = cursor + pagePx;
    if (windowEnd >= workCanvas.height) { pageBreaks.push(workCanvas.height); break; }
    const forced = forcedBreakTops.find(y => y > cursor + GAP_PX && y <= windowEnd);
    if (forced) { pageBreaks.push(forced); cursor = forced; continue; }
    const minY = cursor + Math.round(pagePx * 0.35);
    const choices = gapBreaks.filter(y => y > minY && y <= windowEnd);
    const breakY = choices.length ? choices[choices.length - 1] : windowEnd;
    pageBreaks.push(breakY); cursor = breakY;
  }

  for (let i = 0; i < pageBreaks.length - 1; i++) {
    if (i > 0) pdf.addPage();
    const srcY = pageBreaks[i], srcH = pageBreaks[i + 1] - srcY;
    if (srcH <= 0) continue;
    const slice = document.createElement('canvas');
    slice.width = workCanvas.width; slice.height = srcH;
    const ctx = slice.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, workCanvas.width, srcH);
    ctx.drawImage(workCanvas, 0, srcY, workCanvas.width, srcH, 0, 0, workCanvas.width, srcH);
    pdf.addImage(slice.toDataURL('image/jpeg', 0.92), 'JPEG', MH, MV, CONT_W, srcH / pxPerMm);
    slice.width = 0;
  }

  const dataUri = pdf.output('datauristring');
  const b64start = dataUri.indexOf(';base64,');
  const pdfB64 = b64start >= 0 ? dataUri.slice(b64start + 8) : dataUri.split(',')[1];
  if (!pdfB64) throw new Error('pdf.output returned empty base64');
  return pdfB64;
}

/* ─── ReportShell — the shared control header + printable container ─── */
export function ReportShell({
  engine, id, period, setPeriod, genTime, setGenTime, onRefresh,
  connName, subtitle, alertBadges = [], children,
}) {
  const { canHere } = usePermissions();
  const [showEmailModal, setShowEmailModal] = useState(false);
  const [capturingPdf, setCapturingPdf] = useState(false);
  const [capturedPdfB64, setCapturedPdfB64] = useState(null);
  const [captureErrMsg, setCaptureErrMsg] = useState(null);
  const printRef = useRef(null);
  const reportElementId = `${engine.key}-report`;

  const handlePrint = () => { setGenTime(now()); setTimeout(() => window.print(), 200); };

  const openEmailModal = async () => {
    setCapturingPdf(true); setCapturedPdfB64(null); setCaptureErrMsg(null);
    let pdfB64 = null, errMsg = null;
    try { pdfB64 = await capturePdf(reportElementId); }
    catch (e) { errMsg = e?.message || String(e); console.error('[ActMon] PDF capture error:', errMsg); }
    setCapturedPdfB64(pdfB64); setCaptureErrMsg(errMsg);
    setCapturingPdf(false); setShowEmailModal(true);
  };

  const periodObj = PERIODS.find(p => p.id === period) || PERIODS[0];

  return (
    <div className="min-h-screen bg-[#f1f5f9]" id={`${engine.key}-report-root`}>
      {showEmailModal && (
        <EmailScheduleModal id={id} engine={engine} connName={connName}
          capturedPdfB64={capturedPdfB64} captureErrMsg={captureErrMsg}
          onClose={() => setShowEmailModal(false)} />
      )}

      {/* ─── CONTROL HEADER ─── */}
      <div className="no-print text-white shadow-xl sticky top-0 z-40" style={{ background: engine.headerGradient }}>
        <div className="px-6 pt-4 pb-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-4">
            <Link to={engine.backTo} className="w-9 h-9 rounded-xl flex items-center justify-center transition-all"
              style={{ background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)' }}>
              <ArrowLeft size={16} />
            </Link>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center text-xl"
                style={{ background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.3)' }}>{engine.emoji}</div>
              <div>
                <h1 className="text-[18px] font-black tracking-tight">{engine.label} Monitoring Report</h1>
                <p className="text-[12px] mt-0.5" style={{ color: 'rgba(226,240,255,0.8)' }}>{connName}{subtitle ? ` — ${subtitle}` : ''}</p>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex items-center gap-1 bg-white/10 rounded-xl p-1 border border-white/20">
              {PERIODS.map(p => (
                <button key={p.id} onClick={() => setPeriod(p.id)}
                  className="px-3 py-1 rounded-lg text-[11px] font-bold transition-all"
                  style={period === p.id ? { background: p.color, color: '#fff', boxShadow: '0 1px 4px rgba(0,0,0,0.3)' } : { color: 'rgba(255,255,255,0.6)' }}>
                  {p.label}
                </button>
              ))}
            </div>
            <button onClick={() => { onRefresh?.(); setGenTime(now()); }}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all"
              style={{ background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)' }}>
              <RefreshCw size={13} /> Refresh
            </button>
            {canHere('execute') && (
              <button onClick={openEmailModal} disabled={capturingPdf}
                className="flex items-center gap-2 px-4 py-1.5 rounded-lg text-xs font-bold transition-all disabled:opacity-60"
                style={{ background: 'rgba(255,255,255,0.18)', border: '1px solid rgba(255,255,255,0.35)' }}>
                {capturingPdf ? <><Loader size={13} className="animate-spin" /> Preparing PDF…</> : <><Mail size={13} /> Send / Schedule</>}
              </button>
            )}
            {canHere('export') && (
              <button onClick={handlePrint}
                className="flex items-center gap-2 px-4 py-1.5 rounded-lg text-xs font-bold transition-all"
                style={{ background: engine.gradient, border: '1px solid rgba(255,255,255,0.3)' }}>
                <Download size={13} /> Download PDF
              </button>
            )}
          </div>
        </div>

        <div className="px-6 pb-3 flex items-center gap-3 flex-wrap">
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
          {alertBadges.filter(Boolean).map((b, i) => (
            <span key={i} className={`flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full border ${b.tone === 'red' ? 'bg-red-500/20 text-red-300 border-red-500/30' : 'bg-amber-500/20 text-amber-300 border-amber-500/30'}`}>
              {b.tone === 'red' ? <AlertOctagon size={10} /> : <AlertTriangle size={10} />} {b.label}
            </span>
          ))}
        </div>
      </div>

      {/* ─── PRINTABLE REPORT ─── */}
      <div ref={printRef} className="max-w-[1200px] mx-auto p-5" id={reportElementId}>
        {/* Print-only header */}
        <div className="hidden print:block mb-6 pb-4 border-b-2 border-slate-800">
          <div className="flex justify-between items-start">
            <div>
              <h1 className="text-2xl font-black text-slate-900">{engine.label} Database Monitoring Report</h1>
              <p className="text-sm text-slate-600 mt-1">{connName}{subtitle ? ` — ${subtitle}` : ''}</p>
            </div>
            <div className="text-right">
              <p className="text-sm font-bold text-slate-700">{periodObj.label} Report</p>
              <p className="text-xs text-slate-500 mt-0.5">Generated: {genTime}</p>
              <p className="text-xs text-slate-500">Powered by Actmon</p>
            </div>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

/* health-check chip row — same look as PostgreSQL Executive Summary */
export function HealthChecks({ checks }) {
  return (
    <>
      <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Health Checks</p>
      <div className="flex flex-wrap gap-2">
        {checks.map(({ ok, label }) => (
          <span key={label} className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold border ${ok ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-red-50 border-red-200 text-red-700'}`}>
            {ok ? <CheckCircle2 size={11} /> : <AlertTriangle size={11} />}{label}
          </span>
        ))}
      </div>
    </>
  );
}
