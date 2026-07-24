import React, { useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, HardDrive, Folder, FileText, ChevronRight, Link2, Lock,
  KeyRound, Eye, EyeOff, Loader2, AlertTriangle, Server, Search, Pencil, Save, X, Check,
  RefreshCw, Download, Power,
} from 'lucide-react';
import { getHostInfraDetail, fsList, fsRead, fsWrite, updateOsServer, updateAgent } from '../../api/servers';
import { PasswordPrompt, RestartModal } from './InfraHostDetail';

// Same tab set as the host detail page — clicking one here navigates back to
// /infra/:id and asks it to open that tab (see InfraHostDetail's location.state.tab).
const TABS = ['Overview', 'Ports', 'Processes', 'Storage', 'Network', 'Services', 'Diagnostics', 'IP Configuration', 'Config Files'];

const fmtBytes = (b) => {
  if (b == null) return '—';
  if (b >= 1 << 30) return `${(b / (1 << 30)).toFixed(1)} GB`;
  if (b >= 1 << 20) return `${(b / (1 << 20)).toFixed(1)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${b} B`;
};

// Full-page file explorer for an infrastructure host.
// Flow: Storage tab → Browse → THIS PAGE (folders) → click folder → drill →
// click file → content view. Path lives in the URL (?path=) so back/forward work.
export function InfraFileExplorer() {
  const { id } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const path = params.get('path') || '/';
  const file = params.get('file') || null;

  const [ssh, setSsh] = useState({ user: '', pass: '', port: 22 });
  const [showPass, setShowPass] = useState(false);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');
  const [showRestart, setShowRestart] = useState(false);
  const [showUpdate, setShowUpdate] = useState(false);
  // File editor state
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [savingFile, setSavingFile] = useState(false);
  const [saveMsg, setSaveMsg] = useState(null);

  // Same query/shape as the host detail page, so the header (name, status, OS) matches exactly.
  const { data: hostData, isFetching: hostFetching } = useQuery({
    queryKey: ['hostInfraDetail', id], queryFn: () => getHostInfraDetail(id), retry: false, refetchInterval: 30000,
  });
  const hostRow = hostData?.host || {};
  const hostFailed = hostData?.status === 'error';
  const isWin = (hostRow.os_type || '').toLowerCase().startsWith('win');

  const { data: dir, isFetching, error } = useQuery({
    queryKey: ['fsList', id, path],
    queryFn: () => fsList(id, path),
    enabled: !file,
    retry: false,
  });
  const { data: doc, isFetching: reading, error: readErr } = useQuery({
    queryKey: ['fsRead', id, file],
    queryFn: () => fsRead(id, file),
    enabled: !!file,
    retry: false,
  });

  const goPath = (p) => { setSearch(''); setEditing(false); setSaveMsg(null); setParams({ path: p }); };
  const goFile = (f) => { setEditing(false); setSaveMsg(null); setParams({ path, file: f }); };

  const startEdit = () => { setDraft(doc?.content ?? ''); setEditing(true); setSaveMsg(null); };
  const saveFile = async () => {
    setSavingFile(true); setSaveMsg(null);
    try {
      await fsWrite(id, file, draft);
      setEditing(false);
      setSaveMsg({ ok: true, text: 'Saved. A .actmon.bak backup was kept on the host.' });
      qc.invalidateQueries({ queryKey: ['fsRead', id, file] });
    } catch (e) {
      setSaveMsg({ ok: false, text: e?.response?.data?.detail || e?.message || 'Save failed.' });
    } finally { setSavingFile(false); }
  };
  // Back = up one folder; from the root it returns to the host's Storage tab.
  const goBack = () => {
    if (file) setParams({ path });
    else if (path !== '/') goPath(dir?.parent || '/');
    else navigate(`/infra/${id}`);
  };
  const visibleEntries = (dir?.entries || []).filter(
    (e) => !search.trim() || e.name.toLowerCase().includes(search.trim().toLowerCase()));

  const needsSsh = dir?.needs_ssh || doc?.needs_ssh;
  const errMsg = error?.response?.data?.detail || error?.message
    || readErr?.response?.data?.detail || readErr?.message;

  const saveSsh = async () => {
    setSaving(true);
    try {
      await updateOsServer(id, { ssh_username: ssh.user, ssh_password: ssh.pass, ssh_port: Number(ssh.port) || 22 });
      qc.invalidateQueries({ queryKey: ['fsList', id] });
    } finally { setSaving(false); }
  };

  const active = file || path;
  const crumbs = active === '/' ? [] : active.replace(/^\/+/, '').split('/');
  const crumbPath = (i) => '/' + crumbs.slice(0, i + 1).join('/');

  const goTab = (t) => navigate(`/infra/${id}`, { state: { tab: t } });

  return (
    <div className="-mx-6 md:-mx-8 min-h-full bg-slate-50 flex flex-col">
      {/* ─── TOP HEADER (identical to the host detail page) ─── */}
      <div className="bg-gradient-to-r from-slate-900 via-cyan-900 to-teal-800 text-white shadow-xl">
        <div className="px-6 py-4 flex flex-wrap justify-between items-center gap-3">
          <div className="flex items-center gap-4">
            <button onClick={() => navigate(`/infra/${id}`)} className="w-9 h-9 rounded-xl bg-white/10 hover:bg-white/20 border border-white/15 flex items-center justify-center text-white flex-shrink-0">
              <ArrowLeft size={17} />
            </button>
            <div className="w-12 h-12 bg-cyan-400/20 border border-cyan-400/40 rounded-2xl flex items-center justify-center text-2xl">
              {isWin ? '🪟' : '🐧'}
            </div>
            <div>
              <h1 className="text-2xl font-black tracking-tight">
                {hostRow.server_name || `Host #${id}`}
                <span className="ml-2 align-middle px-2 py-0.5 rounded-full bg-amber-400/20 border border-amber-300/40 text-amber-200 text-[11px] font-bold">File Explorer</span>
              </h1>
              <p className="text-cyan-300 text-sm mt-0.5 font-mono">
                {hostRow.hostname || hostRow.ip_address || ''}{hostRow.os_type ? ` · ${hostRow.os_type}` : ''}
                {hostRow.collector ? ` · via ${hostRow.collector}` : ''}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <span className={`px-3 py-1.5 rounded-lg text-xs font-black border ${
              hostFailed ? 'bg-red-500/20 border-red-400/40 text-red-200' : 'bg-emerald-500/20 border-emerald-400/40 text-emerald-200'}`}>
              {hostFailed ? '● Offline' : '● Online'}
            </span>
            <button onClick={() => setParams({ path: '/' })}
              className="px-3 py-1.5 rounded-lg border border-white/20 hover:bg-white/10 text-xs font-semibold text-white/80 hover:text-white">
              File Explorer
            </button>
            <button onClick={() => goTab('IP Configuration')}
              className="px-3 py-1.5 rounded-lg border border-white/20 hover:bg-white/10 text-xs font-semibold text-white/80 hover:text-white">
              Firewall
            </button>
            {hostRow.collector === 'agent' && isWin && (
              <button onClick={() => setShowUpdate(true)} title="Download the latest agent and upgrade in place"
                className="px-3 py-1.5 rounded-lg border border-sky-300/40 bg-sky-500/15 hover:bg-sky-500/25 text-xs font-semibold text-sky-100 flex items-center gap-1.5">
                <Download size={13} /> Update Agent
              </button>
            )}
            <button onClick={() => setShowRestart(true)}
              className="px-3 py-1.5 rounded-lg border border-amber-300/40 bg-amber-500/15 hover:bg-amber-500/25 text-xs font-semibold text-amber-100 flex items-center gap-1.5">
              <Power size={13} /> Restart
            </button>
            <button onClick={() => { qc.invalidateQueries({ queryKey: ['hostInfraDetail', id] }); qc.invalidateQueries({ queryKey: ['fsList', id] }); qc.invalidateQueries({ queryKey: ['fsRead', id] }); }}
              className="flex items-center gap-2 px-4 py-1.5 bg-white/10 hover:bg-white/20 border border-white/20 rounded-lg text-sm font-semibold">
              <RefreshCw size={13} className={hostFetching || isFetching || reading ? 'animate-spin' : ''} /> Refresh
            </button>
          </div>
        </div>

        {/* ─── TAB BAR ─── */}
        <div className="px-4 pt-2 flex gap-0.5 overflow-x-auto border-t border-white/10">
          {TABS.map((t) => (
            <button key={t} onClick={() => goTab(t)}
              className={`flex items-center gap-2 px-4 py-2.5 text-xs font-semibold rounded-t-lg whitespace-nowrap transition-all ${
                t === 'Storage' ? 'bg-slate-50 text-cyan-700' : 'text-white/60 hover:text-white hover:bg-white/10'}`}>
              {t}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 p-5">
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          {/* Toolbar: back + breadcrumb path + search */}
          <div className="px-5 py-3 bg-slate-50 border-b border-slate-200 flex items-center gap-2 flex-wrap">
            <button onClick={goBack}
              className="h-9 px-3 rounded-lg border border-slate-300 bg-white text-slate-700 text-[13px] font-bold hover:bg-slate-100 flex items-center gap-1.5 flex-shrink-0">
              <ArrowLeft size={14} /> Back
            </button>
            <HardDrive size={16} className="text-cyan-600 flex-shrink-0 ml-1" />
            <button onClick={() => setParams({ path: '/' })} className="text-[15px] font-bold text-blue-600 hover:underline">/</button>
            {crumbs.map((c, i) => (
              <React.Fragment key={i}>
                <ChevronRight size={14} className="text-slate-300" />
                {i === crumbs.length - 1 ? (
                  <span className="text-[15px] font-black text-slate-800">{c}</span>
                ) : (
                  <button onClick={() => setParams({ path: crumbPath(i) })} className="text-[15px] font-bold text-blue-600 hover:underline">{c}</button>
                )}
              </React.Fragment>
            ))}
            {(isFetching || reading) && <Loader2 size={16} className="animate-spin text-blue-500 ml-2" />}
            {!file && (
              <div className="ml-auto flex items-center gap-3">
                <div className="relative">
                  <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search this folder…"
                    className="h-9 w-56 pl-8 pr-3 rounded-lg border border-slate-300 bg-white text-[13px] outline-none focus:border-blue-400" />
                </div>
                <span className="text-[13px] text-slate-400 font-semibold whitespace-nowrap">
                  {search.trim() ? `${visibleEntries.length} / ${dir?.count ?? 0}` : `${dir?.count ?? 0} items`}
                </span>
              </div>
            )}
          </div>

          {/* SSH needed (SSH-registered hosts without creds only — agent hosts browse via agent) */}
          {needsSsh && (
            <div className="p-6">
              <div className="flex items-start gap-3 rounded-xl bg-amber-50 border border-amber-200 p-5">
                <Lock size={18} className="text-amber-500 flex-shrink-0 mt-0.5" />
                <div className="flex-1">
                  <p className="text-[16px] font-black text-slate-800">SSH credentials needed for file browsing</p>
                  <p className="text-[14px] text-slate-600 mt-1">{(dir || doc)?.message}</p>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-4 max-w-xl">
                    <input value={ssh.user} onChange={(e) => setSsh((s) => ({ ...s, user: e.target.value }))} placeholder="SSH username"
                      className="h-10 px-3 rounded-lg border border-slate-300 text-[14px] outline-none focus:border-blue-400 bg-white" />
                    <div className="relative">
                      <input value={ssh.pass} type={showPass ? 'text' : 'password'} onChange={(e) => setSsh((s) => ({ ...s, pass: e.target.value }))} placeholder="SSH password"
                        className="w-full h-10 px-3 pr-9 rounded-lg border border-slate-300 text-[14px] outline-none focus:border-blue-400 bg-white" />
                      <button onClick={() => setShowPass((v) => !v)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400">{showPass ? <EyeOff size={14} /> : <Eye size={14} />}</button>
                    </div>
                    <input value={ssh.port} type="number" onChange={(e) => setSsh((s) => ({ ...s, port: e.target.value }))} placeholder="22"
                      className="h-10 px-3 rounded-lg border border-slate-300 text-[14px] outline-none focus:border-blue-400 bg-white" />
                  </div>
                  <button onClick={saveSsh} disabled={saving || !ssh.user || !ssh.pass}
                    className="mt-4 h-10 px-5 rounded-lg bg-blue-600 text-white text-[14px] font-bold hover:bg-blue-700 disabled:opacity-40 flex items-center gap-2">
                    {saving ? <Loader2 size={15} className="animate-spin" /> : <KeyRound size={15} />} Save & Browse
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Error */}
          {!needsSsh && errMsg && (
            <div className="p-6">
              <div className="flex items-center gap-2.5 rounded-xl bg-red-50 border border-red-200 p-4 text-[15px] text-red-700">
                <AlertTriangle size={17} className="flex-shrink-0" /> {errMsg}
                {file && <button onClick={() => setParams({ path })} className="ml-auto font-bold text-blue-600 hover:underline flex-shrink-0">← Back to folder</button>}
              </div>
            </div>
          )}

          {/* Directory listing */}
          {!needsSsh && !errMsg && !file && dir?.entries && (
            <table className="w-full text-[15px]">
              <thead className="bg-white shadow-[0_1px_0_#e2e8f0]"><tr>
                {['Name', 'Size', 'Modified', 'Owner', 'Permissions'].map((h) => (
                  <th key={h} className="px-5 py-3 text-left text-[12px] font-bold text-slate-400 uppercase">{h}</th>))}
              </tr></thead>
              <tbody>
                {path !== '/' && (
                  <tr className="border-b border-slate-100 hover:bg-blue-50/40 cursor-pointer" onClick={() => goPath(dir.parent)}>
                    <td className="px-5 py-3 flex items-center gap-3 font-bold text-slate-500"><Folder size={17} className="text-slate-300" /> ..</td>
                    <td colSpan={4} />
                  </tr>
                )}
                {visibleEntries.map((e) => {
                  const isDir = e.type === 'dir';
                  const isLink = e.type === 'link';
                  const open = () => {
                    const full = `${path === '/' ? '' : path}/${e.name}`;
                    if (isDir) goPath(full);
                    else if (isLink && e.link_target?.startsWith('/')) goPath(e.link_target);
                    else goFile(full);
                  };
                  return (
                    <tr key={e.name} onClick={open} className="border-b border-slate-100 hover:bg-blue-50/40 cursor-pointer">
                      <td className="px-5 py-3">
                        <span className="flex items-center gap-3 font-semibold text-slate-800">
                          {isDir ? <Folder size={17} className="text-amber-500 flex-shrink-0" />
                            : isLink ? <Link2 size={16} className="text-cyan-500 flex-shrink-0" />
                              : <FileText size={16} className="text-blue-400 flex-shrink-0" />}
                          <span className="truncate max-w-[420px]">{e.name}</span>
                          {isLink && e.link_target && <span className="text-[13px] text-slate-400 font-normal">→ {e.link_target}</span>}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-slate-500 whitespace-nowrap">{isDir ? '—' : fmtBytes(e.size)}</td>
                      <td className="px-5 py-3 text-slate-500 whitespace-nowrap">{e.modified}</td>
                      <td className="px-5 py-3 text-slate-500">{e.owner}</td>
                      <td className="px-5 py-3 font-mono text-[13px] text-slate-400">{e.perms}</td>
                    </tr>
                  );
                })}
                {visibleEntries.length === 0 && (
                  <tr><td colSpan={5} className="px-5 py-10 text-center text-[15px] text-slate-400">
                    {search.trim() ? `Nothing matches "${search}" in this folder.` : 'Empty folder'}
                  </td></tr>
                )}
              </tbody>
            </table>
          )}

          {/* File content viewer / editor */}
          {!needsSsh && !errMsg && file && doc && !doc.needs_ssh && (
            <div>
              <div className="px-5 py-3 bg-slate-50 border-b border-slate-100 flex items-center gap-3 text-[14px] text-slate-500 flex-wrap">
                <button onClick={() => setParams({ path })} className="font-bold text-blue-600 hover:underline flex items-center gap-1"><ArrowLeft size={14} /> Back to folder</button>
                <span className="font-mono">{fmtBytes(doc.size)}</span>
                {doc.truncated && <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 text-[12px] font-bold">showing first {fmtBytes(doc.read_bytes)}</span>}
                <div className="ml-auto flex items-center gap-2">
                  {!doc.binary && !editing && !doc.truncated && (
                    <button onClick={startEdit} className="h-8 px-3 rounded-lg bg-slate-800 text-white text-[13px] font-bold hover:bg-slate-700 flex items-center gap-1.5"><Pencil size={13} /> Edit</button>
                  )}
                  {!doc.binary && !editing && doc.truncated && (
                    <span className="text-[12px] text-slate-400">Too large to edit here</span>
                  )}
                  {editing && (
                    <>
                      <button onClick={() => { setEditing(false); setSaveMsg(null); }} className="h-8 px-3 rounded-lg border border-slate-300 text-slate-600 text-[13px] font-bold hover:bg-slate-100 flex items-center gap-1.5"><X size={13} /> Cancel</button>
                      <button onClick={saveFile} disabled={savingFile} className="h-8 px-3 rounded-lg bg-emerald-600 text-white text-[13px] font-bold hover:bg-emerald-700 disabled:opacity-50 flex items-center gap-1.5">
                        {savingFile ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />} Save
                      </button>
                    </>
                  )}
                </div>
              </div>
              {saveMsg && (
                <div className={`px-5 py-2.5 text-[13px] font-semibold flex items-center gap-2 ${saveMsg.ok ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}>
                  {saveMsg.ok ? <Check size={14} /> : <AlertTriangle size={14} />}{saveMsg.text}
                </div>
              )}
              {doc.binary ? (
                <p className="p-8 text-[15px] text-slate-400">Binary file — preview not available.</p>
              ) : editing ? (
                <textarea value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false}
                  className="w-full p-5 text-[14px] leading-relaxed font-mono text-slate-800 bg-white outline-none resize-none"
                  style={{ height: '65vh' }} />
              ) : (
                <pre className="p-5 text-[14px] leading-relaxed font-mono text-slate-800 whitespace-pre-wrap break-all max-h-[65vh] overflow-y-auto bg-white">{doc.content || '(empty file)'}</pre>
              )}
            </div>
          )}
        </div>
      </div>

      {showUpdate && (
        <PasswordPrompt title="Update ActMon Agent" confirmLabel="Update Agent"
          onConfirm={(pw) => updateAgent(id, pw)} onClose={() => setShowUpdate(false)} />
      )}
      {showRestart && (
        <RestartModal id={id} hostName={hostRow.server_name || `Host #${id}`} onClose={() => setShowRestart(false)} />
      )}
    </div>
  );
}

export default InfraFileExplorer;
