/**
 * ActMon AI — Floating Chatbot Widget
 * Features: SSE streaming, navigation commands, PDF report export,
 *           SQL code blocks, suggestion chips, context-awareness.
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Brain, X, Maximize2, Send, Copy, Check, Download, FileText,
  ChevronDown, Trash2, Database, Loader2, Code2, Navigation,
  ArrowUpRight, Zap, MessageSquare, ExternalLink, BarChart2,
} from 'lucide-react';
import { streamChat, fetchConnections, downloadReport } from '../../api/chatbot';

/* ══════════════════════════════════════════════════════
   NAVIGATION DETECTION
══════════════════════════════════════════════════════ */
const DB_KEYWORDS = {
  mysql:      ['mysql', 'mariadb', 'maria'],
  postgresql: ['postgresql', 'postgres', 'pg', 'psql'],
  mongodb:    ['mongodb', 'mongo'],
  mssql:      ['mssql', 'sql server', 'sqlserver', 'microsoft sql'],
  oracle:     ['oracle', 'ora'],
  clickhouse: ['clickhouse', 'click house'],
};

const PAGE_KEYWORDS = {
  'slow-queries':       ['slow quer', 'slow query', 'slow queries', 'top queries'],
  'error-logs':         ['error log', 'error logs', 'errors'],
  'index-analysis':     ['index', 'indexes', 'indices'],
  'backup':             ['backup', 'backups'],
  'slow-operations':    ['slow operation', 'slow op'],
  'collection-analysis':['collection'],
};

function dashboardPath(conn) {
  const t = (conn.db_type || '').toLowerCase();
  const map = { mysql:'/mysql-dashboard/', postgresql:'/postgresql-dashboard/', oracle:'/oracle-dashboard/', mssql:'/mssql-dashboard/', mongodb:'/mongodb-dashboard/', clickhouse:'/clickhouse-dashboard/' };
  return (map[t] || '/mysql-dashboard/') + conn.id;
}

function detectNavCommand(text, connections) {
  const lower = text.toLowerCase().trim();
  const navKw = ['open', 'go to', 'navigate', 'show', 'launch', 'take me to', 'switch to', 'view'];
  const hasNav = navKw.some(k => lower.startsWith(k) || lower.includes(' ' + k + ' '));
  if (!hasNav) return null;

  // Match by connection name first (most specific)
  for (const conn of connections) {
    const name = (conn.connection_name || conn.host || '').toLowerCase();
    if (name && lower.includes(name)) {
      // Check for sub-page
      let subPage = null;
      for (const [page, keywords] of Object.entries(PAGE_KEYWORDS)) {
        if (keywords.some(k => lower.includes(k))) { subPage = page; break; }
      }
      const base = dashboardPath(conn);
      return { conn, path: subPage ? base + '/' + subPage : base, subPage };
    }
  }

  // Match by DB type keyword
  for (const [type, keywords] of Object.entries(DB_KEYWORDS)) {
    if (keywords.some(k => lower.includes(k))) {
      const conn = connections.find(c => (c.db_type || '').toLowerCase() === type || keywords.some(k => (c.db_type || '').toLowerCase().includes(k)));
      if (conn) {
        let subPage = null;
        for (const [page, pkw] of Object.entries(PAGE_KEYWORDS)) {
          if (pkw.some(k => lower.includes(k))) { subPage = page; break; }
        }
        const base = dashboardPath(conn);
        return { conn, path: subPage ? base + '/' + subPage : base, subPage };
      }
    }
  }

  return null;
}

