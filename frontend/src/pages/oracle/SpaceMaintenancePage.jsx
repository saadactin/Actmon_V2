import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import client, { errorText } from '@/api/client';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import Dialog from '@/components/ui/Dialog';
import Input from '@/components/ui/Input';
import Notice from '@/components/ui/Notice';
import Table, { EmptyState } from '@/components/ui/Table';
import { InlineLoading, PageLoading } from '@/components/ui/Loading';
import { Paged } from '@/components/ui/Pagination';
import { fmtNumber } from '@/config/dbCatalog';
import { CategorySummaryBar, OperationConfirmDialog, RefreshBar, useDirectMaintenance } from './maintenanceShared';
import { fmtIST } from './storageHealthConstants';

const REFRESH_SECONDS = 30;

function AnalysisDialog({ tablespaceName, connId, onClose }) {
  const q = useQuery({
    queryKey: ['oracleTsAnalysis', connId, tablespaceName],
    queryFn: () => client.get(`/connections/oracle/${connId}/oracle-maintenance/tablespace-analysis`, {
      params: { tablespace_name: tablespaceName },
    }).then((r) => r.data),
    enabled: !!tablespaceName,
    retry: false,
  });
  const d = q.data;
  return (
    <Dialog open={!!tablespaceName} onClose={onClose} title={`Space Analysis — ${tablespaceName}`} icon="database" width={520}>
      {q.isLoading && <InlineLoading label="Analyzing tablespace…" />}
      {d?.status === 'error' && <Notice tone="danger" title="Analysis failed.">{d.error}</Notice>}
      {d?.status === 'success' && (
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-gutter-sm">
            <div className="rounded-card bg-sunken p-3">
              <p className="text-[10px] font-bold uppercase text-subtle">Size</p>
              <p className="text-[15px] font-bold text-fg">{fmtNumber(round2(d.size_bytes / 1024 / 1024))} MB</p>
            </div>
            <div className="rounded-card bg-sunken p-3">
              <p className="text-[10px] font-bold uppercase text-subtle">Used</p>
              <p className="text-[15px] font-bold text-fg">{d.blocks?.used_pct ?? '—'}%</p>
            </div>
            <div className="rounded-card bg-sunken p-3">
              <p className="text-[10px] font-bold uppercase text-subtle">Free</p>
              <p className="text-[15px] font-bold text-fg">{fmtNumber(round2(d.free_bytes / 1024 / 1024))} MB</p>
            </div>
          </div>
          <div className="rounded-card border border-border p-3">
            <p className="mb-1 text-[11px] font-bold uppercase text-subtle">Growth Trend</p>
            {d.growth?.insufficient_history ? (
              <p className="text-[12px] text-muted">Not enough history yet to estimate growth (needs &gt;24h of samples).</p>
            ) : (
              <p className="text-[12px] text-fg">
                Growing ~<span className="font-semibold">{fmtNumber(d.growth?.mb_per_day)} MB/day</span>
                {d.growth?.days_to_full != null && <> — projected full in <span className="font-semibold">{fmtNumber(d.growth.days_to_full)} days</span> at this rate.</>}
              </p>
            )}
          </div>
          <div>
            <p className="mb-1 text-[11px] font-bold uppercase text-subtle">Datafiles ({d.datafiles?.length || 0})</p>
            <div className="max-h-48 overflow-y-auto rounded-card border border-border">
              {(d.datafiles || []).map((df) => (
                <div key={df.file_id} className="flex items-center justify-between border-b border-border px-3 py-1.5 text-[11px] last:border-b-0">
                  <span className="truncate font-mono text-fg" title={df.file_name}>{df.file_name}</span>
                  <span className="shrink-0 font-mono text-muted">{fmtNumber(round2(df.size_bytes / 1024 / 1024))} MB</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </Dialog>
  );
}

function round2(v) { return Math.round((v || 0) * 100) / 100; }

function ResizeDialog({ target, connId, directMut, onClose }) {
  const [targetMb, setTargetMb] = useState('');
  const info = useQuery({
    queryKey: ['oracleDatafileResizeInfo', connId, target?.file_name],
    queryFn: () => client.get(`/connections/oracle/${connId}/oracle-maintenance/datafile-resize-info`, {
      params: { file_name: target.file_name },
    }).then((r) => r.data),
    enabled: !!target,
    retry: false,
  });
  const minSafe = info.data?.min_safe_mb;
  const invalid = targetMb !== '' && minSafe != null && Number(targetMb) < minSafe;

  return (
    <ConfirmDialog
      open={!!target}
      title={`Resize Datafile`}
      tone="warning"
      confirmLabel="Resize"
      cancelLabel="Cancel"
      loading={directMut.isPending}
      confirmDisabled={!targetMb || invalid || info.isLoading}
      onCancel={onClose}
      onConfirm={() => directMut.mutate({
        objectType: 'datafile', objectName: target.file_name, action: 'datafile_resize',
        params: { target_size_mb: Number(targetMb) },
      })}
    >
      <div className="space-y-2">
        <p className="max-w-full break-all font-mono text-[11px] text-muted">{target?.file_name}</p>
        {info.isLoading ? <InlineLoading label="Calculating minimum safe size…" /> : (
          <>
            <p className="text-[12px] text-muted">
              Current: <span className="font-semibold text-fg">{fmtNumber(info.data?.current_mb)} MB</span> ·
              {' '}Minimum safe size: <span className="font-semibold text-fg">{fmtNumber(minSafe)} MB</span> (below this fails or corrupts the datafile)
            </p>
            <Input
              type="number" value={targetMb} onChange={(e) => setTargetMb(e.target.value)}
              placeholder={`≥ ${minSafe} MB`} size="sm"
            />
            {invalid && <p className="text-[12px] text-danger-fg">Target size is below the minimum safe size for this datafile.</p>}
          </>
        )}
        {directMut.error && <p className="text-[12px] text-danger-fg">{errorText(directMut.error)}</p>}
      </div>
    </ConfirmDialog>
  );
}

export default function SpaceMaintenancePage({ connId }) {
  const navigate = useNavigate();
  const [analysisTarget, setAnalysisTarget] = useState(null);
  const [resizeTarget, setResizeTarget] = useState(null);
  const [purgeConfirm, setPurgeConfirm] = useState(false);

  const q = useQuery({
    queryKey: ['oracleSpaceMaintenance', connId],
    queryFn: () => client.get(`/connections/oracle/${connId}/oracle-maintenance/space-telemetry`).then((r) => r.data),
    retry: false,
    refetchInterval: REFRESH_SECONDS * 1000,
  });

  const [countdown, setCountdown] = useState(REFRESH_SECONDS);
  useEffect(() => {
    const t = setInterval(() => setCountdown((c) => (c <= 1 ? REFRESH_SECONDS : c - 1)), 1000);
    return () => clearInterval(t);
  }, []);

  const directMut = useDirectMaintenance(connId, navigate, 'space');

  if (q.isLoading) return <PageLoading title="Reading tablespace/datafile/recyclebin telemetry…" illustration />;
  if (q.error || q.data?.status === 'error') {
    return <Notice tone="danger" title="Could not load space telemetry.">{q.data?.error || q.error?.message}</Notice>;
  }

  const s = q.data.summary;
  const tablespaces = q.data.tablespaces || [];
  const datafiles = q.data.datafiles || [];
  const recyclebin = q.data.recyclebin || { by_owner: {}, total_mb: 0 };

  return (
    <div className="space-y-gutter">
      <RefreshBar seconds={countdown} isFetching={q.isFetching} onRefresh={() => { q.refetch(); setCountdown(REFRESH_SECONDS); }} lastUpdatedAt={new Date().toISOString()} />

      {(q.data.errors || []).length > 0 && (
        <Notice tone="warning" title="Some telemetry could not be collected.">{q.data.errors.join(' · ')}</Notice>
      )}

      <CategorySummaryBar items={[
        { label: 'Tablespaces', value: fmtNumber(s.total_tablespaces) },
        { label: 'Requiring Attention', value: fmtNumber(s.requiring_attention), tone: s.requiring_attention ? 'warn' : 'good' },
        { label: 'Datafiles', value: fmtNumber(s.total_datafiles) },
        { label: 'Recycle Bin', value: `${fmtNumber(s.reclaimable_mb)} MB` },
        { label: 'Running', value: s.running, tone: s.running ? 'warn' : 'good' },
        { label: 'Failed', value: s.failed, tone: s.failed ? 'bad' : 'good' },
      ]}
      />

      <div className="card p-card">
        <div className="mb-3 flex items-center justify-between">
          <p className="text-[13px] font-bold text-fg">Tablespaces</p>
        </div>
        <Table
          columns={[
            { key: 'name', label: 'Tablespace' },
            { key: 'total', label: 'Total', align: 'right' },
            { key: 'used', label: 'Used', align: 'right' },
            { key: 'free', label: 'Free', align: 'right' },
            { key: 'pct', label: 'Used %', align: 'right' },
            { key: 'status', label: 'Status' },
            { key: 'ops', label: '' },
          ]}
          rows={tablespaces.map((t) => ({
            key: t.tablespace_name,
            cells: {
              name: <span className="font-mono text-[12px] font-semibold text-fg">{t.tablespace_name}</span>,
              total: <span className="font-mono text-[12px]">{fmtNumber(t.total_mb)} MB</span>,
              used: <span className="font-mono text-[12px]">{fmtNumber(t.used_mb)} MB</span>,
              free: <span className="font-mono text-[12px]">{fmtNumber(t.free_mb)} MB</span>,
              pct: <span className={t.used_pct >= 85 ? 'font-mono text-[12px] font-bold text-danger-fg' : 'font-mono text-[12px]'}>{t.used_pct}%</span>,
              status: <Badge tone={t.requires_attention ? 'warning' : 'success'} size="xs">{t.requires_attention ? 'Attention' : 'Healthy'}</Badge>,
              ops: (
                <Button size="sm" variant="secondary" onClick={() => setAnalysisTarget(t.tablespace_name)}>
                  Analyze
                </Button>
              ),
            },
          }))}
          empty={<EmptyState icon="database" title="No tablespaces found" />}
        />
      </div>

      <div className="card p-card">
        <p className="mb-3 text-[13px] font-bold text-fg">Datafiles</p>
        <Paged rows={datafiles} unit="datafiles">
          {(page, pager) => (
            <>
              <Table
                columns={[
                  { key: 'name', label: 'File' },
                  { key: 'ts', label: 'Tablespace' },
                  { key: 'size', label: 'Size', align: 'right' },
                  { key: 'autoextend', label: 'Autoextend' },
                  { key: 'ops', label: '' },
                ]}
                rows={page.map((df) => ({
                  key: df.file_name,
                  cells: {
                    name: <span className="max-w-[280px] truncate font-mono text-[11px] text-fg" title={df.file_name}>{df.file_name}</span>,
                    ts: <span className="text-[12px]">{df.tablespace_name}</span>,
                    size: <span className="font-mono text-[12px]">{fmtNumber(df.size_mb)} MB</span>,
                    autoextend: <Badge tone={df.autoextensible === 'YES' ? 'success' : 'neutral'} size="xs">{df.autoextensible === 'YES' ? 'ON' : 'OFF'}</Badge>,
                    ops: (
                      <Button size="sm" variant="secondary" onClick={() => setResizeTarget(df)}>
                        Resize
                      </Button>
                    ),
                  },
                }))}
                empty={<EmptyState icon="desktop" title="No datafiles found" />}
              />
              {pager}
            </>
          )}
        </Paged>
      </div>

      <div className="card p-card">
        <div className="mb-3 flex items-center justify-between">
          <p className="text-[13px] font-bold text-fg">Recycle Bin — {fmtNumber(recyclebin.total_mb)} MB across {Object.keys(recyclebin.by_owner).length} schema(s)</p>
          <Button size="sm" variant="secondary" icon="trash" onClick={() => setPurgeConfirm(true)} disabled={!recyclebin.total_mb}>
            Purge Recycle Bin
          </Button>
        </div>
        {Object.keys(recyclebin.by_owner).length === 0 ? (
          <EmptyState icon="check" title="Recycle bin is empty" />
        ) : (
          <div className="flex flex-wrap gap-2">
            {Object.entries(recyclebin.by_owner).map(([owner, info]) => (
              <span key={owner} className="rounded-control border border-border bg-surface px-2.5 py-1 text-[11px]">
                <span className="font-semibold text-fg">{owner}</span>
                <span className="ml-1.5 text-subtle">{info.object_count} objects, {fmtNumber(info.size_mb)} MB</span>
              </span>
            ))}
          </div>
        )}
      </div>

      {analysisTarget && (
        <AnalysisDialog tablespaceName={analysisTarget} connId={connId} onClose={() => setAnalysisTarget(null)} />
      )}

      {resizeTarget && (
        <ResizeDialog target={resizeTarget} connId={connId} directMut={directMut} onClose={() => setResizeTarget(null)} />
      )}

      <OperationConfirmDialog
        open={purgeConfirm}
        action="purge_recyclebin"
        objectLabel="the connected user's recycle bin"
        loading={directMut.isPending}
        error={directMut.error}
        onCancel={() => setPurgeConfirm(false)}
        onConfirm={() => directMut.mutate({ objectType: 'recyclebin', objectName: 'CURRENT_USER', action: 'purge_recyclebin' })}
        extra={(
          <p className="text-[12px] text-muted">
            Purges the recycle bin for the user this connection authenticates as — objects dropped by
            other schemas are not affected unless connected as that schema.
          </p>
        )}
      />
    </div>
  );
}
