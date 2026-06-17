import React, { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft, RefreshCw, Download, Upload, Archive,
  Clock, Database, CheckCircle2, AlertTriangle, Info,
  Copy, Check, Shield, Calendar, Terminal, Zap,
  HardDrive, FileText, RotateCcw, Settings,
} from 'lucide-react';
import client from '../../api/client';

const C = { green: '#00ED64', dark: '#00684A', navy: '#001E2B', emerald: '#00C851', blue: '#3B82F6', orange: '#F97316', red: '#EF4444' };

const fetchDashboard = (id) => client.get(`/connections/mongodb/${id}/mongo-dashboard`).then(r => r.data);

function CopyBtn({ text, label = 'Copy' }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
      className="flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all"
      style={copied
        ? { background: '#dcfce7', color: '#166534', border: '1px solid #bbf7d0' }
        : { background: '#f1f5f9', color: '#475569', border: '1px solid #e2e8f0' }}>
      {copied ? <Check size={11} /> : <Copy size={11} />}
      {copied ? 'Copied!' : label}
    </button>
  );
}

function TabBtn({ active, onClick, icon: Icon, label }) {
  return (
    <button onClick={onClick}
      className={`flex items-center gap-2 px-5 py-2.5 text-sm font-semibold rounded-t-xl whitespace-nowrap border-b-2 transition-all ${
        active ? 'border-green-500 text-green-700 bg-white' : 'border-transparent text-slate-500 hover:text-slate-700 hover:bg-slate-50'
      }`}>
      <Icon size={14} />
      {label}
    </button>
  );
}

function CodeBlock({ code, language = 'bash' }) {
  return (
    <div className="relative bg-slate-900 rounded-xl overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 bg-slate-800 border-b border-slate-700">
        <span className="text-[10px] font-mono text-slate-400 uppercase">{language}</span>
        <CopyBtn text={code} />
      </div>
      <pre className="px-4 py-3 text-sm font-mono text-green-400 overflow-x-auto whitespace-pre-wrap leading-relaxed">{code}</pre>
    </div>
  );
}

function InfoCard({ icon: Icon, title, value, accent = 'slate' }) {
  const accentMap = { green: 'border-l-green-500', blue: 'border-l-blue-500', orange: 'border-l-orange-400', red: 'border-l-red-500', slate: 'border-l-slate-300' };
  return (
    <div className={`bg-white rounded-xl border border-slate-200 border-l-4 ${accentMap[accent]} p-4`}>
      <div className="flex items-center gap-2 mb-1">
        <Icon size={14} className="text-slate-400" />
        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wide">{title}</p>
      </div>
      <p className="font-bold text-slate-800 text-sm">{value || '—'}</p>
    </div>
  );
}

