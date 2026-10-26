import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { atlasClusters, atlasErrorText, atlasNodes, deleteAtlasConnection, listAtlasConnections, retestAtlasConnection } from '@/api/atlas';
import { ClusterTopology } from './AtlasDashboard';
import PageHeader from '@/components/layout/PageHeader';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import Icon from '@/components/ui/Icon';
import IconButton from '@/components/ui/IconButton';
import Notice from '@/components/ui/Notice';
import { EmptyState } from '@/components/ui/Table';
import { PageLoading } from '@/components/ui/Loading';
import { engineMeta } from '@/config/engines';
import { usePermissions } from '@/hooks/usePermissions';
import { ago } from '@/lib/format';

export const ATLAS_STATUS = {
  connected: { label: 'Connected', tone: 'success' },
  error: { label: 'Error', tone: 'danger' },
  disconnected: { label: 'Disconnected', tone: 'warning' },
  unknown: { label: 'Not checked', tone: 'outline' },
};

const METHOD_LABEL = { uri: 'URI', credentials: 'Credentials', api_key: 'API key only' };

/** Saved MongoDB Atlas connections — open, re-test, edit or remove each one. */
export default function AtlasConnectionsPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { can } = usePermissions();
  const engine = engineMeta('mongoatlas');
  const [confirming, setConfirming] = useState(null);
  const [testing, setTesting] = useState(null);

  const { data: connections = [], isLoading, isError, error } = useQuery({
    queryKey: ['atlasConnections'], queryFn: listAtlasConnections, refetchInterval: 30000,
  });
  const del = useMutation({
    mutationFn: (cid) => deleteAtlasConnection(cid),
    onSettled: () => { qc.invalidateQueries({ queryKey: ['atlasConnections'] }); setConfirming(null); },
  });
  const retest = useMutation({
    mutationFn: (cid) => { setTesting(cid); return retestAtlasConnection(cid); },
    onSettled: () => { qc.invalidateQueries({ queryKey: ['atlasConnections'] }); setTesting(null); },
  });

  const canAdd = can('/databases', 'add');
  const header = (
    <PageHeader
      title="MongoDB Atlas"
      description="Managed MongoDB — clusters, performance, alerts and backups"
      backTo="/databases"
      leading={<span className="grid h-10 w-10 shrink-0 place-items-center rounded-md text-[20px]" style={{ background: `color-mix(in srgb, ${engine.color} 16%, transparent)` }}>{engine.emoji}</span>}
      actions={canAdd && <Button variant="primary" icon="plus" onClick={() => navigate('/mongoatlas/new')}>Connect Atlas</Button>}
    />
  );

  if (isLoading) return <>{header}<PageLoading title="Loading connections…" /></>;

  return (
    <>
      {header}
      {isError && <Notice tone="danger" title="Could not load connections.">{atlasErrorText(error)}</Notice>}
      {retest.isError && <Notice tone="danger" title="Re-test failed.">{atlasErrorText(retest.error)}</Notice>}

      {connections.length === 0 ? (
        <div className="card px-card py-12">
          <EmptyState icon="cloud" title="No MongoDB Atlas connections yet"
            body="Connect with an Atlas connection URI, a database user, or a project API key."
            action={canAdd && <Button variant="primary" icon="plus" onClick={() => navigate('/mongoatlas/new')}>Connect Atlas</Button>} />
        </div>
      ) : (
        <div className="space-y-8">
          {connections.map((c) => (
            <ConnectionTopology key={c.id} c={c} navigate={navigate} can={can} testing={testing === c.id}
              onRetest={() => retest.mutate(c.id)} onRemove={() => setConfirming(c)} />
          ))}
        </div>
      )}

      <ConfirmDialog open={Boolean(confirming)} onCancel={() => setConfirming(null)} onConfirm={() => del.mutate(confirming.id)}
        loading={del.isPending} tone="danger" title="Remove this Atlas connection?" confirmLabel="Remove" cancelLabel="Cancel">
        <p className="text-[13px] text-muted">
          <b className="text-fg">{confirming?.connection_name}</b> and its stored URI, password and API key are deleted from ActMon.
          The Atlas project, its clusters and data are untouched.
        </p>
      </ConfirmDialog>
    </>
  );
}

