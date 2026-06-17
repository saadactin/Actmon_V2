/**
 * ActMon AI — Full-page chatbot
 * Route: /chatbot
 * Features: navigation commands, PDF export with charts, SQL generation,
 *           conversation history, connection context, quick library.
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Brain, Send, X, Copy, Check, Download, Database, Trash2, Code2,
  FileText, Zap, ChevronRight, BarChart2, AlertTriangle, Shield,
  ArrowUpRight, Navigation, ExternalLink, MessageSquare, RefreshCw,
  Search, Settings,
} from 'lucide-react';
import { streamChat, fetchConnections, downloadReport, quickSQL } from '../../api/chatbot';

/* ══════════════════════════════════════════════════════
   NAVIGATION DETECTION (same as widget)
══════════════════════════════════════════════════════ */
const DB_KEYWORDS = {
  mysql:      ['mysql','mariadb','maria'],
  postgresql: ['postgresql','postgres','pg','psql'],
  mongodb:    ['mongodb','mongo'],
  mssql:      ['mssql','sql server','sqlserver'],
  oracle:     ['oracle','ora'],
  clickhouse: ['clickhouse'],
};
const PAGE_KEYWORDS = {
  'slow-queries':       ['slow quer','slow queries'],
  'error-logs':         ['error log','errors'],
  'index-analysis':     ['index','indexes'],
  'backup':             ['backup'],
};

function dbPath(conn) {
  const t = (conn.db_type||'').toLowerCase();
  const map = { mysql:'/mysql-dashboard/', postgresql:'/postgresql-dashboard/', oracle:'/oracle-dashboard/', mssql:'/mssql-dashboard/', mongodb:'/mongodb-dashboard/', clickhouse:'/clickhouse-dashboard/' };
  return (map[t]||'/mysql-dashboard/')+conn.id;
}