export default function MongoDBBackupPage() {
  const { id } = useParams();
  const [tab, setTab] = useState('overview');

  // Form state for command builder
  const [selectedDb,     setSelectedDb]     = useState('');
  const [selectedColl,   setSelectedColl]   = useState('');
  const [outputDir,      setOutputDir]      = useState('/backup/mongodb');
  const [compress,       setCompress]       = useState(true);
  const [includeOplog,   setIncludeOplog]   = useState(false);
  const [gzip,           setGzip]           = useState(true);
  const [restoreDir,     setRestoreDir]     = useState('/backup/mongodb/dump');
  const [restoreDb,      setRestoreDb]      = useState('');
  const [dropBeforeRestore, setDropBefore]  = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ['mongoDBBackupDash', id],
    queryFn:  () => fetchDashboard(id),
    retry: false,
  });

  const conn       = data?.connection || {};
  const health     = data?.health_summary || {};
  const databases  = (data?.databases || []).map(d => d.name).filter(n => !['admin', 'local', 'config'].includes(n));
  const version    = health.version || '';
  const host       = conn.host || 'localhost';
  const port       = conn.port || 27017;
  const username   = conn.username || '';
  const isReplSet  = health.replication_state && health.replication_state !== 'STANDALONE';

  // Build mongodump command
  const buildDumpCmd = () => {
    const parts = ['mongodump'];
    parts.push(`  --host ${host} --port ${port}`);
    if (username) parts.push(`  --username <username> --password <password>`);
    if (selectedDb)   parts.push(`  --db ${selectedDb}`);
    if (selectedColl) parts.push(`  --collection ${selectedColl}`);
    parts.push(`  --out ${outputDir}`);
    if (gzip)         parts.push('  --gzip');
    if (includeOplog && isReplSet) parts.push('  --oplog');
    return parts.join(' \\\n');
  };

  // Build mongorestore command
  const buildRestoreCmd = () => {
    const parts = ['mongorestore'];
    parts.push(`  --host ${host} --port ${port}`);
    if (username)    parts.push(`  --username <username> --password <password>`);
    if (restoreDb)   parts.push(`  --db ${restoreDb}`);
    if (gzip)        parts.push('  --gzip');
    if (dropBeforeRestore) parts.push('  --drop');
    parts.push(`  ${restoreDir}`);
    return parts.join(' \\\n');
  };

  if (isLoading) return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <div className="text-center">
        <div className="w-10 h-10 border-4 border-green-200 border-t-green-600 rounded-full animate-spin mx-auto mb-3" />
        <p className="text-slate-500 font-semibold text-sm">Loading connection info…</p>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-50">

      {/* ── Header ── */}
      <div style={{ background: `linear-gradient(135deg, ${C.navy} 0%, #0a2d1f 60%, #003d2a 100%)` }} className="text-white px-6 py-5 shadow-2xl">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div className="flex items-center gap-4">
            <Link to={`/mongodb-dashboard/${id}`}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold transition-all"
              style={{ background: 'rgba(0,237,100,0.12)', color: C.green, border: '1px solid rgba(0,237,100,0.25)' }}>
              <ArrowLeft size={13} /> Dashboard
            </Link>
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-xl flex items-center justify-center text-xl"
                style={{ background: 'rgba(0,237,100,0.15)', border: '1px solid rgba(0,237,100,0.35)' }}>💾</div>
              <div>
                <h1 className="text-xl font-black">Backup &amp; Restore</h1>
                <p className="text-xs mt-0.5" style={{ color: C.green }}>MongoDB · {host}:{port}</p>
              </div>
            </div>
          </div>
        </div>

        {/* Quick info strip */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: 'Version',      value: version.split('-')[0] || '—' },
            { label: 'Host',         value: `${host}:${port}` },
            { label: 'Replication',  value: health.replication_state || 'STANDALONE' },
            { label: 'Databases',    value: databases.length + ' available' },
          ].map(k => (
            <div key={k.label} className="rounded-2xl px-4 py-3"
              style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}>
              <p className="text-[10px] font-bold uppercase tracking-wide" style={{ color: 'rgba(255,255,255,0.5)' }}>{k.label}</p>
              <p className="text-base font-black mt-0.5 truncate" style={{ color: C.green }}>{k.value}</p>
            </div>
          ))}
        </div>
      </div>

      {/* ── Tabs ── */}
      <div className="bg-white border-b border-slate-200 px-6 flex gap-1 overflow-x-auto">
        <TabBtn active={tab === 'overview'} onClick={() => setTab('overview')} icon={Archive}   label="Overview" />
        <TabBtn active={tab === 'backup'}   onClick={() => setTab('backup')}   icon={Download}  label="Backup (mongodump)" />
        <TabBtn active={tab === 'restore'}  onClick={() => setTab('restore')}  icon={Upload}    label="Restore" />
        <TabBtn active={tab === 'schedule'} onClick={() => setTab('schedule')} icon={Calendar}  label="Scheduling Guide" />
      </div>

      <div className="p-5">

        {/* ════ OVERVIEW ════ */}
        {tab === 'overview' && (
          <div className="space-y-5 max-w-4xl">
            {/* Connection info cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <InfoCard icon={Database} title="Host"          value={host}                   accent="green" />
              <InfoCard icon={Zap}      title="Port"          value={String(port)}           accent="blue" />
              <InfoCard icon={Shield}   title="Version"       value={version}                accent="slate" />
              <InfoCard icon={HardDrive} title="Storage Engine" value={health.storage_engine || 'WiredTiger'} accent="orange" />
            </div>

            {isReplSet && (
              <div className="bg-green-50 border border-green-200 rounded-2xl p-4 flex items-start gap-3">
                <CheckCircle2 size={16} className="text-green-600 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="font-semibold text-green-800 text-sm">Replica Set detected — Oplog backup available</p>
                  <p className="text-xs text-green-600 mt-0.5">
                    Use <code className="font-mono bg-white px-1 rounded">--oplog</code> flag in mongodump for a point-in-time consistent backup of the entire replica set.
                  </p>
                </div>
              </div>
            )}

            {/* Backup strategy cards */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {[
                {
                  icon: '📦', title: 'mongodump / mongorestore',
                  desc: 'Standard logical backup tool included with MongoDB. Exports BSON files. Suitable for small to medium datasets.',
                  pros: ['Built-in, no extra software', 'Selective database/collection backup', 'Cross-version compatible'],
                  color: 'border-green-200 bg-green-50',
                },
                {
                  icon: '💽', title: 'Filesystem Snapshot',
                  desc: 'LVM or cloud disk snapshot for large deployments. Fastest for large databases but requires stopping writes or using replica.',
                  pros: ['Near-instant for large DBs', 'Block-level — includes indexes', 'Low overhead'],
                  color: 'border-blue-200 bg-blue-50',
                },
                {
                  icon: '☁️', title: 'MongoDB Atlas / Ops Manager',
                  desc: 'Automated managed backups with PITR for Atlas users. Ops Manager for on-premise with continuous backup.',
                  pros: ['Automated scheduling', 'Point-in-time restore (PITR)', 'Oplog replay support'],
                  color: 'border-purple-200 bg-purple-50',
                },
              ].map(s => (
                <div key={s.title} className={`rounded-2xl border p-5 ${s.color}`}>
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-2xl">{s.icon}</span>
                    <p className="font-bold text-slate-800 text-sm">{s.title}</p>
                  </div>
                  <p className="text-xs text-slate-600 mb-3">{s.desc}</p>
                  <ul className="space-y-1">
                    {s.pros.map(p => (
                      <li key={p} className="flex items-center gap-1.5 text-xs text-slate-600">
                        <CheckCircle2 size={11} className="text-green-500 flex-shrink-0" />
                        {p}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>

            {/* Best practices */}
            <div className="bg-white rounded-2xl border border-slate-200 p-5">
              <h3 className="font-bold text-slate-800 mb-4">Best Practices</h3>
              <div className="space-y-3">
                {[
                  { icon: CheckCircle2, color: 'text-green-500', text: 'Always run mongodump against a secondary member to avoid impacting your primary.' },
                  { icon: CheckCircle2, color: 'text-green-500', text: 'Use --gzip to compress output and reduce storage space.' },
                  { icon: CheckCircle2, color: 'text-green-500', text: 'Test restores regularly — a backup you have never restored is an untested backup.' },
                  { icon: AlertTriangle, color: 'text-amber-500', text: 'mongodump does not lock the database, but large dumps may impact I/O.' },
                  { icon: Info, color: 'text-blue-500', text: 'For WiredTiger, you can use --oplog to capture writes during the dump window for a consistent snapshot.' },
                ].map((b, i) => (
                  <div key={i} className="flex items-start gap-2.5">
                    <b.icon size={14} className={`${b.color} flex-shrink-0 mt-0.5`} />
                    <p className="text-sm text-slate-600">{b.text}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ════ BACKUP (mongodump) ════ */}
        {tab === 'backup' && (
          <div className="space-y-5 max-w-4xl">
            {/* Builder form */}
            <div className="bg-white rounded-2xl border border-slate-200 p-6">
              <h3 className="font-bold text-slate-800 mb-4">Command Builder</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-5">
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1.5">Database (leave empty for all)</label>
                  <select value={selectedDb} onChange={e => { setSelectedDb(e.target.value); setSelectedColl(''); }}
                    className="w-full h-9 px-3 rounded-xl border border-slate-200 text-sm outline-none focus:border-green-400 bg-white">
                    <option value="">— All Databases —</option>
                    {databases.map(d => <option key={d} value={d}>{d}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1.5">Output Directory</label>
                  <input value={outputDir} onChange={e => setOutputDir(e.target.value)}
                    className="w-full h-9 px-3 rounded-xl border border-slate-200 text-sm outline-none focus:border-green-400 font-mono" />
                </div>
                <div className="flex flex-col gap-2">
                  <label className="text-xs font-semibold text-slate-600">Options</label>
                  {[
                    { key: 'gzip',         val: gzip,         set: setGzip,         label: '--gzip (compress output files)' },
                    { key: 'oplog',        val: includeOplog, set: setIncludeOplog, label: '--oplog (point-in-time, replica set only)', disabled: !isReplSet },
                  ].map(o => (
                    <label key={o.key} className={`flex items-center gap-2 cursor-pointer ${o.disabled ? 'opacity-40 cursor-not-allowed' : ''}`}>
                      <input type="checkbox" checked={o.val} onChange={e => o.set(e.target.checked)} disabled={o.disabled}
                        className="w-4 h-4 rounded accent-green-600" />
                      <span className="text-xs text-slate-600 font-mono">{o.label}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs font-bold text-slate-600 uppercase tracking-wide">Generated Command</p>
                  <CopyBtn text={buildDumpCmd()} label="Copy Command" />
                </div>
                <CodeBlock code={buildDumpCmd()} />
              </div>
            </div>

            {/* Common scenarios */}
            <div className="bg-white rounded-2xl border border-slate-200 p-6">
              <h3 className="font-bold text-slate-800 mb-4">Common Scenarios</h3>
              <div className="space-y-4">
                {[
                  {
                    title: 'Full instance backup',
                    desc: 'Backup all databases with compression',
                    code: `mongodump \\\n  --host ${host} --port ${port} \\\n  --out /backup/mongo-$(date +%Y%m%d) \\\n  --gzip`,
                  },
                  {
                    title: 'Single database backup',
                    desc: 'Backup a specific database only',
                    code: `mongodump \\\n  --host ${host} --port ${port} \\\n  --db myapp \\\n  --out /backup/myapp-$(date +%Y%m%d) \\\n  --gzip`,
                  },
                  ...(isReplSet ? [{
                    title: 'Oplog-backed consistent backup',
                    desc: 'Capture all writes during dump for a consistent snapshot',
                    code: `mongodump \\\n  --host ${host} --port ${port} \\\n  --out /backup/full-$(date +%Y%m%d) \\\n  --gzip --oplog`,
                  }] : []),
                ].map(s => (
                  <div key={s.title} className="border border-slate-100 rounded-xl overflow-hidden">
                    <div className="px-4 py-2.5 bg-slate-50 flex items-center justify-between">
                      <div>
                        <p className="font-semibold text-slate-800 text-sm">{s.title}</p>
                        <p className="text-xs text-slate-500">{s.desc}</p>
                      </div>
                      <CopyBtn text={s.code} />
                    </div>
                    <CodeBlock code={s.code} />
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ════ RESTORE ════ */}
        {tab === 'restore' && (
          <div className="space-y-5 max-w-4xl">
            {/* Warning */}
            <div className="bg-red-50 border border-red-200 rounded-2xl p-4 flex items-start gap-3">
              <AlertTriangle size={16} className="text-red-500 flex-shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold text-red-800 text-sm">Always test in a non-production environment first</p>
                <p className="text-xs text-red-600 mt-0.5">Using <code className="font-mono bg-white px-1 rounded">--drop</code> will delete existing collections before restoring. This cannot be undone.</p>
              </div>
            </div>

            {/* Builder form */}
            <div className="bg-white rounded-2xl border border-slate-200 p-6">
              <h3 className="font-bold text-slate-800 mb-4">Restore Command Builder</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-5">
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1.5">Backup Directory (dump folder)</label>
                  <input value={restoreDir} onChange={e => setRestoreDir(e.target.value)}
                    className="w-full h-9 px-3 rounded-xl border border-slate-200 text-sm outline-none focus:border-green-400 font-mono" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1.5">Target Database (leave empty to restore all)</label>
                  <input value={restoreDb} onChange={e => setRestoreDb(e.target.value)}
                    placeholder="e.g. myapp"
                    className="w-full h-9 px-3 rounded-xl border border-slate-200 text-sm outline-none focus:border-green-400 font-mono" />
                </div>
                <div className="flex flex-col gap-2">
                  <label className="text-xs font-semibold text-slate-600">Options</label>
                  {[
                    { key: 'gzip', val: gzip, set: setGzip, label: '--gzip (if backup was compressed)' },
                    { key: 'drop', val: dropBeforeRestore, set: setDropBefore, label: '--drop (delete collections before restore) ⚠️', danger: true },
                  ].map(o => (
                    <label key={o.key} className="flex items-center gap-2 cursor-pointer">
                      <input type="checkbox" checked={o.val} onChange={e => o.set(e.target.checked)}
                        className={`w-4 h-4 rounded ${o.danger ? 'accent-red-600' : 'accent-green-600'}`} />
                      <span className={`text-xs font-mono ${o.danger ? 'text-red-600' : 'text-slate-600'}`}>{o.label}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs font-bold text-slate-600 uppercase tracking-wide">Generated Command</p>
                  <CopyBtn text={buildRestoreCmd()} label="Copy Command" />
                </div>
                <CodeBlock code={buildRestoreCmd()} />
              </div>
            </div>

            {/* Restore steps */}
            <div className="bg-white rounded-2xl border border-slate-200 p-6">
              <h3 className="font-bold text-slate-800 mb-4">Restore Procedure</h3>
              <ol className="space-y-4">
                {[
                  { step: 1, title: 'Verify backup integrity', code: `ls -lh ${restoreDir}/`, desc: 'Ensure the dump directory exists and contains the expected files.' },
                  { step: 2, title: 'Stop application connections (optional)', desc: 'For a clean restore, stop all application writes to the target database.' },
                  { step: 3, title: 'Run mongorestore', code: buildRestoreCmd(), desc: 'Execute the restore command. Monitor progress output.' },
                  { step: 4, title: 'Verify data', code: `mongo ${host}:${port} --eval "db.adminCommand({ listDatabases: 1 })"`, desc: 'Confirm databases and collection counts match expectations.' },
                  { step: 5, title: 'Rebuild indexes (if needed)', desc: 'mongorestore rebuilds indexes automatically, but for large collections you may reindex in the background.' },
                ].map(s => (
                  <li key={s.step} className="flex gap-4">
                    <div className="flex-shrink-0 h-7 w-7 rounded-full flex items-center justify-center text-sm font-black text-white" style={{ background: C.dark }}>{s.step}</div>
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-slate-800 text-sm mb-1">{s.title}</p>
                      <p className="text-xs text-slate-500 mb-2">{s.desc}</p>
                      {s.code && <CodeBlock code={s.code} />}
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        )}

        {/* ════ SCHEDULE GUIDE ════ */}
        {tab === 'schedule' && (
          <div className="space-y-5 max-w-4xl">
            <div className="bg-white rounded-2xl border border-slate-200 p-6">
              <h3 className="font-bold text-slate-800 mb-4">Linux Cron Schedule Examples</h3>
              <p className="text-sm text-slate-500 mb-4">Add these entries to <code className="font-mono bg-slate-50 px-1.5 py-0.5 rounded text-xs">crontab -e</code> on your backup server.</p>

              {[
                {
                  title: 'Daily full backup at 2 AM',
                  cron: `0 2 * * * mongodump --host ${host} --port ${port} --out /backup/daily/$(date +\\%Y\\%m\\%d) --gzip`,
                },
                {
                  title: 'Weekly full backup every Sunday midnight',
                  cron: `0 0 * * 0 mongodump --host ${host} --port ${port} --out /backup/weekly/$(date +\\%Y\\%m\\%d) --gzip`,
                },
                {
                  title: 'Hourly backup of single database',
                  cron: `0 * * * * mongodump --host ${host} --port ${port} --db myapp --out /backup/hourly/$(date +\\%Y\\%m\\%d_\\%H) --gzip`,
                },
                {
                  title: 'Cleanup backups older than 7 days',
                  cron: `0 3 * * * find /backup/daily -maxdepth 1 -type d -mtime +7 -exec rm -rf {} +`,
                },
              ].map(s => (
                <div key={s.title} className="mb-4 last:mb-0">
                  <p className="text-xs font-semibold text-slate-600 mb-1.5">{s.title}</p>
                  <CodeBlock code={s.cron} />
                </div>
              ))}
            </div>

            <div className="bg-white rounded-2xl border border-slate-200 p-6">
              <h3 className="font-bold text-slate-800 mb-4">Backup Rotation Strategy</h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {[
                  { period: 'Hourly',  keep: '24 hours',  type: 'Incremental (oplog)' },
                  { period: 'Daily',   keep: '7 days',    type: 'Full mongodump + gzip' },
                  { period: 'Weekly',  keep: '4 weeks',   type: 'Full mongodump + gzip' },
                  { period: 'Monthly', keep: '12 months', type: 'Full mongodump archived' },
                ].map(s => (
                  <div key={s.period} className="bg-slate-50 rounded-xl border border-slate-100 p-4">
                    <p className="font-bold text-slate-800">{s.period}</p>
                    <p className="text-xs text-slate-500 mt-0.5">Retain: <span className="font-semibold">{s.keep}</span></p>
                    <p className="text-xs text-slate-500">Type: <span className="font-semibold">{s.type}</span></p>
                  </div>
                ))}
              </div>
            </div>

            <div className="bg-blue-50 border border-blue-200 rounded-2xl p-5">
              <div className="flex items-start gap-3">
                <Info size={16} className="text-blue-500 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="font-semibold text-blue-800 text-sm mb-1">Replica Set Tip</p>
                  <p className="text-sm text-blue-700">
                    {isReplSet
                      ? `Your instance is in a replica set (${health.replication_state}). Run mongodump against a SECONDARY member to avoid impacting primary performance:`
                      : 'If you upgrade to a replica set, you can run mongodump against a secondary to minimize impact on the primary.'}
                  </p>
                  {isReplSet && (
                    <CodeBlock code={`mongodump \\\n  --host <secondary-host>:${port} \\\n  --readPreference secondary \\\n  --out /backup/$(date +%Y%m%d) \\\n  --gzip --oplog`} />
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