/** One Atlas connection: its header + the cluster topology of its project (Oracle-RAC style node cards). */
function ConnectionTopology({ c, navigate, can, testing, onRetest, onRemove }) {
  const engine = engineMeta('mongoatlas');
  const st = ATLAS_STATUS[c.status] || ATLAS_STATUS.unknown;
  const cl = useQuery({ queryKey: ['atlas', String(c.id), 'clusters'], queryFn: () => atlasClusters(c.id), enabled: c.has_api_key, refetchInterval: 60000, retry: false });
  const nq = useQuery({ queryKey: ['atlas', String(c.id), 'nodes'], queryFn: () => atlasNodes(c.id), enabled: Boolean(c.has_api_key && cl.data?.available), refetchInterval: 60000, retry: false });
  const dash = (q) => navigate(`/mongoatlas-dashboard/${c.id}${q ? `?${q}` : ''}`);
  const clusters = cl.data?.available ? cl.data.clusters : [];
  const procs = cl.data?.processes || [];
  const healthy = clusters.filter((x) => x.health === 'healthy').length;
  return (
    <section>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <span className="h-6 w-1 rounded-full bg-emerald-500" />
        <span className="grid h-9 w-9 place-items-center rounded-lg text-[17px]" style={{ background: `color-mix(in srgb, ${engine.color} 16%, transparent)` }}>{engine.emoji}</span>
        <div className="min-w-0">
          <h2 className="text-[16px] font-black text-fg">{c.connection_name}</h2>
          <p className="text-[11.5px] text-subtle">{[c.project_label, c.environment, c.host || (c.project_id ? `Project ${c.project_id}` : null)].filter(Boolean).join(' · ')}</p>
        </div>
        <Badge tone={st.tone} size="xs">{st.label}</Badge>
        {cl.data?.available && <span className="rounded-full bg-indigo-50 px-2.5 py-0.5 text-[11px] font-bold text-indigo-700">{clusters.length} cluster{clusters.length === 1 ? '' : 's'} · {procs.length} nodes · {healthy}/{clusters.length} healthy</span>}
        <span className="flex-1" />
        <Button size="sm" variant="primary" icon="activity" onClick={() => dash()}>Dashboard</Button>
        <IconButton icon="refresh" label={`Reconnect ${c.connection_name}`} size="sm" className={testing ? 'animate-spin' : undefined} onClick={onRetest} />
        {can('/databases', 'edit') && <IconButton icon="settings" label={`Edit ${c.connection_name}`} size="sm" onClick={() => navigate(`/mongoatlas-edit/${c.id}`)} />}
        {can('/databases', 'delete') && <IconButton icon="trash" label={`Remove ${c.connection_name}`} size="sm" onClick={onRemove} />}
      </div>
      {c.status === 'error' && c.last_error && <Notice tone="danger" title="Last check failed.">{c.last_error}</Notice>}
      {!c.has_api_key ? (
        <div className="card px-card py-8 text-center text-[13px] text-muted">
          This connection uses database access only. Cluster topology (nodes, roles, per-node metrics) comes from the Atlas Admin API —
          {' '}{can('/databases', 'edit') ? <button type="button" className="font-semibold text-accent-text hover:underline" onClick={() => navigate(`/mongoatlas-edit/${c.id}`)}>add an API key</button> : 'add an API key'} to see it.
        </div>
      ) : cl.isLoading ? <div className="card px-card py-10 text-center text-[13px] text-muted">Loading clusters…</div>
        : !cl.data?.available ? <Notice tone="warning" title="Clusters could not be read.">{cl.data?.reason || atlasErrorText(cl.error)}</Notice>
          : <ClusterTopology clusters={clusters} processes={procs} nodes={nq.data?.nodes} nodesLoading={nq.isLoading}
              onOpenNode={(p) => dash(`node=${encodeURIComponent(p.id)}`)} onOpenCluster={(x) => dash(`cluster=${encodeURIComponent(x.name)}`)} />}
    </section>
  );
}