/* ══════════════════════════════════════════════════════
   PDF REPORT GENERATOR
══════════════════════════════════════════════════════ */
function generatePDFReport(messages, connections = []) {
  const ts = new Date().toLocaleString();
  const aiMsgs = messages.filter(m => m.role === 'assistant' && !m.streaming && m.content);
  const userMsgs = messages.filter(m => m.role === 'user');

  const msgHtml = messages
    .filter(m => !m.streaming && m.content)
    .map(m => {
      const isUser = m.role === 'user';
      const content = m.content
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/`([^`]+)`/g, '<code style="background:#f1f5f9;padding:2px 6px;border-radius:4px;font-family:monospace">$1</code>')
        .replace(/```[\w]*\n?([\s\S]*?)```/g, '<pre style="background:#0f172a;color:#e2e8f0;padding:12px 16px;border-radius:8px;font-size:12px;overflow:auto;margin:8px 0">$1</pre>')
        .replace(/\n/g, '<br>');
      return `
        <div style="margin-bottom:20px;${isUser ? 'text-align:right' : ''}">
          <div style="display:inline-block;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#94a3b8;margin-bottom:4px">${isUser ? 'You' : '🧠 ActMon AI'}</div>
          <div style="display:${isUser ? 'inline-block' : 'block'};background:${isUser ? '#4f46e5' : '#f8fafc'};color:${isUser ? '#fff' : '#1e293b'};border:${isUser ? 'none' : '1px solid #e2e8f0'};padding:12px 16px;border-radius:12px;font-size:13px;line-height:1.65;max-width:85%;text-align:left">${content}</div>
          ${m.timestamp ? `<div style="font-size:10px;color:#cbd5e1;margin-top:4px">${m.timestamp}</div>` : ''}
        </div>`;
    }).join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>ActMon AI Report — ${ts}</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:'Segoe UI',system-ui,sans-serif;color:#1e293b;background:#fff;font-size:14px}
  .header{background:linear-gradient(135deg,#312e81 0%,#4f46e5 60%,#7c3aed 100%);color:#fff;padding:36px 48px;position:relative;overflow:hidden}
  .header::after{content:'';position:absolute;top:-40px;right:-40px;width:200px;height:200px;border-radius:50%;background:rgba(255,255,255,0.05)}
  .header h1{font-size:26px;font-weight:900;letter-spacing:-0.5px}
  .header .meta{font-size:12px;opacity:0.75;margin-top:6px}
  .header .badges{display:flex;gap:8px;margin-top:12px}
  .badge{background:rgba(255,255,255,0.15);border:1px solid rgba(255,255,255,0.2);padding:4px 10px;border-radius:20px;font-size:11px;font-weight:700}
  .stats-bar{display:grid;grid-template-columns:repeat(3,1fr);background:#f1f5f9;border-bottom:1px solid #e2e8f0}
  .stat{padding:16px 24px;border-right:1px solid #e2e8f0}
  .stat:last-child{border-right:none}
  .stat .num{font-size:28px;font-weight:900;color:#4f46e5}
  .stat .lbl{font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;margin-top:2px}
  .section{padding:32px 48px;border-bottom:1px solid #f1f5f9}
  .section-title{font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:0.08em;color:#94a3b8;margin-bottom:20px;display:flex;align-items:center;gap:8px}
  .section-title::after{content:'';flex:1;height:1px;background:#f1f5f9}
  .conn-table{width:100%;border-collapse:collapse;font-size:12px}
  .conn-table th{background:#f8fafc;padding:8px 12px;text-align:left;font-weight:700;color:#64748b;font-size:11px;text-transform:uppercase;letter-spacing:0.05em;border-bottom:2px solid #e2e8f0}
  .conn-table td{padding:10px 12px;border-bottom:1px solid #f1f5f9;color:#334155}
  .type-pill{display:inline-block;padding:3px 8px;border-radius:20px;font-size:10px;font-weight:700}
  .mysql{background:#fff7ed;color:#c2410c}.postgresql{background:#eef2ff;color:#4338ca}.mongodb{background:#ecfdf5;color:#065f46}.mssql{background:#e0f2fe;color:#0369a1}.oracle{background:#fef2f2;color:#dc2626}.clickhouse{background:#fefce8;color:#a16207}
  .chat-area{padding:32px 48px}
  .footer{text-align:center;padding:24px;color:#94a3b8;font-size:11px;border-top:2px solid #f1f5f9;background:#fafafa}
  @media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}.header{background:linear-gradient(135deg,#312e81,#4f46e5,#7c3aed) !important}}
</style>
</head>
<body>
<div class="header">
  <h1>🧠 ActMon AI Analysis Report</h1>
  <div class="meta">Generated ${ts}</div>
  <div class="badges">
    <div class="badge">${aiMsgs.length} AI Responses</div>
    <div class="badge">${userMsgs.length} Queries</div>
    <div class="badge">ActMon DBA Assistant</div>
  </div>
</div>

<div class="stats-bar">
  <div class="stat"><div class="num">${userMsgs.length}</div><div class="lbl">Questions Asked</div></div>
  <div class="stat"><div class="num">${aiMsgs.length}</div><div class="lbl">AI Responses</div></div>
  <div class="stat"><div class="num">${connections.length}</div><div class="lbl">DB Connections</div></div>
</div>

${connections.length > 0 ? `
<div class="section">
  <div class="section-title">Database Connections</div>
  <table class="conn-table">
    <thead><tr><th>#</th><th>Name</th><th>Type</th><th>Host</th></tr></thead>
    <tbody>
      ${connections.map(c => `<tr>
        <td>${c.id}</td>
        <td><strong>${c.connection_name || c.host}</strong></td>
        <td><span class="type-pill ${(c.db_type||'').toLowerCase()}">${(c.db_type||'').toUpperCase()}</span></td>
        <td style="font-family:monospace;font-size:11px">${c.host}:${c.port||'default'}</td>
      </tr>`).join('')}
    </tbody>
  </table>
</div>` : ''}

<div class="section">
  <div class="section-title">Conversation Analysis</div>
</div>

<div class="chat-area">${msgHtml}</div>

<div class="footer">
  ActMon AI · DBA Intelligence Platform · ${ts} · Confidential
</div>
</body>
</html>`;

  const win = window.open('', '_blank', 'width=900,height=700');
  if (!win) { alert('Please allow popups to generate PDF reports.'); return; }
  win.document.write(html);
  win.document.close();
  setTimeout(() => { try { win.print(); } catch(e) {} }, 600);
}

