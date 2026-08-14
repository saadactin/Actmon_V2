import React, { useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getHostInfraDetail, fsList, fsRead, fsWrite, updateOsServer, updateAgent } from '@/api/servers';
import { PasswordPrompt, RestartModal } from '@/pages/infra/InfraHostDetail';
import { hostStatus } from '@/pages/infra/InfraHostCard';
import cn from '@/lib/cn';
import Icon from '@/components/ui/Icon';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import PageHeader from '@/components/layout/PageHeader';
import Tabs from '@/components/ui/Tabs';
import Table, { EmptyState } from '@/components/ui/Table';
import { usePermissions } from '@/hooks/usePermissions';

// Same tab set as the host detail page — clicking one here navigates back to
// /infra/:id/:tab (tabs are real routes there, see InfraHostDetail's SLUG_FOR_TAB).
const TABS = ['Overview', 'Ports', 'Processes', 'Storage', 'Network', 'Services', 'Diagnostics', 'IP Configuration', 'Config Files'];
const TAB_ICONS = {
  Overview: 'activity', Ports: 'plug', Processes: 'box', Storage: 'desktop', Network: 'network',
  Services: 'settings2', Diagnostics: 'diagnose', 'IP Configuration': 'route', 'Config Files': 'file-edit',
};
const SLUG_FOR_TAB = {
  Overview: 'overview', Ports: 'ports', Processes: 'processes', Storage: 'storage', Network: 'network',
  Services: 'services', Diagnostics: 'diagnostics', 'IP Configuration': 'ip-configuration', 'Config Files': 'config-files',
};

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
  const { canHere } = usePermissions();
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
  const status = hostStatus({ status: hostFailed ? 'offline' : 'online' });

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

  const goTab = (t) => navigate(`/infra/${id}${t !== 'Overview' ? `/${SLUG_FOR_TAB[t]}` : ''}`);
  const refreshAll = () => {
    qc.invalidateQueries({ queryKey: ['hostInfraDetail', id] });
    qc.invalidateQueries({ queryKey: ['fsList', id] });
    qc.invalidateQueries({ queryKey: ['fsRead', id] });
  };

  const tabDefs = TABS.map((t) => ({ id: t, label: t, icon: TAB_ICONS[t] }));

  // Directory listing rows for the shared Table component.
  const dirRows = [];
  if (!needsSsh && !errMsg && !file && dir?.entries && path !== '/') {
    dirRows.push({
      key: '__up',
      onClick: () => goPath(dir.parent),
      cells: {
        name: <span className="flex items-center gap-3 font-bold text-muted"><Icon name="folder" size={17} className="text-subtle" /> ..</span>,
        size: '', modified: '', owner: '', perms: '',
      },
    });
  }
  visibleEntries.forEach((e) => {
    const isDir = e.type === 'dir';
    const isLink = e.type === 'link';
    const icon = isDir ? 'folder' : isLink ? 'link' : 'report';
    const iconColor = isDir ? 'text-warning-fg' : isLink ? 'text-info-fg' : 'text-accent-text';
    const open = () => {
      const full = `${path === '/' ? '' : path}/${e.name}`;
      if (isDir) goPath(full);
      else if (isLink && e.link_target?.startsWith('/')) goPath(e.link_target);
      else goFile(full);
    };
    dirRows.push({
      key: e.name,
      onClick: open,
      cells: {
        name: (
          <span className="flex items-center gap-3 font-semibold text-fg">
            <Icon name={icon} size={17} className={cn('shrink-0', iconColor)} />
            <span className="truncate-safe max-w-[420px]">{e.name}</span>
            {isLink && e.link_target && <span className="text-[13px] font-normal text-subtle">→ {e.link_target}</span>}
          </span>
        ),
        size: <span className="whitespace-nowrap text-muted">{isDir ? '—' : fmtBytes(e.size)}</span>,
        modified: <span className="whitespace-nowrap text-muted">{e.modified}</span>,
        owner: <span className="text-muted">{e.owner}</span>,
        perms: <span className="font-mono text-[13px] text-subtle">{e.perms}</span>,
      },
    });
  });
  if (dir?.entries && visibleEntries.length === 0) {
    dirRows.push({
      key: '__empty',
      cells: {
        name: <span className="text-subtle">{search.trim() ? `Nothing matches "${search}" in this folder.` : 'This folder is empty.'}</span>,
        size: '', modified: '', owner: '', perms: '',
      },
    });
  }
  const dirColumns = [
    { key: 'name', label: 'Name' },
    { key: 'size', label: 'Size', width: 100 },
    { key: 'modified', label: 'Modified', width: 170 },
    { key: 'owner', label: 'Owner', width: 130 },
    { key: 'perms', label: 'Permissions', width: 130 },
  ];

  return (
    <div className="flex flex-col gap-gutter-lg">
      <PageHeader
        backTo={`/infra/${id}`}
        title={hostRow.server_name || `Host #${id}`}
        description={[hostRow.hostname || hostRow.ip_address, hostRow.os_type, hostRow.collector && `via ${hostRow.collector}`].filter(Boolean).join(' · ')}
        leading={
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-sunken text-muted">
            <Icon name="desktop" size={20} />
          </div>
        }
        tabs={<Tabs value="Storage" onChange={goTab} tabs={tabDefs} />}
        actions={
          <>
            <Badge tone={status.tone} size="sm">
              <Icon name={status.icon} size={10} strokeWidth={3} />
              {status.label}
            </Badge>
            <Badge tone="warning" size="sm">File Explorer</Badge>
            <Button variant="secondary" size="sm" icon="folder" onClick={() => setParams({ path: '/' })}>File Explorer</Button>
            <Button variant="secondary" size="sm" icon="shield-check" onClick={() => goTab('IP Configuration')}>Firewall</Button>
            {hostRow.collector === 'agent' && isWin && canHere('execute') && (
              <Button variant="secondary" size="sm" icon="download" title="Download the latest agent and upgrade in place" onClick={() => setShowUpdate(true)}>Update Agent</Button>
            )}
            {canHere('restart') && (
              <Button variant="secondary" size="sm" icon="power" onClick={() => setShowRestart(true)}>Restart</Button>
            )}
            {canHere('view') && (
              <button
                type="button"
                onClick={refreshAll}
                title="Refresh now"
                className="flex h-control shrink-0 items-center gap-1.5 rounded-control border border-border px-2.5 text-[12px] font-semibold text-muted transition-colors hover:bg-sunken hover:text-fg"
              >
                <Icon name="refresh" size={13} className={hostFetching || isFetching || reading ? 'animate-spin' : undefined} />
                Refresh
              </button>
            )}
          </>
        }
      />

      <div className="card overflow-hidden">
        {/* Toolbar: back + breadcrumb path + search */}
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-sunken px-5 py-3">
          <Button variant="secondary" size="sm" icon="arrow-left" onClick={goBack}>Back</Button>
          <Icon name="desktop" size={16} className="ml-1 shrink-0 text-accent-text" />
          <button onClick={() => setParams({ path: '/' })} className="text-[15px] font-bold text-accent-text hover:underline">/</button>
          {crumbs.map((c, i) => (
            <React.Fragment key={i}>
              <Icon name="chevron-right" size={14} className="text-subtle" />
              {i === crumbs.length - 1 ? (
                <span className="text-[15px] font-black text-fg">{c}</span>
              ) : (
                <button onClick={() => setParams({ path: crumbPath(i) })} className="text-[15px] font-bold text-accent-text hover:underline">{c}</button>
              )}
            </React.Fragment>
          ))}
          {(isFetching || reading) && <Icon name="spinner" size={16} className="ml-2 animate-spin text-accent-text" />}
          {!file && (
            <div className="ml-auto flex items-center gap-3">
              <Input icon="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search this folder…"
                size="sm" wrapperClassName="w-56" />
              <span className="whitespace-nowrap text-[13px] font-semibold text-subtle">
                {search.trim() ? `${visibleEntries.length} / ${dir?.count ?? 0}` : `${dir?.count ?? 0} items`}
              </span>
            </div>
          )}
        </div>

        {/* SSH needed (SSH-registered hosts without creds only — agent hosts browse via agent) */}
        {needsSsh && (
          <div className="p-6">
            <div className="flex items-start gap-3 rounded-control bg-warning-soft p-5">
              <Icon name="lock" size={18} className="mt-0.5 shrink-0 text-warning-fg" />
              <div className="flex-1">
                <p className="text-[16px] font-black text-fg">SSH credentials needed for file browsing</p>
                <p className="mt-1 text-[14px] text-muted">{(dir || doc)?.message}</p>
                <div className="mt-4 grid max-w-xl grid-cols-1 gap-3 sm:grid-cols-3">
                  <Input value={ssh.user} onChange={(e) => setSsh((s) => ({ ...s, user: e.target.value }))} placeholder="SSH username" />
                  <div className="relative flex items-center">
                    <Input value={ssh.pass} type={showPass ? 'text' : 'password'} onChange={(e) => setSsh((s) => ({ ...s, pass: e.target.value }))}
                      placeholder="SSH password" className="pr-9" wrapperClassName="flex-1" />
                    <button onClick={() => setShowPass((v) => !v)} className="absolute right-2.5 text-subtle hover:text-fg">
                      <Icon name={showPass ? 'eye-off' : 'eye'} size={14} />
                    </button>
                  </div>
                  <Input value={ssh.port} type="number" onChange={(e) => setSsh((s) => ({ ...s, port: e.target.value }))} placeholder="22" />
                </div>
                <Button variant="primary" icon="key" loading={saving} disabled={saving || !ssh.user || !ssh.pass} onClick={saveSsh} className="mt-4">
                  Save &amp; Browse
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* Error */}
        {!needsSsh && errMsg && (
          <div className="p-6">
            <div className="flex items-center gap-2.5 rounded-control bg-danger-soft p-4 text-[15px] text-danger-fg">
              <Icon name="alert" size={17} className="shrink-0" /> {errMsg}
              {file && <button onClick={() => setParams({ path })} className="ml-auto shrink-0 font-bold text-accent-text hover:underline">← Back to folder</button>}
            </div>
          </div>
        )}

        {/* Directory listing */}
        {!needsSsh && !errMsg && !file && dir?.entries && (
          dirRows.length ? (
            <Table columns={dirColumns} rows={dirRows} />
          ) : (
            <div className="px-card py-10">
              <EmptyState icon="folder" title="Empty folder" body="This folder has no files or subfolders." />
            </div>
          )
        )}

        {/* File content viewer / editor */}
        {!needsSsh && !errMsg && file && doc && !doc.needs_ssh && (
          <div>
            <div className="flex flex-wrap items-center gap-3 border-b border-border bg-sunken px-5 py-3 text-[14px] text-muted">
              <button onClick={() => setParams({ path })} className="flex items-center gap-1 font-bold text-accent-text hover:underline">
                <Icon name="arrow-left" size={14} /> Back to folder
              </button>
              <span className="font-mono">{fmtBytes(doc.size)}</span>
              {doc.truncated && <Badge tone="warning" size="xs">showing first {fmtBytes(doc.read_bytes)}</Badge>}
              <div className="ml-auto flex items-center gap-2">
                {!doc.binary && !editing && !doc.truncated && canHere('edit') && (
                  <Button variant="secondary" size="sm" icon="file-edit" onClick={startEdit}>Edit</Button>
                )}
                {!doc.binary && !editing && doc.truncated && (
                  <span className="text-[12px] text-subtle">Too large to edit here</span>
                )}
                {editing && (
                  <>
                    <Button variant="secondary" size="sm" icon="close" onClick={() => { setEditing(false); setSaveMsg(null); }}>Cancel</Button>
                    <Button variant="primary" size="sm" icon="save" loading={savingFile} disabled={savingFile} onClick={saveFile}>Save</Button>
                  </>
                )}
              </div>
            </div>
            {saveMsg && (
              <div className={cn('flex items-center gap-2 px-5 py-2.5 text-[13px] font-semibold', saveMsg.ok ? 'bg-success-soft text-success-fg' : 'bg-danger-soft text-danger-fg')}>
                <Icon name={saveMsg.ok ? 'check' : 'alert'} size={14} />{saveMsg.text}
              </div>
            )}
            {doc.binary ? (
              <p className="p-8 text-[15px] text-subtle">Binary file — preview not available.</p>
            ) : editing ? (
              <textarea value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false}
                className="w-full resize-none bg-sunken p-5 text-[14px] leading-relaxed font-mono text-fg outline-none"
                style={{ height: '65vh' }} />
            ) : (
              <pre className="max-h-[65vh] overflow-y-auto whitespace-pre-wrap break-all bg-sunken p-5 text-[14px] leading-relaxed font-mono text-fg">{doc.content || '(empty file)'}</pre>
            )}
          </div>
        )}
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
