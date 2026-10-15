import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import cn from '@/lib/cn';
import client, { errorText } from '@/api/client';
import PageHeader from '@/components/layout/PageHeader';
import Button from '@/components/ui/Button';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import Notice from '@/components/ui/Notice';
import Tabs from '@/components/ui/Tabs';
import { PageLoading } from '@/components/ui/Loading';
import ProviderLogo from '@/features/cloud/components/ProviderLogo';
import { providerTileStyle } from '@/features/cloud/utils/providerTheme';
import AnalysisTab, { FeatureStrip, DropZone, MAX_MB } from './awr/AnalysisTab';
import AlertsTab from './awr/AlertsTab';
import CapacityTab from './awr/CapacityTab';
import HistoryTab from './awr/HistoryTab';
import OverviewTab from './awr/OverviewTab';
import PredictionsTab from './awr/PredictionsTab';
import RecommendationsTab from './awr/RecommendationsTab';
import SqlTab from './awr/SqlTab';
import WaitsTab from './awr/WaitsTab';
import { API, StaleBanner, fmtDay, num } from './awr/shared';

/**
 * Oracle Performance Intelligence — uploaded AWR reports, per database.
 *
 * /cloud/oracle-awr is the whole library (opened from the OCI page);
 * /oracle-dashboard/:id/awr is the same workspace limited to reports linked to
 * one monitored connection. Everything here comes from uploaded, historical
 * AWR files: it is never presented as live monitoring.
 */
const TABS = [
  { id: 'overview', label: 'Overview', icon: 'activity' },
  { id: 'analysis', label: 'AWR Analysis', icon: 'report' },
  { id: 'sql', label: 'SQL Insights', icon: 'zap' },
  { id: 'waits', label: 'Wait Events', icon: 'clock' },
  { id: 'predictions', label: 'Predictions & Trends', icon: 'trend' },
  { id: 'capacity', label: 'Capacity Planning', icon: 'gauge' },
  { id: 'recommendations', label: 'Recommendations', icon: 'check' },
  { id: 'history', label: 'History & Reports', icon: 'history' },
  { id: 'alerts', label: 'Alerts', icon: 'alert' },
];
const isAwrFile = (f) => /\.html?$/i.test(f.name);