function detectNav(text, connections) {
  const lower = text.toLowerCase().trim();
  const navKw = ['open','go to','navigate','show','launch','switch to','view'];
  if (!navKw.some(k => lower.startsWith(k)||lower.includes(' '+k+' '))) return null;
  for (const conn of connections) {
    const name = (conn.connection_name||conn.host||'').toLowerCase();
    if (name && lower.includes(name)) {
      let sub = null;
      for (const [p,kws] of Object.entries(PAGE_KEYWORDS)) if (kws.some(k=>lower.includes(k))) { sub=p; break; }
      const base = dbPath(conn);
      return { conn, path: sub ? base+'/'+sub : base, subPage:sub };
    }
  }
  for (const [type,kws] of Object.entries(DB_KEYWORDS)) {
    if (kws.some(k=>lower.includes(k))) {
      const conn = connections.find(c=>(c.db_type||'').toLowerCase()===type||kws.some(k=>(c.db_type||'').toLowerCase().includes(k)));
      if (conn) {
        let sub = null;
        for (const [p,pkw] of Object.entries(PAGE_KEYWORDS)) if (pkw.some(k=>lower.includes(k))) { sub=p; break; }
        const base = dbPath(conn);
        return { conn, path: sub ? base+'/'+sub : base, subPage:sub };
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
  const aiMsgs = messages.filter(m=>m.role==='assistant'&&!m.streaming&&m.content);
  const userMsgs = messages.filter(m=>m.role==='user');

  const msgHtml = messages.filter(m=>!m.streaming&&m.content).map(m=>{
    const isUser = m.role === 'user';
    const content = m.content
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>')
      .replace(/`([^`]+)`/g,'<code style="background:#f1f5f9;padding:2px 6px;border-radius:4px;font-family:monospace;font-size:12px">$1</code>')
      .replace(/```[\w]*\n?([\s\S]*?)```/g,'<pre style="background:#0f172a;color:#e2e8f0;padding:14px 18px;border-radius:10px;font-size:12px;margin:10px 0;overflow:auto;line-height:1.6">$1</pre>')
      .replace(/^#{1,3}\s+(.+)$/gm,'<h3 style="font-weight:800;color:#1e293b;margin:14px 0 4px;font-size:15px">$1</h3>')
      .replace(/^[-•]\s+(.+)$/gm,'<div style="display:flex;gap:8px;margin:3px 0"><span style="color:#6366f1;font-weight:900">•</span><span>$1</span></div>')
      .replace(/\n/g,'<br>');
    return `<div style="margin-bottom:24px">
      <div style="font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:0.06em;color:#94a3b8;margin-bottom:6px;${isUser?'text-align:right':''}">${isUser?'You':'🧠 ActMon AI'}</div>
      <div style="display:${isUser?'inline-block':'block'};float:${isUser?'right':'none'};background:${isUser?'linear-gradient(135deg,#4f46e5,#7c3aed)':'#f8fafc'};color:${isUser?'#fff':'#1e293b'};border:${isUser?'none':'1px solid #e2e8f0'};padding:14px 18px;border-radius:14px;font-size:13px;line-height:1.65;max-width:85%;text-align:left;${isUser?'border-top-right-radius:4px':'border-top-left-radius:4px'}">${content}</div>
      <div style="clear:both"></div>
      ${m.timestamp?`<div style="font-size:10px;color:#cbd5e1;margin-top:4px;${isUser?'text-align:right':''}">${m.timestamp}</div>`:''}
    </div>`;
  }).join('');

  // Simple SVG bar chart for connection health
  const connChart = connections.length > 0 ? `
    <svg width="${Math.min(connections.length * 70, 560)}" height="160" viewBox="0 0 ${Math.min(connections.length * 70, 560)} 160">
      <text x="0" y="14" font-size="11" fill="#64748b" font-weight="700">Connections Overview</text>
      ${connections.slice(0,8).map((c,i)=>{
        const colors = {mysql:'#f97316',postgresql:'#6366f1',mongodb:'#10b981',mssql:'#0ea5e9',oracle:'#ef4444',clickhouse:'#eab308'};
        const color = colors[(c.db_type||'').toLowerCase()] || '#94a3b8';
        const x = i * 70;
        return `<rect x="${x+5}" y="40" width="50" height="80" fill="${color}" rx="6" opacity="0.85"/>
          <text x="${x+30}" y="36" text-anchor="middle" font-size="9" fill="#64748b" font-weight="700">${(c.db_type||'').toUpperCase()}</text>
          <text x="${x+30}" y="138" text-anchor="middle" font-size="9" fill="#475569">#${c.id}</text>`;
      }).join('')}
    </svg>` : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>ActMon AI Report — ${ts}</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:'Segoe UI',system-ui,sans-serif;color:#1e293b;background:#fff;font-size:14px}
  .page-break{page-break-before:always}
  .header{background:linear-gradient(135deg,#2e1065 0%,#4f46e5 60%,#7c3aed 100%);color:#fff;padding:40px 56px;position:relative;overflow:hidden}
  .header::before{content:'';position:absolute;bottom:-60px;right:-60px;width:240px;height:240px;border-radius:50%;background:rgba(255,255,255,0.04)}
  .header h1{font-size:28px;font-weight:900;letter-spacing:-0.5px;margin-bottom:6px}
  .header .sub{font-size:13px;opacity:0.7}
  .badges{display:flex;gap:10px;margin-top:16px;flex-wrap:wrap}
  .badge{background:rgba(255,255,255,0.15);border:1px solid rgba(255,255,255,0.25);padding:5px 12px;border-radius:20px;font-size:11px;font-weight:800;letter-spacing:0.03em}
  .stats{display:grid;grid-template-columns:repeat(4,1fr);border-bottom:2px solid #f1f5f9}
  .stat{padding:20px 28px;border-right:1px solid #f1f5f9;text-align:center}
  .stat:last-child{border-right:none}
  .stat .n{font-size:32px;font-weight:900;color:#4f46e5;line-height:1}
  .stat .l{font-size:11px;color:#94a3b8;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;margin-top:4px}
  .section{padding:32px 56px;border-bottom:1px solid #f8fafc}
  .section-hdr{display:flex;align-items:center;gap:10px;margin-bottom:20px}
  .section-hdr h2{font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:0.08em;color:#94a3b8}
  .section-hdr::after{content:'';flex:1;height:1px;background:#f1f5f9}
  .conn-table{width:100%;border-collapse:collapse;font-size:12px}
  .conn-table th{background:#f8fafc;padding:10px 14px;text-align:left;font-weight:700;color:#64748b;font-size:11px;text-transform:uppercase;letter-spacing:0.05em;border-bottom:2px solid #e2e8f0}
  .conn-table td{padding:11px 14px;border-bottom:1px solid #f8fafc;color:#334155}
  .conn-table tr:hover td{background:#fafafa}
  .pill{display:inline-block;padding:3px 9px;border-radius:20px;font-size:10px;font-weight:800}
  .mysql{background:#fff7ed;color:#c2410c}.postgresql{background:#eef2ff;color:#4338ca}.mongodb{background:#ecfdf5;color:#065f46}.mssql{background:#e0f2fe;color:#0369a1}.oracle{background:#fef2f2;color:#dc2626}.clickhouse{background:#fefce8;color:#a16207}
  .chat{padding:32px 56px}
  .footer{text-align:center;padding:28px;color:#94a3b8;font-size:11px;border-top:2px solid #f8fafc;background:#fafafa}
  @media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
</style>
</head>
<body>

<div class="header">
  <h1>🧠 ActMon AI Analysis Report</h1>
  <div class="sub">Database Performance Intelligence</div>
  <div class="badges">
    <div class="badge">📅 ${ts}</div>
    <div class="badge">${aiMsgs.length} AI Responses</div>
    <div class="badge">${userMsgs.length} Queries</div>
    <div class="badge">${connections.length} Connections</div>
  </div>
</div>

<div class="stats">
  <div class="stat"><div class="n">${userMsgs.length}</div><div class="l">Questions</div></div>
  <div class="stat"><div class="n">${aiMsgs.length}</div><div class="l">AI Responses</div></div>
  <div class="stat"><div class="n">${connections.length}</div><div class="l">Connections</div></div>
  <div class="stat"><div class="n">${messages.filter(m=>m.actions?.length>0).length}</div><div class="l">Reports</div></div>
</div>

${connections.length > 0 ? `
<div class="section">
  <div class="section-hdr"><h2>Database Connections</h2></div>
  ${connChart}
  <br/><br/>
  <table class="conn-table">
    <thead><tr><th>#</th><th>Connection Name</th><th>Type</th><th>Host</th><th>Port</th></tr></thead>
    <tbody>
      ${connections.map(c=>`<tr>
        <td><strong>${c.id}</strong></td>
        <td>${c.connection_name||c.host}</td>
        <td><span class="pill ${(c.db_type||'').toLowerCase()}">${(c.db_type||'').toUpperCase()}</span></td>
        <td style="font-family:monospace;font-size:11px;color:#64748b">${c.host}</td>
        <td style="font-family:monospace;font-size:11px;color:#94a3b8">${c.port||'default'}</td>
      </tr>`).join('')}
    </tbody>
  </table>
</div>` : ''}

<div class="section">
  <div class="section-hdr"><h2>Conversation Analysis</h2></div>
</div>
<div class="chat">${msgHtml}</div>

<div class="footer">
  ActMon AI · DBA Intelligence Platform · Generated ${ts} · Confidential
</div>
</body>
</html>`;

  const win = window.open('','_blank','width=1000,height=750');
  if (!win) { alert('Allow popups to generate PDF reports.'); return; }
  win.document.write(html);
  win.document.close();
  setTimeout(()=>{ try{win.print();}catch(e){} }, 700);
}

/* ══════════════════════════════════════════════════════
   TEXT / CODE RENDERERS
══════════════════════════════════════════════════════ */
function parseSegments(text) {
  const clean = (text||'')
    .replace(/^SUGGESTIONS:.*$/m,'')
    .replace(/\[ACTION:[^\]]+\]/g,'')
    .trim();
  const segs = [];
  const re = /```(\w+)?\n?([\s\S]*?)```/g;
  let last = 0, m;
  while ((m = re.exec(clean)) !== null) {
    if (m.index > last) segs.push({ type:'text', content:clean.slice(last,m.index) });
    segs.push({ type:'code', language:m[1]||'sql', content:m[2].trim() });
    last = m.index + m[0].length;
  }
  if (last < clean.length) segs.push({ type:'text', content:clean.slice(last) });
  return segs.filter(s=>s.content.trim());
}

function highlightSQL(raw) {
  const KW = /\b(SELECT|FROM|WHERE|JOIN|LEFT|RIGHT|INNER|OUTER|ON|GROUP\s+BY|ORDER\s+BY|HAVING|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|INDEX|VIEW|ALTER|DROP|IF|NOT|EXISTS|NULL|PRIMARY|KEY|FOREIGN|REFERENCES|DEFAULT|UNIQUE|AUTO_INCREMENT|BIGSERIAL|BIGINT|INTEGER|INT|VARCHAR|TEXT|BOOLEAN|TIMESTAMPTZ|TIMESTAMP|DATETIME|SERIAL|IDENTITY|ENGINE|AS|WITH|CASE|WHEN|THEN|ELSE|AND|OR|IN|IS|LIKE|BETWEEN|UNION|DISTINCT|LIMIT|OFFSET|ASC|DESC|COUNT|SUM|AVG|MAX|MIN|COALESCE|CAST|NOW|CURRENT_TIMESTAMP)\b/gi;
  return raw
    .replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(KW,'<span style="color:#93c5fd;font-weight:600">$&</span>')
    .replace(/--[^\n]*/g,'<span style="color:#64748b;font-style:italic">$&</span>')
    .replace(/('[^']*')/g,'<span style="color:#86efac">$1</span>');
}

function CopyBtn({ text }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      onClick={()=>{ navigator.clipboard.writeText(text); setOk(true); setTimeout(()=>setOk(false),2000); }}
      className="flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-bold transition-colors"
      style={ok?{background:'#d1fae5',color:'#065f46'}:{background:'#1e293b',color:'#94a3b8'}}
    >
      {ok?<Check size={12}/>:<Copy size={12}/>}
      {ok?'Copied!':'Copy'}
    </button>
  );
}

function CodeBlock({ language, content }) {
  return (
    <div className="rounded-xl overflow-hidden border border-slate-700 text-sm my-3">
      <div className="flex items-center justify-between px-4 py-2.5 bg-[#1e293b]">
        <div className="flex items-center gap-2.5">
          <div className="flex gap-1.5">
            <div className="w-3 h-3 rounded-full bg-[#ff5f57]"/>
            <div className="w-3 h-3 rounded-full bg-[#febc2e]"/>
            <div className="w-3 h-3 rounded-full bg-[#28c840]"/>
          </div>
          <span className="font-bold text-slate-400 text-xs uppercase tracking-widest">{language}</span>
        </div>
        <CopyBtn text={content}/>
      </div>
      <pre className="p-4 overflow-x-auto bg-[#0d1117] text-slate-200 leading-relaxed text-sm"
        dangerouslySetInnerHTML={{ __html: highlightSQL(content) }}/>
    </div>
  );
}

function TextBlock({ content }) {
  const html = (content||'')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/\*\*(.+?)\*\*/g,'<strong class="font-semibold text-slate-900">$1</strong>')
    .replace(/`([^`]+)`/g,'<code class="font-mono text-xs bg-indigo-50 border border-indigo-100 px-1.5 py-0.5 rounded text-indigo-700">$1</code>')
    .replace(/^#{1,3}\s+(.+)$/gm,'<div class="font-black text-slate-800 mt-3 mb-1 text-base">$1</div>')
    .replace(/^[-•]\s+(.+)$/gm,'<div class="flex gap-2 my-1 items-start"><span class="text-indigo-400 font-black mt-0.5 flex-shrink-0">•</span><span>$1</span></div>')
    .replace(/^\d+\.\s+(.+)$/gm,(m,p1)=>`<div class="flex gap-2 my-1 items-start"><span class="text-indigo-500 font-black flex-shrink-0 w-5 text-sm">·</span><span>${p1}</span></div>`)
    .split('\n')
    .map(l=>{ const t=l.trim(); if(!t)return '<div class="h-1.5"/>'; if(t.startsWith('<'))return t; return `<p>${t}</p>`; })
    .join('');
  return <div className="text-slate-700 leading-relaxed text-sm" dangerouslySetInnerHTML={{ __html:html }}/>;
}

function AssistantMessage({ msg, onReport, onNavigate }) {
  const segs = parseSegments(msg.content||'');
  const hasActions = msg.actions?.length > 0;
  const hasNav = msg.navResult;

  if (msg.streaming && !msg.content) {
    return (
      <div className="flex gap-3 mb-5">
        <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center flex-shrink-0 mt-0.5 shadow-sm">
          <Brain size={16} className="text-white"/>
        </div>
        <div className="bg-white border border-slate-100 rounded-2xl rounded-tl-md px-5 py-4 shadow-sm">
          <div className="flex gap-1.5 py-0.5">
            {[0,1,2].map(i=>(
              <div key={i} className="w-2 h-2 rounded-full bg-indigo-400 animate-bounce" style={{animationDelay:`${i*0.18}s`}}/>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-3 mb-5 group">
      <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center flex-shrink-0 mt-0.5 shadow-sm">
        <Brain size={16} className="text-white"/>
      </div>
      <div className="flex-1 min-w-0 max-w-3xl">
        <div className="bg-white border border-slate-100 rounded-2xl rounded-tl-md shadow-sm overflow-hidden">
          {/* Content */}
          <div className="px-5 pt-4 pb-3">
            {segs.map((seg,i)=>
              seg.type==='code'
                ? <CodeBlock key={i} language={seg.language} content={seg.content}/>
                : <TextBlock key={i} content={seg.content}/>
            )}
          </div>
          {/* Actions — clearly separated */}
          {(hasActions || hasNav) && (
            <div className="px-5 pb-4 pt-1 border-t border-slate-50 bg-slate-50/60 space-y-2">
              {hasNav && (
                <button
                  onClick={() => onNavigate(msg.navResult)}
                  className="flex items-center gap-2.5 px-4 py-2.5 rounded-xl text-sm font-bold bg-emerald-50 border border-emerald-200 text-emerald-700 hover:bg-emerald-100 transition-colors w-full"
                >
                  <ArrowUpRight size={15}/>
                  Open {msg.navResult.conn.connection_name || msg.navResult.conn.host} Dashboard
                  <span className="ml-auto text-emerald-400 text-xs font-normal">{msg.navResult.subPage || 'Dashboard'}</span>
                </button>
              )}
              {msg.actions?.map((a,i)=>{
                const labels = { slow_queries:'Slow Queries CSV', health:'Health Summary CSV', connections:'Connections CSV', indexes:'Index Report CSV' };
                return (
                  <button key={i} onClick={()=>onReport(a.subtype,a.conn_id)}
                    className="flex items-center gap-2.5 px-4 py-2.5 rounded-xl text-sm font-bold bg-indigo-50 border border-indigo-200 text-indigo-700 hover:bg-indigo-100 transition-colors w-full">
                    <Download size={14}/> Download {labels[a.subtype]||a.subtype+' CSV'}
                  </button>
                );
              })}
            </div>
          )}
        </div>
        {msg.timestamp && (
          <p className="text-[11px] text-slate-400 mt-1.5 pl-1">{msg.timestamp}</p>
        )}
      </div>
    </div>
  );
}

function UserMessage({ msg }) {
  return (
    <div className="flex gap-3 mb-5 justify-end">
      <div className="max-w-2xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white px-5 py-3.5 rounded-2xl rounded-tr-md shadow-sm">
        <p className="text-sm leading-relaxed whitespace-pre-wrap">{msg.content}</p>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════
   QUICK LIBRARY
══════════════════════════════════════════════════════ */
const QUICK_LIBRARY = [
  { category:'Analysis', icon:<BarChart2 size={14}/>, color:'indigo', items:[
    { label:'Database health summary', msg:'Give me a complete health summary of all my connected databases with key metrics and recommendations.' },
    { label:'Top slow queries', msg:'What are the top slow queries I should optimize? List the worst ones and explain why they are slow.' },
    { label:'Cache hit rate analysis', msg:'Analyze cache hit rates and tell me what my target should be and how to improve it.' },
    { label:'Index usage audit', msg:'How do I audit which indexes are unused and costing write performance?' },
  ]},
  { category:'SQL Generation', icon:<Code2 size={14}/>, color:'violet', items:[
    { label:'CREATE TABLE template', msg:'Show me an advanced CREATE TABLE template with proper types, constraints, indexes, and audit triggers.' },
    { label:'Pagination query', msg:'Write an efficient cursor-based pagination query for PostgreSQL.' },
    { label:'Full-text search setup', msg:'How do I set up full-text search in PostgreSQL? Show indexes and queries.' },
    { label:'Partitioned table', msg:'Write a time-partitioned CREATE TABLE for log data in PostgreSQL.' },
  ]},
  { category:'Troubleshooting', icon:<AlertTriangle size={14}/>, color:'amber', items:[
    { label:'High CPU diagnosis', msg:'My PostgreSQL is using 100% CPU. What are the most likely causes and how do I investigate and fix it?' },
    { label:'Lock wait diagnosis', msg:'How do I find and kill long-running lock waits in PostgreSQL and MySQL?' },
    { label:'Replication lag fix', msg:'My replication is lagging. What are common causes and how do I fix replication lag?' },
    { label:'Connection errors', msg:'My database shows connection refused. Walk me through diagnosing and fixing it step by step.' },
  ]},
  { category:'Reports & Exports', icon:<FileText size={14}/>, color:'emerald', items:[
    { label:'Performance baseline', msg:'What metrics should I capture for a monthly database performance baseline report?' },
    { label:'Capacity planning', msg:'Help me build a database capacity planning report. What metrics should it include and how do I project growth?' },
    { label:'Security audit', msg:'Give me a comprehensive security audit checklist for PostgreSQL databases.' },
    { label:'Monthly DBA report template', msg:'Create a monthly DBA status report template covering availability, performance, capacity, and incidents.' },
  ]},
];

const colCls = {
  indigo:'bg-indigo-50 border-indigo-100 text-indigo-600',
  violet:'bg-violet-50 border-violet-100 text-violet-600',
  amber :'bg-amber-50  border-amber-100  text-amber-600',
  emerald:'bg-emerald-50 border-emerald-100 text-emerald-600',
};

/* ══════════════════════════════════════════════════════
   MAIN PAGE
══════════════════════════════════════════════════════ */
export default function ChatbotPage() {
  const location  = useLocation();
  const navigate  = useNavigate();
  const [messages, setMessages]       = useState(location.state?.messages || []);
  const [input, setInput]             = useState('');
  const [streaming, setStreaming]     = useState(false);
  const [suggestions, setSuggestions] = useState(location.state?.suggestions || []);
  const [connections, setConnections] = useState([]);
  const [ctxConnId, setCtxConnId]     = useState('');
  const [dbType, setDbType]           = useState('postgresql');
  const [activeLib, setActiveLib]     = useState(null);
  const [search, setSearch]           = useState('');
  const bottomRef = useRef(null);
  const inputRef  = useRef(null);
  const abortRef  = useRef(null);

  useEffect(() => {
    fetchConnections().then(list => {
      setConnections(list);
      if (list.length > 0 && !ctxConnId) setCtxConnId(String(list[0].id));
    }).catch(()=>{});
  }, []);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior:'smooth' }); }, [messages]);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const addMsg = (msg) => setMessages(prev=>[...prev,{id:Date.now()+Math.random(),...msg}]);
  const updateLast = (patch) => setMessages(prev=>{
    const next=[...prev]; const i=next.length-1;
    if(i>=0&&next[i].role==='assistant') next[i]={...next[i],...patch};
    return next;
  });

  const handleNavigate = (navResult) => {
    navigate(navResult.path);
  };

  const send = useCallback(async (text = input.trim()) => {
    if (!text || streaming) return;
    setInput('');
    setSuggestions([]);

    // Navigation detection
    const navResult = detectNav(text, connections);
    if (navResult) {
      addMsg({ role:'user', content:text });
      addMsg({ role:'assistant', content:`Navigating to **${navResult.conn.connection_name||navResult.conn.host}** ${navResult.subPage||'dashboard'}.`, streaming:false, navResult, timestamp:new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}) });
      setTimeout(()=>navigate(navResult.path), 600);
      return;
    }

    addMsg({ role:'user', content:text });
    addMsg({ role:'assistant', content:'', streaming:true });
    setStreaming(true);

    const ctx = ctxConnId ? { connection_id:parseInt(ctxConnId), db_type:dbType } : { db_type:dbType };
    const history = messages.filter(m=>!m.streaming&&m.role!=='system').slice(-20).map(m=>({role:m.role,content:m.content}));
    let accum = '';

    abortRef.current = streamChat({
      message:text, history, context:ctx,
      onToken: t => { accum+=t; updateLast({content:accum}); },
      onDone: meta => {
        const ts = new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
        updateLast({content:accum,streaming:false,actions:meta.actions||[],timestamp:ts});
        setSuggestions(meta.suggestions||[]);
        setStreaming(false);
      },
      onError: err => { updateLast({content:`Error: ${err}`,streaming:false}); setStreaming(false); },
    });
  }, [input, streaming, messages, ctxConnId, dbType, connections, navigate]);

  const handleReport = (type, connId) => {
    const cid = connId&&connId!=='unknown' ? connId : ctxConnId||undefined;
    downloadReport(type, cid);
  };

  const handleQuickSQL = async (queryType) => {
    const name = prompt('Table name (or leave blank):') || '';
    const result = await quickSQL(queryType, dbType, name ? {table_name:name} : {});
    if (result.sql) {
      addMsg({ role:'user', content:`Generate a ${queryType.replace('_',' ')} for ${dbType.toUpperCase()}${name?` — table: ${name}`:''}` });
      const ts = new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
      addMsg({ role:'assistant', content:`Here's a ${dbType.toUpperCase()} template:\n\n\`\`\`sql\n${result.sql}\n\`\`\``, streaming:false, actions:[], timestamp:ts });
      setSuggestions(['How do I add indexes?','Explain each column type','Show me an INSERT example']);
    }
  };

  // Filter library items by search
  const filteredLib = QUICK_LIBRARY.map(cat=>({
    ...cat,
    items: cat.items.filter(i => !search || i.label.toLowerCase().includes(search.toLowerCase())),
  })).filter(cat => !search || cat.items.length > 0);

  return (
    <div className="flex h-[calc(100vh-96px)] gap-0 bg-slate-50 rounded-2xl overflow-hidden border border-slate-200 shadow-sm">

      {/* ══ LEFT SIDEBAR ══════════════════════════════ */}
      <div className="w-72 flex-shrink-0 border-r border-slate-200 bg-white flex flex-col overflow-hidden">

        {/* Sidebar header */}
        <div className="flex-shrink-0 px-4 pt-4 pb-3 border-b border-slate-100">
          <div className="flex items-center gap-2.5 mb-4">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center shadow-md"
              style={{background:'linear-gradient(135deg,#4f46e5,#7c3aed)'}}>
              <Brain size={17} className="text-white"/>
            </div>
            <div>
              <p className="font-black text-slate-800 text-sm leading-none">ActMon AI</p>
              <p className="text-[10px] text-slate-400 mt-0.5 font-medium">DBA Intelligence</p>
            </div>
          </div>

          {/* DB type */}
          <div className="space-y-2">
            <div className="relative">
              <Database size={12} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"/>
              <select value={dbType} onChange={e=>setDbType(e.target.value)}
                className="w-full text-xs border border-slate-200 rounded-xl pl-8 pr-3 py-2 text-slate-600 bg-slate-50 outline-none focus:border-indigo-400 appearance-none">
                {['postgresql','mysql','mongodb','mssql','oracle','clickhouse'].map(t=>(
                  <option key={t} value={t}>{t.toUpperCase()}</option>
                ))}
              </select>
            </div>
            <select value={ctxConnId} onChange={e=>setCtxConnId(e.target.value)}
              className="w-full text-xs border border-slate-200 rounded-xl px-3 py-2 text-slate-600 bg-slate-50 outline-none focus:border-indigo-400">
              <option value="">No specific connection</option>
              {connections.map(c=>(
                <option key={c.id} value={c.id}>#{c.id} — {c.connection_name||c.host}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Quick SQL */}
        <div className="flex-shrink-0 px-4 py-3 border-b border-slate-100">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Quick SQL</p>
          <button onClick={()=>handleQuickSQL('create_table')}
            className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl bg-violet-50 border border-violet-200 text-xs font-bold text-violet-700 hover:bg-violet-100 transition-colors">
            <Code2 size={12}/> Generate CREATE TABLE
          </button>
        </div>

        {/* Search library */}
        <div className="flex-shrink-0 px-4 py-2.5 border-b border-slate-100">
          <div className="relative">
            <Search size={11} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"/>
            <input value={search} onChange={e=>setSearch(e.target.value)}
              placeholder="Search prompts…"
              className="w-full text-xs border border-slate-200 rounded-xl pl-8 pr-3 py-2 outline-none focus:border-indigo-400 bg-slate-50"/>
          </div>
        </div>

        {/* Library */}
        <div className="flex-1 overflow-y-auto">
          {filteredLib.map(cat=>(
            <div key={cat.category}>
              <button onClick={()=>setActiveLib(activeLib===cat.category?null:cat.category)}
                className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-slate-50 transition-colors border-b border-slate-50">
                <div className="flex items-center gap-2">
                  <div className={`w-6 h-6 rounded-lg border flex items-center justify-center ${colCls[cat.color]}`}>
                    {cat.icon}
                  </div>
                  <span className="text-xs font-bold text-slate-700">{cat.category}</span>
                </div>
                <ChevronRight size={12} className={`text-slate-400 transition-transform ${activeLib===cat.category?'rotate-90':''}`}/>
              </button>
              {activeLib === cat.category && (
                <div className="bg-slate-50/70 border-b border-slate-100">
                  {cat.items.map(item=>(
                    <button key={item.label} onClick={()=>send(item.msg)}
                      className="w-full text-left px-5 py-2.5 text-[12px] text-slate-600 hover:bg-white hover:text-slate-900 hover:pl-6 transition-all border-b border-slate-50 last:border-0">
                      {item.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Navigation shortcuts */}
        {connections.length > 0 && (
          <div className="flex-shrink-0 px-4 py-3 border-t border-slate-100">
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Quick Navigate</p>
            <div className="space-y-1">
              {connections.slice(0,4).map(c=>(
                <button key={c.id} onClick={()=>navigate(dbPath(c))}
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-xl hover:bg-slate-100 text-xs font-semibold text-slate-600 transition-colors text-left">
                  <ArrowUpRight size={11} className="text-slate-400 flex-shrink-0"/>
                  <span className="truncate">{c.connection_name||c.host}</span>
                  <span className="ml-auto text-[10px] text-slate-400 font-normal">{(c.db_type||'').toUpperCase()}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Reports */}
        <div className="flex-shrink-0 px-4 py-3 border-t border-slate-100">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Export Reports</p>
          <div className="space-y-1.5">
            <button onClick={()=>generatePDFReport(messages, connections)}
              disabled={messages.length===0}
              className="w-full flex items-center gap-2 px-3 py-2 rounded-xl bg-indigo-50 border border-indigo-200 text-xs font-bold text-indigo-700 hover:bg-indigo-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
              <FileText size={11}/> Export as PDF
            </button>
            {[
              {label:'All Connections CSV', type:'connections', conn:null},
              {label:'Health Summary CSV', type:'health', conn:null},
              {label:'Slow Queries CSV', type:'slow-queries', conn:ctxConnId},
            ].map(({label,type,conn})=>(
              <button key={type} onClick={()=>downloadReport(type,conn||undefined)}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-xl bg-emerald-50 border border-emerald-200 text-xs font-semibold text-emerald-700 hover:bg-emerald-100 transition-colors">
                <Download size={11}/> {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ══ MAIN CHAT AREA ════════════════════════════ */}
      <div className="flex-1 flex flex-col min-w-0 bg-[#f8fafc]">

        {/* Chat topbar */}
        <div className="flex-shrink-0 flex items-center justify-between px-6 py-3.5 bg-white border-b border-slate-100">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center shadow-sm"
              style={{background:'linear-gradient(135deg,#4f46e5,#7c3aed)'}}>
              <Brain size={16} className="text-white"/>
            </div>
            <div>
              <h1 className="font-black text-slate-800 text-base leading-none">ActMon AI Chat</h1>
              <p className="text-xs text-slate-400 mt-0.5">
                {messages.filter(m=>m.role==='user').length} queries
                {ctxConnId&&connections.length>0 && ` · Connection #${ctxConnId}`}
                {streaming && ' · Thinking…'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={()=>generatePDFReport(messages,connections)} disabled={messages.length===0}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold text-indigo-600 bg-indigo-50 border border-indigo-200 hover:bg-indigo-100 transition-colors disabled:opacity-40">
              <FileText size={12}/> PDF
            </button>
            <button onClick={()=>{setMessages([]);setSuggestions([]);}}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold text-slate-500 border border-slate-200 hover:text-red-600 hover:bg-red-50 hover:border-red-200 transition-colors">
              <Trash2 size={12}/> Clear
            </button>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-6 py-6">

          {/* Empty state */}
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full gap-6 max-w-lg mx-auto text-center">
              <div className="w-20 h-20 rounded-3xl flex items-center justify-center shadow-lg shadow-indigo-200"
                style={{background:'linear-gradient(135deg,#4f46e5,#7c3aed)'}}>
                <Brain size={40} className="text-white"/>
              </div>
              <div>
                <h2 className="font-black text-2xl text-slate-800 mb-2">Hello! I'm ActMon AI</h2>
                <p className="text-slate-500 text-sm leading-relaxed">
                  Your expert DBA assistant. I can analyze databases, write SQL,<br/>
                  diagnose errors, and navigate to any dashboard instantly.
                </p>
                {connections.length > 0 && (
                  <p className="text-indigo-600 text-xs mt-3 font-semibold">
                    💡 Try: "open {connections[0].connection_name || 'Local-Postgresql'} dashboard"
                  </p>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3 w-full">
                {[
                  { icon:<Zap size={16}/>, t:'Health Check', m:'Give me a health summary of all my connected databases.' },
                  { icon:<Code2 size={16}/>, t:'Write SQL', m:'Write a CREATE TABLE for a users table with proper indexing.' },
                  { icon:<AlertTriangle size={16}/>, t:'High CPU Fix', m:'My PostgreSQL is using 100% CPU. Diagnose and fix it step by step.' },
                  { icon:<BarChart2 size={16}/>, t:'Performance Report', m:'Create a full database performance analysis report with recommendations.' },
                ].map(({icon,t,m})=>(
                  <button key={t} onClick={()=>send(m)}
                    className="flex items-center gap-3 p-4 bg-white border border-slate-200 rounded-2xl text-left hover:border-indigo-300 hover:shadow-md transition-all shadow-sm">
                    <span className="text-indigo-500 flex-shrink-0">{icon}</span>
                    <span className="text-sm font-semibold text-slate-700">{t}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Message list */}
          {messages.map(msg=>
            msg.role==='user'
              ? <UserMessage key={msg.id} msg={msg}/>
              : <AssistantMessage key={msg.id} msg={msg} onReport={handleReport} onNavigate={handleNavigate}/>
          )}

          {/* Suggestion chips */}
          {suggestions.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-4 ml-12">
              {suggestions.map((s,i)=>(
                <button key={i} onClick={()=>send(s)}
                  className="text-xs px-3.5 py-1.5 rounded-full border border-indigo-200 text-indigo-700 bg-white hover:bg-indigo-50 font-medium transition-colors shadow-sm">
                  {s}
                </button>
              ))}
            </div>
          )}

          <div ref={bottomRef}/>
        </div>

        {/* Input */}
        <div className="flex-shrink-0 px-6 pb-6 pt-3 bg-white border-t border-slate-100">
          <div className="flex items-end gap-3 bg-slate-50 border border-slate-200 rounded-2xl px-4 py-3
            focus-within:border-indigo-400 focus-within:ring-2 focus-within:ring-indigo-100 transition-all">
            <textarea
              ref={inputRef}
              value={input}
              onChange={e=>setInput(e.target.value)}
              onKeyDown={e=>{ if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();} }}
              placeholder={connections.length > 0
                ? `Ask anything or try "open ${connections[0]?.connection_name||'Local-Postgresql'} dashboard"…`
                : 'Ask anything — write SQL, diagnose errors, request reports…'}
              rows={1}
              disabled={streaming}
              className="flex-1 resize-none text-sm text-slate-700 bg-transparent outline-none disabled:opacity-60 leading-relaxed"
              style={{maxHeight:120}}
              onInput={e=>{ e.target.style.height='auto'; e.target.style.height=Math.min(e.target.scrollHeight,120)+'px'; }}
            />
            <div className="flex items-center gap-2 flex-shrink-0">
              {streaming ? (
                <button onClick={()=>{ abortRef.current?.abort(); updateLast({streaming:false}); setStreaming(false); }}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-red-50 border border-red-200 text-xs font-bold text-red-600 hover:bg-red-100 transition-colors">
                  <X size={13}/> Stop
                </button>
              ) : (
                <button onClick={()=>send()} disabled={!input.trim()}
                  className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-bold text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed shadow-sm"
                  style={{background:'linear-gradient(135deg,#4f46e5,#7c3aed)'}}>
                  <Send size={14}/> Send
                </button>
              )}
            </div>
          </div>
          <p className="text-[11px] text-slate-400 mt-2 text-center">
            ActMon AI · Press Enter to send, Shift+Enter for new line · Type a connection name to navigate instantly
          </p>
        </div>
      </div>
    </div>
  );
}