/* ══════════════════════════════════════════════════════
   TEXT / CODE PARSERS
══════════════════════════════════════════════════════ */
function parseSegments(text) {
  const clean = (text || '')
    .replace(/^SUGGESTIONS:.*$/m, '')
    .replace(/\[ACTION:[^\]]+\]/g, '')
    .trim();
  const segs = [];
  const re = /```(\w+)?\n?([\s\S]*?)```/g;
  let last = 0, m;
  while ((m = re.exec(clean)) !== null) {
    if (m.index > last) segs.push({ type: 'text', content: clean.slice(last, m.index) });
    segs.push({ type: 'code', language: m[1] || 'sql', content: m[2].trim() });
    last = m.index + m[0].length;
  }
  if (last < clean.length) segs.push({ type: 'text', content: clean.slice(last) });
  return segs.filter(s => s.content.trim());
}

function highlightSQL(raw) {
  const KW = /\b(SELECT|FROM|WHERE|JOIN|LEFT|RIGHT|INNER|OUTER|ON|GROUP\s+BY|ORDER\s+BY|HAVING|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|INDEX|VIEW|ALTER|DROP|IF|NOT|EXISTS|NULL|PRIMARY|KEY|FOREIGN|REFERENCES|DEFAULT|UNIQUE|AUTO_INCREMENT|BIGSERIAL|BIGINT|INTEGER|INT|VARCHAR|TEXT|BOOLEAN|TIMESTAMPTZ|TIMESTAMP|DATETIME|SERIAL|IDENTITY|ENGINE|AS|WITH|CASE|WHEN|THEN|ELSE|AND|OR|IN|IS|LIKE|BETWEEN|EXISTS|UNION|DISTINCT|LIMIT|OFFSET|ASC|DESC|COUNT|SUM|AVG|MAX|MIN|COALESCE|CAST|NOW|CURRENT_TIMESTAMP)\b/gi;
  return raw
    .replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(KW, '<span style="color:#93c5fd;font-weight:600">$&</span>')
    .replace(/--[^\n]*/g, '<span style="color:#64748b;font-style:italic">$&</span>')
    .replace(/('[^']*')/g, '<span style="color:#86efac">$1</span>');
}

/* ══════════════════════════════════════════════════════
   SUB-COMPONENTS
══════════════════════════════════════════════════════ */
function CopyBtn({ text }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      onClick={() => { navigator.clipboard.writeText(text); setOk(true); setTimeout(()=>setOk(false),2000); }}
      className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold transition-colors"
      style={ok ? {background:'#d1fae5',color:'#065f46'} : {background:'#1e293b',color:'#94a3b8'}}
    >
      {ok ? <Check size={10}/> : <Copy size={10}/>}
      {ok ? 'Copied' : 'Copy'}
    </button>
  );
}