export default function OracleAwrPage() {
  const { id: connectionId } = useParams(); // absent on /cloud/oracle-awr
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const fileInputRef = useRef(null);
  const [notice, setNotice] = useState(null);
  const [selectedReport, setSelectedReport] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);

  const tab = TABS.some((t) => t.id === params.get('tab')) ? params.get('tab') : 'overview';
  const setTab = (t) => setParams((p) => { const n = new URLSearchParams(p); n.set('tab', t); return n; }, { replace: true });
  const setDb = (k) => setParams((p) => { const n = new URLSearchParams(p); n.set('db', k); return n; }, { replace: true });

  const reportsQ = useQuery({
    queryKey: ['oracleAwrReports', connectionId ?? 'all'],
    queryFn: () => client.get(`${API}/`, { params: connectionId ? { connection_id: connectionId } : {} }).then((r) => r.data),
    retry: false,
  });
  const dbQ = useQuery({ queryKey: ['awrDb', 'list'], queryFn: () => client.get(`${API}/databases`).then((r) => r.data), retry: false });
  const connQ = useQuery({
    queryKey: ['oracleConnection', connectionId], enabled: Boolean(connectionId), retry: false,
    queryFn: () => client.get(`/connections/oracle/${connectionId}`).then((r) => r.data?.data),
  });

  const allReports = useMemo(() => reportsQ.data?.reports || [], [reportsQ.data]);
  const databases = useMemo(() => {
    const keys = new Set(allReports.map((r) => r.database_key).filter(Boolean));
    return (dbQ.data?.databases || []).filter((d) => keys.has(d.database_key));
  }, [dbQ.data, allReports]);
  const dbKey = databases.some((d) => d.database_key === params.get('db')) ? params.get('db') : databases[0]?.database_key;
  const db = databases.find((d) => d.database_key === dbKey);
  const dbReports = allReports.filter((r) => r.database_key === dbKey);
  const unidentified = allReports.filter((r) => !r.database_key);

  const invalidate = () => qc.invalidateQueries({ predicate: (q) => ['oracleAwrReports', 'awrDb', 'awrAlerts', 'oracleAwrReportDetail'].includes(q.queryKey[0]) });

  const upload = useMutation({
    mutationFn: (files) => {
      const multiple = files.length > 1;
      const form = new FormData();
      files.forEach((f) => form.append(multiple ? 'files' : 'file', f));
      if (connectionId) form.append('connection_id', connectionId);
      return client.post(`${API}/${multiple ? 'batch-upload' : 'upload'}`, form, { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 600000 }).then((r) => r.data);
    },
    onSuccess: (res) => {
      if (res?.status === 'error') { setNotice({ tone: 'danger', text: res.error }); return; }
      const first = res.report || res.results?.find((r) => r.report)?.report;
      if (res.batch_id) {
        const errs = res.results.filter((r) => r.status === 'error').map((r) => r.error);
        setNotice({ tone: res.failed ? 'warning' : 'success',
          text: `Batch analysed: ${res.succeeded} of ${res.total} parsed.${errs.length ? ` ${errs.slice(0, 3).join(' ')}` : ''}` });
      } else if (res.report?.status === 'FAILED') {
        setNotice({ tone: 'danger', text: `Could not analyse ${res.report.original_filename}: ${res.report.error_message}` });
      } else {
        setNotice({ tone: 'success', text: `${res.report.original_filename} analysed.` });
      }
      if (first?.database_key) setDb(first.database_key);
      if (first?.id) setSelectedReport(first.id);
      setTab('analysis');
      invalidate();
    },
    onError: (err) => setNotice({ tone: 'danger', text: errorText(err) }),
  });

  const remove = useMutation({
    mutationFn: (rid) => client.delete(`${API}/${rid}`).then((r) => r.data),
    onSuccess: (res) => {
      setPendingDelete(null);
      setNotice(res?.status === 'error' ? { tone: 'danger', text: res.error } : { tone: 'success', text: 'Report deleted; this database’s history was recomputed.' });
      invalidate();
    },
    onError: (err) => { setPendingDelete(null); setNotice({ tone: 'danger', text: errorText(err) }); },
  });

  const handleFiles = (fileList) => {
    const files = Array.from(fileList || []);
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (!files.length) return;
    const rejected = files.filter((f) => !isAwrFile(f) || f.size > MAX_MB * 1024 * 1024);
    const accepted = files.filter((f) => !rejected.includes(f));
    setNotice(rejected.length ? { tone: 'warning', text: `Skipped ${rejected.map((f) => f.name).join(', ')} — only .html/.htm AWR reports up to ${MAX_MB} MB.` } : null);
    if (accepted.length) upload.mutate(accepted);
  };
  const browse = () => fileInputRef.current?.click();

  useEffect(() => { setSelectedReport(null); }, [dbKey]);

  if (reportsQ.isLoading || dbQ.isLoading) return <PageLoading />;

  const conn = connQ.data;
  const subtitle = db
    ? [db.db_name, db.host_name, db.release && `Oracle ${db.release}`, db.is_rac ? `RAC instance ${db.instance_number}` : null,
       db.num_cpus && `${num(db.num_cpus, 0)} CPUs`, `${db.parsed_reports} report${db.parsed_reports === 1 ? '' : 's'}`,
       db.first_window && `${fmtDay(db.first_window)} – ${fmtDay(db.last_window)}`].filter(Boolean).join(' · ')
    : connectionId ? (conn ? `${conn.connection_name || 'Oracle'} — no reports linked yet` : 'Reports linked to this Oracle connection')
      : 'Upload AWR reports to analyse a database’s performance';

  const tabProps = { databaseKey: dbKey };
  return (
    <div>
      <input ref={fileInputRef} type="file" accept=".html,.htm" multiple hidden onChange={(e) => handleFiles(e.target.files)} />
      <PageHeader
        title="Oracle Performance Intelligence"
        description={subtitle}
        backTo={connectionId ? `/oracle-dashboard/${connectionId}` : '/cloud/oci-accounts'}
        leading={<div className="grid h-10 w-10 shrink-0 place-items-center rounded-md border" style={providerTileStyle('OCI')}><ProviderLogo provider="OCI" size={28} /></div>}
        actions={<Button variant="primary" icon="report" onClick={browse} loading={upload.isPending}>Upload AWR</Button>}
      />

      {(reportsQ.error || dbQ.error) && <Notice tone="danger">{errorText(reportsQ.error || dbQ.error, 'Could not load AWR data.')}</Notice>}
      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}

      {!databases.length ? (
        <>
          <DropZone onFiles={handleFiles} onBrowse={browse} busy={upload.isPending} compact={false} />
          {unidentified.length > 0 && (
            <Notice tone="warning">{unidentified.length} uploaded file(s) could not be identified as an AWR report of a database — see the error on each in History once a database exists, or re-upload a valid AWR HTML file.</Notice>
          )}
          <FeatureStrip />
        </>
      ) : (
        <>
          {databases.length > 1 && (
            <div className="mb-4 flex flex-wrap items-center gap-1.5 rounded-2xl border border-border bg-surface px-4 py-2.5 shadow-sm">
              <span className="mr-1 text-micro font-bold tracking-wide text-subtle uppercase">Database</span>
              {databases.map((d) => (
                <button key={d.database_key} type="button" onClick={() => setDb(d.database_key)} aria-pressed={d.database_key === dbKey}
                        className={cn('inline-flex h-7 items-center gap-1.5 rounded-lg px-3 text-meta font-bold transition-all',
                          d.database_key === dbKey ? 'bg-accent text-accent-fg shadow-sm' : 'text-muted hover:bg-sunken hover:text-fg')}>
                  {d.db_name}{d.is_rac ? ` #${d.instance_number}` : ''}
                  <span className={cn('rounded-full px-1.5 text-micro', d.database_key === dbKey ? 'bg-white/25' : 'bg-sunken')}>{d.parsed_reports}</span>
                </button>
              ))}
            </div>
          )}
          <StaleBanner freshness={db} />
          <Tabs tabs={TABS} value={tab} onChange={setTab} className="mb-gutter" />
          {tab === 'overview' && <OverviewTab {...tabProps} />}
          {tab === 'analysis' && (
            <AnalysisTab reports={dbReports} selectedId={selectedReport} setSelectedId={setSelectedReport}
                         onFiles={handleFiles} onBrowse={browse} uploading={upload.isPending} onDelete={setPendingDelete} />
          )}
          {tab === 'sql' && <SqlTab {...tabProps} />}
          {tab === 'waits' && <WaitsTab {...tabProps} />}
          {tab === 'predictions' && <PredictionsTab {...tabProps} />}
          {tab === 'capacity' && <CapacityTab {...tabProps} />}
          {tab === 'recommendations' && <RecommendationsTab {...tabProps} />}
          {tab === 'history' && <HistoryTab {...tabProps} reports={dbReports} onDelete={setPendingDelete} />}
          {tab === 'alerts' && <AlertsTab {...tabProps} />}
        </>
      )}

      <ConfirmDialog
        open={Boolean(pendingDelete)} tone="danger" icon="trash" title="Delete this AWR report?"
        message={pendingDelete ? `${pendingDelete.original_filename} and its findings will be removed, the uploaded file deleted, and this database’s trends recomputed.` : ''}
        confirmLabel="Delete report" cancelLabel="Keep it" loading={remove.isPending}
        onConfirm={() => remove.mutate(pendingDelete.id)} onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
