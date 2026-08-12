import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { errorText } from '@/api/client';
import { deleteConnection, listConnections } from '@/api/connections';
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

/**
 * Azure Cosmos DB connections.
 *
 * Its own page rather than the shared `DatabaseServersPage`, because a Cosmos
 * connection has no host and no port — it has an account endpoint, a key, and a
 * default database/container. Rendering it through a host/port list would leave
 * the two columns that identify every other engine blank.
 */
export default function CosmosDBConnectionsPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(null);

  const engine = engineMeta('cosmosdb');

  const { data: connections = [], isLoading, isError, error } = useQuery({
    queryKey: ['cosmosdbConnections'],
    queryFn: () => listConnections('cosmosdb'),
    refetchInterval: 30000,
  });

  const del = useMutation({
    mutationFn: (connId) => deleteConnection('cosmosdb', connId),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['cosmosdbConnections'] });
      setConfirming(null);
    },
  });

  const header = (
    <PageHeader
      title="Azure Cosmos DB"
      description="Globally distributed, multi-model — SQL (Core) API"
      backTo="/databases"
      leading={(
        <span
          className="grid h-10 w-10 shrink-0 place-items-center rounded-md text-[20px]"
          style={{ background: `color-mix(in srgb, ${engine.color} 16%, transparent)` }}
        >
          {engine.emoji}
        </span>
      )}
      actions={(
        <Button variant="primary" icon="plus" onClick={() => navigate('/databases/add-data')}>
          Add connection
        </Button>
      )}
    />
  );

  if (isLoading) return <>{header}<PageLoading title="Loading connections…" /></>;

  return (
    <>
      {header}

      {isError && (
        <Notice tone="danger" title="Could not load connections.">
          {errorText(error)}
        </Notice>
      )}

      {connections.length === 0 ? (
        <div className="card px-card py-12">
          <EmptyState
            icon="cloud"
            title="No Cosmos DB accounts yet"
            body="Add an account endpoint and key to start reading its databases and containers."
            action={(
              <Button variant="primary" icon="plus" onClick={() => navigate('/databases/add-data')}>
                Add connection
              </Button>
            )}
          />
        </div>
      ) : (
        <div className="grid gap-gutter-sm sm:grid-cols-2 xl:grid-cols-3">
          {connections.map((c) => (
            <article key={c.id} className="card group relative overflow-hidden">
              <button
                type="button"
                onClick={() => navigate(`/cosmosdb-dashboard/${c.id}`)}
                className="block w-full px-card py-3.5 text-left transition-colors hover:bg-sunken"
              >
                <div className="flex items-start gap-3">
                  <span
                    className="grid h-10 w-10 shrink-0 place-items-center rounded-md text-[19px]"
                    style={{ background: `color-mix(in srgb, ${engine.color} 16%, transparent)` }}
                  >
                    {engine.emoji}
                  </span>
                  <div className="min-w-0 flex-1 pr-14">
                    <h3 className="truncate-safe text-[14px] font-bold text-fg">{c.connection_name}</h3>
                    <p
                      title={c.endpoint}
                      className="truncate-safe mt-0.5 font-mono text-[11px] text-subtle"
                    >
                      {c.endpoint}
                    </p>
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  {(c.database_name || c.container_name) && (
                    <Badge tone="accent" size="xs">
                      <Icon name="database" size={9} />
                      {[c.database_name, c.container_name].filter(Boolean).join(' / ')}
                    </Badge>
                  )}
                  {c.api_type && c.api_type !== 'sql' && (
                    <Badge tone="warning" size="xs">{c.api_type} API</Badge>
                  )}
                  {c.consistency_level && <Badge tone="outline" size="xs">{c.consistency_level}</Badge>}
                  {c.has_secondary_key && (
                    <Badge tone="outline" size="xs">
                      <Icon name="key" size={9} />
                      2 keys
                    </Badge>
                  )}
                </div>

                <div className="mt-3 flex items-center justify-between gap-2 border-t border-border pt-3">
                  <span className="text-[12px] font-semibold text-accent-text">
                    Databases &amp; containers
                  </span>
                  <Icon
                    name="chevron-right"
                    size={14}
                    className="text-accent-text transition-transform group-hover:translate-x-0.5"
                  />
                </div>
              </button>

              {/* Absolute, so the whole card stays one click target for opening it. */}
              <div className="absolute top-3 right-3 flex items-center gap-0.5">
                <IconButton
                  icon="settings"
                  label={`Edit ${c.connection_name}`}
                  size="sm"
                  onClick={() => navigate(`/cosmosdb-edit/${c.id}`)}
                />
                <IconButton
                  icon="trash"
                  label={`Delete ${c.connection_name}`}
                  size="sm"
                  onClick={() => setConfirming(c)}
                />
              </div>
            </article>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={Boolean(confirming)}
        onCancel={() => setConfirming(null)}
        onConfirm={() => del.mutate(confirming.id)}
        loading={del.isPending}
        tone="danger"
        title="Delete this connection?"
        confirmLabel="Delete"
        cancelLabel="Cancel"
      >
        <p className="text-[13px] text-muted">
          <b className="text-fg">{confirming?.connection_name}</b> is removed from ActMon along with
          its call history. The Cosmos DB account itself, and every document in it, is untouched.
        </p>
      </ConfirmDialog>
    </>
  );
}