function CodeBlock({ language, content }) {
  return (
    <div className="rounded-xl overflow-hidden border border-slate-700 text-xs my-2">
      <div className="flex items-center justify-between px-3 py-1.5 bg-[#1e293b]">
        <div className="flex items-center gap-2">
          <div className="flex gap-1">
            <div className="w-2.5 h-2.5 rounded-full bg-red-500 opacity-80"/>
            <div className="w-2.5 h-2.5 rounded-full bg-yellow-400 opacity-80"/>
            <div className="w-2.5 h-2.5 rounded-full bg-green-500 opacity-80"/>
          </div>
          <Code2 size={10} className="text-slate-400"/>
          <span className="font-bold text-slate-400 uppercase tracking-wider text-[9px]">{language}</span>
        </div>
        <CopyBtn text={content}/>
      </div>
      <pre
        className="p-3 overflow-x-auto bg-[#0d1117] text-slate-200 leading-relaxed whitespace-pre-wrap"
        dangerouslySetInnerHTML={{ __html: highlightSQL(content) }}
      />
    </div>
  );
}

function RichText({ content }) {
  const html = (content || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong class="font-semibold text-slate-900">$1</strong>')
    .replace(/`([^`]+)`/g, '<code class="font-mono text-[11px] bg-indigo-50 px-1 py-0.5 rounded text-indigo-700 border border-indigo-100">$1</code>')
    .replace(/^#{1,3}\s+(.+)$/gm, '<div class="font-black text-slate-800 mt-2 mb-0.5 text-sm">$1</div>')
    .replace(/^[-•]\s+(.+)$/gm, '<div class="flex gap-1.5 my-0.5 items-start"><span class="text-indigo-400 font-black mt-0.5 flex-shrink-0">•</span><span>$1</span></div>')
    .replace(/^\d+\.\s+(.+)$/gm, (m, p1, offset, str) => {
      const num = str.slice(0, offset).match(/^\d+\./gm)?.length + 1 || 1;
      return `<div class="flex gap-1.5 my-0.5 items-start"><span class="text-indigo-500 font-black w-4 flex-shrink-0 mt-0.5 text-[11px]">${num}.</span><span>${p1}</span></div>`;
    })
    .split('\n')
    .map(l => {
      const t = l.trim();
      if (!t) return '';                       // collapse blank lines (gap comes from spacing)
      if (t.startsWith('<')) return t;          // already a block element (heading/bullet)
      return `<div>${t}</div>`;                 // plain line → block (clean vertical flow, no overlap)
    })
    .filter(Boolean)
    .join('');
  return <div className="text-[13px] text-slate-700 leading-relaxed space-y-1 break-words" dangerouslySetInnerHTML={{ __html: html }}/>;
}

function NavigateBtn({ nav, navigate, onClose }) {
  return (
    <button
      onClick={() => { navigate(nav.path); onClose(); }}
      className="flex items-center gap-2 mt-2 px-3 py-2 rounded-xl text-xs font-bold bg-emerald-50 border border-emerald-200 text-emerald-700 hover:bg-emerald-100 transition-colors w-full"
    >
      <ArrowUpRight size={13}/>
      Open {nav.conn.connection_name || nav.conn.host} Dashboard
    </button>
  );
}

function AssistantBubble({ msg, onReport, navigate, onClose }) {
  const segs = parseSegments(msg.content || '');
  const hasContent = msg.content && msg.content.trim();
  const hasActions = msg.actions?.length > 0;
  const hasNav = msg.navResult;

  if (msg.streaming && !hasContent) {
    return (
      <div className="flex gap-2.5 mb-4">
        <div className="w-7 h-7 rounded-full bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center flex-shrink-0 mt-0.5 shadow-sm">
          <Brain size={13} className="text-white"/>
        </div>
        <div className="bg-white border border-slate-100 rounded-2xl rounded-tl-md px-4 py-3 shadow-sm">
          <div className="flex gap-1 py-0.5">
            {[0,1,2].map(i=>(
              <div key={i} className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-bounce" style={{animationDelay:`${i*0.18}s`}}/>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-2.5 mb-4">
      <div className="w-7 h-7 rounded-full bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center flex-shrink-0 mt-0.5 shadow-sm">
        <Brain size={13} className="text-white"/>
      </div>
      <div className="flex-1 min-w-0">
        <div className="bg-white border border-slate-100 rounded-2xl rounded-tl-md shadow-sm overflow-hidden">
          {/* message content */}
          <div className="px-4 pt-3 pb-2">
            {segs.map((seg, i) =>
              seg.type === 'code'
                ? <CodeBlock key={i} language={seg.language} content={seg.content}/>
                : <RichText key={i} content={seg.content}/>
            )}
          </div>
          {/* actions section — always below content, clearly separated */}
          {(hasActions || hasNav) && (
            <div className="px-4 pb-3 pt-1 border-t border-slate-50 space-y-1.5 bg-slate-50/50">
              {hasNav && <NavigateBtn nav={msg.navResult} navigate={navigate} onClose={onClose}/>}
              {msg.actions?.map((a, i) => {
                const labels = { slow_queries:'Slow Queries CSV', health:'Health Report CSV', connections:'Connections CSV', indexes:'Index Report CSV' };
                return (
                  <button key={i}
                    onClick={() => onReport(a.subtype, a.conn_id)}
                    className="flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-bold bg-indigo-50 border border-indigo-100 text-indigo-700 hover:bg-indigo-100 transition-colors w-full"
                  >
                    <Download size={12}/> Download {labels[a.subtype] || a.subtype + ' CSV'}
                  </button>
                );
              })}
            </div>
          )}
        </div>
        {msg.timestamp && (
          <p className="text-[10px] text-slate-400 mt-1 px-1">{msg.timestamp}</p>
        )}
      </div>
    </div>
  );
}

function UserBubble({ msg }) {
  return (
    <div className="flex justify-end mb-4">
      <div className="max-w-[82%] bg-gradient-to-br from-indigo-500 to-violet-600 text-white text-[13px] px-4 py-2.5 rounded-2xl rounded-tr-md shadow-sm leading-relaxed whitespace-pre-wrap">
        {msg.content}
      </div>
    </div>
  );
}

function NavMessage({ nav, navigate, onClose }) {
  return (
    <div className="flex gap-2.5 mb-4">
      <div className="w-7 h-7 rounded-full bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center flex-shrink-0 mt-0.5 shadow-sm">
        <Navigation size={13} className="text-white"/>
      </div>
      <div className="flex-1 min-w-0">
        <div className="bg-white border border-emerald-100 rounded-2xl rounded-tl-md shadow-sm px-4 py-3">
          <p className="text-[13px] text-slate-700 mb-2">
            Navigating to <strong>{nav.conn.connection_name || nav.conn.host}</strong>
            {nav.subPage ? ` → ${nav.subPage.replace('-', ' ')}` : ' Dashboard'}
          </p>
          <button
            onClick={() => { navigate(nav.path); onClose(); }}
            className="flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-bold bg-emerald-50 border border-emerald-200 text-emerald-700 hover:bg-emerald-100 transition-colors"
          >
            <ArrowUpRight size={12}/> Go now →
          </button>
        </div>
      </div>
    </div>
  );
}

const QUICK_PROMPTS = [
  { emoji:'⚡', label:'Health Check',    msg:'Give me a health summary of all my connected databases.' },
  { emoji:'🐌', label:'Slow Queries',    msg:'What are the top slow queries I should fix first?' },
  { emoji:'📊', label:'CPU/Memory',      msg:'How do I check CPU and memory usage on my PostgreSQL databases?' },
  { emoji:'📋', label:'Generate Report', msg:'Create a full performance analysis report for my databases.' },
];

/* ══════════════════════════════════════════════════════
   MAIN WIDGET
══════════════════════════════════════════════════════ */
export default function ChatbotWidget() {
  const [open, setOpen]               = useState(false);
  const [wide, setWide]               = useState(false);
  const [messages, setMessages]       = useState([]);
  const [input, setInput]             = useState('');
  const [streaming, setStreaming]     = useState(false);
  const [suggestions, setSuggestions] = useState([]);
  const [connections, setConnections] = useState([]);
  const [ctxConnId, setCtxConnId]     = useState('');
  const [showCtx, setShowCtx]         = useState(false);
  const bottomRef = useRef(null);
  const inputRef  = useRef(null);
  const abortRef  = useRef(null);
  const location  = useLocation();
  const navigate  = useNavigate();

  useEffect(() => { fetchConnections().then(setConnections).catch(()=>{}); }, []);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior:'smooth' }); }, [messages]);
  useEffect(() => { if (open) setTimeout(()=>inputRef.current?.focus(), 150); }, [open]);

  const pageContext = (() => {
    const path = location.pathname;
    const m = path.match(/\/(mysql|postgresql|mongodb|mssql|oracle|clickhouse)-dashboard\/(\d+)/);
    if (m) return { db_type:m[1], connection_id:parseInt(m[2]) };
    return null;
  })();

  const addMsg = (msg) => setMessages(prev => [...prev, { id: Date.now()+Math.random(), ...msg }]);

  const updateLast = (patch) => setMessages(prev => {
    const next = [...prev];
    const i = next.length - 1;
    if (i >= 0 && next[i].role === 'assistant') next[i] = { ...next[i], ...patch };
    return next;
  });

  const send = useCallback(async (text = input.trim()) => {
    if (!text || streaming) return;
    setInput('');
    setSuggestions([]);

    // ── Navigation command detection ──────────────────
    const navResult = detectNavCommand(text, connections);
    if (navResult) {
      addMsg({ role:'user', content: text });
      addMsg({ role:'assistant', content: `Navigating you to **${navResult.conn.connection_name || navResult.conn.host}** dashboard.`, streaming:false, navResult, timestamp: new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}) });
      setTimeout(() => { navigate(navResult.path); setOpen(false); }, 800);
      return;
    }

    // ── Normal AI chat ────────────────────────────────
    addMsg({ role:'user', content: text });
    addMsg({ role:'assistant', content:'', streaming:true });
    setStreaming(true);

    const ctx = { ...pageContext, ...(ctxConnId ? { connection_id:parseInt(ctxConnId) } : {}) };
    const history = messages.filter(m=>!m.streaming&&m.role!=='system').slice(-16).map(m=>({role:m.role,content:m.content}));

    let accum = '';
    abortRef.current = streamChat({
      message: text,
      history,
      context: ctx,
      onToken: t => { accum += t; updateLast({ content:accum }); },
      onDone: meta => {
        const ts = new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
        updateLast({ content:accum, streaming:false, actions:meta.actions||[], timestamp:ts });
        setSuggestions(meta.suggestions||[]);
        setStreaming(false);
      },
      onError: err => {
        updateLast({ content:`Sorry, something went wrong: ${err}`, streaming:false, timestamp:new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}) });
        setStreaming(false);
      },
    });
  }, [input, streaming, messages, ctxConnId, pageContext, connections, navigate]);

  const handleReport = (type, connId) => {
    const cid = connId && connId !== 'unknown' ? connId : ctxConnId || undefined;
    downloadReport(type, cid);
  };

  const clearHistory = () => { setMessages([]); setSuggestions([]); };

  // ── Closed: floating button ─────────────────────────
  if (!open) {
    const msgCount = messages.filter(m=>m.role==='assistant'&&!m.streaming).length;
    return (
      <button
        onClick={()=>setOpen(true)}
        className="fixed bottom-6 right-6 z-50 group flex items-center gap-2.5 px-4 py-3 rounded-2xl text-white font-bold text-sm hover:scale-105 active:scale-95 transition-all shadow-2xl"
        style={{ background:'linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%)', boxShadow:'0 8px 32px rgba(79,70,229,0.4)' }}
      >
        <Brain size={18}/>
        <span>ActMon AI</span>
        {msgCount > 0 && (
          <span className="w-5 h-5 rounded-full bg-white text-indigo-700 text-xs font-black flex items-center justify-center">
            {msgCount}
          </span>
        )}
      </button>
    );
  }

  const W = wide ? 680 : 420;

  // ── Open: chat panel ───────────────────────────────
  return (
    <div
      className="fixed bottom-6 right-6 z-50 flex flex-col rounded-2xl shadow-2xl overflow-hidden transition-all duration-300"
      style={{ width:W, height:620, background:'var(--color-surface)', border:'1px solid rgba(99,102,241,0.15)' }}
    >
      {/* ── Header ───────────────────────────────────── */}
      <div className="flex-shrink-0 flex items-center gap-3 px-4 py-3 text-white"
        style={{ background:'linear-gradient(135deg,#2e1065 0%,#312e81 40%,#4f46e5 100%)' }}>
        <div className="w-8 h-8 rounded-xl bg-white/15 border border-white/20 flex items-center justify-center flex-shrink-0">
          <Brain size={16} className="text-white"/>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-black text-sm">ActMon AI</span>
            <span className="text-[9px] px-1.5 py-0.5 bg-white/20 rounded-full font-black tracking-wide uppercase">DBA</span>
          </div>
          <p className="text-[10px] text-indigo-200 mt-0.5 truncate">
            {pageContext ? `Context: ${pageContext.db_type?.toUpperCase()} #${pageContext.connection_id}` : 'No active context · ask me anything'}
          </p>
        </div>
        {/* action buttons */}
        <div className="flex items-center gap-0.5 flex-shrink-0">
          <button onClick={()=>setShowCtx(v=>!v)} title="Context"
            className={`p-2 rounded-lg transition-colors ${showCtx ? 'bg-white/25' : 'hover:bg-white/15'}`}>
            <Database size={13} className="text-indigo-200"/>
          </button>
          <button onClick={()=>generatePDFReport(messages, connections)} title="Export PDF"
            className="p-2 rounded-lg hover:bg-white/15 transition-colors" disabled={messages.length===0}>
            <FileText size={13} className="text-indigo-200"/>
          </button>
          <button onClick={()=>setWide(v=>!v)} title={wide?'Narrow':'Wide'}
            className="p-2 rounded-lg hover:bg-white/15 transition-colors">
            <MessageSquare size={13} className="text-indigo-200"/>
          </button>
          <button onClick={clearHistory} title="Clear"
            className="p-2 rounded-lg hover:bg-white/15 transition-colors">
            <Trash2 size={13} className="text-indigo-200"/>
          </button>
          <button onClick={()=>{ setOpen(false); navigate('/chatbot',{state:{messages,suggestions}}); }} title="Full page"
            className="p-2 rounded-lg hover:bg-white/15 transition-colors">
            <ExternalLink size={13} className="text-indigo-200"/>
          </button>
          <button onClick={()=>setOpen(false)} title="Close"
            className="p-2 rounded-lg hover:bg-white/15 transition-colors ml-0.5">
            <X size={13} className="text-indigo-200"/>
          </button>
        </div>
      </div>

      {/* ── Context selector (collapsible) ───────────── */}
      {showCtx && connections.length > 0 && (
        <div className="flex-shrink-0 px-3 py-2 bg-indigo-950/90 border-b border-indigo-900">
          <div className="flex items-center gap-2">
            <Database size={11} className="text-indigo-400 flex-shrink-0"/>
            <select
              value={ctxConnId}
              onChange={e=>setCtxConnId(e.target.value)}
              className="flex-1 text-[11px] text-indigo-200 bg-transparent outline-none cursor-pointer"
            >
              <option value="">Auto-detect from current page</option>
              {connections.map(c=>(
                <option key={c.id} value={c.id} style={{background:'#1e1b4b'}}>
                  [{(c.db_type||'').toUpperCase()}] {c.connection_name||c.host} #{c.id}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {/* ── Messages ─────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto px-3 pt-3" style={{ paddingBottom:'8px' }}>

        {/* Empty state */}
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full pb-4 gap-4">
            <div className="w-14 h-14 rounded-2xl flex items-center justify-center shadow-lg"
              style={{ background:'linear-gradient(135deg,#4f46e5,#7c3aed)' }}>
              <Brain size={28} className="text-white"/>
            </div>
            <div className="text-center">
              <p className="font-black text-slate-800 text-[15px]">ActMon AI</p>
              <p className="text-[12px] text-slate-500 mt-0.5 leading-relaxed">
                Ask anything · type a connection name to navigate<br/>
                or request a performance report
              </p>
            </div>
            <div className="grid grid-cols-2 gap-2 w-full px-1">
              {QUICK_PROMPTS.map(({ emoji, label, msg }) => (
                <button key={label} onClick={()=>send(msg)}
                  className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-white border border-slate-200 text-[11px] font-semibold text-slate-700 hover:border-indigo-300 hover:bg-indigo-50 transition-all text-left shadow-sm">
                  <span className="text-base leading-none">{emoji}</span>
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Message list */}
        {messages.map(msg => {
          if (msg.role === 'user') return <UserBubble key={msg.id} msg={msg}/>;
          if (msg.navResult && !msg.streaming) return (
            <AssistantBubble key={msg.id} msg={msg} onReport={handleReport} navigate={navigate} onClose={()=>setOpen(false)}/>
          );
          return (
            <AssistantBubble key={msg.id} msg={msg} onReport={handleReport} navigate={navigate} onClose={()=>setOpen(false)}/>
          );
        })}

        {/* Suggestion chips — inside scroll area, after messages */}
        {suggestions.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-3 ml-9">
            {suggestions.map((s,i)=>(
              <button key={i} onClick={()=>send(s)}
                className="text-[11px] px-2.5 py-1 rounded-full border border-indigo-200 text-indigo-700 bg-white hover:bg-indigo-50 font-medium transition-colors shadow-sm max-w-[180px] truncate">
                {s}
              </button>
            ))}
          </div>
        )}

        <div ref={bottomRef}/>
      </div>

      {/* ── Input ────────────────────────────────────── */}
      <div className="flex-shrink-0 px-3 pb-3 pt-2 bg-white border-t border-slate-100">
        <div className="flex items-end gap-2 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2
          focus-within:border-indigo-400 focus-within:ring-2 focus-within:ring-indigo-100 transition-all">
          <textarea
            ref={inputRef}
            value={input}
            onChange={e=>setInput(e.target.value)}
            onKeyDown={e=>{ if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();} }}
            placeholder={connections.length > 0 ? `Ask anything or "open ${connections[0]?.connection_name || 'Local-Postgresql'}"…` : 'Ask anything about your databases…'}
            rows={1}
            disabled={streaming}
            className="flex-1 resize-none text-[13px] text-slate-700 bg-transparent outline-none disabled:opacity-60 leading-relaxed"
            style={{ maxHeight:90 }}
            onInput={e=>{ e.target.style.height='auto'; e.target.style.height=Math.min(e.target.scrollHeight,90)+'px'; }}
          />
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {streaming ? (
              <button onClick={()=>{ abortRef.current?.abort(); updateLast({streaming:false}); setStreaming(false); }}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-red-50 border border-red-200 text-xs font-bold text-red-600 hover:bg-red-100 transition-colors">
                <X size={11}/> Stop
              </button>
            ) : (
              <button onClick={()=>send()} disabled={!input.trim()}
                className="w-8 h-8 rounded-lg flex items-center justify-center transition-all disabled:opacity-30"
                style={{ background: input.trim() ? 'linear-gradient(135deg,#4f46e5,#7c3aed)' : '#e2e8f0' }}>
                <Send size={13} className={input.trim()?'text-white':'text-slate-400'}/>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
